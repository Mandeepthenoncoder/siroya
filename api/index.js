'use strict';
/* Vercel serverless entry. vercel.json rewrites every /api/* request here;
   the static site (site/) is served by Vercel's CDN.

   The app (database client, routes, limiters) is built once per warm
   instance. Migrations, the first-run seed and module start-up run once per
   cold start, before the first request is handled.

   Vercel's Node helpers may read the request body before this function runs
   (req.body). When that has happened the bytes are handed to the app as
   req.bufferedBody, which server/lib/http.js readBody() uses instead of the
   (already drained) stream. */
const { loadEnv } = require('../server/lib/env');
const { openDb } = require('../server/lib/db');
const { createApp } = require('../server/server');

let app = null;
let bootError = null;

function getApp() {
  if (app) return app;
  const env = loadEnv();
  const db = openDb();
  app = createApp({ env, db, timers: false });
  return app;
}

/* Re-creates the raw body bytes from Vercel's parsed req.body when the stream
   was already consumed. JSON comes back as an object, text/plain as a string,
   octet-stream as a Buffer. Invalid JSON makes the getter throw: the app then
   sees a body that is not valid JSON and answers as it always does. */
function recoverBody(req) {
  const desc = Object.getOwnPropertyDescriptor(req, 'body');
  const drained = req.readableEnded || req.complete === true && req.readable === false;
  if (!desc || !drained) return;
  let value;
  try {
    value = req.body;
  } catch {
    req.bufferedBody = Buffer.from('{"__invalid_json__":', 'utf8');
    return;
  }
  if (value === undefined || value === null) req.bufferedBody = Buffer.alloc(0);
  else if (Buffer.isBuffer(value)) req.bufferedBody = value;
  else if (typeof value === 'string') req.bufferedBody = Buffer.from(value, 'utf8');
  else req.bufferedBody = Buffer.from(JSON.stringify(value), 'utf8');
}

/* If the platform hands over the rewritten URL (/api/index?...), restore the
   original path from the x-forwarded / matched-path headers when present. */
function originalUrl(req) {
  const url = req.url || '/';
  if (!/^\/api\/index(?:\.js)?(?:[?#]|$)/.test(url)) return url;
  const candidates = [req.headers['x-vercel-original-path'], req.headers['x-original-url'], req.headers['x-forwarded-uri']];
  for (const c of candidates) {
    if (typeof c === 'string' && c.startsWith('/api/')) return c;
  }
  return url;
}

module.exports = async function siroyaApi(req, res) {
  try {
    if (bootError) throw bootError;
    const handler = getApp();
    req.url = originalUrl(req);
    recoverBody(req);
    await handler(req, res);
  } catch (err) {
    // Configuration problems (missing env vars) end up here: say what is wrong
    // without revealing any value.
    if (!bootError && err && /Missing required environment variable|R2_/.test(String(err.message))) bootError = err;
    console.error('Siroya API failed to start:', err && err.stack ? err.stack : err);
    if (!res.headersSent) {
      res.statusCode = 500;
      res.setHeader('Content-Type', 'application/json; charset=utf-8');
      res.setHeader('Cache-Control', 'no-store');
      res.end(JSON.stringify({ error: 'Server configuration error', detail: String(err && err.message || err).slice(0, 300) }));
    } else {
      res.end();
    }
  }
};
