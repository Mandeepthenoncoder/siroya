# Deploying Siroya Jewellers

The same code runs in two places. Environment variables decide which.

| | Locally (`npm start`) | Production (Vercel) |
|---|---|---|
| Public site and admin pages | Served by `server/server.js` from `site/` | Served by Vercel's CDN from `site/` (`outputDirectory`) |
| API (`/api/*`) | The same Node process | One serverless function, `api/index.js`, which wraps the same request handler (`vercel.json` rewrites `/api/*` to it) |
| Database | SQLite file `server/data/siroya.db` (through `@libsql/client`) | Turso (`TURSO_DATABASE_URL`, `TURSO_AUTH_TOKEN`) |
| Uploaded photos and videos | `site/uploads/yyyy/mm/...` on disk | Cloudflare R2. The admin uploads straight to R2 with a 10-minute presigned URL, and the database stores the public URL |
| Nightly analytics maintenance | Timer at 00:01 Dubai | Vercel cron calls `GET /api/cron/daily` at 20:01 UTC (00:01 Dubai) with `Authorization: Bearer $CRON_SECRET` |
| Admin password, session secret | `server/.env`, created on first run | Vercel environment variables. They are required: the API answers 500 "Server configuration error" if either is missing |

Locally nothing changes: without `TURSO_DATABASE_URL` the server uses the SQLite file, and without `R2_ACCOUNT_ID` it keeps uploads on disk. `server/.env` is never read or written on Vercel.

On every cold start the function runs the idempotent migrations once. If the database has no catalog yet, it also imports `site/assets/js/data.js`, exactly as the local server does on first run.

## Environment variables (Vercel > Project > Settings > Environment Variables)

| Name | What it is |
|---|---|
| `TURSO_DATABASE_URL` | `libsql://<db>-<org>.turso.io`. The server talks to it over HTTPS. |
| `TURSO_AUTH_TOKEN` | Database token (`turso db tokens create <db>`) |
| `R2_ACCOUNT_ID` | Cloudflare account ID. Setting it switches media to R2, and then the other R2 values are required. |
| `R2_ACCESS_KEY_ID`, `R2_SECRET_ACCESS_KEY` | R2 API token with **Object Read & Write** on the bucket only |
| `R2_BUCKET` | Bucket name, for example `siroya-media` |
| `R2_PUBLIC_URL` | Public address of the bucket, with no trailing slash: `https://pub-xxxx.r2.dev` or a custom domain such as `https://media.siroyajewellers.com`. Images and videos are stored as `R2_PUBLIC_URL/uploads/yyyy/mm/<random>.<ext>`, and only URLs under this address are accepted for homepage media. |
| `ADMIN_PASSWORD` | Admin sign-in password, 12 or more characters |
| `SESSION_SECRET` | 64 random hex characters. It signs admin cookies and encrypts the stored Google key. |
| `CRON_SECRET` | Any long random string. Vercel sends it to the cron route automatically. |
| `PUBLIC_ORIGIN` | Optional. The site address, for example `https://siroya.vercel.app`, used to recognise the site's own pages in analytics. |
| `R2_SIGN_CONTENT_LENGTH` | Optional. Set it to `0` only if R2 ever rejects browser uploads with 403 (see Troubleshooting). |

After you change a variable, redeploy (Deployments > ... > Redeploy). Running functions keep the old values until then.

## One-time setup

