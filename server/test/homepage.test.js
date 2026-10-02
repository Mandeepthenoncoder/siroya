'use strict';
/* Homepage banners: validation, seed, featured resolution, admin API, streamed
   video uploads and byte-range serving of the uploaded video.
   Run: node --no-warnings=ExperimentalWarning --test server/test/homepage.test.js
   Local servers listen on 127.0.0.1, ports 5401-5420 only. */
process.env.NODE_ENV = 'test';

const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { Readable } = require('node:stream');
const { spawnSync } = require('node:child_process');

const { openDb } = require('../lib/db');
const { Router } = require('../lib/router');
const { createAuth } = require('../lib/auth');
const { createLimiter } = require('../lib/ratelimit');
const { createStatic } = require('../lib/static');
const {
  HttpError, setSecurityHeaders, contentType, readJson, json, sendError,
} = require('../lib/http');
const H = require('../lib/homepage');
const { registerHomepage } = require('../lib/api/homepage');
const { saveVideoStream, cleanFilename, MAX_VIDEO_BYTES, TEMP_DIR, UPLOAD_IDLE_MS, UPLOAD_MAX_MS, mp4Layout, webmLayout } = require('../lib/videoupload');
const net = require('node:net');

const SERVER_JS = path.resolve(__dirname, '..', 'server.js');
const TEST_ENV = { ADMIN_PASSWORD: 'homepage-test-password', SESSION_SECRET: 'a1'.repeat(32), TRUST_PROXY: false };

/* ---------- helpers ---------- */

function quietly(fn) {
  const log = console.log;
  const warn = console.warn;
  console.log = () => {};
  console.warn = () => {};
  try { return fn(); } finally { console.log = log; console.warn = warn; }
}

function freshDb() {
  return quietly(() => {
    const db = openDb(':memory:');
    db.migrate();
    return db;
  });
}

function seedCollections(db) {
  const ins = db.stmt('INSERT INTO collections (slug, name, kind, short, hero, cover, active, sort) VALUES (?, ?, ?, ?, ?, ?, ?, ?)');
  ins.run('sanskriti', 'Sanskriti', 'Temple Jewellery', 'Temple jewellery for weddings.', 'assets/img/collections/sanskriti-hero.jpg', 'assets/img/collections/sanskriti-cover.jpg', 1, 0);
  ins.run('rangmahal', 'Rangmahal', 'Precious Stone Jewellery', 'Rubies, emeralds and sapphires.', 'assets/img/collections/rangmahal-hero.jpg', 'assets/img/collections/rangmahal-cover.jpg', 1, 1);
  ins.run('hidden', 'Hidden', '', '', '', '', 0, 2);
}

function tempSite() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'siroya-homepage-'));
  fs.writeFileSync(path.join(dir, 'index.html'), '<!doctype html><title>t</title>');
  fs.mkdirSync(path.join(dir, 'uploads'), { recursive: true });
  return dir;
}

function listFiles(dir) {
  const out = [];
  const walk = d => {
    let entries;
    try { entries = fs.readdirSync(d, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) walk(p);
      else out.push(path.relative(dir, p).split(path.sep).join('/'));
    }
  };
  walk(dir);
  return out.sort();
}

/* A valid full homepage object to mutate in tests. */
function base() {
  const h = H.defaults();
  h.hero.slides.push({
    image: 'uploads/2026/10/abcdef0123456789.jpg', image_mobile: 'uploads/2026/10/0123456789abcdef.webp', focus: 'center',
    eyebrow: 'New', headline: 'Second slide', text: 'Text', cta_label: 'Shop', cta_link: 'collections.html',
    cta2_label: '', cta2_link: '', alt: 'A ring',
  });
  h.hero.video = { src: 'uploads/2026/10/aaaaaaaaaaaaaaaa.mp4', src_mobile: '', poster: 'uploads/2026/10/bbbbbbbbbbbbbbbb.jpg', poster_mobile: '' };
  return h;
}

const withLink = v => {
  const h = base();
  h.hero.slides[0].cta_link = v;
  if (!v) h.hero.slides[0].cta_label = '';
  return h;
};
const withImage = v => { const h = base(); h.hero.slides[0].image = v; return h; };
const isBad = re => err => err instanceof HttpError && err.status === 400 && (!re || re.test(err.message));

async function listenInRange(server, from = 5401, to = 5420) {
  for (let port = from; port <= to; port++) {
    try {
      await new Promise((resolve, reject) => {
        const onError = err => { server.off('listening', onListening); reject(err); };
        const onListening = () => { server.off('error', onError); resolve(); };
        server.once('error', onError);
        server.once('listening', onListening);
        server.listen(port, '127.0.0.1');
      });
      return port;
    } catch (err) {
      if (err.code !== 'EADDRINUSE' && err.code !== 'EACCES') throw err;
    }
  }
  throw new Error('No free port between 5401 and 5420');
}

function closeServer(server) {
  return new Promise(resolve => {
    if (typeof server.closeAllConnections === 'function') server.closeAllConnections();
    server.close(() => resolve());
  });
}

/* body: object (JSON), string, Buffer, or a Readable (streamed, chunked unless
   a Content-Length header is given). Resolves on the response even if the
   server closes the connection while the body is still being sent. */
function request(port, method, urlPath, { body, headers = {} } = {}) {
  return new Promise((resolve, reject) => {
    let payload = null;
    const h = { ...headers };
    if (body !== undefined && !(body instanceof Readable)) {
      payload = Buffer.isBuffer(body) ? body : Buffer.from(typeof body === 'string' ? body : JSON.stringify(body));
      if (h['Content-Length'] === undefined) h['Content-Length'] = payload.length;
    }
    let settled = false;
    const req = http.request({ host: '127.0.0.1', port, method, path: urlPath, agent: false, headers: h }, res => {
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => {
        const buf = Buffer.concat(chunks);
        const text = buf.toString('utf8');
        let data = null;
        try { data = text ? JSON.parse(text) : null; } catch { data = null; }
        settled = true;
        resolve({ status: res.statusCode, headers: res.headers, text, buf, data });
      });
      res.on('error', err => { if (!settled) { settled = true; reject(err); } });
    });
    req.on('error', err => {
      // EPIPE / ECONNRESET after an early reply are expected for refused uploads.
      if (!settled) setTimeout(() => { if (!settled) { settled = true; reject(err); } }, 200);
    });
    if (body instanceof Readable) {
      body.on('error', () => req.destroy());
      body.pipe(req);
    } else {
      if (payload) req.write(payload);
      req.end();
    }
  });
}

/* Mirrors handleApi + the error handler in server/server.js, including the
   proposed one-line change: routes with { raw: true } skip readJson. */
function testApp(router, { auth, siteDir }) {
  const serveStatic = createStatic(siteDir);
  const MUTATING = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);
  return async (req, res) => {
    setSecurityHeaders(res);
    const [rawPath, rawQuery = ''] = req.url.split('?');
    try {
      const decoded = decodeURIComponent(rawPath);
      if (decoded === '/api' || decoded.startsWith('/api/')) {
        const found = router.match(req.method, decoded);
        if (!found) throw new HttpError(404, 'Not found');
        if (found.allowed) throw new HttpError(405, 'Method not allowed', { Allow: found.allowed.join(', ') });
        const { route, params } = found;
        const opts = route.opts;
        if (opts.auth && !auth.isAuthed(req)) throw new HttpError(401, 'Not signed in');
        let body = {};
        if (MUTATING.has(req.method)) {
          const allowedTypes = opts.contentTypes || ['application/json'];
          if (!allowedTypes.includes(contentType(req))) throw new HttpError(415, `Content-Type must be ${allowedTypes.join(' or ')}`);
          if (!opts.raw) body = await readJson(req, opts.limit || 200 * 1024);
        }
        const ctx = { path: decoded, query: new URLSearchParams(rawQuery), ip: req.socket.remoteAddress };
        const result = await route.handler({ ...ctx, req, res, params, body });
        if (result !== undefined && !res.headersSent) json(req, res, 200, result);
        if (!res.headersSent) throw new HttpError(500, 'No response');
        return;
      }
      await serveStatic(req, res, decoded, rawPath, rawQuery);
    } catch (err) {
      const isHttp = err instanceof HttpError;
      const status = isHttp ? err.status : 500;
      if (!isHttp) console.error(err);
      if (res.headersSent) { res.destroy(); return; }
      const headers = { ...(isHttp && err.headers ? err.headers : {}) };
      if (status === 413) headers.Connection = 'close';
      sendError(req, res, status, isHttp ? err.message : 'Something went wrong. Please try again.', headers, isHttp ? err.data : null);
      if (status === 413) res.on('finish', () => setTimeout(() => req.destroy(), 50).unref());
    }
  };
}

