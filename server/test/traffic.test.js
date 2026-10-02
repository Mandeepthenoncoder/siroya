'use strict';
/* Traffic analytics + Google client tests.
   Run: node --no-warnings=ExperimentalWarning --test server/test/
   Local servers listen on 127.0.0.1, ports 5301-5320 only. */
process.env.NODE_ENV = 'test';

const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { openDb } = require('../lib/db');
const A = require('../lib/analytics');
const G = require('../lib/google');
const { Router } = require('../lib/router');
const T = require('../lib/api/traffic');
const { registerTraffic } = T;
const { HttpError, contentType, readJson, json, sendError } = require('../lib/http');
const { createLimiter } = require('../lib/ratelimit');

const DAY = 864e5;
// 2026-10-02 10:00 UTC = 14:00 in Dubai.
const BASE = Date.parse('2026-10-02T10:00:00Z');
const UA = {
  desktop: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0 Safari/537.36',
  mac: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 14_5) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Safari/605.1.15',
  iphone: 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1',
  androidPhone: 'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0 Mobile Safari/537.36',
  androidTablet: 'Mozilla/5.0 (Linux; Android 13; SM-X700) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0 Safari/537.36',
  ipad: 'Mozilla/5.0 (iPad; CPU OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1',
};

/* ---------- helpers ---------- */

function quietly(fn) {
  const log = console.log;
  console.log = () => {};
  try { return fn(); } finally { console.log = log; }
}

function freshDb() {
  return quietly(() => {
    const db = openDb(':memory:');
    db.migrate();
    A.ensureAnalyticsSchema(db.raw);
    return db;
  });
}

async function listenInRange(server, from = 5301, to = 5320) {
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
  throw new Error('No free port between 5301 and 5320');
}

function closeServer(server) {
  return new Promise(resolve => {
    if (typeof server.closeAllConnections === 'function') server.closeAllConnections();
    server.close(() => resolve());
  });
}

function request(port, method, path, { body, headers = {} } = {}) {
  return new Promise((resolve, reject) => {
    const payload = body === undefined ? null : Buffer.from(typeof body === 'string' ? body : JSON.stringify(body));
    const req = http.request({
      host: '127.0.0.1', port, method, path, agent: false,
      headers: { ...headers, ...(payload ? { 'Content-Length': payload.length } : {}) },
    }, res => {
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        let data = null;
        try { data = text ? JSON.parse(text) : null; } catch { data = null; }
        resolve({ status: res.statusCode, headers: res.headers, text, data });
      });
    });
    req.on('error', reject);
    if (payload) req.write(payload);
    req.end();
  });
}

/* Mirrors the API pipeline in server/server.js (handleApi) closely enough
   to exercise route options: auth, contentTypes, limit, async handlers. */
function apiHarness(router, { isAuthed, beaconPatch = false }) {
  return async (req, res) => {
    const [rawPath, rawQuery = ''] = req.url.split('?');
    try {
      const found = router.match(req.method, rawPath);
      if (!found) throw new HttpError(404, 'Not found');
      if (found.allowed) throw new HttpError(405, 'Method not allowed');
      const { route, params } = found;
      const opts = route.opts;
      if (opts.auth && !isAuthed(req)) throw new HttpError(401, 'Not signed in');
      let body = {};
      if (['POST', 'PUT', 'PATCH', 'DELETE'].includes(req.method)) {
        const allowed = opts.contentTypes || ['application/json'];
        if (opts.beacon && beaconPatch) {
          // Same code as the server.js patch in the integration note.
          try {
            const parsed = await readJson(req, opts.limit || 200 * 1024);
            body = allowed.includes(contentType(req)) ? parsed : null;
          } catch (err) {
            if (err instanceof HttpError && err.status === 413) throw err;
            body = null;
          }
        } else {
          if (!allowed.includes(contentType(req))) throw new HttpError(415, `Content-Type must be ${allowed.join(' or ')}`);
          body = await readJson(req, opts.limit || 200 * 1024);
        }
      }
      const ctx = { path: rawPath, query: new URLSearchParams(rawQuery), ip: req.socket.remoteAddress };
      const result = await route.handler({ ...ctx, req, res, params, body });
      if (result !== undefined && !res.headersSent) json(req, res, 200, result);
    } catch (err) {
      const isHttp = err instanceof HttpError;
      if (!isHttp) console.error(err);
      if (isHttp && err.status === 413) req.resume();
      sendError(req, res, isHttp ? err.status : 500, isHttp ? err.message : 'Server error', isHttp && err.headers ? err.headers : {}, isHttp ? err.data : null);
    }
  };
}

function seedCatalog(db) {
  db.stmt("INSERT INTO collections (slug, name) VALUES ('bridal', 'Bridal Collection')").run();
  db.stmt("INSERT INTO categories (slug, name) VALUES ('rings', 'Rings')").run();
  db.stmt("INSERT INTO products (handle, code, name, collection, category) VALUES ('rose-ring', 'SJ-101', 'Rose Ring', 'bridal', 'rings')").run();
}

const insertLead = (db, createdAt) => db.stmt('INSERT INTO leads (created_at, name, phone) VALUES (?, ?, ?)').run(createdAt, 'Test', '971500000000');

/* ======================================================================
   First-party analytics
   ====================================================================== */

describe('analytics: user agent helpers', () => {
  it('drops known bots, previewers and empty user agents', () => {
    for (const ua of [
      'Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)',
      'Mozilla/5.0 (compatible; bingbot/2.0)',
      'Mozilla/5.0 (X11; Linux x86_64) HeadlessChrome/120.0 Safari/537.36',
      'Mozilla/5.0 (Linux; Android 11) Chrome-Lighthouse',
      'facebookexternalhit/1.1 (+http://www.facebook.com/externalhit_uatext.php)',
      'WhatsApp/2.23.20.0 A',
      'Slackbot-LinkExpanding 1.0',
      'Mozilla/5.0 (compatible; YandexSpider/3.0)',
      'Mozilla/5.0 Google Page Preview',
      '',
      undefined,
    ]) {
      assert.equal(A.isBot(ua), true, `expected bot: ${ua}`);
    }
    for (const ua of Object.values(UA)) assert.equal(A.isBot(ua), false, `expected human: ${ua}`);
  });

  it('classifies devices', () => {
    assert.equal(A.deviceFromUA(UA.iphone), 'mobile');
    assert.equal(A.deviceFromUA(UA.androidPhone), 'mobile');
    assert.equal(A.deviceFromUA(UA.androidTablet), 'tablet');
    assert.equal(A.deviceFromUA(UA.ipad), 'tablet');
    assert.equal(A.deviceFromUA(UA.desktop), 'desktop');
    assert.equal(A.deviceFromUA(UA.mac), 'desktop');
    assert.equal(A.deviceFromUA(''), 'desktop');
  });
});

describe('analytics: deriveSource', () => {
  const own = 'siroya.com';
  const cases = [
    [{ hasGclid: true, refHost: 'www.google.com' }, 'google_ads'],
    [{ hasGclid: 1, source: 'instagram' }, 'google_ads'],
    [{ source: 'google', medium: 'cpc' }, 'google_ads'],
    [{ source: 'Google', medium: 'PPC' }, 'google_ads'],
    [{ source: 'google', medium: 'paid' }, 'google_ads'],
    [{ source: 'adwords', medium: 'cpc' }, 'google_ads'],
    [{ source: 'facebook', medium: 'cpc' }, 'facebook'],
    [{ source: '  Newsletter ', medium: 'email' }, 'newsletter'],
    [{ source: 'google', medium: 'organic' }, 'google'],
    [{ source: 'ig', refHost: 'l.instagram.com' }, 'ig'],
    [{ refHost: 'www.google.com' }, 'google_organic'],
    [{ refHost: 'google.co.in' }, 'google_organic'],
    [{ refHost: 'https://www.google.ae/search?q=gold+ring' }, 'google_organic'],
    [{ refHost: 'com.google.android.googlequicksearchbox' }, 'google_organic'],
    [{ refHost: 'mail.google.com' }, 'referral'],
    [{ refHost: 'notgoogle.com' }, 'referral'],
    [{ refHost: 'www.bing.com' }, 'other_search'],
    [{ refHost: 'search.yahoo.com' }, 'other_search'],
    [{ refHost: 'duckduckgo.com' }, 'other_search'],
    [{ refHost: 'l.facebook.com' }, 'social'],
    [{ refHost: 'www.instagram.com' }, 'social'],
    [{ refHost: 't.co' }, 'social'],
    [{ refHost: 'x.com' }, 'social'],
    [{ refHost: 'www.linkedin.com' }, 'social'],
    [{ refHost: 'm.youtube.com' }, 'social'],
    [{ refHost: 'pinterest.co.uk' }, 'social'],
    [{ refHost: 'www.tiktok.com' }, 'social'],
    [{ refHost: 'box.com' }, 'referral'],
    [{ refHost: 'web.whatsapp.com' }, 'whatsapp'],
    [{ refHost: 'wa.me' }, 'whatsapp'],
    [{ refHost: '' }, 'direct'],
    [{}, 'direct'],
    [{ refHost: 'www.siroya.com', ownHost: 'siroya.com:5173' }, 'direct'],
    [{ refHost: 'siroya.com', ownHost: 'www.siroya.com' }, 'direct'],
    [{ refHost: 'blog.example.com' }, 'referral'],
  ];
  for (const [input, expected] of cases) {
    it(`${JSON.stringify(input)} -> ${expected}`, () => {
      assert.equal(A.deriveSource({ ownHost: own, ...input }), expected);
    });
  }
});

