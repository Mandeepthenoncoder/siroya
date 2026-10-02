'use strict';
/* Small HTTP helpers: errors, JSON responses, body reading, cookies, gzip. */
const zlib = require('node:zlib');

class HttpError extends Error {
  /* data: extra JSON fields merged into the {error} response body. */
  constructor(status, message, headers, data) {
    super(message);
    this.status = status;
    this.headers = headers || null;
    this.data = data || null;
  }
}

const SECURITY_HEADERS = {
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'strict-origin-when-cross-origin',
  'X-Frame-Options': 'SAMEORIGIN',
};

function setSecurityHeaders(res) {
  for (const [k, v] of Object.entries(SECURITY_HEADERS)) res.setHeader(k, v);
}

function acceptsGzip(req) {
  return /\bgzip\b/i.test(String(req.headers['accept-encoding'] || ''));
}

/* Sends a buffer, gzipping text bodies over 1 KB when the client accepts it. */
function sendBuffer(req, res, status, headers, buf, compressible) {
  const out = { ...headers };
  let body = buf;
  if (compressible) {
    out['Vary'] = 'Accept-Encoding';
    if (buf.length >= 1024 && acceptsGzip(req)) {
      body = zlib.gzipSync(buf, { level: 6 });
      out['Content-Encoding'] = 'gzip';
    }
  }
  out['Content-Length'] = body.length;
  res.writeHead(status, out);
  res.end(req.method === 'HEAD' ? undefined : body);
}

function json(req, res, status, data, headers) {
  const buf = Buffer.from(JSON.stringify(data), 'utf8');
  sendBuffer(req, res, status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    ...(headers || {}),
  }, buf, true);
}

function sendError(req, res, status, message, headers, data) {
  json(req, res, status, { ...(data || {}), error: message }, headers);
}

function contentType(req) {
  return String(req.headers['content-type'] || '').split(';')[0].trim().toLowerCase();
}

/* Reads the raw request body, rejecting with 413 once it passes `limit` bytes. */
function readBody(req, limit) {
  return new Promise((resolve, reject) => {
    const declared = Number(req.headers['content-length']);
    if (Number.isFinite(declared) && declared > limit) {
      reject(new HttpError(413, 'Request body too large'));
      return;
    }
    const chunks = [];
    let size = 0;
    let settled = false;
    const finish = (fn, v) => { if (!settled) { settled = true; fn(v); } };
    req.on('data', chunk => {
      if (settled) return;
      size += chunk.length;
      if (size > limit) {
        chunks.length = 0;
        finish(reject, new HttpError(413, 'Request body too large'));
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => finish(resolve, Buffer.concat(chunks)));
    req.on('error', err => finish(reject, err));
    req.on('aborted', () => finish(reject, new HttpError(400, 'Request aborted')));
  });
}

/* Reads and parses a JSON object body. Empty body becomes {}. */
async function readJson(req, limit) {
  const buf = await readBody(req, limit);
  let text = buf.toString('utf8');
  if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);
  if (!text.trim()) return {};
  let data;
  try {
    data = JSON.parse(text);
  } catch {
    throw new HttpError(400, 'Invalid JSON body');
  }
  if (!data || typeof data !== 'object' || Array.isArray(data)) {
    throw new HttpError(400, 'Expected a JSON object');
  }
  return data;
}

function parseCookies(req) {
  const out = {};
  const header = req.headers.cookie;
  if (!header) return out;
  for (const part of header.split(';')) {
    const eq = part.indexOf('=');
    if (eq < 1) continue;
    const key = part.slice(0, eq).trim();
    let val = part.slice(eq + 1).trim();
    if (val.startsWith('"') && val.endsWith('"')) val = val.slice(1, -1);
    if (!(key in out)) {
      try { out[key] = decodeURIComponent(val); } catch { out[key] = val; }
    }
  }
  return out;
}

function clientIp(req, trustProxy) {
  if (trustProxy) {
    const fwd = String(req.headers['x-forwarded-for'] || '').split(',')[0].trim();
    if (fwd) return fwd;
  }
  return req.socket.remoteAddress || 'unknown';
}

function isHttps(req, trustProxy) {
  if (req.socket.encrypted) return true;
  return Boolean(trustProxy) && String(req.headers['x-forwarded-proto'] || '').split(',')[0].trim() === 'https';
}

module.exports = {
  HttpError, setSecurityHeaders, sendBuffer, json, sendError, contentType,
  readBody, readJson, parseCookies, clientIp, isHttps, acceptsGzip,
};
