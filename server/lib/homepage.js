'use strict';
/* Homepage banners (settings key "homepage"): seed defaults, validation and
   featured collection resolution. Contract: docs/HOMEPAGE-BANNER-SPEC.md.

   validate(input)          -> clean object, or throws HttpError(400) whose
                               message the admin can show as is.
   getHomepage(db)          -> stored object (defaults when the key is missing).
   seedHomepage(db)         -> writes the defaults once, when the key is missing.
   resolveFeatured(db, home)-> copy of home with featured.resolved filled in. */
const { HttpError } = require('./http');

const KEY = 'homepage';
const MODES = ['image', 'slideshow', 'video'];
const FOCUS = ['right', 'center', 'left'];
const ALIGN = ['left', 'center'];
const ENUM_ALIASES = { centre: 'center', middle: 'center' };
const MIN_SLIDES = 1;
const MAX_SLIDES = 6;

/* Character caps for single line text. Over the cap is an error, not a silent
   cut, so a headline never goes live half written. */
const CAPS = {
  eyebrow: 50,
  headline: 70,
  text: 160,
  alt: 140,
  ctaLabel: 40,
  link: 500,
  media: 300,
  featuredHeadline: 120,
  featuredText: 400,
  featuredCta: 40,
  slug: 80,
};
const INTERVAL = { min: 4, max: 12, def: 6, decimals: 1 };
const OVERLAY = { min: 0, max: 0.8, def: 0.45, decimals: 2 };