describe('analytics: recordEvent', () => {
  let db;
  before(() => { db = freshDb(); });
  after(() => db.close());

  const meta = { ua: UA.desktop, host: 'siroya.com', now: BASE };
  const count = () => db.stmt('SELECT COUNT(*) AS n FROM events').get().n;
  const last = () => db.stmt('SELECT * FROM events ORDER BY id DESC LIMIT 1').get();

  it('rejects non-objects, unknown types and bad session ids without throwing', () => {
    const before = count();
    assert.deepEqual(A.recordEvent(db, null, meta), { ok: false, reason: 'invalid' });
    assert.deepEqual(A.recordEvent(db, [], meta), { ok: false, reason: 'invalid' });
    assert.deepEqual(A.recordEvent(db, 'page_view', meta), { ok: false, reason: 'invalid' });
    assert.equal(A.recordEvent(db, { sid: '0123456789abcdef' }, meta).reason, 'invalid_type');
    assert.equal(A.recordEvent(db, { t: 'click', sid: '0123456789abcdef' }, meta).reason, 'invalid_type');
    assert.equal(A.recordEvent(db, { t: 'filter_category', sid: '0123456789abcdef' }, meta).reason, 'invalid_type');
    assert.equal(A.recordEvent(db, { t: 'page_view' }, meta).reason, 'invalid_sid');
    assert.equal(A.recordEvent(db, { t: 'page_view', sid: '0123456789ABCDEF' }, meta).reason, 'invalid_sid');
    assert.equal(A.recordEvent(db, { t: 'page_view', sid: '0123456789abcde' }, meta).reason, 'invalid_sid');
    assert.equal(A.recordEvent(db, { t: 'page_view', sid: '0123456789abcdef0' }, meta).reason, 'invalid_sid');
    assert.equal(A.recordEvent(db, { t: 'page_view', sid: 'g123456789abcdef' }, meta).reason, 'invalid_sid');
    assert.equal(count(), before);
  });

  it('drops bots', () => {
    const before = count();
    const r = A.recordEvent(db, { t: 'page_view', sid: '0123456789abcdef' }, { ...meta, ua: 'Googlebot/2.1' });
    assert.deepEqual(r, { ok: false, reason: 'bot' });
    assert.equal(A.recordEvent(db, { t: 'page_view', sid: '0123456789abcdef' }, { ...meta, ua: '' }).reason, 'bot');
    assert.equal(count(), before);
  });

  it('accepts every allowed type', () => {
    for (const t of A.EVENT_TYPES) {
      assert.equal(A.recordEvent(db, { t, sid: '0123456789abcdef' }, meta).ok, true, t);
    }
  });

  it('cleans, caps and derives fields; stores no IP or user agent', () => {
    const r = A.recordEvent(db, {
      t: 'view_item', sid: 'abcdefabcdef0123', p: '/product.html?p=rose-ring', pt: 'product', i: ' SJ-101\n',
      c: 'bridal\r\nline', k: { evil: true }, n: true, src: 'Instagram ', med: 'Social', cmp: 'Diwali\t2026',
      ref: 'https://L.Instagram.com/some/path?x=1', g: false,
    }, { ...meta, ua: UA.iphone });
    assert.deepEqual(r, { ok: true, source: 'instagram', device: 'mobile' });
    const row = last();
    assert.equal(row.type, 'view_item');
    assert.equal(row.path, '/product.html?p=rose-ring');
    assert.equal(row.page_type, 'product');
    assert.equal(row.item, 'SJ-101');
    assert.equal(row.collection, '', 'a collection slug with a line break is not a slug');
    assert.equal(row.category, '');
    assert.equal(row.is_new, 1);
    assert.equal(row.source, 'instagram');
    assert.equal(row.medium, 'social');
    assert.equal(row.campaign, 'Diwali 2026');
    assert.equal(row.ref_host, 'l.instagram.com');
    assert.equal(row.has_gclid, 0);
    assert.equal(row.device, 'mobile');
    assert.equal(row.ts, new Date(BASE).toISOString());
    assert.equal(row.day, '2026-10-02');
    const cols = db.raw.prepare('PRAGMA table_info(events)').all().map(c => c.name);
    for (const banned of ['ip', 'user_agent', 'ua']) assert.ok(!cols.includes(banned), `events must not have ${banned}`);
  });

  it('marks gclid visits as google_ads and buckets days in Dubai time (UTC+4)', () => {
    A.recordEvent(db, { t: 'page_view', sid: 'abcdefabcdef0123', g: 1 }, { ...meta, now: Date.parse('2026-10-01T20:00:00Z') });
    let row = last();
    assert.equal(row.source, 'google_ads');
    assert.equal(row.has_gclid, 1);
    assert.equal(row.day, '2026-10-02');
    A.recordEvent(db, { t: 'page_view', sid: 'abcdefabcdef0123' }, { ...meta, now: Date.parse('2026-10-01T19:59:59Z') });
    row = last();
    assert.equal(row.day, '2026-10-01');
    assert.equal(row.source, 'direct');
  });
});

describe('analytics: trafficReport', () => {
  let db;
  let report;
  const S = {
    s1: 'a1a1a1a1a1a1a1a1', s2: 'b2b2b2b2b2b2b2b2', s3: 'c3c3c3c3c3c3c3c3', s4: 'd4d4d4d4d4d4d4d4',
    s5: 'e5e5e5e5e5e5e5e5', s6: 'f6f6f6f6f6f6f6f6', old: '0101010101010101',
  };
  const ev = (dayOffset, ua, body) => {
    const r = A.recordEvent(db, body, { ua, host: 'siroya.com', now: BASE + dayOffset * DAY });
    assert.equal(r.ok, true, JSON.stringify(body));
  };

  before(() => {
    db = freshDb();
    seedCatalog(db);
    // Current 7 days: 2026-09-26 .. 2026-10-02
    ev(0, UA.iphone, { t: 'page_view', sid: S.s1, p: '/', ref: 'https://www.google.com/', n: 1 });
    ev(0, UA.iphone, { t: 'page_view', sid: S.s1, p: '/collection.html?c=bridal', ref: 'https://siroya.com/' });
    ev(0, UA.iphone, { t: 'view_item_list', sid: S.s1, c: 'bridal', ref: 'https://siroya.com/' });
    ev(0, UA.iphone, { t: 'view_item', sid: S.s1, i: 'SJ-101', ref: 'https://siroya.com/' });
    ev(0, UA.iphone, { t: 'whatsapp_click', sid: S.s1, i: 'SJ-101', ref: 'https://siroya.com/' });
    ev(-2, UA.desktop, { t: 'page_view', sid: S.s2, p: '/', src: 'instagram', med: 'social', cmp: 'diwali', n: 1 });
    ev(-2, UA.desktop, { t: 'generate_lead', sid: S.s2, i: 'SJ-101', src: 'instagram', med: 'social', cmp: 'diwali' });
    ev(-6, UA.ipad, { t: 'page_view', sid: S.s3, p: '/about.html', n: 0 });
    ev(-6, UA.ipad, { t: 'page_view', sid: S.s3, p: '/product.html?p=rose-ring', g: true });
    ev(-1, UA.mac, { t: 'page_view', sid: S.s4, p: '/product.html?p=rose-ring', ref: 'www.bing.com' });
    ev(-1, UA.mac, { t: 'view_item', sid: S.s4, i: 'rose-ring', ref: 'siroya.com' });
    ev(-1, UA.mac, { t: 'view_item_list', sid: S.s4, c: 'category-rings', ref: 'siroya.com' });
    // Previous 7 days: 2026-09-19 .. 2026-09-25
    ev(-7, UA.desktop, { t: 'page_view', sid: S.s5, p: '/' });
    ev(-7, UA.desktop, { t: 'whatsapp_click', sid: S.s5 });
    ev(-13, UA.desktop, { t: 'page_view', sid: S.s6, p: '/' });
    // Outside both periods
    ev(-14, UA.desktop, { t: 'page_view', sid: S.old, p: '/' });

    insertLead(db, '2026-10-01T21:30:00.000Z'); // Dubai 2026-10-02 01:30 -> current
    insertLead(db, '2026-09-25T20:00:00.000Z'); // Dubai 2026-09-26 00:00 -> current, first day
    insertLead(db, '2026-09-25T19:59:59.000Z'); // Dubai 2026-09-25 23:59 -> previous
    insertLead(db, '2026-09-18T19:00:00.000Z'); // Dubai 2026-09-18 -> outside

    // The report covers complete days ending yesterday: taken the day after BASE,
    // its current period is 2026-09-26 .. 2026-10-02.
    report = A.trafficReport(db, 7, { now: BASE + DAY });
  });
  after(() => db.close());

  it('has the documented shape', () => {
    for (const key of ['range', 'from', 'to', 'totals', 'previous', 'daily', 'previous_daily', 'sources', 'campaigns', 'top_pages',
      'top_collections', 'top_products', 'devices', 'new_vs_returning', 'today']) {
      assert.ok(key in report, `missing ${key}`);
    }
    const totalKeys = ['visitors', 'page_views', 'whatsapp_clicks', 'leads', 'conversion_rate'];
    assert.deepEqual(Object.keys(report.totals).sort(), [...totalKeys].sort());
    assert.deepEqual(Object.keys(report.previous).sort(), [...totalKeys].sort());
    assert.equal(report.range, 7);
    assert.equal(report.from, '2026-09-26');
    assert.equal(report.to, '2026-10-02');
    assert.equal(report.previous_from, '2026-09-19');
    assert.equal(report.previous_to, '2026-09-25');
  });

  it('computes current totals (leads from the leads table)', () => {
    assert.deepEqual(report.totals, { visitors: 4, page_views: 6, whatsapp_clicks: 1, leads: 2, conversion_rate: 0.5 });
  });

  it('computes the previous period of the same length', () => {
    assert.deepEqual(report.previous, { visitors: 2, page_views: 2, whatsapp_clicks: 1, leads: 1, conversion_rate: 0.5 });
  });

  it('zero-fills every day in order', () => {
    assert.equal(report.daily.length, 7);
    assert.deepEqual(report.daily.map(d => d.day), [
      '2026-09-26', '2026-09-27', '2026-09-28', '2026-09-29', '2026-09-30', '2026-10-01', '2026-10-02',
    ]);
    const byDay = Object.fromEntries(report.daily.map(d => [d.day, d]));
    assert.deepEqual(byDay['2026-09-26'], { day: '2026-09-26', visitors: 1, page_views: 2, whatsapp_clicks: 0, leads: 1 });
    assert.deepEqual(byDay['2026-09-27'], { day: '2026-09-27', visitors: 0, page_views: 0, whatsapp_clicks: 0, leads: 0 });
    assert.deepEqual(byDay['2026-09-30'], { day: '2026-09-30', visitors: 1, page_views: 1, whatsapp_clicks: 0, leads: 0 });
    assert.deepEqual(byDay['2026-10-01'], { day: '2026-10-01', visitors: 1, page_views: 1, whatsapp_clicks: 0, leads: 0 });
    assert.deepEqual(byDay['2026-10-02'], { day: '2026-10-02', visitors: 1, page_views: 2, whatsapp_clicks: 1, leads: 1 });
    const sum = report.daily.reduce((acc, d) => acc + d.page_views, 0);
    assert.equal(sum, report.totals.page_views);
  });

  it('attributes each session to its first non-direct source', () => {
    assert.deepEqual(report.sources, [
      { source: 'google_ads', visitors: 1, whatsapp_clicks: 0, leads: 0 },
      { source: 'google_organic', visitors: 1, whatsapp_clicks: 1, leads: 0 },
      { source: 'instagram', visitors: 1, whatsapp_clicks: 0, leads: 1 },
      { source: 'other_search', visitors: 1, whatsapp_clicks: 0, leads: 0 },
    ]);
    assert.deepEqual(report.campaigns, [{ campaign: 'diwali', visitors: 1, whatsapp_clicks: 0, leads: 1 }]);
  });

  it('ranks pages, collections and products with catalog names', () => {
    assert.deepEqual(report.top_pages, [
      { path: '/', views: 2, visitors: 2 },
      { path: '/product.html?p=rose-ring', views: 2, visitors: 2 },
      { path: '/about.html', views: 1, visitors: 1 },
      { path: '/collection.html?c=bridal', views: 1, visitors: 1 },
    ]);
    assert.deepEqual(report.top_collections, [
      { collection: 'bridal', name: 'Bridal Collection', views: 1 },
      { collection: 'category-rings', name: 'Rings', views: 1 },
    ]);
    assert.deepEqual(report.top_products, [
      { item: 'SJ-101', name: 'Rose Ring', handle: 'rose-ring', views: 1, whatsapp_clicks: 1, leads: 1 },
      { item: 'rose-ring', name: 'Rose Ring', handle: 'rose-ring', views: 1, whatsapp_clicks: 0, leads: 0 },
    ]);
  });

  it('splits devices and new vs returning', () => {
    assert.deepEqual(report.devices, [
      { device: 'desktop', visitors: 2 },
      { device: 'mobile', visitors: 1 },
      { device: 'tablet', visitors: 1 },
    ]);
    assert.deepEqual(report.new_vs_returning, { new: 2, returning: 2 });
  });

  it('sends the previous period day by day for the comparison line', () => {
    assert.equal(report.previous_daily.length, 7);
    assert.equal(report.previous_daily[0].day, '2026-09-19');
    assert.equal(report.previous_daily[6].day, '2026-09-25');
    const byDay = Object.fromEntries(report.previous_daily.map(d => [d.day, d]));
    assert.deepEqual(byDay['2026-09-25'], { day: '2026-09-25', visitors: 1, page_views: 1, whatsapp_clicks: 1, leads: 1 });
    assert.deepEqual(byDay['2026-09-19'], { day: '2026-09-19', visitors: 1, page_views: 1, whatsapp_clicks: 0, leads: 0 });
  });

  it('supports 30 and 90 day ranges and rejects others', () => {
    const r30 = A.trafficReport(db, 30, { now: BASE + DAY });
    assert.equal(r30.daily.length, 30);
    assert.equal(r30.from, '2026-09-03');
    assert.equal(r30.previous_to, '2026-09-02');
    assert.equal(r30.previous_from, '2026-08-04');
    assert.equal(r30.totals.visitors, 7);
    assert.equal(r30.totals.leads, 4);
    const r90 = A.trafficReport(db, '90', { now: BASE + DAY });
    assert.equal(r90.daily.length, 90);
    assert.equal(r90.daily[0].day, r90.from);
    assert.equal(r90.daily[89].day, '2026-10-02');
    assert.throws(() => A.trafficReport(db, 14, { now: BASE + DAY }), err => err instanceof HttpError && err.status === 400);
  });

  it('returns zeros on an empty database', () => {
    const empty = freshDb();
    const r = A.trafficReport(empty, 7, { now: BASE });
    assert.deepEqual(r.totals, { visitors: 0, page_views: 0, whatsapp_clicks: 0, leads: 0, conversion_rate: 0 });
    assert.deepEqual(r.today, { day: '2026-10-02', visitors: 0, page_views: 0, whatsapp_clicks: 0, leads: 0 });
    assert.equal(r.daily.length, 7);
    assert.ok(r.daily.every(d => d.visitors === 0 && d.leads === 0));
    assert.deepEqual(r.sources, []);
    assert.deepEqual(r.new_vs_returning, { new: 0, returning: 0 });
    empty.close();
  });
});

