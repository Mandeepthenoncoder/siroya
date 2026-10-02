# Traffic dashboard: build spec

Goal: the admin dashboard shows how the site is doing, from three sources:
1. **Website analytics (first-party, works from day one)**: our own privacy-friendly event log, no cookies.
2. **Google Search Console**: clicks, impressions, CTR, position, queries, pages.
3. **Google Analytics 4**: users, sessions, channels, landing pages.

Stack rules (same as docs/BACKEND-SPEC.md): Node 22, zero npm dependencies (`node:crypto`, `node:https`, `node:sqlite`), vanilla JS admin, brand look. Read the existing code first and reuse its helpers: `server/lib/http.js` (json, HttpError), `server/lib/validate.js`, `server/lib/db.js` (stmt, getSetting/setSetting, now, migrations), `server/lib/router.js`, and the admin modules in `site/admin/` (lib.js helpers, routing, toasts, escaping).

## 1. First-party analytics

### Table (add as a new idempotent migration step)
```
events(id INTEGER PK, ts TEXT NOT NULL, day TEXT NOT NULL,        -- day = YYYY-MM-DD in Asia/Dubai
       type TEXT NOT NULL, path TEXT, page_type TEXT,
       item TEXT, collection TEXT, category TEXT,
       sid TEXT, is_new INTEGER DEFAULT 0,
       source TEXT, medium TEXT, campaign TEXT, ref_host TEXT,
       has_gclid INTEGER DEFAULT 0, device TEXT)
INDEX events_day ON events(day); INDEX events_type_day ON events(type, day)
```
Allowed `type`: page_view, view_item, view_item_list, filter_collection, whatsapp_click, generate_lead, story_open, intro_complete. Retention: delete rows older than 400 days (run at startup and once a day).

### `POST /api/track` (public)
- Body JSON (accept `application/json` and `text/plain` from sendBeacon), max 4 KB: `{t, p, pt, i, c, k, sid, n, src, med, cmp, ref, g}` = type, path, page_type, item, collection, category, session id, is_new, utm_source, utm_medium, utm_campaign, referrer host, gclid/gbraid/wbraid present (bool).
- Validate: type in allow-list; sid `^[a-f0-9]{16}$`; strings single-line, trimmed, capped (path 200, others 100). Drop known bots by User-Agent (`bot|crawl|spider|slurp|headless|lighthouse|preview|facebookexternalhit|whatsapp`). Device from UA: mobile / tablet / desktop.
- **Source** derivation on the server: has_gclid or utm_medium in (cpc, ppc, paid) with google source → `google_ads`; utm_source present → that source (lowercased); referrer host google.* → `google_organic`; bing/yahoo/duckduckgo → `other_search`; facebook/instagram/t.co/x.com/linkedin/youtube/pinterest/tiktok → `social`; whatsapp → `whatsapp`; empty referrer or own host → `direct`; else `referral`.
- Never store IP addresses or full user agents. Rate limit 120 events per IP per minute (in memory). Always reply `204` quickly (even when dropped), `413` over size.

### `GET /api/admin/traffic?range=7|30|90` (auth)
Returns current period and previous period of the same length:
```
{ range, from, to,
  totals: { visitors, sessions?, page_views, whatsapp_clicks, leads, conversion_rate },   // visitors = distinct sid; leads from the leads table; conversion = (distinct sids with whatsapp_click or generate_lead) / visitors
  previous: { same keys },
  daily: [ { day, visitors, page_views, whatsapp_clicks, leads } ],     // every day in range, zero-filled
  sources: [ { source, visitors, whatsapp_clicks, leads } ],
  campaigns: [ { campaign, visitors, whatsapp_clicks, leads } ],          // utm_campaign, top 15
  top_pages: [ { path, views, visitors } ],                               // top 15
  top_collections: [ { collection, views } ], top_products: [ { item, views, whatsapp_clicks, leads } ],  // names resolved from catalog tables
  devices: [ { device, visitors } ], new_vs_returning: { new, returning } }
```

## 2. Google connection (Search Console + GA4)

Auth: a Google Cloud **service account** (JSON key). The client grants that service-account email access to the Search Console property (Users and permissions, Restricted is enough) and to the GA4 property (Viewer). One key serves both.