/* Same-site relative link (no scheme, no leading slash, no dot segments). */
const REL_LINK_RE = /^[a-z0-9][a-z0-9\-_/.?=&#%]*$/i;
/* https:// link with a real host name; no credentials, quotes or backslashes. */
const HTTPS_LINK_RE = /^https:\/\/[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)*(?::\d{1,5})?(?:[/?#][^\s"'<>\\`]*)?$/i;
const MEDIA_RE = /^(?:assets|uploads)\/[A-Za-z0-9._~\-/]+$/;
const IMAGE_EXT_RE = /\.(?:jpe?g|png|webp|avif|gif|svg)$/i;
const VIDEO_EXT_RE = /\.(?:mp4|webm)$/i;
const SLUG_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

const DEFAULT_HOMEPAGE = Object.freeze({
  hero: {
    mode: 'image',
    slides: [{
      image: 'assets/img/home/hero.jpg',
      image_mobile: '',
      focus: 'right',
      eyebrow: 'Jewellers to the world since 1976',
      headline: 'Jewellery that feels like home',
      text: "Designs curated from across the world, chosen with care for your family's celebrations.",
      cta_label: 'Explore collections',
      cta_link: 'collections.html',
      cta2_label: 'Our story',
      cta2_link: 'about.html',
      alt: 'A mother fastening a gold temple necklace on her daughter before the wedding',
    }],
    video: { src: '', src_mobile: '', poster: '', poster_mobile: '' },
    interval: INTERVAL.def,
    overlay: OVERLAY.def,
    align: 'left',
  },
  featured: {
    collection: 'sanskriti',
    image: '',
    headline: 'Sanskriti. Traditions carried forward.',
    text: 'Temple jewellery shaped by South Indian craft, made for the weddings and festivals your family will remember.',
    cta_label: '',
  },
});

const clone = v => JSON.parse(JSON.stringify(v));
const defaults = () => clone(DEFAULT_HOMEPAGE);
const isObj = v => v !== null && typeof v === 'object' && !Array.isArray(v);
const bad = message => new HttpError(400, message);

/* ---------- field cleaners ---------- */

/* Single line text: control characters removed, line breaks and tabs become a
   space, trimmed. Over `max` characters is an error. */
function line(value, max, label) {
  if (value === undefined || value === null) return '';
  if (typeof value !== 'string' && typeof value !== 'number') throw bad(`${label} must be text`);
  const s = String(value)
    .replace(/[\r\n\t\p{Zl}\p{Zp}]+/gu, ' ')
    .replace(/[\u0000-\u001f\u007f]/g, '')
    .trim();
  if (s.length > max) throw bad(`${label} is ${s.length} characters. Please keep it to ${max} or fewer.`);
  return s;
}

/* Button link: a page on this site (collections.html, collection.html?c=x)
   or a full https:// link. A single leading "/" is accepted and removed. */
function link(value, label) {
  let s = line(value, CAPS.link, label);
  if (!s) return '';
  if (/^https:\/\//i.test(s)) {
    s = `https://${s.slice(8)}`;
    if (!HTTPS_LINK_RE.test(s)) throw bad(`${label} is not a valid https:// link`);
    return s;
  }
  if (s.startsWith('/') && !s.startsWith('//')) s = s.slice(1);
  if (s.includes('..') || /%2e/i.test(s) || !REL_LINK_RE.test(s)) {
    throw bad(`${label} must be a page on this site (for example collections.html) or a full https:// link`);
  }
  return s;
}

/* Image or video path inside the site: assets/... or uploads/... only. */
function media(value, label, kind) {
  let s = line(value, CAPS.media, label);
  if (!s) return '';
  s = s.replace(/^\/+/, '');
  const where = kind === 'video' ? 'an uploaded video (uploads/...)' : 'an uploaded image (uploads/...) or a site image (assets/...)';
  if (s.includes('..') || !MEDIA_RE.test(s) || s.split('/').some(seg => !seg || seg.startsWith('.'))) {
    throw bad(`${label} must be ${where}`);
  }
  if (kind === 'video' && !VIDEO_EXT_RE.test(s)) throw bad(`${label} must be an MP4 or WebM video (.mp4 or .webm)`);
  if (kind === 'image' && !IMAGE_EXT_RE.test(s)) throw bad(`${label} must be an image (.jpg, .png, .webp, .avif, .gif or .svg)`);
  return s;
}

function pick(value, allowed, def, label) {
  if (value === undefined || value === null || value === '') return def;
  if (typeof value !== 'string') throw bad(`${label} must be one of: ${allowed.join(', ')}`);
  let s = value.trim().toLowerCase();
  if (ENUM_ALIASES[s]) s = ENUM_ALIASES[s];
  if (!allowed.includes(s)) throw bad(`${label} must be one of: ${allowed.join(', ')}`);
  return s;
}

/* Number clamped into [min, max]; blank uses the default. */
function num(value, { min, max, def, decimals }, label) {
  if (value === undefined || value === null || value === '') return def;
  const n = typeof value === 'string' ? Number(value.trim()) : value;
  if (typeof n !== 'number' || !Number.isFinite(n)) throw bad(`${label} must be a number`);
  const f = 10 ** decimals;
  return Math.round(Math.min(max, Math.max(min, n)) * f) / f;
}

function slug(value, label) {
  const s = line(value, CAPS.slug, label).toLowerCase();
  if (s && !SLUG_RE.test(s)) throw bad(`${label} is not a valid collection`);
  return s;
}

/* ---------- validation ---------- */

function cleanSlide(raw, index, needImage) {
  const p = `Slide ${index + 1}`;
  if (!isObj(raw)) throw bad(`${p} must be an object`);
  const out = {
    image: media(raw.image, `${p} desktop image`, 'image'),
    image_mobile: media(raw.image_mobile, `${p} phone image`, 'image'),
    focus: pick(raw.focus, FOCUS, 'right', `${p} focus`),
    eyebrow: line(raw.eyebrow, CAPS.eyebrow, `${p} eyebrow`),
    headline: line(raw.headline, CAPS.headline, `${p} headline`),
    text: line(raw.text, CAPS.text, `${p} text`),
    cta_label: line(raw.cta_label, CAPS.ctaLabel, `${p} button 1 label`),
    cta_link: link(raw.cta_link, `${p} button 1 link`),
    cta2_label: line(raw.cta2_label, CAPS.ctaLabel, `${p} button 2 label`),
    cta2_link: link(raw.cta2_link, `${p} button 2 link`),
    alt: line(raw.alt, CAPS.alt, `${p} image description`),
  };
  if (needImage && !out.image) throw bad(`${p} needs a desktop image`);
  if (out.cta_label && !out.cta_link) throw bad(`${p} button 1 needs a link`);
  if (out.cta2_label && !out.cta2_link) throw bad(`${p} button 2 needs a link`);
  return out;
}

function cleanHero(hero) {
  if (!isObj(hero)) throw bad('Hero settings are missing');
  const mode = pick(hero.mode, MODES, 'image', 'Banner type');
  if (!Array.isArray(hero.slides)) throw bad('Slides must be a list');
  if (hero.slides.length < MIN_SLIDES) throw bad('Add at least one slide');
  if (hero.slides.length > MAX_SLIDES) throw bad(`A slideshow can have at most ${MAX_SLIDES} slides`);
  // Image mode shows slides[0] only; slides kept from a slideshow may stay
  // without images until the slideshow is used again.
  const slides = hero.slides.map((s, i) => cleanSlide(s, i, mode === 'slideshow' || (mode === 'image' && i === 0)));

  if (hero.video !== undefined && hero.video !== null && !isObj(hero.video)) throw bad('Video settings must be an object');
  const v = isObj(hero.video) ? hero.video : {};
  const video = {
    src: media(v.src, 'Video', 'video'),
    src_mobile: media(v.src_mobile, 'Phone video', 'video'),
    poster: media(v.poster, 'Video cover image', 'image'),
    poster_mobile: media(v.poster_mobile, 'Phone cover image', 'image'),
  };
  if (mode === 'video') {
    if (!video.src) throw bad('Upload a video for the banner');
    if (!video.poster) throw bad('Add a cover image for the video. It shows while the video loads and when it cannot play.');
  }
  return {
    mode,
    slides,
    video,
    interval: num(hero.interval, INTERVAL, 'Slideshow interval'),
    overlay: num(hero.overlay, OVERLAY, 'Overlay'),
    align: pick(hero.align, ALIGN, 'left', 'Alignment'),
  };
}

function cleanFeatured(f) {
  if (!isObj(f)) throw bad('Featured collection settings are missing');
  const collection = slug(f.collection, 'Featured collection');
  if (!collection) throw bad('Choose a collection for the featured banner');
  return {
    collection,
    image: media(f.image, 'Featured image', 'image'),
    headline: line(f.headline, CAPS.featuredHeadline, 'Featured headline'),
    text: line(f.text, CAPS.featuredText, 'Featured text'),
    cta_label: line(f.cta_label, CAPS.featuredCta, 'Featured button label'),
  };
}

/* Full homepage object in, clean object out. Unknown fields are dropped. */
function validate(input) {
  if (!isObj(input)) throw bad('Expected the homepage settings as an object');
  return { hero: cleanHero(input.hero), featured: cleanFeatured(input.featured) };
}

/* ---------- storage ---------- */

function seedHomepage(db) {
  if (db.getSetting(KEY, null) !== null) return false;
  db.setSetting(KEY, defaults());
  return true;
}

/* Stored settings, re-validated so the public site always gets a sound shape.
   Missing key: the defaults are written once and returned. */
function getHomepage(db) {
  const stored = db.getSetting(KEY, null);
  if (stored === null) {
    try { seedHomepage(db); } catch { /* read-only or unmigrated db: still answer */ }
    return defaults();
  }
  try {
    return validate(stored);
  } catch (err) {
    console.warn(`Stored homepage settings are invalid (${err.message}); using defaults`);
    return defaults();
  }
}

function saveHomepage(db, clean) {
  db.setSetting(KEY, clean);
  return clean;
}

/* ---------- featured collection ---------- */

const COLLECTION_COLUMNS = 'slug, name, kind, short, hero, cover';

/* Returns a copy of `home` with featured.resolved = { slug, name, kind, short,
   hero, cover, url, fallback }. When the chosen collection is missing or
   hidden, the first active collection is used instead (fallback: true) and the
   custom image, headline, text and button label are blanked because they were
   written for the other collection. resolved is null when no collection is
   active. */
function resolveFeatured(db, home) {
  const out = clone(home);
  const f = isObj(out.featured) ? out.featured : {};
  let row = f.collection
    ? db.stmt(`SELECT ${COLLECTION_COLUMNS} FROM collections WHERE slug = ? AND active = 1`).get(f.collection)
    : null;
  let fallback = false;
  if (!row) {
    row = db.stmt(`SELECT ${COLLECTION_COLUMNS} FROM collections WHERE active = 1 ORDER BY sort, id LIMIT 1`).get();
    fallback = Boolean(row);
    if (fallback) Object.assign(f, { image: '', headline: '', text: '', cta_label: '' });
  }
  const s = v => (v === null || v === undefined ? '' : String(v));
  f.resolved = row ? {
    slug: row.slug,
    name: s(row.name),
    kind: s(row.kind),
    short: s(row.short),
    hero: s(row.hero),
    cover: s(row.cover),
    url: `collection.html?c=${encodeURIComponent(row.slug)}`,
    fallback,
  } : null;
  out.featured = f;
  return out;
}

/* Admin save check: the featured collection must exist and be active. */
function assertFeaturedCollection(db, slugValue) {
  const row = db.stmt('SELECT active FROM collections WHERE slug = ?').get(slugValue);
  if (!row) throw bad(`Unknown collection "${slugValue}". Choose one from the list.`);
  if (!row.active) throw bad(`The collection "${slugValue}" is hidden on the site. Make it active first or choose another.`);
}

module.exports = {
  KEY,
  MODES,
  FOCUS,
  ALIGN,
  MIN_SLIDES,
  MAX_SLIDES,
  CAPS,
  INTERVAL,
  OVERLAY,
  DEFAULT_HOMEPAGE,
  defaults,
  validate,
  link,
  media,
  seedHomepage,
  getHomepage,
  saveHomepage,
  resolveFeatured,
  assertFeaturedCollection,
};
