"""Browser test for the public tracking script site/assets/js/track.js.

Runs a throwaway static server (Python http.server, port 5301 by default)
that serves site/, records every POST /api/track body (replying 204) and
exposes them at GET /__events. Until the public pages carry the track.js tag
themselves, the server injects it exactly where it belongs: right before the
site.js tag. Chrome is then driven with Playwright through the public pages.

Checks: one page_view per page load with path, page_type, product /
collection / category; view_item_list, view_item, filter_collection,
whatsapp_click, generate_lead, intro_complete and story_open mirrored from
the dataLayer; session id and is_new; per-session attribution (utm, gclid
flag, referrer host) that survives internal navigation and falls back to
siroya_attr; sendBeacon text/plain bodies under 4 KB with a fetch fallback;
nothing sent with Do Not Track, Global Privacy Control, the siroya_notrack
opt-out or on file: pages; no console errors or page errors.

Usage:  python server/test/track_browser_test.py
Env:    TRACK_TEST_PORT (default 5301), CHROME_PATH, HEADED=1
"""
import json
import os
import re
import socket
import sys
import threading
import time
from functools import partial
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import urlsplit
from urllib.request import urlopen

from playwright.sync_api import sync_playwright

ROOT = Path(__file__).resolve().parents[2]
SITE = ROOT / "site"
PORT = int(os.environ.get("TRACK_TEST_PORT", "5301"))
BASE = f"http://127.0.0.1:{PORT}"
CHROME = os.environ.get("CHROME_PATH", r"C:/Program Files/Google/Chrome/Application/chrome.exe")
SITE_TAG = '<script src="assets/js/site.js"></script>'
TRACK_TAG = '<script src="assets/js/track.js"></script>'
SID_RE = re.compile(r"^[a-f0-9]{16}$")

EVENTS = []
LOCK = threading.Lock()


class Handler(SimpleHTTPRequestHandler):
    def log_message(self, *args):
        pass

    def _send(self, code, body=b"", ctype="application/json"):
        self.send_response(code)
        if body:
            self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        if body:
            self.wfile.write(body)

    def do_GET(self):
        path = urlsplit(self.path).path
        if path == "/__events":
            with LOCK:
                return self._send(200, json.dumps(EVENTS).encode())
        if path == "/api/catalog":
            # Not a catalog: site.js falls back to data.js, as on static hosting, without a 404 in the console
            return self._send(200, b"{}")
        if path == "/api/homepage":
            # No saved banner: hero.js keeps the static hero, without a 404 in the console
            return self._send(200, b"{}")
        if path.endswith(".html") or path.endswith("/"):
            fs = Path(self.translate_path(path))
            if fs.is_dir():
                fs = fs / "index.html"
            if fs.is_file():
                html = fs.read_text(encoding="utf-8")
                if "assets/js/track.js" not in html and SITE_TAG in html:
                    html = html.replace(SITE_TAG, TRACK_TAG + "\n" + SITE_TAG, 1)
                return self._send(200, html.encode("utf-8"), "text/html; charset=utf-8")
        return super().do_GET()

    def do_POST(self):
        raw = self.rfile.read(int(self.headers.get("Content-Length") or 0))
        if urlsplit(self.path).path == "/api/track":
            try:
                body = json.loads(raw.decode("utf-8"))
            except Exception:
                body = {"_unparsed": raw.decode("utf-8", "replace")}
            with LOCK:
                EVENTS.append({"ct": self.headers.get("Content-Type", ""), "size": len(raw), "body": body})
        self._send(204)


def events():
    with urlopen(BASE + "/__events", timeout=5) as r:
        return [e["body"] | {"_ct": e["ct"], "_size": e["size"]} for e in json.load(r)]


def wait_for(mark, types, timeout=8.0):
    """Wait until every event type in `types` (a list, repeats allowed) arrived after `mark`."""
    end = time.time() + timeout
    while True:
        new = events()[mark:]
        got = [e.get("t") for e in new]
        if all(got.count(t) >= types.count(t) for t in set(types)) or time.time() > end:
            return new
        time.sleep(0.1)


