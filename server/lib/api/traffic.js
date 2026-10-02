'use strict';
/* Traffic API.
   Public:  POST /api/track            (beacon from site/assets/js/track.js)
   Admin:   GET  /api/admin/traffic    ?range=7|30|90
            GET|PUT|DELETE /api/admin/google
            POST /api/admin/google/test
            GET  /api/admin/search     ?range=7|28|90[&refresh=1]
            GET  /api/admin/analytics  ?range=7|30|90[&refresh=1]
   Route options follow server.js: { auth: true } for admin routes,
   contentTypes/limit for the beacon (sendBeacon posts text/plain), and
   beacon: true, which asks server.js to hand junk bodies to the handler as
   null instead of answering 400/415 (see the integration note). */
const net = require('node:net');
const { HttpError } = require('../http');
const { createLimiter } = require('../ratelimit');
const {
  ensureAnalyticsSchema, createEventRecorder, trafficReport, purgeOld, missingDays, buildDay,
  dubaiDay, addDays, RANGES, MAX_EVENTS_PER_DAY,
} = require('../analytics');
const { createGoogleClient, SEARCH_RANGES, ANALYTICS_RANGES } = require('../google');

const TRACK_BODY_LIMIT = 4 * 1024;
const TRACK_PER_MINUTE = 120;           // per client (IPv4 address or IPv6 /64)
const TRACK_GLOBAL_PER_MINUTE = 2000;   // whole site
const GOOGLE_BODY_LIMIT = 64 * 1024;
const REPORT_TTL_MS = 60 * 1000;
const DUBAI_OFFSET_MS = 4 * 3600 * 1000;
/* Rollups kept ready for the longest report plus its previous period. */
const ROLLUP_DAYS = 2 * Math.max(...RANGES);

function rangeParam(query, allowed, fallback) {
  const raw = query.get('range');
  if (raw === null || raw.trim() === '') return fallback;
  const n = Number(raw);
  if (!allowed.includes(n)) {
    throw new HttpError(400, `Range must be ${allowed.slice(0, -1).join(', ')} or ${allowed[allowed.length - 1]} days`);
  }
  return n;
}

const isRefresh = query => /^(1|true|yes)$/i.test(query.get('refresh') || '');

/* ---------- client identity for the beacon rate limit ---------- */

/* First four groups of an IPv6 address (its /64 network). */
function v6Prefix64(addr) {
  const dbl = addr.indexOf('::');
  const head = dbl === -1 ? addr : addr.slice(0, dbl);
  const tail = dbl === -1 ? '' : addr.slice(dbl + 2);
  const h = head ? head.split(':') : [];
  const t = tail ? tail.split(':') : [];
  const groups = list => list.reduce((n, g) => n + (g.includes('.') ? 2 : 1), 0);
  const fill = dbl === -1 ? 0 : Math.max(0, 8 - groups(h) - groups(t));
  return [...h, ...Array(fill).fill('0'), ...t].slice(0, 4).map(g => (parseInt(g, 16) || 0).toString(16)).join(':');
}

/* Rate-limit bucket for one address: the IPv4 address itself, or the /64
   network of an IPv6 address (one home or phone gets a whole /64, so a
   single address is too easy to rotate). Ports, brackets and zone ids are
   dropped; IPv4-mapped IPv6 counts as IPv4. */
function ipBucket(raw) {
  let s = String(raw || '').trim().toLowerCase();
  if (s.startsWith('[')) {
    const end = s.indexOf(']');
    s = end > 0 ? s.slice(1, end) : s.slice(1);
  } else if (/^\d{1,3}(?:\.\d{1,3}){3}:\d+$/.test(s)) {
    s = s.replace(/:\d+$/, '');
  }
  s = s.split('%')[0];
  const mapped = /^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/.exec(s);
  if (mapped) s = mapped[1];
  if (net.isIPv4(s)) return s;
  if (net.isIPv6(s)) return `${v6Prefix64(s)}::/64`;
  return s ? `other:${s.slice(0, 64)}` : 'unknown';
}

/* The client address as seen by the nearest trusted proxy. With TRUST_PROXY
   the proxy appends the address it saw to X-Forwarded-For, so the trusted
   entry is counted from the right (hops = number of trusted proxies in front
   of Node, default 1). Entries further left are whatever the client sent and
   are never used. Without TRUST_PROXY the socket address is used. */
function clientAddress(req, trustProxy, hops = 1) {
  if (trustProxy) {
    const parts = String(req.headers['x-forwarded-for'] || '').split(',').map(p => p.trim()).filter(Boolean);
    if (parts.length) return parts[Math.max(0, parts.length - Math.max(1, hops))];
  }
  return (req.socket && req.socket.remoteAddress) || '';
}

