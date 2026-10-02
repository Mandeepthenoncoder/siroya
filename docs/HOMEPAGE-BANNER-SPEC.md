# Homepage banners: build spec

The store team edits the landing page banner from the admin, in one of three modes:
**single image**, **slideshow** (multiple images), or **single video**, plus the "featured collection" banner further down the homepage.
Stack rules as in docs/BACKEND-SPEC.md (Node 22, zero dependencies, vanilla admin). Reuse existing helpers (server/lib/http.js readBody/json/HttpError, validate.js, db getSetting/setSetting, uploads.js saveUpload for images, auth via route option `{ auth: true }`; admin lib.js API wrapper, toasts, escape helper, media.js image uploader with client-side resize).

## Data (settings key `homepage`, JSON)
```
{
  hero: {
    mode: "image" | "slideshow" | "video",            // default "image"
    slides: [ {                                        // 1..6; "image" mode uses slides[0]; "video" mode uses slides[0] for its text
      image: "assets/... | uploads/...",               // desktop, 16:9, recommended 2400x1350
      image_mobile: "",                                // optional portrait 4:5 for phones
      focus: "right" | "center" | "left",              // object-position on desktop crops (default "right")
      eyebrow: "", headline: "", text: "",             // headline <= 70 chars, text <= 160, eyebrow <= 50
      cta_label: "", cta_link: "",                     // primary button
      cta2_label: "", cta2_link: "",                   // optional secondary button
      alt: ""                                          // image description for screen readers, <= 140
    } ],
    video: { src: "uploads/...mp4", src_mobile: "", poster: "uploads/...jpg", poster_mobile: "" },
    interval: 6,                                       // slideshow seconds, 4..12
    overlay: 0.45,                                     // darkness behind text 0..0.8
    align: "left" | "center"
  },
  featured: { collection: "sanskriti", image: "", headline: "", text: "", cta_label: "" }   // blanks fall back to the collection's own data
}
```
Seed (first run, when the key is missing): mode "image" with the current homepage hero (assets/img/home/hero.jpg, eyebrow "Jewellers to the world since 1976", headline "Jewellery that feels like home", text "Designs curated from across the world, chosen with care for your family's celebrations.", CTA "Explore collections" -> collections.html, CTA2 "Our story" -> about.html, alt as in index.html), overlay 0.45, align left, interval 6; featured: sanskriti with headline "Sanskriti. Traditions carried forward." and the current text.

Validation (server): mode/focus/align enums; strings trimmed, single line, length caps; links must be a same-site relative path (`^[a-z0-9][a-z0-9\-_/.?=&#%]*$`, no `..`, no scheme) or `https://` URL; media paths must start with `assets/` or `uploads/` and contain no `..`; video paths must end .mp4 or .webm; 1..6 slides; numbers clamped. Unknown fields ignored.

## API
- `GET /api/homepage` (public, `Cache-Control: no-store`): the homepage object, with featured resolved against the collections table (include `featured.resolved = { slug, name, kind, short, hero, cover, url }`).
- `GET /api/admin/homepage` (auth): same, raw.
- `PUT /api/admin/homepage` (auth, JSON): full object; validates and saves; returns saved object.
- `POST /api/admin/upload-video` (auth): **raw binary body** (not JSON), `Content-Type: video/mp4` or `video/webm`, optional header `X-Filename`. Limit 80 MB, streamed to a temp file while counting bytes (413 beyond, delete temp). Verify magic bytes: mp4 has `ftyp` at offset 4; webm starts with `1A 45 DF A3`. Save as `site/uploads/YYYY/MM/<random-16-hex>.mp4|webm`, respond `{ url }`. Rate limit 20 uploads per hour per session. Note: the existing server parses JSON bodies before handlers based on route `contentTypes`; read server/server.js to see whether a route can opt out of body parsing (e.g. a `raw: true` option). If it cannot, design the smallest change and describe it precisely in the integration note (do not edit server.js yourself).
- Static serving must send video with `Content-Type` video/mp4|webm and support HTTP `Range` requests (206 Partial Content) so iOS Safari can play it: check server/lib/static.js; if Range is missing, write a NEW helper module and describe the one-line integration.

