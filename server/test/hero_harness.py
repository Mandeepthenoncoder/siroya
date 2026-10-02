"""Browser harness for the homepage hero renderer (site/assets/js/hero.js,
site/assets/css/hero.css). Contract: docs/HOMEPAGE-BANNER-SPEC.md.

Runs a throwaway static server (Python http.server, port 5401 by default)
that serves site/ and answers GET /api/homepage with canned JSON. The
scenario is switched per test with GET /__harness/mode/<name>. Small test
videos and cover images are made with ffmpeg into a temp folder and served
at uploads/__harness/... with HTTP Range support (206), the way iOS Safari
needs it. Until index.html carries the hero tags itself, the server injects
them exactly where the integration note puts them: hero.css right after
intro.css, hero.js right after intro.js.

Checks, in real Chrome through Playwright:
  static hero kept when /api/homepage is 404 (and on a slow answer the static
  hero shows, then cross-fades to the live one); single image (picture,
  phone source, focus, fetchpriority); slideshow (carousel semantics, only the
  active slide focusable, auto advance, Pause / Play, hover and keyboard focus
  pause, hidden tab and off-screen pause, keyboard and button previous / next,
  slide pickers, swipe on a touch phone, only the next image fetched ahead);
  video (muted inline autoplay, Range requests, pause off-screen and in a
  hidden tab, Pause / Play, phone file, Save-Data and reduced motion show the
  cover only, broken file falls back to the cover); reduced motion (no
  autoplay, no zoom, instant swaps); intro hand-off (nothing plays or advances
  behind the intro, everything starts on siroya:intro-done); featured
  collection section follows featured.resolved; hostile data is neutralised,
  also when raw editor state goes straight into SiroyaHero.render(); no layout
  shift during the static-to-live cross-fade (CLS); one h1 in the outline on
  every slide; Save-Data slideshow starts paused; focus ring with a dark halo;
  no page errors.

Usage:  python server/test/hero_harness.py            run the checks
        python server/test/hero_harness.py --serve    only serve (Ctrl+C to stop)
Env:    HERO_TEST_PORT (default 5401), CHROME_PATH, HEADED=1,
        HERO_SHOTS (screenshot folder, default: a temp folder, printed at the end)
"""
import json
import os
import re
import shutil
import subprocess
import sys
import tempfile
import threading
import time
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import urlsplit, unquote

ROOT = Path(__file__).resolve().parents[2]
SITE = ROOT / "site"
PORT = int(os.environ.get("HERO_TEST_PORT", "5401"))
BASE = f"http://localhost:{PORT}"
CHROME = os.environ.get("CHROME_PATH", r"C:/Program Files/Google/Chrome/Application/chrome.exe")
MEDIA_PREFIX = "/uploads/__harness/"

INTRO_CSS = '<link rel="stylesheet" href="assets/css/intro.css">'
INTRO_JS = '<script src="assets/js/intro.js"></script>'
HERO_CSS = '<link rel="stylesheet" href="assets/css/hero.css">'
HERO_JS = '<script src="assets/js/hero.js"></script>'

STATE = {"mode": "404", "delay": 0}
REQUESTS = []          # (path, range header, status) for images and media
LOCK = threading.Lock()
MEDIA = None           # temp folder with the generated media


# ----------------------------------------------------------------- scenarios
IMG = "assets/img/collections/"


def slide(image, eyebrow, headline, text, cta=None, cta2=None, focus="right", alt="", mobile=""):
    s = {"image": image, "image_mobile": mobile, "focus": focus, "eyebrow": eyebrow, "headline": headline,
         "text": text, "cta_label": "", "cta_link": "", "cta2_label": "", "cta2_link": "", "alt": alt}
    if cta:
        s["cta_label"], s["cta_link"] = cta
    if cta2:
        s["cta2_label"], s["cta2_link"] = cta2
    return s


def featured(slug="sanskriti", headline="Sanskriti. Traditions carried forward.", text=None, image="", cta=""):
    names = {
        "sanskriti": ("Sanskriti", "Temple Jewellery", "Temple jewellery for weddings, festivals and family celebrations."),
        "rangmahal": ("Rangmahal", "Precious Stone Jewellery", "Rubies, emeralds and sapphires, set in gold."),
    }
    name, kind, short = names[slug]
    if text is None:
        text = "Temple jewellery shaped by South Indian craft, made for the weddings and festivals your family will remember." if slug == "sanskriti" else ""
    return {"collection": slug, "image": image, "headline": headline, "text": text, "cta_label": cta,
            "resolved": {"slug": slug, "name": name, "kind": kind, "short": short,
                         "hero": f"{IMG}{slug}-hero.jpg", "cover": f"{IMG}{slug}-cover.jpg",
                         "url": f"collection.html?c={slug}", "fallback": False}}


SLIDES = [
    slide(IMG + "sanskriti-hero.jpg", "Sanskriti", "Traditions carried forward",
          "Temple jewellery for the weddings and festivals your family will remember.",
          ("Discover Sanskriti", "collection.html?c=sanskriti"), ("Our story", "about.html"), "right",
          "A bride in a red silk saree wearing a layered gold temple necklace"),
    slide(IMG + "prestige-hero.jpg", "Prestige", "Natural diamonds, chosen with care",
          "Certified stones set in gold for the moments that deserve them.",
          ("Explore Prestige", "collection.html?c=prestige"), None, "right",
          "A woman in a red saree wearing a diamond necklace by the window at dusk"),
    slide(IMG + "rangmahal-hero.jpg", "Rangmahal", "Colour, set in gold",
          "Rubies, emeralds and sapphires from our family of craftsmen.",
          ("See Rangmahal", "collection.html?c=rangmahal"), ("Visit a store", "index.html#stores"), "right",
          "A woman in a green lehenga with emerald jewellery in a palace courtyard"),
]


def hero(mode, slides, video=None, interval=6, overlay=0.45, align="left"):
    return {"mode": mode, "slides": slides,
            "video": video or {"src": "", "src_mobile": "", "poster": "", "poster_mobile": ""},
            "interval": interval, "overlay": overlay, "align": align}


VIDEO = {"src": "uploads/__harness/hero.mp4", "src_mobile": "uploads/__harness/hero-mobile.mp4",
         "poster": "uploads/__harness/poster.jpg", "poster_mobile": "uploads/__harness/poster-mobile.jpg"}
VIDEO_SLIDE = slide("", "Evermore", "Light you can wear every day",
                    "Lab grown diamonds, set in gold for the everyday moments.",
                    ("Discover Evermore", "collection.html?c=evermore"), ("Our story", "about.html"), "right",
                    "A woman laughing in a sunlit room, wearing a fine diamond necklace")

