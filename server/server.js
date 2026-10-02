'use strict';
/* Siroya Jewellers server: public site, admin app, uploads and JSON API.
   Zero dependencies (Node 22: node:http + node:sqlite).
   Run: node --no-warnings=ExperimentalWarning server/server.js [--port=5180] */
const http = require('node:http');
const path = require('node:path');

const { loadEnv } = require('./lib/env');
const { openDb } = require('./lib/db');
const { seed } = require('./lib/seed');
const { createAuth } = require('./lib/auth');
const { createLimiter } = require('./lib/ratelimit');
const { createStatic } = require('./lib/static');
const { Router } = require('./lib/router');
const { registerPublic } = require('./lib/api/public');
const { registerAdmin } = require('./lib/api/admin');
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

function createApp({ env, db, siteDir = SITE_DIR }) {
  const auth = createAuth(env);
  const leadLimiter = createLimiter({ limit: 20, windowMs: 10 * 60 * 1000 });
  const loginLimiter = createLimiter({ limit: 10, windowMs: 15 * 60 * 1000 });
  const serveStatic = createStatic(siteDir);
  const router = new Router();
  registerPublic(router, { db, leadLimiter });
  registerAdmin(router, { db, auth, env, loginLimiter, siteDir });

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
      if (!allowedTypes.includes(contentType(req))) {
        throw new HttpError(415, `Content-Type must be ${allowedTypes.join(' or ')}`);
      }
      body = await readJson(req, opts.limit || DEFAULT_BODY_LIMIT);
    }

    const result = await route.handler({ ...ctx, req, res, params, body });
    if (result !== undefined && !res.headersSent) {
      json(req, res, 200, result);
    }
  }

  return async function handler(req, res) {
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
      if (!isHttp && err && err.code === 'ERR_SQLITE_ERROR' && /UNIQUE constraint failed/.test(err.message)) {
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
  };
}

function start() {
  const env = loadEnv();
  const port = Number(portFromArgs(process.argv.slice(2)) || env.PORT || 5173);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    console.error('Invalid port. Use PORT in server/.env or --port=<number>.');
    process.exit(1);
  }
  const db = openDb();
  db.migrate();
  seed(db, SITE_DIR);

  const server = http.createServer(createApp({ env, db }));
  server.requestTimeout = 120000;
  server.headersTimeout = 30000;
  server.keepAliveTimeout = 5000;

  server.on('error', err => {
    if (err.code === 'EADDRINUSE') console.error(`Port ${port} is already in use. Set PORT or run with --port=<number>.`);
    else console.error('Server error:', err.message);
    db.close();
    process.exit(1);
  });

  server.listen(port, env.HOST || undefined, () => {
    console.log(`Siroya running at http://localhost:${port}  (admin: http://localhost:${port}/admin/)`);
  });

  let closing = false;
  const shutdown = signal => {
    if (closing) return;
    closing = true;
    console.log(`${signal} received, shutting down`);
    server.close(() => { db.close(); process.exit(0); });
    if (typeof server.closeIdleConnections === 'function') server.closeIdleConnections();
    setTimeout(() => { db.close(); process.exit(0); }, 3000).unref();
  };
  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('unhandledRejection', err => console.error('Unhandled rejection:', err && err.stack ? err.stack : err));
}

if (require.main === module) start();

module.exports = { createApp, start };