## Public site (`site/assets/js/hero.js`, `site/assets/css/hero.css`)
- Loaded on index.html only. Fetches `/api/homepage` (2.5 s timeout). If it fails (static hosting), leave the existing static hero untouched.
- Renders into the existing `<section class="hero">` (keep class names `.hero`, `.hero-media`, `.hero-copy`, `.rv` so intro.css, motion.css and siroya.css keep working; the intro waits for the hero and expects `.hero-media img` or `.hero-media video`).
- **image**: `<picture>` with mobile source (max-width 760px) when image_mobile is set; object-position from focus; first image `fetchpriority="high"`.
- **slideshow**: all slides stacked; active slide cross-fades (1.2 s) with a slow 8 s zoom from 1.06 to 1; copy for the active slide rises in (reuse the existing reveal feel); progress indicator = thin lines at the bottom (one per slide, the active one fills over the interval); prev/next buttons on desktop, swipe on touch; pause on hover, on focus within, and when the tab is hidden; a visible Pause/Play button (WCAG 2.2.2); `aria-roledescription="carousel"`, each slide `role="group" aria-roledescription="slide" aria-label="n of N"`; only the active slide's links are focusable. Reduced motion: no autoplay, no zoom, instant swaps. Preload only the next slide's image.
- **video**: `<video muted loop playsinline autoplay preload="metadata" poster>`; choose `src_mobile`/`poster_mobile` by `matchMedia("(max-width: 760px)")`; play only after the intro has finished (`siroya:intro-done` event) or immediately when no intro; pause when off-screen (IntersectionObserver) and when the tab is hidden; Pause/Play button; with `prefers-reduced-motion`, `navigator.connection.saveData`, or effectiveType 2g/3g show the poster only.
- Overlay: a gradient whose strength follows `overlay`; align center moves the copy block to the centre.
- Featured banner: update the homepage featured section (heading, text, image, link, mini products of that collection) from `featured.resolved`.

## Admin (`site/admin/homepage.js`, `site/admin/homepage.css`)
- Route `#/homepage`, nav label "Homepage" (Phosphor `ph-house-line`).
- **Hero**: segmented control Single image / Slideshow / Video (switching keeps entered data). Slide cards (image mode shows one card; slideshow up to 6 with Add slide, Remove, drag to reorder plus up/down buttons). Each card: desktop image uploader (reuse media.js uploader: client-side resize to 2400px, JPEG 0.85), optional phone image, focus point (Left/Centre/Right with a tiny visual), eyebrow, headline (counter /70), text (counter /160), button 1 label + link, button 2 label + link (link field with a dropdown of site pages and collections plus "Custom link"), image description.
- **Video**: video uploader (file input + drag and drop; mp4/webm; shows size; uploads with `XMLHttpRequest` to show a progress bar; client checks size <= 80 MB and type; recommends 1920x1080, under 20 MB, 10 to 20 seconds, no sound), cover image (required, used as poster and fallback), optional phone video and phone cover; shows a muted preview.
- Overlay slider (0 to 80%), alignment (Left / Centre), slideshow interval (4 to 12 s).
- **Live preview** panel: Desktop / Phone toggle, renders the hero exactly like the public site (same markup and CSS from hero.css scoped inside the preview frame or an iframe of `/index.html?preview=1` is NOT required; a faithful mini render is enough), updates as you type.
- **Featured collection**: collection select, optional image override, headline, text, button label.
- Save (disabled until changed; unsaved-changes guard), "View homepage" link. Errors from the server shown inline. Mobile-friendly.

## Integration (later, by someone else)
Every agent ends with exact integration lines: server.js registration and any raw-body option, static Range support hookup, admin nav + route registration, `<link>`/`<script>` tags in index.html and admin/index.html.
