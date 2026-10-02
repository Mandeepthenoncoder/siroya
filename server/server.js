'use strict';
/* Siroya Jewellers server: public site, admin app, uploads and JSON API.
   Runs two ways from the same code:
   - Locally: `npm start` (node:http, SQLite file via @libsql/client, uploads
     on disk, nightly timers).
   - On Vercel: api/index.js wraps createApp()'s handler (Turso database,
     Cloudflare R2 media, a daily cron instead of timers).
   Run: node server/server.js [--port=5180] */
const http = require('node:http');
const path = require('node:path');
const crypto = require('node:crypto');

const { loadEnv, isServerless } = require('./lib/env');
const { openDb } = require('./lib/db');
const { seed } = require('./lib/seed');
const { createAuth } = require('./lib/auth');
const { createLimiter } = require('./lib/ratelimit');
const { createStatic } = require('./lib/static');
const { createStorage } = require('./lib/storage');
const { Router } = require('./lib/router');
const { registerPublic } = require('./lib/api/public');
const { registerAdmin } = require('./lib/api/admin');
const { registerTraffic } = require('./lib/api/traffic');
const { registerHomepage } = require('./lib/api/homepage');
const {
  HttpError, setSecurityHeaders, sendError, contentType, readJson, clientIp, json,
} = require('./lib/http');

const SITE_DIR = path.resolve(__dirname, '..', 'site');
const DEFAULT_BODY_LIMIT = 200 * 1024;
const MUTATING = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

function portFromArgs(argv) {
  for (let i = 0; i < argv.length; i++) {
    const m = /^--port(?:=(\d+))?$/.exec(argv[i]);
    if (m) return m[1] || argv[i + 1];
  }
  return undefined;
}

/* Constant-time check of "Authorization: Bearer <CRON_SECRET>". */
function cronAuthorized(req, secret) {
  if (!secret) return false;
  const got = Buffer.from(String(req.headers.authorization || ''));
  const want = Buffer.from(`Bearer ${secret}`);
  return got.length === want.length && crypto.timingSafeEqual(got, want);
}

/* Options:
   env, db       required (db from openDb())
   siteDir       site folder (default ../site)
   storage       media storage (default: R2 when R2_ACCOUNT_ID is set, else disk)
   timers        nightly maintenance timers (default: on locally, off on Vercel)
   seed          import data.js into an empty database (default true)
   The returned handler(req, res) runs migrations, the first-run seed and the
   modules' start-up work once (handler.ready()) before the first API request. */
