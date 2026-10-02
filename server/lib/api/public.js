'use strict';
/* Public API: GET /api/catalog and POST /api/leads. */
const { HttpError, json } = require('../http');
const { safeJson } = require('../validate');
const { now } = require('../db');

const s = v => (v === null || v === undefined ? '' : v);

/* The site settings object exactly as data.js shapes it. */
function siteObject(db, withLeadEndpoint = true) {
  const stored = db.getSetting('site', {}) || {};
  const socials = stored.socials && typeof stored.socials === 'object' ? stored.socials : {};
  const out = {
    ...stored,
    name: s(stored.name),
    tagline: s(stored.tagline),
    since: s(stored.since),
    whatsapp: s(stored.whatsapp),
    phone: s(stored.phone),
    email: s(stored.email),
    socials: { ...socials, instagram: s(socials.instagram), facebook: s(socials.facebook), youtube: s(socials.youtube) },
  };
  if (withLeadEndpoint) out.leadEndpoint = '/api/leads';
  else delete out.leadEndpoint;
  return out;
}

function catalog(db) {
  return {
    site: siteObject(db),
    categories: db.stmt('SELECT * FROM categories ORDER BY sort, id').all().map(r => ({
      slug: r.slug, name: r.name, img: s(r.image), description: s(r.description), featured: !!r.featured, sort: r.sort,
    })),
    collections: db.stmt('SELECT * FROM collections WHERE active = 1 ORDER BY sort, id').all().map(r => ({
      slug: r.slug, name: r.name, kind: s(r.kind), short: s(r.short), intro: s(r.intro), hero: s(r.hero), cover: s(r.cover),
      chapters: safeJson(r.chapters, []), quote: s(r.quote), sort: r.sort,
    })),
    products: db.stmt("SELECT * FROM products WHERE status = 'active' ORDER BY sort, id").all().map(r => ({
      id: r.handle, code: s(r.code), name: r.name, collection: s(r.collection), category: s(r.category), metal: s(r.metal),
      weight: s(r.weight), stones: s(r.stones), images: safeJson(r.images, []), description: s(r.description),
      featured: !!r.featured, sort: r.sort,
    })),
    stores: db.stmt('SELECT * FROM stores ORDER BY sort, id').all().map(r => ({
      slug: r.slug, name: r.name, address: s(r.address), hours: s(r.hours), phone: s(r.phone), map: s(r.map), img: s(r.image),
    })),
  };
}

const LEAD_FIELDS = ['store', 'product', 'code', 'collection', 'url', 'gclid', 'gbraid', 'wbraid',
  'utm_source', 'utm_medium', 'utm_campaign', 'utm_term', 'utm_content', 'landing'];

/* Every lead field: plain single-line text, trimmed, max 500 characters. */
function leadText(v) {
  if (typeof v !== 'string' && typeof v !== 'number') return '';
  return String(v).replace(/[\u0000-\u001f\u007f]+/g, ' ').trim().slice(0, 500).trim();
}

function registerPublic(router, { db, leadLimiter }) {
  router.get('/api/catalog', ({ req, res }) => json(req, res, 200, catalog(db)));

  router.post('/api/leads', ({ req, res, body }) => {
    const name = leadText(body.name);
    if (!name || name.length > 120) throw new HttpError(400, 'Please enter your name (up to 120 characters)');
    const phone = leadText(body.phone);
    const digits = phone.replace(/\D/g, '');
    if (digits.length < 6 || digits.length > 20) throw new HttpError(400, 'Please enter a valid mobile number');
    const lead = { name, phone, when_pref: leadText(body.when ?? body.when_pref) };
    for (const k of LEAD_FIELDS) lead[k] = leadText(body[k]);
    db.stmt(`INSERT INTO leads (created_at, name, phone, store, when_pref, product, code, collection, url,
      gclid, gbraid, wbraid, utm_source, utm_medium, utm_campaign, utm_term, utm_content, landing, user_agent)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
      now(), lead.name, lead.phone, lead.store, lead.when_pref, lead.product, lead.code, lead.collection, lead.url,
      lead.gclid, lead.gbraid, lead.wbraid, lead.utm_source, lead.utm_medium, lead.utm_campaign, lead.utm_term,
      lead.utm_content, lead.landing, leadText(req.headers['user-agent']),
    );
    json(req, res, 201, { ok: true });
  }, { contentTypes: ['application/json', 'text/plain'], rateLimit: leadLimiter });
}

module.exports = { registerPublic, catalog, siteObject };