### Turso
1. `turso db create siroya` (pick the region nearest the Vercel function region; Vercel's default is `iad1`, Washington DC).
2. `turso db show siroya --url` gives `TURSO_DATABASE_URL`.
3. `turso db tokens create siroya` gives `TURSO_AUTH_TOKEN`.

You don't need to load any schema by hand. The first API request creates the tables.

### Cloudflare R2
1. Create a bucket, for example `siroya-media`.
2. Make it public. Use Settings > Public access, either the `r2.dev` subdomain (fine for testing, rate-limited) or, better, a **custom domain** on a Cloudflare zone, for example `media.siroyajewellers.com`. Put that address in `R2_PUBLIC_URL`.
3. Under Manage R2 API Tokens, create a token with **Object Read & Write**, limited to this bucket. Copy the Access Key ID and Secret Access Key.
4. Under Bucket > Settings > CORS policy, paste:

```json
[
  {
    "AllowedOrigins": ["https://siroya.vercel.app", "http://localhost:5173"],
    "AllowedMethods": ["GET", "HEAD", "PUT"],
    "AllowedHeaders": ["Content-Type"],
    "ExposeHeaders": ["ETag"],
    "MaxAgeSeconds": 3600
  }
]
```

   Add your final domain (for example `https://siroyajewellers.com` and `https://www.siroyajewellers.com`) to `AllowedOrigins` when you move to it. Without CORS, admin uploads fail with "Upload failed. Check your connection...".
5. Caching: uploaded files never change (each upload gets a new random name). On a custom domain, add a Cache Rule for `media.<domain>/uploads/*` with Edge TTL "Ignore cache-control header, 1 year" and Browser TTL 1 year. R2 serves byte ranges itself, so videos play on iPhones.

### Vercel
The project is already connected to GitHub (`main` deploys automatically), and the environment variables listed above are already set.
- Framework preset: **Other**. Build command: none. Output directory: `site` (from `vercel.json`). Vercel installs `package.json` dependencies for the function.
- Node.js version: 22.x (from `package.json` `engines`).
- Cron jobs appear under Settings > Cron Jobs after a deploy. On the Hobby plan a daily cron can run any time within the scheduled hour, which is fine here.

## First deploy

1. Push to `main`. Vercel builds and deploys.
2. Open `https://siroya.vercel.app/api/catalog`. The first request migrates the Turso database and, if it is empty, imports `data.js`. You should get JSON with the products.
3. Open `https://siroya.vercel.app/admin/` and sign in with `ADMIN_PASSWORD`.
4. Upload a test photo in a product. The image URL should start with `R2_PUBLIC_URL`.

## Copying your local data to Turso and R2

The local admin data (products, collections, categories, stores, site settings, homepage banners) and the photos and videos in `site/uploads/` can be copied in one step. Your local files are only read, never changed.

```bash
# from the project folder; vercel-import.env holds the production values
node --env-file=vercel-import.env scripts/copy-local-to-turso.js --dry-run   # shows what would happen
node --env-file=vercel-import.env scripts/copy-local-to-turso.js             # copies
```

What the script does:
- **Catalog tables** (`categories`, `collections`, `products`, `stores`): Turso is made identical to the local copy, with one atomic batch per table. This replaces the `data.js` seed that the first request created.
- **Settings**: `site`, `homepage` and `seeded_at` are copied. The Google connection is not copied, because its key is encrypted with the local `SESSION_SECRET`. Connect Google again under Settings in the live admin.
- **Media**: every `uploads/...` file that the copied rows use is uploaded to R2 under the same key (files already in R2 are skipped), and the stored paths become `R2_PUBLIC_URL/uploads/...`.
- `--with-leads` also copies local leads, and `--with-analytics` copies traffic events and rollups. In both cases rows that already exist on Turso are kept. Leave these flags off if your local leads are only tests.
- `--skip-media` copies the database only.

You can run it more than once. It always produces the same result, but each run overwrites catalog edits made in the live admin, so run it before launch, not after.

## Launch checklist: remove `noindex`

While the site is in review, every response carries `X-Robots-Tag: noindex, nofollow`. At launch:
1. In `vercel.json`, delete the `{ "key": "X-Robots-Tag", "value": "noindex, nofollow" }` line from the `"source": "/(.*)"` headers block (keep the other two headers).
2. Commit and push. The admin keeps its own `noindex` (meta tag plus header on `/api/admin`).
3. Set `PUBLIC_ORIGIN` to the final address, add that address to the R2 CORS origins, and add the domain in Vercel > Settings > Domains.

## Rotating keys

| What | How |
|---|---|
| Admin password | Change `ADMIN_PASSWORD` in Vercel and redeploy. Every admin session is signed out (the cookie key includes the password). |
| `SESSION_SECRET` | Generate one with `node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"`, set it, and redeploy. Everyone is signed out, and the saved Google key can no longer be decrypted, so load the Google JSON key again under Settings. |
| Turso token | `turso db tokens create siroya`, update `TURSO_AUTH_TOKEN`, redeploy, then `turso db tokens invalidate siroya` to revoke the old ones. |
| R2 token | Create a new R2 API token, update `R2_ACCESS_KEY_ID` and `R2_SECRET_ACCESS_KEY`, redeploy, then delete the old token in Cloudflare. Already-issued upload URLs expire within 10 minutes. |
| `CRON_SECRET` | Change it and redeploy. Vercel sends the new value automatically. |
| Local copies | Update `vercel-import.env` (never committed) if you use it for the copy script. |

## Good to know

- **Per-instance state.** Rate limits (logins, leads, analytics beacons, video uploads) and the one-minute traffic report cache are kept in memory, so each warm function instance has its own counters. That is enough for this site's traffic.
- **Body size.** Vercel functions accept at most 4.5 MB per request. Photos and videos therefore go straight from the browser to R2 and never pass through the function.
- **Upload checks.** In R2 mode the server can't see the uploaded bytes. The presigned URL fixes the content type and the exact size (JPEG, PNG or WebP up to 10 MB; MP4 or WebM up to 80 MB), and the admin checks a video's container header before uploading.
- **Client IP.** On Vercel the trusted client address comes from `X-Forwarded-For` / `X-Real-IP`, which Vercel sets (`TRUST_PROXY` is on by default there).
- **Logs.** Vercel > Project > Logs shows the function output. Each API request logs one line, and start-up problems are logged as "Siroya API failed to start" or "Start-up failed".

## Troubleshooting

| Symptom | Check |
|---|---|
| `/api/...` returns `{"error":"Server configuration error", "detail": "Missing required environment variable ..."}` | Set the variable named in `detail` and redeploy. |
| `/api/...` returns 503 "database is unreachable" | `TURSO_DATABASE_URL` / `TURSO_AUTH_TOKEN` are wrong or the token was revoked. The function logs show the libsql error. |
| Admin upload fails with "Upload to storage failed (error 403)" | The R2 token lacks write access to `R2_BUCKET`, or the clock or signature is off. If the error appears only for some browsers, set `R2_SIGN_CONTENT_LENGTH=0` and redeploy (the admin already retries once without the signed length). |
| Admin upload fails with a network error | R2 CORS policy is missing the admin's origin. |
| Images upload but don't show | `R2_PUBLIC_URL` is not the bucket's public address, or public access is off. |
