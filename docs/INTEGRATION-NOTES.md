# Integration notes (from the traffic and homepage-banner builds)


## TRAFFIC (final, after review fixes)

Nothing existing was modified. In this fix pass only analytics.js, google.js, api/traffic.js, traffic.test.js, site/admin/traffic.js and traffic.css changed (all are new files). track.js and track_browser_test.py are unchanged. The scratchpad harness applied every step below in memory to the current files, and every anchor matched exactly once.

1) server/server.js
 a. After line 16, `const { registerAdmin } = require('./lib/api/admin');`, add:
    const { registerTraffic } = require('./lib/api/traffic');
 b. After line 40, `registerAdmin(router, { db, auth, env, loginLimiter, siteDir });`, add:
    registerTraffic(router, { db, env });
 c. NEW (finding 11). In handleApi, inside `if (MUTATING.has(req.method)) {`, replace lines 57-61 (from `const allowedTypes = ...` through `body = await readJson(req, opts.limit || DEFAULT_BODY_LIMIT);`) with:
      const allowedTypes = opts.contentTypes || ['application/json'];
      if (opts.beacon) {
        // Beacon routes always reach their handler (it answers 204): a wrong
        // content type or a body that is not a JSON object arrives as null.
        try {
          const parsed = await readJson(req, opts.limit || DEFAULT_BODY_LIMIT);
          body = allowedTypes.includes(contentType(req)) ? parsed : null;
        } catch (err) {
          if (err instanceof HttpError && err.status === 413) throw err;
          body = null;
        }
      } else {
        if (!allowedTypes.includes(contentType(req))) {
          throw new HttpError(415, `Content-Type must be ${allowedTypes.join(' or ')}`);
        }
        body = await readJson(req, opts.limit || DEFAULT_BODY_LIMIT);
      }
    The /api/track route already passes `beacon: true`. Without step c, junk bodies still get 400/415. That is harmless, but it does not meet the spec.

2) server/lib/db.js MIGRATIONS
 After the v1 template string that closes on line 88 (`  \`,`) and before `];` on line 89, add:
    // v2: first-party analytics events + daily rollups (docs/TRAFFIC-SPEC.md)
    require('./analytics').ANALYTICS_SCHEMA_SQL,
 If the other workflow already took v2, use the next free number. The SQL is idempotent and creates:
 - the events table and indexes events_day, events_type_day and events_sid_day (new);
 - the rollup tables events_daily and events_daily_dim (new).
 registerTraffic runs the same SQL at startup, so a database that already applied an older v2 still gets the new tables and index. There is no circular require.

3) Optional, server/lib/env.js. In the env object (lines 68-74), add:
    TRUST_PROXY_HOPS: get('TRUST_PROXY_HOPS'),
    PUBLIC_ORIGIN: get('PUBLIC_ORIGIN'),
 Without this, both values are read only from process.env.
 - TRUST_PROXY_HOPS is the number of trusted proxies in front of Node (default 1).
 - PUBLIC_ORIGIN (e.g. https://siroya.com) is needed only if a proxy rewrites Host and sends no X-Forwarded-Host.
 - Behind any proxy or CDN, set TRUST_PROXY=1. The server logs a one-time warning when proxied requests arrive with it off.
 These keys could also be documented in server/.env.example.

4) Public pages (finding 12: anchor on the tag, not the line number)
 Insert `<script src="assets/js/track.js"></script>` directly before `<script src="assets/js/site.js"></script>`, as a plain synchronous script. Current lines (data.js / site.js):
 - index.html 133/134
 - collections.html 46/47
 - collection.html 22/23
 - category.html 22/23
 - product.html 20/21
 - about.html 203/204
 Do not add it to admin/index.html.

5) Admin (anchors unchanged)
 - site/admin/index.html: after line 14 (`<link rel="stylesheet" href="admin.css">`) add:
    <link rel="stylesheet" href="traffic.css">
 - admin.js:
   a. After line 7 (the import from "./more.js") add:
      import { renderTrafficPage, renderDashboardTraffic } from "./traffic.js";
   b. After NAV line 13 (dashboard) add:
      { key: "traffic", href: "#/traffic", label: "Traffic", icon: "chart-line-up" },
   c. After ROUTES line 23 (dashboard route) add:
      { re: /^\/traffic$/, view: ctx => renderTrafficPage(ctx.root, ctx), nav: "traffic", title: "Traffic" },
   d. In dashboard():
      - before line 273, `ctx.root.append(`, add:
        const trafficBox = h("section", { class: "tr-dash-mount" });
      - in that append, put `trafficBox,` between `pageHead({ title: greeting(), subtitle: today }),` and `statsBox,`;
      - before line 288, `const [stats, leads] = await Promise.allSettled(`, add (not awaited):
        renderDashboardTraffic(trafficBox, ctx);
 - more.js:
   a. After line 6 (import from "./catalog.js") add:
      import { renderGoogleSettings } from "./traffic.js";
   b. Before line 210 add:
      const googleBox = h("div", { class: "edit-grid single" });
      and change line 210 to:
      ctx.root.replaceChildren(fr.head, h("p", { class: "page-sub page-sub-solo", text: "Contact details used across the website." }), form, googleBox, fr.savebar);
   c. After the wireForm(ctx, form, {...}); call (lines 214-223) add:
      renderGoogleSettings(googleBox, ctx);
   googleBox must stay outside #settings-form.

