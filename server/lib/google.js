'use strict';
/* Google Search Console + Google Analytics 4 (Data API) client.
   Auth: a service-account JSON key, RS256 JWT bearer flow (node:crypto).
   - Outbound hosts are fixed constants. token_uri in the key file is ignored.
     GOOGLE_API_ORIGIN may redirect every host to a local mock, and only
     when NODE_ENV=test.
   - The private key never leaves this module: status() and every error
     message omit it, and nothing here logs.
   - Access token cached in memory until 60 s before expiry.
   - Reports cached in memory and in settings (google_cache) for 6 hours per
     range and date window; refresh bypasses the cache at most once per 5
     minutes.
   - With a secret (the server's SESSION_SECRET), the private key is stored
     encrypted (AES-256-GCM, key from HKDF), so old database pages and backups
     only ever hold ciphertext. An optional wipe() callback runs whenever a key
     is replaced or removed (the API layer uses it to checkpoint and truncate
     the SQLite WAL). */
const crypto = require('node:crypto');
const https = require('node:https');
const http = require('node:http');
const { HttpError } = require('./http');

const TOKEN_AUDIENCE = 'https://oauth2.googleapis.com/token';
const ORIGINS = Object.freeze({
  token: 'https://oauth2.googleapis.com',
  gsc: 'https://searchconsole.googleapis.com',
  ga4: 'https://analyticsdata.googleapis.com',
});
const SCOPES = 'https://www.googleapis.com/auth/webmasters.readonly https://www.googleapis.com/auth/analytics.readonly';
const GRANT_TYPE = 'urn:ietf:params:oauth:grant-type:jwt-bearer';
const TIMEOUT_MS = 15000;
const CACHE_TTL_MS = 6 * 3600 * 1000;
const REFRESH_MIN_MS = 5 * 60 * 1000;
const TOKEN_SKEW_MS = 60 * 1000;
const CACHE_KEEP_MS = 7 * 864e5;
const MAX_RESPONSE_BYTES = 5 * 1024 * 1024;
const SEARCH_RANGES = Object.freeze([7, 28, 90]);
const ANALYTICS_RANGES = Object.freeze([7, 30, 90]);
const SETTINGS_KEY = 'google';
const CACHE_SETTINGS_KEY = 'google_cache';
const DAY_MS = 864e5;
const DUBAI_OFFSET_MS = 4 * 3600 * 1000;

/* An HttpError the API layer can send as is: { error, code }. Upstream
   failures use 502/504 (never 401, which the admin treats as signed out). */
class GoogleError extends HttpError {
  constructor(status, message, code, { transient = false } = {}) {
    super(status, message, null, { code });
    this.name = 'GoogleError';
    this.code = code;
    this.transient = transient;
  }
}

/* Every outbound origin. The override applies only when NODE_ENV=test. */
function apiOrigins(nodeEnv = process.env.NODE_ENV, override = process.env.GOOGLE_API_ORIGIN) {
  if (nodeEnv === 'test' && override) {
    let u = null;
    try { u = new URL(override); } catch { u = null; }
    if (u && (u.protocol === 'http:' || u.protocol === 'https:')) {
      return Object.freeze({ token: u.origin, gsc: u.origin, ga4: u.origin });
    }
  }
  return ORIGINS;
}

/* ---------- small helpers ---------- */

const hasOwn = (o, k) => Object.prototype.hasOwnProperty.call(o, k);
const b64url = value => Buffer.from(typeof value === 'string' ? value : JSON.stringify(value)).toString('base64url');
const num = v => {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
};
const round = (v, digits) => {
  const f = 10 ** digits;
  return Math.round(num(v) * f) / f;
};
const iso = ms => new Date(ms).toISOString();
const dubaiDay = ms => new Date(ms + DUBAI_OFFSET_MS).toISOString().slice(0, 10);
const addDays = (day, n) => new Date(Date.parse(`${day}T00:00:00Z`) + n * DAY_MS).toISOString().slice(0, 10);
function daysBetween(from, to) {
  const out = [];
  for (let d = from; d <= to; d = addDays(d, 1)) out.push(d);
  return out;
}
/* Google's own text, made safe to show: one line, capped. */
const clip = (s, max = 300) => String(s || '').replace(/[\u0000-\u001f\u007f]+/g, ' ').trim().slice(0, max);

/* Current and previous windows of `range` days ending yesterday (Dubai). */
function windows(nowMs, range) {
  const to = addDays(dubaiDay(nowMs), -1);
  const from = addDays(to, -(range - 1));
  const previousTo = addDays(from, -1);
  const previousFrom = addDays(previousTo, -(range - 1));
  return { from, to, previousFrom, previousTo };
}

function parseRange(value, allowed) {
  const n = Number(value);
  if (!allowed.includes(n)) {
    throw new GoogleError(400, `Range must be ${allowed.slice(0, -1).join(', ')} or ${allowed[allowed.length - 1]} days`, 'invalid_range');
  }
  return n;
}

/* ---------- input validation ---------- */

const PEM_RE = /^-----BEGIN (RSA )?PRIVATE KEY-----\n[A-Za-z0-9+/=\s]+\n-----END \1PRIVATE KEY-----\n$/;