SCENARIOS = {
    "image": {"hero": hero("image", [slide(IMG + "prestige-hero.jpg", "Natural diamonds", "Brilliance, set by hand",
                                           "Certified diamonds in gold, chosen with care for your family's celebrations.",
                                           ("Discover Prestige", "collection.html?c=prestige"), ("Our story", "about.html"),
                                           "right", "A woman in a red saree wearing a diamond necklace by the window at dusk")]),
              "featured": featured("rangmahal", "Rangmahal. Colour, set in gold.", "", "", "")},
    "image_mobile": {"hero": hero("image", [dict(SLIDES[0], image_mobile=IMG + "sanskriti-cover.jpg")]), "featured": featured()},
    "slideshow": {"hero": hero("slideshow", SLIDES, interval=4), "featured": featured()},
    "slideshow_center": {"hero": hero("slideshow", [dict(SLIDES[0], focus="center"), dict(SLIDES[1], focus="left"), SLIDES[2]],
                                       interval=5, overlay=0.6, align="center"), "featured": featured()},
    "video": {"hero": hero("video", [VIDEO_SLIDE], VIDEO), "featured": featured()},
    "video_center": {"hero": hero("video", [VIDEO_SLIDE], VIDEO, overlay=0.3, align="center"), "featured": featured()},
    "video_broken": {"hero": hero("video", [VIDEO_SLIDE], dict(VIDEO, src="uploads/__harness/missing.mp4", src_mobile="")),
                     "featured": featured()},
    "hostile": {"hero": hero("slideshow", [
        slide("../../server/.env", "x", "Bad", "y", ("Click", "javascript:alert(1)")),
        slide(IMG + "nexa-hero.jpg", "<b>Eyebrow</b>", "<img src=x onerror=\"window.__pwned=1\">Headline",
              "Text <script>window.__pwned=1</script>", ("Go", "javascript:alert(1)"), ("Safe", "about.html"),
              "sideways", "alt \" onerror=\"window.__pwned=1")]),
        "featured": {"collection": "x", "resolved": {"slug": "x", "name": "<i>X</i>", "kind": "", "short": "",
                                                     "hero": "javascript:alert(1)", "cover": "", "url": "javascript:alert(1)"}}},
}


# ----------------------------------------------------------------- server
class Handler(SimpleHTTPRequestHandler):
    def __init__(self, *a, **kw):
        super().__init__(*a, directory=str(SITE), **kw)

    def log_message(self, *args):
        pass

    def _send(self, code, body=b"", ctype="application/json", extra=None):
        self.send_response(code)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        for k, v in (extra or {}).items():
            self.send_header(k, v)
        self.end_headers()
        if body and self.command != "HEAD":
            self.wfile.write(body)

    def _log(self, status):
        with LOCK:
            REQUESTS.append((urlsplit(self.path).path, self.headers.get("Range"), status))

    def do_GET(self):
        path = unquote(urlsplit(self.path).path)
        if path.startswith("/__harness/mode/"):
            name = path.rsplit("/", 1)[1]
            q = urlsplit(self.path).query
            delay = int(re.search(r"delay=(\d+)", q).group(1)) if "delay=" in q else 0
            STATE.update(mode=name, delay=delay)
            with LOCK:
                REQUESTS.clear()
            return self._send(200, b'{"ok":true}')
        if path == "/__harness/requests":
            with LOCK:
                return self._send(200, json.dumps(REQUESTS).encode())
        if path == "/api/homepage":
            if STATE["delay"]:
                time.sleep(STATE["delay"] / 1000)
            data = SCENARIOS.get(STATE["mode"])
            if data is None:
                return self._send(404, b'{"error":"Not found"}')
            return self._send(200, json.dumps(data).encode(), "application/json; charset=utf-8")
        if path.startswith("/api/"):
            return self._send(404, b'{"error":"Not found"}')
        if path.startswith(MEDIA_PREFIX):
            return self._media(path[len(MEDIA_PREFIX):])
        if path in ("/", "/index.html"):
            html = (SITE / "index.html").read_text(encoding="utf-8")
            if "assets/css/hero.css" not in html:
                html = html.replace(INTRO_CSS, INTRO_CSS + "\n" + HERO_CSS, 1)
            if "assets/js/hero.js" not in html:
                html = html.replace(INTRO_JS, INTRO_JS + "\n" + HERO_JS, 1)
            return self._send(200, html.encode("utf-8"), "text/html; charset=utf-8")
        if path.startswith("/assets/img/"):
            self._log(200)
        return super().do_GET()

    def _media(self, name):
        f = (MEDIA / name) if MEDIA else None
        if not f or "/" in name or "\\" in name or not f.is_file():
            self._log(404)
            return self._send(404, b"not found", "text/plain")
        size = f.stat().st_size
        ctype = "video/mp4" if name.endswith(".mp4") else "video/webm" if name.endswith(".webm") else "image/jpeg"
        rng = self.headers.get("Range")
        start, end, status = 0, size - 1, 200
        if rng:
            m = re.match(r"bytes=(\d*)-(\d*)$", rng.strip())
            if not m or (not m.group(1) and not m.group(2)):
                self._log(416)
                return self._send(416, b"", ctype, {"Content-Range": f"bytes */{size}"})
            if m.group(1):
                start = int(m.group(1))
                end = min(int(m.group(2)), size - 1) if m.group(2) else size - 1
            else:  # suffix range: the last N bytes
                start = max(0, size - int(m.group(2)))
            if start >= size or start > end:
                self._log(416)
                return self._send(416, b"", ctype, {"Content-Range": f"bytes */{size}"})
            status = 206
        self._log(status)
        with open(f, "rb") as fh:
            fh.seek(start)
            body = fh.read(end - start + 1)
        extra = {"Accept-Ranges": "bytes"}
        if status == 206:
            extra["Content-Range"] = f"bytes {start}-{end}/{size}"
        try:
            self._send(status, body, ctype, extra)
        except (ConnectionResetError, BrokenPipeError, ConnectionAbortedError):
            pass


def make_media():
    """Small H.264 clips and covers from a collection photo (testsrc if that fails)."""
    global MEDIA
    MEDIA = Path(tempfile.mkdtemp(prefix="siroya-hero-"))
    src = SITE / "assets/img/collections/evermore-hero.jpg"
    zoom = "zoompan=z='1.0+0.0012*on':x='iw/2-(iw/zoom/2)':y='ih/2-(ih/zoom/2)':d=96"
    jobs = [
        ["-loop", "1", "-i", str(src), "-vf", f"scale=2400:1350,{zoom}:s=1280x720:fps=24,format=yuv420p",
         "-frames:v", "96", "-c:v", "libx264", "-crf", "26", "-movflags", "+faststart", "-an", "hero.mp4"],
        ["-loop", "1", "-i", str(src), "-vf", f"crop=760:1350:1020:0,scale=540:960,{zoom}:s=540x960:fps=24,format=yuv420p",
         "-frames:v", "96", "-c:v", "libx264", "-crf", "26", "-movflags", "+faststart", "-an", "hero-mobile.mp4"],
    ]
    for args in jobs:
        r = subprocess.run(["ffmpeg", "-hide_banner", "-loglevel", "error", "-y", *args], cwd=MEDIA, capture_output=True)
        if r.returncode != 0:  # plain test pattern, as a last resort
            subprocess.run(["ffmpeg", "-hide_banner", "-loglevel", "error", "-y", "-f", "lavfi", "-i",
                            "testsrc=duration=3:size=640x360:rate=24", "-pix_fmt", "yuv420p", "-movflags", "+faststart",
                            args[-1]], cwd=MEDIA, check=True)
    for clip, cover in (("hero.mp4", "poster.jpg"), ("hero-mobile.mp4", "poster-mobile.jpg")):
        subprocess.run(["ffmpeg", "-hide_banner", "-loglevel", "error", "-y", "-i", clip, "-frames:v", "1", "-q:v", "3", cover],
                       cwd=MEDIA, check=True)


