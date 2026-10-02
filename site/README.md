# Siroya Jewellers: new website (layout phase)

Static prototype. No build step. Open with any local server, for example:

```
python -m http.server 5173 --directory site
```

## Pages

| File | What it is |
|---|---|
| `index.html` | Home: hero, collections rail, featured collection, legacy numbers, categories, promise bento, stores, WhatsApp join |
| `collections.html` | All collections index (editorial grid) |
| `collection.html?c=<slug>` | Collection storyline page (Zoya-style): hero, intro, story chapter, filterable grid with story breaks, more collections. **Google Ads landing page.** |
| `product.html?p=<id>` | Product page. No "Buy now". WhatsApp enquiry form (name, mobile, store, time) as the primary action |
| `about.html` | Interactive brand story: line reveal, word-by-word purpose, pinned horizontal timeline (GSAP), counters, sticky pillars, record feature |

## Where things live

- `assets/css/siroya.css`: design tokens and all styles. Colours from the brand guide: cream `#F5F2EC`, red `#981E1D`, gold `#B49151 > #E2C283`. Corner rule: 10px surfaces, 8px controls.
- `assets/js/data.js`: **all content**: collections, chapters, products, stores, WhatsApp number. Products are currently placeholders (see the `seedPlaceholders` block at the bottom; delete it once real products are added).
- `assets/js/site.js`: header, footer, page rendering, motion, lead capture.
- `assets/img/logo/`: logo variants made from the brand guide (red, white, ink, favicon). Replace with original vector files when available.

## Adding images

Set the path in `data.js` (`hero`, `cover`, chapter `img`, product `images[]`, store `img`, category `img`). Any empty slot shows a labelled placeholder with the intended ratio:

- Collection hero: 16:9, min 2400px wide
- Collection cover: 3:4 portrait
- Story images: 4:5 portrait, editorial breaks landscape
- Products: 4:5, at least 2 shots (second shows on hover)
- Stores: 4:3

Home hero, featured Sanskriti image and bento image are marked with `TODO` / slot labels directly in `index.html`. About page archive photos are in `about.html`.

## Google Ads and lead tracking

- `gclid`, `gbraid`, `wbraid` and `utm_*` are captured on landing and kept for 90 days.
- `dataLayer` events: `view_item_list`, `view_item`, `filter_collection`, `whatsapp_click`, `generate_lead`. Map `generate_lead` (and optionally `whatsapp_click`) to Google Ads conversions in GTM.
- The WhatsApp message carries product name, code, link, customer name, mobile, store, time and campaign.
- Optional: set `SIROYA.site.leadEndpoint` to a webhook (Google Sheet / CRM) to keep a copy of every lead.

## Still needed from Siroya

- New photography (see list above)
- Garet font files (`assets/fonts/`, then uncomment the `@font-face` at the top of the CSS). Outfit is the stand-in.
- Confirmed WhatsApp enquiry number, store addresses and hours, social links
- Original logo vectors (SVG/AI)
- Real product catalogue (name, code, metal, weight, images)

## Image map (current)

Art direction: warm, film-like, low-key light; deep crimson and antique gold; 85mm shallow depth of field. Banner subjects sit in the right third so headlines sit on the darker left.

| Where | File | Source |
|---|---|---|
| Home hero | `img/home/hero.jpg` | AI generated (Magnific, Seedream 5 Pro): mother fastening a temple necklace on the bride |
| Home featured Sanskriti | `img/collections/sanskriti-hero.jpg` (cropped) | AI generated |
| Home "Your family jewellers" tile, About "Today" | `img/home/store-moment.jpg` | AI generated |
| Collection heroes (16:9) | `img/collections/<slug>-hero.jpg` | AI generated, 8 |
| Collection cards (3:4) | `img/collections/<slug>-cover.jpg` | AI generated, 8 |
| Collection story + editorial break | `<slug>-story.jpg`, `<slug>-detail.jpg` | Real Siroya product shoots from the old site (Sanskriti, Rangmahal, Prestige, Evermore). AI generated details for Divine Solitaire, Nexa, Iconyx, Toons |
| Category tiles | `img/categories/*.jpg` | AI generated, 6 |
| All products (temporary) | `img/products/ring-1.jpg`, `ring-2.jpg` | AI generated, one ring used everywhere |
| About timeline | `img/about/archive-*.jpg` | Real archive photos from the old site |
| About craftsman, record chain | `img/about/craftsman.jpg`, `gold-chain.jpg` | AI generated |
| Founders | `img/about/founders.jpg` | Real, old site |
| Stores | `img/stores/*.jpg` | Real, old site |

Full-resolution originals of every generated image are in `../generated/`.