describe('analytics: retention', () => {
  it('purges events older than 400 days', () => {
    const db = freshDb();
    const meta = d => ({ ua: UA.desktop, host: 'siroya.com', now: BASE - d * DAY });
    A.recordEvent(db, { t: 'page_view', sid: '0123456789abcdef' }, meta(401));
    A.recordEvent(db, { t: 'page_view', sid: '0123456789abcdef' }, meta(399));
    A.recordEvent(db, { t: 'page_view', sid: '0123456789abcdef' }, meta(0));
    assert.equal(A.purgeOld(db, { now: BASE }), 1);
    assert.equal(db.stmt('SELECT COUNT(*) AS n FROM events').get().n, 2);
    assert.equal(A.purgeOld(db, { now: BASE }), 0);
    db.close();
  });

  it('schema SQL is idempotent', () => {
    const db = freshDb();
    A.ensureAnalyticsSchema(db.raw);
    A.ensureAnalyticsSchema(db);
    db.raw.exec(A.ANALYTICS_SCHEMA_SQL);
    const idx = db.raw.prepare("SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = 'events'").all().map(r => r.name).sort();
    assert.deepEqual(idx, ['events_day', 'events_sid_day', 'events_type_day']);
    const tables = db.raw.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name LIKE 'events%'").all().map(r => r.name).sort();
    assert.deepEqual(tables, ['events', 'events_daily', 'events_daily_dim']);
    db.close();
  });
});

/* ======================================================================
   HTTP routes (registerTraffic)
   ====================================================================== */

describe('api: /api/track and admin traffic routes', () => {
  let db;
  let server;
  let port;
  let registered;
  const AUTH = { 'X-Test-Auth': '1' };
  const count = () => db.stmt('SELECT COUNT(*) AS n FROM events').get().n;

  before(async () => {
    db = freshDb();
    seedCatalog(db);
    const router = new Router();
    registered = registerTraffic(router, { db, env: {}, trackLimiter: createLimiter({ limit: 6, windowMs: 60000 }) });
    server = http.createServer(apiHarness(router, { isAuthed: req => req.headers['x-test-auth'] === '1' }));
    port = await listenInRange(server);
  });
  after(async () => {
    registered.stop();
    await closeServer(server);
    db.close();
  });

  const beacon = (body, { type = 'text/plain;charset=UTF-8', ua = UA.desktop } = {}) => request(port, 'POST', '/api/track', {
    body, headers: { 'Content-Type': type, 'User-Agent': ua, Host: 'siroya.com' },
  });

  it('stores a sendBeacon text/plain event and answers 204 with no body', async () => {
    const res = await beacon({ t: 'page_view', sid: '0123456789abcdef', p: '/', ref: 'www.google.com', n: 1 });
    assert.equal(res.status, 204);
    assert.equal(res.text, '');
    assert.equal(count(), 1);
    const row = db.stmt('SELECT * FROM events').get();
    assert.equal(row.source, 'google_organic');
    assert.equal(row.device, 'desktop');
  });

  it('accepts application/json and treats own host referrers as direct', async () => {
    const res = await beacon({ t: 'view_item', sid: '0123456789abcdef', i: 'SJ-101', ref: 'siroya.com' }, { type: 'application/json' });
    assert.equal(res.status, 204);
    assert.equal(db.stmt('SELECT source FROM events ORDER BY id DESC LIMIT 1').get().source, 'direct');
  });

  it('answers 204 but stores nothing for bots and invalid events', async () => {
    const before = count();
    assert.equal((await beacon({ t: 'page_view', sid: '0123456789abcdef' }, { ua: 'Googlebot/2.1' })).status, 204);
    assert.equal((await beacon({ t: 'nope', sid: '0123456789abcdef' })).status, 204);
    assert.equal((await beacon({ t: 'page_view', sid: 'short' })).status, 204);
    assert.equal(count(), before);
  });

  it('rejects bodies over 4 KB with 413 and other content types with 415', async () => {
    const big = JSON.stringify({ t: 'page_view', sid: '0123456789abcdef', p: 'x'.repeat(5000) });
    const res = await beacon(big);
    assert.equal(res.status, 413);
    const form = await request(port, 'POST', '/api/track', {
      body: 't=page_view', headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'User-Agent': UA.desktop },
    });
    assert.equal(form.status, 415);
  });

  it('rate limits per IP silently (still 204)', async () => {
    // limiter allows 6 per minute; 5 hits used above (2 stored + 3 dropped), 413/415 never reached the handler
    const before = count();
    assert.equal((await beacon({ t: 'page_view', sid: '0123456789abcdef' })).status, 204); // 6th: stored
    assert.equal((await beacon({ t: 'page_view', sid: '0123456789abcdef' })).status, 204); // 7th: dropped
    assert.equal((await beacon({ t: 'page_view', sid: '0123456789abcdef' })).status, 204); // 8th: dropped
    assert.equal(count(), before + 1);
  });

  it('protects admin routes', async () => {
    for (const [method, path] of [['GET', '/api/admin/traffic'], ['GET', '/api/admin/google'], ['GET', '/api/admin/search'],
      ['GET', '/api/admin/analytics'], ['POST', '/api/admin/google/test'], ['DELETE', '/api/admin/google']]) {
      const res = await request(port, method, path, method === 'GET' ? {} : { body: {}, headers: { 'Content-Type': 'application/json' } });
      assert.equal(res.status, 401, `${method} ${path}`);
    }
  });

  it('GET /api/admin/traffic returns the report and validates range', async () => {
    const res = await request(port, 'GET', '/api/admin/traffic', { headers: AUTH });
    assert.equal(res.status, 200);
    assert.equal(res.data.range, 7);
    assert.equal(res.data.daily.length, 7);
    assert.equal(res.data.to, A.addDays(A.dubaiDay(Date.now()), -1), 'complete days end yesterday');
    assert.ok(res.data.today.visitors >= 1, 'beacons sent just now show up in today');
    assert.ok(res.data.today.page_views >= 1);
    const r30 = await request(port, 'GET', '/api/admin/traffic?range=30', { headers: AUTH });
    assert.equal(r30.data.daily.length, 30);
    const bad = await request(port, 'GET', '/api/admin/traffic?range=14', { headers: AUTH });
    assert.equal(bad.status, 400);
    assert.match(bad.data.error, /7, 30 or 90/);
  });

  it('Google endpoints report not_connected with 409', async () => {
    const st = await request(port, 'GET', '/api/admin/google', { headers: AUTH });
    assert.equal(st.status, 200);
    assert.equal(st.data.connected, false);
    for (const path of ['/api/admin/search?range=28', '/api/admin/analytics?range=30']) {
      const res = await request(port, 'GET', path, { headers: AUTH });
      assert.equal(res.status, 409, path);
      assert.deepEqual(res.data, { code: 'not_connected', error: 'Google is not connected' });
    }
    const t = await request(port, 'POST', '/api/admin/google/test', { body: {}, headers: { ...AUTH, 'Content-Type': 'application/json' } });
    assert.equal(t.status, 409);
    const badRange = await request(port, 'GET', '/api/admin/search?range=30', { headers: AUTH });
    assert.equal(badRange.status, 400);
  });

  it('PUT /api/admin/google validates input with friendly 400s', async () => {
    const put = body => request(port, 'PUT', '/api/admin/google', { body, headers: { ...AUTH, 'Content-Type': 'application/json' } });
    let res = await put({ service_account_json: '{"type":"authorized_user"}' });
    assert.equal(res.status, 400);
    assert.match(res.data.error, /service_account/);
    res = await put({ ga4_property: 'G-ABC123' });
    assert.equal(res.status, 400);
    assert.match(res.data.error, /Measurement ID/);
    res = await put({ gsc_site: 'sc-domain:siroya.com', ga4_property: '123456' });
    assert.equal(res.status, 200);
    assert.equal(res.data.connected, false);
    assert.equal(res.data.gsc_site, 'sc-domain:siroya.com');
    assert.equal(res.data.ga4_property, '123456');
  });
});

/* ======================================================================
   Google client against a local mock of Google's APIs
   ====================================================================== */

const KEYS = crypto.generateKeyPairSync('rsa', {
  modulusLength: 2048,
  publicKeyEncoding: { type: 'spki', format: 'pem' },
  privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
});
const OTHER_KEYS = crypto.generateKeyPairSync('rsa', {
  modulusLength: 2048,
  publicKeyEncoding: { type: 'spki', format: 'pem' },
  privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
});
const CLIENT_EMAIL = 'siroya-reader@siroya-test.iam.gserviceaccount.com';
const serviceAccount = (privateKey = KEYS.privateKey) => ({
  type: 'service_account',
  project_id: 'siroya-test',
  private_key_id: 'kid-0123456789abcdef',
  private_key: privateKey,
  client_email: CLIENT_EMAIL,
  client_id: '1234567890',
  token_uri: 'https://attacker.invalid/token',
});
// A distinctive slice of the private key body, to prove it never leaks.
const KEY_FRAGMENT = KEYS.privateKey.split('\n')[5];

