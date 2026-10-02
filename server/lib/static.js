'use strict';
/* Static file serving for site/: traversal-safe path resolution, directory
   index, ETag / 304, gzip for text assets, byte ranges for media. */
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const zlib = require('node:zlib');
const { HttpError, sendBuffer, acceptsGzip } = require('./http');

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.htm': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
  '.webmanifest': 'application/manifest+json; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8',
  '.csv': 'text/csv; charset=utf-8',
  '.xml': 'application/xml; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.avif': 'image/avif',
  '.gif': 'image/gif',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
  '.woff': 'font/woff',
  '.ttf': 'font/ttf',
  '.otf': 'font/otf',
  '.mp4': 'video/mp4',
  '.webm': 'video/webm',
  '.pdf': 'application/pdf',
};
const COMPRESSIBLE = new Set(['.html', '.htm', '.css', '.js', '.mjs', '.json', '.map', '.webmanifest', '.txt', '.csv', '.xml', '.svg', '.ico']);
const LONG_CACHE = new Set(['.png', '.jpg', '.jpeg', '.webp', '.avif', '.gif', '.woff2', '.woff', '.ttf', '.otf', '.mp4', '.webm']);
const GZIP_MAX = 5 * 1024 * 1024;
const GZIP_CACHE_MAX = 32 * 1024 * 1024;

const NOT_FOUND_HTML = Buffer.from(`<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Page not found | Siroya Jewellers</title><style>body{margin:0;min-height:100vh;display:grid;place-items:center;background:#F5F2EC;color:#241A19;font:16px/1.6 system-ui,sans-serif;text-align:center;padding:24px}a{color:#981E1D;font-weight:600}</style></head><body><main><h1 style="font-weight:500;letter-spacing:.04em">Page not found</h1><p>The page you were looking for has moved or no longer exists.</p><p><a href="/">Back to Siroya Jewellers</a></p></main></body></html>`);