6) Message for the server.js / http.js owner (finding 2; existing files, not changed)
 http.js clientIp() (lines 125-131) takes the leftmost X-Forwarded-For entry when TRUST_PROXY is on. The client controls that entry, so the login limiter (10 per 15 min) and the leads limiter (20 per 10 min) can be bypassed with a random XFF.
 Fix: use the trusted (rightmost) hop. api/traffic.js exports clientAddress(req, trustProxy, hops) and ipBucket(addr), which buckets IPv4 by address and IPv6 by /64. In server.js line 96 you could use:
    ip: ipBucket(clientAddress(req, env.TRUST_PROXY))

7) Runtime behaviour to know
 - registerTraffic(router, { db, env }) returns { google, report, stop }.
 - It sets PRAGMA secure_delete=ON on the shared connection, so deleted rows are zeroed (a small extra cost for deletes).
 - Maintenance runs at startup and at 00:01 Dubai each day (timer unref'd). It purges anything older than 400 days and builds missing daily rollups for the last 180 closed days, one day per setImmediate.
 - The Google private key is stored AES-256-GCM encrypted under a key derived from SESSION_SECRET (settings.google.private_key_enc). A plaintext key saved earlier is re-encrypted on start. If SESSION_SECRET changes, the admin must load the JSON key again; status.last_error says so.

8) API contract changes since the build reports
 - GET /api/admin/traffic:
   - from/to cover complete days ending yesterday (Dubai), and previous is the same number of days before;
   - adds previous_daily (zero-filled) and today {day, visitors, page_views, whatsapp_clicks, leads};
   - conversion_rate is unrounded; sources show the top 25;
   - top_pages paths are always "/" or "/<page>.html" with at most one ?p= or ?c=.
 - Search Console ctr/position and GA4 engagementRate/averageSessionDuration are rounded to 6 decimals only.
 - A cached Google report expires when the date window moves past it.
 - POST /api/track:
   - always 204, except 413 over 4 KB (once step 1c is in);
   - silently drops beacons with DNT/GPC, a foreign Origin, or over a cap: 120/min per client, 2,000/min site-wide, 300 per session per day, 50,000 per Dubai day.

### traffic build note: analytics.js, google.js, traffic.js, traffic.test.js, index.js
Only new files were created; nothing existing was changed. These two edits wire it in (line numbers are from the current files).

1) server/server.js
 a. After line 16, `const { registerAdmin } = require('./lib/api/admin');`, add:
    const { registerTraffic } = require('./lib/api/traffic');
 b. After line 40, `registerAdmin(router, { db, auth, env, loginLimiter, siteDir });` (inside createApp), add:
    registerTraffic(router, { db, env });
 - This line also creates the events table if it is missing (safe to repeat), deletes events older than 400 days at startup and then every 24 h (the timer does not keep the process alive), and creates the Google client from db.getSetting/db.setSetting.
 - It returns { google, stop }; stop() clears the purge timer. No change is needed to start(), env.js or .env. NODE_ENV and GOOGLE_API_ORIGIN are read from process.env, and the origin override only works when NODE_ENV=test.

2) Migration step in server/lib/db.js
 Append a new entry to the MIGRATIONS array, after the v1 template string that closes at line 88 and before `];` on line 89:
    // v2: first-party analytics events (docs/TRAFFIC-SPEC.md)
    require('./analytics').ANALYTICS_SCHEMA_SQL,
 If the other workflow has already added a v2, use the next free number. There is no circular require: analytics.js only requires ./http. The SQL only creates things that don't exist yet (table events and indexes events_day, events_type_day).

3) Optional, in package.json scripts:
    "test": "node --no-warnings=ExperimentalWarning --test server/test/"
 server/test/index.js exists only so that command works on Node 22.14, which runs a folder passed to --test as a module instead of searching it. When the runner finds files on its own, index.js does nothing, so no test runs twice.

API contract for the admin UI and track.js:
- POST /api/track: public, accepts application/json or text/plain, body limit 4 KB. Fields: t, p, pt, i, c, k, sid, n, src, med, cmp, ref, g; these match what the other agent's track.js test sends. Replies 204 with no body, including when an event is dropped as a bot, as invalid, or over the 120 per IP per minute limit.
- GET /api/admin/traffic?range=7|30|90 (default 7): the shape in the spec, plus previous_from, previous_to and generated_at.
  - top_collections items: {collection, name, views}.
  - top_products items: {item, name, handle, views, whatsapp_clicks, leads}. item can be a product handle or code; both are looked up.
  - conversion_rate is a fraction (0.0123 means 1.23%).
  - Each visitor is credited to the first non-direct source of their session.