def start_server():
    srv = ThreadingHTTPServer(("127.0.0.1", PORT), Handler)
    srv.daemon_threads = True
    threading.Thread(target=srv.serve_forever, daemon=True).start()
    return srv


# ----------------------------------------------------------------- checks
FAILS = []
PASSES = [0]


def check(cond, msg):
    if cond:
        PASSES[0] += 1
    else:
        FAILS.append(msg)
        print("  FAIL:", msg)


SKIP_INTRO = "try { sessionStorage.setItem('siroya_intro_seen', '1'); } catch (e) {}"
CLS_HOOK = """
window.__cls = 0;
try { new PerformanceObserver(function (l) { l.getEntries().forEach(function (e) { if (!e.hadRecentInput) window.__cls += e.value; }); })
  .observe({ type: 'layout-shift', buffered: true }); } catch (e) {}
"""
READY_HOOK = """
window.__heroReady = null;
addEventListener('siroya:hero-ready', function (e) { window.__heroReady = e.detail.mode; });
"""


def set_mode(page, mode, delay=0):
    page.request.get(f"{BASE}/__harness/mode/{mode}" + (f"?delay={delay}" if delay else ""))


def requests_log(page):
    return page.request.get(f"{BASE}/__harness/requests").json()


def new_page(browser, width=1440, height=900, mobile=False, reduce=False, intro=False, init=""):
    opts = {"viewport": {"width": width, "height": height}, "reduced_motion": "reduce" if reduce else "no-preference"}
    if mobile:
        opts.update(is_mobile=True, has_touch=True, device_scale_factor=2,
                    user_agent="Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0 Mobile Safari/537.36")
    ctx = browser.new_context(**opts)
    ctx.route("https://cdn.jsdelivr.net/**", lambda r: r.abort())  # no Lenis: deterministic scrolling
    if not intro:
        ctx.add_init_script(SKIP_INTRO)
    ctx.add_init_script(READY_HOOK + init)
    page = ctx.new_page()
    errors = []
    page.on("pageerror", lambda e: errors.append(str(e)))
    page.on("console", lambda m: errors.append(m.text) if m.type == "error" and "favicon" not in m.text and "404" not in m.text and "Failed to load resource" not in m.text else None)
    page._errors = errors
    return ctx, page


def open_home(page):
    page.goto(f"{BASE}/index.html", wait_until="domcontentloaded")
    page.wait_for_function("window.__heroReady !== null", timeout=8000)


def js(page, code, arg=None):
    return page.evaluate(code, arg) if arg is not None else page.evaluate(code)


def active_index(page):
    return js(page, "() => [...document.querySelectorAll('.hero-slide')].findIndex(s => s.classList.contains('is-active'))")


def shot(page, name, wait=0):
    if wait:
        page.wait_for_timeout(wait)
    page.screenshot(path=str(SHOTS / f"{name}.png"))


def no_errors(page, label):
    errs = [e for e in page._errors]
    check(not errs, f"{label}: page errors {errs}")


# ---- individual checks
def t_static_404(browser):
    print("static hero when /api/homepage is 404")
    set_mode_ctx, page = new_page(browser)
    set_mode(page, "404")
    t0 = time.time()
    open_home(page)
    check(js(page, "window.__heroReady") == "static", "hero-ready reports static")
    check(time.time() - t0 < 2.5, "static hero released quickly")
    check(not js(page, "document.documentElement.classList.contains('hero-pending')"), "hero-pending removed")
    check(js(page, "document.querySelector('.hero').hasAttribute('data-hero-mode')") is False, "no render on 404")
    check(js(page, "document.querySelector('.hero > .hero-media img').getAttribute('src')") == "assets/img/home/hero.jpg", "static image kept")
    page.wait_for_timeout(1500)
    check(js(page, "getComputedStyle(document.querySelector('.hero > .hero-media')).opacity") == "1", "static media visible")
    check(js(page, "getComputedStyle(document.querySelector('.hero > .wrap')).visibility") == "visible", "static copy visible")
    check("feels like home" in js(page, "document.querySelector('.hero h1').textContent"), "static headline kept")
    no_errors(page, "404")
    set_mode_ctx.close()


def t_slow(browser):
    print("slow API: static first, then a cross-fade to the live hero")
    for w, h in ((1440, 900), (390, 844)):
        ctx, page = new_page(browser, w, h, mobile=w < 600, init=CLS_HOOK)
        # 1.3 s: past the 0.9 s hold, with room to spare under the 2.5 s timeout
        set_mode(page, "image", delay=1300)
        page.goto(f"{BASE}/index.html", wait_until="domcontentloaded")
        page.wait_for_timeout(1000)
        check(not js(page, "document.documentElement.classList.contains('hero-pending')"), f"{w}: static shown after the hold")
        check(js(page, "!!document.querySelector('.hero > .hero-media img[src=\"assets/img/home/hero.jpg\"]')"), f"{w}: static image on screen while waiting")
        page.wait_for_function("window.__heroReady === 'image'", timeout=5000)
        check(js(page, "!!document.querySelector('.hero > .hero-old')"), f"{w}: static kept underneath during the cross-fade")
        old = js(page, "() => { const o = document.querySelector('.hero > .hero-old.wrap'); return o ? [o.getAttribute('aria-hidden'), o.hasAttribute('inert'), getComputedStyle(o).position] : null }")
        check(old == ["true", True, "absolute"], f"{w}: outgoing copy hidden from assistive tech and out of the flow {old}")
        page.wait_for_timeout(250)
        mid = js(page, "() => { const r = document.querySelector('.hero-slide .hero-copy').getBoundingClientRect(); return [Math.round(r.left), Math.round(r.width)] }")
        page.wait_for_timeout(1700)
        check(not js(page, "!!document.querySelector('.hero > .hero-old')"), f"{w}: static removed after the cross-fade")
        fin = js(page, "() => { const r = document.querySelector('.hero-slide .hero-copy').getBoundingClientRect(); return [Math.round(r.left), Math.round(r.width)] }")
        check(mid == fin, f"{w}: new copy already in its final place mid-fade {mid} vs {fin}")
        cls = js(page, "window.__cls")
        check(cls < 0.05, f"{w}: CLS during the cross-fade {cls:.4f} < 0.05")
        check(js(page, "document.querySelectorAll('.hero h1').length") == 1, f"{w}: one h1 after the swap")
        no_errors(page, f"slow {w}")
        ctx.close()


