'use strict';
/* Database layer on @libsql/client (async).
   - Local: a SQLite file, file:server/data/siroya.db by default (the same file
     and format node:sqlite used before, so existing data keeps working).
   - Production: Turso, from TURSO_DATABASE_URL + TURSO_AUTH_TOKEN (HTTP, so no
     native module is loaded on Vercel).

   API (every call returns a Promise):
     db.all(sql, args)   -> rows (plain objects)
     db.get(sql, args)   -> first row or undefined
     db.run(sql, args)   -> { changes, lastInsertRowid }
     db.exec(sql)        -> runs several ;-separated statements
     db.batch([{ sql, args }, ...]) -> atomic list of writes, one round trip
     db.stmt(sql)        -> { all(...args), get(...args), run(...args) }
     db.tx(async () => { ... }) -> interactive write transaction. Every db call
                            made inside fn (however deep) joins it, through
                            AsyncLocalStorage; nested tx() calls join the outer one.
     db.getSetting(key, fallback) / db.setSetting(key, value)
     db.migrate()        -> idempotent, cached per process (one per cold start)

   Writes and transactions are serialised inside one process: a SQLite file
   allows a single writer, and a statement that met a held write lock would
   fail at once with SQLITE_BUSY instead of waiting. */
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { AsyncLocalStorage } = require('node:async_hooks');
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

/* Where the database lives. Explicit argument first, then TURSO_DATABASE_URL,
   then the local file. A bare path becomes a file: URL. ':memory:' becomes a
   private temporary file (libsql opens a new connection per transaction, and
   each new in-memory connection would be an empty database). */
