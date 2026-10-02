# Siroya server

One Node process serves the public site, the admin app, uploaded images and the JSON API. It has no npm dependencies and needs Node 22.13 or newer (it uses the built-in `node:sqlite`).

```
npm start          # http://localhost:5173 (or PORT from server/.env)
npm run dev        # http://localhost:5180
node --no-warnings=ExperimentalWarning server/server.js --port=8080
```

| URL | Serves |
|---|---|
| `/` | `site/` (public pages) |
| `/admin/` | `site/admin/` (admin app, `Cache-Control: no-store`). `/admin` redirects here. |
| `/uploads/...` | `site/uploads/` (images uploaded from the admin, cached for a year) |
| `/api/...` | JSON API (below) |

## First run

1. If `server/.env` is missing, the server creates it with a random `ADMIN_PASSWORD` and `SESSION_SECRET` and logs only `Admin password written to server/.env`. Open that file to read the password. To change it, edit the file and restart. Changing the password signs every admin session out.
2. The database `server/data/siroya.db` is created and migrated (`settings.schema_version`).
3. If the database is empty, it is seeded once from `site/assets/js/data.js` (run in a `node:vm` sandbox): site settings, categories (all shown on the homepage), collections, products (`id` becomes `handle`) and stores.

To start again from `data.js`, stop the server and delete `server/data/`.

## Config (`server/.env`)

| Key | Meaning |
|---|---|
| `PORT` | Port, default 5173. `--port=<n>` and the `PORT` environment variable win over the file. |
| `ADMIN_PASSWORD` | Admin password. Use 12 or more characters. |
| `SESSION_SECRET` | Signs the admin cookie (64 hex characters). |
| `HOST` | Optional bind address. Default is all interfaces, so a phone on the same Wi-Fi can open `http://<computer-ip>:<port>`. |
| `TRUST_PROXY` | Optional. Set to `1` only behind a reverse proxy, so client IPs (rate limits) and https (Secure cookie) come from `X-Forwarded-For` / `X-Forwarded-Proto`. |

One `KEY=VALUE` per line. Do not put comments after a value. Never commit `.env` (it is git-ignored, as is `data/`).

## Public API

### `GET /api/catalog`
`Cache-Control: no-store`, gzip when accepted. Same shape as `window.SIROYA` in `data.js`:

```
{ site: { name, tagline, since, whatsapp, phone, email, socials: { instagram, facebook, youtube }, leadEndpoint: "/api/leads" },
  categories:  [ { slug, name, img, description, featured, sort } ],                         // all, by sort
  collections: [ { slug, name, kind, short, intro, hero, cover, chapters: [{ title, text, img }], quote, sort } ], // active only
  products:    [ { id /* handle */, code, name, collection, category, metal, weight, stones, images: [], description, featured, sort } ], // status active only
  stores:      [ { slug, name, address, hours, phone, map, img } ] }
```

### `POST /api/leads`
Body: the lead object from `site.js` (`name, phone, store, when, product, code, collection, url, gclid, gbraid, wbraid, utm_*, landing`). `Content-Type` `application/json` or `text/plain` (sendBeacon). Name 1 to 120 characters, phone 6 to 20 digits. Every field is trimmed to 500 characters. Returns `201 {ok:true}`. Limit: 20 per IP per 10 minutes (then `429` with `Retry-After`).

## Admin API

Every admin route except `login` and `logout` needs the `siroya_admin` cookie (`401` otherwise). Every `POST`, `PUT` and `DELETE` must send `Content-Type: application/json`, including `DELETE` requests with no body (`415` otherwise). Bodies are capped at 200 KB (12 MB for uploads), `413` beyond. Errors are always `{ "error": "message" }` with 400, 401, 404, 405, 409, 413, 415 or 429, and messages are written to be shown to the admin as is.

### Session
| Route | Result |
|---|---|
| `POST /api/admin/login {password}` | `200 {ok:true}` and sets the cookie (HttpOnly, SameSite=Strict, 7 days). `401` wrong password. 10 attempts per IP per 15 minutes, then `429`. |
| `POST /api/admin/logout` | `200 {ok:true}`, clears the cookie. |
| `GET /api/admin/me` | `{ok:true}` or `401`. |
| `GET /api/admin/stats` | `{ products: {active, draft, archived}, categories, collections, leads: {total, last7} }` |

### Categories, collections, stores
The same routes for each `<res>` in `categories`, `collections`, `stores`:

| Route | Result |
|---|---|
| `GET /api/admin/<res>` | `{ items: [...] }` sorted by `sort` |
| `GET /api/admin/<res>/:id` | one item |
| `POST /api/admin/<res>` | `201` new item. `name` required. Blank `slug` is generated from the name (made unique with `-2`, `-3`). An explicit slug that is taken returns `409`. New items go last unless `sort` is sent. |
| `PUT /api/admin/<res>/:id` | updated item. Partial: only the fields sent change. Renaming a category or collection slug also updates every product that used it. |
| `DELETE /api/admin/<res>/:id` | `{ok:true, cleared}`. For categories and collections: `409 {error, products: <count>}` when products use it, unless `?force=1`, which clears that field on those products. |
| `PUT /api/admin/<res>/order {ids:[...]}` | sets `sort` to each id's index. Returns `{ok:true, items}`. |

