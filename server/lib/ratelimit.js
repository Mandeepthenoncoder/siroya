'use strict';
/* In-memory sliding-window rate limiter keyed by client IP. */

function createLimiter({ limit, windowMs, maxKeys = 20000 }) {
  const hits = new Map();

  function prune(key, t) {
    const list = hits.get(key);
    if (!list) return [];
    while (list.length && list[0] <= t - windowMs) list.shift();
    if (!list.length) hits.delete(key);
    return list;
  }

  /* Records one attempt. Returns { ok, retryAfter } (seconds). */
  function hit(key) {
    const t = Date.now();
    const list = prune(key, t);
    if (list.length >= limit) {
      return { ok: false, retryAfter: Math.max(1, Math.ceil((list[0] + windowMs - t) / 1000)) };
    }
    if (!hits.has(key)) {
      if (hits.size >= maxKeys) hits.delete(hits.keys().next().value);
      hits.set(key, list);
    }
    list.push(t);
    return { ok: true, retryAfter: 0 };
  }

  function reset(key) { hits.delete(key); }

  const timer = setInterval(() => {
    const t = Date.now();
    for (const key of [...hits.keys()]) prune(key, t);
  }, Math.min(windowMs, 5 * 60 * 1000));
  timer.unref();

  return { hit, reset };
}

module.exports = { createLimiter };
