'use strict';
/* Homepage banner API (docs/HOMEPAGE-BANNER-SPEC.md).
   GET  /api/homepage             public, featured resolved against collections
   GET  /api/admin/homepage       auth, stored object
   PUT  /api/admin/homepage       auth, JSON, validates and saves
   POST /api/admin/upload-video   auth, RAW body (video/mp4 | video/webm)

   The upload route is registered with { raw: true }: server.js must skip
   readJson for routes with that option (one line, see the integration note). */
const crypto = require('node:crypto');
const { HttpError, json, parseCookies, contentType } = require('../http');
const { COOKIE } = require('../auth');
const { createLimiter } = require('../ratelimit');
const H = require('../homepage');
const path = require('node:path');
const { saveVideoStream, cleanFilename, sweepStale, VIDEO_TYPES, MAX_VIDEO_BYTES, TEMP_DIR } = require('../videoupload');

const VIDEO_UPLOADS_PER_HOUR = 20;
const DRAIN_AFTER_413 = 8 * 1024 * 1024;
const DRAIN_MS = 2 * 60 * 1000;
const hasOwn = (o, k) => Object.prototype.hasOwnProperty.call(o, k);
const mbText = bytes => `${Math.round((bytes / (1024 * 1024)) * 10) / 10} MB`;

/* Rate limit key for the signed-in admin session (the signed cookie changes
   on every login); falls back to the client IP. */
function sessionKey(req, ip) {
  const value = parseCookies(req)[COOKIE];
  if (!value) return `ip:${ip || 'unknown'}`;
  return `sess:${crypto.createHash('sha256').update(value).digest('hex').slice(0, 32)}`;
}

/* Options:
   db, siteDir     required
   videoLimiter    optional limiter ({ hit(key) }), default 20 per hour
   maxVideoBytes   optional size cap, default 80 MB
   uploadIdleMs    optional, longest gap between body chunks (default 45 s)
   uploadMaxMs     optional, longest whole upload (default 20 min)
   A stalled upload gets 408 and its socket is closed. */
function registerHomepage(router, { db, siteDir, storage, videoLimiter, maxVideoBytes = MAX_VIDEO_BYTES, uploadIdleMs, uploadMaxMs } = {}) {
  if (!db || !siteDir) throw new Error('registerHomepage needs { db, siteDir }');
  const limiter = videoLimiter || createLimiter({ limit: VIDEO_UPLOADS_PER_HOUR, windowMs: 60 * 60 * 1000 });

  router.get('/api/homepage', async ({ req, res }) => {
    json(req, res, 200, await H.resolveFeatured(db, await H.getHomepage(db)));
  });

  router.get('/api/admin/homepage', () => H.getHomepage(db), { auth: true });

  /* Full object. A missing top-level "hero" or "featured" keeps the saved one. */
  router.put('/api/admin/homepage', ({ body }) => db.tx(async () => {
    const current = await H.getHomepage(db);
    const input = {
      hero: hasOwn(body, 'hero') ? body.hero : current.hero,
      featured: hasOwn(body, 'featured') ? body.featured : current.featured,
    };
    const clean = H.validate(input);
    await H.assertFeaturedCollection(db, clean.featured.collection);
    return H.saveHomepage(db, clean);
  }), { auth: true });

  router.post('/api/admin/upload-video', async ({ req, res, ip }) => {
    if (storage && storage.kind === 'r2') {
      // Media lives in R2: the admin uploads straight there (upload/presign).
      throw new HttpError(409, 'Videos upload straight to media storage. Please reload the admin and try again.');
    }
    // Browsers send Sec-Fetch-Site; refuse uploads started from another site.
    if (String(req.headers['sec-fetch-site'] || '').toLowerCase() === 'cross-site') {
      throw new HttpError(403, 'Uploads must come from the Siroya admin');
    }
    const type = contentType(req);
    if (!VIDEO_TYPES[type]) throw new HttpError(415, 'Upload an MP4 or WebM video (Content-Type video/mp4 or video/webm)');
    if (req.readableEnded) {
      // server.js read the body as JSON: the { raw: true } hookup is missing.
      throw new HttpError(500, 'Video uploads are not enabled on this server yet');
    }
    const declared = req.headers['content-length'] === undefined ? NaN : Number(req.headers['content-length']);
    if (Number.isFinite(declared) && declared > maxVideoBytes) {
      throw new HttpError(413, `Video is larger than ${mbText(maxVideoBytes)}. Please compress it and try again.`);
    }
    if (declared === 0) throw new HttpError(400, 'No video received');

    const r = limiter.hit(sessionKey(req, ip));
    if (!r.ok) {
      throw new HttpError(429, `Upload limit reached (${VIDEO_UPLOADS_PER_HOUR} videos per hour). Please try again later.`, { 'Retry-After': String(r.retryAfter) });
    }

    let saved;
    try {
      saved = await saveVideoStream(siteDir, req, { type, limit: maxVideoBytes, idleMs: uploadIdleMs, maxMs: uploadMaxMs });
    } catch (err) {
      if (!(err instanceof HttpError) || req.destroyed || req.readableEnded) throw err;
      // Refused midway (wrong file type, or a chunked body past the limit).
      // Closing a socket that still has unread body data sends a TCP reset,
      // and browsers then show a network error instead of this message. So
      // the rest of the body is read and dropped first (within a byte and
      // time budget), then the reply goes out on a clean connection.
      const budget = Number.isFinite(declared) ? declared : Math.min(maxVideoBytes, DRAIN_AFTER_413);
      const clean = await discardRest(req, budget);
      if (res.headersSent || res.destroyed) return undefined;
      const headers = { ...(err.headers || {}) };
      if (!clean) {
        headers.Connection = 'close';
        res.on('finish', () => setTimeout(() => req.destroy(), 50).unref());
      }
      json(req, res, err.status, { error: err.message }, headers);
      return undefined;
    }
    json(req, res, 201, { url: saved.url, bytes: saved.bytes, type: saved.type, name: cleanFilename(req.headers['x-filename']) });
    return undefined;
  }, { auth: true, raw: true, contentTypes: Object.keys(VIDEO_TYPES) });

  /* Start-up work, awaited once before the first request: store the defaults
     so the admin starts from the current hero. */
  async function init() {
    try { await H.seedHomepage(db); } catch (err) { console.warn(`Homepage seed skipped: ${err.message}`); }
  }

  /* Daily cron: removes stale temp files of interrupted local video uploads. */
  function sweep() {
    if (storage && storage.kind === 'r2') return false;
    sweepStale(path.join(siteDir, 'uploads', TEMP_DIR));
    return true;
  }

  return { init, sweep };
}

/* Reads and drops the unread part of a refused upload. Resolves true once the
   body has ended, false when it passes `maxBytes`, the client goes away, or
   DRAIN_MS elapses (the caller then closes the connection). */
function discardRest(req, maxBytes) {
  return new Promise(resolve => {
    let seen = 0;
    let settled = false;
    const finish = ok => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      req.off('data', onData);
      req.off('end', onEnd);
      req.off('close', onClose);
      resolve(ok);
    };
    const onData = chunk => {
      seen += chunk.length;
      if (seen > maxBytes) finish(false);
    };
    const onEnd = () => finish(true);
    const onClose = () => finish(req.readableEnded);
    const timer = setTimeout(() => finish(false), DRAIN_MS);
    timer.unref();
    req.on('data', onData);
    req.on('end', onEnd);
    req.on('close', onClose);
    req.resume();
  });
}

module.exports = { registerHomepage, VIDEO_UPLOADS_PER_HOUR };
