'use strict';
/* Admin API (cookie auth). Categories, collections, stores, products, settings,
   uploads and leads. All SQL uses prepared statements; column names come only
   from the fixed definitions below, never from request data. */
const crypto = require('node:crypto');
const { HttpError, json, sendBuffer } = require('../http');
const V = require('../validate');
const { now } = require('../db');
const { toCsv } = require('../csv');
const { saveUpload } = require('../uploads');
const { presignUpload } = require('../storage');
const { siteObject } = require('./public');

const UPLOAD_LIMIT = 12 * 1024 * 1024;
const SORT_MIN = -1e6;
const SORT_MAX = 1e6;

/* Shared resources with the same five routes. `ref` is the products column
   that stores this resource's slug. */
const RESOURCES = {
  categories: {
    table: 'categories',
    label: 'Category',
    ref: 'category',
    timestamps: true,
    fields: {
      name: { type: 'text', max: 120 },
      description: { type: 'text', max: 1000, multiline: true },
      image: { type: 'image', alias: 'img' },
      featured: { type: 'bool' },
      sort: { type: 'int' },
    },
    defaults: { description: '', image: '', featured: 1 },
    out: r => ({
      id: r.id, slug: r.slug, name: r.name, description: r.description || '', image: r.image || '',
      featured: !!r.featured, sort: r.sort, created_at: r.created_at, updated_at: r.updated_at,
    }),
  },
  collections: {
    table: 'collections',
    label: 'Collection',
    ref: 'collection',
    timestamps: true,
    fields: {
      name: { type: 'text', max: 120 },
      kind: { type: 'text', max: 120 },
      short: { type: 'text', max: 300 },
      intro: { type: 'text', max: 3000, multiline: true },
      hero: { type: 'image' },
      cover: { type: 'image' },
      quote: { type: 'text', max: 300 },
      chapters: { type: 'chapters' },
      active: { type: 'bool' },
      sort: { type: 'int' },
    },
    defaults: { kind: '', short: '', intro: '', hero: '', cover: '', quote: '', chapters: '[]', active: 1 },
    out: r => ({
      id: r.id, slug: r.slug, name: r.name, kind: r.kind || '', short: r.short || '', intro: r.intro || '',
      hero: r.hero || '', cover: r.cover || '', quote: r.quote || '', chapters: V.safeJson(r.chapters, []),
      active: !!r.active, sort: r.sort, created_at: r.created_at, updated_at: r.updated_at,
    }),
  },
  stores: {
    table: 'stores',
    label: 'Store',
    ref: null,
    timestamps: false,
    fields: {
      name: { type: 'text', max: 120 },
      address: { type: 'text', max: 300, multiline: true },
      hours: { type: 'text', max: 200 },
      phone: { type: 'text', max: 40 },
      map: { type: 'url' },
      image: { type: 'image', alias: 'img' },
      sort: { type: 'int' },
    },
    defaults: { address: '', hours: '', phone: '', map: '', image: '' },
    out: r => ({
      id: r.id, slug: r.slug, name: r.name, address: r.address || '', hours: r.hours || '', phone: r.phone || '',
      map: r.map || '', image: r.image || '', sort: r.sort,
    }),
  },
};

const PRODUCT_FIELDS = {
  code: { type: 'text', max: 60 },
  name: { type: 'text', max: 160 },
  metal: { type: 'text', max: 120 },
  weight: { type: 'text', max: 60 },
  stones: { type: 'text', max: 300 },
  description: { type: 'text', max: 5000, multiline: true },
  images: { type: 'images' },
  featured: { type: 'bool' },
  status: { type: 'enum', values: ['active', 'draft', 'archived'] },
  sort: { type: 'int' },
};
const PRODUCT_DEFAULTS = {
  code: '', collection: '', category: '', metal: '', weight: '', stones: '', description: '', images: '[]', featured: 0, status: 'active',
};

const labelOf = key => key.charAt(0).toUpperCase() + key.slice(1);

function convert(field, value, label) {
  switch (field.type) {
    case 'text': return V.text(value, field.max, label, field.multiline);
    case 'image': return V.image(value, label);
    case 'url': return V.url(value, label);
    case 'bool': return V.bool(value, label);
    case 'int': return V.int(value, label, SORT_MIN, SORT_MAX);
    case 'enum': return V.oneOf(value, field.values, label);
    case 'chapters': return JSON.stringify(V.chapters(value));
    case 'images': return JSON.stringify(V.imageList(value));
    default: throw new Error(`Unknown field type ${field.type}`);
  }
}

