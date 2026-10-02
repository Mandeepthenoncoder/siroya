#!/usr/bin/env node
'use strict';
/* Copies the local Siroya database (server/data/siroya.db) to Turso and the
   local uploads (site/uploads/...) to Cloudflare R2, rewriting stored
   "uploads/..." paths to R2 URLs on the way. The local database and files are
   only read, never changed.

   Run from the project folder, with the production values in the environment:
     node --env-file=vercel-import.env scripts/copy-local-to-turso.js --dry-run
     node --env-file=vercel-import.env scripts/copy-local-to-turso.js

   Needs: TURSO_DATABASE_URL, TURSO_AUTH_TOKEN, and for media R2_ACCOUNT_ID,
   R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY, R2_BUCKET, R2_PUBLIC_URL.

   What it copies (safe to run again; the result is the same every time):
   - categories, collections, products, stores: Turso is made identical to the
     local copy (rows missing locally are removed), one atomic batch per table.
   - settings: site details, homepage banners and the seed marker. Not copied:
     schema_version (Turso keeps its own) and the Google connection (its key is
     encrypted with the local SESSION_SECRET; connect Google again in the live
     admin).
   - files under site/uploads that the copied rows use: uploaded to R2 under the
     same key (uploads/yyyy/mm/name), skipped when already there.
   Optional:
   --with-leads      also copy leads (rows whose id already exists on Turso are kept)
   --with-analytics  also copy analytics events and rollups (same rule)
   --skip-media      copy the database only (uploads/... paths stay as they are)
   --from <file>     another local database file
   --dry-run         show what would happen, change nothing */
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const args = process.argv.slice(2);
const flag = name => args.includes(name);
const option = name => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
};

const DRY = flag('--dry-run');
const WITH_LEADS = flag('--with-leads');
const WITH_ANALYTICS = flag('--with-analytics');
const SKIP_MEDIA = flag('--skip-media');
const FROM = path.resolve(option('--from') || path.join(ROOT, 'server', 'data', 'siroya.db'));
const SITE_DIR = path.join(ROOT, 'site');

const MIRROR_TABLES = ['categories', 'collections', 'products', 'stores'];
const SKIP_SETTINGS = new Set(['schema_version', 'google', 'google_cache']);
const CHUNK = 200;
const CONTENT_TYPES = {
  '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png', '.webp': 'image/webp',
  '.gif': 'image/gif', '.avif': 'image/avif', '.svg': 'image/svg+xml', '.mp4': 'video/mp4', '.webm': 'video/webm',
};
const UPLOAD_RE = /^\/?(uploads\/[A-Za-z0-9._~\-/]+)$/;

function fail(message) {
  console.error(`\n${message}\n`);
  process.exit(1);
}

function chunks(list, n) {
  const out = [];
  for (let i = 0; i < list.length; i += n) out.push(list.slice(i, i + n));
  return out;
}

function rowsOf(rs) {
  return rs.rows.map(r => {
    const o = {};
    rs.columns.forEach((c, i) => { o[c] = r[i]; });
    return o;
  });
}

/* Replaces "uploads/..." references in a value (plain or JSON text). */
function rewriteValue(value, mapPath) {
  if (typeof value !== 'string' || !value) return value;
  const direct = UPLOAD_RE.exec(value);
  if (direct) return mapPath(direct[1]);
  const t = value.trim();
  if (!(t.startsWith('{') || t.startsWith('['))) return value;
  let data;
  try { data = JSON.parse(t); } catch { return value; }
  let changed = false;
  const walk = v => {
    if (typeof v === 'string') {
      const m = UPLOAD_RE.exec(v);
      if (m) { changed = true; return mapPath(m[1]); }
      return v;
    }
    if (Array.isArray(v)) return v.map(walk);
    if (v && typeof v === 'object') {
      const o = {};
      for (const [k, x] of Object.entries(v)) o[k] = walk(x);
      return o;
    }
    return v;
  };
  const next = walk(data);
  return changed ? JSON.stringify(next) : value;
}