- GET /api/admin/google returns {connected, client_email, gsc_site, ga4_property, connected_at, last_sync, last_error}. The private key is never returned.
- PUT /api/admin/google: service_account_json may be JSON text or an object. sc-domain: values are lowercased, a URL property gets a trailing slash, and properties/123 becomes 123. Errors are 400 {error, code: invalid_key|invalid_site|invalid_property}.
- DELETE /api/admin/google wipes the key, cached token and cached reports, but keeps gsc_site and ga4_property. Like every mutating admin call, it needs Content-Type: application/json; admin lib.js already sends that.
- POST /api/admin/google/test returns {ok, client_email, sites:[siteUrl strings], site_permissions:[{site, permission}], gsc_ok, ga4_ok, error}.
- GET /api/admin/search?range=7|28|90 (default 28), optional &refresh=1:
  - returns {range, from, to, previous_from, previous_to, site, totals{clicks, impressions, ctr, position}, previous, daily[{date, ...}], queries (top 50), pages (top 25), devices, countries (top 10, ISO-3 uppercase), fetched_at, cached}
  - optional extras: throttled, or stale plus error.
  - ctr is a fraction. Days with no impressions show position 0. Dates run up to yesterday, Dubai time.
- GET /api/admin/analytics?range=7|30|90 (default 30), optional &refresh=1:
  - returns {range, from, to, previous_from, previous_to, property, totals{activeUsers, newUsers, sessions, engagementRate, averageSessionDuration}, previous, daily[{date, activeUsers, sessions}], channels[{channel, sessions, users}], landing_pages[{page, sessions}], fetched_at, cached}
- Error codes:
  - 409 {error, code}: not_connected (message "Google is not connected"), no_site, or no_property.
  - 400 for a bad range.
  - 502 {error, code}: google_auth, google_permission, google_not_found, google_api_disabled, google_quota, google_unavailable, google_bad_request, google_unreachable or google_error.
  - 504 google_timeout.
  - Google failures never come back as 401, because the admin UI reads 401 as "signed out".

### traffic build note: track.js, track_browser_test.py
1) SCRIPT TAG (the only change needed for the public site). In each public page, add this exact line directly after the data.js tag and directly before the site.js tag. It must be a plain synchronous script (no async or defer) inside <body>:
    <script src="assets/js/track.js"></script>
Result in every page:
    <script src="assets/js/data.js"></script>
    <script src="assets/js/track.js"></script>
    <script src="assets/js/site.js"></script>
Where it goes (line numbers as of now; the other workflow may shift them, so anchor on the site.js tag):
  - site/index.html: between line 132 (data.js) and line 133 (site.js). intro.js stays at the top of <body>. It only pushes intro_complete later, which track.js still sends.
  - site/collections.html: between line 46 (data.js) and line 47 (site.js).
  - site/collection.html: between line 22 (data.js) and line 23 (site.js).
  - site/category.html: between line 22 (data.js) and line 23 (site.js).
  - site/product.html: between line 20 (data.js) and line 21 (site.js).
  - site/about.html: between line 203 (data.js) and line 204 (site.js). The GSAP tags on lines 201-202 stay where they are.
Do not add it to site/admin/index.html.

2) PAYLOAD CONTRACT for whoever builds POST /api/track:
  - The body is JSON. It arrives as Content-Type "text/plain" (sendBeacon Blob) or "text/plain;charset=UTF-8" (fetch keepalive fallback). Parse the raw body whatever the content type is.
  - Fields: t, p, pt, i, c, k, sid, n, src, med, cmp, ref, g.
    - Empty fields are left out of the JSON, so treat a missing field as null or false.
    - n is the number 0 or 1, and it applies to the whole session.
    - g is a JSON boolean. It is present only when the session has utm or gclid attribution.
  - t: track.js sends page_view itself. It also forwards these dataLayer events: view_item, view_item_list, filter_collection, whatsapp_click, generate_lead, story_open, intro_complete. site.js also pushes filter_category from the category page chips. That event is not in the spec allow-list, so track.js does not send it. To track it, add it to the server allow-list and to the regex in mirror() in track.js.
  - p: the pathname with /index.html turned into "/", plus only "?p=<handle>" or "?c=<slug>", URL-encoded as in the address bar. Examples: "/", "/collection.html?c=sanskriti", "/product.html?p=sanskriti-1". The client does not shorten it, so the server must cap it at 200.
  - pt: the body's data-page value. Values: home, showcase (collections.html uses data-page="showcase"), collection, category, product, about. The dashboard may want to label "showcase" as "Collections".
  - i: the product handle (products.handle) from ?p= on the product page. If there is no ?p=, it is the event's item_id, which is the product code, or else its item_name. Resolve names by handle first, then by code. Product events do not include c or k; if the dashboard needs collection or category for products, join the products table on the handle.
  - c: the collection slug. It comes from ?c= on collection.html, view_item_list item_list_id, or filter_collection.collection.
  - k: the category slug. It comes from ?c= on category.html, item_list_id "category-<slug>" with the prefix removed, or filter_collection.category. A value of "all" is dropped.
  - src, med, cmp, ref, g are fixed for each session (sessionStorage key siroya_ses). They come from the landing URL's utm parameters, the gclid/gbraid/wbraid flag, and the external referrer host. Later internal pages keep the session's source instead of turning direct. A direct new session falls back to site.js's siroya_attr if it is under 90 days old. ref is only an external host: track.js drops it when it exactly equals location.hostname. The server should still map its own host, including the www/apex variant, to direct. Source derivation (google_ads, organic and so on) stays on the server as the spec says.
  - Strings are already single-line and capped at 100 characters on the client. The server should still validate them.