const limiterKey = (req, trustProxy, hops) => ipBucket(clientAddress(req, trustProxy, hops));

const PRIVATE_ADDR_RE = /^(?:::ffff:)?(?:127\.|10\.|192\.168\.|172\.(?:1[6-9]|2\d|3[01])\.)|^(?:::1$|f[cd][0-9a-f]{2}:)/i;

/* ---------- privacy and origin ---------- */

/* Do Not Track or Global Privacy Control: the event is not stored. */
const privacySignal = req => req.headers['sec-gpc'] === '1' || req.headers.dnt === '1';

const bareHost = h => String(h || '').trim().toLowerCase()
  .replace(/:\d+$/, '').replace(/^\[|\]$/g, '').replace(/\.$/, '').replace(/^www\./, '');

/* Hosts this site answers as: Host, X-Forwarded-Host (only behind a trusted
   proxy) and an optional PUBLIC_ORIGIN. */
function ownHosts(req, trustProxy, publicOrigin) {
  const hosts = [req.headers.host];
  if (trustProxy) hosts.push(...String(req.headers['x-forwarded-host'] || '').split(','));
  if (publicOrigin) {
    try { hosts.push(new URL(publicOrigin).host); } catch { /* ignore a bad setting */ }
  }
  return hosts.map(bareHost).filter(Boolean);
}

/* Beacons from our own pages only. Browsers send Origin on every POST, so a
   third-party page that makes its visitors post to /api/track is refused.
   No Origin at all (old browsers, curl) is accepted and rate limited. */
function sameOrigin(req, trustProxy, publicOrigin) {
  const origin = req.headers.origin;
  if (origin === undefined || origin === '') return true;
  let host = '';
  try { host = new URL(String(origin)).host; } catch { return false; }
  const want = bareHost(host);
  return Boolean(want) && ownHosts(req, trustProxy, publicOrigin).includes(want);
}

/* Host used to tell our own pages from referrers. */
function siteHost(req, trustProxy) {
  if (trustProxy) {
    const fwd = String(req.headers['x-forwarded-host'] || '').split(',').map(s => s.trim()).filter(Boolean);
    if (fwd.length) return fwd[fwd.length - 1];
  }
  return req.headers.host || '';
}

/* Options (all optional except db): google (a client, for tests),
   trackLimiter / globalLimiter (createLimiter instances), recorder
   (createEventRecorder), maxEventsPerDay, purge (false to skip the start-up
   and nightly maintenance: retention purge and rollup building).
   Returns { google, stop, report }. */
