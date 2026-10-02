'use strict';
/* Input cleaning shared by the API. Every helper either returns a clean value
   or throws HttpError(400) with a message the admin can show as is. */
const { HttpError } = require('./http');

const SLUG_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const SLUG_MAX = 80;
const CONTROL_RE = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g;

const hasOwn = (o, k) => Object.prototype.hasOwnProperty.call(o, k);

function slugify(input) {
  return String(input ?? '')
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/&/g, ' and ')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, SLUG_MAX)
    .replace(/-+$/g, '');
}

/* Text field: trimmed, control characters removed, capped at `max`.
   `multiline` keeps line breaks (descriptions, intros). */
function text(value, max, label, multiline = false) {
  if (value === null || value === undefined) return '';
  if (typeof value !== 'string' && typeof value !== 'number') throw new HttpError(400, `${label} must be text`);
  let s = String(value);
  s = multiline ? s.replace(/\r\n?/g, '\n').replace(CONTROL_RE, '') : s.replace(/[\r\n\t]+/g, ' ').replace(CONTROL_RE, '');
  return s.trim().slice(0, max).trim();
}

function slug(value, label) {
  const s = text(value, 200, label).toLowerCase();
  if (!s) return '';
  if (s.length > SLUG_MAX || !SLUG_RE.test(s)) {
    throw new HttpError(400, `${label} may only use lowercase letters, numbers and single hyphens (max ${SLUG_MAX} characters)`);
  }
  return s;
}

/* Image reference: site asset (assets/...), upload (uploads/...) or https URL. */
function image(value, label) {
  let s = text(value, 500, label);
  if (!s) return '';
  if (/^https:\/\/[^\s"'<>\\]+$/i.test(s)) return s;
  s = s.replace(/^\/+/, '');
  const ok = /^(?:assets|uploads)\/[^"'<>\\?#\u0000-\u001f]+$/.test(s) && !s.split('/').some(seg => seg === '..' || seg === '.' || seg === '');
  if (!ok) throw new HttpError(400, `${label} must be an uploaded image (uploads/...), a site image (assets/...) or an https link`);
  return s;
}

/* Link used as an href on the public site: only http(s). */
function url(value, label) {
  const s = text(value, 500, label);
  if (!s) return '';
  if (!/^https?:\/\/[^\s"'<>\\]+$/i.test(s)) throw new HttpError(400, `${label} must be a link starting with https://`);
  return s;
}

function bool(value, label) {
  if (value === true || value === 1 || value === '1' || value === 'true' || value === 'on' || value === 'yes') return 1;
  if (value === false || value === 0 || value === '0' || value === 'false' || value === 'off' || value === 'no' || value === '' || value === null) return 0;
  throw new HttpError(400, `${label} must be true or false`);
}

function int(value, label, min = -1e9, max = 1e9) {
  const n = typeof value === 'string' && value.trim() !== '' ? Number(value) : value;
  if (typeof n !== 'number' || !Number.isInteger(n) || n < min || n > max) {
    throw new HttpError(400, `${label} must be a whole number between ${min} and ${max}`);
  }
  return n;
}

function oneOf(value, allowed, label) {
  const s = text(value, 40, label).toLowerCase();
  if (!allowed.includes(s)) throw new HttpError(400, `${label} must be one of: ${allowed.join(', ')}`);
  return s;
}

function idList(value, label = 'ids', maxLen = 2000) {
  if (!Array.isArray(value)) throw new HttpError(400, `${label} must be a list of ids`);
  if (value.length > maxLen) throw new HttpError(400, `Too many ${label} (max ${maxLen})`);
  const out = [];
  const seen = new Set();
  for (const v of value) {
    const n = typeof v === 'string' && /^\d+$/.test(v) ? Number(v) : v;
    if (!Number.isInteger(n) || n < 1) throw new HttpError(400, `${label} must contain positive whole numbers`);
    if (!seen.has(n)) { seen.add(n); out.push(n); }
  }
  return out;
}

function imageList(value, label = 'Images', maxLen = 20) {
  if (value === null || value === undefined || value === '') return [];
  if (!Array.isArray(value)) throw new HttpError(400, `${label} must be a list`);
  if (value.length > maxLen) throw new HttpError(400, `${label}: at most ${maxLen} images`);
  const out = [];
  value.forEach((v, i) => {
    const s = image(v, `${label} ${i + 1}`);
    if (s && !out.includes(s)) out.push(s);
  });
  return out;
}

function chapters(value, label = 'Chapters', maxLen = 20) {
  if (value === null || value === undefined || value === '') return [];
  if (!Array.isArray(value)) throw new HttpError(400, `${label} must be a list`);
  if (value.length > maxLen) throw new HttpError(400, `${label}: at most ${maxLen}`);
  return value.map((c, i) => {
    if (!c || typeof c !== 'object' || Array.isArray(c)) throw new HttpError(400, `${label} ${i + 1} must be an object`);
    return {
      title: text(c.title, 160, `Chapter ${i + 1} title`),
      text: text(c.text, 3000, `Chapter ${i + 1} text`, true),
      img: image(hasOwn(c, 'img') ? c.img : c.image, `Chapter ${i + 1} image`),
    };
  });
}

function safeJson(textValue, fallback) {
  try {
    const v = JSON.parse(textValue);
    return v === null || v === undefined ? fallback : v;
  } catch {
    return fallback;
  }
}

module.exports = {
  SLUG_RE, hasOwn, slugify, text, slug, image, url, bool, int, oneOf, idList, imageList, chapters, safeJson,
};