def t_image(browser):
    print("single image")
    ctx, page = new_page(browser)
    set_mode(page, "image")
    open_home(page)
    check(js(page, "window.__heroReady") == "image", "hero-ready image")
    hero = js(page, """() => { const h = document.querySelector('.hero'), img = h.querySelector('.hero-media img');
      return { mode: h.dataset.heroMode, src: img.getAttribute('src'), pri: img.getAttribute('fetchpriority'), focus: img.closest('.hero-media').dataset.focus,
               pos: getComputedStyle(img).objectPosition, bar: !!h.querySelector('.hero-bar'), h1: h.querySelector('h1').textContent,
               ctas: [...h.querySelectorAll('.hero-ctas a')].map(a => a.getAttribute('href')), slides: h.querySelectorAll('.hero-slide').length,
               role: h.getAttribute('aria-roledescription'), pic: !!img.closest('picture'), alt: img.alt } }""")
    check(hero["mode"] == "image" and hero["slides"] == 1, "one image slide")
    check(hero["src"].endswith("prestige-hero.jpg") and hero["pri"] == "high", "first image fetchpriority high")
    check(hero["pic"] and hero["focus"] == "right" and hero["pos"].startswith("68%"), f"picture + focus right ({hero['pos']})")
    check(not hero["bar"] and hero["role"] is None, "no controls, no carousel role")
    check(hero["h1"] == "Brilliance, set by hand", "headline")
    check(hero["ctas"] == ["collection.html?c=prestige", "about.html"], "buttons")
    check("diamond necklace" in hero["alt"], "alt text")
    check(js(page, "getComputedStyle(document.querySelector('.hero .hero-eyebrow')).color") == "rgb(245, 242, 236)", "eyebrow in cream (legible on light photos)")
    floor = js(page, "getComputedStyle(document.querySelector('.hero .hero-copy'), '::before').backgroundImage")
    check(floor.startswith("radial-gradient"), f"copy keeps its own dark ground ({floor[:40]})")
    page.wait_for_timeout(2600)
    check(js(page, "[...document.querySelectorAll('.hero .rv')].every(e => getComputedStyle(e).opacity === '1')"), "copy revealed")
    check(js(page, "getComputedStyle(document.querySelector('.hero .hero-slide .hero-media')).opacity") == "1", "media faded in")
    shot(page, "image-1440")
    # Featured collection section follows featured.resolved
    page.wait_for_function("document.documentElement.dataset.catalog", timeout=6000)
    page.wait_for_timeout(300)
    f = js(page, """() => { const b = document.querySelector('.feature'), c = b.querySelector('.feature-copy');
      return { eyebrow: c.querySelector('.eyebrow').textContent.trim(), h2: c.querySelector('h2').textContent.replace(/\\s+/g,' ').trim(),
               h2label: c.querySelector('h2').getAttribute('aria-label'), lede: c.querySelector('.lede').textContent.trim(),
               img: b.querySelector(':scope > a img').getAttribute('src'), href: b.querySelector(':scope > a').getAttribute('href'),
               cta: c.querySelector('.link-arrow').textContent.trim(), ctaHref: c.querySelector('.link-arrow').getAttribute('href'),
               minis: [...c.querySelectorAll('#feature-products a')].map(a => a.getAttribute('href')) } }""")
    check(f["eyebrow"] == "Rangmahal" and f["h2"] == "Colour, set in gold.", f"featured heading {f['eyebrow']!r} {f['h2']!r}")
    check(f["lede"].startswith("Rubies, emeralds"), "featured text falls back to the collection")
    check(f["img"].endswith("rangmahal-hero.jpg") and f["href"] == "collection.html?c=rangmahal", "featured image and link")
    check(f["cta"] == "Discover Rangmahal" and f["ctaHref"] == "collection.html?c=rangmahal", "featured button")
    check(len(f["minis"]) >= 3 and all("rangmahal" in h for h in f["minis"]), f"featured minis {f['minis']}")
    page.evaluate("document.querySelector('.feature').scrollIntoView({block: 'center'})")
    shot(page, "featured-1440", 1800)
    no_errors(page, "image")
    ctx.close()

    ctx, page = new_page(browser, 390, 844, mobile=True)
    set_mode(page, "image")
    open_home(page)
    shot(page, "image-390", 2600)
    no_errors(page, "image phone")
    ctx.close()


def t_image_mobile(browser):
    print("single image with a phone crop")
    ctx, page = new_page(browser, 390, 844, mobile=True)
    set_mode(page, "image_mobile")
    open_home(page)
    page.wait_for_timeout(600)
    r = js(page, """() => { const m = document.querySelector('.hero .hero-media'), img = m.querySelector('img'), s = m.querySelector('source');
      return { media: s && s.getAttribute('media'), srcset: s && s.getAttribute('srcset'), cur: img.currentSrc, has: m.classList.contains('has-mobile'),
               pos: getComputedStyle(img).objectPosition, top: getComputedStyle(img).top } }""")
    check(r["media"] == "(max-width: 760px)" and r["srcset"].endswith("sanskriti-cover.jpg"), "phone <source>")
    check(r["cur"].endswith("sanskriti-cover.jpg"), f"phone crop chosen ({r['cur']})")
    check(r["has"] and r["pos"] == "50% 50%" and r["top"] == "0px", f"phone crop centred, not nudged ({r['pos']}, {r['top']})")
    shot(page, "image-mobile-390", 2200)
    no_errors(page, "image_mobile")
    ctx.close()


