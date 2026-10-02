'use strict';
/* Media storage: local disk (site/uploads/...) or Cloudflare R2.
   R2 is used when R2_ACCOUNT_ID is set (production on Vercel); the other R2_*
   variables are then required. Keys are uploads/<yyyy>/<mm>/<16 hex>.<ext>;
   local files are referenced as "uploads/..." (relative to the site), R2
   objects by their public URL, R2_PUBLIC_URL + "/" + key.

   createStorage({ siteDir, env })   -> storage
     storage.kind                     'local' | 'r2'
     storage.put(key, buffer, type)   -> public reference (url or path)
     storage.presignPut(key, type, size, { signLength }) -> signed PUT URL (r2 only)
   presignUpload(storage, body)       -> response for POST /api/admin/upload/presign
   mediaBase()                        -> R2_PUBLIC_URL without a trailing slash, or ''
   isStoredMediaUrl(url)              -> true for https URLs under R2_PUBLIC_URL/uploads/ */
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { HttpError } = require('./http');

const PRESIGN_EXPIRES = 600; // seconds
const KINDS = {
  image: {
    max: 10 * 1024 * 1024,
    types: { 'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp' },
    tooBig: 'Image is larger than 10 MB',
    badType: 'Only JPEG, PNG and WebP images can be uploaded',
  },
  video: {
    max: 80 * 1024 * 1024,
    types: { 'video/mp4': 'mp4', 'video/webm': 'webm' },
    tooBig: 'Video is larger than 80 MB. Please compress it and try again.',
    badType: 'Upload an MP4 or WebM video',
  },
};

const R2_KEYS = ['R2_ACCOUNT_ID', 'R2_ACCESS_KEY_ID', 'R2_SECRET_ACCESS_KEY', 'R2_BUCKET', 'R2_PUBLIC_URL'];