function createMockGoogle(publicKey) {
  const state = {
    hits: { token: 0, sites: 0, gsc: 0, ga4: 0 },
    issued: new Set(),
    jwt: null,
    gscBodies: [],
    ga4Bodies: [],
    failGsc: 0,
    rejectTokensOnce: false,
    hanging: [],
  };
  const yesterday = '2026-10-01';

  function verifyAssertion(assertion) {
    const parts = String(assertion || '').split('.');
    if (parts.length !== 3) return null;
    const [h, c, s] = parts;
    const ok = crypto.verify('RSA-SHA256', Buffer.from(`${h}.${c}`), publicKey, Buffer.from(s, 'base64url'));
    if (!ok) return null;
    const header = JSON.parse(Buffer.from(h, 'base64url').toString('utf8'));
    const claims = JSON.parse(Buffer.from(c, 'base64url').toString('utf8'));
    if (header.alg !== 'RS256' || header.typ !== 'JWT') return null;
    if (claims.aud !== 'https://oauth2.googleapis.com/token' || claims.iss !== CLIENT_EMAIL) return null;
    if (claims.exp - claims.iat !== 3600) return null;
    return { header, claims };
  }

  const send = (res, status, data) => {
    const body = JSON.stringify(data);
    res.writeHead(status, { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) });
    res.end(body);
  };
  const googleError = (res, status, statusText, message, details) => send(res, status, {
    error: { code: status, message, status: statusText, ...(details ? { details } : {}) },
  });

  function searchRows(body) {
    const dims = body.dimensions || [];
    const current = body.endDate === yesterday;
    if (!dims.length) {
      return [current
        ? { clicks: 120, impressions: 3000, ctr: 0.04, position: 8.254 }
        : { clicks: 80, impressions: 2500, ctr: 0.032, position: 9.5 }];
    }
    switch (dims[0]) {
      case 'date': return [
        { keys: ['2026-09-30'], clicks: 5, impressions: 50, ctr: 0.1, position: 7.5 },
        { keys: ['2026-10-01'], clicks: 7, impressions: 70, ctr: 0.1, position: 6.25 },
      ];
      case 'query': return Array.from({ length: 60 }, (_, i) => ({
        keys: [`gold ring ${i}`], clicks: 60 - i, impressions: 600 - i, ctr: 0.1, position: 3 + i / 10,
      })).slice(0, body.rowLimit);
      case 'page': return [
        { keys: ['https://siroya.com/'], clicks: 50, impressions: 900, ctr: 0.0556, position: 4.2 },
        { keys: ['https://siroya.com/product.html?p=rose-ring'], clicks: 20, impressions: 300, ctr: 0.0667, position: 6.1 },
        { keys: ['https://siroya.com/about.html'], clicks: 2, impressions: 40, ctr: 0.05, position: 12 },
      ];
      case 'device': return [
        { keys: ['MOBILE'], clicks: 90, impressions: 2000, ctr: 0.045, position: 7.9 },
        { keys: ['DESKTOP'], clicks: 30, impressions: 1000, ctr: 0.03, position: 9.1 },
      ];
      case 'country': return [
        { keys: ['ind'], clicks: 10, impressions: 400, ctr: 0.025, position: 15 },
        { keys: ['are'], clicks: 100, impressions: 2400, ctr: 0.0417, position: 6.5 },
      ];
      default: return [];
    }
  }

  function gaReport(body) {
    const dims = (body.dimensions || []).map(d => d.name);
    const mets = (body.metrics || []).map(m => m.name);
    const range = (body.dateRanges || [])[0] || {};
    const current = range.endDate === yesterday || range.endDate === 'yesterday';
    const values = current
      ? { activeUsers: '1200', newUsers: '900', sessions: '1500', engagementRate: '0.612345', averageSessionDuration: '75.3456' }
      : { activeUsers: '1000', newUsers: '800', sessions: '1300', engagementRate: '0.55', averageSessionDuration: '70' };
    const out = {
      dimensionHeaders: dims.map(name => ({ name })),
      metricHeaders: mets.map(name => ({ name, type: 'TYPE_INTEGER' })),
      kind: 'analyticsData#runReport',
    };
    const row = (dimValues, metricMap) => ({
      dimensionValues: dimValues.map(value => ({ value })),
      metricValues: mets.map(m => ({ value: String(metricMap[m] ?? '0') })),
    });
    if (!dims.length) out.rows = [row([], values)];
    else if (dims[0] === 'date') out.rows = [row(['20260930'], { activeUsers: 40, sessions: 50 }), row(['20261001'], { activeUsers: 45, sessions: 52 })];
    else if (dims[0] === 'sessionDefaultChannelGroup') {
      out.rows = [row(['Direct'], { sessions: 300, activeUsers: 250 }), row(['Organic Search'], { sessions: 900, activeUsers: 700 }), row(['Organic Social'], { sessions: 120, activeUsers: 100 })];
    } else if (dims[0] === 'landingPage') out.rows = [row(['/'], { sessions: 800 }), row(['/product.html'], { sessions: 300 })];
    out.rowCount = out.rows ? out.rows.length : 0;
    return out;
  }

  const server = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', c => chunks.push(c));
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8');
      const url = new URL(req.url, 'http://mock');
      if (req.method === 'POST' && url.pathname === '/token') {
        state.hits.token++;
        const form = new URLSearchParams(raw);
        if (form.get('grant_type') !== 'urn:ietf:params:oauth:grant-type:jwt-bearer') {
          return send(res, 400, { error: 'unsupported_grant_type', error_description: 'Invalid grant_type' });
        }
        const verified = verifyAssertion(form.get('assertion'));
        if (!verified) return send(res, 400, { error: 'invalid_grant', error_description: 'Invalid JWT Signature.' });
        state.jwt = verified;
        const access = `tok-${state.hits.token}-${crypto.randomBytes(4).toString('hex')}`;
        state.issued.add(access);
        return send(res, 200, { access_token: access, expires_in: 3600, token_type: 'Bearer' });
      }

      const auth = String(req.headers.authorization || '');
      const access = auth.startsWith('Bearer ') ? auth.slice(7) : '';
      if (state.rejectTokensOnce) {
        state.rejectTokensOnce = false;
        state.issued.clear();
      }
      if (!state.issued.has(access)) {
        return googleError(res, 401, 'UNAUTHENTICATED', 'Request had invalid authentication credentials.');
      }

      if (req.method === 'GET' && url.pathname === '/webmasters/v3/sites') {
        state.hits.sites++;
        return send(res, 200, {
          siteEntry: [
            { siteUrl: 'sc-domain:siroya.com', permissionLevel: 'siteRestrictedUser' },
            { siteUrl: 'https://siroya.com/', permissionLevel: 'siteFullUser' },
            { siteUrl: 'https://unverified.example/', permissionLevel: 'siteUnverifiedUser' },
          ],
        });
      }

      const gsc = /^\/webmasters\/v3\/sites\/([^/]+)\/searchAnalytics\/query$/.exec(url.pathname);
      if (req.method === 'POST' && gsc) {
        state.hits.gsc++;
        const site = decodeURIComponent(gsc[1]);
        const body = JSON.parse(raw || '{}');
        state.gscBodies.push({ site, body });
        if (state.failGsc) return googleError(res, state.failGsc, 'UNAVAILABLE', 'The service is currently unavailable.');
        if (site === 'sc-domain:noaccess.com') {
          return googleError(res, 403, 'PERMISSION_DENIED', "User does not have sufficient permission for site 'sc-domain:noaccess.com'. See also: https://support.google.com/webmasters/answer/2451999.");
        }
        return send(res, 200, { rows: searchRows(body), responseAggregationType: 'byProperty' });
      }

      const ga = /^\/v1beta\/properties\/(\d+):runReport$/.exec(url.pathname);
      if (req.method === 'POST' && ga) {
        state.hits.ga4++;
        const body = JSON.parse(raw || '{}');
        state.ga4Bodies.push({ property: ga[1], body });
        if (ga[1] === '999') return googleError(res, 403, 'PERMISSION_DENIED', 'User does not have sufficient permissions for this property.');
        if (ga[1] === '404') return googleError(res, 404, 'NOT_FOUND', 'Requested entity was not found.');
        if (ga[1] === '555') {
          return googleError(res, 403, 'PERMISSION_DENIED', 'Google Analytics Data API has not been used in project 1234 before or it is disabled.', [
            { '@type': 'type.googleapis.com/google.rpc.ErrorInfo', reason: 'SERVICE_DISABLED', domain: 'googleapis.com' },
          ]);
        }
        if (ga[1] === '777') { state.hanging.push(res); return undefined; }
        return send(res, 200, gaReport(body));
      }

      return googleError(res, 404, 'NOT_FOUND', 'Not found');
    });
  });

  return { server, state };
}

function memorySettings() {
  const map = new Map();
  return {
    map,
    getSetting: (key, fallback) => (map.has(key) ? JSON.parse(map.get(key)) : fallback),
    setSetting: (key, value) => { map.set(key, JSON.stringify(value)); },
  };
}