3) OPTIONAL staff opt-out: if localStorage key siroya_notrack is set to any value (admin and site share an origin), track.js sends nothing. The admin could set it, for example with a "Don't count my visits" toggle or automatically on login: localStorage.setItem('siroya_notrack','1'). Removing the key turns tracking back on.

4) TEST: run python server/test/track_browser_test.py. Optional environment variables: TRACK_TEST_PORT (default 5301), CHROME_PATH, HEADED=1. Until the pages carry the tag, the test's server inserts it before the site.js tag. Once the tag is in the pages it stops inserting it, so the test keeps working after integration. Exit code is 0 on pass and 1 on failure. A package.json script could be added later, e.g. "test:track": "python server/test/track_browser_test.py".

### traffic build note: traffic.js, traffic.css
No existing file was modified. Temporary harness site/admin/traffic-harness.html was DELETED. Mock + test scripts left only in scratchpad (scratchpad/traffic-ui/: traffic_mock.py, traffic_shots.py, traffic_func.py, crop.py). Mock server on 5302 stopped; ports 5301-5309 free.

1) site/admin/index.html — right after line 14 `<link rel="stylesheet" href="admin.css">` add:
   <link rel="stylesheet" href="traffic.css">

2) site/admin/admin.js
 a) After line 7 (import from "./more.js") add:
    import { renderTrafficPage, renderDashboardTraffic } from "./traffic.js";
 b) In NAV, after the dashboard item (line 13) add:
    { key: "traffic", href: "#/traffic", label: "Traffic", icon: "chart-line-up" },
    (No `tab: true`: admin.css .tabbar is a fixed 5-column grid = 4 tabs + More, so Traffic appears in the phone "More" sheet. If you want it as a phone tab, set tab:true on it AND remove tab:true from categories.)
 c) In ROUTES, after the dashboard route (line 23) add:
    { re: /^\/traffic$/, view: ctx => renderTrafficPage(ctx.root, ctx), nav: "traffic", title: "Traffic" },
    (Tab/range live in the hash: #/traffic?tab=website|search|analytics&range=7|30|90 (search 7|28|90); the page updates it with history.replaceState, no re-render.)
 d) In dashboard(ctx) (line 262): before `ctx.root.append(` add
    const trafficBox = h("section", { class: "tr-dash-mount" });
    then in the append put `trafficBox,` between `pageHead({ title: greeting(), subtitle: today }),` and `statsBox,`; and right after the append (before `const [stats, leads] = await Promise.allSettled(...)`) add
    renderDashboardTraffic(trafficBox, ctx);   // not awaited; handles its own skeleton/empty/error states

3) site/admin/more.js (settingsView)
 a) Add import at top: import { renderGoogleSettings } from "./traffic.js";
 b) Before the line `ctx.root.replaceChildren(fr.head, h("p", { class: "page-sub page-sub-solo", ... }), form, fr.savebar);` add
    const googleBox = h("div", { class: "edit-grid single" });
    and change that line to
    ctx.root.replaceChildren(fr.head, h("p", { class: "page-sub page-sub-solo", text: "Contact details used across the website." }), form, googleBox, fr.savebar);
 c) After the `wireForm(ctx, form, {...});` call add:
    renderGoogleSettings(googleBox, ctx);
    googleBox MUST be outside #settings-form (it has its own form/buttons; inside it would mark the contact form dirty). renderGoogleSettings chains onto ctx.guard (wireForm's unsaved-changes guard) automatically via a microtask. Deep link #/settings?section=google scrolls to and focuses the section (used by the dashboard CTA and the Traffic page "Google connection" button).

Exports: renderTrafficPage(container, ctx), renderDashboardTraffic(container, ctx), renderGoogleSettings(container, ctx). ctx = the router ctx (uses alive(), onLeave(), query, guard()/isDirty); all three also work with ctx omitted.

