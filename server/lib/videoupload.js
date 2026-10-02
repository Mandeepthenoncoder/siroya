'use strict';
/* Streamed video uploads (raw request body, not JSON). Bytes are counted while
   they are written to a hidden temp file (site/uploads/.incoming/, never
   served because static.js hides dot folders). The first bytes are checked
   against the declared type as soon as they arrive (container signature in
   the first 12 bytes, then the box / element layout in the first 4 KB); past
   the size limit the upload stops with 413. A client that stops sending for
   UPLOAD_IDLE_MS, or takes longer than UPLOAD_MAX_MS in total, gets 408 and
   its connection is closed (Node's requestTimeout does not cover a body that
   a handler is still reading). On success the temp file is renamed to
   site/uploads/<yyyy>/<mm>/<random-16-hex>.<mp4|webm>. */
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { HttpError } = require('./http');

const MAX_VIDEO_BYTES = 80 * 1024 * 1024;
const MIN_VIDEO_BYTES = 64;
const HEAD_BYTES = 12;
const SNIFF_BYTES = 4096;
const UPLOAD_IDLE_MS = 45 * 1000;
const UPLOAD_MAX_MS = 20 * 60 * 1000;
const TEMP_DIR = '.incoming';
const STALE_MS = 6 * 60 * 60 * 1000;

/* ISO BMFF brands used by still images (HEIC, AVIF); they also carry "ftyp". */
const IMAGE_BRANDS = new Set(['heic', 'heix', 'heim', 'heis', 'mif1', 'msf1', 'avif', 'avis']);

/* Top-level ISO BMFF box types are four letters, digits or spaces. */
const BOX_TYPE = /^[A-Za-z0-9 ]{4}$/;

/* MP4 layout: an ftyp box of a sane size first, then at least one more box,
   and every box header inside the sniffed bytes well formed. This refuses
   polyglots that only borrow the "ftyp" signature (for example ftyp followed
   by HTML) without parsing the whole file. */
function mp4Layout(b) {
  let off = 0;
  let boxes = 0;
  while (off + 8 <= b.length) {
    let size = b.readUInt32BE(off);
    const type = b.toString('latin1', off + 4, off + 8);
    if (boxes === 0) {
      if (type !== 'ftyp' || size < 16 || size > 1024) return false;
    } else if (!BOX_TYPE.test(type)) {
      return false;
    }
    boxes++;
    if (size === 0) return boxes >= 2; // last box, runs to the end of the file
    if (size === 1) {
      if (off + 16 > b.length) return boxes >= 2;
      size = b.readUInt32BE(off + 8) * 2 ** 32 + b.readUInt32BE(off + 12);
      if (size < 16) return false;
    } else if (size < 8) {
      return false;
    }
    off += size;
  }
  return boxes >= 2;
}

/* EBML variable-size integer at `off`: { len, value, unknown } or null. IDs
   keep their length marker bits (0x1A45DFA3 stays 0x1A45DFA3). */
function readVint(b, off, isId) {
  if (off >= b.length) return null;
  const first = b[off];
  if (first === 0) return null;
  let len = 1;
  let mask = 0x80;
  while (!(first & mask)) { mask >>= 1; len++; }
  if ((isId && len > 4) || off + len > b.length) return null;
  let value = isId ? first : first & (mask - 1);
  let ones = (first & (mask - 1)) === mask - 1;
  for (let i = 1; i < len; i++) {
    value = value * 256 + b[off + i];
    if (b[off + i] !== 0xff) ones = false;
  }
  return { len, value, unknown: !isId && ones };
}

/* WebM layout: an EBML header whose DocType is webm (or matroska), then the
   Segment element, optionally after Void elements. */
