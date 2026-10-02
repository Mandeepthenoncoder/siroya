# Siroya backend + admin: build spec (single source of truth)

## Stack
- Node 22 (installed: v22.14.0). **Zero npm dependencies.** `node:http`, `node:sqlite` (`DatabaseSync`), `node:crypto`, `node:fs`, `node:path`, `node:vm`.
- Run: `node --no-warnings=ExperimentalWarning server/server.js` (port from `PORT`, default 5173). Serves the public site from `site/` at `/`, the admin app at `/admin/` (files in `site/admin/`), uploads at `/uploads/` (files in `site/uploads/`), and the JSON API at `/api/`.
- Database file: `server/data/siroya.db` (created on first run). `server/data/` is git-ignored.
- Config: `server/.env` (simple KEY=VALUE parser, no dependency). Keys: `PORT`, `ADMIN_PASSWORD`, `SESSION_SECRET`. If `server/.env` is missing on first run, the server creates it with a random `ADMIN_PASSWORD` (16+ chars) and `SESSION_SECRET` (32 bytes hex) and logs only "Admin password written to server/.env" (never log the value). `server/.env.example` documents the keys with placeholder values.

## Data model (SQLite)
```
settings(key TEXT PRIMARY KEY, value TEXT)            -- JSON-encoded values
categories(id INTEGER PK, slug TEXT UNIQUE NOT NULL, name TEXT NOT NULL, description TEXT DEFAULT '',
           image TEXT DEFAULT '', featured INTEGER DEFAULT 1, sort INTEGER DEFAULT 0,
           created_at TEXT, updated_at TEXT)
collections(id INTEGER PK, slug TEXT UNIQUE NOT NULL, name TEXT NOT NULL, kind TEXT DEFAULT '', short TEXT DEFAULT '',
           intro TEXT DEFAULT '', hero TEXT DEFAULT '', cover TEXT DEFAULT '', quote TEXT DEFAULT '',
           chapters TEXT DEFAULT '[]',  -- JSON [{title,text,img}]
           active INTEGER DEFAULT 1, sort INTEGER DEFAULT 0, created_at TEXT, updated_at TEXT)
products(id INTEGER PK, handle TEXT UNIQUE NOT NULL, code TEXT DEFAULT '', name TEXT NOT NULL,
           collection TEXT DEFAULT '',  -- collection slug
           category TEXT DEFAULT '',    -- category slug
           metal TEXT DEFAULT '', weight TEXT DEFAULT '', stones TEXT DEFAULT '', description TEXT DEFAULT '',
           images TEXT DEFAULT '[]',    -- JSON array of URL paths, first = primary
           featured INTEGER DEFAULT 0, status TEXT DEFAULT 'active',  -- active | draft | archived
           sort INTEGER DEFAULT 0, created_at TEXT, updated_at TEXT)
stores(id INTEGER PK, slug TEXT UNIQUE NOT NULL, name TEXT NOT NULL, address TEXT DEFAULT '', hours TEXT DEFAULT '',
           phone TEXT DEFAULT '', map TEXT DEFAULT '', image TEXT DEFAULT '', sort INTEGER DEFAULT 0)
leads(id INTEGER PK, created_at TEXT, name TEXT, phone TEXT, store TEXT, when_pref TEXT,
      product TEXT, code TEXT, collection TEXT, url TEXT,
      gclid TEXT, gbraid TEXT, wbraid TEXT, utm_source TEXT, utm_medium TEXT, utm_campaign TEXT,
      utm_term TEXT, utm_content TEXT, landing TEXT, user_agent TEXT)
```
**Seed** (first run, empty DB): evaluate `site/assets/js/data.js` in a `node:vm` sandbox (`{window:{}}`) and import `window.SIROYA`: site -> settings, categories (all featured=1, sort = index), collections, products (`id` -> `handle`), stores (`img` -> `image`). Image paths stay as they are (`assets/img/...`).