async function main() {
  const turso = process.env.TURSO_DATABASE_URL;
  if (!turso) fail('TURSO_DATABASE_URL is not set. Run with: node --env-file=<your env file> scripts/copy-local-to-turso.js');
  if (!/^(libsql|https|wss):\/\//i.test(turso) && !flag('--allow-file-target')) fail('TURSO_DATABASE_URL must be the Turso database URL (libsql://...).');
  if (!fs.existsSync(FROM)) fail(`Local database not found: ${FROM}`);

  const r2Ready = ['R2_ACCOUNT_ID', 'R2_ACCESS_KEY_ID', 'R2_SECRET_ACCESS_KEY', 'R2_BUCKET', 'R2_PUBLIC_URL'].every(k => process.env[k]);
  if (!SKIP_MEDIA && !r2Ready) fail('R2 settings are missing (R2_ACCOUNT_ID, R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY, R2_BUCKET, R2_PUBLIC_URL). Set them, or pass --skip-media.');

  const { createClient } = require('@libsql/client/sqlite3');
  const local = createClient({ url: `file:${FROM}`, intMode: 'number' });
  const { openDb } = require('../server/lib/db');
  const remote = openDb({ url: turso, authToken: process.env.TURSO_AUTH_TOKEN });

  console.log(`From: ${path.relative(ROOT, FROM)}`);
  const where = /^file:/i.test(turso) ? turso : `Turso (${new URL(turso.replace(/^libsql:/i, 'https:')).host})`;
  console.log(`To:   ${where}${DRY ? '   [dry run: nothing is written]' : ''}`);

  // Make sure the Turso schema is current before writing.
  if (!DRY) await remote.migrate();

  const read = async sql => rowsOf(await local.execute(sql));
  const tables = new Set((await read("SELECT name FROM sqlite_master WHERE type = 'table'")).map(r => r.name));

  /* ---------- media ---------- */
  let base = '';
  const used = new Set();
  const mapPath = p => {
    used.add(p);
    return SKIP_MEDIA ? p : `${base}/${p}`;
  };
  if (!SKIP_MEDIA) {
    const { mediaBase } = require('../server/lib/storage');
    base = mediaBase();
    if (!base) fail('R2_PUBLIC_URL must be an https:// address.');
  }

  /* ---------- catalog tables: mirror ---------- */
  const plan = [];
  for (const table of MIRROR_TABLES) {
    if (!tables.has(table)) continue;
    const rows = (await read(`SELECT * FROM ${table} ORDER BY id`)).map(row => {
      const out = {};
      for (const [k, v] of Object.entries(row)) out[k] = rewriteValue(v, mapPath);
      return out;
    });
    plan.push({ table, rows });
  }

  /* ---------- settings ---------- */
  const settings = tables.has('settings')
    ? (await read('SELECT key, value FROM settings')).filter(r => !SKIP_SETTINGS.has(r.key))
      .map(r => ({ key: r.key, value: rewriteValue(r.value, mapPath) }))
    : [];

  /* ---------- upload the files the rows use ---------- */
  const files = [...used].filter(p => !p.split('/').some(seg => !seg || seg.startsWith('.')));
  let uploaded = 0;
  let present = 0;
  const missing = [];
  if (!SKIP_MEDIA && files.length) {
    const { AwsClient } = require('aws4fetch');
    const aws = new AwsClient({
      accessKeyId: process.env.R2_ACCESS_KEY_ID, secretAccessKey: process.env.R2_SECRET_ACCESS_KEY, service: 's3', region: 'auto',
    });
    const endpoint = `${(process.env.R2_ENDPOINT || `https://${process.env.R2_ACCOUNT_ID}.r2.cloudflarestorage.com`).replace(/\/+$/, '')}/${encodeURIComponent(process.env.R2_BUCKET)}`;
    for (const key of files) {
      const file = path.join(SITE_DIR, ...key.split('/'));
      if (!fs.existsSync(file)) { missing.push(key); continue; }
      const url = `${endpoint}/${key.split('/').map(encodeURIComponent).join('/')}`;
      const head = await aws.fetch(url, { method: 'HEAD' });
      if (head.ok) { present++; continue; }
      if (head.status !== 404) fail(`R2 answered ${head.status} for ${key}. Check the R2 token (Object Read & Write on bucket ${process.env.R2_BUCKET}).`);
      if (DRY) { uploaded++; continue; }
      const type = CONTENT_TYPES[path.extname(file).toLowerCase()] || 'application/octet-stream';
      const res = await aws.fetch(url, {
        method: 'PUT',
        body: fs.readFileSync(file),
        headers: { 'Content-Type': type, 'Cache-Control': 'public, max-age=31536000, immutable' },
      });
      if (!res.ok) fail(`Upload of ${key} failed: ${res.status} ${(await res.text()).slice(0, 200)}`);
      uploaded++;
      process.stdout.write('.');
    }
    if (uploaded) process.stdout.write('\n');
  }
  if (!SKIP_MEDIA) {
    console.log(`Media: ${files.length} file(s) referenced, ${uploaded} ${DRY ? 'to upload' : 'uploaded'}, ${present} already in R2${missing.length ? `, ${missing.length} missing locally` : ''}.`);
    if (missing.length) console.warn(`  Missing locally (left as links that will not load): ${missing.slice(0, 10).join(', ')}${missing.length > 10 ? ' ...' : ''}`);
  } else if (used.size) {
    console.warn(`Media skipped: ${used.size} uploads/... path(s) stay as they are and will not load on Vercel.`);
  }

  /* ---------- write the catalog and settings ---------- */
  for (const { table, rows } of plan) {
    const stmts = [{ sql: `DELETE FROM ${table}`, args: [] }];
    for (const row of rows) {
      const cols = Object.keys(row);
      stmts.push({ sql: `INSERT INTO ${table} (${cols.join(', ')}) VALUES (${cols.map(() => '?').join(', ')})`, args: cols.map(c => row[c]) });
    }
    console.log(`${table}: ${rows.length} row(s)${DRY ? '' : ' copied'}`);
    if (!DRY) await remote.batch(stmts); // one atomic batch: readers see old or new, never half
  }
  if (settings.length) {
    console.log(`settings: ${settings.map(s => s.key).join(', ')}`);
    if (!DRY) {
      await remote.batch(settings.map(s => ({
        sql: 'INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value',
        args: [s.key, s.value],
      })));
    }
  }

  /* ---------- optional: leads and analytics (existing Turso rows win) ---------- */
  const keepExisting = async (table, orderBy) => {
    if (!tables.has(table)) return;
    const rows = await read(`SELECT * FROM ${table} ORDER BY ${orderBy}`);
    console.log(`${table}: ${rows.length} row(s)${DRY ? '' : ' copied (existing rows kept)'}`);
    if (DRY || !rows.length) return;
    const cols = Object.keys(rows[0]);
    const sql = `INSERT OR IGNORE INTO ${table} (${cols.join(', ')}) VALUES (${cols.map(() => '?').join(', ')})`;
    for (const part of chunks(rows, CHUNK)) await remote.batch(part.map(r => ({ sql, args: cols.map(c => r[c]) })));
  };
  if (WITH_LEADS) await keepExisting('leads', 'id');
  if (WITH_ANALYTICS) {
    await keepExisting('events', 'id');
    await keepExisting('events_daily', 'day');
    await keepExisting('events_daily_dim', 'dim, day, key');
  }

  local.close();
  await remote.close();
  console.log(DRY ? '\nDry run finished. Run again without --dry-run to copy.' : '\nDone. Open https://siroya.vercel.app/admin/ to check.');
}

main().catch(err => {
  console.error('\nCopy failed:', err && err.message ? err.message : err);
  process.exit(1);
});