def t_slideshow(browser):
    print("slideshow on desktop")
    ctx, page = new_page(browser)
    set_mode(page, "slideshow")
    open_home(page)
    page.wait_for_timeout(200)
    a = js(page, """() => { const h = document.querySelector('.hero'), sl = [...h.querySelectorAll('.hero-slide')];
      return { role: h.getAttribute('aria-roledescription'), n: sl.length,
               groups: sl.map(s => [s.getAttribute('role'), s.getAttribute('aria-roledescription'), s.getAttribute('aria-label')]),
               inert: sl.map(s => s.hasAttribute('inert')),
               tab: sl.map(s => [...s.querySelectorAll('a')].map(x => x.tabIndex)),
               srcs: sl.map(s => s.querySelector('img').getAttribute('src')),
               h1s: h.querySelectorAll('h1').length, toggle: h.querySelector('.hero-toggle').getAttribute('aria-label'),
               dots: [...h.querySelectorAll('.hero-dot')].map(d => d.getAttribute('aria-current')) } }""")
    check(a["role"] == "carousel" and a["n"] == 3, "carousel with 3 slides")
    check(a["groups"] == [["group", "slide", f"{i} of 3"] for i in (1, 2, 3)], f"slide groups {a['groups']}")
    check(a["inert"] == [False, True, True], "only the active slide is reachable")
    check(all(t >= 0 for t in a["tab"][0]) and all(t == -1 for s in a["tab"][1:] for t in s), f"only active links focusable {a['tab']}")
    check(a["srcs"][0] and a["srcs"][1] and a["srcs"][2] is None, f"only the next image fetched ahead {a['srcs']}")
    check(a["h1s"] == 1, "one h1")
    o = js(page, """() => { const h1 = document.querySelector('.hero h1');
      return { inSlides: !!h1.closest('.hero-slides'), hidden: !!h1.closest('[aria-hidden="true"], [inert]'), text: h1.textContent,
               heads: [...document.querySelectorAll('.hero-slide .hero-title')].map(e => e.tagName + '.' + e.className.split(' ').includes('h1')) } }""")
    check(not o["inSlides"] and not o["hidden"] and o["text"] == "Siroya Jewellers", f"persistent h1 outside the slides {o}")
    check(o["heads"] == ["H2.true"] * 3, f"slide headlines are h2 styled as h1 {o['heads']}")
    check(a["toggle"] == "Pause slideshow", "Pause button")
    check(a["dots"] == ["true", None, None], "first picker current")
    imgs = [p for p, _, _ in requests_log(page) if "collections/" in p and p.endswith("-hero.jpg")]
    check("/assets/img/collections/rangmahal-hero.jpg" not in imgs, f"third image not requested yet {imgs}")
    shot(page, "slideshow-1-1440", 2600)
    # Mid-fade: the incoming slide fades over the outgoing one, which stays fully opaque underneath
    page.wait_for_function("document.querySelectorAll('.hero-slide')[1].classList.contains('is-active')", timeout=4000)
    page.wait_for_timeout(350)
    mid = js(page, "() => [...document.querySelectorAll('.hero-slide .hero-media')].map(m => +getComputedStyle(m).opacity)")
    check(mid[0] == 1 and 0 < mid[1] < 1, f"cross-fade over the outgoing slide {mid}")
    zoom = js(page, "() => new DOMMatrix(getComputedStyle(document.querySelectorAll('.hero-zoom')[1]).transform).a")
    check(1.0 < zoom < 1.06, f"slow zoom running ({zoom:.4f})")
    check(js(page, "document.querySelectorAll('.hero-slide img')[2].getAttribute('src')") is not None, "next image fetched once its turn comes")
    page.wait_for_timeout(1300)
    mid = js(page, "() => [...document.querySelectorAll('.hero-slide .hero-media')].map(m => +getComputedStyle(m).opacity)")
    check(mid[0] == 0 and mid[1] == 1, f"outgoing slide gone after the fade {mid}")
    check(js(page, "getComputedStyle(document.querySelectorAll('.hero-slide-copy')[0]).visibility") == "hidden", "old copy hidden")
    shot(page, "slideshow-2-1440", 1200)
    # Pause / Play
    page.mouse.move(1300, 200)
    page.click(".hero-toggle")
    i0 = active_index(page)
    check(js(page, "document.querySelector('.hero-toggle').getAttribute('aria-label')") == "Play slideshow", "toggle says Play")
    check(js(page, "document.querySelector('.hero').classList.contains('is-still')"), "is-still when paused")
    check(js(page, "document.querySelector('.hero-slides').getAttribute('aria-live')") == "polite", "polite live region when paused")
    page.mouse.move(1300, 200)
    page.wait_for_timeout(5000)
    check(active_index(page) == i0, "no advance while paused")
    page.click(".hero-toggle")
    page.mouse.move(1300, 200)
    check(js(page, "document.querySelector('.hero-slides').getAttribute('aria-live')") == "off", "live region off while rotating")
    page.wait_for_timeout(4700)
    check(active_index(page) == (i0 + 1) % 3, "advances again after Play")
    # Hover over the words pauses, moving away resumes
    page.mouse.move(200, 650)
    page.wait_for_timeout(100)
    held = js(page, "document.querySelector('.hero').classList.contains('is-held')")
    over = js(page, "!!document.elementFromPoint(200, 650).closest('.hero-copy')")
    check(held == over and over, f"hover on the copy pauses (over={over}, held={held})")
    page.mouse.move(1300, 200)
    page.wait_for_timeout(100)
    check(not js(page, "document.querySelector('.hero').classList.contains('is-held')"), "resumes when the pointer leaves the copy")
    # Buttons and pickers
    i = active_index(page)
    page.click(".hero-next"); page.wait_for_timeout(250)
    check(active_index(page) == (i + 1) % 3, "Next button")
    page.click(".hero-prev"); page.wait_for_timeout(250)
    check(active_index(page) == i, "Previous button")
    page.click(".hero-dot:nth-child(3)"); page.wait_for_timeout(900)
    check(active_index(page) == 2 and js(page, "document.querySelectorAll('.hero-dot')[2].getAttribute('aria-current')") == "true", "slide picker")
    check(js(page, "document.querySelector('.hero-count').textContent") == "03 / 03", "count")
    page.mouse.move(1300, 200)
    # Keyboard: Tab into the controls pauses, arrows move
    page.keyboard.press("Escape")
    page.evaluate("document.querySelector('.hero-prev').focus()")
    for _ in range(8):
        if js(page, "document.activeElement && document.activeElement.classList.contains('hero-next')"):
            break
        page.keyboard.press("Tab")
    check(js(page, "document.activeElement.classList.contains('hero-next')"), "Tab reaches Next")
    ring = js(page, "() => { const s = getComputedStyle(document.activeElement); return [s.outlineStyle, s.outlineColor, s.boxShadow] }")
    check(ring[0] == "solid" and ring[1] == "rgb(226, 194, 131)" and "rgba(36, 26, 25" in ring[2], f"focus ring: gold on a dark halo {ring}")
    page.wait_for_timeout(50)
    check(js(page, "document.querySelector('.hero').classList.contains('is-held')"), "keyboard focus inside pauses")
    i = active_index(page)
    page.keyboard.press("ArrowRight"); page.wait_for_timeout(900)
    check(active_index(page) == (i + 1) % 3, "ArrowRight = next")
    page.keyboard.press("ArrowLeft"); page.wait_for_timeout(900)
    check(active_index(page) == i, "ArrowLeft = previous")
    # Whichever slide shows, the accessibility tree keeps exactly one h1
    for k in (1, 2):
        js(page, f"document.querySelector('.hero')._siroyaHero.go({k})")
        page.wait_for_timeout(900)
        h1s = js(page, "() => [...document.querySelectorAll('h1')].filter(e => !e.closest('[aria-hidden=\"true\"], [inert]')).length")
        check(h1s == 1, f"slide {k + 1}: one h1 in the accessibility tree ({h1s})")
    # Focus inside a slide follows the slide
    page.evaluate("document.querySelector('.hero-slide.is-active .hero-ctas a').focus()")
    page.keyboard.press("ArrowRight"); page.wait_for_timeout(900)
    check(js(page, "!!document.activeElement.closest('.hero-slide.is-active')"), "focus moves into the new slide")
    page.evaluate("document.activeElement.blur()")
    page.mouse.move(1300, 200)
    # Hidden tab
    page.evaluate("Object.defineProperty(document, 'hidden', {configurable: true, get: () => true}); document.dispatchEvent(new Event('visibilitychange'))")
    check(js(page, "document.querySelector('.hero').classList.contains('is-held')"), "hidden tab pauses")
    page.evaluate("Object.defineProperty(document, 'hidden', {configurable: true, get: () => false}); document.dispatchEvent(new Event('visibilitychange'))")
    page.wait_for_timeout(50)
    check(not js(page, "document.querySelector('.hero').classList.contains('is-held')"), "visible tab resumes")
    # Off-screen
    page.evaluate("window.scrollTo(0, document.body.scrollHeight)")
    page.wait_for_timeout(400)
    check(js(page, "document.querySelector('.hero').classList.contains('is-held')"), "off-screen pauses")
    page.evaluate("window.scrollTo(0, 0)")
    page.wait_for_timeout(400)
    check(not js(page, "document.querySelector('.hero').classList.contains('is-held')"), "back on screen resumes")
    no_errors(page, "slideshow")
    ctx.close()

    ctx, page = new_page(browser)
    set_mode(page, "slideshow_center")
    open_home(page)
    r = js(page, """() => ({ pos: [...document.querySelectorAll('.hero-slide .hero-media img')].map(i => getComputedStyle(i).objectPosition),
      align: getComputedStyle(document.querySelector('.hero-slide .hero-copy')).textAlign })""")
    check(r["pos"][0].startswith("50%") and r["pos"][1].startswith("30%") and r["pos"][2].startswith("68%"), f"focus centre / left / right {r['pos']}")
    check(r["align"] == "center", "centred copy")
    shot(page, "slideshow-center-1440", 2600)
    ctx.close()

    ctx, page = new_page(browser, 390, 844, mobile=True)
    set_mode(page, "slideshow_center")
    open_home(page)
    shot(page, "slideshow-center-390", 2600)
    no_errors(page, "slideshow centre phone")
    ctx.close()