## Public API (no auth)
`GET /api/catalog` -> 200, `Cache-Control: no-store`. Shape is IDENTICAL to `window.SIROYA` in `site/assets/js/data.js`, so the front end can drop it in:
```
{ site: { name, tagline, since, whatsapp, phone, email, socials:{instagram,facebook,youtube}, leadEndpoint:"/api/leads" },
  categories: [ { slug, name, img, description, featured:boolean, sort } ],          // all categories, sorted by sort
  collections: [ { slug, name, kind, short, intro, hero, cover, chapters:[{title,text,img}], quote, sort } ],  // active only
  products: [ { id /*= handle*/, code, name, collection, category, metal, weight, stones, images:[], description, featured:boolean, sort } ], // status=active only
  stores: [ { slug, name, address, hours, phone, map, img } ] }
```
`POST /api/leads` -> body JSON (the `lead` object built in `site/assets/js/site.js`: name, phone, store, when, product, code, collection, url, gclid, gbraid, wbraid, utm_*, landing, ts). Accept `application/json` and `text/plain` (sendBeacon). Validate: name 1-120 chars, phone 6-20 digits after stripping non-digits; trim every field to 500 chars. Store `user_agent`. Return `201 {ok:true}`. Simple in-memory rate limit: 20 per IP per 10 minutes -> 429.

## Admin API (auth required unless noted)
- Auth: `POST /api/admin/login {password}` (no auth) -> constant-time compare with ADMIN_PASSWORD -> sets cookie `siroya_admin=<payload>.<hmac>` (HttpOnly, SameSite=Strict, Path=/, Max-Age 7 days; payload = expiry timestamp; HMAC-SHA256 with SESSION_SECRET). Login rate limit: 10 attempts / 15 min / IP -> 429. `POST /api/admin/logout` clears it. `GET /api/admin/me` -> `{ok:true}` or 401.
- All mutating admin requests must have `Content-Type: application/json` (rejects cross-site form posts) and a valid cookie; else 401/415.
- `GET /api/admin/stats` -> `{products:{active,draft,archived}, categories, collections, leads:{total,last7}}`
- Categories: `GET /api/admin/categories`, `POST /api/admin/categories`, `PUT /api/admin/categories/:id`, `DELETE /api/admin/categories/:id` (409 if products use it, unless `?force=1`, which clears `category` on those products), `PUT /api/admin/categories/order {ids:[...]}` (sets sort by array index).
- Collections: same five routes under `/api/admin/collections` (`chapters` sent/returned as array). DELETE returns 409 if products use it unless `?force=1`.
- Products: `GET /api/admin/products?q=&collection=&category=&status=&featured=&page=1&per=50` -> `{items, total, page, per}` (q matches name/code/handle/description, case-insensitive). `GET /api/admin/products/:id`, `POST`, `PUT /:id`, `DELETE /:id`, `POST /api/admin/products/bulk {ids:[], action:"activate"|"draft"|"archive"|"delete"|"feature"|"unfeature"|"set_category", value}`.
  Products returned to admin use field `handle` (not `id` alias) plus numeric `id`, `images` as array, booleans for featured.
- Stores: same five routes under `/api/admin/stores`.
- Settings: `GET /api/admin/settings` -> site object; `PUT /api/admin/settings` (partial merge).
- Uploads: `POST /api/admin/upload {filename, dataUrl}` where dataUrl is `data:image/(jpeg|png|webp);base64,...` (the admin resizes client-side first). Max 10 MB decoded. Server verifies magic bytes match the declared type, writes `site/uploads/<yyyy>/<mm>/<random-16-hex>.<ext>`, returns `{url:"uploads/yyyy/mm/x.jpg"}` (relative, no leading slash, so it works from site pages).
- Leads: `GET /api/admin/leads?page=&per=` -> `{items,total}`; `GET /api/admin/leads.csv` -> CSV download (escape quotes, prefix cells starting with `= + - @` with `'` to prevent CSV injection).
- Validation: slugs/handles `^[a-z0-9]+(?:-[a-z0-9]+)*$`, auto-generated from name if blank, unique (409 on clash). Strings trimmed, length capped. Unknown fields ignored. Errors: `{error:"message"}` with 400/401/404/409/413/415/429.