FAILS = []


def check(cond, label, detail=None):
    print(("PASS  " if cond else "FAIL  ") + label + ("" if cond or detail is None else f"\n      got: {detail}"))
    if not cond:
        FAILS.append(label)


def one(new, t, **want):
    """The single event of type t in `new`, checked against the expected fields (None = must be absent)."""
    hits = [e for e in new if e.get("t") == t]
    check(len(hits) == 1, f"exactly one {t}", [h.get("t") for h in new])
    if not hits:
        return {}
    e = hits[0]
    for k, v in want.items():
        check(e.get(k) == v, f"  {t}.{k} == {v!r}", e.get(k))
    return e


def port_free(port):
    with socket.socket() as s:
        try:
            s.bind(("127.0.0.1", port))
            return True
        except OSError:
            return False


INIT_STUBS = """
  window.__opened = [];
  window.open = function (u) { window.__opened.push(String(u)); return null; };
  // WhatsApp links must not leave the page; site.js still sees the click (bubble phase)
  addEventListener("click", function (e) {
    var a = e.target.closest && e.target.closest('a[href*="wa.me"]');
    if (a) e.preventDefault();
  }, true);
"""


def stub_external(route):
    url = route.request.url
    ctype = "text/css" if ".css" in url or "fonts.googleapis" in url else "application/javascript" if ".js" in url else "text/plain"
    route.fulfill(status=200, body="", content_type=ctype)


def new_context(browser, init=None):
    ctx = browser.new_context(viewport={"width": 1280, "height": 900}, reduced_motion="reduce")
    # Third-party CDNs (fonts, icons, Lenis, GSAP) and wa.me are stubbed: the test stays offline and deterministic
    ctx.route(lambda u: u.startswith("http") and not u.startswith(BASE), stub_external)
    ctx.add_init_script(INIT_STUBS)
    if init:
        ctx.add_init_script(init)
    return ctx


def watch(page, errors):
    page.on("console", lambda m: m.type == "error" and errors.append(f"console: {m.text} @ {page.url}"))
    page.on("pageerror", lambda e: errors.append(f"pageerror: {e} @ {page.url}"))