Item shapes (what the admin receives and may send back; unknown fields are ignored):

```
category:   { id, slug, name, description, image, featured: bool, sort, product_count, created_at, updated_at }
collection: { id, slug, name, kind, short, intro, hero, cover, quote, chapters: [{title, text, img}], active: bool, sort,
              product_count, created_at, updated_at }
store:      { id, slug, name, address, hours, phone, map, image, sort }
```

Note the admin field is `image` (database column) while the public catalog calls it `img`. On input, `img` is accepted as an alias for `image`.

### Products
| Route | Result |
|---|---|
| `GET /api/admin/products?q=&collection=&category=&status=&featured=&page=1&per=50` | `{ items, total, page, per }`. `q` matches name, code, handle and description (case-insensitive). `collection=_none` / `category=_none` finds products without one. `status` is `active`, `draft` or `archived` (blank for all). `featured` is `1` or `0`. `per` max 200. |
| `GET /api/admin/products/:id` | one product |
| `POST /api/admin/products` | `201` new product. `name` required, `handle` generated when blank. |
| `PUT /api/admin/products/:id` | updated product (partial) |
| `DELETE /api/admin/products/:id` | `{ok:true}` |
| `POST /api/admin/products/bulk {ids, action, value}` | `{ok:true, affected}`. Actions: `activate`, `draft`, `archive`, `delete`, `feature`, `unfeature`, `set_category` (`value` = category slug, blank clears), `set_collection` (`value` = collection slug). Runs in one transaction. |

```
product: { id, handle, code, name, collection, category, metal, weight, stones, description, images: [], featured: bool,
           status: "active" | "draft" | "archived", sort, created_at, updated_at }
```

`collection` and `category` must be existing slugs (or blank). Images are an ordered list; the first is the primary image.

### Settings
`GET /api/admin/settings` returns the site object (without `leadEndpoint`). `PUT /api/admin/settings` merges the fields sent: `name`, `tagline`, `since`, `whatsapp` (8 to 15 digits; spaces, `+` and dashes are stripped), `phone`, `email`, `socials: {instagram, facebook, youtube}` (https links or blank). Returns the updated object.

### Uploads
`POST /api/admin/upload {filename, dataUrl}` with `dataUrl` = `data:image/(jpeg|png|webp);base64,...`, at most 10 MB decoded. The file content must match the declared type. Saved as `site/uploads/<yyyy>/<mm>/<random>.<ext>`. Returns `201 {url: "uploads/yyyy/mm/x.jpg", bytes}`; use `url` as is in any image field.

### Leads
`GET /api/admin/leads?page=&per=` returns `{ items, total, page, per }`, newest first. Each item has every lead column (`when_pref`, plus `when` as an alias). `GET /api/admin/leads.csv` downloads every lead as CSV (UTF-8 with BOM for Excel). Cells starting with `= + - @` are prefixed with `'` so spreadsheets never run them as formulas.

### Image and link rules
Image fields accept `assets/...`, `uploads/...` or an `https://` URL. Store `map` and social links must be `http(s)://`. Anything else is rejected with `400`, so no `javascript:` link can reach the public site.

## Security notes
- Static files resolve inside `site/` only: `..` segments get `403`, hidden files (`.env`, `.git`), backslashes, drive letters and symlinks out of `site/` are refused. `server/` and `server/data/` are never reachable.
- Every response sends `X-Content-Type-Options: nosniff`, `Referrer-Policy: strict-origin-when-cross-origin` and `X-Frame-Options: SAMEORIGIN`.
- All SQL is prepared statements; multi-row writes run in transactions.
- One log line per request: `METHOD /path STATUS 1.2ms` (no query strings, no bodies). Unexpected errors log the stack on the server and return `500 {error}` without details.

## Deploying
- Run behind a reverse proxy with https (Caddy, nginx) and set `TRUST_PROXY=1`.
- Back up `server/data/siroya.db` (stop the server or use `sqlite3 .backup`), `server/.env` and `site/uploads/`.
- Keep `site/uploads/` out of git; it is content, like the database.

## Files
```
server/server.js         entry: config, database, HTTP pipeline, error handling, logging
server/lib/env.js        .env loader (creates it on first run)
server/lib/db.js         node:sqlite, statement cache, transactions, migrations
server/lib/seed.js       first-run import of site/assets/js/data.js
server/lib/http.js       JSON responses, body limits, cookies, gzip
server/lib/auth.js       signed session cookie, constant-time password check
server/lib/ratelimit.js  in-memory per-IP limits
server/lib/static.js     static files (traversal-safe, ETag, gzip, ranges)
server/lib/router.js     tiny router
server/lib/validate.js   input cleaning
server/lib/uploads.js    data URL decoding, magic-byte check, file write
server/lib/csv.js        CSV export with formula-injection guard
server/lib/api/public.js catalog and leads
server/lib/api/admin.js  admin routes
```