describe('google: helpers', () => {
  it('honours GOOGLE_API_ORIGIN only when NODE_ENV=test', () => {
    assert.equal(G.apiOrigins('production', 'http://127.0.0.1:5301'), G.ORIGINS);
    assert.equal(G.apiOrigins('development', 'http://127.0.0.1:5301'), G.ORIGINS);
    assert.equal(G.apiOrigins('', 'http://127.0.0.1:5301'), G.ORIGINS);
    assert.equal(G.apiOrigins('test', ''), G.ORIGINS);
    assert.equal(G.apiOrigins('test', 'ftp://127.0.0.1:5301'), G.ORIGINS);
    assert.equal(G.apiOrigins('test', 'not a url'), G.ORIGINS);
    assert.deepEqual({ ...G.apiOrigins('test', 'http://127.0.0.1:5301/ignored/path') }, {
      token: 'http://127.0.0.1:5301', gsc: 'http://127.0.0.1:5301', ga4: 'http://127.0.0.1:5301',
    });
    assert.deepEqual({ ...G.ORIGINS }, {
      token: 'https://oauth2.googleapis.com',
      gsc: 'https://searchconsole.googleapis.com',
      ga4: 'https://analyticsdata.googleapis.com',
    });
  });

  it('validates Search Console properties and GA4 property IDs', () => {
    assert.equal(G.parseGscSite('sc-domain:Siroya.COM'), 'sc-domain:siroya.com');
    assert.equal(G.parseGscSite('https://Siroya.com'), 'https://siroya.com/');
    assert.equal(G.parseGscSite('https://siroya.com/shop/'), 'https://siroya.com/shop/');
    assert.equal(G.parseGscSite(''), '');
    for (const bad of ['siroya.com', 'sc-domain:', 'sc-domain:bad domain.com', 'javascript:alert(1)', 'https://user:pw@siroya.com/', 'https://siroya.com/?q=1', 42]) {
      assert.throws(() => G.parseGscSite(bad), err => err.status === 400, String(bad));
    }
    assert.equal(G.parseGa4Property('123456'), '123456');
    assert.equal(G.parseGa4Property('properties/123456'), '123456');
    assert.equal(G.parseGa4Property(987654), '987654');
    assert.equal(G.parseGa4Property(''), '');
    assert.throws(() => G.parseGa4Property('G-ABC123'), /Measurement ID/);
    assert.throws(() => G.parseGa4Property('12ab'), err => err.status === 400);
  });

  it('validates the service-account key without echoing it', () => {
    const ec = crypto.generateKeyPairSync('ec', { namedCurve: 'P-256', privateKeyEncoding: { type: 'pkcs8', format: 'pem' }, publicKeyEncoding: { type: 'spki', format: 'pem' } });
    const cases = [
      'not json',
      '[]',
      JSON.stringify({ type: 'authorized_user', client_email: CLIENT_EMAIL, private_key: KEYS.privateKey }),
      JSON.stringify({ ...serviceAccount(), client_email: 'nope' }),
      JSON.stringify({ ...serviceAccount(), private_key: 'abc' }),
      JSON.stringify({ ...serviceAccount(), private_key: KEYS.privateKey.replace('A', '!') }),
      JSON.stringify({ ...serviceAccount(), private_key: ec.privateKey }),
    ];
    for (const input of cases) {
      assert.throws(() => G.parseServiceAccount(input), err => {
        assert.equal(err.status, 400);
        assert.equal(err.data.code, 'invalid_key');
        assert.ok(!err.message.includes('PRIVATE KEY') && !err.message.includes(KEY_FRAGMENT));
        return true;
      });
    }
    const sa = G.parseServiceAccount(JSON.stringify(serviceAccount()));
    assert.deepEqual(Object.keys(sa).sort(), ['client_email', 'private_key', 'private_key_id']);
    assert.equal(sa.client_email, CLIENT_EMAIL);
    // Accepts an object and a key with literal "\n" sequences (pasted from a .env or shell).
    const escaped = { ...serviceAccount(), private_key: KEYS.privateKey.replace(/\n/g, '\\n') };
    assert.equal(G.parseServiceAccount(escaped).private_key, sa.private_key);
  });
});

describe('google: client against a mock Google', () => {
  let mock;
  let port;
  let clock = BASE;
  const now = () => clock;
  let settings;
  let client;
  const outputs = [];
  const logs = [];
  const original = { log: console.log, error: console.error, warn: console.warn };
  const keep = value => { outputs.push(JSON.stringify(value)); return value; };
  const expectReject = async (promise, check) => {
    await assert.rejects(promise, err => { outputs.push(err.message); return check(err); });
  };

  before(async () => {
    mock = createMockGoogle(KEYS.publicKey);
    port = await listenInRange(mock.server);
    process.env.GOOGLE_API_ORIGIN = `http://127.0.0.1:${port}`;
    for (const k of ['log', 'error', 'warn']) {
      console[k] = (...args) => { logs.push(args.map(String).join(' ')); };
    }
    settings = memorySettings();
    client = G.createGoogleClient({ getSetting: settings.getSetting, setSetting: settings.setSetting, env: {}, now });
  });

  after(async () => {
    Object.assign(console, original);
    for (const res of mock.state.hanging) { try { res.destroy(); } catch { /* ignore */ } }
    await closeServer(mock.server);
    delete process.env.GOOGLE_API_ORIGIN;
  });

  it('reports not connected before a key is saved', async () => {
    assert.deepEqual(keep(client.status()), {
      connected: false, client_email: '', gsc_site: '', ga4_property: '', connected_at: null, last_sync: null, last_error: '',
    });
    await expectReject(client.searchReport(28), err => err.status === 409 && err.data.code === 'not_connected' && err.message === 'Google is not connected');
    await expectReject(client.analyticsReport(30), err => err.status === 409 && err.data.code === 'not_connected');
    await expectReject(client.test(), err => err.status === 409);
    assert.equal(mock.state.hits.token, 0);
  });

  it('saves the key and settings; status never includes the private key', () => {
    const st = keep(client.save({
      service_account_json: JSON.stringify(serviceAccount()),
      gsc_site: 'sc-domain:Siroya.com',
      ga4_property: 'properties/123456',
    }));
    assert.equal(st.connected, true);
    assert.equal(st.client_email, CLIENT_EMAIL);
    assert.equal(st.gsc_site, 'sc-domain:siroya.com');
    assert.equal(st.ga4_property, '123456');
    assert.equal(st.connected_at, new Date(BASE).toISOString());
    assert.ok(!('private_key' in st));
    const text = JSON.stringify(st);
    assert.ok(!text.includes('PRIVATE KEY') && !text.includes(KEY_FRAGMENT));
    const stored = settings.getSetting('google');
    assert.equal(stored.private_key_id, 'kid-0123456789abcdef');
    assert.ok(!('token_uri' in stored), 'token_uri from the key file must be ignored');
    assert.ok(stored.private_key.includes('PRIVATE KEY'), 'the key itself is kept server side');
  });

  it('test() signs a valid RS256 JWT, lists sites and checks GA4', async () => {
    const r = keep(await client.test());
    assert.equal(r.ok, true, r.error);
    assert.deepEqual(r.sites, ['https://siroya.com/', 'sc-domain:siroya.com']);
    assert.equal(r.gsc_ok, true);
    assert.equal(r.ga4_ok, true);
    assert.equal(r.error, '');
    assert.equal(mock.state.hits.token, 1);
    const { header, claims } = mock.state.jwt;
    assert.deepEqual(header, { alg: 'RS256', typ: 'JWT', kid: 'kid-0123456789abcdef' });
    assert.equal(claims.iss, CLIENT_EMAIL);
    assert.equal(claims.aud, 'https://oauth2.googleapis.com/token');
    assert.equal(claims.scope, 'https://www.googleapis.com/auth/webmasters.readonly https://www.googleapis.com/auth/analytics.readonly');
    assert.equal(claims.iat, Math.floor(BASE / 1000));
    assert.equal(claims.exp, claims.iat + 3600);
    const ga = mock.state.ga4Bodies.at(-1);
    assert.equal(ga.property, '123456');
    assert.deepEqual(ga.body.dateRanges, [{ startDate: 'yesterday', endDate: 'yesterday' }]);
  });

  it('searchReport returns the documented shape with zero-filled days', async () => {
    const r = keep(await client.searchReport(28));
    assert.equal(r.range, 28);
    assert.equal(r.from, '2026-09-04');
    assert.equal(r.to, '2026-10-01');
    assert.equal(r.previous_from, '2026-08-07');
    assert.equal(r.previous_to, '2026-09-03');
    assert.equal(r.site, 'sc-domain:siroya.com');
    assert.deepEqual(r.totals, { clicks: 120, impressions: 3000, ctr: 0.04, position: 8.254 }, 'sent unrounded; the admin rounds once');
    assert.deepEqual(r.previous, { clicks: 80, impressions: 2500, ctr: 0.032, position: 9.5 });
    assert.equal(r.daily.length, 28);
    assert.equal(r.daily[0].date, '2026-09-04');
    assert.equal(r.daily[27].date, '2026-10-01');
    assert.deepEqual(r.daily.find(d => d.date === '2026-09-30'), { date: '2026-09-30', clicks: 5, impressions: 50, ctr: 0.1, position: 7.5 });
    assert.deepEqual(r.daily.find(d => d.date === '2026-09-10'), { date: '2026-09-10', clicks: 0, impressions: 0, ctr: 0, position: 0 });
    assert.equal(r.queries.length, 50);
    assert.deepEqual(r.queries[0], { query: 'gold ring 0', clicks: 60, impressions: 600, ctr: 0.1, position: 3 });
    assert.equal(r.pages.length, 3);
    assert.equal(r.pages[0].page, 'https://siroya.com/');
    assert.deepEqual(r.devices.map(d => d.device), ['mobile', 'desktop']);
    assert.deepEqual(r.countries.map(c => c.country), ['ARE', 'IND']);
    assert.equal(r.fetched_at, new Date(BASE).toISOString());
    assert.equal(r.cached, false);
    assert.equal(mock.state.hits.gsc, 7);
    for (const { site, body } of mock.state.gscBodies) {
      assert.equal(site, 'sc-domain:siroya.com');
      assert.equal(body.dataState, 'all');
      assert.equal(body.type, 'web');
    }
    assert.equal(mock.state.gscBodies.find(b => b.body.dimensions[0] === 'query').body.rowLimit, 50);
    assert.equal(mock.state.gscBodies.find(b => b.body.dimensions[0] === 'page').body.rowLimit, 25);
    assert.equal(mock.state.hits.token, 1, 'the access token is reused');
    const st = client.status();
    assert.equal(st.last_sync, new Date(BASE).toISOString());
    assert.equal(st.last_error, '');
  });

  it('caches for 6 hours and throttles refresh to once per 5 minutes', async () => {
    const hits = mock.state.hits.gsc;
    const second = keep(await client.searchReport(28));
    assert.equal(second.cached, true);
    assert.equal(mock.state.hits.gsc, hits, 'second call must not hit Google');

    clock += 60 * 1000;
    const throttled = keep(await client.searchReport(28, { refresh: true }));
    assert.equal(throttled.cached, true);
    assert.equal(throttled.throttled, true);
    assert.equal(mock.state.hits.gsc, hits, 'refresh within 5 minutes must not hit Google');

    clock += 4 * 60 * 1000 + 1000;
    const refreshed = keep(await client.searchReport(28, { refresh: true }));
    assert.equal(refreshed.cached, false);
    assert.equal(mock.state.hits.gsc, hits + 7);
    assert.equal(refreshed.fetched_at, new Date(clock).toISOString());

    clock += 3 * 3600 * 1000;
    const stillCached = await client.searchReport(28);
    assert.equal(stillCached.cached, true);
    assert.equal(mock.state.hits.gsc, hits + 7);
    assert.equal(mock.state.hits.token, 1);
  });

  it('gets a new access token after the old one expires', async () => {
    clock += 60 * 1000; // > 3600 s - 60 s since the first token
    const r = keep(await client.searchReport(7));
    assert.equal(r.daily.length, 7);
    assert.equal(mock.state.hits.token, 2);
  });

  it('serves the settings copy of the cache after a restart', async () => {
    const restarted = G.createGoogleClient({ getSetting: settings.getSetting, setSetting: settings.setSetting, now });
    const hits = mock.state.hits.gsc;
    const r = keep(await restarted.searchReport(28));
    assert.equal(r.cached, true);
    assert.equal(mock.state.hits.gsc, hits);
    const persisted = settings.map.get('google_cache');
    assert.ok(persisted.includes('gold ring 0'));
    assert.ok(!persisted.includes('PRIVATE KEY'));
  });

  it('analyticsReport returns the documented GA4 shape', async () => {
    const r = keep(await client.analyticsReport(30));
    assert.equal(r.range, 30);
    assert.equal(r.from, '2026-09-02');
    assert.equal(r.to, '2026-10-01');
    assert.equal(r.property, '123456');
    assert.deepEqual(r.totals, { activeUsers: 1200, newUsers: 900, sessions: 1500, engagementRate: 0.612345, averageSessionDuration: 75.3456 });
    assert.deepEqual(r.previous, { activeUsers: 1000, newUsers: 800, sessions: 1300, engagementRate: 0.55, averageSessionDuration: 70 });
    assert.equal(r.daily.length, 30);
    assert.deepEqual(r.daily.find(d => d.date === '2026-09-30'), { date: '2026-09-30', activeUsers: 40, sessions: 50 });
    assert.deepEqual(r.daily[0], { date: '2026-09-02', activeUsers: 0, sessions: 0 });
    assert.deepEqual(r.channels, [
      { channel: 'Organic Search', sessions: 900, users: 700 },
      { channel: 'Direct', sessions: 300, users: 250 },
      { channel: 'Organic Social', sessions: 120, users: 100 },
    ]);
    assert.deepEqual(r.landing_pages, [{ page: '/', sessions: 800 }, { page: '/product.html', sessions: 300 }]);
    assert.equal(r.cached, false);
    const hits = mock.state.hits.ga4;
    assert.equal((await client.analyticsReport(30)).cached, true);
    assert.equal(mock.state.hits.ga4, hits);
    await expectReject(client.analyticsReport(28), err => err.status === 400);
  });

  it('retries once with a new token when Google answers 401', async () => {
    mock.state.rejectTokensOnce = true;
    const tokens = mock.state.hits.token;
    const r = keep(await client.analyticsReport(7));
    assert.equal(r.range, 7);
    assert.equal(mock.state.hits.token, tokens + 1);
  });

  it('serves stale data with an error when Google is down', async () => {
    clock += 6 * 3600 * 1000 + 60 * 1000; // past the 6 h cache
    mock.state.failGsc = 503;
    try {
      const r = keep(await client.searchReport(28));
      assert.equal(r.stale, true);
      assert.equal(r.cached, true);
      assert.match(r.error, /Google is having trouble right now \(HTTP 503\)/);
      assert.equal(r.totals.clicks, 120);
      assert.match(client.status().last_error, /HTTP 503/);
      await expectReject(client.searchReport(90), err => err.status === 502 && err.data.code === 'google_unavailable');
    } finally {
      mock.state.failGsc = 0;
    }
  });

  it('turns a Search Console 403 into a friendly message', async () => {
    client.save({ gsc_site: 'sc-domain:noaccess.com' });
    await expectReject(client.searchReport(7), err => {
      assert.equal(err.status, 502);
      assert.equal(err.data.code, 'google_permission');
      assert.equal(err.message, `The service account has no access to sc-domain:noaccess.com. Add ${CLIENT_EMAIL} as a user in Search Console (Settings > Users and permissions; Restricted is enough).`);
      return true;
    });
    assert.match(client.status().last_error, /no access to sc-domain:noaccess\.com/);
    const t = keep(await client.test());
    assert.equal(t.ok, false);
    assert.equal(t.gsc_ok, false);
    assert.equal(t.ga4_ok, true);
    assert.match(t.error, new RegExp(`Add ${CLIENT_EMAIL.replace(/[.]/g, '\\.')} as a user in Search Console`));
    client.save({ gsc_site: 'sc-domain:siroya.com' });
  });

  it('turns GA4 403 / 404 / disabled API into friendly messages', async () => {
    client.save({ ga4_property: '999' });
    await expectReject(client.analyticsReport(7), err => err.status === 502 && err.data.code === 'google_permission'
      && err.message.includes(`Add ${CLIENT_EMAIL} as a Viewer in Google Analytics`) && err.message.includes('GA4 property 999'));
    client.save({ ga4_property: '404' });
    await expectReject(client.analyticsReport(7), err => err.data.code === 'google_not_found' && /GA4 property 404 was not found/.test(err.message));
    client.save({ ga4_property: '555' });
    await expectReject(client.analyticsReport(7), err => err.data.code === 'google_api_disabled' && /enable "Google Analytics Data API"/.test(err.message));
    client.save({ ga4_property: '123456' });
  });

  it('times out slow Google requests', async () => {
    const quick = G.createGoogleClient({ getSetting: settings.getSetting, setSetting: settings.setSetting, now, timeoutMs: 300 });
    quick.save({ ga4_property: '777' });
    const started = Date.now();
    await expectReject(quick.analyticsReport(7), err => err.status === 504 && err.data.code === 'google_timeout');
    assert.ok(Date.now() - started < 5000);
    quick.save({ ga4_property: '123456' });
  });

  it('reports a key Google rejects (bad signature) without throwing from test()', async () => {
    const other = memorySettings();
    const wrong = G.createGoogleClient({ getSetting: other.getSetting, setSetting: other.setSetting, now });
    wrong.save({ service_account_json: serviceAccount(OTHER_KEYS.privateKey), gsc_site: 'sc-domain:siroya.com' });
    const r = keep(await wrong.test());
    assert.equal(r.ok, false);
    assert.match(r.error, /rejected the key signature/);
    await expectReject(wrong.searchReport(7), err => err.status === 502 && err.data.code === 'google_auth');
  });

  it('disconnect wipes the key, token and cached data', async () => {
    const st = keep(client.disconnect());
    assert.equal(st.connected, false);
    assert.equal(st.client_email, '');
    assert.equal(st.gsc_site, 'sc-domain:siroya.com');
    const stored = settings.getSetting('google');
    assert.ok(!('private_key' in stored));
    assert.deepEqual(settings.getSetting('google_cache'), {});
    await expectReject(client.searchReport(28), err => err.status === 409 && err.data.code === 'not_connected');
  });

  it('never exposed the private key in any output, error or log', () => {
    assert.ok(outputs.length > 10);
    for (const text of [...outputs, ...logs]) {
      assert.ok(!text.includes('PRIVATE KEY'), text.slice(0, 200));
      assert.ok(!text.includes(KEY_FRAGMENT), text.slice(0, 200));
      assert.ok(!text.includes('"private_key"'), text.slice(0, 200));
    }
  });
});