/* Tiny real videos made by ffmpeg; synthetic headers when ffmpeg is missing. */
function makeVideos(dir) {
  const run = (args, out) => {
    const r = spawnSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-f', 'lavfi', '-i', 'testsrc=duration=1:size=320x180:rate=12', ...args, '-y', out], { timeout: 60000 });
    return r.status === 0 && fs.existsSync(out) && fs.statSync(out).size > 0;
  };
  const mp4 = path.join(dir, 'test.mp4');
  const webm = path.join(dir, 'test.webm');
  const real = { mp4: run(['-pix_fmt', 'yuv420p'], mp4), webm: run(['-c:v', 'libvpx', '-b:v', '100k'], webm) };
  if (!real.mp4) {
    // ftyp box (32 bytes) then an mdat box filling the rest.
    const b = Buffer.alloc(4096);
    Buffer.from([0, 0, 0, 0x20]).copy(b, 0);
    b.write('ftypisom', 4, 'latin1');
    b.writeUInt32BE(4096 - 32, 32);
    b.write('mdat', 36, 'latin1');
    fs.writeFileSync(mp4, b);
  }
  if (!real.webm) {
    // EBML header with DocType "webm", then a Segment of unknown size.
    const b = Buffer.alloc(4096);
    Buffer.from([0x1a, 0x45, 0xdf, 0xa3, 0x87, 0x42, 0x82, 0x84]).copy(b, 0);
    b.write('webm', 8, 'latin1');
    Buffer.from([0x18, 0x53, 0x80, 0x67, 0x01, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff]).copy(b, 12);
    fs.writeFileSync(webm, b);
  }
  return { mp4: fs.readFileSync(mp4), webm: fs.readFileSync(webm), real };
}

/* ======================================================================
   Validation
   ====================================================================== */

describe('homepage: validate links', () => {
  const good = [
    ['collections.html', 'collections.html'],
    ['  about.html  ', 'about.html'],
    ['/collections.html', 'collections.html'],
    ['collection.html?c=sanskriti', 'collection.html?c=sanskriti'],
    ['product.html?p=rose-ring#details', 'product.html?p=rose-ring#details'],
    ['category.html?c=rings&sort=new', 'category.html?c=rings&sort=new'],
    ['https://wa.me/971500000000?text=Hello%20Siroya', 'https://wa.me/971500000000?text=Hello%20Siroya'],
    ['HTTPS://www.siroya.com/about', 'https://www.siroya.com/about'],
    ['https://www.instagram.com/siroya/', 'https://www.instagram.com/siroya/'],
    ['', ''],
  ];
  for (const [input, expected] of good) {
    it(`accepts ${JSON.stringify(input)}`, () => {
      assert.equal(H.validate(withLink(input)).hero.slides[0].cta_link, expected);
    });
  }

  const badLinks = [
    'javascript:alert(1)',
    'JavaScript:alert(1)',
    '  javascript:alert(document.cookie)',
    'java\nscript:alert(1)',
    'vbscript:msgbox(1)',
    'data:text/html;base64,PHNjcmlwdD5hbGVydCgxKTwvc2NyaXB0Pg==',
    '//evil.com',
    '//evil.com/collections.html',
    '/\\evil.com',
    '\\\\evil.com',
    '../admin/',
    'about/../admin/index.html',
    '%2e%2e/admin',
    'http://example.com',
    'https://',
    'https://user:pass@evil.com',
    'https://evil.com\\@siroya.com',
    'https://evil.com/"onmouseover="alert(1)',
    'mailto:hello@siroya.com',
    'tel:+97140000000',
    '#top',
    'collections.html<script>',
    'collections .html',
  ];
  for (const input of badLinks) {
    it(`rejects ${JSON.stringify(input)}`, () => {
      assert.throws(() => H.validate(withLink(input)), isBad(/Slide 1 button 1 link/));
    });
  }

  it('checks button 2 and featured-free links the same way', () => {
    const h = base();
    h.hero.slides[1].cta2_label = 'More';
    h.hero.slides[1].cta2_link = 'javascript:alert(1)';
    assert.throws(() => H.validate(h), isBad(/Slide 2 button 2 link/));
  });

  it('requires a link when a button label is set', () => {
    const h = base();
    h.hero.slides[0].cta_link = '';
    assert.throws(() => H.validate(h), isBad(/button 1 needs a link/));
    const h2 = base();
    h2.hero.slides[0].cta2_link = '';
    assert.throws(() => H.validate(h2), isBad(/button 2 needs a link/));
  });
});

