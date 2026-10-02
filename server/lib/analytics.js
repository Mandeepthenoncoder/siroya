'use strict';
/* First-party, cookie-free website analytics.
   - events table (one row per tracked event; no IP address, no user agent)
   - recordEvent(): validates one beacon from site/assets/js/track.js.
     Every free-text field is cleaned (single line, no invisible or bidi
     characters, e-mail addresses and long digit runs removed) and the path
     is rebuilt from a page name plus one slug-checked ?p= or ?c=.
   - createEventRecorder(): recordEvent plus a site-wide daily cap.
   - Write caps: 300 events per session per day, 50,000 per Dubai day.
   - Reports read daily rollups (events_daily, events_daily_dim), built once
     per closed day, so a report never scans the raw event log. The report
     covers complete days ending yesterday (like the Google reports); today
     comes back separately as a small live summary.
   Days are calendar days in Asia/Dubai (UTC+4, no daylight saving).
   This module must not require ./db (db.js requires it for the migration). */
const { HttpError } = require('./http');

const EVENT_TYPES = Object.freeze([
  'page_view', 'view_item', 'view_item_list', 'filter_collection',
  'whatsapp_click', 'generate_lead', 'story_open', 'intro_complete',
]);
const TYPE_SET = new Set(EVENT_TYPES);
const RANGES = Object.freeze([7, 30, 90]);
const RETENTION_DAYS = 400;
const MAX_EVENTS_PER_DAY = 50000;
const MAX_EVENTS_PER_SESSION_DAY = 300;
/* Rollups keep this many keys per dimension per day (pages, products...). */
const ROLLUP_KEYS_PER_DAY = 200;
const DAY_MS = 864e5;
const DUBAI_OFFSET_MS = 4 * 3600 * 1000;
const SID_RE = /^[a-f0-9]{16}$/;
const TOP_N = 15;
const DIMS = Object.freeze(['source', 'campaign', 'page', 'collection', 'product', 'device']);

/* Idempotent: safe to run on every start and as a migration step. */
const ANALYTICS_SCHEMA_SQL = `
  CREATE TABLE IF NOT EXISTS events (
    id INTEGER PRIMARY KEY,
    ts TEXT NOT NULL,
    day TEXT NOT NULL,
    type TEXT NOT NULL,
    path TEXT DEFAULT '',
    page_type TEXT DEFAULT '',
    item TEXT DEFAULT '',
    collection TEXT DEFAULT '',
    category TEXT DEFAULT '',
    sid TEXT DEFAULT '',
    is_new INTEGER DEFAULT 0,
    source TEXT DEFAULT '',
    medium TEXT DEFAULT '',
    campaign TEXT DEFAULT '',
    ref_host TEXT DEFAULT '',
    has_gclid INTEGER DEFAULT 0,
    device TEXT DEFAULT ''
  );
  CREATE INDEX IF NOT EXISTS events_day ON events(day);
  CREATE INDEX IF NOT EXISTS events_type_day ON events(type, day);
  CREATE INDEX IF NOT EXISTS events_sid_day ON events(sid, day);
  CREATE TABLE IF NOT EXISTS events_daily (
    day TEXT PRIMARY KEY,
    visitors INTEGER NOT NULL DEFAULT 0,
    page_views INTEGER NOT NULL DEFAULT 0,
    whatsapp_clicks INTEGER NOT NULL DEFAULT 0,
    converted INTEGER NOT NULL DEFAULT 0,
    new_visitors INTEGER NOT NULL DEFAULT 0,
    returning_visitors INTEGER NOT NULL DEFAULT 0,
    built_at TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS events_daily_dim (
    dim TEXT NOT NULL,
    day TEXT NOT NULL,
    key TEXT NOT NULL,
    views INTEGER NOT NULL DEFAULT 0,
    visitors INTEGER NOT NULL DEFAULT 0,
    whatsapp_clicks INTEGER NOT NULL DEFAULT 0,
    leads INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (dim, day, key)
  ) WITHOUT ROWID;
`;