function webmLayout(b) {
  if (b.length < 4 || b.readUInt32BE(0) !== 0x1a45dfa3) return false;
  const hsize = readVint(b, 4, false);
  if (!hsize || hsize.unknown || hsize.value > 1024) return false;
  const start = 4 + hsize.len;
  const end = start + hsize.value;
  if (end > b.length) return false;
  let docType = '';
  for (let off = start; off < end;) {
    const id = readVint(b, off, true);
    if (!id) return false;
    const size = readVint(b, off + id.len, false);
    if (!size || size.unknown) return false;
    const data = off + id.len + size.len;
    if (data + size.value > end) return false;
    if (id.value === 0x4282) docType = b.toString('latin1', data, data + size.value).replace(/\0+$/, '');
    off = data + size.value;
  }
  if (docType !== 'webm' && docType !== 'matroska') return false;
  let off = end;
  for (;;) {
    if (off + 4 > b.length) return false;
    if (b.readUInt32BE(off) === 0x18538067) return true; // Segment
    if (b[off] !== 0xec) return false; // only Void elements may come before it
    const size = readVint(b, off + 1, false);
    if (!size || size.unknown) return false;
    off += 1 + size.len + size.value;
  }
}

/* check: quick signature test on the first 12 bytes (fails fast on junk).
   layout: structure test on the first SNIFF_BYTES, or the whole file. */
const VIDEO_TYPES = {
  'video/mp4': {
    ext: 'mp4',
    label: 'MP4',
    check: b => b.length >= 12 && b.toString('latin1', 4, 8) === 'ftyp' && !IMAGE_BRANDS.has(b.toString('latin1', 8, 12)),
    layout: mp4Layout,
  },
  'video/webm': {
    ext: 'webm',
    label: 'WebM',
    check: b => b.length >= 4 && b[0] === 0x1a && b[1] === 0x45 && b[2] === 0xdf && b[3] === 0xa3,
    layout: webmLayout,
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
   Resolves { url, bytes, type, ext, file }; rejects with HttpError 400 / 408 /
   413 / 415, or the raw error for disk failures. The temp file is always
   removed on failure before the promise rejects. On failure `input` is left
   paused (the caller should close the connection after replying), except on
   408, where `input` is destroyed because the client has stopped sending.
   idleMs: longest allowed gap between chunks; maxMs: longest whole upload
   (0 turns either off). */
function saveVideoStream(siteDir, input, {
  type, limit = MAX_VIDEO_BYTES, date = new Date(), idleMs = UPLOAD_IDLE_MS, maxMs = UPLOAD_MAX_MS,
} = {}) {
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
    let sniffed = false;
    let ended = false;
    let done = false;
    let idleTimer = null;
    let maxTimer = null;

    function stalled(message) {
      if (done) return;
      fail(new HttpError(408, message));
      // The client went quiet, so nothing more will arrive: free the socket.
      if (typeof input.destroy === 'function') input.destroy();
    }

    function bump() {
      if (!(idleMs > 0)) return;
      clearTimeout(idleTimer);
      idleTimer = setTimeout(() => stalled('Upload stalled. Please try again.'), idleMs);
    }

    function detach() {
      clearTimeout(idleTimer);
      clearTimeout(maxTimer);
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
      bump();
      size += chunk.length;
      if (size > limit) {
        fail(new HttpError(413, `Video is larger than ${mbText(limit)}`));
        return;
      }
      if (!sniffed) {
        head = Buffer.concat([head, chunk.subarray(0, SNIFF_BYTES - head.length)]);
        if (!checked && head.length >= HEAD_BYTES) {
          checked = true;
          if (!spec.check(head)) {
            fail(notValid());
            return;
          }
        }
        if (head.length >= SNIFF_BYTES) {
          sniffed = true;
          if (!spec.layout(head)) {
            fail(notValid());
            return;
          }
        }
      }
      if (!out.write(chunk)) input.pause();
    }

    function onDrain() {
      if (done) return;
      bump();
      input.resume();
    }

    function onEnd() {
      ended = true;
      if (done) return;
      clearTimeout(idleTimer);
      if (size === 0) {
        fail(new HttpError(400, 'No video received'));
        return;
      }
      if ((!checked && !spec.check(head)) || (!sniffed && !spec.layout(head))) {
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
    if (maxMs > 0) maxTimer = setTimeout(() => stalled('Upload took too long. Please try again on a faster connection.'), maxMs);
    bump();
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

module.exports = {
  saveVideoStream, cleanFilename, sweepStale, VIDEO_TYPES, MAX_VIDEO_BYTES, MIN_VIDEO_BYTES, TEMP_DIR,
  UPLOAD_IDLE_MS, UPLOAD_MAX_MS, mp4Layout, webmLayout,
};