/* ======================================================================
   Review fixes: input hardening, write caps, rollups, beacon hardening,
   Google key at rest and date windows
   ====================================================================== */

describe('analytics: input hardening', () => {
  let db;
  before(() => { db = freshDb(); });
  after(() => db.close());
  const meta = { ua: UA.desktop, host: 'siroya.com', now: BASE };
  const last = () => db.stmt('SELECT * FROM events ORDER BY id DESC LIMIT 1').get();
  const sid = 'aaaabbbbccccdddd';

  it('rebuilds the path: a page name plus one slug-checked ?p= or ?c=', () => {
    const cases = [
      ['/', '/'],
      ['/index.html', '/'],
      ['/About.html', '/about.html'],
      ['/collection.html?c=sanskriti', '/collection.html?c=sanskriti'],
      ['/product.html?p=rose-ring&utm_source=x', '/product.html?p=rose-ring'],
      ['/collection.html?q=1', '/collection.html'],
      ['https://evil.example/collection.html?c=sanskriti', ''],
      ['http://siroya.com/', ''],
      ['//evil.example/x.html', ''],
      ['/\\evil.example', ''],
      ['/a/b.html', ''],
      ['/x.php', ''],
      ['javascript:alert(1)', ''],
      [`/${'x'.repeat(500)}`, ''],
      ['/collection.html?c=jane.doe@example.com', '/collection.html'],
      ['/collection.html?c=jane.doe%40example.com', '/collection.html'],
      ['/?c=jane.doe@example.com', '/'],
      ['/product.html?p=0501234567', '/product.html'],
      ['/collection.html?c=%E2%80%AEevil', '/collection.html'],
      ['/collection.html?c=%ZZ', '/collection.html'],
      [42, ''],
      [{ p: '/' }, ''],
    ];
    for (const [input, expected] of cases) assert.equal(A.cleanPath(input), expected, JSON.stringify(input));
  });

  it('never stores another site as a page path', () => {
    A.recordEvent(db, { t: 'page_view', sid, p: 'https://evil.example/collection.html?c=sanskriti' }, meta);
    assert.equal(last().path, '');
  });

  it('removes bidi overrides and zero-width characters', () => {
    A.recordEvent(db, { t: 'page_view', sid, cmp: 'summer‮gnp.exe', src: 'insta​gram' }, meta);
    const row = last();
    assert.equal(row.campaign, 'summergnp.exe');
    assert.equal(row.source, 'instagram');
  });

  it('removes e-mail addresses and long digit runs from free text', () => {
    A.recordEvent(db, { t: 'page_view', sid, cmp: 'jane.doe@example.com', p: '/?c=jane.doe@example.com' }, meta);
    let row = last();
    assert.equal(row.campaign, '[hidden]');
    assert.equal(row.path, '/');
    A.recordEvent(db, { t: 'page_view', sid, cmp: 'promo-0501234567 spring', med: 'email jane@example.com' }, meta);
    row = last();
    assert.equal(row.campaign, 'promo-[hidden] spring');
    assert.ok(!row.medium.includes('@'));
    A.recordEvent(db, { t: 'view_item', sid, i: 'jane@example.com', c: '1234567', k: 'rings' }, meta);
    row = last();
    assert.equal(row.item, '');
    assert.equal(row.collection, '');
    assert.equal(row.category, 'rings');
    A.recordEvent(db, { t: 'page_view', sid, src: 'jane@example.com' }, meta);
    assert.equal(last().source, 'direct', 'a personal utm_source is not used as the source name');
  });

  it('keeps product codes and names as items, slugs as collections and categories', () => {
    A.recordEvent(db, { t: 'view_item', sid, i: 'SJ-SAN-1040', c: 'sanskriti', k: 'necklaces', pt: 'product' }, meta);
    let row = last();
    assert.deepEqual([row.item, row.collection, row.category, row.page_type], ['SJ-SAN-1040', 'sanskriti', 'necklaces', 'product']);
    A.recordEvent(db, { t: 'view_item', sid, i: 'Rose Ring', c: 'bridal line', pt: 'pro duct' }, meta);
    row = last();
    assert.deepEqual([row.item, row.collection, row.page_type], ['Rose Ring', '', '']);
  });

  it('never uses a built-in object property name as a source', () => {
    for (const src of ['constructor', '__proto__', 'toString', 'hasOwnProperty', 'prototype', 'valueOf', '__defineGetter__']) {
      assert.equal(A.deriveSource({ source: src }), 'direct', src);
      assert.equal(A.deriveSource({ source: src, refHost: 'www.google.com' }), 'google_organic', src);
      A.recordEvent(db, { t: 'page_view', sid, src }, meta);
      assert.equal(last().source, 'direct', src);
    }
    assert.equal(A.deriveSource({ source: 'IG_Story' }), 'ig_story');
    assert.equal(A.deriveSource({ source: 'x'.repeat(61), refHost: 'box.com' }), 'referral');
    assert.equal(A.deriveSource({ source: '<b>hi</b>' }), 'direct');
  });
});

