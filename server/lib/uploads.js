'use strict';
/* Image uploads sent as data URLs. Verifies magic bytes against the declared
   type and writes site/uploads/<yyyy>/<mm>/<random-16-hex>.<ext>. */
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { HttpError } = require('./http');

const MAX_BYTES = 10 * 1024 * 1024;
const TYPES = {
  jpeg: { ext: 'jpg', check: b => b.length > 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff },
  png: { ext: 'png', check: b => b.length > 8 && b.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) },
  webp: { ext: 'webp', check: b => b.length > 12 && b.toString('latin1', 0, 4) === 'RIFF' && b.toString('latin1', 8, 12) === 'WEBP' },
};

function decodeDataUrl(dataUrl) {
  if (typeof dataUrl !== 'string' || !dataUrl.startsWith('data:')) {
    throw new HttpError(400, 'dataUrl must be a data:image/(jpeg|png|webp);base64 string');
  }
  const comma = dataUrl.indexOf(',');
  if (comma < 0 || comma > 100) throw new HttpError(400, 'Malformed dataUrl');
  const header = dataUrl.slice(5, comma).toLowerCase();
  const m = /^image\/(jpeg|jpg|png|webp);base64$/.exec(header);
  if (!m) throw new HttpError(415, 'Only JPEG, PNG and WebP images can be uploaded');
  const kind = m[1] === 'jpg' ? 'jpeg' : m[1];
  const b64 = dataUrl.slice(comma + 1).replace(/\s+/g, '');
  if (!b64 || /[^A-Za-z0-9+/=]/.test(b64)) throw new HttpError(400, 'Image data is not valid base64');
  if (Math.floor((b64.length * 3) / 4) > MAX_BYTES + 3) throw new HttpError(413, 'Image is larger than 10 MB');
  const buf = Buffer.from(b64, 'base64');
  if (buf.length > MAX_BYTES) throw new HttpError(413, 'Image is larger than 10 MB');
  if (!TYPES[kind].check(buf)) throw new HttpError(400, `File content is not a valid ${kind.toUpperCase()} image`);
  return { kind, ext: TYPES[kind].ext, buf };
}

function saveUpload(siteDir, dataUrl) {
  const { ext, buf } = decodeDataUrl(dataUrl);
  const d = new Date();
  const yyyy = String(d.getFullYear());
  const mm = String(d.getMonth() + 1).padStart(2, '0');
  const dir = path.join(siteDir, 'uploads', yyyy, mm);
  fs.mkdirSync(dir, { recursive: true });
  const name = `${crypto.randomBytes(8).toString('hex')}.${ext}`;
  fs.writeFileSync(path.join(dir, name), buf, { flag: 'wx' });
  return { url: `uploads/${yyyy}/${mm}/${name}`, bytes: buf.length };
}

module.exports = { saveUpload, decodeDataUrl, MAX_BYTES };
