'use strict';
/* Loads server/.env (simple KEY=VALUE, no dependency). Creates it on first run
   with a random ADMIN_PASSWORD and SESSION_SECRET. Values are never logged.
   process.env always wins over the file. On Vercel (VERCEL is set) the file
   system is read-only, so nothing is ever written, and in production
   (Vercel or NODE_ENV=production) ADMIN_PASSWORD and SESSION_SECRET must be
   set in the environment: start-up fails with a clear message otherwise. */
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

const isServerless = () => Boolean(process.env.VERCEL);
const isProduction = () => isServerless() || process.env.NODE_ENV === 'production';

function loadEnv(file = ENV_FILE) {
  if (isProduction()) {
    const missing = ['ADMIN_PASSWORD', 'SESSION_SECRET'].filter(k => !process.env[k]);
    if (missing.length) {
      throw new Error(`Missing required environment variable${missing.length > 1 ? 's' : ''} ${missing.join(' and ')}. `
        + 'Set them in the Vercel project settings (Settings > Environment Variables) and redeploy.');
    }
  }
  if (isServerless()) {
    const get = k => (process.env[k] !== undefined && process.env[k] !== '' ? process.env[k] : undefined);
    return buildEnv(get);
  }
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

  return buildEnv(k => fromProc(k) ?? fromFile[k]);
}

function buildEnv(get) {
  const env = {
    PORT: get('PORT'),
    HOST: get('HOST'),
    ADMIN_PASSWORD: get('ADMIN_PASSWORD') || '',
    SESSION_SECRET: get('SESSION_SECRET') || '',
    // Vercel always sits in front of the function and sets X-Forwarded-For itself.
    TRUST_PROXY: /^(1|true|yes)$/i.test(get('TRUST_PROXY') || (isServerless() ? '1' : '')),
    TRUST_PROXY_HOPS: get('TRUST_PROXY_HOPS'),
    PUBLIC_ORIGIN: get('PUBLIC_ORIGIN'),
    CRON_SECRET: get('CRON_SECRET') || '',
  };
  if (env.ADMIN_PASSWORD.length < 12) console.warn('Warning: ADMIN_PASSWORD is short. Use 12 or more characters.');
  if (env.SESSION_SECRET.length < 32) console.warn('Warning: SESSION_SECRET is short. Use 32 or more random characters.');
  return env;
}

module.exports = { loadEnv, parseEnv, ENV_FILE, SERVER_DIR, isServerless, isProduction };