/* Service-account key (JSON text or object) -> { client_email, private_key, private_key_id }. */
function parseServiceAccount(value) {
  let obj = value;
  if (typeof value === 'string') {
    if (value.length > 50000) throw new GoogleError(400, 'That key file is too large. Load the service-account .json key downloaded from Google Cloud.', 'invalid_key');
    try {
      obj = JSON.parse(value.charCodeAt(0) === 0xfeff ? value.slice(1) : value);
    } catch {
      throw new GoogleError(400, 'The key is not valid JSON. Load the .json file from Google Cloud (IAM > Service accounts > Keys > Add key > JSON).', 'invalid_key');
    }
  }
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) {
    throw new GoogleError(400, 'The key must be the service-account JSON object from Google Cloud.', 'invalid_key');
  }
  if (obj.type !== 'service_account') {
    throw new GoogleError(400, 'This is not a service-account key ("type" must be "service_account"). In Google Cloud, create a JSON key for a service account, not an OAuth client.', 'invalid_key');
  }
  const email = typeof obj.client_email === 'string' ? obj.client_email.trim() : '';
  if (!email || email.length > 200 || !/^[^\s@<>"']+@[^\s@<>"']+\.[^\s@<>"']+$/.test(email)) {
    throw new GoogleError(400, 'The key has no valid client_email. Download a new JSON key for the service account.', 'invalid_key');
  }
  let pem = typeof obj.private_key === 'string' ? obj.private_key : '';
  pem = `${pem.replace(/\\n/g, '\n').replace(/\r\n?/g, '\n').trim()}\n`;
  if (pem.length > 10000 || !PEM_RE.test(pem)) {
    throw new GoogleError(400, 'The key has no valid private_key (PEM). Download a new JSON key for the service account.', 'invalid_key');
  }
  let keyType = '';
  try { keyType = crypto.createPrivateKey(pem).asymmetricKeyType; } catch { keyType = ''; }
  if (keyType !== 'rsa') {
    throw new GoogleError(400, 'The private_key in this file could not be read as an RSA key. Download a new JSON key for the service account.', 'invalid_key');
  }
  const kid = typeof obj.private_key_id === 'string' && /^[A-Za-z0-9_-]{1,100}$/.test(obj.private_key_id) ? obj.private_key_id : '';
  return { client_email: email, private_key: pem, private_key_id: kid };
}

const DOMAIN_RE = /^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z][a-z0-9-]{1,62}$/;