## Static serving rules
- Resolve paths with `path.resolve` and refuse anything outside the served root (path traversal). Decode URI safely. Directory -> `index.html`. Correct MIME for html/css/js/json/png/jpg/jpeg/webp/svg/ico/woff2/mp4/csv. `/admin` -> redirect `/admin/`. Never serve `server/`, `.env`, `data/`.
- Security headers on every response: `X-Content-Type-Options: nosniff`, `Referrer-Policy: strict-origin-when-cross-origin`, `X-Frame-Options: SAMEORIGIN`. Admin pages also `Cache-Control: no-store`.

## Admin app (`site/admin/index.html`, `admin.css`, `admin.js`)
Vanilla JS single page, hash routing (`#/products`, `#/products/new`, `#/products/12`, `#/categories`, `#/collections`, `#/stores`, `#/leads`, `#/settings`, `#/` dashboard). Brand look: cream `#F5F2EC` background, red `#981E1D` primary, gold `#B49151` accents, Cinzel headings, Outfit body (Google Fonts), Phosphor icons (unpkg `@phosphor-icons/web@2.1.1`), 10px radius surfaces, 8px controls, logo `../assets/img/logo/siroya-red.png`. Fully usable on a phone (sidebar becomes bottom tab bar or drawer; tables become cards).
- Login screen (password only) -> shows errors inline; 429 message.
- Dashboard: counts, last 5 leads, quick links.
- Products: search, filters (collection, category, status, featured), list with thumbnail, name, code, collection, category, status chip, featured star toggle inline; checkbox multi-select + bulk actions; "New product". Edit page: all fields (name, handle auto from name, code, collection select, category select, metal, weight, stones, description textarea with live character count, status select, featured toggle), image manager (multi upload with client-side resize to max 2000px long edge, JPEG q0.85 via canvas, drag to reorder or up/down buttons, remove, first = primary, upload progress), live preview card matching the public product card, Save, Delete (confirm dialog), "View on site" link (`../product.html?p=<handle>`).
- Categories: list with image, name, product count, "Show on homepage" toggle (featured), reorder (up/down buttons + drag), edit form (name, slug, description, image upload), delete with confirm (and force option explaining products will be un-categorised).
- Collections: list + edit (name, slug, kind, short, intro, quote, hero and cover upload, chapters editor add/remove/reorder with title/text/image), active toggle.
- Stores: list + edit.
- Leads: table (date, name, phone as `tel:` and WhatsApp links, product, store, campaign/gclid present), pagination, "Export CSV".
- Settings: WhatsApp number (digits only, validated), phone, email, socials.
- Every render uses `textContent` / escaped strings (no unescaped `innerHTML` of user data). Loading skeletons, empty states, error toasts, unsaved-changes guard on edit pages.

## Public site integration (`site/assets/js/site.js`)
- On boot, `fetch('/api/catalog', {cache:'no-store'})` with a 2.5 s timeout; on success replace `SIROYA.site/categories/collections/products/stores` with the response, otherwise keep `data.js` (static hosting fallback). Then render. Pages must not flash empty content (render after load; keep header/footer immediate).
- Home "Find your design": show categories with `featured:true` sorted by `sort` (if none featured, show all), linking to `category.html?c=<slug>`; grid adapts to any count (1 to 12).
- New page `site/category.html?c=<slug>`: title + description + optional image, filter chips by collection, product grid (same card), empty state with WhatsApp CTA, "Other categories" rail. Title/meta set from data.
- Product page: product `description` shown; collection page chips use category names from catalog.
- Images: any product/category/collection image path may be `assets/...` or `uploads/...` (both relative to site root).
