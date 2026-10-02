'use strict';
/* First-run seed: evaluates site/assets/js/data.js in a node:vm sandbox and
   imports window.SIROYA into an empty database, in one atomic batch. */
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { now } = require('./db');
const { SLUG_RE, slugify } = require('./validate');

function loadSiteData(siteDir) {
  const file = path.join(siteDir, 'assets', 'js', 'data.js');
  const code = fs.readFileSync(file, 'utf8');
  const sandbox = { window: {} };
  vm.createContext(sandbox);
  vm.runInContext(code, sandbox, { filename: 'data.js', timeout: 2000 });
  const S = sandbox.window.SIROYA;
  if (!S || typeof S !== 'object') throw new Error('data.js did not define window.SIROYA');
  // Round-trip through JSON so nothing from the vm realm leaks out.
  return JSON.parse(JSON.stringify(S));
}

const str = (v, max = 5000) => (v === null || v === undefined ? '' : String(v)).slice(0, max);
const arr = v => (Array.isArray(v) ? v : []);

function uniqueSlug(base, used, fallback) {
  let s = SLUG_RE.test(String(base || '')) ? String(base) : slugify(base);
  if (!s) s = fallback;
  let out = s;
  for (let i = 2; used.has(out); i++) out = `${s}-${i}`;
  used.add(out);
  return out;
}

async function isEmpty(db) {
  const counts = await Promise.all(['categories', 'collections', 'products', 'stores']
    .map(t => db.get(`SELECT COUNT(*) AS n FROM ${t}`)));
  return counts.every(r => Number(r.n) === 0);
}

/* Imports data.js into an empty database once. All inserts go in one atomic
   batch (one round trip on Turso). Concurrent cold starts are safe: the batch
   re-checks emptiness by failing on the UNIQUE slugs of a second import. */
async function seed(db, siteDir) {
  if (await db.getSetting('seeded_at', null)) return false;
  if (!(await isEmpty(db))) {
    await db.setSetting('seeded_at', now());
    return false;
  }
  let S;
  try {
    S = loadSiteData(siteDir);
  } catch (err) {
    console.warn(`Seed skipped: could not read site/assets/js/data.js (${err.message})`);
    return false;
  }
  const ts = now();
  const stmts = [];
  const setting = (key, value) => stmts.push({
    sql: 'INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value',
    args: [key, JSON.stringify(value)],
  });

  const site = S.site && typeof S.site === 'object' ? { ...S.site } : {};
  delete site.leadEndpoint;
  setting('site', site);

  const insCat = `INSERT INTO categories (slug, name, description, image, featured, sort, created_at, updated_at)
    VALUES (?, ?, ?, ?, 1, ?, ?, ?)`;
  const catSlugs = new Set();
  arr(S.categories).forEach((c, i) => {
    if (!c || !c.name) return;
    const slug = uniqueSlug(c.slug || c.name, catSlugs, `category-${i + 1}`);
    stmts.push({ sql: insCat, args: [slug, str(c.name, 120), str(c.description, 1000), str(c.img || c.image, 500), i, ts, ts] });
  });

  const insCol = `INSERT INTO collections (slug, name, kind, short, intro, hero, cover, quote, chapters, active, sort, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?, ?)`;
  const colSlugs = new Set();
  arr(S.collections).forEach((c, i) => {
    if (!c || !c.name) return;
    const slug = uniqueSlug(c.slug || c.name, colSlugs, `collection-${i + 1}`);
    const chapters = arr(c.chapters).map(ch => ({ title: str(ch && ch.title, 160), text: str(ch && ch.text, 3000), img: str(ch && (ch.img || ch.image), 500) }));
    stmts.push({ sql: insCol, args: [slug, str(c.name, 120), str(c.kind, 120), str(c.short, 300), str(c.intro, 3000), str(c.hero, 500), str(c.cover, 500),
      str(c.quote, 300), JSON.stringify(chapters), i, ts, ts] });
  });

  const insProd = `INSERT INTO products (handle, code, name, collection, category, metal, weight, stones, description, images, featured, status, sort, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'active', ?, ?, ?)`;
  const handles = new Set();
  arr(S.products).forEach((p, i) => {
    if (!p || !p.name) return;
    const handle = uniqueSlug(p.id || p.handle || p.name, handles, `product-${i + 1}`);
    const images = arr(p.images).map(x => str(x, 500)).filter(Boolean);
    stmts.push({ sql: insProd, args: [handle, str(p.code, 60), str(p.name, 160), str(p.collection, 80), str(p.category, 80), str(p.metal, 120),
      str(p.weight, 60), str(p.stones, 300), str(p.description, 5000), JSON.stringify(images), p.featured ? 1 : 0, i, ts, ts] });
  });

  const insStore = 'INSERT INTO stores (slug, name, address, hours, phone, map, image, sort) VALUES (?, ?, ?, ?, ?, ?, ?, ?)';
  const storeSlugs = new Set();
  arr(S.stores).forEach((s, i) => {
    if (!s || !s.name) return;
    const slug = uniqueSlug(s.slug || s.name, storeSlugs, `store-${i + 1}`);
    stmts.push({ sql: insStore, args: [slug, str(s.name, 120), str(s.address, 300), str(s.hours, 200), str(s.phone, 40), str(s.map, 500), str(s.img || s.image, 500), i] });
  });

  setting('seeded_at', ts);
  try {
    await db.batch(stmts);
  } catch (err) {
    // Another instance seeded first (UNIQUE slug clash): nothing to do.
    if (/UNIQUE constraint failed/.test(String(err && err.message))) return false;
    throw err;
  }
  const n = async t => (await db.get(`SELECT COUNT(*) AS n FROM ${t}`)).n;
  console.log(`Seeded from data.js: ${await n('categories')} categories, ${await n('collections')} collections, ${await n('products')} products, ${await n('stores')} stores`);
  return true;
}

module.exports = { seed, loadSiteData };