API contract the UI expects (per docs/TRAFFIC-SPEC.md; please align the backend):
- GET /api/admin/traffic|search|analytics?range=N (via lib api(), cached client-side 60s / 5min with lib cached(); keys "traffic:N","search:N","analytics:N"; logout's invalidate() clears them). Rates (conversion_rate, ctr, engagementRate) as fractions 0..1 (values >1 are treated as percentages). GA4 daily.date may be YYYYMMDD or YYYY-MM-DD. top_products/top_collections use `name` if present else `item`/`collection`. GSC countries alpha-3 or alpha-2 codes; devices any case.
- Comparison (dashed) line: if a response includes optional `previous_daily` (same row shape as daily) it is used; otherwise the page lazily fetches the next longer range (traffic/analytics 7->30, 30->90; search 7->28, 28->90) and slices the previous period out of it. 90-day views show no dashed line unless previous_daily is provided.
- Not connected: 409 {error, code:"not_connected"} -> connect state. Refresh: ?refresh=1; 429 -> info toast, data kept. Other errors: server `error` message shown with Retry.
- PUT /api/admin/google body: { service_account_json: <raw JSON TEXT string>, gsc_site?, ga4_property? } -> server should JSON.parse a string (and may also accept an object). Response may be the status object ({connected,...}); otherwise the UI re-GETs /google.
- POST /api/admin/google/test -> { ok, sites: [string | {siteUrl, permissionLevel}], ga4_ok, error, ga4_error? }. DELETE /api/admin/google -> any 2xx.
- The private key never leaves the browser except in that PUT; the UI clears the textarea immediately after client-side validation and only ever displays client_email.

## HOMEPAGE BANNERS

### after review fixes
FINDING OUTCOMES (in the order given)
1. videoupload.js, stalled upload (medium): FIXED. saveVideoStream now has an idle timer, reset on every chunk and on drain (UPLOAD_IDLE_MS = 45 s), and a total deadline (UPLOAD_MAX_MS = 20 min). When either fires, it rejects with 408 ("Upload stalled. Please try again." or "Upload took too long..."), removes the .part file and destroys the input, which closes the socket. Both values can be overridden through saveVideoStream({idleMs, maxMs}) and registerHomepage({uploadIdleMs, uploadMaxMs}). Checked against the real server.js with the integration lines applied in memory: an 80 MB declared body that stopped after 6 KB was closed by the server after 45 s, and the temp file was removed. New tests cover a direct stall, a slow but steady upload that is allowed through, the maxMs deadline, and an HTTP socket stall.
2. hero.js, render() skipping cleaning (medium): FIXED. render() now always calls cleanHero(data). The harness passes the reviewer's hostile object straight into SiroyaHero.render(): nothing renders and no javascript:, data: or // URL appears. A mixed object keeps only its good values.
3. videoupload.js, polyglots (low): FIXED in code, plus one recommended header (below). After the 12-byte signature check, the first 4 KB is now checked for structure. MP4 needs an ftyp box of 16 to 1024 bytes followed by well-formed box headers. WebM needs an EBML header with DocType webm or matroska, then the Segment element (Void elements may come before it). ftyp+HTML and EBML+SVG files now get 400, both over HTTP and on the real server.js. Real ffmpeg output passes: faststart, fragmented, QuickTime brand, mp42, VP8, VP9 and MKV.
4. homepage.js, attacks tried and blocked (informational): no change.
5. hero.css, CLS during the cross-fade (high): FIXED. The outgoing static copy now has `.hero > .hero-old.wrap { position:absolute; left:0; right:0; bottom:0 }`, and hero.js marks the old nodes aria-hidden and inert. With a 1.2 s API delay, CLS went from 0.642 to 0.0008 at 1440 and from 0.431 to 0 at 390, and the copy sits at its final x and width mid-fade. t_slow now checks CLS < 0.05 and the geometry at both widths. Its delay is 1.3 s (was 1.5), which leaves more room under the 2.5 s timeout. It passed 3 runs out of 3.
6. hero.css, contrast on bright photos (high): FIXED.
   - The copy block always keeps its own soft dark ground. hero-copy::before is a radial scrim that follows the copy at any width and alignment, with --hero-floor = clamp(0, 0.88 - overlay, 0.8): 0.8 at 0%, 0.43 at the default 45%, none at 80% and above.
   - The text shadow is slightly stronger.
   - The eyebrow is now cream instead of gold.
   - .btn-line has a dark translucent backing.
   - The progress lines are brighter and have a dark 1 px outline. The count has a shadow.
   - The admin shows a warning below 35%.
   - Measured on evermore-hero.jpg at 1440, left align (median, and the share of glyph pixels below target):
     - 0%: before, eyebrow 1.25, h1 1.37, lede 1.42 (all 100% below). After, 5.45, 7.97, 6.39 (25%, 0%, 17% below).
     - 20%: after, 5.43, 6.93, 6.35 (17%, 0%, 0% below).
     - 45%: before, 2.46, 3.45, 5.03. After, 5.42, 6.42, 7.03 (0% below everywhere).
   - Centre align and 390 pass at every overlay.
7. hero.js, no h1 on slides 2 and later (medium): FIXED for slideshows. A slideshow now renders one persistent visually hidden <h1 class="sr-only hero-h1">Siroya Jewellers</h1> outside .hero-slides, and every slide headline is an <h2 class="hero-title h1">. Image and video modes keep their visible h1, because their single slide is never hidden. This is a deliberate deviation from "same outline in every mode"; every mode still has exactly one h1. The harness checks for one h1 in the accessibility tree on slides 1, 2 and 3.
8. index.html, static image always fetched at high priority (medium): NOT FIXED IN CODE. index.html is an existing file, and the browser's preload scanner fetches the image before any script runs. The optional line is listed below.
9. hero.js, Save-Data slideshow (low): FIXED. Data-saver and 2G/3G visitors start paused with a Play button, as with reduced motion. Nothing is fetched ahead: only slide 1 is requested until the visitor moves on. Added as harness test t_savedata.
10. admin homepage.js, video-mode alt and focus hidden (medium): FIXED. In video mode the slide card shows "Video framing": Keep in view, and "Video description (optional)" with its own hint and placeholder. Only the photo uploaders are hidden. Values are saved to slides[0].focus and slides[0].alt; I verified this against the mock.
11. admin hints (low): FIXED. Phone image, phone cover and featured image now say "Portrait 4:5, ideally 1600 x 2000". The phone video hint says "Portrait 4:5, ideally 1080 x 1350, under 10 MB and the same length as the main video".
12. admin homepage.css, preview not matching the site (low): FIXED. The preview now copies hero.css: the centred radial overlay, the copy floor scrim, the text shadows (desktop and phone), the cream eyebrow, the btn-line backing, the line outline and the count shadow. A comment says to keep the two in step.
13. admin, touch help text and .m4v (low): FIXED. On a coarse pointer the help says "Use the arrows to change the order". videoType() treats video/x-m4v, and .mp4/.m4v files labelled video/quicktime or octet-stream, as video/mp4, and the file picker accepts .m4v. I verified that an x-m4v file uploads as MP4.
14. hero.css, focus ring on light photos (low): FIXED. Inside .hero the ring is now a 2px gold outline over a 7px dark halo, rgba(36,26,25,.6). The harness checks this.
15. hero.js, areas that passed review: no change. The hover pause still covers only the copy and the controls (deliberate).
16. server.js note check: the stale Range gap is dropped, because static.js already serves 206/416. The line numbers below were re-checked today.
17 and 18. index.html and admin.js note checks: re-verified. The lines are unchanged and listed below.

INTEGRATION (no existing file was edited; apply these by hand)
=== server/server.js ===
1) After line 16 `const { registerAdmin } = require('./lib/api/admin');` add:
const { registerHomepage } = require('./lib/api/homepage');
2) After line 40 `  registerAdmin(router, { db, auth, env, loginLimiter, siteDir });` add:
  registerHomepage(router, { db, siteDir });
