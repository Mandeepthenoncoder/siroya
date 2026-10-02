'use strict';
/* Loads server/.env (simple KEY=VALUE, no dependency). Creates it on first run
   with a random ADMIN_PASSWORD and SESSION_SECRET. Values are never logged. */
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const SERVER_DIR = path.resolve(__dirname, '..');
const ENV_FILE = path.join(SERVER_DIR, '.env');

function parseEnv(text) {
  const out = {};
  for (const raw of String(text).split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq < 1) continue;
    const key = line.slice(0, eq).trim().replace(/^export\s+/, '');
    let val = line.slice(eq + 1).trim();
    const q = val[0];
    if ((q === '"' || q === "'") && val.length >= 2 && val.endsWith(q)) val = val.slice(1, -1);
    if (/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) out[key] = val;
  }
  return out;
}

function randomPassword() {
  // 18 random bytes -> 24 URL-safe characters
  return crypto.randomBytes(18).toString('base64url');
}

function loadEnv(file = ENV_FILE) {
  const existed = fs.existsSync(file);
  const text = existed ? fs.readFileSync(file, 'utf8') : '';
  const fromFile = parseEnv(text);
  const fromProc = k => (process.env[k] !== undefined && process.env[k] !== '' ? process.env[k] : undefined);

  const lines = [];
  let wrotePassword = false;
  if (!fromFile.ADMIN_PASSWORD && !fromProc('ADMIN_PASSWORD')) {
    fromFile.ADMIN_PASSWORD = randomPassword();
    lines.push(`ADMIN_PASSWORD=${fromFile.ADMIN_PASSWORD}`);
    wrotePassword = true;
  }
  if (!fromFile.SESSION_SECRET && !fromProc('SESSION_SECRET')) {
    fromFile.SESSION_SECRET = crypto.randomBytes(32).toString('hex');
    lines.push(`SESSION_SECRET=${fromFile.SESSION_SECRET}`);
  }
  if (lines.length) {
    let content;
    if (!existed) {
      content = [
        '# Siroya server config. Private: never commit or share this file.',
        '# PORT=5173',
        ...lines,
        '',
      ].join('\n');
    } else {
      content = (text.endsWith('\n') || !text ? '' : '\n') + lines.join('\n') + '\n';
    }
    fs.mkdirSync(path.dirname(file), { recursive: true });
    if (existed) fs.appendFileSync(file, content, { mode: 0o600 });
    else fs.writeFileSync(file, content, { mode: 0o600 });
    console.log(wrotePassword ? 'Admin password written to server/.env' : 'Session secret written to server/.env');
  }

  const get = k => fromProc(k) ?? fromFile[k];
  const env = {
    PORT: get('PORT'),
    HOST: get('HOST'),
    ADMIN_PASSWORD: get('ADMIN_PASSWORD') || '',
    SESSION_SECRET: get('SESSION_SECRET') || '',
    TRUST_PROXY: /^(1|true|yes)$/i.test(get('TRUST_PROXY') || ''),
    TRUST_PROXY_HOPS: get('TRUST_PROXY_HOPS'),
    PUBLIC_ORIGIN: get('PUBLIC_ORIGIN'),
  };
  if (env.ADMIN_PASSWORD.length < 12) console.warn('Warning: ADMIN_PASSWORD in server/.env is short. Use 12 or more characters.');
  if (env.SESSION_SECRET.length < 32) console.warn('Warning: SESSION_SECRET in server/.env is short. Use 32 or more random characters.');
  return env;
}

module.exports = { loadEnv, parseEnv, ENV_FILE, SERVER_DIR };