describe('analytics: write caps', () => {
  it('stores at most 300 events per session per day', () => {
    const db = freshDb();
    const meta = { ua: UA.desktop, host: 'siroya.com', now: BASE };
    const sid = '1111222233334444';
    assert.equal(A.MAX_EVENTS_PER_SESSION_DAY, 300);
    for (let i = 0; i < 300; i++) assert.equal(A.recordEvent(db, { t: 'page_view', sid, p: '/' }, meta).ok, true);
    assert.deepEqual(A.recordEvent(db, { t: 'page_view', sid, p: '/' }, meta), { ok: false, reason: 'session_cap' });
    assert.equal(A.recordEvent(db, { t: 'page_view', sid: '5555666677778888' }, meta).ok, true, 'another session is not affected');
    assert.equal(A.recordEvent(db, { t: 'page_view', sid }, { ...meta, now: BASE + DAY }).ok, true, 'the next day starts again');
    assert.equal(db.stmt('SELECT COUNT(*) AS n FROM events WHERE sid = ?').get(sid).n, 301);
    db.close();
  });

  it('caps the whole site per Dubai day, counting from the database after a restart', () => {
    const db = freshDb();
    assert.equal(A.MAX_EVENTS_PER_DAY, 50000);
    const meta = { ua: UA.desktop, host: 'siroya.com', now: BASE };
    const rec = A.createEventRecorder(db, { maxPerDay: 5 });
    const sidN = i => crypto.createHash('md5').update(String(i)).digest('hex').slice(0, 16);
    assert.equal(rec.record({ t: 'nope', sid: sidN(0) }, meta).reason, 'invalid_type', 'dropped events do not count');
    for (let i = 0; i < 5; i++) assert.equal(rec.record({ t: 'page_view', sid: sidN(i) }, meta).ok, true);
    assert.deepEqual(rec.record({ t: 'page_view', sid: sidN(9) }, meta), { ok: false, reason: 'daily_cap' });
    assert.equal(rec.count(), 5);
    const restarted = A.createEventRecorder(db, { maxPerDay: 5 });
    assert.equal(restarted.record({ t: 'page_view', sid: sidN(9) }, meta).reason, 'daily_cap');
    assert.equal(restarted.record({ t: 'page_view', sid: sidN(9) }, { ...meta, now: BASE + DAY }).ok, true, 'the next Dubai day starts again');
    assert.equal(db.stmt('SELECT COUNT(*) AS n FROM events').get().n, 6);
    db.close();
  });
});

describe('analytics: daily rollups', () => {
  const meta = d => ({ ua: UA.desktop, host: 'siroya.com', now: BASE + d * DAY });

  it('reports from rollups, not from the raw events of closed days', () => {
    const db = freshDb();
    A.recordEvent(db, { t: 'page_view', sid: '0123456789abcdef', p: '/' }, meta(-1));
    A.recordEvent(db, { t: 'whatsapp_click', sid: '0123456789abcdef' }, meta(-1));
    const first = A.trafficReport(db, 7, { now: BASE });
    assert.equal(first.to, '2026-10-01');
    assert.deepEqual(first.totals, { visitors: 1, page_views: 1, whatsapp_clicks: 1, leads: 0, conversion_rate: 1 });
    // The raw rows of a closed day are no longer read once its rollup exists.
    db.raw.exec("DELETE FROM events WHERE day = '2026-10-01'");
    const second = A.trafficReport(db, 7, { now: BASE });
    assert.deepEqual(second.totals, first.totals);
    assert.deepEqual(second.top_pages, [{ path: '/', views: 1, visitors: 1 }]);
    assert.equal(A.missingDays(db, '2026-09-18', '2026-10-01').length, 0, 'every day of both periods is rolled up');
    db.close();
  });

  it('rebuilds a day when a late event lands on it', () => {
    const db = freshDb();
    A.recordEvent(db, { t: 'page_view', sid: '0123456789abcdef', p: '/' }, meta(-1));
    assert.equal(A.trafficReport(db, 7, { now: BASE }).totals.page_views, 1);
    A.recordEvent(db, { t: 'page_view', sid: '0123456789abcdef', p: '/about.html' }, meta(-1));
    const r = A.trafficReport(db, 7, { now: BASE });
    assert.equal(r.totals.page_views, 2);
    assert.equal(r.top_pages.length, 2);
    db.close();
  });

  it('shows today separately, live', () => {
    const db = freshDb();
    A.recordEvent(db, { t: 'page_view', sid: '0123456789abcdef', p: '/' }, meta(0));
    A.recordEvent(db, { t: 'whatsapp_click', sid: '0123456789abcdef' }, meta(0));
    A.recordEvent(db, { t: 'page_view', sid: 'fedcba9876543210', p: '/' }, meta(0));
    insertLead(db, new Date(BASE).toISOString());
    const r = A.trafficReport(db, 7, { now: BASE });
    assert.equal(r.totals.visitors, 0, 'today is not a complete day yet');
    assert.deepEqual(r.today, { day: '2026-10-02', visitors: 2, page_views: 2, whatsapp_clicks: 1, leads: 1 });
    assert.equal(A.missingDays(db, '2026-10-02', '2026-10-02').length, 1, 'today is never rolled up');
    db.close();
  });

  it('keeps at most 200 keys per dimension per day', () => {
    const db = freshDb();
    for (let i = 0; i < 230; i++) A.recordEvent(db, { t: 'page_view', sid: crypto.randomBytes(8).toString('hex'), p: `/p${i}.html` }, meta(-1));
    A.trafficReport(db, 7, { now: BASE });
    const kept = db.stmt("SELECT COUNT(*) AS n FROM events_daily_dim WHERE dim = 'page' AND day = '2026-10-01'").get().n;
    assert.equal(kept, 200);
    assert.equal(A.trafficReport(db, 7, { now: BASE }).totals.page_views, 230, 'totals still count every event');
    db.close();
  });

  it('builds the missing rollups at start-up without waiting for other activity', async () => {
    const db = freshDb();
    A.recordEvent(db, { t: 'page_view', sid: '0123456789abcdef', p: '/' }, { ua: UA.desktop, now: Date.now() - DAY });
    const registered = registerTraffic(new Router(), { db, env: {} });
    try {
      const started = Date.now();
      // Only a slow timer wakes the loop here: the maintenance chain must drive itself
      // (unref'd immediates would advance one day per wake-up, far too slow).
      while (db.stmt('SELECT COUNT(*) AS n FROM events_daily').get().n < 180 && Date.now() - started < 3000) {
        await new Promise(resolve => setTimeout(resolve, 50));
      }
      assert.equal(db.stmt('SELECT COUNT(*) AS n FROM events_daily').get().n, 180);
      const y = A.addDays(A.dubaiDay(Date.now()), -1);
      assert.equal(db.stmt('SELECT page_views FROM events_daily WHERE day = ?').get(y).page_views, 1);
    } finally {
      registered.stop();
      db.close();
    }
  });

  it('purges rollups with the events after 400 days', () => {
    const db = freshDb();
    A.recordEvent(db, { t: 'page_view', sid: '0123456789abcdef', p: '/' }, meta(-395));
    A.trafficReport(db, 90, { now: BASE - 300 * DAY });
    assert.ok(db.stmt('SELECT COUNT(*) AS n FROM events_daily').get().n > 0);
    A.purgeOld(db, { now: BASE + 10 * DAY });
    assert.equal(db.stmt('SELECT COUNT(*) AS n FROM events').get().n, 0);
    assert.equal(db.stmt("SELECT COUNT(*) AS n FROM events_daily WHERE day < '2025-09-07'").get().n, 0);
    assert.equal(db.stmt("SELECT COUNT(*) AS n FROM events_daily_dim WHERE day < '2025-09-07'").get().n, 0);
    db.close();
  });
});