3) Line 61, inside `if (MUTATING.has(req.method)) {`, replace
      body = await readJson(req, opts.limit || DEFAULT_BODY_LIMIT);
with
      if (!opts.raw) body = await readJson(req, opts.limit || DEFAULT_BODY_LIMIT);
4) Optional, CHANGED: line 146 `server.requestTimeout = 120000;` should become `server.requestTimeout = 1200000;` (20 min, the same as the upload's own total limit, so the two never conflict). Stalled uploads no longer depend on this setting.
=== server/lib/static.js (NEW, defence in depth for finding 3) ===
After line 119 `      headers['Cache-Control'] = 'public, max-age=31536000, immutable';` (inside the `/uploads/` branch that opens on line 118) add:
      headers['Content-Security-Policy'] = "sandbox allow-same-origin; default-src 'none'; img-src 'self'; media-src 'self'; style-src 'unsafe-inline'";
Checked in Chrome: embedded <img> and <video> are unaffected, an .mp4 or .jpg opened directly still works, and an HTML file served from /uploads/ ran no script. Do not use plain `sandbox`: without allow-same-origin, a directly opened .mp4 stopped loading in Chrome.
=== site/index.html ===
1) After line 14 `<link rel="stylesheet" href="assets/css/intro.css">` add: <link rel="stylesheet" href="assets/css/hero.css">
2) After line 21 `<script src="assets/js/intro.js"></script>` add (synchronous, before data.js, site.js and motion.js): <script src="assets/js/hero.js"></script>
3) Optional, finding 8, a product decision: on line 29, remove ` fetchpriority="high"` from the static <img>. The live hero's first image already carries fetchpriority="high". The full fix is for the server to template the saved hero image or poster into that <img> and a <link rel=preload> when it serves index.html.
=== site/admin/index.html ===
After line 14 `<link rel="stylesheet" href="admin.css">` add: <link rel="stylesheet" href="homepage.css">
=== site/admin/admin.js ===
a) After line 7 (the more.js import) add: import { renderHomepage } from "./homepage.js";
b) After line 16 (the collections NAV entry) add: { key: "homepage", href: "#/homepage", label: "Homepage", icon: "house-line" },
c) After line 29 (the /collections/(new|\d+) route) add: { re: /^\/homepage$/, view: ctx => renderHomepage(ctx.root, ctx), nav: "homepage", title: "Homepage", form: true },
d) Optional, in the dashboard quick array: { href: "#/homepage", icon: "house-line", label: "Homepage banner", text: "Image, slideshow or video at the top" },
Admin preview: window.SiroyaHero.render(section, heroObject, { preview: true, instant: true }) now cleans everything it is given, so raw editor state is safe to pass. The current admin keeps its own text-only preview, so no change is needed.