def main():
    if not port_free(PORT):
        print(f"Port {PORT} is busy; set TRACK_TEST_PORT")
        return 2
    server = ThreadingHTTPServer(("127.0.0.1", PORT), partial(Handler, directory=str(SITE)))
    threading.Thread(target=server.serve_forever, daemon=True).start()
    errors = []
    try:
        with sync_playwright() as pw:
            browser = pw.chromium.launch(executable_path=CHROME, headless=not os.environ.get("HEADED"))
            ctx = new_context(browser)
            page = ctx.new_page()
            watch(page, errors)

            # 1. Home, landing from a Google ad link with utm + gclid
            print("\n== Home: landing with utm + gclid, referrer google ==")
            mark = len(events())
            page.goto(BASE + "/index.html?utm_source=Newsletter&utm_medium=email&utm_campaign=Diwali%20Launch&gclid=TESTGCLID&x=1",
                      referer="https://www.google.com/")
            new = wait_for(mark, ["page_view"])
            pv = one(new, "page_view", p="/", pt="home", i=None, c=None, k=None, n=1, src="Newsletter", med="email",
                     cmp="Diwali Launch", g=True, ref="www.google.com")
            sid = pv.get("sid", "")
            check(bool(SID_RE.match(sid)), "sid is 16 hex chars", sid)
            check(pv.get("_ct", "").startswith("text/plain"), "beacon Content-Type is text/plain", pv.get("_ct"))
            check(0 < pv.get("_size", 0) < 4096, "body under 4 KB", pv.get("_size"))
            check(page.evaluate("sessionStorage.getItem('siroya_sid')") == sid, "sid kept in sessionStorage siroya_sid")
            check(page.evaluate("localStorage.getItem('siroya_seen')") == "1", "localStorage siroya_seen flag set")

            mark = len(events())
            page.click(".intro-skip")
            one(wait_for(mark, ["intro_complete"]), "intro_complete", pt="home", sid=sid)

            mark = len(events())
            page.click('[data-wa="header"]')
            one(wait_for(mark, ["whatsapp_click"]), "whatsapp_click", pt="home", sid=sid, src="Newsletter")

            # 2. Collection, reached by clicking a card (internal referrer keeps the session's source)
            print("\n== Collection: internal navigation, filter chip, WhatsApp ==")
            mark = len(events())
            page.click('#home-collections a[href="collection.html?c=sanskriti"]')
            page.wait_for_url("**/collection.html?c=sanskriti")
            new = wait_for(mark, ["page_view", "view_item_list"])
            one(new, "page_view", p="/collection.html?c=sanskriti", pt="collection", c="sanskriti", k=None, i=None,
                sid=sid, n=1, src="Newsletter", cmp="Diwali Launch", g=True, ref="www.google.com")
            one(new, "view_item_list", pt="collection", c="sanskriti", sid=sid)

            chip = page.locator('.filterbar .chip:not([data-k="all"])').first
            chip_k = chip.get_attribute("data-k")
            mark = len(events())
            chip.click()
            one(wait_for(mark, ["filter_collection"]), "filter_collection", c="sanskriti", k=chip_k)
            mark = len(events())
            page.click('.filterbar .chip[data-k="all"]')
            one(wait_for(mark, ["filter_collection"]), "filter_collection", c="sanskriti", k=None)

            mark = len(events())
            page.click('[data-wa="collection-hero"]')
            one(wait_for(mark, ["whatsapp_click"]), "whatsapp_click", pt="collection", c="sanskriti", sid=sid)

            # 3. Product: view_item and the enquiry form (window.open stubbed)
            print("\n== Product: view_item, enquiry form ==")
            mark = len(events())
            page.goto(BASE + "/product.html?p=sanskriti-1")
            new = wait_for(mark, ["page_view", "view_item"])
            one(new, "page_view", p="/product.html?p=sanskriti-1", pt="product", i="sanskriti-1", sid=sid, n=1, src="Newsletter")
            one(new, "view_item", pt="product", i="sanskriti-1", sid=sid)

            page.fill("#f-name", "Test Visitor")
            page.fill("#f-phone", "501234567")
            mark = len(events())
            page.click("#lead button[type=submit]")
            one(wait_for(mark, ["generate_lead"]), "generate_lead", pt="product", i="sanskriti-1", sid=sid, src="Newsletter", g=True)
            opened = page.evaluate("window.__opened")
            check(len(opened) == 1 and "wa.me" in opened[0], "enquiry opened WhatsApp through the stubbed window.open", opened)

            # 4. Category and 5. About (story dialog) and 6. Collections showcase
            print("\n== Category, About, Collections ==")
            mark = len(events())
            page.goto(BASE + "/category.html?c=necklaces")
            new = wait_for(mark, ["page_view", "view_item_list"])
            one(new, "page_view", p="/category.html?c=necklaces", pt="category", k="necklaces", c=None)
            one(new, "view_item_list", pt="category", k="necklaces", c=None)

            mark = len(events())
            page.goto(BASE + "/about.html")
            one(wait_for(mark, ["page_view"]), "page_view", p="/about.html", pt="about")
            if page.locator(".tl-more").count():
                mark = len(events())
                page.locator(".tl-more").first.click()
                one(wait_for(mark, ["story_open"]), "story_open", pt="about")

            mark = len(events())
            page.goto(BASE + "/collections.html")
            one(wait_for(mark, ["page_view"]), "page_view", p="/collections.html", pt="showcase")

            no_ids = all("TESTGCLID" not in json.dumps(e) for e in events())
            check(no_ids, "gclid value never sent (only the g flag)")

            # 7. Same browser, new tab = new session: returning visitor, source from siroya_attr
            print("\n== New tab: returning visitor, last campaign from siroya_attr ==")
            page2 = ctx.new_page()
            watch(page2, errors)
            mark = len(events())
            page2.goto(BASE + "/")
            pv2 = one(wait_for(mark, ["page_view"]), "page_view", p="/", pt="home", n=0, src="Newsletter",
                      cmp="Diwali Launch", g=True, ref=None)
            check(pv2.get("sid") != sid and bool(SID_RE.match(pv2.get("sid", ""))), "new tab gets a new sid", pv2.get("sid"))
            page2.close()

            page3 = ctx.new_page()
            watch(page3, errors)
            mark = len(events())
            page3.goto(BASE + "/index.html", referer="https://www.bing.com/search?q=siroya")
            one(wait_for(mark, ["page_view"]), "page_view", n=0, ref="www.bing.com", src=None, g=None)
            page3.close()
            ctx.close()

            # 8. sendBeacon missing: fetch keepalive fallback
            print("\n== No sendBeacon: fetch fallback ==")
            ctx = new_context(browser, "delete Navigator.prototype.sendBeacon;")
            page = ctx.new_page()
            watch(page, errors)
            mark = len(events())
            page.goto(BASE + "/collection.html?c=rangmahal")
            new = wait_for(mark, ["page_view", "view_item_list"])
            pv = one(new, "page_view", c="rangmahal", pt="collection", n=1)
            check(pv.get("_ct", "").startswith("text/plain"), "fetch fallback Content-Type is text/plain", pv.get("_ct"))
            one(new, "view_item_list", c="rangmahal")
            ctx.close()

            # 9. Privacy signals and opt-out: nothing is sent, the site still works
            for label, init in [
                ("Do Not Track", "Object.defineProperty(Navigator.prototype, 'doNotTrack', { get: function () { return '1'; }, configurable: true });"),
                ("Global Privacy Control", "Object.defineProperty(Navigator.prototype, 'globalPrivacyControl', { get: function () { return true; }, configurable: true });"),
                ("siroya_notrack opt-out", "try { localStorage.setItem('siroya_notrack', '1'); } catch (e) {}"),
            ]:
                print(f"\n== {label}: nothing sent ==")
                ctx = new_context(browser, init)
                page = ctx.new_page()
                watch(page, errors)
                mark = len(events())
                page.goto(BASE + "/index.html?utm_source=x&gclid=y")
                page.click(".intro-skip")
                page.goto(BASE + "/collection.html?c=sanskriti")
                page.wait_for_selector("#grid .p-card")
                page.click('[data-wa="collection-hero"]')
                page.goto(BASE + "/product.html?p=sanskriti-1")
                page.wait_for_selector("#lead form")
                page.fill("#f-name", "Test Visitor")
                page.fill("#f-phone", "501234567")
                page.click("#lead button[type=submit]")
                pushed = page.evaluate("(window.dataLayer || []).map(function (e) { return e.event; })")
                wrapped = page.evaluate("window.dataLayer.push !== Array.prototype.push")
                time.sleep(1.5)
                sent = events()[mark:]
                check(not sent, f"{label}: no /api/track requests", [e.get("t") for e in sent])
                check("view_item" in pushed and "generate_lead" in pushed, f"{label}: site.js still pushes dataLayer events", pushed)
                check(not wrapped, f"{label}: dataLayer.push left untouched")
                ctx.close()

            # 10. file: pages never send
            print("\n== file: page ==")
            ctx = new_context(browser)
            page = ctx.new_page()
            page.goto((SITE / "collection.html").as_uri() + "?c=sanskriti")
            # track.js is not in the file yet (injection happens in the test server), so add it the same way
            if not page.evaluate("!!document.querySelector('script[src*=\"track.js\"]')"):
                page.add_script_tag(url=(SITE / "assets/js/track.js").as_uri())
            time.sleep(0.5)
            check(not page.evaluate("!!window.siroyaTrack"), "file: page: tracker stays off")
            ctx.close()

            browser.close()
    finally:
        server.shutdown()
        server.server_close()

    print("\n== Console ==")
    check(not errors, "no console errors or page errors", "\n      ".join(errors))
    total = len(EVENTS)
    print(f"\n{total} events recorded; {len(FAILS)} failed check(s)")
    return 1 if FAILS else 0


if __name__ == "__main__":
    sys.exit(main())