function mediaBase(env = process.env) {
  const raw = String(env.R2_PUBLIC_URL || '').trim();
  if (!/^https:\/\/[^\s"'<>\\?#]+$/i.test(raw)) return '';
  return raw.replace(/\/+$/, '');
}

const KEY_RE = /^uploads\/[A-Za-z0-9._~\-/]+$/;
const safeKey = key => KEY_RE.test(key) && !key.split('/').some(seg => !seg || seg.startsWith('.'));

function isStoredMediaUrl(value, env = process.env) {
  const base = mediaBase(env);
  const s = String(value || '');
  if (!base || !s.startsWith(`${base}/`)) return false;
  return safeKey(s.slice(base.length + 1));
}

function newKey(ext, date = new Date()) {
  const yyyy = String(date.getUTCFullYear());
  const mm = String(date.getUTCMonth() + 1).padStart(2, '0');
  return `uploads/${yyyy}/${mm}/${crypto.randomBytes(8).toString('hex')}.${ext}`;
}

function createStorage({ siteDir, env = process.env } = {}) {
  if (!env.R2_ACCOUNT_ID) {
    return {
      kind: 'local',
      async put(key, buf) {
        if (!safeKey(key)) throw new Error(`Bad storage key ${key}`);
        const file = path.join(siteDir, ...key.split('/'));
        try {
          fs.mkdirSync(path.dirname(file), { recursive: true });
          fs.writeFileSync(file, buf, { flag: 'wx' });
        } catch (err) {
          if (err && ['EROFS', 'EACCES', 'EPERM'].includes(err.code)) {
            // Vercel's disk is read-only: media must go to R2 there.
            throw new HttpError(503, 'This server cannot store uploads on its disk. Set the R2_* environment variables (see DEPLOY.md).');
          }
          throw err;
        }
        return key;
      },
      async presignPut() { return null; },
    };
  }

  const missing = R2_KEYS.filter(k => !env[k]);
  if (missing.length) {
    throw new Error(`R2_ACCOUNT_ID is set but ${missing.join(', ')} ${missing.length === 1 ? 'is' : 'are'} missing`);
  }
  const base = mediaBase(env);
  if (!base) throw new Error('R2_PUBLIC_URL must be an https:// address (the bucket\'s public or custom domain)');
  const { AwsClient } = require('aws4fetch');
  const aws = new AwsClient({
    accessKeyId: env.R2_ACCESS_KEY_ID,
    secretAccessKey: env.R2_SECRET_ACCESS_KEY,
    service: 's3',
    region: 'auto',
  });
  // R2_ENDPOINT is only for tests against a local S3-compatible mock.
  const origin = (env.R2_ENDPOINT || `https://${env.R2_ACCOUNT_ID}.r2.cloudflarestorage.com`).replace(/\/+$/, '');
  const endpoint = `${origin}/${encodeURIComponent(env.R2_BUCKET)}`;
  const objectUrl = key => `${endpoint}/${key.split('/').map(encodeURIComponent).join('/')}`;
  const signLengthDefault = !/^(0|false|no)$/i.test(String(env.R2_SIGN_CONTENT_LENGTH || ''));

  return {
    kind: 'r2',
    publicUrl: base,
    signLengthDefault,
    /* Server-side upload (used by the JSON image route). */
    async put(key, buf, type) {
      if (!safeKey(key)) throw new Error(`Bad storage key ${key}`);
      const res = await aws.fetch(objectUrl(key), {
        method: 'PUT',
        body: buf,
        headers: { 'Content-Type': type, 'Cache-Control': 'public, max-age=31536000, immutable' },
      });
      if (!res.ok) {
        const text = await res.text().catch(() => '');
        console.error(`R2 upload failed: ${res.status} ${text.slice(0, 300)}`);
        throw new HttpError(502, 'Could not save the file to storage. Please try again.');
      }
      return `${base}/${key}`;
    },
    /* Presigned PUT for the browser. Content-Type is always signed, so the
       browser must send exactly that type; Content-Length is signed too
       (unless turned off), so the file must be exactly the declared size. */
    async presignPut(key, type, size, { signLength = signLengthDefault } = {}) {
      const url = new URL(objectUrl(key));
      url.searchParams.set('X-Amz-Expires', String(PRESIGN_EXPIRES));
      const headers = { 'Content-Type': type };
      if (signLength) headers['Content-Length'] = String(size);
      const signed = await aws.sign(url.toString(), {
        method: 'PUT',
        headers,
        aws: { signQuery: true, allHeaders: true },
      });
      return { uploadUrl: signed.url, headers: { 'Content-Type': type }, lengthSigned: Boolean(signLength) };
    },
  };
}

/* POST /api/admin/upload/presign body: { kind, type, size, filename, unsigned_length } */
async function presignUpload(storage, body = {}) {
  if (!storage || storage.kind !== 'r2') return { method: 'LOCAL' };
  const kind = KINDS[body.kind] ? body.kind : null;
  if (!kind) throw new HttpError(400, 'kind must be "image" or "video"');
  const spec = KINDS[kind];
  let type = String(body.type || '').toLowerCase().split(';')[0].trim();
  if (type === 'image/jpg') type = 'image/jpeg';
  const ext = spec.types[type];
  if (!ext) throw new HttpError(415, spec.badType);
  const size = Number(body.size);
  if (!Number.isInteger(size) || size < 1) throw new HttpError(400, 'size must be the file size in bytes');
  if (size > spec.max) throw new HttpError(413, spec.tooBig);
  const key = newKey(ext);
  const signLength = body.unsigned_length === true ? false : undefined;
  const signed = await storage.presignPut(key, type, size, signLength === false ? { signLength: false } : {});
  return {
    method: 'PUT',
    uploadUrl: signed.uploadUrl,
    headers: signed.headers,
    url: `${storage.publicUrl}/${key}`,
    key,
    expires_in: PRESIGN_EXPIRES,
    length_signed: signed.lengthSigned,
  };
}

module.exports = { createStorage, presignUpload, mediaBase, isStoredMediaUrl, newKey, KINDS, PRESIGN_EXPIRES };