function createStatic(siteDir) {
  // Native realpath matches fsp.realpath below (true casing on Windows).
  // On Vercel the site folder may be missing from the function bundle (the CDN
  // serves it); static requests never reach the function there.
  let root;
  try { root = fs.realpathSync.native(siteDir); } catch { root = path.resolve(siteDir); }
  const gzCache = new Map();
  let gzBytes = 0;

  const inside = p => p === root || p.startsWith(root + path.sep);

  function notFound(req, res) {
    sendBuffer(req, res, 404, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' }, NOT_FOUND_HTML, true);
  }

  async function gzipped(file, st) {
    const key = `${file}|${st.size}|${st.mtimeMs}`;
    const hit = gzCache.get(key);
    if (hit) return hit;
    const buf = zlib.gzipSync(await fsp.readFile(file), { level: 6 });
    for (const k of gzCache.keys()) if (k.startsWith(`${file}|`)) { gzBytes -= gzCache.get(k).length; gzCache.delete(k); }
    while (gzBytes + buf.length > GZIP_CACHE_MAX && gzCache.size) {
      const [k, v] = gzCache.entries().next().value;
      gzBytes -= v.length;
      gzCache.delete(k);
    }
    gzCache.set(key, buf);
    gzBytes += buf.length;
    return buf;
  }

  /* decodedPath: already URI-decoded, starts with "/". rawPath/rawQuery are
     the original (still encoded) parts, used only for redirects. */
  return async function serveStatic(req, res, decodedPath, rawPath, rawQuery) {
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      throw new HttpError(405, 'Method not allowed', { Allow: 'GET, HEAD' });
    }
    // Reject Windows separators, drive letters / alternate data streams and NUL.
    if (/[\\:\u0000]/.test(decodedPath)) return notFound(req, res);
    const segments = decodedPath.split('/');
    if (segments.some(s => s === '..')) throw new HttpError(403, 'Forbidden');
    // Hidden files and folders (.env, .git, ...) are never served; /.well-known/ is allowed.
    if (segments.some((s, i) => s.startsWith('.') && !(i === 1 && s === '.well-known'))) return notFound(req, res);

    let file = path.resolve(root, `.${decodedPath}`);
    if (!inside(file)) throw new HttpError(403, 'Forbidden');

    let st = await fsp.stat(file).catch(() => null);
    if (!st) return notFound(req, res);
    if (st.isDirectory()) {
      if (!decodedPath.endsWith('/')) {
        const location = `/${rawPath.replace(/^\/+/, '')}/${rawQuery ? `?${rawQuery}` : ''}`;
        res.writeHead(301, { Location: location, 'Cache-Control': 'no-cache', 'Content-Length': 0 });
        res.end();
        return;
      }
      file = path.join(file, 'index.html');
      st = await fsp.stat(file).catch(() => null);
    }
    if (!st || !st.isFile()) return notFound(req, res);

    const real = await fsp.realpath(file).catch(() => null);
    if (!real || !inside(real)) throw new HttpError(403, 'Forbidden');

    const ext = path.extname(file).toLowerCase();
    const type = MIME[ext] || 'application/octet-stream';
    const etag = `W/"${st.size.toString(16)}-${Math.floor(st.mtimeMs).toString(16)}"`;
    const headers = {
      'Content-Type': type,
      'Last-Modified': st.mtime.toUTCString(),
      ETag: etag,
    };
    const lowerPath = decodedPath.toLowerCase();
    if (lowerPath.startsWith('/admin/')) {
      headers['Cache-Control'] = 'no-store';
      headers['X-Robots-Tag'] = 'noindex, nofollow';
    } else if (lowerPath.startsWith('/uploads/')) {
      headers['Cache-Control'] = 'public, max-age=31536000, immutable';
      headers['Content-Security-Policy'] = "sandbox allow-same-origin; default-src 'none'; img-src 'self'; media-src 'self'; style-src 'unsafe-inline'";
    } else if (LONG_CACHE.has(ext)) {
      headers['Cache-Control'] = 'public, max-age=3600';
    } else {
      headers['Cache-Control'] = 'no-cache';
    }
    const compressible = COMPRESSIBLE.has(ext);
    if (compressible) headers['Vary'] = 'Accept-Encoding';

    const inm = req.headers['if-none-match'];
    if (inm ? inm.split(',').map(s => s.trim()).includes(etag)
      : (req.headers['if-modified-since'] && Date.parse(req.headers['if-modified-since']) >= Math.floor(st.mtimeMs / 1000) * 1000)) {
      if (headers['Cache-Control'] !== 'no-store') {
        res.writeHead(304, headers);
        res.end();
        return;
      }
    }

    if (compressible && st.size >= 1024 && st.size <= GZIP_MAX && acceptsGzip(req)) {
      const gz = await gzipped(file, st);
      res.writeHead(200, { ...headers, 'Content-Encoding': 'gzip', 'Content-Length': gz.length });
      res.end(req.method === 'HEAD' ? undefined : gz);
      return;
    }

    headers['Accept-Ranges'] = 'bytes';
    let start = 0;
    let end = st.size - 1;
    let status = 200;
    const range = req.headers.range;
    if (range && !compressible && st.size > 0) {
      const m = /^bytes=(\d*)-(\d*)$/.exec(String(range).trim());
      if (m && (m[1] !== '' || m[2] !== '')) {
        if (m[1] === '') {
          start = Math.max(0, st.size - Number(m[2]));
        } else {
          start = Number(m[1]);
          if (m[2] !== '') end = Math.min(end, Number(m[2]));
        }
        if (start > end || start >= st.size) {
          res.writeHead(416, { 'Content-Range': `bytes */${st.size}`, 'Content-Length': 0 });
          res.end();
          return;
        }
        status = 206;
        headers['Content-Range'] = `bytes ${start}-${end}/${st.size}`;
      }
    }
    headers['Content-Length'] = st.size === 0 ? 0 : end - start + 1;
    res.writeHead(status, headers);
    if (req.method === 'HEAD' || st.size === 0) {
      res.end();
      return;
    }
    await new Promise(resolve => {
      const stream = fs.createReadStream(file, { start, end });
      stream.on('error', () => { res.destroy(); resolve(); });
      res.on('close', () => { stream.destroy(); resolve(); });
      stream.pipe(res);
    });
  };
}

module.exports = { createStatic, MIME };