### build note: homepage.js, videoupload.js, homepage.js, homepage.test.js
No existing file was modified. To go live, server/server.js needs 3 lines (1 optional). No change is needed for byte ranges, so I did not create range.js.

=== server/server.js ===
1) Add a require. After line 16, `const { registerAdmin } = require('./lib/api/admin');`, add:
const { registerHomepage } = require('./lib/api/homepage');

2) Register the routes. After line 40 (in createApp), `  registerAdmin(router, { db, auth, env, loginLimiter, siteDir });`, add:
  registerHomepage(router, { db, siteDir });

3) Let raw routes skip JSON parsing. Line 61 is inside handleApi, inside `if (MUTATING.has(req.method)) {`. Replace:
      body = await readJson(req, opts.limit || DEFAULT_BODY_LIMIT);
with:
      if (!opts.raw) body = await readJson(req, opts.limit || DEFAULT_BODY_LIMIT);
The Content-Type check just above it still runs. The video route is registered as { auth: true, raw: true, contentTypes: ['video/mp4','video/webm'] }, so anything else gets 415 before the handler runs. Raw routes get body = {} and read `req` themselves. If this line is missing, the handler answers 500 "Video uploads are not enabled on this server yet" (or readJson fails first with 413 or 400).

4) Optional but recommended: change `server.requestTimeout = 120000;` to `600000`. Otherwise an 80 MB upload on an uplink slower than about 5.5 Mbps is cut off at 2 minutes.

Verification: I applied lines 1 to 3 in memory to the current server.js (scratchpad script, nothing written to the project) and ran the real createApp on port 5411. Results:
- GET /api/homepage: 200
- Admin without cookie: 401
- MP4 upload: 201
- Junk file declared as mp4: 400
- JSON Content-Type on upload-video: 415
- Range on the uploaded file: 206 with "bytes 0-1/6369" and video/mp4
- Bad range: 416
- PUT in video mode: 200
- /api/admin/login still parses JSON as before
The last describe block in server/test/homepage.test.js runs this same flow against the real server.js. It switches on by itself once `registerHomepage(` and `opts.raw` appear in server.js. Until then it is skipped.

=== Static Range ===
server/lib/static.js already handles this: it sends video/mp4 and video/webm with Accept-Ranges: bytes, answers single ranges with 206 and Content-Range, and answers bad ranges with 416 and `bytes */size`. Uploads get immutable caching. The tests check bytes=0-1 (the iOS probe), a middle range, an open-ended range, a suffix range, a range past the end, 416 cases, and HEAD.

=== Contract for the public-site and admin agents ===
- GET /api/homepage (no-store): the stored object plus `featured.resolved = { slug, name, kind, short, hero, cover, url: 'collection.html?c=<slug>', fallback }`.
  - If the chosen collection is missing or hidden, the first active collection is used (fallback: true) and featured image, headline, text and cta_label come back as ''.
  - `resolved` is null when no collection is active.
- GET /api/admin/homepage: the raw stored object, with no `resolved`.
- PUT /api/admin/homepage: JSON body. Returns the saved object (200).
  - If the top-level `hero` or `featured` is missing, the saved one is kept.
  - featured.collection must exist and be active.
  - Errors are 400 `{error}` with messages ready to show, e.g. "Slide 2 needs a desktop image", "Slide 1 headline is 85 characters. Please keep it to 70 or fewer.", "Add a cover image for the video. ...".
  - Over-length text is rejected, not cut.
  - Caps: eyebrow 50, headline 70, text 160, alt 140, button labels 40. Featured caps (my choice, the spec gave none): headline 120, text 400, button label 40.
  - "centre" is accepted as an alias for "center". A single leading "/" on links and media is removed.
  - Required by mode: image mode needs slides[0].image; slideshow needs every slide's image; video mode needs video.src and video.poster.
- POST /api/admin/upload-video: raw body (e.g. `xhr.send(file)`) with Content-Type video/mp4 or video/webm. Optional X-Filename header; the admin should pass `encodeURIComponent(name)` because XHR rejects non-Latin1 header values.
  - Success is **201** (same as the image upload) with `{ url: 'uploads/YYYY/MM/<16hex>.mp4|webm', bytes, type, name }`.
  - Errors as `{error}`: 400 (wrong magic bytes, empty, interrupted), 401, 403 (Sec-Fetch-Site cross-site), 413 (over 80 MB), 415 (wrong type), 429 with Retry-After (20 per hour per admin session).
  - A declared Content-Length over 80 MB is refused at once. Wrong magic bytes are caught in the first 12 bytes, but the reply waits until the rest of the body has been read and discarded (bounded), so the browser shows the message rather than a network error.
  - Temp files go to site/uploads/.incoming/, which static.js never serves. Temp files older than 6 hours are swept.