def swipe(page, cdp, x0, y0, x1, y1, steps=8):
    cdp.send("Input.dispatchTouchEvent", {"type": "touchStart", "touchPoints": [{"x": x0, "y": y0}]})
    for k in range(1, steps + 1):
        cdp.send("Input.dispatchTouchEvent", {"type": "touchMove", "touchPoints": [{"x": x0 + (x1 - x0) * k / steps, "y": y0 + (y1 - y0) * k / steps}]})
        page.wait_for_timeout(16)
    cdp.send("Input.dispatchTouchEvent", {"type": "touchEnd", "touchPoints": []})
    page.wait_for_timeout(900)


def t_slideshow_phone(browser):
    print("slideshow on a phone: swipe")
    ctx, page = new_page(browser, 390, 844, mobile=True)
    set_mode(page, "slideshow")
    open_home(page)
    page.wait_for_timeout(2600)
    check(js(page, "getComputedStyle(document.querySelector('.hero-next')).display") == "none", "no arrows on phones")
    shot(page, "slideshow-1-390")
    cdp = ctx.new_cdp_session(page)
    i = active_index(page)
    swipe(page, cdp, 320, 420, 70, 432)
    check(active_index(page) == (i + 1) % 3, "swipe left = next")
    swipe(page, cdp, 70, 420, 330, 410)
    check(active_index(page) == i, "swipe right = previous")
    swipe(page, cdp, 200, 600, 205, 300)
    check(active_index(page) == i, "vertical swipe leaves the slide alone")
    page.evaluate("window.scrollTo(0, 0)")
    page.wait_for_timeout(300)
    page.tap(".hero-dot:nth-child(2)")
    shot(page, "slideshow-2-390", 2200)
    page.tap(".hero-dot:nth-child(3)")
    shot(page, "slideshow-3-390", 2200)
    check(active_index(page) == 2, "tap on a slide picker")
    no_errors(page, "slideshow phone")
    ctx.close()


def t_reduced(browser):
    print("reduced motion")
    ctx, page = new_page(browser, reduce=True)
    set_mode(page, "slideshow")
    open_home(page)
    page.wait_for_timeout(300)
    check(js(page, "document.querySelector('.hero-toggle').getAttribute('aria-label')") == "Play slideshow", "no autoplay: toggle offers Play")
    check(js(page, "getComputedStyle(document.querySelector('.hero-zoom')).transform") == "none", "no zoom")
    page.wait_for_timeout(4800)
    check(active_index(page) == 0, "does not advance by itself")
    page.click(".hero-next")
    page.wait_for_timeout(120)
    op = js(page, "() => [...document.querySelectorAll('.hero-slide .hero-media')].map(m => getComputedStyle(m).opacity)")
    check(op[1] == "1", f"instant swap {op}")
    check(js(page, "[...document.querySelectorAll('.hero-slide.is-active .rv')].every(e => getComputedStyle(e).opacity === '1')"), "copy shown without motion")
    no_errors(page, "reduced slideshow")
    ctx.close()

    ctx, page = new_page(browser, reduce=True)
    set_mode(page, "video")
    open_home(page)
    r = js(page, "() => ({ video: !!document.querySelector('.hero video'), img: (document.querySelector('.hero .hero-media img') || {}).getAttribute && document.querySelector('.hero .hero-media img').getAttribute('src'), bar: !!document.querySelector('.hero-bar') })")
    check(not r["video"] and r["img"] and r["img"].endswith("poster.jpg") and not r["bar"], f"reduced motion video = cover only {r}")
    no_errors(page, "reduced video")
    ctx.close()


def t_savedata(browser):
    print("Save-Data slideshow")
    ctx, page = new_page(browser, init="Object.defineProperty(navigator, 'connection', {configurable: true, get: () => ({ saveData: true, effectiveType: '4g' })});")
    set_mode(page, "slideshow")
    open_home(page)
    page.wait_for_timeout(300)
    check(js(page, "document.querySelector('.hero-toggle').getAttribute('aria-label')") == "Play slideshow", "Save-Data: no autoplay, toggle offers Play")
    srcs = js(page, "() => [...document.querySelectorAll('.hero-slide img')].map(i => i.getAttribute('src'))")
    check(srcs[0] and srcs[1] is None and srcs[2] is None, f"Save-Data: nothing fetched ahead {srcs}")
    page.mouse.move(1300, 200)
    page.wait_for_timeout(4800)
    check(active_index(page) == 0, "Save-Data: does not advance by itself")
    imgs = [p for p, _, _ in requests_log(page) if "collections/" in p and p.endswith("-hero.jpg")]
    check(imgs == ["/assets/img/collections/sanskriti-hero.jpg"], f"Save-Data: only the first slide downloaded {imgs}")
    page.click(".hero-next")
    page.wait_for_timeout(900)
    check(active_index(page) == 1, "Save-Data: Next still works")
    no_errors(page, "savedata")
    ctx.close()


