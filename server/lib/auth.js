'use strict';
/* Admin session: stateless signed cookie siroya_admin=<expiry>.<hmac>.
   The signing key mixes SESSION_SECRET with a hash of ADMIN_PASSWORD, so
   changing the password signs everyone out. */
const crypto = require('node:crypto');
const { parseCookies, isHttps } = require('./http');

const COOKIE = 'siroya_admin';
const MAX_AGE_S = 7 * 24 * 60 * 60;

function createAuth(env) {
  const pwHash = crypto.createHash('sha256').update(env.ADMIN_PASSWORD, 'utf8').digest('hex');
  const key = crypto.createHmac('sha256', env.SESSION_SECRET).update(`siroya-admin:${pwHash}`).digest();

  const sign = payload => crypto.createHmac('sha256', key).update(payload).digest('base64url');

  function passwordMatches(candidate) {
    if (typeof candidate !== 'string' || !env.ADMIN_PASSWORD) return false;
    // Compare fixed-length digests so neither length nor content leaks through timing.
    const a = crypto.createHash('sha256').update(candidate, 'utf8').digest();
    const b = crypto.createHash('sha256').update(env.ADMIN_PASSWORD, 'utf8').digest();
    return crypto.timingSafeEqual(a, b);
  }

  function cookieAttrs(req, maxAge) {
    const parts = ['Path=/', 'HttpOnly', 'SameSite=Strict', `Max-Age=${maxAge}`];
    if (isHttps(req, env.TRUST_PROXY)) parts.push('Secure');
    return parts.join('; ');
  }

  function issueCookie(req) {
    const payload = String(Date.now() + MAX_AGE_S * 1000);
    return `${COOKIE}=${payload}.${sign(payload)}; ${cookieAttrs(req, MAX_AGE_S)}`;
  }

  function clearCookie(req) {
    return `${COOKIE}=; ${cookieAttrs(req, 0)}`;
  }

  function isAuthed(req) {
    const value = parseCookies(req)[COOKIE];
    if (!value) return false;
    const dot = value.lastIndexOf('.');
    if (dot < 1) return false;
    const payload = value.slice(0, dot);
    const sig = value.slice(dot + 1);
    if (!/^\d{10,16}$/.test(payload)) return false;
    const expected = Buffer.from(sign(payload));
    const given = Buffer.from(sig);
    if (given.length !== expected.length || !crypto.timingSafeEqual(given, expected)) return false;
    return Number(payload) > Date.now();
  }

  return { passwordMatches, issueCookie, clearCookie, isAuthed };
}

module.exports = { createAuth, COOKIE };