function resolveTarget(target) {
  let url = target;
  let authToken;
  let temp = null;
  if (url && typeof url === 'object') {
    authToken = url.authToken;
    url = url.url;
  }
  if (!url) {
    url = process.env.TURSO_DATABASE_URL || '';
    authToken = authToken || process.env.TURSO_AUTH_TOKEN || undefined;
  }
  if (!url) url = DB_FILE;
  if (url === ':memory:' || url === 'file::memory:') {
    const dir = path.join(os.tmpdir(), 'siroya-test-dbs');
    fs.mkdirSync(dir, { recursive: true });
    sweepTempDbs(dir);
    temp = path.join(dir, `siroya-test-${process.pid}-${crypto.randomBytes(6).toString('hex')}.db`);
    url = temp;
  }
  const isRemote = /^(libsql|https?|wss?):\/\//i.test(url);
  if (isRemote) {
    // libsql:// means Turso; HTTP keeps it stateless and needs no native module.
    return { mode: 'remote', url: url.replace(/^libsql:\/\//i, 'https://'), authToken, file: null, temp: null };
  }
  const file = url.startsWith('file:') ? url.slice(5) : url;
  return { mode: 'file', url: `file:${file}`, authToken: undefined, file: path.resolve(file), temp };
}

/* Temp databases whose delete failed (Windows keeps a native handle open until
   garbage collection) are removed by a later run once they are an hour old. */
function sweepTempDbs(dir) {
  let names = [];
  try { names = fs.readdirSync(dir); } catch { return; }
  const cutoff = Date.now() - 3600 * 1000;
  for (const name of names) {
    if (!name.startsWith('siroya-test-')) continue;
    const f = path.join(dir, name);
    try { if (fs.statSync(f).mtimeMs < cutoff) fs.rmSync(f, { force: true }); } catch { /* still in use */ }
  }
}

function createLibsqlClient(t) {
  if (t.mode === 'remote') {
    const { createClient } = require('@libsql/client/http');
    return createClient({ url: t.url, authToken: t.authToken, intMode: 'number' });
  }
  fs.mkdirSync(path.dirname(t.file), { recursive: true });
  const { createClient } = require('@libsql/client/sqlite3');
  return createClient({ url: t.url, intMode: 'number' });
}

/* libsql rows are array-like objects; hand out plain { column: value } rows. */
function toRows(rs) {
  const cols = rs.columns;
  return rs.rows.map(r => {
    const o = {};
    for (let i = 0; i < cols.length; i++) o[cols[i]] = r[i];
    return o;
  });
}

function normArgs(args) {
  if (args === undefined || args === null) return [];
  if (!Array.isArray(args)) return args; // named arguments object
  return args.map(v => (typeof v === 'boolean' ? (v ? 1 : 0) : v));
}

function openDb(target) {
  const t = resolveTarget(target);
  const client = createLibsqlClient(t);
  const als = new AsyncLocalStorage();

  /* One writer at a time in this process. lock() resolves with a release(). */
  let tail = Promise.resolve();
  function lock() {
    let release;
    const next = new Promise(resolve => { release = resolve; });
    const ready = tail.then(() => release);
    tail = tail.then(() => next);
    return ready;
  }

  let pragmasDone = false;
  async function filePragmas() {
    if (pragmasDone || t.mode !== 'file') return;
    pragmasDone = true;
    try {
      await client.execute('PRAGMA journal_mode = WAL');
      await client.execute('PRAGMA synchronous = NORMAL');
    } catch { /* best effort */ }
  }

  const current = () => {
    const store = als.getStore();
    return store && !store.closed ? store : null;
  };

  /* Reads skip the queue: a write transaction holds the lock only between its
     own awaits, and SQLite readers in WAL mode never wait for the writer. */
  async function execute(sql, args, write) {
    const store = current();
    const stmt = { sql, args: normArgs(args) };
    if (store) return store.tx.execute(stmt);
    if (!write) return client.execute(stmt);
    const release = await lock();
    try { return await client.execute(stmt); } finally { release(); }
  }

  const isWrite = sql => !/^\s*(?:SELECT|WITH|PRAGMA\s+\w+\s*$|EXPLAIN)\b/i.test(sql) || /^\s*WITH\b[\s\S]*\b(?:INSERT|UPDATE|DELETE)\b/i.test(sql);

  async function all(sql, args) { return toRows(await execute(sql, args, isWrite(sql))); }
  async function get(sql, args) { return (await all(sql, args))[0]; }
  async function run(sql, args) {
    const rs = await execute(sql, args, true);
    return { changes: rs.rowsAffected, lastInsertRowid: rs.lastInsertRowid === undefined ? 0 : Number(rs.lastInsertRowid) };
  }

  async function exec(sql) {
    const store = current();
    if (store) return store.tx.executeMultiple(sql);
    const release = await lock();
    try { return await client.executeMultiple(sql); } finally { release(); }
  }

  /* Atomic list of statements in one round trip. Inside tx() they run in it. */
  async function batch(stmts) {
    const list = stmts.map(s => (typeof s === 'string' ? { sql: s, args: [] } : { sql: s.sql, args: normArgs(s.args) }));
    const store = current();
    if (store) {
      const out = [];
      for (const s of list) out.push(await store.tx.execute(s));
      return out;
    }
    const release = await lock();
    try { return await client.batch(list, 'write'); } finally { release(); }
  }

  function stmt(sql) {
    return {
      all: (...args) => all(sql, args),
      get: (...args) => get(sql, args),
      run: (...args) => run(sql, args),
    };
  }

  /* Runs fn inside a write transaction; nested calls join the outer one. */
  async function tx(fn) {
    if (current()) return fn();
    const release = await lock();
    let txn;
    const store = { tx: null, closed: false };
    try {
      txn = await client.transaction('write');
      store.tx = txn;
      const result = await als.run(store, fn);
      await txn.commit();
      return result;
    } catch (err) {
      if (txn) { try { await txn.rollback(); } catch { /* already rolled back */ } }
      throw err;
    } finally {
      store.closed = true;
      if (txn) { try { txn.close(); } catch { /* ignore */ } }
      release();
    }
  }

  async function getSetting(key, fallback) {
    const row = await get('SELECT value FROM settings WHERE key = ?', [key]);
    if (!row) return fallback;
    try { return JSON.parse(row.value); } catch { return fallback; }
  }

  async function setSetting(key, value) {
    await run('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value',
      [key, JSON.stringify(value)]);
  }

  let migrated = null;
  function migrate() {
    if (!migrated) {
      migrated = (async () => {
        await filePragmas();
        await exec('CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT)');
        const currentVersion = Number(await getSetting('schema_version', 0)) || 0;
        for (let v = currentVersion + 1; v < MIGRATIONS.length; v++) {
          await tx(async () => {
            await exec(MIGRATIONS[v]);
            await setSetting('schema_version', v);
          });
          console.log(`Database migrated to schema v${v}`);
        }
      })();
      migrated.catch(() => { migrated = null; }); // a failed cold start retries
    }
    return migrated;
  }

  let closed = false;
  async function close() {
    if (closed) return;
    closed = true;
    try { await tail; } catch { /* ignore */ }
    try { client.close(); } catch { /* ignore */ }
    if (t.temp) {
      for (const f of [t.temp, `${t.temp}-wal`, `${t.temp}-shm`, `${t.temp}-journal`]) {
        try { fs.rmSync(f, { force: true }); } catch { /* ignore */ }
      }
    }
  }

  return {
    all, get, run, exec, batch, stmt, tx, getSetting, setSetting, migrate, close,
    client, mode: t.mode, file: t.file, url: t.mode === 'file' ? t.url : '(remote)',
  };
}

const now = () => new Date().toISOString();

module.exports = { openDb, resolveTarget, DB_FILE, now, MIGRATIONS, SCHEMA_VERSION: MIGRATIONS.length - 1 };