describe('homepage: validate media paths', () => {
  const goodImages = [
    ['assets/img/home/hero.jpg', 'assets/img/home/hero.jpg'],
    ['uploads/2026/10/abcdef0123456789.webp', 'uploads/2026/10/abcdef0123456789.webp'],
    ['/uploads/2026/10/a.PNG', 'uploads/2026/10/a.PNG'],
    ['assets/img/logo/siroya-red.svg', 'assets/img/logo/siroya-red.svg'],
    ['uploads/2026/10/a.jpeg', 'uploads/2026/10/a.jpeg'],
  ];
  for (const [input, expected] of goodImages) {
    it(`accepts image ${JSON.stringify(input)}`, () => {
      assert.equal(H.validate(withImage(input)).hero.slides[0].image, expected);
    });
  }

  const badImages = [
    'https://cdn.example.com/a.jpg',
    'http://example.com/a.jpg',
    '//evil.com/a.jpg',
    'img/home/hero.jpg',
    'site/uploads/a.jpg',
    'uploads/../server/.env',
    'uploads/2026/../../server/data/siroya.db',
    'assets/img/..%2fsecret.jpg',
    'uploads/2026/10/a..b.jpg',
    'assets/img/hero.jpg?v=2',
    'assets/img/hero.jpg#x',
    `uploads/${TEMP_DIR}/abc.jpg`,
    'uploads/.env.jpg',
    'uploads//a.jpg',
    'uploads/',
    'uploads/a b.jpg',
    'assets\\img\\hero.jpg',
    'C:/Windows/win.jpg',
    'javascript:alert(1)',
    'data:image/png;base64,iVBORw0KGgo=',
    'uploads/2026/10/a.mp4',
    'uploads/2026/10/a.html',
    'uploads/2026/10/a',
  ];
  for (const input of badImages) {
    it(`rejects image ${JSON.stringify(input)}`, () => {
      assert.throws(() => H.validate(withImage(input)), isBad(/Slide 1 desktop image/));
    });
  }

  it('checks phone images, video posters and the featured image too', () => {
    const a = base();
    a.hero.slides[0].image_mobile = '../x.jpg';
    assert.throws(() => H.validate(a), isBad(/Slide 1 phone image/));
    const b = base();
    b.hero.video.poster = 'https://evil.com/p.jpg';
    assert.throws(() => H.validate(b), isBad(/Video cover image/));
    const c = base();
    c.featured.image = 'uploads/../../etc/passwd';
    assert.throws(() => H.validate(c), isBad(/Featured image/));
  });

  it('video paths must be uploads/ or assets/ and end .mp4 or .webm', () => {
    for (const ok of ['uploads/2026/10/aaaaaaaaaaaaaaaa.mp4', 'uploads/2026/10/aaaaaaaaaaaaaaaa.webm', 'assets/video/hero.MP4', '/uploads/2026/10/x.mp4']) {
      const h = base();
      h.hero.video.src = ok;
      assert.equal(H.validate(h).hero.video.src, ok.replace(/^\//, ''));
    }
    for (const no of ['uploads/2026/10/a.mov', 'uploads/2026/10/a.jpg', 'https://cdn.example.com/a.mp4', 'uploads/../a.mp4', 'uploads/a.mp4?autoplay=1', 'video.mp4']) {
      const h = base();
      h.hero.video.src_mobile = no;
      assert.throws(() => H.validate(h), isBad(/Phone video/), no);
    }
  });
});

describe('homepage: validate structure, required fields and clamping', () => {
  it('needs 1 to 6 slides', () => {
    const none = base();
    none.hero.slides = [];
    assert.throws(() => H.validate(none), isBad(/at least one slide/));
    const seven = base();
    seven.hero.mode = 'slideshow';
    seven.hero.slides = Array.from({ length: 7 }, () => ({ ...base().hero.slides[0] }));
    assert.throws(() => H.validate(seven), isBad(/at most 6 slides/));
    const six = base();
    six.hero.mode = 'slideshow';
    six.hero.slides = Array.from({ length: 6 }, () => ({ ...base().hero.slides[0] }));
    assert.equal(H.validate(six).hero.slides.length, 6);
    const notList = base();
    notList.hero.slides = { 0: notList.hero.slides[0] };
    assert.throws(() => H.validate(notList), isBad(/Slides must be a list/));
    const notObj = base();
    notObj.hero.slides = ['x'];
    assert.throws(() => H.validate(notObj), isBad(/Slide 1 must be an object/));
  });

  it('needs the top level hero and featured objects', () => {
    assert.throws(() => H.validate(null), isBad());
    assert.throws(() => H.validate([]), isBad());
    assert.throws(() => H.validate({ featured: base().featured }), isBad(/Hero settings/));
    assert.throws(() => H.validate({ hero: base().hero }), isBad(/Featured collection settings/));
  });

  it('clamps interval to 4..12 and overlay to 0..0.8', () => {
    const cases = [
      [{ interval: 2 }, 'interval', 4],
      [{ interval: 99 }, 'interval', 12],
      [{ interval: '7' }, 'interval', 7],
      [{ interval: 6.25 }, 'interval', 6.3],
      [{ interval: undefined }, 'interval', 6],
      [{ interval: '' }, 'interval', 6],
      [{ overlay: -1 }, 'overlay', 0],
      [{ overlay: 0.95 }, 'overlay', 0.8],
      [{ overlay: 0.333 }, 'overlay', 0.33],
      [{ overlay: '0.5' }, 'overlay', 0.5],
      [{ overlay: null }, 'overlay', 0.45],
      [{ overlay: 45 }, 'overlay', 0.8],
    ];
    for (const [patch, key, expected] of cases) {
      const h = base();
      Object.assign(h.hero, patch);
      assert.equal(H.validate(h).hero[key], expected, JSON.stringify(patch));
    }
    for (const badValue of ['abc', true, {}, [], 'Infinity', Number.NaN]) {
      const h = base();
      h.hero.interval = badValue;
      assert.throws(() => H.validate(h), isBad(/Slideshow interval must be a number/), String(badValue));
    }
  });

  it('checks enums, with defaults for blanks and "centre" as an alias', () => {
    const h = base();
    h.hero.mode = ' Slideshow ';
    h.hero.align = 'centre';
    h.hero.slides[0].focus = 'CENTRE';
    delete h.hero.slides[1].focus;
    const v = H.validate(h);
    assert.equal(v.hero.mode, 'slideshow');
    assert.equal(v.hero.align, 'center');
    assert.equal(v.hero.slides[0].focus, 'center');
    assert.equal(v.hero.slides[1].focus, 'right');
    const blank = base();
    delete blank.hero.mode;
    delete blank.hero.align;
    assert.equal(H.validate(blank).hero.mode, 'image');
    assert.equal(H.validate(blank).hero.align, 'left');
    for (const [where, value, re] of [['mode', 'carousel', /Banner type/], ['align', 'right', /Alignment/], ['mode', 3, /Banner type/]]) {
      const x = base();
      x.hero[where] = value;
      assert.throws(() => H.validate(x), isBad(re));
    }
    const f = base();
    f.hero.slides[0].focus = 'top';
    assert.throws(() => H.validate(f), isBad(/Slide 1 focus/));
  });

  it('trims text to a single line and enforces length caps', () => {
    const h = base();
    h.hero.slides[0].headline = '  Gold\r\nfor\tevery\u0007 day  ';
    h.hero.slides[0].eyebrow = 42;
    assert.equal(H.validate(h).hero.slides[0].headline, 'Gold for every day');
    assert.equal(H.validate(h).hero.slides[0].eyebrow, '42');
    const caps = [['headline', 70], ['text', 160], ['eyebrow', 50], ['alt', 140]];
    for (const [field, max] of caps) {
      const ok = base();
      ok.hero.slides[0][field] = 'x'.repeat(max);
      assert.equal(H.validate(ok).hero.slides[0][field].length, max);
      const tooLong = base();
      tooLong.hero.slides[0][field] = 'x'.repeat(max + 1);
      assert.throws(() => H.validate(tooLong), isBad(new RegExp(`is ${max + 1} characters\\. Please keep it to ${max} or fewer`)), field);
    }
    const obj = base();
    obj.hero.slides[0].headline = { text: 'x' };
    assert.throws(() => H.validate(obj), isBad(/Slide 1 headline must be text/));
  });

  it('requires images per mode', () => {
    const img = base();
    img.hero.slides[0].image = '';
    assert.throws(() => H.validate(img), isBad(/Slide 1 needs a desktop image/));
    // Image mode keeps other slides even without images (switching modes keeps data).
    const kept = base();
    kept.hero.slides[1].image = '';
    assert.equal(H.validate(kept).hero.slides[1].image, '');
    const show = base();
    show.hero.mode = 'slideshow';
    show.hero.slides[1].image = '';
    assert.throws(() => H.validate(show), isBad(/Slide 2 needs a desktop image/));
    // Video mode uses slides[0] for text only.
    const vid = base();
    vid.hero.mode = 'video';
    vid.hero.slides[0].image = '';
    assert.equal(H.validate(vid).hero.mode, 'video');
  });

  it('requires a video and a cover image in video mode', () => {
    const noSrc = base();
    noSrc.hero.mode = 'video';
    noSrc.hero.video.src = '';
    assert.throws(() => H.validate(noSrc), isBad(/Upload a video/));
    const noPoster = base();
    noPoster.hero.mode = 'video';
    noPoster.hero.video.poster = '';
    assert.throws(() => H.validate(noPoster), isBad(/cover image for the video/));
    const noVideoObj = base();
    delete noVideoObj.hero.video;
    assert.deepEqual(H.validate(noVideoObj).hero.video, { src: '', src_mobile: '', poster: '', poster_mobile: '' });
    const badVideoObj = base();
    badVideoObj.hero.video = 'uploads/a.mp4';
    assert.throws(() => H.validate(badVideoObj), isBad(/Video settings must be an object/));
  });

  it('validates the featured block', () => {
    const blank = base();
    blank.featured.collection = '';
    assert.throws(() => H.validate(blank), isBad(/Choose a collection/));
    const badSlug = base();
    badSlug.featured.collection = 'Sanskriti Gold!';
    assert.throws(() => H.validate(badSlug), isBad(/not a valid collection/));
    const upper = base();
    upper.featured.collection = ' RANGMAHAL ';
    assert.equal(H.validate(upper).featured.collection, 'rangmahal');
    const long = base();
    long.featured.headline = 'x'.repeat(121);
    assert.throws(() => H.validate(long), isBad(/Featured headline is 121 characters/));
  });

  it('drops unknown fields and returns the exact contract shape', () => {
    const h = base();
    h.extra = 1;
    h.hero.extra = '<script>';
    h.hero.slides[0].onclick = 'alert(1)';
    h.hero.video.autoplay = false;
    h.featured.resolved = { slug: 'x' };
    h.featured.html = '<b>';
    const v = H.validate(h);
    assert.deepEqual(Object.keys(v), ['hero', 'featured']);
    assert.deepEqual(Object.keys(v.hero), ['mode', 'slides', 'video', 'interval', 'overlay', 'align']);
    assert.deepEqual(Object.keys(v.hero.slides[0]), ['image', 'image_mobile', 'focus', 'eyebrow', 'headline', 'text', 'cta_label', 'cta_link', 'cta2_label', 'cta2_link', 'alt']);
    assert.deepEqual(Object.keys(v.hero.video), ['src', 'src_mobile', 'poster', 'poster_mobile']);
    assert.deepEqual(Object.keys(v.featured), ['collection', 'image', 'headline', 'text', 'cta_label']);
  });
});

/* ======================================================================
   Seed, storage, featured resolution
   ====================================================================== */

describe('homepage: seed defaults and storage', () => {
  it('defaults match the current static hero and pass validation unchanged', () => {
    const d = H.defaults();
    assert.equal(d.hero.mode, 'image');
    assert.equal(d.hero.slides.length, 1);
    const s = d.hero.slides[0];
    assert.equal(s.image, 'assets/img/home/hero.jpg');
    assert.equal(s.eyebrow, 'Jewellers to the world since 1976');
    assert.equal(s.headline, 'Jewellery that feels like home');
    assert.equal(s.text, "Designs curated from across the world, chosen with care for your family's celebrations.");
    assert.deepEqual([s.cta_label, s.cta_link, s.cta2_label, s.cta2_link], ['Explore collections', 'collections.html', 'Our story', 'about.html']);
    assert.match(s.alt, /gold temple necklace/);
    assert.equal(d.hero.overlay, 0.45);
    assert.equal(d.hero.align, 'left');
    assert.equal(d.hero.interval, 6);
    assert.equal(d.featured.collection, 'sanskriti');
    assert.equal(d.featured.headline, 'Sanskriti. Traditions carried forward.');
    assert.match(d.featured.text, /^Temple jewellery shaped by South Indian craft/);
    assert.deepEqual(H.validate(d), d);
    // No em or en dashes in any seeded copy.
    assert.doesNotMatch(JSON.stringify(d), /[\u2013\u2014]/);
    // defaults() hands out copies.
    d.hero.slides[0].headline = 'changed';
    assert.equal(H.defaults().hero.slides[0].headline, 'Jewellery that feels like home');
  });

  it('seeds once when the key is missing and never overwrites', () => {
    const db = freshDb();
    assert.equal(db.getSetting(H.KEY, null), null);
    assert.equal(H.seedHomepage(db), true);
    assert.deepEqual(db.getSetting(H.KEY, null), H.defaults());
    const custom = H.validate(base());
    H.saveHomepage(db, custom);
    assert.equal(H.seedHomepage(db), false);
    assert.deepEqual(H.getHomepage(db), custom);
    db.close();
  });

  it('getHomepage writes the seed on first read and survives a corrupt value', () => {
    const db = freshDb();
    assert.deepEqual(H.getHomepage(db), H.defaults());
    assert.deepEqual(db.getSetting(H.KEY, null), H.defaults());
    db.setSetting(H.KEY, { hero: { mode: 'video', slides: [] } });
    assert.deepEqual(quietly(() => H.getHomepage(db)), H.defaults());
    db.close();
  });
});

describe('homepage: resolveFeatured', () => {
  let db;
  before(() => { db = freshDb(); seedCollections(db); });
  after(() => db.close());

  it('resolves the chosen active collection', () => {
    const home = H.defaults();
    const out = H.resolveFeatured(db, home);
    assert.deepEqual(out.featured.resolved, {
      slug: 'sanskriti', name: 'Sanskriti', kind: 'Temple Jewellery', short: 'Temple jewellery for weddings.',
      hero: 'assets/img/collections/sanskriti-hero.jpg', cover: 'assets/img/collections/sanskriti-cover.jpg',
      url: 'collection.html?c=sanskriti', fallback: false,
    });
    assert.equal(out.featured.headline, home.featured.headline);
    assert.equal(home.featured.resolved, undefined, 'input is not mutated');
    assert.deepEqual(out.hero, home.hero);
  });

  it('falls back to the first active collection and blanks overrides for a hidden or missing one', () => {
    for (const slug of ['hidden', 'does-not-exist']) {
      const home = H.defaults();
      home.featured.collection = slug;
      home.featured.image = 'uploads/2026/10/x.jpg';
      const out = H.resolveFeatured(db, home);
      assert.equal(out.featured.resolved.slug, 'sanskriti');
      assert.equal(out.featured.resolved.fallback, true);
      assert.equal(out.featured.collection, slug);
      assert.deepEqual([out.featured.image, out.featured.headline, out.featured.text, out.featured.cta_label], ['', '', '', '']);
    }
  });

  it('is null when no collection is active', () => {
    const empty = freshDb();
    assert.equal(H.resolveFeatured(empty, H.defaults()).featured.resolved, null);
    empty.close();
  });

  it('assertFeaturedCollection refuses unknown and hidden collections', () => {
    assert.doesNotThrow(() => H.assertFeaturedCollection(db, 'rangmahal'));
    assert.throws(() => H.assertFeaturedCollection(db, 'nope'), isBad(/Unknown collection "nope"/));
    assert.throws(() => H.assertFeaturedCollection(db, 'hidden'), isBad(/hidden on the site/));
  });
});

/* ======================================================================
   HTTP: homepage API, video upload, byte ranges
   ====================================================================== */

describe('homepage API over HTTP', () => {
  let db;
  let siteDir;
  let videoDir;
  let videos;
  let server;
  let port;
  let auth;
  let cookie;
  const SMALL_LIMIT = 1024 * 1024;

  before(async () => {
    db = freshDb();
    seedCollections(db);
    siteDir = tempSite();
    videoDir = fs.mkdtempSync(path.join(os.tmpdir(), 'siroya-video-'));
    videos = makeVideos(videoDir);
    auth = createAuth(TEST_ENV);
    cookie = auth.issueCookie({ socket: {}, headers: {} }).split(';')[0];
    const router = new Router();
    registerHomepage(router, { db, siteDir, maxVideoBytes: SMALL_LIMIT });
    server = http.createServer(testApp(router, { auth, siteDir }));
    port = await listenInRange(server);
  });

  after(async () => {
    await closeServer(server);
    db.close();
    fs.rmSync(siteDir, { recursive: true, force: true });
    fs.rmSync(videoDir, { recursive: true, force: true });
  });

  const authed = (extra = {}) => ({ Cookie: cookie, ...extra });

  it('seeds on registration and serves the public object with featured resolved', async () => {
    assert.deepEqual(db.getSetting(H.KEY, null), H.defaults());
    const r = await request(port, 'GET', '/api/homepage');
    assert.equal(r.status, 200);
    assert.equal(r.headers['cache-control'], 'no-store');
    assert.match(r.headers['content-type'], /^application\/json/);
    assert.equal(r.headers['x-content-type-options'], 'nosniff');
    assert.equal(r.data.hero.mode, 'image');
    assert.equal(r.data.featured.resolved.slug, 'sanskriti');
    assert.equal(r.data.featured.resolved.url, 'collection.html?c=sanskriti');
    const head = await request(port, 'HEAD', '/api/homepage');
    assert.equal(head.status, 200);
    assert.equal(head.text, '');
  });

  it('admin routes need the session cookie', async () => {
    assert.equal((await request(port, 'GET', '/api/admin/homepage')).status, 401);
    assert.equal((await request(port, 'PUT', '/api/admin/homepage', { body: base(), headers: { 'Content-Type': 'application/json' } })).status, 401);
    assert.equal((await request(port, 'POST', '/api/admin/upload-video', { body: videos.mp4, headers: { 'Content-Type': 'video/mp4' } })).status, 401);
    const forged = await request(port, 'GET', '/api/admin/homepage', { headers: { Cookie: 'siroya_admin=9999999999999.forged' } });
    assert.equal(forged.status, 401);
  });

  it('GET /api/admin/homepage returns the raw stored object', async () => {
    const r = await request(port, 'GET', '/api/admin/homepage', { headers: authed() });
    assert.equal(r.status, 200);
    assert.equal(r.headers['cache-control'], 'no-store');
    assert.deepEqual(r.data, H.defaults());
    assert.equal(r.data.featured.resolved, undefined);
  });

  it('PUT validates, saves and returns the saved object', async () => {
    const h = base();
    h.hero.mode = 'slideshow';
    h.hero.interval = 30;
    h.hero.slides[0].headline = '  Festive gold  ';
    h.featured.collection = 'rangmahal';
    h.featured.headline = 'Colour, set in gold.';
    h.unknown = true;
    const r = await request(port, 'PUT', '/api/admin/homepage', { body: h, headers: authed({ 'Content-Type': 'application/json' }) });
    assert.equal(r.status, 200, r.text);
    assert.equal(r.data.hero.mode, 'slideshow');
    assert.equal(r.data.hero.interval, 12);
    assert.equal(r.data.hero.slides[0].headline, 'Festive gold');
    assert.equal(r.data.unknown, undefined);
    assert.deepEqual(db.getSetting(H.KEY, null), r.data);
    const pub = await request(port, 'GET', '/api/homepage');
    assert.equal(pub.data.hero.slides.length, 2);
    assert.equal(pub.data.featured.resolved.slug, 'rangmahal');
    assert.equal(pub.data.featured.headline, 'Colour, set in gold.');
  });

  it('PUT keeps the saved featured block when only hero is sent', async () => {
    const before = db.getSetting(H.KEY, null);
    const hero = { ...before.hero, align: 'center' };
    const r = await request(port, 'PUT', '/api/admin/homepage', { body: { hero }, headers: authed({ 'Content-Type': 'application/json' }) });
    assert.equal(r.status, 200, r.text);
    assert.equal(r.data.hero.align, 'center');
    assert.deepEqual(r.data.featured, before.featured);
  });

  it('PUT errors are 400 with a clear message and nothing is saved', async () => {
    const saved = db.getSetting(H.KEY, null);
    const cases = [
      [(h => { h.hero.slides[0].cta_link = 'javascript:alert(1)'; return h; })(base()), /Slide 1 button 1 link must be a page on this site/],
      [(h => { h.hero.slides = []; return h; })(base()), /Add at least one slide/],
      [(h => { h.featured.collection = 'nope'; return h; })(base()), /Unknown collection "nope"/],
      [(h => { h.featured.collection = 'hidden'; return h; })(base()), /hidden on the site/],
      [(h => { h.hero.mode = 'video'; h.hero.video.poster = ''; return h; })(base()), /cover image/],
    ];
    for (const [body, re] of cases) {
      const r = await request(port, 'PUT', '/api/admin/homepage', { body, headers: authed({ 'Content-Type': 'application/json' }) });
      assert.equal(r.status, 400, r.text);
      assert.match(r.data.error, re);
      assert.doesNotMatch(r.data.error, /[\u2013\u2014]/);
    }
    assert.deepEqual(db.getSetting(H.KEY, null), saved);
    const wrongType = await request(port, 'PUT', '/api/admin/homepage', { body: 'hero=1', headers: authed({ 'Content-Type': 'application/x-www-form-urlencoded' }) });
    assert.equal(wrongType.status, 415);
    const notJson = await request(port, 'PUT', '/api/admin/homepage', { body: '{', headers: authed({ 'Content-Type': 'application/json' }) });
    assert.equal(notJson.status, 400);
  });

  it('uploads a real MP4 made by ffmpeg', async () => {
    const r = await request(port, 'POST', '/api/admin/upload-video', {
      body: videos.mp4,
      headers: authed({ 'Content-Type': 'video/mp4', 'X-Filename': encodeURIComponent('Diwali hero/../final cut.mp4') }),
    });
    assert.equal(r.status, 201, r.text);
    const year = String(new Date().getFullYear());
    const month = String(new Date().getMonth() + 1).padStart(2, '0');
    assert.match(r.data.url, new RegExp(`^uploads/${year}/${month}/[0-9a-f]{16}\\.mp4$`));
    assert.equal(r.data.bytes, videos.mp4.length);
    assert.equal(r.data.type, 'video/mp4');
    assert.equal(r.data.name, 'final cut.mp4');
    const onDisk = fs.readFileSync(path.join(siteDir, ...r.data.url.split('/')));
    assert.ok(onDisk.equals(videos.mp4), 'stored bytes match');
    assert.deepEqual(fs.readdirSync(path.join(siteDir, 'uploads', TEMP_DIR)), [], 'temp file renamed away');
    // The saved url is accepted by the validator as a video source.
    const h = base();
    h.hero.mode = 'video';
    h.hero.video.src = r.data.url;
    assert.equal(H.validate(h).hero.video.src, r.data.url);
  });

  it('uploads a WebM with a streamed (chunked) body', async () => {
    const r = await request(port, 'POST', '/api/admin/upload-video', {
      body: Readable.from([videos.webm.subarray(0, 3), videos.webm.subarray(3, 9), videos.webm.subarray(9)]),
      headers: authed({ 'Content-Type': 'video/webm' }),
    });
    assert.equal(r.status, 201, r.text);
    assert.match(r.data.url, /^uploads\/\d{4}\/\d{2}\/[0-9a-f]{16}\.webm$/);
    assert.equal(r.data.bytes, videos.webm.length);
  });

  it('rejects wrong magic bytes and deletes the temp file', async () => {
    const before = listFiles(siteDir);
    const png = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(4096)]);
    const heic = Buffer.concat([Buffer.from([0, 0, 0, 0x18]), Buffer.from('ftypheic', 'latin1'), Buffer.alloc(4096)]);
    const cases = [
      ['video/mp4', png],
      ['video/mp4', videos.webm],
      ['video/webm', videos.mp4],
      ['video/mp4', heic],
      ['video/mp4', Buffer.from('<html><script>alert(1)</script></html>'.repeat(10))],
      ['video/mp4', videos.mp4.subarray(0, 10)],
      // Polyglots that borrow only the container signature.
      ['video/mp4', Buffer.concat([Buffer.from([0, 0, 0, 0]), Buffer.from('ftypisom', 'latin1'), Buffer.from('<html><script>alert(document.domain)</script></html>'.repeat(3))])],
      ['video/mp4', Buffer.concat([Buffer.from([0, 0, 0, 0x10]), Buffer.from('ftypisom\0\0\0\0', 'latin1'), Buffer.from('<html><body><script>alert(1)</script></body></html>'.repeat(3))])],
      ['video/mp4', Buffer.concat([Buffer.from([0, 0, 0, 0x10]), Buffer.from('ftypisom\0\0\0\0', 'latin1'), Buffer.from('<html><script>alert(1)</script>'.repeat(300))])],
      ['video/webm', Buffer.concat([Buffer.from([0x1a, 0x45, 0xdf, 0xa3]), Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" onload="alert(1)"/>'.repeat(3))])],
      ['video/webm', Buffer.concat([Buffer.from([0x1a, 0x45, 0xdf, 0xa3, 0x87, 0x42, 0x82, 0x84]), Buffer.from('webm<svg onload=alert(1)>'.repeat(4), 'latin1')])],
    ];
    for (const [type, body] of cases) {
      const r = await request(port, 'POST', '/api/admin/upload-video', { body, headers: authed({ 'Content-Type': type }) });
      assert.equal(r.status, 400, `${type} ${r.text}`);
      assert.match(r.data.error, /not a valid (MP4|WebM) video/);
    }
    assert.deepEqual(listFiles(siteDir), before, 'no files left behind');
  });

  it('rejects other content types, empty bodies and cross-site requests', async () => {
    const mov = await request(port, 'POST', '/api/admin/upload-video', { body: videos.mp4, headers: authed({ 'Content-Type': 'video/quicktime' }) });
    assert.equal(mov.status, 415);
    const jsonBody = await request(port, 'POST', '/api/admin/upload-video', { body: { dataUrl: 'x' }, headers: authed({ 'Content-Type': 'application/json' }) });
    assert.equal(jsonBody.status, 415);
    const form = await request(port, 'POST', '/api/admin/upload-video', { body: 'a=1', headers: authed({ 'Content-Type': 'text/plain' }) });
    assert.equal(form.status, 415);
    const empty = await request(port, 'POST', '/api/admin/upload-video', { body: Buffer.alloc(0), headers: authed({ 'Content-Type': 'video/mp4' }) });
    assert.equal(empty.status, 400);
    assert.match(empty.data.error, /No video received/);
    const cross = await request(port, 'POST', '/api/admin/upload-video', { body: videos.mp4, headers: authed({ 'Content-Type': 'video/mp4', 'Sec-Fetch-Site': 'cross-site' }) });
    assert.equal(cross.status, 403);
  });

  it('refuses a declared Content-Length over the limit before reading', async () => {
    const r = await request(port, 'POST', '/api/admin/upload-video', {
      body: Readable.from([videos.mp4.subarray(0, 64)]),
      headers: authed({ 'Content-Type': 'video/mp4', 'Content-Length': String(SMALL_LIMIT + 1) }),
    });
    assert.equal(r.status, 413);
    assert.match(r.data.error, /larger than 1 MB/);
    assert.equal(r.headers.connection, 'close');
  });

  it('stops a chunked upload once it passes the limit with a readable 413 and removes the temp file', async () => {
    const before = listFiles(siteDir);
    let sent = 0;
    const chunk = Buffer.alloc(64 * 1024);
    const total = SMALL_LIMIT + SMALL_LIMIT / 2;
    const stream = new Readable({
      read() {
        if (sent >= total) { this.push(null); return; }
        const c = Buffer.from(sent === 0 ? Buffer.concat([videos.mp4.subarray(0, 4096), chunk.subarray(4096)]) : chunk);
        sent += c.length;
        this.push(c);
      },
    });
    const r = await request(port, 'POST', '/api/admin/upload-video', { body: stream, headers: authed({ 'Content-Type': 'video/mp4' }) });
    assert.equal(r.status, 413, r.text);
    assert.match(r.data.error, /larger than 1 MB/);
    await new Promise(resolve => setTimeout(resolve, 100));
    assert.deepEqual(listFiles(siteDir), before);
  });

  it('refuses a large file with wrong magic bytes early, with a readable 400', async () => {
    const before = listFiles(siteDir);
    const junk = Buffer.alloc(900 * 1024, 0x41);
    const r = await request(port, 'POST', '/api/admin/upload-video', {
      body: Readable.from([junk.subarray(0, 300 * 1024), junk.subarray(300 * 1024, 600 * 1024), junk.subarray(600 * 1024)]),
      headers: authed({ 'Content-Type': 'video/webm' }),
    });
    assert.equal(r.status, 400, r.text);
    assert.match(r.data.error, /not a valid WebM video/);
    const sized = await request(port, 'POST', '/api/admin/upload-video', { body: junk, headers: authed({ 'Content-Type': 'video/mp4' }) });
    assert.equal(sized.status, 400);
    assert.deepEqual(listFiles(siteDir), before);
  });

  it('serves uploaded video with Content-Type and byte ranges (206 / 416)', async () => {
    const up = await request(port, 'POST', '/api/admin/upload-video', { body: videos.mp4, headers: authed({ 'Content-Type': 'video/mp4' }) });
    assert.equal(up.status, 201);
    const url = `/${up.data.url}`;
    const size = videos.mp4.length;

    const full = await request(port, 'GET', url);
    assert.equal(full.status, 200);
    assert.equal(full.headers['content-type'], 'video/mp4');
    assert.equal(full.headers['accept-ranges'], 'bytes');
    assert.equal(Number(full.headers['content-length']), size);
    assert.ok(full.buf.equals(videos.mp4));

    // iOS Safari probes with bytes=0-1 first.
    const probe = await request(port, 'GET', url, { headers: { Range: 'bytes=0-1' } });
    assert.equal(probe.status, 206);
    assert.equal(probe.headers['content-range'], `bytes 0-1/${size}`);
    assert.equal(Number(probe.headers['content-length']), 2);
    assert.ok(probe.buf.equals(videos.mp4.subarray(0, 2)));

    const mid = await request(port, 'GET', url, { headers: { Range: 'bytes=100-299' } });
    assert.equal(mid.status, 206);
    assert.equal(mid.headers['content-range'], `bytes 100-299/${size}`);
    assert.ok(mid.buf.equals(videos.mp4.subarray(100, 300)));

    const open = await request(port, 'GET', url, { headers: { Range: `bytes=${size - 10}-` } });
    assert.equal(open.status, 206);
    assert.equal(open.headers['content-range'], `bytes ${size - 10}-${size - 1}/${size}`);
    assert.ok(open.buf.equals(videos.mp4.subarray(size - 10)));

    const suffix = await request(port, 'GET', url, { headers: { Range: 'bytes=-16' } });
    assert.equal(suffix.status, 206);
    assert.ok(suffix.buf.equals(videos.mp4.subarray(size - 16)));

    const pastEnd = await request(port, 'GET', url, { headers: { Range: `bytes=0-${size * 2}` } });
    assert.equal(pastEnd.status, 206);
    assert.equal(pastEnd.headers['content-range'], `bytes 0-${size - 1}/${size}`);

    for (const bad of [`bytes=${size}-`, `bytes=${size + 100}-${size + 200}`, 'bytes=50-10']) {
      const r = await request(port, 'GET', url, { headers: { Range: bad } });
      assert.equal(r.status, 416, bad);
      assert.equal(r.headers['content-range'], `bytes */${size}`);
    }

    const head = await request(port, 'HEAD', url, { headers: { Range: 'bytes=0-1' } });
    assert.equal(head.status, 206);
    assert.equal(head.text, '');

    const webm = await request(port, 'POST', '/api/admin/upload-video', { body: videos.webm, headers: authed({ 'Content-Type': 'video/webm' }) });
    const w = await request(port, 'GET', `/${webm.data.url}`, { headers: { Range: 'bytes=0-3' } });
    assert.equal(w.status, 206);
    assert.equal(w.headers['content-type'], 'video/webm');
    assert.deepEqual([...w.buf], [0x1a, 0x45, 0xdf, 0xa3]);
  });

  it('never serves the temp folder', async () => {
    const tmp = path.join(siteDir, 'uploads', TEMP_DIR);
    fs.writeFileSync(path.join(tmp, 'leftover.part'), 'x');
    const r = await request(port, 'GET', `/uploads/${TEMP_DIR}/leftover.part`);
    assert.equal(r.status, 404);
    fs.unlinkSync(path.join(tmp, 'leftover.part'));
  });
});

describe('video upload: rate limit and default size cap', () => {
  let db;
  let siteDir;
  let server;
  let port;
  let auth;
  let videos;
  let videoDir;

  before(async () => {
    db = freshDb();
    siteDir = tempSite();
    videoDir = fs.mkdtempSync(path.join(os.tmpdir(), 'siroya-video-'));
    videos = makeVideos(videoDir);
    auth = createAuth(TEST_ENV);
    const router = new Router();
    registerHomepage(router, { db, siteDir, videoLimiter: createLimiter({ limit: 2, windowMs: 60 * 60 * 1000 }) });
    server = http.createServer(testApp(router, { auth, siteDir }));
    port = await listenInRange(server);
  });

  after(async () => {
    await closeServer(server);
    db.close();
    fs.rmSync(siteDir, { recursive: true, force: true });
    fs.rmSync(videoDir, { recursive: true, force: true });
  });

  it('the default cap is 80 MB and a declared 81 MB body is refused at once', async () => {
    assert.equal(MAX_VIDEO_BYTES, 80 * 1024 * 1024);
    const cookie = auth.issueCookie({ socket: {}, headers: {} }).split(';')[0];
    const r = await request(port, 'POST', '/api/admin/upload-video', {
      body: Readable.from([videos.mp4.subarray(0, 64)]),
      headers: { Cookie: cookie, 'Content-Type': 'video/mp4', 'Content-Length': String(81 * 1024 * 1024) },
    });
    assert.equal(r.status, 413);
    assert.match(r.data.error, /larger than 80 MB/);
  });

  it('allows the limit per session, then 429 with Retry-After; another session is separate', async () => {
    const a = auth.issueCookie({ socket: {}, headers: {} }).split(';')[0];
    await new Promise(resolve => setTimeout(resolve, 5));
    const b = auth.issueCookie({ socket: {}, headers: {} }).split(';')[0];
    assert.notEqual(a, b);
    const send = c => request(port, 'POST', '/api/admin/upload-video', { body: videos.mp4, headers: { Cookie: c, 'Content-Type': 'video/mp4' } });
    assert.equal((await send(a)).status, 201);
    assert.equal((await send(a)).status, 201);
    const third = await send(a);
    assert.equal(third.status, 429);
    assert.ok(Number(third.headers['retry-after']) > 0);
    assert.match(third.data.error, /Upload limit reached/);
    assert.equal((await send(b)).status, 201);
  });
});

describe('saveVideoStream (direct)', () => {
  let siteDir;
  let videoDir;
  let videos;
  before(() => {
    siteDir = tempSite();
    videoDir = fs.mkdtempSync(path.join(os.tmpdir(), 'siroya-video-'));
    videos = makeVideos(videoDir);
  });
  after(() => {
    fs.rmSync(siteDir, { recursive: true, force: true });
    fs.rmSync(videoDir, { recursive: true, force: true });
  });

  it('rejects a Readable that pushes past the limit with 413 and leaves no files', async () => {
    const limit = 256 * 1024;
    let pushed = 0;
    const big = new Readable({
      read() {
        if (pushed >= limit * 4) { this.push(null); return; }
        const c = Buffer.alloc(16 * 1024);
        if (pushed === 0) videos.mp4.copy(c, 0, 0, 4096); // real box headers, then zeros
        pushed += c.length;
        this.push(c);
      },
    });
    await assert.rejects(saveVideoStream(siteDir, big, { type: 'video/mp4', limit }), err => err instanceof HttpError && err.status === 413);
    assert.ok(pushed <= limit + 64 * 1024, `stopped reading soon after the limit (read ${pushed})`);
    big.destroy();
    assert.deepEqual(listFiles(path.join(siteDir, 'uploads')), []);
  });

  it('accepts a body of exactly the limit', async () => {
    const r = await saveVideoStream(siteDir, Readable.from([videos.mp4]), { type: 'video/mp4', limit: videos.mp4.length, date: new Date(2026, 0, 15) });
    assert.match(r.url, /^uploads\/2026\/01\/[0-9a-f]{16}\.mp4$/);
    assert.equal(r.bytes, videos.mp4.length);
    fs.unlinkSync(r.file);
  });

  it('removes the temp file when the stream errors midway', async () => {
    const broken = new Readable({ read() {} });
    const p = saveVideoStream(siteDir, broken, { type: 'video/webm' });
    broken.push(videos.webm.subarray(0, 1024));
    setTimeout(() => broken.destroy(new Error('socket hang up')), 20);
    await assert.rejects(p, err => err instanceof HttpError && err.status === 400 && /interrupted/.test(err.message));
    assert.deepEqual(listFiles(path.join(siteDir, 'uploads')), []);
  });

  it('refuses unknown types and sweeps stale temp files', async () => {
    await assert.rejects(saveVideoStream(siteDir, Readable.from([videos.mp4]), { type: 'video/quicktime' }), err => err.status === 415);
    const tmp = path.join(siteDir, 'uploads', TEMP_DIR);
    fs.mkdirSync(tmp, { recursive: true });
    const stale = path.join(tmp, 'old.part');
    fs.writeFileSync(stale, 'x');
    const old = new Date(Date.now() - 7 * 60 * 60 * 1000);
    fs.utimesSync(stale, old, old);
    const r = await saveVideoStream(siteDir, Readable.from([videos.webm]), { type: 'video/webm' });
    assert.equal(fs.existsSync(stale), false);
    fs.unlinkSync(r.file);
  });

  it('cleans the X-Filename header', () => {
    assert.equal(cleanFilename(encodeURIComponent('Hero film (final).mp4')), 'Hero film (final).mp4');
    assert.equal(cleanFilename('C:\\Users\\me\\clip.webm'), 'clip.webm');
    assert.equal(cleanFilename('<script>x</script>.mp4'), 'script.mp4');
    assert.equal(cleanFilename('a"b<c>|d.mp4'), 'abcd.mp4');
    assert.equal(cleanFilename('%E0%A4%A6%E0%A5%80%E0%A4%AA.mp4'), 'दीप.mp4');
    assert.equal(cleanFilename(undefined), '');
    assert.equal(cleanFilename('%zz.mp4'), 'zz.mp4');
  });
});

describe('video layout checks', () => {
  let videoDir;
  let videos;
  before(() => {
    videoDir = fs.mkdtempSync(path.join(os.tmpdir(), 'siroya-video-'));
    videos = makeVideos(videoDir);
  });
  after(() => fs.rmSync(videoDir, { recursive: true, force: true }));

  it('accepts real MP4 and WebM files, on the first 4 KB and on the whole file', () => {
    assert.equal(mp4Layout(videos.mp4), true);
    assert.equal(mp4Layout(videos.mp4.subarray(0, 4096)), true);
    assert.equal(webmLayout(videos.webm), true);
    assert.equal(webmLayout(videos.webm.subarray(0, 4096)), true);
    assert.equal(mp4Layout(videos.webm), false);
    assert.equal(webmLayout(videos.mp4), false);
  });

  it('accepts 64-bit and run-to-end box sizes and Void elements before the Segment', () => {
    const ftyp = Buffer.concat([Buffer.from([0, 0, 0, 0x10]), Buffer.from('ftypmp42\0\0\0\0', 'latin1')]);
    const large = Buffer.concat([ftyp, Buffer.from([0, 0, 0, 1]), Buffer.from('mdat', 'latin1'), Buffer.from([0, 0, 0, 0, 0, 0, 0x10, 0])]);
    assert.equal(mp4Layout(large), true);
    const toEnd = Buffer.concat([ftyp, Buffer.from([0, 0, 0, 0]), Buffer.from('mdat', 'latin1'), Buffer.alloc(64)]);
    assert.equal(mp4Layout(toEnd), true);
    assert.equal(mp4Layout(ftyp), false, 'ftyp alone is not a video');
    assert.equal(mp4Layout(Buffer.concat([ftyp, Buffer.from([0, 0, 0, 4]), Buffer.from('free', 'latin1')])), false, 'box smaller than its header');
    const ebml = Buffer.from([0x1a, 0x45, 0xdf, 0xa3, 0x87, 0x42, 0x82, 0x84, 0x77, 0x65, 0x62, 0x6d]);
    const seg = Buffer.from([0x18, 0x53, 0x80, 0x67, 0x01, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff]);
    assert.equal(webmLayout(Buffer.concat([ebml, seg])), true);
    assert.equal(webmLayout(Buffer.concat([ebml, Buffer.from([0xec, 0x82, 0, 0]), seg])), true);
    assert.equal(webmLayout(Buffer.concat([ebml, Buffer.from('<svg/>')])), false);
    const other = Buffer.from(ebml);
    other.write('xxxx', 8, 'latin1');
    assert.equal(webmLayout(Buffer.concat([other, seg])), false, 'unknown DocType');
  });
});

describe('video upload: stalled clients', () => {
  let siteDir;
  let videoDir;
  let videos;
  before(() => {
    siteDir = tempSite();
    videoDir = fs.mkdtempSync(path.join(os.tmpdir(), 'siroya-video-'));
    videos = makeVideos(videoDir);
  });
  after(() => {
    fs.rmSync(siteDir, { recursive: true, force: true });
    fs.rmSync(videoDir, { recursive: true, force: true });
  });

  it('has bounded defaults', () => {
    assert.ok(UPLOAD_IDLE_MS >= 30000 && UPLOAD_IDLE_MS <= 60000);
    assert.ok(UPLOAD_MAX_MS >= 10 * 60000 && UPLOAD_MAX_MS <= 30 * 60000);
  });

  it('rejects with 408 when no bytes arrive for idleMs, destroys the input and leaves no files', async () => {
    const quiet = new Readable({ read() {} });
    const started = Date.now();
    const p = saveVideoStream(siteDir, quiet, { type: 'video/mp4', idleMs: 250 });
    quiet.push(videos.mp4.subarray(0, 6 * 1024));
    await assert.rejects(p, err => err instanceof HttpError && err.status === 408 && /stalled/.test(err.message));
    assert.ok(Date.now() - started < 3000);
    assert.equal(quiet.destroyed, true);
    assert.deepEqual(listFiles(path.join(siteDir, 'uploads')), []);
  });

  it('keeps a slow but steady upload alive, and stops one that passes maxMs', async () => {
    const trickle = (gap, total) => {
      let i = 0;
      const r = new Readable({ read() {} });
      const t = setInterval(() => {
        if (r.destroyed) { clearInterval(t); return; }
        if (i * 1024 >= total) { clearInterval(t); r.push(null); return; }
        const from = i * 1024;
        r.push(from < videos.mp4.length ? videos.mp4.subarray(from, Math.min(total, from + 1024)) : Buffer.alloc(1024));
        i++;
      }, gap);
      return r;
    };
    const ok = await saveVideoStream(siteDir, trickle(40, videos.mp4.length), { type: 'video/mp4', idleMs: 300 });
    assert.equal(ok.bytes, videos.mp4.length);
    fs.unlinkSync(ok.file);
    const slow = trickle(40, 10 * 1024 * 1024);
    await assert.rejects(saveVideoStream(siteDir, slow, { type: 'video/mp4', idleMs: 300, maxMs: 400 }), err => err.status === 408 && /too long/.test(err.message));
    assert.equal(slow.destroyed, true);
    assert.deepEqual(fs.readdirSync(path.join(siteDir, 'uploads', TEMP_DIR)), []);
  });

  it('closes a stalled HTTP upload socket and removes the temp file', async () => {
    const db = freshDb();
    const auth = createAuth(TEST_ENV);
    const cookie = auth.issueCookie({ socket: {}, headers: {} }).split(';')[0];
    const router = new Router();
    registerHomepage(router, { db, siteDir, uploadIdleMs: 300 });
    const server = http.createServer(testApp(router, { auth, siteDir }));
    const errors = console.error;
    console.error = () => {};
    try {
      const port = await listenInRange(server);
      const sock = net.connect(port, '127.0.0.1');
      await new Promise(resolve => sock.once('connect', resolve));
      sock.on('error', () => {});
      sock.write([
        'POST /api/admin/upload-video HTTP/1.1', 'Host: 127.0.0.1', `Cookie: ${cookie}`,
        'Content-Type: video/mp4', `Content-Length: ${50 * 1024 * 1024}`, '', '',
      ].join('\r\n'));
      sock.write(videos.mp4.subarray(0, 6 * 1024));
      const started = Date.now();
      const incoming = path.join(siteDir, 'uploads', TEMP_DIR);
      await new Promise(resolve => setTimeout(resolve, 120));
      assert.equal(fs.readdirSync(incoming).length, 1, 'temp file open while bytes are arriving');
      await new Promise((resolve, reject) => {
        const t = setTimeout(() => reject(new Error('server never closed the stalled socket')), 5000);
        sock.once('close', () => { clearTimeout(t); resolve(); });
      });
      assert.ok(Date.now() - started < 5000);
      await new Promise(resolve => setTimeout(resolve, 50));
      assert.deepEqual(fs.readdirSync(incoming), []);
    } finally {
      console.error = errors;
      await closeServer(server);
      db.close();
    }
  });
});

/* ======================================================================
   Real server.js (runs once the integration lines are in place)
   ====================================================================== */

describe('server.js integration', () => {
  const src = fs.readFileSync(SERVER_JS, 'utf8');
  const integrated = /registerHomepage\s*\(/.test(src) && /opts\.raw/.test(src);

  it('upload, homepage API and ranges work through createApp', { skip: integrated ? false : 'server.js does not register registerHomepage with the raw option yet' }, async () => {
    const { createApp } = require('../server');
    const db = freshDb();
    seedCollections(db);
    const siteDir = tempSite();
    const videoDir = fs.mkdtempSync(path.join(os.tmpdir(), 'siroya-video-'));
    const videos = makeVideos(videoDir);
    const server = http.createServer(createApp({ env: TEST_ENV, db, siteDir }));
    const log = console.log;
    console.log = () => {};
    try {
      const port = await listenInRange(server);
      const cookie = createAuth(TEST_ENV).issueCookie({ socket: {}, headers: {} }).split(';')[0];
      const pub = await request(port, 'GET', '/api/homepage');
      assert.equal(pub.status, 200);
      assert.equal(pub.data.featured.resolved.slug, 'sanskriti');
      const up = await request(port, 'POST', '/api/admin/upload-video', { body: videos.mp4, headers: { Cookie: cookie, 'Content-Type': 'video/mp4' } });
      assert.equal(up.status, 201, up.text);
      const range = await request(port, 'GET', `/${up.data.url}`, { headers: { Range: 'bytes=0-1' } });
      assert.equal(range.status, 206);
      assert.equal(range.headers['content-type'], 'video/mp4');
      const h = base();
      h.hero.mode = 'video';
      h.hero.video.src = up.data.url;
      const put = await request(port, 'PUT', '/api/admin/homepage', { body: h, headers: { Cookie: cookie, 'Content-Type': 'application/json' } });
      assert.equal(put.status, 200, put.text);
      assert.equal(put.data.hero.video.src, up.data.url);
    } finally {
      console.log = log;
      await closeServer(server);
      db.close();
      fs.rmSync(siteDir, { recursive: true, force: true });
      fs.rmSync(videoDir, { recursive: true, force: true });
    }
  });
});