/* Accepts a raw DatabaseSync or the openDb() wrapper. */
function ensureAnalyticsSchema(rawDb) {
  const raw = rawDb && rawDb.raw && typeof rawDb.raw.exec === 'function' ? rawDb.raw : rawDb;
  raw.exec(ANALYTICS_SCHEMA_SQL);
}

/* ---------- dates (Asia/Dubai) ---------- */

const dubaiDay = ms => new Date(ms + DUBAI_OFFSET_MS).toISOString().slice(0, 10);
const addDays = (day, n) => new Date(Date.parse(`${day}T00:00:00Z`) + n * DAY_MS).toISOString().slice(0, 10);
/* UTC instant (ISO) when a Dubai calendar day starts. */
const dubaiDayStartIso = day => new Date(Date.parse(`${day}T00:00:00Z`) - DUBAI_OFFSET_MS).toISOString();

function daysBetween(from, to) {
  const out = [];
  for (let d = from; d <= to; d = addDays(d, 1)) out.push(d);
  return out;
}

/* ---------- input cleaning ---------- */

/* Invisible and direction-changing characters (soft hyphen, zero-width,
   bidi embeddings, overrides and isolates, word joiners, BOM): removed so a
   label cannot pretend to be something else. */
const INVISIBLE_RE = /[­؜᠎​-‏‪-‮⁠-⁤⁦-⁩﻿]/g;

/* Single-line text: invisible characters removed, control characters become
   spaces, trimmed, capped (never ending in half a surrogate pair). */
function clean(value, max) {
  if (typeof value !== 'string' && typeof value !== 'number') return '';
  // \s also covers the Unicode line and paragraph separators.
  return String(value)
    .replace(INVISIBLE_RE, '')
    .replace(/[\u0000-\u001f\u007f-\u009f]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, max)
    .replace(/[\ud800-\udbff]$/, '')
    .trim();
}

/* Personal data that marketing tools merge into links: e-mail addresses and
   long digit runs (phone numbers, customer ids). */
const EMAIL_RE = /[^\s@]+@[^\s@]+\.[^\s@]+/g;
const LONG_DIGITS_RE = /\d{7,}/g;
const REDACTED = '[hidden]';
const hasPersonalData = s => /[^\s@]+@[^\s@]+\.[^\s@]+/.test(s) || /\d{7,}/.test(s);
const redact = s => s.replace(EMAIL_RE, REDACTED).replace(LONG_DIGITS_RE, REDACTED);

/* Free text that is shown as is (campaign names): cleaned and redacted. */
const cleanText = (value, max) => redact(clean(value, max));

/* Identifier fields (item, collection, category, page type): one charset,
   no personal data, otherwise ''. */