- Store in settings key `google` (JSON): `{ client_email, private_key, private_key_id, gsc_site, ga4_property, connected_at, last_sync, last_error }`. **The private key never leaves the server**: no API returns it, logs never print it.
- JWT bearer flow: header `{alg:"RS256",typ:"JWT",kid}`; claims `{iss: client_email, scope: "https://www.googleapis.com/auth/webmasters.readonly https://www.googleapis.com/auth/analytics.readonly", aud: "https://oauth2.googleapis.com/token", iat, exp: iat+3600}`; sign with `crypto.createSign("RSA-SHA256")`; POST `grant_type=urn:ietf:params:oauth:grant-type:jwt-bearer&assertion=...` to `https://oauth2.googleapis.com/token`. Cache the access token in memory until 60 s before expiry.
- Outbound hosts are **fixed constants**: `oauth2.googleapis.com`, `searchconsole.googleapis.com` (or `www.googleapis.com/webmasters/v3`), `analyticsdata.googleapis.com`. Never take a URL from user input (ignore `token_uri` in the key file). 15 s timeout per request. For tests only, `GOOGLE_API_ORIGIN` env var may point every host at a local mock **when `NODE_ENV=test`**.
- Endpoints (auth):
  - `GET /api/admin/google` -> `{ connected, client_email, gsc_site, ga4_property, connected_at, last_sync, last_error }`
  - `PUT /api/admin/google` -> body `{ service_account_json?, gsc_site?, ga4_property? }`. Validate the JSON: `type === "service_account"`, `client_email`, PEM `private_key`. `gsc_site` like `sc-domain:siroya.com` or `https://siroya.com/`. `ga4_property` digits only.
  - `DELETE /api/admin/google` -> disconnect (wipe key and cached tokens/data).
  - `POST /api/admin/google/test` -> gets a token, lists Search Console sites the key can see (`GET /webmasters/v3/sites`) and, if `ga4_property` set, runs a 1-day GA4 report. Returns `{ ok, sites:[...], ga4_ok, error }` with human-readable errors (e.g. "The service account has no access to sc-domain:siroya.com. Add <email> as a user in Search Console").
  - `GET /api/admin/search?range=7|28|90[&refresh=1]` -> Search Console `searchAnalytics/query` (dataState "all"; dates end yesterday): `{ range, totals:{clicks,impressions,ctr,position}, previous:{...}, daily:[{date,clicks,impressions,ctr,position}], queries:[{query,clicks,impressions,ctr,position}] (top 50), pages:[{page,clicks,impressions,ctr,position}] (top 25), devices:[...], countries:[...] (top 10), fetched_at }`
  - `GET /api/admin/analytics?range=7|30|90[&refresh=1]` -> GA4 `properties/{id}:runReport`: `{ totals:{activeUsers,newUsers,sessions,engagementRate,averageSessionDuration}, previous, daily:[{date,activeUsers,sessions}], channels:[{channel,sessions,users}], landing_pages:[{page,sessions}], fetched_at }`
  - Cache Google responses in memory (and in settings for resilience) for 6 hours per range; `refresh=1` bypasses, limited to once per 5 minutes. When not connected: `409 {error:"Google is not connected", code:"not_connected"}`.

## 3. Admin UI

- **Dashboard** (top of `#/`): range-agnostic "Last 7 days" row of cards: Visitors, WhatsApp clicks, Enquiries, Conversion rate, each with the change versus the previous 7 days (up/down, coloured with brand red for down and a deep green `#2F6B4F` for up, plus a text arrow so colour is not the only signal) and a small sparkline. A second row: "Google Search" mini card (clicks, impressions, average position) or a "Connect Search Console" call to action. Link "View traffic".
- **Traffic page** `#/traffic` with tabs: **Website**, **Google Search**, **Google Analytics**. Range selector (7 / 30 / 90 days; Search uses 7 / 28 / 90). Each tab: KPI cards with deltas, one main trend chart (SVG line/area, single series switchable: visitors / page views / WhatsApp clicks / enquiries; hover tooltip with the exact value and date; accessible table fallback), and ranked tables (sources, campaigns, top pages, top products; queries and pages for Search with CTR and position; channels and landing pages for GA4). Mobile: cards 2 per row, tables become stacked cards, chart full width.
- **Settings > Google connection** (`#/settings` section): status pill, step-by-step setup guide (create a Google Cloud project, enable Search Console API and Google Analytics Data API, create a service account, create a JSON key, add the service-account email to Search Console and GA4), a file input or textarea to load the JSON key (shows only the client email back), Search Console property picker filled from "Test connection", GA4 property ID field, Save, Test, Disconnect (confirm dialog).
- Charts: hand-built SVG (no chart library). One accent colour (brand red `#981E1D`) for the main series, previous period as a dashed ink-grey line, gridlines faint, numbers in tabular figures, values formatted with thousands separators, CTR and rates as percentages with one decimal, position with one decimal.
- States: skeleton loaders, "Collecting data: numbers appear after the first visits" empty state, Google not connected state with the setup button, Google error state with the server's message and a Retry button.

## 4. Public tracking script `site/assets/js/track.js`
- Loaded on every public page **before** `site.js`. Wraps `window.dataLayer.push` (create the array if missing) so every event site.js already pushes (`view_item_list`, `view_item`, `filter_collection`, `whatsapp_click`, `generate_lead`, `story_open`, `intro_complete`) is also sent to `/api/track`, and sends one `page_view` per page load.
- Session id: random 16 hex chars in `sessionStorage` (`siroya_sid`); `is_new` from a `localStorage` flag `siroya_seen` (no identifier stored). Attribution from the existing `localStorage` key `siroya_attr` (written by site.js; read it, do not change its format) plus the current URL's utm params and `document.referrer` host.
- Respect `navigator.doNotTrack === "1"` and `navigator.globalPrivacyControl`: send nothing. Never send on `file:`. Use `navigator.sendBeacon` with a `text/plain` Blob, fallback `fetch(..., {keepalive:true})`. All in try/catch; never throw or block the page. Under 2 KB minified-equivalent.