function createApp({ env, db, siteDir = SITE_DIR, storage, timers = !isServerless(), seed: doSeed = true }) {
  const media = storage || createStorage({ siteDir });
  const auth = createAuth(env);
  const leadLimiter = createLimiter({ limit: 20, windowMs: 10 * 60 * 1000 });
  const loginLimiter = createLimiter({ limit: 10, windowMs: 15 * 60 * 1000 });
  const serveStatic = createStatic(siteDir);
  const router = new Router();
  registerPublic(router, { db, leadLimiter });
  registerAdmin(router, { db, auth, env, loginLimiter, siteDir, storage: media });
  const traffic = registerTraffic(router, { db, env, timers });
  const homepage = registerHomepage(router, { db, siteDir, storage: media });

  /* Daily maintenance (Vercel cron, 00:01 Dubai): analytics retention purge
     and rollups, plus the local video temp sweep. */
  router.get('/api/cron/daily', async ({ req }) => {
    const secret = env.CRON_SECRET || '';
    if (!secret) throw new HttpError(404, 'Not found');
    if (!cronAuthorized(req, secret)) throw new HttpError(401, 'Not authorized');
    const started = Date.now();
    const analytics = await traffic.maintain();
    const swept = homepage.sweep();
    return { ok: true, analytics, swept, ms: Date.now() - started };
  });

  let ready = null;
  function init() {
    if (!ready) {
      ready = (async () => {
        await db.migrate();
        if (doSeed) await seed(db, siteDir);
        await homepage.init();
        await traffic.init();
      })();
      ready.catch(err => {
        ready = null; // retry on the next request
        console.error('Start-up failed:', err && err.stack ? err.stack : err);
      });
    }
    return ready;
  }

  async function handleApi(req, res, ctx) {
    const found = router.match(req.method, ctx.path);
    if (!found) throw new HttpError(404, 'Not found');
    if (found.allowed) throw new HttpError(405, 'Method not allowed', { Allow: found.allowed.join(', ') });
    const { route, params } = found;
    const opts = route.opts;

    if (opts.rateLimit) {
      const r = opts.rateLimit.hit(ctx.ip);
      if (!r.ok) throw new HttpError(429, opts.rateLimitMessage || 'Too many requests. Please try again in a few minutes.', { 'Retry-After': String(r.retryAfter) });
    }
    if (opts.auth && !auth.isAuthed(req)) throw new HttpError(401, 'Not signed in');

    let body = {};
    if (MUTATING.has(req.method)) {
      const allowedTypes = opts.contentTypes || ['application/json'];
      if (opts.beacon) {
        // Beacon routes always reach their handler (it answers 204): a wrong
        // content type or a body that is not a JSON object arrives as null.
        try {
          const parsed = await readJson(req, opts.limit || DEFAULT_BODY_LIMIT);
          body = allowedTypes.includes(contentType(req)) ? parsed : null;
        } catch (err) {
          if (err instanceof HttpError && err.status === 413) throw err;
          body = null;
        }
      } else {
        if (!allowedTypes.includes(contentType(req))) {
          throw new HttpError(415, `Content-Type must be ${allowedTypes.join(' or ')}`);
        }
        if (!opts.raw) body = await readJson(req, opts.limit || DEFAULT_BODY_LIMIT);
      }
    }

    const result = await route.handler({ ...ctx, req, res, params, body });
    if (result !== undefined && !res.headersSent) {
      json(req, res, 200, result);
    }
  }

  async function handler(req, res) {
    const started = process.hrtime.bigint();
    const rawUrl = req.url || '/';
    const qIndex = rawUrl.indexOf('?');
    const rawPath = qIndex === -1 ? rawUrl : rawUrl.slice(0, qIndex);
    const rawQuery = qIndex === -1 ? '' : rawUrl.slice(qIndex + 1);

    res.on('finish', () => {
      const ms = Number(process.hrtime.bigint() - started) / 1e6;
      const logPath = rawPath.replace(/[^\x21-\x7e]/g, '?').slice(0, 300);
      console.log(`${req.method} ${logPath} ${res.statusCode} ${ms.toFixed(1)}ms`);
    });
    setSecurityHeaders(res);

    try {
      if (!rawPath.startsWith('/')) throw new HttpError(400, 'Bad request');
      let decoded;
      try {
        decoded = decodeURIComponent(rawPath);
      } catch {
        throw new HttpError(400, 'Bad request');
      }
      if (decoded.includes('\u0000')) throw new HttpError(400, 'Bad request');

      if (decoded === '/api' || decoded.startsWith('/api/')) {
        if (decoded.startsWith('/api/admin')) res.setHeader('X-Robots-Tag', 'noindex, nofollow');
        try {
          await init();
        } catch {
          throw new HttpError(503, 'The service is starting up or the database is unreachable. Please try again in a moment.');
        }
        const ctx = { path: decoded, query: new URLSearchParams(rawQuery), ip: clientIp(req, env.TRUST_PROXY) };
        await handleApi(req, res, ctx);
        if (!res.headersSent) throw new HttpError(500, 'No response');
        return;
      }

      if (decoded === '/admin') {
        res.writeHead(301, { Location: `/admin/${rawQuery ? `?${rawQuery}` : ''}`, 'Cache-Control': 'no-store', 'Content-Length': 0 });
        res.end();
        return;
      }

      await serveStatic(req, res, decoded, rawPath, rawQuery);
    } catch (err) {
      const isHttp = err instanceof HttpError;
      let status = isHttp ? err.status : 500;
      let message = isHttp ? err.message : 'Something went wrong. Please try again.';
      if (!isHttp && err && /UNIQUE constraint failed/.test(String(err.message))) {
        status = 409;
        message = 'That slug or handle is already in use';
      } else if (!isHttp) {
        console.error(`Error handling ${req.method} ${rawPath}:`, err && err.stack ? err.stack : err);
      }
      if (res.headersSent) {
        res.destroy();
        return;
      }
      const headers = { ...(isHttp && err.headers ? err.headers : {}) };
      if (status === 413) headers.Connection = 'close';
      sendError(req, res, status, message, headers, isHttp ? err.data : null);
      if (status === 413) {
        // Stop reading an oversized body: close once the response is flushed.
        res.on('finish', () => setTimeout(() => req.destroy(), 50).unref());
      }
    }
  }

  handler.ready = init;
  handler.traffic = traffic;
  handler.homepage = homepage;
  handler.storage = media;
  return handler;
}

async function start() {
  const env = loadEnv();
  const port = Number(portFromArgs(process.argv.slice(2)) || env.PORT || 5173);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    console.error('Invalid port. Use PORT in server/.env or --port=<number>.');
    process.exit(1);
  }
  const db = openDb(process.env.SIROYA_DB || undefined);
  const app = createApp({ env, db });
  try {
    await app.ready();
  } catch (err) {
    console.error('Could not open the database:', err && err.message ? err.message : err);
    await db.close();
    process.exit(1);
  }

  const server = http.createServer(app);
  server.requestTimeout = 1200000;
  server.headersTimeout = 30000;
  server.keepAliveTimeout = 5000;

  server.on('error', err => {
    if (err.code === 'EADDRINUSE') console.error(`Port ${port} is already in use. Set PORT or run with --port=<number>.`);
    else console.error('Server error:', err.message);
    db.close().finally(() => process.exit(1));
  });

  server.listen(port, env.HOST || undefined, () => {
    const where = db.mode === 'file' ? path.relative(process.cwd(), db.file) || db.file : 'Turso';
    const media = app.storage.kind === 'r2' ? 'Cloudflare R2' : 'site/uploads';
    console.log(`Siroya running at http://localhost:${port}  (admin: http://localhost:${port}/admin/)  db: ${where}  media: ${media}`);
  });

  let closing = false;
  const shutdown = signal => {
    if (closing) return;
    closing = true;
    console.log(`${signal} received, shutting down`);
    app.traffic.stop();
    server.close(() => { db.close().finally(() => process.exit(0)); });
    if (typeof server.closeIdleConnections === 'function') server.closeIdleConnections();
    setTimeout(() => { process.exit(0); }, 3000).unref();
  };
  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('unhandledRejection', err => console.error('Unhandled rejection:', err && err.stack ? err.stack : err));
}

if (require.main === module) start();

module.exports = { createApp, start, SITE_DIR };