const SLUG_ID_RE = /^[a-z0-9][a-z0-9_-]{0,99}$/i;
const ITEM_RE = /^[\p{L}\p{N}][\p{L}\p{N} ._/#-]{0,99}$/u;
function cleanId(value, re = SLUG_ID_RE) {
  const s = clean(value, 100);
  return s && re.test(s) && !hasPersonalData(s) ? s : '';
}

/* The page path is rebuilt, never stored as sent: "/" or "/<name>.html"
   (lowercase; /index.html becomes /) plus at most one ?p=<handle> or
   ?c=<slug> whose value is a plain slug. Anything else becomes '' (the event
   is kept, without a page). So a path can never be another site's URL, a
   protocol-relative link or carry personal data. */
const PAGE_RE = /^\/(?:[a-z0-9][a-z0-9_-]{0,63}\.html)?$/;
const PARAM_SLUG_RE = /^[a-z0-9]+(?:[-_][a-z0-9]+)*$/;
function cleanPath(value) {
  const s = clean(value, 400);
  if (!s.startsWith('/') || /[\s\\]/.test(s)) return '';
  const q = s.indexOf('?');
  let pathname = (q === -1 ? s : s.slice(0, q)).toLowerCase();
  if (pathname === '/index.html') pathname = '/';
  if (!PAGE_RE.test(pathname)) return '';
  const m = q === -1 ? null : /^([pc])=([^&#]*)/.exec(s.slice(q + 1));
  if (!m) return pathname;
  let v = '';
  try { v = decodeURIComponent(m[2]); } catch { v = ''; }
  return v.length <= 100 && PARAM_SLUG_RE.test(v) && !hasPersonalData(v) ? `${pathname}?${m[1]}=${v}` : pathname;
}

const truthy = v => v === true || v === 1 || v === '1' || v === 'true';

/* Bare lowercase host without www. and port; '' when it does not look like one. */
function normHost(value) {
  let s = clean(value, 300).toLowerCase();
  if (!s) return '';
  if (s.includes('://')) {
    try { s = new URL(s).hostname; } catch { return ''; }
  } else {
    s = s.split(/[/?#]/)[0];
  }
  s = s.replace(/:\d+$/, '').replace(/\.$/, '').replace(/^www\./, '');
  return /^[a-z0-9.-]{1,100}$/.test(s) ? s : '';
}

/* ---------- user agent ---------- */

const BOT_RE = /bot|crawl|spider|slurp|headless|lighthouse|preview|facebookexternalhit|whatsapp/i;

/* Known bots, link previewers and clients with no user agent at all. */
function isBot(ua) {
  const s = typeof ua === 'string' ? ua.trim() : '';
  return !s || BOT_RE.test(s);
}

function deviceFromUA(ua) {
  const s = typeof ua === 'string' ? ua : '';
  if (/ipad|tablet|kindle|silk\/|playbook|nexus (?:7|9|10)\b|sm-t\d/i.test(s)) return 'tablet';
  if (/android/i.test(s) && !/mobile/i.test(s)) return 'tablet';
  if (/mobi|iphone|ipod|android|windows phone|blackberry|bb10|opera mini|iemobile/i.test(s)) return 'mobile';
  return 'desktop';
}

/* ---------- source ---------- */

const PAID_MEDIUMS = new Set(['cpc', 'ppc', 'paid']);
const GOOGLE_SOURCE_RE = /^(?:google|adwords)/;
const GOOGLE_HOST_RE = /(?:^|\.)google(?:\.[a-z]{2,3}){1,2}$/;
const GOOGLE_NOT_SEARCH_RE = /^(?:mail|docs|drive|accounts|calendar|meet|sites)\.google\./;
const OTHER_SEARCH_RE = /(?:^|\.)(?:bing\.com|duckduckgo\.com|yahoo(?:\.[a-z]{2,3}){1,2}|yandex(?:\.[a-z]{2,3}){1,2}|baidu\.com|ecosia\.org|search\.brave\.com)$/;
const SOCIAL_RE = /(?:^|\.)(?:facebook\.com|fb\.com|fb\.me|instagram\.com|t\.co|x\.com|twitter\.com|linkedin\.com|lnkd\.in|youtube\.com|youtu\.be|pinterest(?:\.[a-z]{2,3}){1,2}|pin\.it|tiktok\.com|threads\.net|snapchat\.com)$/;
const WHATSAPP_RE = /(?:^|\.)(?:whatsapp\.com|whatsapp\.net|wa\.me)$/;

/* utm_source is used as the source name only when it looks like one: short,
   plain characters, and not a name every JavaScript object already has
   (constructor, __proto__, toString...), which would break lookups. */
const UTM_SOURCE_RE = /^[a-z0-9][\w. -]{0,59}$/;
const RESERVED_KEYS = new Set([...Object.getOwnPropertyNames(Object.prototype), 'prototype'].map(k => k.toLowerCase()));
function utmSource(value) {
  const s = redact(clean(value, 100).toLowerCase());
  return UTM_SOURCE_RE.test(s) && !RESERVED_KEYS.has(s) ? s : '';
}

/* Traffic source for one event:
   google_ads | <utm_source> | google_organic | other_search | social |
   whatsapp | direct | referral */
function deriveSource({ hasGclid = false, source = '', medium = '', refHost = '', ownHost = '' } = {}) {
  const src = utmSource(source);
  const med = clean(medium, 100).toLowerCase();
  const ref = normHost(refHost);
  const own = normHost(ownHost);
  if (truthy(hasGclid) || (PAID_MEDIUMS.has(med) && GOOGLE_SOURCE_RE.test(src))) return 'google_ads';
  if (src) return src;
  if (!ref || (own && ref === own)) return 'direct';
  if (ref === 'com.google.android.googlequicksearchbox' || (GOOGLE_HOST_RE.test(ref) && !GOOGLE_NOT_SEARCH_RE.test(ref))) return 'google_organic';
  if (OTHER_SEARCH_RE.test(ref)) return 'other_search';
  if (SOCIAL_RE.test(ref)) return 'social';
  if (WHATSAPP_RE.test(ref)) return 'whatsapp';
  return 'referral';
}

/* ---------- write ---------- */

const WRITE_SQL = {
  sessionCount: 'SELECT COUNT(*) AS n FROM (SELECT 1 FROM events WHERE sid = ? AND day = ? LIMIT ?)',
  dayCount: 'SELECT COUNT(*) AS n FROM events WHERE day = ?',
  insert: `INSERT INTO events (ts, day, type, path, page_type, item, collection, category, sid, is_new,
      source, medium, campaign, ref_host, has_gclid, device)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  unroll: 'DELETE FROM events_daily WHERE day = ?',
};

/* Validates and stores one event. Never throws on bad input: returns
   { ok:false, reason } so the endpoint can always answer 204.
   meta: { ua, host, now, maxPerSession } (now in ms, for tests). */
function recordEvent(db, input, meta = {}) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return { ok: false, reason: 'invalid' };
  const ua = typeof meta.ua === 'string' ? meta.ua : '';
  if (isBot(ua)) return { ok: false, reason: 'bot' };
  const type = typeof input.t === 'string' ? input.t.trim() : '';
  if (!TYPE_SET.has(type)) return { ok: false, reason: 'invalid_type' };
  const sid = typeof input.sid === 'string' ? input.sid.trim() : '';
  if (!SID_RE.test(sid)) return { ok: false, reason: 'invalid_sid' };

  const t = Number.isFinite(meta.now) ? meta.now : Date.now();
  const day = dubaiDay(t);
  const perSession = Number.isInteger(meta.maxPerSession) && meta.maxPerSession > 0 ? meta.maxPerSession : MAX_EVENTS_PER_SESSION_DAY;
  if (db.stmt(WRITE_SQL.sessionCount).get(sid, day, perSession).n >= perSession) return { ok: false, reason: 'session_cap' };

  const ev = {
    path: cleanPath(input.p),
    page_type: cleanId(input.pt),
    item: cleanId(input.i, ITEM_RE),
    collection: cleanId(input.c),
    category: cleanId(input.k),
    is_new: truthy(input.n) ? 1 : 0,
    medium: cleanText(input.med, 100).toLowerCase(),
    campaign: cleanText(input.cmp, 100),
    ref_host: normHost(input.ref),
    has_gclid: truthy(input.g) ? 1 : 0,
    device: deviceFromUA(ua),
  };
  ev.source = deriveSource({
    hasGclid: ev.has_gclid, source: input.src, medium: ev.medium, refHost: ev.ref_host, ownHost: meta.host,
  });

  db.stmt(WRITE_SQL.insert).run(
    new Date(t).toISOString(), day, type, ev.path, ev.page_type, ev.item, ev.collection, ev.category, sid,
    ev.is_new, ev.source, ev.medium, ev.campaign, ev.ref_host, ev.has_gclid, ev.device,
  );
  // A day's rollup is built once the day is over; an event that still lands on
  // a rolled-up day (a backfill, a clock change) marks it for a rebuild.
  db.stmt(WRITE_SQL.unroll).run(day);
  return { ok: true, source: ev.source, device: ev.device };
}

/* recordEvent with a site-wide cap per Dubai day. The count starts from the
   database when the day changes, so a restart does not reset it.
   Returns { record(input, meta), count() }. */
function createEventRecorder(db, { maxPerDay = MAX_EVENTS_PER_DAY, maxPerSession = MAX_EVENTS_PER_SESSION_DAY, now = Date.now } = {}) {
  let day = '';
  let count = 0;
  function record(input, meta = {}) {
    const t = Number.isFinite(meta.now) ? meta.now : now();
    const d = dubaiDay(t);
    if (d !== day) {
      day = d;
      count = Number(db.stmt(WRITE_SQL.dayCount).get(d).n) || 0;
    }
    if (count >= maxPerDay) return { ok: false, reason: 'daily_cap' };
    const r = recordEvent(db, input, { ...meta, now: t, maxPerSession });
    if (r.ok) count++;
    return r;
  }
  return { record, count: () => count };
}

/* Deletes events and rollups older than RETENTION_DAYS. Returns the number of events removed. */
function purgeOld(db, { now = Date.now() } = {}) {
  const cutoff = dubaiDay(now - RETENTION_DAYS * DAY_MS);
  const removed = Number(db.stmt('DELETE FROM events WHERE day < ?').run(cutoff).changes);
  db.stmt('DELETE FROM events_daily WHERE day < ?').run(cutoff);
  for (const dim of DIMS) db.stmt('DELETE FROM events_daily_dim WHERE dim = ? AND day < ?').run(dim, cutoff);
  return removed;
}

/* ---------- daily rollups ---------- */

const KEEP = ROLLUP_KEYS_PER_DAY;
const ROLL_SQL = {
  totals: `SELECT COUNT(DISTINCT sid) AS visitors,
      COALESCE(SUM(type = 'page_view'), 0) AS page_views,
      COALESCE(SUM(type = 'whatsapp_click'), 0) AS whatsapp_clicks,
      COUNT(DISTINCT CASE WHEN type IN ('whatsapp_click', 'generate_lead') THEN sid END) AS converted
    FROM events WHERE day = ?`,
  newVsReturning: `SELECT COALESCE(SUM(n = 1), 0) AS new_visitors, COALESCE(SUM(n = 0), 0) AS returning_visitors
    FROM (SELECT MAX(is_new) AS n FROM events WHERE day = ? GROUP BY sid)`,
  pages: `SELECT path AS key, COUNT(*) AS views, COUNT(DISTINCT sid) AS visitors, 0 AS whatsapp_clicks, 0 AS leads
    FROM events WHERE type = 'page_view' AND day = ? AND path <> ''
    GROUP BY path ORDER BY views DESC, visitors DESC, path LIMIT ${KEEP}`,
  collections: `SELECT collection AS key, COUNT(*) AS views, 0 AS visitors, 0 AS whatsapp_clicks, 0 AS leads
    FROM events WHERE type = 'view_item_list' AND day = ? AND collection <> ''
    GROUP BY collection ORDER BY views DESC, collection LIMIT ${KEEP}`,
  products: `SELECT item AS key,
      COALESCE(SUM(type = 'view_item'), 0) AS views, 0 AS visitors,
      COALESCE(SUM(type = 'whatsapp_click'), 0) AS whatsapp_clicks,
      COALESCE(SUM(type = 'generate_lead'), 0) AS leads
    FROM events
    WHERE type IN ('view_item', 'whatsapp_click', 'generate_lead') AND day = ? AND item <> ''
    GROUP BY item ORDER BY views DESC, leads DESC, whatsapp_clicks DESC, item LIMIT ${KEEP}`,
  devices: `SELECT device AS key, 0 AS views, COUNT(DISTINCT sid) AS visitors, 0 AS whatsapp_clicks, 0 AS leads
    FROM events WHERE day = ? GROUP BY device ORDER BY visitors DESC, device LIMIT ${KEEP}`,
  /* One row per session of the day: its source and campaign come from the
     first event that is not 'direct' (internal navigation reports our own
     host, so a visit from Google stays Google), else from its first event. */
  sessions: `WITH ranked AS (
      SELECT sid, source, campaign, type,
        ROW_NUMBER() OVER (PARTITION BY sid ORDER BY (source = 'direct'), id) AS rn
      FROM events WHERE day = ?
    ),
    sess AS (
      SELECT sid,
        MAX(CASE WHEN rn = 1 THEN source END) AS source,
        MAX(CASE WHEN rn = 1 THEN campaign END) AS campaign,
        SUM(type = 'whatsapp_click') AS wa,
        SUM(type = 'generate_lead') AS leads
      FROM ranked GROUP BY sid
    )
    SELECT COALESCE(source, '') AS source, COALESCE(campaign, '') AS campaign,
      COUNT(*) AS visitors, COALESCE(SUM(wa), 0) AS wa, COALESCE(SUM(leads), 0) AS leads
    FROM sess GROUP BY 1, 2`,
  insertDim: `INSERT INTO events_daily_dim (dim, day, key, views, visitors, whatsapp_clicks, leads)
    VALUES (?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(dim, day, key) DO UPDATE SET views = excluded.views, visitors = excluded.visitors,
      whatsapp_clicks = excluded.whatsapp_clicks, leads = excluded.leads`,
  clearDim: 'DELETE FROM events_daily_dim WHERE dim = ? AND day = ?',
  insertDay: `INSERT INTO events_daily (day, visitors, page_views, whatsapp_clicks, converted, new_visitors, returning_visitors, built_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(day) DO UPDATE SET visitors = excluded.visitors, page_views = excluded.page_views,
      whatsapp_clicks = excluded.whatsapp_clicks, converted = excluded.converted,
      new_visitors = excluded.new_visitors, returning_visitors = excluded.returning_visitors, built_at = excluded.built_at`,
  builtDays: 'SELECT day FROM events_daily WHERE day BETWEEN ? AND ?',
};

/* Sessions grouped by (source, campaign) -> top rows for one dimension. */
function sessionRollup(rows, field) {
  const by = new Map();
  for (const r of rows) {
    const key = field === 'source' ? (r.source || 'direct') : r.campaign;
    if (!key) continue;
    const acc = by.get(key) || { key, views: 0, visitors: 0, whatsapp_clicks: 0, leads: 0 };
    acc.visitors += Number(r.visitors) || 0;
    acc.whatsapp_clicks += Number(r.wa) || 0;
    acc.leads += Number(r.leads) || 0;
    by.set(key, acc);
  }
  return [...by.values()]
    .sort((a, b) => b.visitors - a.visitors || (a.key < b.key ? -1 : a.key > b.key ? 1 : 0))
    .slice(0, KEEP);
}

/* Aggregates one Dubai day of raw events into the rollup tables (in one
   transaction). Cost is bounded by the daily event cap. */
function buildDay(db, day, { now = Date.now() } = {}) {
  const run = () => {
    const t = db.stmt(ROLL_SQL.totals).get(day);
    const nvr = db.stmt(ROLL_SQL.newVsReturning).get(day);
    const sessions = db.stmt(ROLL_SQL.sessions).all(day);
    const dims = {
      source: sessionRollup(sessions, 'source'),
      campaign: sessionRollup(sessions, 'campaign'),
      page: db.stmt(ROLL_SQL.pages).all(day),
      collection: db.stmt(ROLL_SQL.collections).all(day),
      product: db.stmt(ROLL_SQL.products).all(day),
      device: db.stmt(ROLL_SQL.devices).all(day).map(r => ({ ...r, key: r.key || 'desktop' })),
    };
    for (const dim of DIMS) {
      db.stmt(ROLL_SQL.clearDim).run(dim, day);
      for (const r of dims[dim]) {
        db.stmt(ROLL_SQL.insertDim).run(dim, day, String(r.key), Number(r.views) || 0, Number(r.visitors) || 0,
          Number(r.whatsapp_clicks) || 0, Number(r.leads) || 0);
      }
    }
    db.stmt(ROLL_SQL.insertDay).run(day, t.visitors, t.page_views, t.whatsapp_clicks, t.converted,
      nvr.new_visitors, nvr.returning_visitors, new Date(now).toISOString());
  };
  if (typeof db.tx === 'function') db.tx(run);
  else run();
}

/* Days in [from, to] (all before today) that have no rollup yet. */
function missingDays(db, from, to) {
  const built = new Set(db.stmt(ROLL_SQL.builtDays).all(from, to).map(r => r.day));
  return daysBetween(from, to).filter(d => !built.has(d));
}

/* Builds every missing rollup in [from, to]; never touches today or later. */
function ensureRollups(db, from, to, { now = Date.now() } = {}) {
  const lastClosed = addDays(dubaiDay(now), -1);
  const end = to < lastClosed ? to : lastClosed;
  if (from > end) return 0;
  const days = missingDays(db, from, end);
  for (const day of days) buildDay(db, day, { now });
  return days.length;
}

/* ---------- read ---------- */

const SQL = {
  totals: `SELECT COALESCE(SUM(visitors), 0) AS visitors, COALESCE(SUM(page_views), 0) AS page_views,
      COALESCE(SUM(whatsapp_clicks), 0) AS whatsapp_clicks, COALESCE(SUM(converted), 0) AS converted,
      COALESCE(SUM(new_visitors), 0) AS new_visitors, COALESCE(SUM(returning_visitors), 0) AS returning_visitors
    FROM events_daily WHERE day BETWEEN ? AND ?`,
  daily: 'SELECT day, visitors, page_views, whatsapp_clicks FROM events_daily WHERE day BETWEEN ? AND ?',
  leadsTotal: 'SELECT COUNT(*) AS n FROM leads WHERE created_at >= ? AND created_at < ?',
  leadsDaily: `SELECT date(created_at, '+4 hours') AS day, COUNT(*) AS n
    FROM leads WHERE created_at >= ? AND created_at < ? GROUP BY 1`,
  dim: order => `SELECT key, SUM(views) AS views, SUM(visitors) AS visitors,
      SUM(whatsapp_clicks) AS whatsapp_clicks, SUM(leads) AS leads
    FROM events_daily_dim WHERE dim = ? AND day BETWEEN ? AND ?
    GROUP BY key ORDER BY ${order}, key LIMIT ?`,
  productName: `SELECT handle, name FROM products WHERE handle = ? OR code = ?
    ORDER BY (handle = ?) DESC, id LIMIT 1`,
  collectionName: 'SELECT name FROM collections WHERE slug = ?',
  categoryName: 'SELECT name FROM categories WHERE slug = ?',
};
const DIM_ORDER = {
  source: 'visitors DESC',
  campaign: 'visitors DESC',
  page: 'views DESC, visitors DESC',
  collection: 'views DESC',
  product: 'views DESC, leads DESC, whatsapp_clicks DESC',
  device: 'visitors DESC',
};
const dimRows = (db, dim, from, to, limit) => db.stmt(SQL.dim(DIM_ORDER[dim])).all(dim, from, to, limit);

/* Rates are sent unrounded; the admin formats them (one decimal). */
const rate = (part, whole) => (whole > 0 ? part / whole : 0);

const leadsBetween = (db, from, to) => db.stmt(SQL.leadsTotal).get(dubaiDayStartIso(from), dubaiDayStartIso(addDays(to, 1))).n;

function periodTotals(db, from, to) {
  const t = db.stmt(SQL.totals).get(from, to);
  return {
    visitors: t.visitors,
    page_views: t.page_views,
    whatsapp_clicks: t.whatsapp_clicks,
    leads: leadsBetween(db, from, to),
    conversion_rate: rate(t.converted, t.visitors),
  };
}

function dailySeries(db, from, to) {
  const rows = new Map(db.stmt(SQL.daily).all(from, to).map(row => [row.day, row]));
  const leads = new Map(db.stmt(SQL.leadsDaily)
    .all(dubaiDayStartIso(from), dubaiDayStartIso(addDays(to, 1))).map(row => [row.day, row.n]));
  return daysBetween(from, to).map(day => {
    const row = rows.get(day);
    return {
      day,
      visitors: row ? row.visitors : 0,
      page_views: row ? row.page_views : 0,
      whatsapp_clicks: row ? row.whatsapp_clicks : 0,
      leads: leads.get(day) || 0,
    };
  });
}

function collectionLabel(db, slug) {
  const col = db.stmt(SQL.collectionName).get(slug);
  if (col) return col.name;
  const catSlug = slug.startsWith('category-') ? slug.slice(9) : slug;
  const cat = db.stmt(SQL.categoryName).get(catSlug);
  return cat ? cat.name : slug;
}

/* Today so far, live from the raw events (at most one day of them, which the
   daily cap bounds). { day, visitors, page_views, whatsapp_clicks, leads } */
function todaySummary(db, opts = {}) {
  const nowMs = Number.isFinite(opts.now) ? opts.now : Date.now();
  const day = dubaiDay(nowMs);
  const t = db.stmt(ROLL_SQL.totals).get(day);
  return {
    day,
    visitors: t.visitors,
    page_views: t.page_views,
    whatsapp_clicks: t.whatsapp_clicks,
    leads: leadsBetween(db, day, day),
  };
}

/* Dashboard report. range: 7 | 30 | 90 complete days ending yesterday (Dubai),
   compared with the same number of days before. Read from daily rollups;
   missing ones (normally only yesterday's) are built first.
   Rates are fractions (0.0123 = 1.23%). opts.now (ms) is for tests. */
function trafficReport(db, range, opts = {}) {
  const r = Number(range);
  if (!RANGES.includes(r)) throw new HttpError(400, 'Range must be 7, 30 or 90 days');
  const nowMs = Number.isFinite(opts.now) ? opts.now : Date.now();
  const today = dubaiDay(nowMs);
  const to = addDays(today, -1);
  const from = addDays(to, -(r - 1));
  const prevTo = addDays(from, -1);
  const prevFrom = addDays(prevTo, -(r - 1));

  ensureRollups(db, prevFrom, to, { now: nowMs });

  const nvr = db.stmt(SQL.totals).get(from, to);
  const counts = x => ({ visitors: x.visitors, whatsapp_clicks: x.whatsapp_clicks, leads: x.leads });

  return {
    range: r,
    from,
    to,
    previous_from: prevFrom,
    previous_to: prevTo,
    totals: periodTotals(db, from, to),
    previous: periodTotals(db, prevFrom, prevTo),
    daily: dailySeries(db, from, to),
    previous_daily: dailySeries(db, prevFrom, prevTo),
    sources: dimRows(db, 'source', from, to, 25).map(x => ({ source: x.key || 'direct', ...counts(x) })),
    campaigns: dimRows(db, 'campaign', from, to, TOP_N).map(x => ({ campaign: x.key, ...counts(x) })),
    top_pages: dimRows(db, 'page', from, to, TOP_N).map(x => ({ path: x.key, views: x.views, visitors: x.visitors })),
    top_collections: dimRows(db, 'collection', from, to, TOP_N).map(x => ({
      collection: x.key, name: collectionLabel(db, x.key), views: x.views,
    })),
    top_products: dimRows(db, 'product', from, to, TOP_N).map(x => {
      const p = db.stmt(SQL.productName).get(x.key, x.key, x.key);
      return {
        item: x.key,
        name: p ? p.name : x.key,
        handle: p ? p.handle : '',
        views: x.views,
        whatsapp_clicks: x.whatsapp_clicks,
        leads: x.leads,
      };
    }),
    devices: dimRows(db, 'device', from, to, 10).map(x => ({ device: x.key || 'desktop', visitors: x.visitors })),
    new_vs_returning: { new: nvr.new_visitors, returning: nvr.returning_visitors },
    today: todaySummary(db, { now: nowMs }),
    generated_at: new Date(nowMs).toISOString(),
  };
}

module.exports = {
  ANALYTICS_SCHEMA_SQL,
  EVENT_TYPES,
  RANGES,
  RETENTION_DAYS,
  MAX_EVENTS_PER_DAY,
  MAX_EVENTS_PER_SESSION_DAY,
  ensureAnalyticsSchema,
  recordEvent,
  createEventRecorder,
  trafficReport,
  todaySummary,
  ensureRollups,
  missingDays,
  buildDay,
  purgeOld,
  deriveSource,
  deviceFromUA,
  isBot,
  normHost,
  cleanPath,
  dubaiDay,
  addDays,
};
