'use strict';
/* Streamed video uploads (raw request body, not JSON). Bytes are counted while
   they are written to a hidden temp file (site/uploads/.incoming/, never
   served because static.js hides dot folders). The first bytes are checked
   against the declared type as soon as they arrive; past the size limit the
   upload stops with 413. On success the temp file is renamed to
   site/uploads/<yyyy>/<mm>/<random-16-hex>.<mp4|webm>. */
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { HttpError } = require('./http');

const MAX_VIDEO_BYTES = 80 * 1024 * 1024;
const MIN_VIDEO_BYTES = 64;
const HEAD_BYTES = 12;
const TEMP_DIR = '.incoming';
const STALE_MS = 6 * 60 * 60 * 1000;

/* ISO BMFF brands used by still images (HEIC, AVIF); they also carry "ftyp". */
const IMAGE_BRANDS = new Set(['heic', 'heix', 'heim', 'heis', 'mif1', 'msf1', 'avif', 'avis']);

const VIDEO_TYPES = {
  'video/mp4': {
    ext: 'mp4',
    label: 'MP4',
    check: b => b.length >= 12 && b.toString('latin1', 4, 8) === 'ftyp' && !IMAGE_BRANDS.has(b.toString('latin1', 8, 12)),
  },
  'video/webm': {
    ext: 'webm',
    label: 'WebM',
    check: b => b.length >= 4 && b[0] === 0x1a && b[1] === 0x45 && b[2] === 0xdf && b[3] === 0xa3,
  },
};

const mbText = bytes => {
  const mb = bytes / (1024 * 1024);
  return mb >= 1 ? `${Math.round(mb * 10) / 10} MB` : `${Math.max(1, Math.round(bytes / 1024))} KB`;
};

/* Removes temp files left behind by a crash or a killed process. */
function sweepStale(dir, now = Date.now()) {
  let names;
  try { names = fs.readdirSync(dir); } catch { return; }
  for (const name of names) {
    if (!name.endsWith('.part')) continue;
    const file = path.join(dir, name);
    try {
      if (now - fs.statSync(file).mtimeMs > STALE_MS) fs.unlinkSync(file);
    } catch { /* in use or already gone */ }
  }
}

function finalName(uploadsDir, ext, date) {
  const yyyy = String(date.getFullYear());
  const mm = String(date.getMonth() + 1).padStart(2, '0');
  const dir = path.join(uploadsDir, yyyy, mm);
  fs.mkdirSync(dir, { recursive: true });
  let name;
  do {
    name = `${crypto.randomBytes(8).toString('hex')}.${ext}`;
  } while (fs.existsSync(path.join(dir, name)));
  return { file: path.join(dir, name), url: `uploads/${yyyy}/${mm}/${name}` };
}

/* Streams `input` (an http.IncomingMessage or any Readable) to disk.
   Resolves { url, bytes, type, ext, file }; rejects with HttpError 400 / 413 /
   415, or the raw error for disk failures. The temp file is always removed on
   failure before the promise rejects. On failure `input` is left paused; the
   caller should close the connection after replying. */
function saveVideoStream(siteDir, input, { type, limit = MAX_VIDEO_BYTES, date = new Date() } = {}) {
  const spec = VIDEO_TYPES[type];
  if (!spec) return Promise.reject(new HttpError(415, 'Upload an MP4 or WebM video'));
  const uploadsDir = path.join(siteDir, 'uploads');
  const tmpDir = path.join(uploadsDir, TEMP_DIR);
  try {
    fs.mkdirSync(tmpDir, { recursive: true });
  } catch (err) {
    return Promise.reject(err);
  }
  sweepStale(tmpDir);
  const tmpFile = path.join(tmpDir, `${crypto.randomBytes(12).toString('hex')}.part`);
  const notValid = () => new HttpError(400, `This file is not a valid ${spec.label} video`);

  return new Promise((resolve, reject) => {
    const out = fs.createWriteStream(tmpFile, { flags: 'wx' });
    let size = 0;
    let head = Buffer.alloc(0);
    let checked = false;
    let ended = false;
    let done = false;

    function detach() {
      input.off('data', onData);
      input.off('end', onEnd);
      input.off('error', onInputError);
      input.off('aborted', onAborted);
      input.off('close', onInputClose);
      out.off('drain', onDrain);
    }

    function fail(err) {
      if (done) return;
      done = true;
      detach();
      // Keep a no-op listener so a late stream error never goes unhandled.
      input.on('error', () => {});
      if (!ended && typeof input.pause === 'function') input.pause();
      const removeTemp = () => fs.unlink(tmpFile, () => reject(err));
      if (out.closed) removeTemp();
      else {
        out.once('close', removeTemp);
        out.destroy();
      }
    }

    function onData(chunk) {
      if (done) return;
      size += chunk.length;
      if (size > limit) {
        fail(new HttpError(413, `Video is larger than ${mbText(limit)}`));
        return;
      }
      if (!checked) {
        head = Buffer.concat([head, chunk.subarray(0, HEAD_BYTES - head.length)]);
        if (head.length >= HEAD_BYTES) {
          checked = true;
          if (!spec.check(head)) {
            fail(notValid());
            return;
          }
        }
      }
      if (!out.write(chunk)) input.pause();
    }

    function onDrain() {
      if (!done) input.resume();
    }

    function onEnd() {
      ended = true;
      if (done) return;
      if (size === 0) {
        fail(new HttpError(400, 'No video received'));
        return;
      }
      if (!checked && !spec.check(head)) {
        fail(notValid());
        return;
      }
      if (size < MIN_VIDEO_BYTES) {
        fail(new HttpError(400, 'This file is too small to be a video'));
        return;
      }
      out.end();
    }

    const onInputError = () => fail(new HttpError(400, 'Upload interrupted. Please try again.'));
    const onAborted = () => fail(new HttpError(400, 'Upload interrupted. Please try again.'));
    const onInputClose = () => {
      if (!ended) fail(new HttpError(400, 'Upload interrupted. Please try again.'));
    };

    out.on('error', err => fail(err));
    out.on('drain', onDrain);
    out.on('close', () => {
      if (done || !ended) return;
      done = true;
      detach();
      let target;
      try {
        target = finalName(uploadsDir, spec.ext, date);
        fs.renameSync(tmpFile, target.file);
      } catch (err) {
        fs.unlink(tmpFile, () => reject(err));
        return;
      }
      resolve({ url: target.url, bytes: size, type, ext: spec.ext, file: target.file });
    });

    input.on('data', onData);
    input.on('end', onEnd);
    input.on('error', onInputError);
    input.on('aborted', onAborted);
    input.on('close', onInputClose);
    if (typeof input.resume === 'function') input.resume();
  });
}

/* Display name from the optional X-Filename header (URI encoded or plain). */
function cleanFilename(header) {
  let s = Array.isArray(header) ? header[0] : header;
  if (typeof s !== 'string' || !s) return '';
  try { s = decodeURIComponent(s); } catch { /* keep as sent */ }
  s = s.split(/[\\/]/).pop();
  return s.replace(/[^\p{L}\p{M}\p{N} ._()-]+/gu, '').replace(/\s+/g, ' ').trim().slice(0, 120);
}

module.exports = { saveVideoStream, cleanFilename, sweepStale, VIDEO_TYPES, MAX_VIDEO_BYTES, MIN_VIDEO_BYTES, TEMP_DIR };
