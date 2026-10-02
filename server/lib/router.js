'use strict';
/* Tiny exact-match router. ":name" segments match positive integer ids. */

class Router {
  constructor() {
    this.routes = [];
  }

  add(method, pattern, handler, opts = {}) {
    const keys = [];
    const source = pattern
      .replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
      .replace(/\/:(\w+)/g, (_, key) => { keys.push(key); return '/([1-9]\\d{0,15})'; });
    this.routes.push({ method, re: new RegExp(`^${source}$`), keys, handler, opts });
    return this;
  }

  get(p, h, o) { return this.add('GET', p, h, o); }
  post(p, h, o) { return this.add('POST', p, h, o); }
  put(p, h, o) { return this.add('PUT', p, h, o); }
  delete(p, h, o) { return this.add('DELETE', p, h, o); }

  /* Returns { route, params } on a match, { allowed: [...] } when only the
     method differs, or null when nothing matches the path. */
  match(method, path) {
    const allowed = new Set();
    for (const route of this.routes) {
      const m = route.re.exec(path);
      if (!m) continue;
      if (route.method !== method && !(method === 'HEAD' && route.method === 'GET')) {
        allowed.add(route.method);
        continue;
      }
      const params = {};
      route.keys.forEach((k, i) => { params[k] = Number(m[i + 1]); });
      return { route, params };
    }
    return allowed.size ? { allowed: [...allowed] } : null;
  }
}

module.exports = { Router };