### build note: hero.js (already existed, verified only, not modified this run), hero.css (already existed, verified only, not modified this run), hero_harness.py (already existed, run only, not modified this run)
I created no files this run. All three target files were already there from an earlier run of this task: site/assets/js/hero.js, site/assets/css/hero.css and server/test/hero_harness.py. They are in git commit 95764b4 (2026-10-02 17:31) and the working tree is clean. The hard constraint says not to modify any existing file, so I left all three untouched. I ran the harness against the current site/index.html, intro, motion and site.js and checked the screenshots.

The renderer is not yet hooked into index.html. Until it is, the harness adds the two tags itself when it serves the page. Make exactly these two additions to site/index.html; nothing else changes:

1. Stylesheet. Insert a new line directly after line 14, `<link rel="stylesheet" href="assets/css/intro.css">`, and before the inline intro-pending `<script>` on line 15:
   <link rel="stylesheet" href="assets/css/hero.css">
   It must load after siroya.css, motion.css and intro.css because it builds on their .hero rules.

2. Script. Insert a new line directly after line 21, `<script src="assets/js/intro.js"></script>`, which sits just inside `<body>` before the header:
   <script src="assets/js/hero.js"></script>
   Keep it synchronous, with no defer, and keep it before data.js, site.js and motion.js. That way the /api/homepage request starts early and the html.hero-pending hold applies before the first paint.

Nothing else is needed:
- No server change for the renderer. It only needs GET /api/homepage, a JSON object with `hero` and an optional `featured.resolved`.
- If the API fails, returns 404, sends non-JSON, takes longer than 2.5 s, or the page is opened from file:, the static hero in index.html stays exactly as written. A 3 s CSS failsafe shows it even if the script never runs.
- The admin live preview can reuse the same code. Load `<script src="../assets/js/hero.js" data-manual></script>` plus hero.css, then call `window.SiroyaHero.render(sectionEl, heroObject, { preview: true, instant: true })`. The `window.SiroyaHero.clean(obj)` and `window.SiroyaHero.featured(featuredObj)` helpers are also available.
- Each finished render fires `siroya:hero-ready` on window, with `detail.mode` set to image, slideshow, video or static.
- The video Range requirement (206 support) still belongs to whoever owns static serving in server/lib/static.js. The harness has its own Range support for testing.

### build note: homepage.js, homepage.css
PROVENANCE: site/admin/homepage.js, homepage.css and homepage-harness.html were already on disk when this run started. An earlier attempt at this same task wrote them at 16:57 to 17:00 and never finished its test pass. No other workflow owns them. I treated them as this task's own output. I made three small edits: in homepage.css, the single-column layout now stretches its cards, and slide headlines wrap on phones; in homepage.js, only one slide card is open at a time. I deleted the temporary harness page site/admin/homepage-harness.html after testing. I did not edit any other existing file.

1) site/admin/index.html, in <head>, directly after the line `<link rel="stylesheet" href="admin.css">`, add:
   <link rel="stylesheet" href="homepage.css">

2) site/admin/admin.js
   a) Imports: after line 7 `import { storesList, storeEdit, leadsView, settingsView, leadContact } from "./more.js";` add:
      import { renderHomepage } from "./homepage.js";
   b) NAV array: between the `collections` entry and the `stores` entry (that is, after line 16), add:
      { key: "homepage", href: "#/homepage", label: "Homepage", icon: "house-line" },
      (Leave out `tab: true`, so it appears in the sidebar and in the phone "More" sheet.)
   c) ROUTES array: after the `/collections/(new|\d+)` route (line 29), add:
      { re: /^\/homepage$/, view: ctx => renderHomepage(ctx.root, ctx), nav: "homepage", title: "Homepage", form: true },
      (`form: true` is needed so body.has-savebar is set and the phone save bar shows.)
   d) Optional: add to the dashboard `quick` array:
      { href: "#/homepage", icon: "house-line", label: "Homepage banner", text: "Image, slideshow or video at the top" },

APIs the editor calls, all of which match server/lib/api/homepage.js as it stands:
- GET /api/admin/homepage. Accepts a bare object or one wrapped in {homepage|item|data}.
- PUT /api/admin/homepage with the full object. Server 400s with {error} are shown inline. Messages such as "Slide 2 button 1 needs a link" are mapped to the matching field, and so is an optional `field` such as "hero.slides.1.cta_link".
- POST /api/admin/upload: image JSON {filename, dataUrl}, the same as media.js. Banner images are resized in the browser to 2400px wide (phone images 1600px) as JPEG q0.85.
- POST /api/admin/upload-video: raw File body sent with XMLHttpRequest. Headers are Content-Type video/mp4|webm and X-Filename. Expects {url}. Errors 413, 415 and 401 (sign in again) are handled.
- GET /api/admin/collections, /api/admin/categories (link picker) and /api/admin/products?collection=slug (featured preview thumbnails).

Server dependencies, owned by other workers: the upload-video route needs the `raw: true` hookup in server.js, and static.js needs Range support so saved videos play.

Caps: the editor is stricter than the server on purpose. Button text is 30 characters (server 40), featured headline 70 (server 120), featured text 200 (server 400). The server stays the final check.