def video_state(page):
    return js(page, """() => { const v = document.querySelector('.hero video');
      return v ? { paused: v.paused, t: v.currentTime, muted: v.muted, src: v.getAttribute('src'), poster: v.getAttribute('poster'),
        attrs: ['muted', 'loop', 'playsinline', 'autoplay'].filter(a => v.hasAttribute(a)), preload: v.getAttribute('preload'),
        label: document.querySelector('.hero-toggle').getAttribute('aria-label') } : null }""")


def t_video(browser):
    print("video")
    ctx, page = new_page(browser)
    set_mode(page, "video")
    open_home(page)
    v = video_state(page)
    check(v and v["attrs"] == ["muted", "loop", "playsinline", "autoplay"] and v["preload"] == "metadata", f"video attributes {v and v['attrs']}")
    check(v["src"].endswith("/hero.mp4") and v["poster"].endswith("/poster.jpg") and v["muted"], "desktop file and cover")
    page.wait_for_function("(() => { const v = document.querySelector('.hero video'); return v && !v.paused && v.currentTime > 0.3; })()", timeout=8000)
    check(True, "plays muted inline")
    reqs = requests_log(page)
    check(any(p.endswith("hero.mp4") and s == 206 for p, r, s in reqs), f"Range requests answered with 206 {[(p, r, s) for p, r, s in reqs if 'mp4' in p][:4]}")
    shot(page, "video-1440", 1500)
    page.mouse.move(1300, 200)
    page.click(".hero-toggle")
    page.wait_for_timeout(200)
    v = video_state(page)
    check(v["paused"] and v["label"] == "Play video", "Pause button pauses")
    page.click(".hero-toggle")
    page.wait_for_timeout(400)
    v = video_state(page)
    check(not v["paused"] and v["label"] == "Pause video", "Play button resumes")
    page.evaluate("window.scrollTo(0, document.body.scrollHeight)")
    page.wait_for_timeout(500)
    check(video_state(page)["paused"], "pauses off-screen")
    page.evaluate("window.scrollTo(0, 0)")
    page.wait_for_timeout(600)
    check(not video_state(page)["paused"], "plays again on screen")
    page.evaluate("Object.defineProperty(document, 'hidden', {configurable: true, get: () => true}); document.dispatchEvent(new Event('visibilitychange'))")
    page.wait_for_timeout(100)
    check(video_state(page)["paused"], "pauses in a hidden tab")
    page.evaluate("Object.defineProperty(document, 'hidden', {configurable: true, get: () => false}); document.dispatchEvent(new Event('visibilitychange'))")
    page.wait_for_timeout(400)
    check(not video_state(page)["paused"], "plays again when the tab is back")
    no_errors(page, "video")
    ctx.close()

    ctx, page = new_page(browser, 390, 844, mobile=True)
    set_mode(page, "video")
    open_home(page)
    v = video_state(page)
    check(v["src"].endswith("/hero-mobile.mp4") and v["poster"].endswith("/poster-mobile.jpg"), "phone file and cover")
    page.wait_for_function("(() => { const v = document.querySelector('.hero video'); return v && !v.paused && v.currentTime > 0.3; })()", timeout=8000)
    shot(page, "video-390", 1500)
    no_errors(page, "video phone")
    ctx.close()

    ctx, page = new_page(browser)
    set_mode(page, "video_center")
    open_home(page)
    shade = js(page, """() => [getComputedStyle(document.querySelector('.hero-title')).textShadow, getComputedStyle(document.querySelector('.hero-eyebrow')).textShadow]""")
    check(all(s and s != "none" for s in shade), f"light overlay: copy carries its own shadow {shade}")
    shot(page, "video-center-1440", 2600)
    ctx.close()

    ctx, page = new_page(browser, 390, 844, mobile=True)
    set_mode(page, "video_center")
    open_home(page)
    shot(page, "video-center-390", 2600)
    no_errors(page, "video centre phone")
    ctx.close()

    ctx, page = new_page(browser, init="Object.defineProperty(navigator, 'connection', {configurable: true, get: () => ({ saveData: true, effectiveType: '4g' })});")
    set_mode(page, "video")
    open_home(page)
    check(not js(page, "!!document.querySelector('.hero video')"), "Save-Data shows the cover only")
    ctx.close()

    ctx, page = new_page(browser, init="Object.defineProperty(navigator, 'connection', {configurable: true, get: () => ({ saveData: false, effectiveType: '3g' })});")
    set_mode(page, "video")
    open_home(page)
    check(not js(page, "!!document.querySelector('.hero video')"), "3G shows the cover only")
    ctx.close()

    ctx, page = new_page(browser)
    set_mode(page, "video_broken")
    open_home(page)
    page.wait_for_timeout(1500)
    r = js(page, "() => ({ video: !!document.querySelector('.hero video'), img: document.querySelector('.hero .hero-media img') && document.querySelector('.hero .hero-media img').getAttribute('src'), bar: !!document.querySelector('.hero-bar') })")
    check(not r["video"] and r["img"] and r["img"].endswith("poster.jpg") and not r["bar"], f"unplayable file falls back to the cover {r}")
    ctx.close()


def t_intro(browser):
    print("intro hand-off")
    ctx, page = new_page(browser, intro=True)
    set_mode(page, "video")
    page.goto(f"{BASE}/index.html", wait_until="domcontentloaded")
    page.wait_for_function("window.__heroReady !== null", timeout=8000)
    check(js(page, "document.documentElement.classList.contains('intro-active')"), "intro is up")
    page.wait_for_timeout(800)
    v = video_state(page)
    check(v and v["paused"] and "autoplay" not in v["attrs"], f"video waits behind the intro {v and v['attrs']}")
    page.click(".intro-skip")
    page.wait_for_function("document.body.classList.contains('intro-done')", timeout=5000)
    page.wait_for_function("(() => { const v = document.querySelector('.hero video'); return v && !v.paused && v.currentTime > 0.2; })()", timeout=8000)
    check(True, "video starts on siroya:intro-done")
    page.wait_for_timeout(3600)
    check(js(page, "[...document.querySelectorAll('.hero .rv')].every(e => getComputedStyle(e).opacity === '1')"), "copy revealed after the intro")
    check(js(page, "getComputedStyle(document.querySelector('.hero video')).transform") in ("none", "matrix(1, 0, 0, 1, 0, 0)"), "video settles after the intro scale")
    shot(page, "intro-video-1440")
    no_errors(page, "intro video")
    ctx.close()

    ctx, page = new_page(browser, intro=True)
    set_mode(page, "slideshow")
    page.goto(f"{BASE}/index.html", wait_until="domcontentloaded")
    page.wait_for_function("window.__heroReady !== null", timeout=8000)
    page.wait_for_timeout(300)
    check(js(page, "document.querySelector('.hero').classList.contains('is-held')"), "slideshow held behind the intro")
    page.wait_for_timeout(4300)
    check(active_index(page) == 0, "no advance behind the intro")
    page.click(".intro-skip")
    page.wait_for_function("document.body.classList.contains('intro-done')", timeout=5000)
    page.mouse.move(1300, 200)
    page.wait_for_timeout(200)
    check(not js(page, "document.querySelector('.hero').classList.contains('is-held')"), "released after the intro")
    page.wait_for_timeout(4600)
    check(active_index(page) == 1, "advances after the intro")
    no_errors(page, "intro slideshow")
    ctx.close()

    ctx, page = new_page(browser, intro=True)
    set_mode(page, "image")
    page.goto(f"{BASE}/index.html", wait_until="domcontentloaded")
    page.wait_for_function("window.__heroReady !== null", timeout=8000)
    t = js(page, "getComputedStyle(document.querySelector('.hero .hero-media img')).transform")
    check(t.startswith("matrix(1.14"), f"image waits scaled behind the intro ({t})")
    page.click(".intro-skip")
    page.wait_for_function("document.body.classList.contains('intro-done')", timeout=5000)
    page.wait_for_timeout(3800)
    check(js(page, "!!document.querySelector('.hero h1.m-split.in')"), "headline word rise ran")
    shot(page, "intro-image-1440")
    no_errors(page, "intro image")
    ctx.close()