/* 'sc-domain:siroya.com' or 'https://siroya.com/' (URL-prefix property). */
function parseGscSite(value) {
  if (value === null || value === undefined) return '';
  if (typeof value !== 'string') throw new GoogleError(400, 'Search Console property must be text', 'invalid_site');
  const s = value.trim();
  if (!s) return '';
  const bad = () => new GoogleError(400, 'Search Console property must look like sc-domain:siroya.com (domain property) or https://siroya.com/ (URL-prefix property).', 'invalid_site');
  if (s.length > 200) throw bad();
  if (/^sc-domain:/i.test(s)) {
    const domain = s.slice(10).trim().toLowerCase().replace(/\.$/, '');
    if (!DOMAIN_RE.test(domain)) throw bad();
    return `sc-domain:${domain}`;
  }
  if (/^https?:\/\//i.test(s)) {
    let u;
    try { u = new URL(s); } catch { throw bad(); }
    if (!['http:', 'https:'].includes(u.protocol) || u.username || u.password || u.search || u.hash || !u.hostname.includes('.')) throw bad();
    const out = `${u.origin}${u.pathname.endsWith('/') ? u.pathname : `${u.pathname}/`}`;
    if (/[\s"'<>\\]/.test(out)) throw bad();
    return out;
  }
  throw bad();
}

/* Digits only; accepts 'properties/123' too. */
function parseGa4Property(value) {
  if (value === null || value === undefined) return '';
  if (typeof value !== 'string' && typeof value !== 'number') throw new GoogleError(400, 'GA4 property ID must be digits', 'invalid_property');
  const s = String(value).trim().replace(/^properties\//i, '');
  if (!s) return '';
  if (/^G-/i.test(s)) {
    throw new GoogleError(400, 'That is a Measurement ID (G-...). Use the numeric Property ID from Google Analytics > Admin > Property settings.', 'invalid_property');
  }
  if (!/^\d{1,20}$/.test(s)) {
    throw new GoogleError(400, 'GA4 property ID must be digits only (Google Analytics > Admin > Property settings).', 'invalid_property');
  }
  return s;
}

/* ---------- HTTP ---------- */

/* One HTTPS request (HTTP only for the test origin). Resolves { status, data, text }. */
function httpRequest(urlString, { method = 'GET', headers = {}, body = null, timeoutMs = TIMEOUT_MS } = {}) {
  return new Promise((resolve, reject) => {
    const url = new URL(urlString);
    const mod = url.protocol === 'https:' ? https : http;
    const payload = body === null || body === undefined ? null : Buffer.from(body);
    let timer = null;
    const req = mod.request(url, {
      method,
      headers: {
        Accept: 'application/json',
        'User-Agent': 'siroya-admin/1.0 (+node)',
        ...headers,
        ...(payload ? { 'Content-Length': payload.length } : {}),
      },
    }, res => {
      const chunks = [];
      let size = 0;
      res.on('data', chunk => {
        size += chunk.length;
        if (size > MAX_RESPONSE_BYTES) {
          const err = new Error('Response too large');
          err.code = 'ERESPONSETOOLARGE';
          req.destroy(err);
          return;
        }
        chunks.push(chunk);
      });
      res.on('end', () => {
        clearTimeout(timer);
        const text = Buffer.concat(chunks).toString('utf8');
        let data = null;
        try { data = text ? JSON.parse(text) : null; } catch { data = null; }
        resolve({ status: res.statusCode, data, text });
      });
      res.on('error', err => { clearTimeout(timer); reject(err); });
    });
    timer = setTimeout(() => {
      const err = new Error('Request timed out');
      err.code = 'EGOOGLETIMEOUT';
      req.destroy(err);
    }, timeoutMs);
    req.on('error', err => { clearTimeout(timer); reject(err); });
    if (payload) req.write(payload);
    req.end();
  });
}

/* ---------- errors ---------- */

function googleReasons(data) {
  const err = data && typeof data.error === 'object' && data.error ? data.error : {};
  const out = [];
  if (typeof err.status === 'string') out.push(err.status);
  for (const d of Array.isArray(err.details) ? err.details : []) if (d && typeof d.reason === 'string') out.push(d.reason);
  for (const e of Array.isArray(err.errors) ? err.errors : []) if (e && typeof e.reason === 'string') out.push(e.reason);
  return out.join(' ');
}

function googleMessage(res) {
  const d = res.data;
  if (d && typeof d.error === 'object' && d.error) return clip(d.error.message);
  if (d && typeof d.error === 'string') return clip(d.error_description || d.error);
  return clip(res.text, 200);
}

/* Token endpoint failure -> friendly message. */
function tokenError(res) {
  const d = res.data || {};
  const code = typeof d.error === 'string' ? d.error : '';
  const desc = clip(d.error_description || '', 200);
  if (res.status >= 500) {
    return new GoogleError(502, `Google sign-in is not responding right now (HTTP ${res.status}). Try again in a few minutes.`, 'google_unavailable', { transient: true });
  }
  if (res.status === 429) {
    return new GoogleError(502, 'Google is limiting sign-in requests right now. Try again in a few minutes.', 'google_quota', { transient: true });
  }
  if (/short-lived|iat|exp|clock|time/i.test(desc)) {
    return new GoogleError(502, "Google rejected the sign-in because this server's clock is wrong. Correct the system time and try again.", 'google_auth');
  }
  if (/signature/i.test(desc)) {
    return new GoogleError(502, 'Google rejected the key signature. The key may have been deleted or replaced in Google Cloud. Create a new JSON key and load it again.', 'google_auth');
  }
  if (code === 'invalid_client' || code === 'unauthorized_client' || /not found|disabled|deleted/i.test(desc)) {
    return new GoogleError(502, `Google does not recognise this service account${desc ? ` (${desc})` : ''}. It may have been deleted or disabled. Check it in Google Cloud and load a new JSON key.`, 'google_auth');
  }
  return new GoogleError(502, `Google sign-in failed${desc || code ? `: ${desc || code}` : ` (HTTP ${res.status})`}. Load the JSON key again; if it keeps failing, create a new key.`, 'google_auth');
}

/* API failure -> friendly message. what: 'gsc' | 'gsc_sites' | 'ga4'. */
function apiError(res, what, cfg) {
  const email = cfg.client_email;
  const reasons = googleReasons(res.data);
  const gmsg = googleMessage(res);
  const apiName = what === 'ga4' ? 'Google Analytics Data API' : 'Google Search Console API';
  const status = res.status;
  if (status === 401) {
    return new GoogleError(502, 'Google did not accept the sign-in for this service account. Load the JSON key again, or create a new key if the old one was deleted.', 'google_auth');
  }
  if (status === 403 && (/SERVICE_DISABLED|accessNotConfigured/.test(reasons) || /has not been used|is disabled|not been enabled/i.test(gmsg))) {
    return new GoogleError(502, `The ${apiName} is not enabled in this service account's Google Cloud project. In Google Cloud console open APIs & Services > Library, enable "${apiName}", wait a few minutes and try again.`, 'google_api_disabled');
  }
  if (status === 403 && /ACCESS_TOKEN_SCOPE_INSUFFICIENT|insufficientPermissions.*scope/i.test(reasons)) {
    return new GoogleError(502, 'Google refused the requested read-only access for this key. Load the JSON key again.', 'google_permission');
  }
  if (status === 403) {
    if (what === 'ga4') {
      return new GoogleError(502, `The service account has no access to GA4 property ${cfg.ga4_property}. Add ${email} as a Viewer in Google Analytics (Admin > Property access management).`, 'google_permission');
    }
    if (what === 'gsc') {
      return new GoogleError(502, `The service account has no access to ${cfg.gsc_site}. Add ${email} as a user in Search Console (Settings > Users and permissions; Restricted is enough).`, 'google_permission');
    }
    return new GoogleError(502, `Google refused access to Search Console for ${email}${gmsg ? ` (${gmsg})` : ''}.`, 'google_permission');
  }
  if (status === 404) {
    if (what === 'ga4') {
      return new GoogleError(502, `GA4 property ${cfg.ga4_property} was not found. Check the numeric Property ID in Google Analytics (Admin > Property settings).`, 'google_not_found');
    }
    if (what === 'gsc') {
      return new GoogleError(502, `Search Console property ${cfg.gsc_site} was not found. Use sc-domain:example.com for a domain property, or the full URL with a trailing slash for a URL-prefix property.`, 'google_not_found');
    }
    return new GoogleError(502, 'Google could not find the Search Console API endpoint.', 'google_not_found');
  }
  if (status === 429) {
    return new GoogleError(502, 'Google API quota reached for now. Try again in a few minutes.', 'google_quota', { transient: true });
  }
  if (status >= 500) {
    return new GoogleError(502, `Google is having trouble right now (HTTP ${status}). Try again in a few minutes.`, 'google_unavailable', { transient: true });
  }
  if (status === 400) {
    return new GoogleError(502, `Google rejected the request${gmsg ? `: ${gmsg}` : ''}.`, 'google_bad_request');
  }
  return new GoogleError(502, `Google returned an unexpected response (HTTP ${status}).`, 'google_error', { transient: true });
}

function networkError(err, timeoutMs) {
  if (err && err.code === 'EGOOGLETIMEOUT') {
    return new GoogleError(504, `Google did not respond within ${Math.round(timeoutMs / 1000)} seconds. Try again in a minute.`, 'google_timeout', { transient: true });
  }
  const code = err && typeof err.code === 'string' && /^[A-Z_]{2,40}$/.test(err.code) ? err.code : 'network error';
  return new GoogleError(502, `Could not reach Google (${code}). Check the server's internet connection and try again.`, 'google_unreachable', { transient: true });
}

/* ---------- report parsing ---------- */

const scMetrics = row => ({
  clicks: num(row && row.clicks),
  impressions: num(row && row.impressions),
  // Unrounded for display: the admin rounds once (one decimal).
  ctr: round(row && row.ctr, 6),
  position: round(row && row.position, 6),
});
const scRows = res => (res && Array.isArray(res.rows) ? res.rows : []);
const scKey = row => (row && Array.isArray(row.keys) ? String(row.keys[0] ?? '') : '');

/* GA4 rows as plain objects keyed by dimension / metric name. */
function gaRows(res) {
  if (!res || !Array.isArray(res.rows)) return [];
  const dims = (Array.isArray(res.dimensionHeaders) ? res.dimensionHeaders : []).map(h => h && h.name);
  const mets = (Array.isArray(res.metricHeaders) ? res.metricHeaders : []).map(h => h && h.name);
  return res.rows.map(row => {
    const out = {};
    (row.dimensionValues || []).forEach((v, i) => { out[dims[i] || `d${i}`] = v && v.value !== undefined ? String(v.value) : ''; });
    (row.metricValues || []).forEach((v, i) => { out[mets[i] || `m${i}`] = num(v && v.value); });
    return out;
  });
}

const GA_TOTAL_METRICS = ['activeUsers', 'newUsers', 'sessions', 'engagementRate', 'averageSessionDuration'];
function gaTotals(res) {
  const row = gaRows(res)[0] || {};
  return {
    activeUsers: num(row.activeUsers),
    newUsers: num(row.newUsers),
    sessions: num(row.sessions),
    engagementRate: round(row.engagementRate, 6),
    averageSessionDuration: round(row.averageSessionDuration, 6),
  };
}

/* ---------- private key at rest ---------- */

const ENC_PREFIX = 'v1';
const KEY_UNREADABLE = 'The saved Google key could not be read on this server (its SESSION_SECRET changed). Load the JSON key again in Settings > Google connection.';

/* 32-byte AES key derived from the server secret, or null without one. */
function deriveKey(secret) {
  if (typeof secret !== 'string' || secret.length < 16) return null;
  return Buffer.from(crypto.hkdfSync('sha256', secret, 'siroya-google-key', 'private_key:v1', 32));
}

/* AES-256-GCM, bound to the service-account email. 'v1:<iv>:<tag>:<data>' (base64url). */
function encryptKey(aesKey, pem, email) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', aesKey, iv);
  cipher.setAAD(Buffer.from(String(email), 'utf8'));
  const data = Buffer.concat([cipher.update(pem, 'utf8'), cipher.final()]);
  return [ENC_PREFIX, iv.toString('base64url'), cipher.getAuthTag().toString('base64url'), data.toString('base64url')].join(':');
}

/* The PEM, or '' when the value cannot be decrypted with this key. */
function decryptKey(aesKey, value, email) {
  if (!aesKey || typeof value !== 'string') return '';
  const parts = value.split(':');
  if (parts.length !== 4 || parts[0] !== ENC_PREFIX) return '';
  try {
    const decipher = crypto.createDecipheriv('aes-256-gcm', aesKey, Buffer.from(parts[1], 'base64url'));
    decipher.setAAD(Buffer.from(String(email), 'utf8'));
    decipher.setAuthTag(Buffer.from(parts[2], 'base64url'));
    return Buffer.concat([decipher.update(Buffer.from(parts[3], 'base64url')), decipher.final()]).toString('utf8');
  } catch {
    return '';
  }
}

/* ---------- client ---------- */

/* Options: getSetting/setSetting (required; may return Promises, as the
   openDb() ones do, or plain values), env, now, timeoutMs,
   secret (encrypts the private key at rest; defaults to env.SESSION_SECRET),
   wipe (sync or async; called after a key is replaced or removed, to scrub
   old copies).
   Returns { status, save, disconnect, test, searchReport, analyticsReport,
   ready }: every method is async; ready settles (never rejects) once a key
   saved before the secret was set has been encrypted. */
function createGoogleClient({
  getSetting, setSetting, env = {}, now = Date.now, timeoutMs = TIMEOUT_MS,
  secret = env && env.SESSION_SECRET, wipe = null,
} = {}) {
  if (typeof getSetting !== 'function' || typeof setSetting !== 'function') {
    throw new TypeError('createGoogleClient needs getSetting and setSetting');
  }
  const origins = apiOrigins(process.env.NODE_ENV, process.env.GOOGLE_API_ORIGIN || (env && env.GOOGLE_API_ORIGIN));
  const aesKey = deriveKey(secret);

  let token = null; // { value, expMs, fp }
  let tokenInflight = null; // { fp, promise }
  let generation = 0; // bumps when the key changes or is removed
  const mem = new Map(); // cache key -> { at, data }
  let memLoaded = null; // Promise of the one settings read (loadMem)
  const inflight = new Map();
  let pemCache = null; // { enc, email, pem }: the last decrypted key

  /* Every read-modify-write of the settings rows runs one at a time, so a
     report that finishes while a key is being replaced cannot write the old
     config back. Only top-level operations queue here (never nested). */
  let queue = Promise.resolve();
  function serial(fn) {
    const run = queue.then(fn, fn);
    queue = run.catch(() => {});
    return run;
  }

  async function scrub() {
    if (typeof wipe !== 'function') return;
    try { await wipe(); } catch { /* best effort; never block a disconnect */ }
  }

  /* Raw settings row (the key encrypted when a secret is set). */
  async function loadRaw() {
    const v = await getSetting(SETTINGS_KEY, null);
    return v && typeof v === 'object' && !Array.isArray(v) ? v : {};
  }
  /* Settings with private_key as a usable PEM ('' when missing or unreadable). */
  async function load() {
    const cfg = { ...(await loadRaw()) };
    if (cfg.private_key_enc) {
      if (pemCache && pemCache.enc === cfg.private_key_enc && pemCache.email === cfg.client_email) {
        cfg.private_key = pemCache.pem;
      } else {
        cfg.private_key = decryptKey(aesKey, cfg.private_key_enc, cfg.client_email);
        if (cfg.private_key) pemCache = { enc: cfg.private_key_enc, email: cfg.client_email, pem: cfg.private_key };
      }
    }
    return cfg;
  }
  /* Writes a full config; the PEM is encrypted first when a secret is set. */
  async function persist(cfg) {
    const row = { ...cfg };
    delete row.private_key_enc;
    if (aesKey && row.private_key) {
      // same key as last read: keep its ciphertext (no new copy on every sync)
      const same = pemCache && pemCache.pem === row.private_key && pemCache.email === row.client_email;
      row.private_key_enc = same ? pemCache.enc : encryptKey(aesKey, row.private_key, row.client_email);
      if (!same) pemCache = { enc: row.private_key_enc, email: row.client_email, pem: row.private_key };
      delete row.private_key;
    } else if (!row.private_key) {
      delete row.private_key;
      const raw = await loadRaw();
      // keep an encrypted key this server cannot read, so the error stays visible
      if (raw.private_key_enc && cfg.client_email && cfg.client_email === raw.client_email) row.private_key_enc = raw.private_key_enc;
    }
    await setSetting(SETTINGS_KEY, row);
  }
  async function storeNow(patch) {
    const next = { ...(await load()), ...patch };
    await persist(next);
    return next;
  }
  const store = patch => serial(() => storeNow(patch));
  const keyUnreadable = cfg => Boolean(cfg.client_email && cfg.private_key_enc && !cfg.private_key);
  const isConnected = cfg => Boolean(cfg.client_email && cfg.private_key);
  const fingerprint = cfg => crypto.createHash('sha256')
    .update(`${cfg.client_email}\n${cfg.private_key_id || ''}\n${cfg.private_key}`).digest('hex').slice(0, 24);

  /* A key saved before a secret was configured is encrypted on first start.
     Exposed as client.ready, which never rejects. It starts on the next
     microtask, so creating a client never touches the settings synchronously. */
  const ready = serial(async () => {
    try {
      const raw = await loadRaw();
      if (aesKey && raw.private_key && raw.client_email) {
        await persist(raw);
        await scrub();
      }
    } catch { /* settings not ready (tests); load() still works with plaintext */ }
  });

  async function requireConnected() {
    const cfg = await load();
    if (!isConnected(cfg)) throw new GoogleError(409, 'Google is not connected', 'not_connected');
    return cfg;
  }

  async function status() {
    const cfg = await load();
    return {
      connected: isConnected(cfg),
      client_email: cfg.client_email || '',
      gsc_site: cfg.gsc_site || '',
      ga4_property: cfg.ga4_property || '',
      connected_at: cfg.connected_at || null,
      last_sync: cfg.last_sync || null,
      last_error: keyUnreadable(cfg) ? KEY_UNREADABLE : (cfg.last_error || ''),
    };
  }

  /* ----- cache ----- */

  /* Loads the settings copy once; concurrent callers share the one read. */
  function loadMem() {
    if (!memLoaded) {
      memLoaded = (async () => {
        let saved = null;
        try { saved = await getSetting(CACHE_SETTINGS_KEY, null); } catch { saved = null; }
        if (!saved || typeof saved !== 'object') return;
        for (const [key, entry] of Object.entries(saved)) {
          if (entry && Number.isFinite(entry.at) && entry.data && typeof entry.data === 'object' && !mem.has(key)) mem.set(key, entry);
        }
      })();
    }
    return memLoaded;
  }

  /* Keeps only entries for the current property settings and under a week old. */
  async function persistCache() {
    const cfg = await loadRaw();
    const t = now();
    const keep = {};
    for (const [key, entry] of mem) {
      const current = key.startsWith(`search:${cfg.gsc_site}:`) || key.startsWith(`analytics:${cfg.ga4_property}:`);
      if (current && t - entry.at < CACHE_KEEP_MS) keep[key] = entry;
      else mem.delete(key);
    }
    try { await setSetting(CACHE_SETTINGS_KEY, keep); } catch { /* memory cache still works */ }
  }

  async function clearCache() {
    mem.clear();
    inflight.clear();
    try { await setSetting(CACHE_SETTINGS_KEY, {}); } catch { /* ignore */ }
  }

  const present = (entry, flags) => ({ ...entry.data, fetched_at: iso(entry.at), ...flags });

  /* windowTo: the last day the report should cover now. An entry for an older
     window (fetched before Dubai midnight) is out of date whatever its age;
     it is only served again as stale data when Google fails. */
  async function cached(key, refresh, fetcher, windowTo) {
    await loadMem();
    // From here to inflight.set there is no await, so concurrent callers share one fetch.
    const entry = mem.get(key);
    const t = now();
    if (entry && (!windowTo || (entry.data && entry.data.to === windowTo))) {
      const age = t - entry.at;
      if (!refresh && age >= 0 && age < CACHE_TTL_MS) return present(entry, { cached: true });
      if (refresh && age >= 0 && age < REFRESH_MIN_MS) return present(entry, { cached: true, throttled: true });
    }
    if (inflight.has(key)) return inflight.get(key);
    const gen = generation;
    const p = (async () => {
      try {
        const data = await fetcher();
        const fresh = { at: now(), data };
        await serial(async () => {
          if (gen !== generation) return;
          mem.set(key, fresh);
          await persistCache();
          await storeNow({ last_sync: iso(fresh.at), last_error: '' });
        });
        return present(fresh, { cached: false });
      } catch (err) {
        const message = err instanceof GoogleError ? err.message : 'Could not load data from Google. Try again in a few minutes.';
        await serial(async () => { if (gen === generation) await storeNow({ last_error: message }); });
        if (entry && err instanceof GoogleError && err.transient) {
          return present(entry, { cached: true, stale: true, error: message });
        }
        if (err instanceof GoogleError) throw err;
        throw new GoogleError(502, message, 'google_error');
      } finally {
        if (inflight.get(key) === p) inflight.delete(key);
      }
    })();
    inflight.set(key, p);
    return p;
  }

  /* ----- HTTP with auth ----- */

  async function send(kind, path, opts) {
    try {
      return await httpRequest(`${origins[kind]}${path}`, { ...opts, timeoutMs });
    } catch (err) {
      throw networkError(err, timeoutMs);
    }
  }

  function signAssertion(cfg) {
    const iat = Math.floor(now() / 1000);
    const header = { alg: 'RS256', typ: 'JWT' };
    if (cfg.private_key_id) header.kid = cfg.private_key_id;
    const claims = { iss: cfg.client_email, scope: SCOPES, aud: TOKEN_AUDIENCE, iat, exp: iat + 3600 };
    const input = `${b64url(header)}.${b64url(claims)}`;
    let signature;
    try {
      signature = crypto.createSign('RSA-SHA256').update(input).sign(cfg.private_key).toString('base64url');
    } catch {
      throw new GoogleError(400, 'The stored private key could not sign a request. Load the JSON key again.', 'invalid_key');
    }
    return `${input}.${signature}`;
  }

  async function fetchToken(cfg, fp) {
    const assertion = signAssertion(cfg);
    const res = await send('token', '/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: `grant_type=${encodeURIComponent(GRANT_TYPE)}&assertion=${assertion}`,
    });
    if (res.status !== 200 || !res.data || typeof res.data.access_token !== 'string' || !res.data.access_token) {
      throw tokenError(res);
    }
    const expiresIn = Math.max(120, Math.min(86400, num(res.data.expires_in) || 3600));
    token = { value: res.data.access_token, expMs: now() + expiresIn * 1000, fp };
    return token.value;
  }

  function getToken(cfg) {
    const fp = fingerprint(cfg);
    if (token && token.fp === fp && now() < token.expMs - TOKEN_SKEW_MS) return Promise.resolve(token.value);
    if (tokenInflight && tokenInflight.fp === fp) return tokenInflight.promise;
    const promise = fetchToken(cfg, fp).finally(() => {
      if (tokenInflight && tokenInflight.promise === promise) tokenInflight = null;
    });
    tokenInflight = { fp, promise };
    return promise;
  }

  /* Authenticated JSON call. what: 'gsc' | 'gsc_sites' | 'ga4' (for error text). */
  async function apiCall(kind, path, { method = 'GET', body } = {}, cfg, what) {
    for (let attempt = 0; attempt < 2; attempt++) {
      const access = await getToken(cfg);
      const res = await send(kind, path, {
        method,
        headers: {
          Authorization: `Bearer ${access}`,
          ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
        },
        body: body !== undefined ? JSON.stringify(body) : null,
      });
      if (res.status === 200) return res.data || {};
      if (res.status === 401 && attempt === 0) {
        token = null; // token revoked or expired early: get a new one once
        continue;
      }
      if (res.status === 401) token = null;
      throw apiError(res, what, cfg);
    }
    throw new GoogleError(502, 'Google did not accept the sign-in for this service account.', 'google_auth');
  }

  /* ----- reports ----- */

  async function fetchSearch(cfg, range) {
    const w = windows(now(), range);
    const path = `/webmasters/v3/sites/${encodeURIComponent(cfg.gsc_site)}/searchAnalytics/query`;
    const query = (startDate, endDate, dimensions, rowLimit) => apiCall('gsc', path, {
      method: 'POST',
      body: { startDate, endDate, dimensions, type: 'web', dataState: 'all', rowLimit },
    }, cfg, 'gsc');
    const [cur, prev, daily, queries, pages, devices, countries] = await Promise.all([
      query(w.from, w.to, [], 1),
      query(w.previousFrom, w.previousTo, [], 1),
      query(w.from, w.to, ['date'], range + 10),
      query(w.from, w.to, ['query'], 50),
      query(w.from, w.to, ['page'], 25),
      query(w.from, w.to, ['device'], 10),
      query(w.from, w.to, ['country'], 10),
    ]);
    const byDate = new Map(scRows(daily).map(row => [scKey(row), row]));
    const ranked = (res, name, limit, map = k => k) => scRows(res)
      .map(row => ({ [name]: map(scKey(row)), ...scMetrics(row) }))
      .sort((a, b) => b.clicks - a.clicks || b.impressions - a.impressions)
      .slice(0, limit);
    return {
      range,
      from: w.from,
      to: w.to,
      previous_from: w.previousFrom,
      previous_to: w.previousTo,
      site: cfg.gsc_site,
      totals: scMetrics(scRows(cur)[0]),
      previous: scMetrics(scRows(prev)[0]),
      daily: daysBetween(w.from, w.to).map(date => ({ date, ...scMetrics(byDate.get(date)) })),
      queries: ranked(queries, 'query', 50),
      pages: ranked(pages, 'page', 25),
      devices: ranked(devices, 'device', 10, k => k.toLowerCase()),
      countries: ranked(countries, 'country', 10, k => k.toUpperCase()),
    };
  }

  async function fetchAnalytics(cfg, range) {
    const w = windows(now(), range);
    const path = `/v1beta/properties/${cfg.ga4_property}:runReport`;
    const run = body => apiCall('ga4', path, { method: 'POST', body }, cfg, 'ga4');
    const current = [{ startDate: w.from, endDate: w.to }];
    const metrics = names => names.map(name => ({ name }));
    const bySessions = [{ metric: { metricName: 'sessions' }, desc: true }];
    const [cur, prev, daily, channels, landing] = await Promise.all([
      run({ dateRanges: current, metrics: metrics(GA_TOTAL_METRICS) }),
      run({ dateRanges: [{ startDate: w.previousFrom, endDate: w.previousTo }], metrics: metrics(GA_TOTAL_METRICS) }),
      run({
        dateRanges: current, dimensions: [{ name: 'date' }], metrics: metrics(['activeUsers', 'sessions']),
        orderBys: [{ dimension: { dimensionName: 'date' } }], limit: 400,
      }),
      run({
        dateRanges: current, dimensions: [{ name: 'sessionDefaultChannelGroup' }], metrics: metrics(['sessions', 'activeUsers']),
        orderBys: bySessions, limit: 20,
      }),
      run({
        dateRanges: current, dimensions: [{ name: 'landingPage' }], metrics: metrics(['sessions']),
        orderBys: bySessions, limit: 25,
      }),
    ]);
    const byDate = new Map(gaRows(daily).map(row => {
      const d = String(row.date || '');
      return [/^\d{8}$/.test(d) ? `${d.slice(0, 4)}-${d.slice(4, 6)}-${d.slice(6, 8)}` : d, row];
    }));
    return {
      range,
      from: w.from,
      to: w.to,
      previous_from: w.previousFrom,
      previous_to: w.previousTo,
      property: cfg.ga4_property,
      totals: gaTotals(cur),
      previous: gaTotals(prev),
      daily: daysBetween(w.from, w.to).map(date => {
        const row = byDate.get(date) || {};
        return { date, activeUsers: num(row.activeUsers), sessions: num(row.sessions) };
      }),
      channels: gaRows(channels)
        .map(row => ({ channel: row.sessionDefaultChannelGroup || '(other)', sessions: num(row.sessions), users: num(row.activeUsers) }))
        .sort((a, b) => b.sessions - a.sessions),
      landing_pages: gaRows(landing)
        .map(row => ({ page: row.landingPage || '(not set)', sessions: num(row.sessions) }))
        .sort((a, b) => b.sessions - a.sessions)
        .slice(0, 25),
    };
  }

  async function searchReport(range, { refresh = false } = {}) {
    const r = parseRange(range, SEARCH_RANGES);
    const cfg = await requireConnected();
    if (!cfg.gsc_site) throw new GoogleError(409, 'Choose a Search Console property in Settings > Google connection first.', 'no_site');
    return cached(`search:${cfg.gsc_site}:${r}`, Boolean(refresh), () => fetchSearch(cfg, r), windows(now(), r).to);
  }

  async function analyticsReport(range, { refresh = false } = {}) {
    const r = parseRange(range, ANALYTICS_RANGES);
    const cfg = await requireConnected();
    if (!cfg.ga4_property) throw new GoogleError(409, 'Enter the GA4 property ID in Settings > Google connection first.', 'no_property');
    return cached(`analytics:${cfg.ga4_property}:${r}`, Boolean(refresh), () => fetchAnalytics(cfg, r), windows(now(), r).to);
  }

  /* ----- connection management ----- */

  /* input: { service_account_json?, gsc_site?, ga4_property? }. Resolves with status(). */
  async function save(input) {
    if (!input || typeof input !== 'object' || Array.isArray(input)) throw new GoogleError(400, 'Expected a JSON object', 'invalid_input');
    await serial(() => saveNow(input));
    return status();
  }

  async function saveNow(input) {
    const cfg = await load();
    const next = { ...cfg };
    let keyChanged = false;
    const hadKey = Boolean(cfg.private_key || cfg.private_key_enc);
    const rawKey = input.service_account_json;
    if (rawKey !== undefined && rawKey !== null && rawKey !== '') {
      const sa = parseServiceAccount(rawKey);
      keyChanged = sa.client_email !== cfg.client_email || sa.private_key !== cfg.private_key || sa.private_key_id !== (cfg.private_key_id || '');
      Object.assign(next, sa);
      if (keyChanged) {
        next.connected_at = iso(now());
        next.last_sync = null;
        next.last_error = '';
      }
    }
    if (hasOwn(input, 'gsc_site')) next.gsc_site = parseGscSite(input.gsc_site);
    if (hasOwn(input, 'ga4_property')) next.ga4_property = parseGa4Property(input.ga4_property);
    const configChanged = (next.gsc_site || '') !== (cfg.gsc_site || '') || (next.ga4_property || '') !== (cfg.ga4_property || '');
    if (configChanged && !keyChanged) next.last_error = '';
    await persist(next);
    if (keyChanged) {
      generation++;
      token = null;
      tokenInflight = null;
      pemCache = null;
      await clearCache();
      if (hadKey) await scrub(); // the old key must not linger in freed pages or the WAL
    } else if (configChanged) {
      await loadMem();
      await persistCache();
    }
  }

  /* Wipes the key, token and cached reports. Property names stay for reconnecting.
     The key still works at Google until it is deleted there (the admin says so).
     Resolves with status(). */
  async function disconnect() {
    // Reports that finish from now on belong to the old key and are not stored.
    generation++;
    token = null;
    tokenInflight = null;
    pemCache = null;
    await serial(async () => {
      const cfg = await loadRaw();
      generation++;
      token = null;
      tokenInflight = null;
      pemCache = null;
      await setSetting(SETTINGS_KEY, { gsc_site: cfg.gsc_site || '', ga4_property: cfg.ga4_property || '' });
      await clearCache();
      await scrub();
    });
    return status();
  }

  /* Token + Search Console site list + (if set) a 1-day GA4 report. */
  async function test() {
    const cfg = await requireConnected();
    const out = { ok: false, client_email: cfg.client_email, sites: [], site_permissions: [], gsc_ok: null, ga4_ok: null, error: '' };
    const errors = [];
    try {
      await getToken(cfg);
    } catch (err) {
      out.error = err instanceof GoogleError ? err.message : 'Could not sign in to Google with this key.';
      out.gsc_ok = false;
      if (cfg.ga4_property) out.ga4_ok = false;
      await store({ last_error: out.error });
      return out;
    }
    try {
      const res = await apiCall('gsc', '/webmasters/v3/sites', { method: 'GET' }, cfg, 'gsc_sites');
      const entries = (Array.isArray(res.siteEntry) ? res.siteEntry : [])
        .filter(e => e && typeof e.siteUrl === 'string' && e.permissionLevel !== 'siteUnverifiedUser')
        .map(e => ({ site: clip(e.siteUrl, 200), permission: clip(e.permissionLevel, 40) }))
        .sort((a, b) => a.site.localeCompare(b.site));
      out.site_permissions = entries;
      out.sites = entries.map(e => e.site);
      if (cfg.gsc_site) {
        out.gsc_ok = out.sites.includes(cfg.gsc_site);
        if (!out.gsc_ok) {
          errors.push(`The service account has no access to ${cfg.gsc_site}. Add ${cfg.client_email} as a user in Search Console (Settings > Users and permissions; Restricted is enough).`);
        }
      } else if (!out.sites.length) {
        out.gsc_ok = false;
        errors.push(`The key works, but no Search Console property is shared with ${cfg.client_email} yet. Add it as a user in Search Console (Settings > Users and permissions).`);
      } else {
        out.gsc_ok = true;
      }
    } catch (err) {
      out.gsc_ok = false;
      errors.push(err instanceof GoogleError ? err.message : 'Search Console check failed.');
    }
    if (cfg.ga4_property) {
      try {
        await apiCall('ga4', `/v1beta/properties/${cfg.ga4_property}:runReport`, {
          method: 'POST',
          body: { dateRanges: [{ startDate: 'yesterday', endDate: 'yesterday' }], metrics: [{ name: 'activeUsers' }] },
        }, cfg, 'ga4');
        out.ga4_ok = true;
      } catch (err) {
        out.ga4_ok = false;
        errors.push(err instanceof GoogleError ? err.message : 'Google Analytics check failed.');
      }
    }
    out.ok = errors.length === 0;
    out.error = errors.join(' ');
    await store({ last_error: out.error });
    return out;
  }

  return { status, save, disconnect, test, searchReport, analyticsReport, ready };
}

module.exports = {
  createGoogleClient,
  GoogleError,
  apiOrigins,
  parseServiceAccount,
  parseGscSite,
  parseGa4Property,
  SEARCH_RANGES,
  ANALYTICS_RANGES,
  ORIGINS,
  SCOPES,
};