/* Picks known fields present in the input; unknown fields are ignored. */
function pickFields(fields, input) {
  const out = {};
  for (const [key, field] of Object.entries(fields)) {
    let has = V.hasOwn(input, key);
    let value = input[key];
    if (!has && field.alias && V.hasOwn(input, field.alias)) {
      has = true;
      value = input[field.alias];
    }
    if (has) out[key] = convert(field, value, labelOf(key));
  }
  return out;
}

function registerAdmin(router, { db, auth, env, loginLimiter, siteDir, storage }) {
  const { stmt, tx } = db;

  /* ---------- helpers ---------- */

  async function slugTaken(table, column, value, selfId) {
    return !!(await stmt(`SELECT id FROM ${table} WHERE ${column} = ? AND id != ?`).get(value, selfId || 0));
  }

  /* Explicit slug: validated, 409 on clash. Blank: generated from the name
     and made unique with a numeric suffix. */
  async function resolveSlug(table, column, provided, name, selfId, label) {
    const given = V.slug(provided, label);
    if (given) {
      if (await slugTaken(table, column, given, selfId)) throw new HttpError(409, `${label} "${given}" is already in use`);
      return given;
    }
    const base = V.slugify(name) || `${table.replace(/s$/, '')}-${crypto.randomBytes(3).toString('hex')}`;
    let candidate = base;
    for (let i = 2; await slugTaken(table, column, candidate, selfId); i++) {
      const suffix = `-${i}`;
      candidate = `${base.slice(0, 80 - suffix.length).replace(/-+$/, '')}${suffix}`;
    }
    return candidate;
  }

  async function nextSort(table) {
    const row = await stmt(`SELECT MAX(sort) AS m FROM ${table}`).get();
    return row && row.m !== null ? Math.min(SORT_MAX, Number(row.m) + 1) : 0;
  }

  async function insertRow(table, values) {
    const cols = Object.keys(values);
    const sql = `INSERT INTO ${table} (${cols.join(', ')}) VALUES (${cols.map(() => '?').join(', ')})`;
    return Number((await stmt(sql).run(...cols.map(c => values[c]))).lastInsertRowid);
  }

  async function updateRow(table, id, values) {
    const cols = Object.keys(values);
    if (!cols.length) return;
    await stmt(`UPDATE ${table} SET ${cols.map(c => `${c} = ?`).join(', ')} WHERE id = ?`).run(...cols.map(c => values[c]), id);
  }

  async function productCounts(column) {
    const map = new Map();
    for (const r of await stmt(`SELECT ${column} AS slug, COUNT(*) AS n FROM products GROUP BY ${column}`).all()) map.set(r.slug, r.n);
    return map;
  }

  const isForce = query => /^(1|true|yes)$/i.test(query.get('force') || '');

  /* ---------- session ---------- */

  router.post('/api/admin/login', ({ req, res, body, ip }) => {
    const password = typeof body.password === 'string' ? body.password.slice(0, 500) : '';
    if (!password) throw new HttpError(400, 'Please enter the password');
    if (!auth.passwordMatches(password)) throw new HttpError(401, 'Incorrect password');
    loginLimiter.reset(ip);
    json(req, res, 200, { ok: true }, { 'Set-Cookie': auth.issueCookie(req) });
  }, { rateLimit: loginLimiter, rateLimitMessage: 'Too many login attempts. Please wait 15 minutes and try again.' });

  router.post('/api/admin/logout', ({ req, res }) => {
    json(req, res, 200, { ok: true }, { 'Set-Cookie': auth.clearCookie(req) });
  });

  router.get('/api/admin/me', ({ req }) => {
    if (!auth.isAuthed(req)) throw new HttpError(401, 'Not signed in');
    return { ok: true };
  });

  /* ---------- dashboard ---------- */

  router.get('/api/admin/stats', async () => {
    const products = { active: 0, draft: 0, archived: 0 };
    const since = new Date(Date.now() - 7 * 864e5).toISOString();
    const [statusRows, categories, collections, leadsTotal, leads7] = await Promise.all([
      stmt('SELECT status, COUNT(*) AS n FROM products GROUP BY status').all(),
      stmt('SELECT COUNT(*) AS n FROM categories').get(),
      stmt('SELECT COUNT(*) AS n FROM collections').get(),
      stmt('SELECT COUNT(*) AS n FROM leads').get(),
      stmt('SELECT COUNT(*) AS n FROM leads WHERE created_at >= ?').get(since),
    ]);
    for (const r of statusRows) {
      if (r.status in products) products[r.status] = r.n;
    }
    return {
      products,
      categories: categories.n,
      collections: collections.n,
      leads: { total: leadsTotal.n, last7: leads7.n },
    };
  }, { auth: true });

  /* ---------- categories / collections / stores ---------- */

  for (const [name, def] of Object.entries(RESOURCES)) {
    const base = `/api/admin/${name}`;
    const { table, label } = def;

    const withCount = async (row, counts) => {
      const item = def.out(row);
      if (def.ref) item.product_count = counts ? counts.get(row.slug) || 0 : (await stmt(`SELECT COUNT(*) AS n FROM products WHERE ${def.ref} = ?`).get(row.slug)).n;
      return item;
    };
    const listAll = async () => {
      const [counts, rows] = await Promise.all([
        def.ref ? productCounts(def.ref) : null,
        stmt(`SELECT * FROM ${table} ORDER BY sort, id`).all(),
      ]);
      return Promise.all(rows.map(r => withCount(r, counts)));
    };
    const getRow = async id => {
      const row = await stmt(`SELECT * FROM ${table} WHERE id = ?`).get(id);
      if (!row) throw new HttpError(404, `${label} not found`);
      return row;
    };

    router.get(base, async () => ({ items: await listAll() }), { auth: true });

    router.get(`${base}/:id`, async ({ params }) => withCount(await getRow(params.id)), { auth: true });

    router.post(base, async ({ req, res, body }) => {
      const values = pickFields(def.fields, body);
      if (!values.name) throw new HttpError(400, `${label} name is required`);
      const item = await tx(async () => {
        const record = { ...def.defaults, ...values };
        record.slug = await resolveSlug(table, 'slug', body.slug, values.name, 0, `${label} slug`);
        if (record.sort === undefined) record.sort = await nextSort(table);
        if (def.timestamps) record.created_at = record.updated_at = now();
        const id = await insertRow(table, record);
        return withCount(await getRow(id));
      });
      json(req, res, 201, item);
    }, { auth: true });

    router.put(`${base}/order`, async ({ body }) => {
      const ids = V.idList(body.ids);
      const ts = now();
      const sql = def.timestamps ? `UPDATE ${table} SET sort = ?, updated_at = ? WHERE id = ?` : `UPDATE ${table} SET sort = ? WHERE id = ?`;
      if (ids.length) await db.batch(ids.map((id, i) => ({ sql, args: def.timestamps ? [i, ts, id] : [i, id] })));
      return { ok: true, items: await listAll() };
    }, { auth: true });

    router.put(`${base}/:id`, ({ params, body }) => tx(async () => {
      const row = await getRow(params.id);
      const values = pickFields(def.fields, body);
      if (V.hasOwn(values, 'name') && !values.name) throw new HttpError(400, `${label} name is required`);
      if (V.hasOwn(body, 'slug')) {
        const slug = await resolveSlug(table, 'slug', body.slug, values.name || row.name, row.id, `${label} slug`);
        if (slug !== row.slug) values.slug = slug;
      }
      if (Object.keys(values).length && def.timestamps) values.updated_at = now();
      await updateRow(table, row.id, values);
      // Keep products pointing at the renamed slug.
      if (values.slug && def.ref) {
        await stmt(`UPDATE products SET ${def.ref} = ?, updated_at = ? WHERE ${def.ref} = ?`).run(values.slug, now(), row.slug);
      }
      return withCount(await getRow(row.id));
    }), { auth: true });

    router.delete(`${base}/:id`, ({ params, query }) => tx(async () => {
      const row = await getRow(params.id);
      let cleared = 0;
      if (def.ref) {
        const used = (await stmt(`SELECT COUNT(*) AS n FROM products WHERE ${def.ref} = ?`).get(row.slug)).n;
        if (used && !isForce(query)) {
          throw new HttpError(409, `${used} ${used === 1 ? 'product uses' : 'products use'} this ${label.toLowerCase()}. Delete anyway and ${used === 1 ? 'it' : 'they'} will have no ${label.toLowerCase()}.`, null, { products: used });
        }
        if (used) cleared = Number((await stmt(`UPDATE products SET ${def.ref} = '', updated_at = ? WHERE ${def.ref} = ?`).run(now(), row.slug)).changes);
      }
      await stmt(`DELETE FROM ${table} WHERE id = ?`).run(row.id);
      return { ok: true, cleared };
    }), { auth: true });
  }

  /* ---------- products ---------- */

  const productOut = r => ({
    id: r.id, handle: r.handle, code: r.code || '', name: r.name, collection: r.collection || '', category: r.category || '',
    metal: r.metal || '', weight: r.weight || '', stones: r.stones || '', description: r.description || '',
    images: V.safeJson(r.images, []), featured: !!r.featured, status: r.status, sort: r.sort,
    created_at: r.created_at, updated_at: r.updated_at,
  });
  const getProduct = async id => {
    const row = await stmt('SELECT * FROM products WHERE id = ?').get(id);
    if (!row) throw new HttpError(404, 'Product not found');
    return row;
  };

  /* Collection / category slug that must exist (or be blank). An unchanged
     current value is accepted as is. */
  async function refSlug(table, value, label, current) {
    const s = V.text(value, 80, label).toLowerCase();
    if (!s || s === current) return s;
    if (!await stmt(`SELECT 1 AS ok FROM ${table} WHERE slug = ?`).get(s)) throw new HttpError(400, `Unknown ${label.toLowerCase()} "${s}"`);
    return s;
  }

  async function productValues(body, row) {
    const values = pickFields(PRODUCT_FIELDS, body);
    if (V.hasOwn(body, 'collection')) values.collection = await refSlug('collections', body.collection, 'Collection', row && row.collection);
    if (V.hasOwn(body, 'category')) values.category = await refSlug('categories', body.category, 'Category', row && row.category);
    return values;
  }

  router.get('/api/admin/products', async ({ query }) => {
    const where = [];
    const params = [];
    const q = V.text(query.get('q'), 200, 'Search');
    if (q) {
      const like = `%${q.replace(/[\\%_]/g, m => `\\${m}`)}%`;
      where.push("(name LIKE ? ESCAPE '\\' OR code LIKE ? ESCAPE '\\' OR handle LIKE ? ESCAPE '\\' OR description LIKE ? ESCAPE '\\')");
      params.push(like, like, like, like);
    }
    for (const col of ['collection', 'category']) {
      const v = (query.get(col) || '').trim().toLowerCase();
      if (v === '_none') where.push(`${col} = ''`);
      else if (v) { where.push(`${col} = ?`); params.push(v); }
    }
    const status = (query.get('status') || '').trim().toLowerCase();
    if (['active', 'draft', 'archived'].includes(status)) { where.push('status = ?'); params.push(status); }
    const featured = (query.get('featured') || '').trim().toLowerCase();
    if (['1', 'true', 'yes'].includes(featured)) where.push('featured = 1');
    else if (['0', 'false', 'no'].includes(featured)) where.push('featured = 0');

    const per = Math.min(200, Math.max(1, parseInt(query.get('per'), 10) || 50));
    const page = Math.max(1, parseInt(query.get('page'), 10) || 1);
    const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';
    const [totalRow, rows] = await Promise.all([
      stmt(`SELECT COUNT(*) AS n FROM products ${whereSql}`).get(...params),
      stmt(`SELECT * FROM products ${whereSql} ORDER BY sort, id LIMIT ? OFFSET ?`).all(...params, per, (page - 1) * per),
    ]);
    const total = totalRow.n;
    const items = rows.map(productOut);
    return { items, total, page, per };
  }, { auth: true });

  router.get('/api/admin/products/:id', async ({ params }) => productOut(await getProduct(params.id)), { auth: true });

  router.post('/api/admin/products', async ({ req, res, body }) => {
    const item = await tx(async () => {
      const values = await productValues(body, null);
      if (!values.name) throw new HttpError(400, 'Product name is required');
      const record = { ...PRODUCT_DEFAULTS, ...values };
      record.handle = await resolveSlug('products', 'handle', body.handle, values.name, 0, 'Product handle');
      if (record.sort === undefined) record.sort = await nextSort('products');
      record.created_at = record.updated_at = now();
      return productOut(await getProduct(await insertRow('products', record)));
    });
    json(req, res, 201, item);
  }, { auth: true });

  router.post('/api/admin/products/bulk', async ({ body }) => {
    const ids = V.idList(body.ids);
    if (!ids.length) throw new HttpError(400, 'Select at least one product');
    const action = V.text(body.action, 40, 'Action');
    const ts = now();
    let sql;
    let extra = [];
    switch (action) {
      case 'activate': sql = "UPDATE products SET status = 'active', updated_at = ? WHERE id = ?"; break;
      case 'draft': sql = "UPDATE products SET status = 'draft', updated_at = ? WHERE id = ?"; break;
      case 'archive': sql = "UPDATE products SET status = 'archived', updated_at = ? WHERE id = ?"; break;
      case 'feature': sql = 'UPDATE products SET featured = 1, updated_at = ? WHERE id = ?'; break;
      case 'unfeature': sql = 'UPDATE products SET featured = 0, updated_at = ? WHERE id = ?'; break;
      case 'delete': sql = 'DELETE FROM products WHERE id = ?'; break;
      case 'set_category':
        extra = [await refSlug('categories', body.value, 'Category', null)];
        sql = 'UPDATE products SET category = ?, updated_at = ? WHERE id = ?';
        break;
      case 'set_collection':
        extra = [await refSlug('collections', body.value, 'Collection', null)];
        sql = 'UPDATE products SET collection = ?, updated_at = ? WHERE id = ?';
        break;
      default:
        throw new HttpError(400, 'Action must be one of: activate, draft, archive, delete, feature, unfeature, set_category, set_collection');
    }
    const results = await db.batch(ids.map(id => ({ sql, args: action === 'delete' ? [id] : [...extra, ts, id] })));
    const affected = results.reduce((n, rs) => n + Number(rs.rowsAffected || 0), 0);
    return { ok: true, affected };
  }, { auth: true });

  router.put('/api/admin/products/:id', ({ params, body }) => tx(async () => {
    const row = await getProduct(params.id);
    const values = await productValues(body, row);
    if (V.hasOwn(values, 'name') && !values.name) throw new HttpError(400, 'Product name is required');
    if (V.hasOwn(body, 'handle')) {
      const handle = await resolveSlug('products', 'handle', body.handle, values.name || row.name, row.id, 'Product handle');
      if (handle !== row.handle) values.handle = handle;
    }
    if (Object.keys(values).length) values.updated_at = now();
    await updateRow('products', row.id, values);
    return productOut(await getProduct(row.id));
  }), { auth: true });

  router.delete('/api/admin/products/:id', async ({ params }) => {
    const row = await getProduct(params.id);
    await stmt('DELETE FROM products WHERE id = ?').run(row.id);
    return { ok: true };
  }, { auth: true });

  /* ---------- settings ---------- */

  router.get('/api/admin/settings', () => siteObject(db, false), { auth: true });

  router.put('/api/admin/settings', ({ body }) => tx(async () => {
    const current = (await db.getSetting('site', {})) || {};
    const next = { ...current };
    delete next.leadEndpoint;
    if (V.hasOwn(body, 'name')) {
      next.name = V.text(body.name, 120, 'Name');
      if (!next.name) throw new HttpError(400, 'Site name is required');
    }
    if (V.hasOwn(body, 'tagline')) next.tagline = V.text(body.tagline, 160, 'Tagline');
    if (V.hasOwn(body, 'since')) next.since = body.since === '' || body.since === null ? '' : V.int(body.since, 'Since', 1800, 2100);
    if (V.hasOwn(body, 'whatsapp')) {
      const raw = V.text(body.whatsapp, 40, 'WhatsApp number');
      const digits = raw.replace(/[\s()+-]/g, '');
      if (digits && !/^\d{8,15}$/.test(digits)) throw new HttpError(400, 'WhatsApp number must be 8 to 15 digits, including the country code, with no plus sign');
      next.whatsapp = digits;
    }
    if (V.hasOwn(body, 'phone')) next.phone = V.text(body.phone, 40, 'Phone');
    if (V.hasOwn(body, 'email')) {
      const email = V.text(body.email, 200, 'Email');
      if (email && !/^[^\s@<>"']+@[^\s@<>"']+\.[^\s@<>"']+$/.test(email)) throw new HttpError(400, 'Email address looks incomplete');
      next.email = email;
    }
    if (V.hasOwn(body, 'socials')) {
      if (!body.socials || typeof body.socials !== 'object' || Array.isArray(body.socials)) throw new HttpError(400, 'Socials must be an object');
      const socials = { ...(current.socials && typeof current.socials === 'object' ? current.socials : {}) };
      for (const k of ['instagram', 'facebook', 'youtube']) {
        if (V.hasOwn(body.socials, k)) socials[k] = V.url(body.socials[k], labelOf(k));
      }
      next.socials = socials;
    }
    await db.setSetting('site', next);
    return siteObject(db, false);
  }), { auth: true });

  /* ---------- uploads ---------- */

  /* Image as a data URL in JSON. Local disk, or R2 (server-side PUT) when
     R2 is configured. On Vercel the admin uses /upload/presign instead, since
     a function body is capped at 4.5 MB. */
  router.post('/api/admin/upload', async ({ req, res, body }) => {
    const result = await saveUpload(siteDir, body.dataUrl, storage);
    json(req, res, 201, { url: result.url, bytes: result.bytes });
  }, { auth: true, limit: UPLOAD_LIMIT });

  /* Direct browser upload: { kind: image|video, type, size, filename }.
     R2: { method: 'PUT', uploadUrl, headers, url, key, expires_in }.
     Local disk: { method: 'LOCAL' } and the admin uses the upload routes. */
  router.post('/api/admin/upload/presign', async ({ req, body }) => {
    if (String(req.headers['sec-fetch-site'] || '').toLowerCase() === 'cross-site') {
      throw new HttpError(403, 'Uploads must come from the Siroya admin');
    }
    return presignUpload(storage, body);
  }, { auth: true });

  /* ---------- leads ---------- */

  const leadOut = r => ({ ...r, when: r.when_pref });

  router.get('/api/admin/leads', async ({ query }) => {
    const per = Math.min(200, Math.max(1, parseInt(query.get('per'), 10) || 50));
    const page = Math.max(1, parseInt(query.get('page'), 10) || 1);
    const [totalRow, rows] = await Promise.all([
      stmt('SELECT COUNT(*) AS n FROM leads').get(),
      stmt('SELECT * FROM leads ORDER BY id DESC LIMIT ? OFFSET ?').all(per, (page - 1) * per),
    ]);
    const total = totalRow.n;
    const items = rows.map(leadOut);
    return { items, total, page, per };
  }, { auth: true });

  const LEAD_COLUMNS = [
    ['id', 'ID'], ['created_at', 'Date'], ['name', 'Name'], ['phone', 'Phone'], ['store', 'Store'], ['when_pref', 'Best time'],
    ['product', 'Product'], ['code', 'Code'], ['collection', 'Collection'], ['url', 'URL'],
    ['gclid', 'gclid'], ['gbraid', 'gbraid'], ['wbraid', 'wbraid'],
    ['utm_source', 'utm_source'], ['utm_medium', 'utm_medium'], ['utm_campaign', 'utm_campaign'],
    ['utm_term', 'utm_term'], ['utm_content', 'utm_content'], ['landing', 'Landing page'], ['user_agent', 'User agent'],
  ].map(([key, label]) => ({ key, label }));

  router.get('/api/admin/leads.csv', async ({ req, res }) => {
    const rows = await stmt('SELECT * FROM leads ORDER BY id DESC').all();
    const csv = Buffer.from(toCsv(LEAD_COLUMNS, rows), 'utf8');
    const day = new Date().toISOString().slice(0, 10);
    sendBuffer(req, res, 200, {
      'Content-Type': 'text/csv; charset=utf-8',
      'Content-Disposition': `attachment; filename="siroya-leads-${day}.csv"`,
      'Cache-Control': 'no-store',
    }, csv, true);
  }, { auth: true });

  return { RESOURCES };
}

module.exports = { registerAdmin, RESOURCES };