def t_hostile(browser):
    print("hostile data")
    ctx, page = new_page(browser)
    set_mode(page, "hostile")
    open_home(page)
    page.wait_for_timeout(500)
    r = js(page, """() => { const h = document.querySelector('.hero');
      return { mode: h.dataset.heroMode, imgs: [...h.querySelectorAll('img')].map(i => i.getAttribute('src')),
               hrefs: [...h.querySelectorAll('a')].map(a => a.getAttribute('href')), h1: h.querySelector('h1').textContent,
               eyebrow: h.querySelector('.eyebrow').textContent, focus: h.querySelector('.hero-media').dataset.focus,
               pwned: !!window.__pwned, scripts: h.querySelectorAll('script, b, img[src="x"]').length } }""")
    check(r["mode"] == "image", "one usable slide = single image")
    check(r["imgs"] == [IMG + "nexa-hero.jpg"], f"bad media path dropped {r['imgs']}")
    check(r["hrefs"] == ["about.html"], f"javascript: links dropped {r['hrefs']}")
    check(r["h1"].startswith("<img") and r["eyebrow"] == "<b>Eyebrow</b>" and r["scripts"] == 0, "markup shown as text")
    check(r["focus"] == "right" and not r["pwned"], "unknown focus falls back, nothing ran")
    page.wait_for_function("document.documentElement.dataset.catalog", timeout=6000)
    page.wait_for_timeout(300)
    f = js(page, "() => ({ href: document.querySelector('.feature > a').getAttribute('href'), img: document.querySelector('.feature > a img').getAttribute('src') })")
    check(f["href"] == "collection.html?c=x" and not f["img"].startswith("javascript"), f"featured link and image sanitised {f}")
    # Raw, unvalidated editor state handed straight to render() (the admin preview path)
    raw = js(page, """() => { const sec = document.querySelector('.hero');
      const ret = window.SiroyaHero.render(sec, { mode: 'image', slides: [{ image: 'javascript:alert(1)', image_mobile: '//evil.example/track.jpg',
        headline: 'Raw', cta_label: 'click', cta_link: 'javascript:alert(document.domain)', cta2_label: 'data',
        cta2_link: 'data:text/html,<script>alert(1)</script>' }], video: {} }, { preview: true, instant: true });
      const after = { ret: ret, mode: sec.dataset.heroMode || null, hrefs: [...sec.querySelectorAll('a')].map(a => a.getAttribute('href')),
        srcs: [...sec.querySelectorAll('img, source')].map(e => e.getAttribute('src') || e.getAttribute('srcset') || e.getAttribute('data-src') || e.getAttribute('data-srcset')) };
      window.SiroyaHero.render(sec, { mode: 'image', slides: [{ image: 'assets/img/collections/nexa-hero.jpg', image_mobile: '//evil.example/t.jpg',
        headline: 'Raw ok', cta_label: 'Bad', cta_link: 'javascript:alert(1)', cta2_label: 'Good', cta2_link: 'about.html' }], video: {} }, { preview: true, instant: true });
      after.ok = { hrefs: [...sec.querySelectorAll('a')].map(a => a.getAttribute('href')), srcs: [...sec.querySelectorAll('img, source')].map(e => e.getAttribute('src') || e.getAttribute('srcset')) };
      return after; }""")
    check(raw["ret"] is None and all(not h.startswith(("javascript", "data", "//")) for h in raw["hrefs"]) and all(not s or not re.match(r"^(javascript|data|//)", s) for s in raw["srcs"]), f"raw hostile object: nothing usable, so nothing rendered; no script, data or off-site URLs {raw}")
    check(raw["ok"]["hrefs"] == ["about.html"] and raw["ok"]["srcs"] == [IMG + "nexa-hero.jpg"], f"raw object: good values kept, bad ones dropped {raw['ok']}")
    no_errors(page, "hostile")
    ctx.close()


def main():
    global SHOTS
    serve_only = "--serve" in sys.argv
    make_media()
    srv = start_server()
    print(f"Serving {SITE} at {BASE} (media in {MEDIA})")
    try:
        if serve_only:
            print("Ctrl+C to stop. Switch scenarios with /__harness/mode/<" + "|".join(SCENARIOS) + "|404>")
            while True:
                time.sleep(1)
        from playwright.sync_api import sync_playwright
        SHOTS = Path(os.environ.get("HERO_SHOTS") or tempfile.mkdtemp(prefix="siroya-hero-shots-"))
        SHOTS.mkdir(parents=True, exist_ok=True)
        only = [a for a in sys.argv[1:] if not a.startswith("-")]
        tests = [t_static_404, t_slow, t_image, t_image_mobile, t_slideshow, t_slideshow_phone, t_reduced, t_savedata, t_video, t_intro, t_hostile]
        with sync_playwright() as p:
            browser = p.chromium.launch(executable_path=CHROME, headless=not os.environ.get("HEADED"))
            for t in tests:
                if only and not any(o in t.__name__ for o in only):
                    continue
                try:
                    t(browser)
                except Exception as e:  # keep going, report at the end
                    FAILS.append(f"{t.__name__}: {e!r}")
                    print("  ERROR:", t.__name__, repr(e)[:400])
            browser.close()
        print(f"\nScreenshots: {SHOTS}")
        print(f"{PASSES[0]} passed, {len(FAILS)} failed")
        for f in FAILS:
            print(" -", f)
        return 1 if FAILS else 0
    except KeyboardInterrupt:
        return 0
    finally:
        srv.shutdown()
        srv.server_close()
        if MEDIA:
            shutil.rmtree(MEDIA, ignore_errors=True)


if __name__ == "__main__":
    sys.exit(main())