function registerTraffic(router, {
  db, env = {}, google, trackLimiter, globalLimiter, recorder, maxEventsPerDay = MAX_EVENTS_PER_DAY, purge = true,
} = {}) {
  // Idempotent; the db.js migration step creates the same tables.
  ensureAnalyticsSchema(db.raw);
  // Deleted rows (an old Google key, purged events) are overwritten with zeros
  // instead of lingering in free pages of the database file.
  try { db.raw.exec('PRAGMA secure_delete = ON'); } catch { /* older SQLite: best effort */ }

  const trustProxy = Boolean(env.TRUST_PROXY);
  const hops = Math.max(1, Math.floor(Number(env.TRUST_PROXY_HOPS || process.env.TRUST_PROXY_HOPS) || 1));
  const publicOrigin = env.PUBLIC_ORIGIN || process.env.PUBLIC_ORIGIN || '';
  const limiter = trackLimiter || createLimiter({ limit: TRACK_PER_MINUTE, windowMs: 60 * 1000 });
  const siteLimiter = globalLimiter || createLimiter({ limit: TRACK_GLOBAL_PER_MINUTE, windowMs: 60 * 1000, maxKeys: 10 });
  const events = recorder || createEventRecorder(db, { maxPerDay: maxEventsPerDay });
  /* After a key is replaced or removed: copy the WAL into the database file
     (where secure_delete has zeroed the old row) and truncate the WAL. */
  const wipe = () => { db.raw.exec('PRAGMA wal_checkpoint(TRUNCATE)'); };
  const client = google || createGoogleClient({ getSetting: db.getSetting, setSetting: db.setSetting, env, wipe });

  /* ---------- nightly maintenance ---------- */

  let timer = null;
  let stopped = false;
  let warnedMaintenance = false;
  const warnMaintenance = (what, err) => {
    if (warnedMaintenance) return;
    warnedMaintenance = true;
    console.error(`Analytics ${what} failed:`, err && err.message ? err.message : err);
  };
  /* Retention purge, then one rollup per missing closed day, yielding to
     requests between days (each day costs at most one day of events). */
  function maintain() {
    if (stopped) return;
    try {
      const removed = purgeOld(db);
      if (removed) console.log(`Analytics: removed ${removed} events older than 400 days`);
    } catch (err) {
      warnMaintenance('purge', err);
    }
    let days = [];
    try {
      const to = addDays(dubaiDay(Date.now()), -1);
      days = missingDays(db, addDays(to, -(ROLLUP_DAYS - 1)), to);
    } catch (err) {
      warnMaintenance('rollup', err);
    }
    // Plain (ref'd) immediates: an unref'd one does not wake the event loop, so the
    // chain would only advance when some other I/O happened. It ends by itself
    // (at most ROLLUP_DAYS short steps) or at stop().
    const next = () => {
      if (stopped || !days.length) return;
      try {
        buildDay(db, days.shift());
      } catch (err) {
        warnMaintenance('rollup', err);
        return;
      }
      setImmediate(next);
    };
    setImmediate(next);
  }
  /* Runs a minute after every Dubai midnight. */
  function schedule() {
    if (stopped) return;
    const t = Date.now();
    const nextDayStart = Date.parse(`${addDays(dubaiDay(t), 1)}T00:00:00Z`) - DUBAI_OFFSET_MS;
    timer = setTimeout(() => { maintain(); schedule(); }, Math.max(1000, nextDayStart - t + 60 * 1000));
    timer.unref();
  }
  if (purge) {
    maintain();
    schedule();
  }

  /* ---------- public beacon ---------- */

  let warnedRecord = false;
  let warnedProxy = false;
  function accept(req) {
    if (privacySignal(req)) return false;
    if (!sameOrigin(req, trustProxy, publicOrigin)) return false;
    if (!trustProxy && !warnedProxy && req.headers['x-forwarded-for'] && PRIVATE_ADDR_RE.test(String((req.socket && req.socket.remoteAddress) || ''))) {
      warnedProxy = true;
      console.warn('Analytics: requests arrive through a proxy but TRUST_PROXY is off, so every visitor shares one tracking rate limit. Set TRUST_PROXY=1 in server/.env.');
    }
    if (!limiter.hit(limiterKey(req, trustProxy, hops)).ok) return false;
    return siteLimiter.hit('all').ok;
  }

  router.post('/api/track', ({ req, res, body }) => {
    // Always 204, even when the event is dropped (privacy signal, other origin,
    // rate or daily limit, bot, invalid).
    try {
      if (accept(req)) events.record(body, { ua: req.headers['user-agent'], host: siteHost(req, trustProxy) });
    } catch (err) {
      if (!warnedRecord) {
        warnedRecord = true;
        console.error('Analytics: could not record an event:', err && err.message ? err.message : err);
      }
    }
    res.writeHead(204, { 'Cache-Control': 'no-store' });
    res.end();
  }, { contentTypes: ['application/json', 'text/plain'], limit: TRACK_BODY_LIMIT, beacon: true });

  /* ---------- first-party report ---------- */

  /* Reports read daily rollups; today's live part is cached for a minute.
     The computation is synchronous, so concurrent requests are served one
     after another and all but the first get the cached result. */
  const reports = new Map(); // range -> { at, day, data }
  function report(range, t = Date.now()) {
    const day = dubaiDay(t);
    const hit = reports.get(range);
    if (hit && hit.day === day && t - hit.at >= 0 && t - hit.at < REPORT_TTL_MS) return hit.data;
    const data = trafficReport(db, range, { now: t });
    reports.set(range, { at: t, day, data });
    return data;
  }

  router.get('/api/admin/traffic', ({ query }) => report(rangeParam(query, RANGES, 7)), { auth: true });

  /* ---------- Google connection ---------- */

  router.get('/api/admin/google', () => client.status(), { auth: true });

  router.put('/api/admin/google', ({ body }) => client.save(body), { auth: true, limit: GOOGLE_BODY_LIMIT });

  router.delete('/api/admin/google', () => client.disconnect(), { auth: true });

  router.post('/api/admin/google/test', () => client.test(), { auth: true });

  router.get('/api/admin/search', ({ query }) => client.searchReport(
    rangeParam(query, SEARCH_RANGES, 28), { refresh: isRefresh(query) },
  ), { auth: true });

  router.get('/api/admin/analytics', ({ query }) => client.analyticsReport(
    rangeParam(query, ANALYTICS_RANGES, 30), { refresh: isRefresh(query) },
  ), { auth: true });

  return {
    google: client,
    report,
    stop() {
      stopped = true;
      if (timer) clearTimeout(timer);
      timer = null;
    },
  };
}

module.exports = { registerTraffic, ipBucket, clientAddress, sameOrigin, privacySignal };
