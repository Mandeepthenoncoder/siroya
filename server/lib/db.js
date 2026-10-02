'use strict';
/* SQLite (node:sqlite) connection, cached prepared statements, transactions,
   settings helpers and idempotent migrations tracked by settings.schema_version. */
const fs = require('node:fs');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');
const { SERVER_DIR } = require('./env');

const DB_FILE = path.join(SERVER_DIR, 'data', 'siroya.db');

/* Each entry upgrades the schema by one version. Statements are written so a
   re-run is harmless (IF NOT EXISTS), and the version is recorded in settings. */
const MIGRATIONS = [
  null,
  // v1: initial schema
  `
  CREATE TABLE IF NOT EXISTS categories (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    slug TEXT UNIQUE NOT NULL,
    name TEXT NOT NULL,
    description TEXT DEFAULT '',
    image TEXT DEFAULT '',
    featured INTEGER DEFAULT 1,
    sort INTEGER DEFAULT 0,
    created_at TEXT,
    updated_at TEXT
  );
  CREATE TABLE IF NOT EXISTS collections (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    slug TEXT UNIQUE NOT NULL,
    name TEXT NOT NULL,
    kind TEXT DEFAULT '',
    short TEXT DEFAULT '',
    intro TEXT DEFAULT '',
    hero TEXT DEFAULT '',
    cover TEXT DEFAULT '',
    quote TEXT DEFAULT '',
    chapters TEXT DEFAULT '[]',
    active INTEGER DEFAULT 1,
    sort INTEGER DEFAULT 0,
    created_at TEXT,
    updated_at TEXT
  );
  CREATE TABLE IF NOT EXISTS products (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    handle TEXT UNIQUE NOT NULL,
    code TEXT DEFAULT '',
    name TEXT NOT NULL,
    collection TEXT DEFAULT '',
    category TEXT DEFAULT '',
    metal TEXT DEFAULT '',
    weight TEXT DEFAULT '',
    stones TEXT DEFAULT '',
    description TEXT DEFAULT '',
    images TEXT DEFAULT '[]',
    featured INTEGER DEFAULT 0,
    status TEXT DEFAULT 'active' CHECK (status IN ('active', 'draft', 'archived')),
    sort INTEGER DEFAULT 0,
    created_at TEXT,
    updated_at TEXT
  );
  CREATE TABLE IF NOT EXISTS stores (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    slug TEXT UNIQUE NOT NULL,
    name TEXT NOT NULL,
    address TEXT DEFAULT '',
    hours TEXT DEFAULT '',
    phone TEXT DEFAULT '',
    map TEXT DEFAULT '',
    image TEXT DEFAULT '',
    sort INTEGER DEFAULT 0
  );
  CREATE TABLE IF NOT EXISTS leads (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    created_at TEXT,
    name TEXT, phone TEXT, store TEXT, when_pref TEXT,
    product TEXT, code TEXT, collection TEXT, url TEXT,
    gclid TEXT, gbraid TEXT, wbraid TEXT,
    utm_source TEXT, utm_medium TEXT, utm_campaign TEXT, utm_term TEXT, utm_content TEXT,
    landing TEXT, user_agent TEXT
  );
  CREATE INDEX IF NOT EXISTS idx_products_collection ON products(collection);
  CREATE INDEX IF NOT EXISTS idx_products_category ON products(category);
  CREATE INDEX IF NOT EXISTS idx_products_status_sort ON products(status, sort);
  CREATE INDEX IF NOT EXISTS idx_categories_sort ON categories(sort);
  CREATE INDEX IF NOT EXISTS idx_collections_sort ON collections(sort);
  CREATE INDEX IF NOT EXISTS idx_leads_created ON leads(created_at);
  `,
  // v2: first-party analytics events + daily rollups (docs/TRAFFIC-SPEC.md)
  require('./analytics').ANALYTICS_SCHEMA_SQL,
];

function openDb(file = DB_FILE) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const raw = new DatabaseSync(file);
  raw.exec('PRAGMA journal_mode = WAL; PRAGMA synchronous = NORMAL; PRAGMA busy_timeout = 5000;');

  const cache = new Map();
  /* Cached prepared statement for a fixed SQL string. */
  function stmt(sql) {
    let s = cache.get(sql);
    if (!s) {
      s = raw.prepare(sql);
      cache.set(sql, s);
    }
    return s;
  }

  let depth = 0;
  /* Runs fn inside a transaction; nested calls join the outer one. */
  function tx(fn) {
    if (depth > 0) return fn();
    raw.exec('BEGIN IMMEDIATE');
    depth++;
    try {
      const result = fn();
      raw.exec('COMMIT');
      return result;
    } catch (err) {
      try { raw.exec('ROLLBACK'); } catch { /* already rolled back */ }
      throw err;
    } finally {
      depth--;
    }
  }

  function getSetting(key, fallback) {
    const row = stmt('SELECT value FROM settings WHERE key = ?').get(key);
    if (!row) return fallback;
    try { return JSON.parse(row.value); } catch { return fallback; }
  }

  function setSetting(key, value) {
    stmt('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value')
      .run(key, JSON.stringify(value));
  }

  function migrate() {
    raw.exec('CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT)');
    const current = Number(getSetting('schema_version', 0)) || 0;
    for (let v = current + 1; v < MIGRATIONS.length; v++) {
      tx(() => {
        raw.exec(MIGRATIONS[v]);
        setSetting('schema_version', v);
      });
      console.log(`Database migrated to schema v${v}`);
    }
  }

  function close() {
    cache.clear();
    try { raw.close(); } catch { /* ignore */ }
  }

  return { raw, stmt, tx, getSetting, setSetting, migrate, close, file };
}

const now = () => new Date().toISOString();

module.exports = { openDb, DB_FILE, now, SCHEMA_VERSION: MIGRATIONS.length - 1 };
