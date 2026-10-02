# Production on Vercel + Turso + Cloudflare R2

Goal: the same repo runs **locally** (current Node server, local SQLite file, local disk uploads) and on **Vercel** (serverless function, Turso database, R2 media), chosen by environment variables. The public site and admin keep working unchanged from the user's point of view.

## Dependencies (zero-dependency rule is lifted for production)
- `@libsql/client` for the database in both modes: `url: "file:server/data/siroya.db"` locally, `TURSO_DATABASE_URL` + `TURSO_AUTH_TOKEN` on Vercel. Remove `node:sqlite` usage.
- `aws4fetch` (tiny) to sign R2 (S3-compatible) requests: presigned PUT URLs for browser uploads, and DELETE when needed.
Add both to package.json `dependencies`; commit package-lock.json.

## Database layer (`server/lib/db.js`)
- Async API used everywhere: `await db.all(sql, args)`, `await db.get(...)`, `await db.run(...)`, `await db.batch([...], "write")` / transactions via `db.transaction(async tx => ...)` (libsql `client.transaction("write")`). `getSetting/setSetting` become async.
- Convert every caller: api/public.js, api/admin.js, api/homepage.js, api/traffic.js, analytics.js, google.js, homepage.js, seed.js, auth (if it touches db), tests. Router handlers become async (router already awaits handlers? verify and make it so).
- Migrations: same idempotent SQL, run once per cold start (cache a promise). Seed from site/assets/js/data.js on an empty DB (same as now).
- Keep SQL SQLite-compatible (Turso is libSQL). Remove `PRAGMA` statements that Turso rejects (journal_mode, synchronous, secure_delete) when not in file mode.

## Media (`server/lib/storage.js`)
- `STORAGE=r2` when `R2_ACCOUNT_ID` is set, else `local`.
- New admin endpoint `POST /api/admin/upload/presign` `{ kind: "image"|"video", type, size, filename }` -> validates type (jpeg/png/webp for images up to 10 MB; mp4/webm for video up to 80 MB), creates key `uploads/YYYY/MM/<16hex>.<ext>`, returns `{ method:"PUT", uploadUrl, headers:{ "Content-Type": type }, url: R2_PUBLIC_URL + "/" + key }` (presigned, 10 minute expiry). In local mode it returns `{ method:"LOCAL" }` and the admin falls back to the existing upload routes.
- Admin `site/admin/media.js` (image uploader) and the homepage video uploader: if presign returns PUT, upload the (client-resized) file straight to R2 with XHR (progress), then use `url`. Image and media path validators must also accept `https://` URLs under `R2_PUBLIC_URL`.
- After upload the server may `HEAD` the object to confirm size/type (optional). Magic-byte checks move to the client for R2 mode (server cannot see the bytes); keep content-type + size enforcement in the presigned URL.
- R2 serves Range requests natively (iOS video OK). Set long cache headers via the R2 custom domain / Cloudflare cache rules (document).

## Vercel entry
- `api/index.js`: exports `default async (req, res)` that lazily builds the app once (`createApp` from server/server.js refactored to export the request handler without listening) and handles the request. Body limits: images go direct to R2, so function bodies stay small (Vercel limit 4.5 MB).
- `vercel.json`: keep `outputDirectory: "site"`, add `rewrites: [{ "source": "/api/(.*)", "destination": "/api/index" }]`, `functions: { "api/index.js": { "maxDuration": 30 } }`, `crons: [{ "path": "/api/cron/daily", "schedule": "1 20 * * *" }]` (00:01 Dubai = 20:01 UTC), and the noindex header only while `REVIEW_MODE` / until launch (document how to remove).
- `/api/cron/daily`: requires `Authorization: Bearer ${CRON_SECRET}`; runs analytics purge + rollups and the homepage temp sweep. No `setInterval`/timers in serverless mode (keep them for local mode).
- `env.js`: read `process.env` first; never write `.env` when `VERCEL` is set (read-only filesystem); require `ADMIN_PASSWORD` and `SESSION_SECRET` in production and fail with a clear message.
- In-memory rate limiters and caches stay per instance (acceptable); document.
- `clientIp`: on Vercel use `x-forwarded-for` rightmost trusted hop / `x-real-ip` (Vercel sets it).

## Wiring still pending (do it as part of this work)
- Traffic module: apply the integration steps in the traffic workflow notes (server.js registerTraffic + beacon option, migration v2, admin nav/route/dashboard/settings, track.js script tag before site.js on every public page).
- Homepage banners: registerHomepage + `raw` route option (local video upload), hero.js/hero.css on index.html, admin nav/route for `#/homepage`.

## Env vars (Vercel dashboard)
`TURSO_DATABASE_URL, TURSO_AUTH_TOKEN, R2_ACCOUNT_ID, R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY, R2_BUCKET, R2_PUBLIC_URL, ADMIN_PASSWORD, SESSION_SECRET, CRON_SECRET` (+ optional `PUBLIC_ORIGIN`). Document all in server/.env.example and a DEPLOY.md.

## Done means
- `npm test` green (tests updated to async; libsql in-memory `file::memory:` for tests).
- Local `npm start` works exactly as before (file DB, disk uploads).
- `vercel dev` (or a local simulation calling api/index.js) works with a Turso URL of `file:` and a mock R2 (or real creds if provided) for: catalog, lead save, admin login, product CRUD, image upload via presign, homepage save, traffic beacon + report.
- DEPLOY.md with step by step: Turso, R2 (bucket, CORS JSON, token, custom domain), Vercel env vars, first deploy, data migration from the local SQLite file to Turso (`turso db shell` import or a small script), how to remove noindex at launch.