describe('api: beacon hardening', () => {
  const started = [];
  async function start({ env = {}, perIp = 3, global = 100, beaconPatch = true } = {}) {
    const db = freshDb();
    const router = new Router();
    const registered = registerTraffic(router, {
      db, env, purge: false,
      trackLimiter: createLimiter({ limit: perIp, windowMs: 60000 }),
      globalLimiter: createLimiter({ limit: global, windowMs: 60000 }),
    });
    const server = http.createServer(apiHarness(router, { isAuthed: () => true, beaconPatch }));
    const port = await listenInRange(server);
    const ctx = { db, port, registered, server, count: () => db.stmt('SELECT COUNT(*) AS n FROM events').get().n };
    started.push(ctx);
    return ctx;
  }
  after(async () => {
    for (const c of started) { c.registered.stop(); await closeServer(c.server); c.db.close(); }
  });
  const beacon = (port, headers = {}, body = { t: 'page_view', sid: crypto.randomBytes(8).toString('hex'), p: '/' }) => request(port, 'POST', '/api/track', {
    body, headers: { 'Content-Type': 'text/plain;charset=UTF-8', 'User-Agent': UA.desktop, Host: 'siroya.com', ...headers },
  });

  it('buckets addresses: IPv4, IPv4-mapped, IPv6 /64, ports and brackets', () => {
    assert.equal(T.ipBucket('203.0.113.7'), '203.0.113.7');
    assert.equal(T.ipBucket('::ffff:203.0.113.7'), '203.0.113.7');
    assert.equal(T.ipBucket('203.0.113.7:5678'), '203.0.113.7');
    assert.equal(T.ipBucket('2001:db8:1:2:3:4:5:6'), '2001:db8:1:2::/64');
    assert.equal(T.ipBucket('2001:db8:1:2::9'), '2001:db8:1:2::/64');
    assert.equal(T.ipBucket('[2001:DB8::1]:443'), '2001:db8:0:0::/64');
    assert.equal(T.ipBucket('fe80::1%eth0'), 'fe80:0:0:0::/64');
    assert.equal(T.ipBucket(''), 'unknown');
  });

  it('takes the client address from the trusted end of X-Forwarded-For', () => {
    const req = (xff, remote = '10.0.0.2') => ({ headers: { 'x-forwarded-for': xff }, socket: { remoteAddress: remote } });
    assert.equal(T.clientAddress(req('1.1.1.1, 2.2.2.2, 3.3.3.3'), false), '10.0.0.2', 'ignored without TRUST_PROXY');
    assert.equal(T.clientAddress(req('1.1.1.1, 2.2.2.2, 3.3.3.3'), true), '3.3.3.3');
    assert.equal(T.clientAddress(req('1.1.1.1, 2.2.2.2, 3.3.3.3'), true, 2), '2.2.2.2');
    assert.equal(T.clientAddress(req('1.1.1.1'), true, 5), '1.1.1.1');
    assert.equal(T.clientAddress(req(''), true), '10.0.0.2');
  });

  it('a spoofed X-Forwarded-For does not buy a fresh rate limit', async () => {
    const c = await start({ env: { TRUST_PROXY: true }, perIp: 3 });
    for (let i = 0; i < 6; i++) {
      const res = await beacon(c.port, { 'X-Forwarded-For': `${crypto.randomInt(1, 223)}.${crypto.randomInt(255)}.0.${i}, 203.0.113.7` });
      assert.equal(res.status, 204);
    }
    assert.equal(c.count(), 3, 'all six came through one proxy hop from 203.0.113.7');
    await beacon(c.port, { 'X-Forwarded-For': '2001:db8:1:2::1' });
    await beacon(c.port, { 'X-Forwarded-For': '2001:db8:1:2:aaaa::2' });
    await beacon(c.port, { 'X-Forwarded-For': '2001:db8:1:2:bbbb::3' });
    await beacon(c.port, { 'X-Forwarded-For': '2001:db8:1:2:cccc::4' });
    assert.equal(c.count(), 6, 'one IPv6 /64 is one client');
  });

  it('caps the whole site per minute', async () => {
    const c = await start({ env: { TRUST_PROXY: true }, perIp: 100, global: 5 });
    for (let i = 0; i < 9; i++) await beacon(c.port, { 'X-Forwarded-For': `198.51.100.${i}` });
    assert.equal(c.count(), 5);
  });

  it('stores nothing with Do Not Track or Global Privacy Control', async () => {
    const c = await start();
    assert.equal((await beacon(c.port, { DNT: '1' })).status, 204);
    assert.equal((await beacon(c.port, { 'Sec-GPC': '1' })).status, 204);
    assert.equal(c.count(), 0);
    await beacon(c.port, { DNT: '0' });
    assert.equal(c.count(), 1);
  });

  it('refuses beacons posted from other sites', async () => {
    const c = await start({ perIp: 100 });
    for (const origin of ['https://evil.example', 'null', 'https://siroya.com.evil.example', 'not a url']) {
      assert.equal((await beacon(c.port, { Origin: origin, Referer: 'https://evil.example/page' })).status, 204, origin);
    }
    assert.equal(c.count(), 0);
    await beacon(c.port, { Origin: 'https://siroya.com' });
    await beacon(c.port, { Origin: 'https://www.siroya.com', Host: 'siroya.com:5173' });
    await beacon(c.port, {});
    assert.equal(c.count(), 3, 'own origin (www or not, any port) and no Origin at all are accepted');
  });

  it('behind a trusted proxy that rewrites Host, X-Forwarded-Host names the site', async () => {
    const proxied = { Origin: 'https://siroya.com', Host: '127.0.0.1:5173', 'X-Forwarded-Host': 'siroya.com', 'X-Forwarded-For': '203.0.113.9' };
    const off = await start({ perIp: 100 });
    await beacon(off.port, proxied);
    assert.equal(off.count(), 0, 'X-Forwarded-Host is not trusted without TRUST_PROXY');
    const on = await start({ env: { TRUST_PROXY: true }, perIp: 100 });
    await beacon(on.port, proxied);
    await beacon(on.port, { ...proxied, Referer: 'https://siroya.com/' }, { t: 'page_view', sid: '0123456789abcdef', p: '/', ref: 'siroya.com' });
    assert.equal(on.count(), 2);
    assert.equal(on.db.stmt('SELECT source FROM events ORDER BY id DESC LIMIT 1').get().source, 'direct', 'own host via X-Forwarded-Host');
  });

  it('answers junk with 204 once server.js honours beacon: true (413 stays)', async () => {
    const c = await start({ perIp: 100 });
    for (const [body, type] of [['{not json', 'text/plain'], ['[1]', 'text/plain'], ['t=page_view', 'application/x-www-form-urlencoded'], ['{"t":"page_view"}', 'image/png']]) {
      const res = await request(c.port, 'POST', '/api/track', { body, headers: { 'Content-Type': type, 'User-Agent': UA.desktop, Host: 'siroya.com' } });
      assert.equal(res.status, 204, `${type} ${body}`);
      assert.equal(res.text, '');
    }
    const big = await beacon(c.port, {}, JSON.stringify({ t: 'page_view', sid: '0123456789abcdef', p: 'x'.repeat(5000) }));
    assert.equal(big.status, 413);
    assert.equal(c.count(), 0);
  });

  it('caches the report for a minute and starts a new one on a new day', async () => {
    const c = await start();
    const a = await request(c.port, 'GET', '/api/admin/traffic?range=7');
    await beacon(c.port);
    const b = await request(c.port, 'GET', '/api/admin/traffic?range=7');
    assert.equal(b.data.generated_at, a.data.generated_at);
    assert.equal(b.data.today.page_views, a.data.today.page_views, 'served from the one-minute cache');
    const t = Date.parse(a.data.generated_at);
    assert.notEqual(c.registered.report(7, t + 61 * 1000).generated_at, a.data.generated_at, 'recomputed after a minute');
    assert.equal(c.registered.report(7, t + 61 * 1000).today.page_views, a.data.today.page_views + 1);
  });

  it('removes the Google key from the database files on disconnect (plain key, WAL)', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'siroya-traffic-'));
    const file = path.join(dir, 'wipe.db');
    const fragment = KEYS.privateKey.split('\n')[7];
    try {
      const db = quietly(() => { const d = openDb(file); d.migrate(); return d; });
      const registered = registerTraffic(new Router(), { db, env: {}, purge: false });
      registered.google.save({ service_account_json: JSON.stringify(serviceAccount()), gsc_site: 'sc-domain:siroya.com' });
      for (let i = 0; i < 5; i++) db.setSetting('google', { ...db.getSetting('google'), last_sync: new Date(BASE + i).toISOString() });
      const onDisk = () => ['', '-wal'].some(ext => fs.existsSync(file + ext) && fs.readFileSync(file + ext).includes(fragment));
      assert.equal(onDisk(), true, 'positive control: a plain key is on disk while connected');
      registered.google.disconnect();
      assert.equal(onDisk(), false, 'no copy left in the database file or the WAL');
      registered.stop();
      db.close();
      assert.equal(onDisk(), false);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('with SESSION_SECRET the key is only ever written encrypted', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'siroya-traffic-'));
    const file = path.join(dir, 'enc.db');
    const fragment = KEYS.privateKey.split('\n')[7];
    try {
      const db = quietly(() => { const d = openDb(file); d.migrate(); return d; });
      const registered = registerTraffic(new Router(), { db, env: { SESSION_SECRET: 'a'.repeat(64) }, purge: false });
      const st = registered.google.save({ service_account_json: JSON.stringify(serviceAccount()), gsc_site: 'sc-domain:siroya.com' });
      assert.equal(st.connected, true);
      const row = db.getSetting('google');
      assert.ok(!('private_key' in row));
      assert.match(row.private_key_enc, /^v1:/);
      for (const ext of ['', '-wal']) {
        if (fs.existsSync(file + ext)) assert.equal(fs.readFileSync(file + ext).includes(fragment), false, ext || 'db');
      }
      registered.stop();
      db.close();
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('google: key at rest, wipe and date windows', () => {
  let mock;
  let port;
  const original = { log: console.log, error: console.error, warn: console.warn };
  before(async () => {
    mock = createMockGoogle(KEYS.publicKey);
    port = await listenInRange(mock.server);
    process.env.GOOGLE_API_ORIGIN = `http://127.0.0.1:${port}`;
    for (const k of ['log', 'error', 'warn']) console[k] = () => {};
  });
  after(async () => {
    Object.assign(console, original);
    await closeServer(mock.server);
    delete process.env.GOOGLE_API_ORIGIN;
  });
  const SECRET = crypto.randomBytes(32).toString('hex');

  it('stores the private key encrypted when a secret is set, and still signs with it', async () => {
    const st = memorySettings();
    const client = G.createGoogleClient({ ...st, secret: SECRET, now: () => BASE });
    client.save({ service_account_json: JSON.stringify(serviceAccount()), gsc_site: 'sc-domain:siroya.com' });
    const raw = st.map.get('google');
    assert.ok(!raw.includes('PRIVATE KEY') && !raw.includes(KEY_FRAGMENT));
    assert.ok(!('private_key' in JSON.parse(raw)));
    const r = await client.test();
    assert.equal(r.ok, true, r.error);
    const enc = JSON.parse(st.map.get('google')).private_key_enc;
    await client.searchReport(7);
    assert.equal(JSON.parse(st.map.get('google')).private_key_enc, enc, 'no new ciphertext on every sync');

    const restarted = G.createGoogleClient({ ...st, secret: SECRET, now: () => BASE + 7 * 3600 * 1000 });
    assert.equal(restarted.status().connected, true);
    assert.equal((await restarted.searchReport(28)).cached, false);

    const otherSecret = G.createGoogleClient({ ...st, secret: crypto.randomBytes(32).toString('hex'), now: () => BASE });
    const s2 = otherSecret.status();
    assert.equal(s2.connected, false);
    assert.match(s2.last_error, /could not be read on this server/);
    await assert.rejects(otherSecret.searchReport(7), err => err.status === 409 && err.data.code === 'not_connected');
    otherSecret.save({ ga4_property: '123456' });
    assert.ok(JSON.parse(st.map.get('google')).private_key_enc, 'an unreadable key is kept until it is replaced or removed');
  });

  it('encrypts a key saved before the secret was set, and wipes after', () => {
    const st = memorySettings();
    G.createGoogleClient({ ...st, now: () => BASE }).save({ service_account_json: JSON.stringify(serviceAccount()) });
    assert.ok(st.map.get('google').includes('PRIVATE KEY'), 'no secret: stored as is');
    let wiped = 0;
    const client = G.createGoogleClient({ ...st, secret: SECRET, wipe: () => { wiped++; }, now: () => BASE });
    assert.ok(!st.map.get('google').includes('PRIVATE KEY'));
    assert.equal(wiped, 1);
    assert.equal(client.status().connected, true);
  });

  it('calls wipe when a key is replaced or removed, not for property changes', () => {
    const st = memorySettings();
    let wiped = 0;
    const client = G.createGoogleClient({ ...st, wipe: () => { wiped++; }, now: () => BASE });
    client.save({ service_account_json: JSON.stringify(serviceAccount()) });
    assert.equal(wiped, 0, 'first key: nothing old to scrub');
    client.save({ gsc_site: 'sc-domain:siroya.com', ga4_property: '123456' });
    assert.equal(wiped, 0);
    client.save({ service_account_json: JSON.stringify(serviceAccount()) });
    assert.equal(wiped, 0, 'the same key again is not a change');
    client.save({ service_account_json: JSON.stringify(serviceAccount(OTHER_KEYS.privateKey)) });
    assert.equal(wiped, 1);
    client.disconnect();
    assert.equal(wiped, 2);
    const thrower = G.createGoogleClient({ ...memorySettings(), wipe: () => { throw new Error('disk'); } });
    thrower.save({ service_account_json: JSON.stringify(serviceAccount()) });
    assert.equal(thrower.disconnect().connected, false, 'a failing wipe never blocks a disconnect');
  });

  it('treats a cached report for an older date window as expired', async () => {
    const st = memorySettings();
    let clock = Date.parse('2026-10-01T19:00:00Z'); // 23:00 in Dubai
    const client = G.createGoogleClient({ ...st, now: () => clock });
    client.save({ service_account_json: JSON.stringify(serviceAccount()), gsc_site: 'sc-domain:siroya.com' });
    const before = await client.searchReport(7);
    assert.equal(before.to, '2026-09-30');
    clock += 90 * 60 * 1000; // 00:30 in Dubai, the next day
    const after = await client.searchReport(7);
    assert.equal(after.cached, false);
    assert.equal(after.to, '2026-10-01');
    clock += 60 * 1000;
    assert.equal((await client.searchReport(7)).cached, true);

    clock += 24 * 3600 * 1000; // another day; Google is down: the old window comes back as stale data
    mock.state.failGsc = 503;
    try {
      const stale = await client.searchReport(7);
      assert.equal(stale.stale, true);
      assert.equal(stale.to, '2026-10-01');
      assert.match(stale.error, /HTTP 503/);
    } finally {
      mock.state.failGsc = 0;
    }
  });
});
