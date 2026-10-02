/* Homepage hero: single image, slideshow or muted video, chosen in the admin
   (Homepage) and served by GET /api/homepage. Renders into the existing
   <section class="hero"> of index.html and keeps the class names that
   siroya.css, intro.css and motion.css already style (.hero, .hero-media,
   .hero-copy, .rv), so the intro hand-off, the word rise and the scroll
   parallax work for every slide, image or video. Also points the featured
   collection section further down at the collection chosen in the admin.

   No API (static hosting, file:, error, 2.5 s timeout): the hero written in
   index.html stays exactly as it is.

   Contract: docs/HOMEPAGE-BANNER-SPEC.md. Styles: assets/css/hero.css.
   Load it right after intro.js so the request starts early:
     <script src="assets/js/hero.js"></script>
   Add data-manual to that tag to skip the automatic fetch (for example in an
   admin preview) and call window.SiroyaHero.render(section, hero) yourself.
   Events on window: "siroya:hero-ready" (detail.mode = image | slideshow |
   video | static) once the hero on screen is final. */
(function () {
  "use strict";

  var API = "/api/homepage";
  var TIMEOUT = 2500;     // give up on the API after 2.5 s
  var HOLD = 900;         // keep the static hero hidden this long while the API answers
  var FADE = 1200;        // slide cross-fade, in step with hero.css
  var PHONE = "(max-width: 760px)";
  var MAX_SLIDES = 6;

  var root = document.documentElement;
  var script = document.currentScript;
  var reduce = matchMedia("(prefers-reduced-motion: reduce)").matches;

  function introPending() { return root.classList.contains("intro-active") || root.classList.contains("intro-pending"); }
  function each(list, fn) { Array.prototype.forEach.call(list, fn); }
  function raf2(fn) { requestAnimationFrame(function () { requestAnimationFrame(fn); }); }
  function emit(mode) { try { dispatchEvent(new CustomEvent("siroya:hero-ready", { detail: { mode: mode } })); } catch (e) {} }

  /* ---------------- Data: the server validates, the page stays defensive ---------------- */
  var MEDIA_RE = /^(?:assets|uploads)\/[A-Za-z0-9._~\-\/]+$/;
  var REL_LINK_RE = /^[a-z0-9][a-z0-9\-_\/.?=&#%]*$/i;
  var HTTPS_RE = /^https:\/\/[a-z0-9][a-z0-9.\-]*(?::\d{1,5})?(?:[\/?#][^\s"'<>\\`]*)?$/i;

  function str(v, max) {
    if (typeof v !== "string" && typeof v !== "number") return "";
    return String(v).replace(/\s+/g, " ").trim().slice(0, max);
  }
  function mediaPath(v, video) {
    var s = str(v, 300).replace(/^\/+/, "");
    if (!s || s.indexOf("..") > -1 || !MEDIA_RE.test(s)) return "";
    if (video && !/\.(?:mp4|webm)$/i.test(s)) return "";
    return s;
  }
  function linkHref(v) {
    var s = str(v, 500);
    if (!s) return "";
    if (/^https:\/\//i.test(s)) return HTTPS_RE.test(s) ? s : "";
    if (s.charAt(0) === "/" && s.charAt(1) !== "/") s = s.slice(1);
    return s.indexOf("..") > -1 || !REL_LINK_RE.test(s) ? "" : s;
  }
  function num(v, def, min, max) {
    var n = typeof v === "number" ? v : parseFloat(v);
    if (!isFinite(n)) n = def;
    return Math.min(max, Math.max(min, n));
  }
  function slideOf(s) {
    s = s && typeof s === "object" ? s : {};
    var focus = s.focus === "center" || s.focus === "centre" ? "center" : s.focus === "left" ? "left" : "right";
    return {
      image: mediaPath(s.image), image_mobile: mediaPath(s.image_mobile), focus: focus,
      eyebrow: str(s.eyebrow, 50), headline: str(s.headline, 70), text: str(s.text, 160),
      cta_label: str(s.cta_label, 40), cta_link: linkHref(s.cta_link),
      cta2_label: str(s.cta2_label, 40), cta2_link: linkHref(s.cta2_link),
      alt: str(s.alt, 140)
    };
  }

  /* API answer (or the hero object itself) -> what can actually be shown, or null */
  function cleanHero(d) {
    var h = d && (d.hero || (d.homepage && d.homepage.hero) || (Array.isArray(d.slides) ? d : null));
    if (!h || typeof h !== "object") return null;
    var mode = h.mode === "slideshow" || h.mode === "video" ? h.mode : "image";
    var slides = (Array.isArray(h.slides) ? h.slides : []).slice(0, MAX_SLIDES).map(slideOf);
    var v = h.video && typeof h.video === "object" ? h.video : {};
    var video = { src: mediaPath(v.src, true), src_mobile: mediaPath(v.src_mobile, true), poster: mediaPath(v.poster), poster_mobile: mediaPath(v.poster_mobile) };
    var pictured = slides.filter(function (s) { return s.image; });
    if (mode === "video" && !video.src) mode = "image";
    if (mode === "slideshow") {
      slides = pictured;
      if (slides.length < 2) mode = "image";
    }
    if (mode === "image") {
      var first = slides[0] && slides[0].image ? slides[0] : pictured[0];
      if (!first) return null;
      slides = [first];
    }
    if (mode === "video") slides = [slides[0] || slideOf({})];
    return {
      mode: mode, slides: slides, video: video,
      interval: num(h.interval, 6, 4, 12), overlay: num(h.overlay, 0.45, 0, 0.8),
      align: h.align === "center" || h.align === "centre" ? "center" : "left"
    };
  }

  /* ---------------- DOM helpers (text only, never innerHTML of data) ---------------- */
  function h(tag, attrs, kids) {
    var n = document.createElement(tag);
    if (attrs) for (var k in attrs) {
      var v = attrs[k];
      if (v === null || v === undefined || v === false) continue;
      n.setAttribute(k, v === true ? "" : String(v));
    }
    (kids || []).forEach(function (c) {
      if (c === null || c === undefined || c === false) return;
      n.appendChild(typeof c === "string" ? document.createTextNode(c) : c);
    });
    return n;
  }
  function icon(name) { return h("i", { "class": "ph " + name, "aria-hidden": "true" }); }
  function cta(label, href, cls) {
    var a = h("a", { "class": cls, href: href }, [label]);
    if (/^https:/i.test(href)) {
      try { if (new URL(href).host !== location.host) { a.target = "_blank"; a.rel = "noopener"; } } catch (e) {}
    }
    return a;
  }

  function copyBlock(s, first) {
    var kids = [];
    if (s.eyebrow) kids.push(h("span", { "class": "eyebrow hero-eyebrow rv" }, [s.eyebrow]));
    if (s.headline) kids.push(h(first ? "h1" : "h2", { "class": "hero-title rv" + (first ? "" : " h1"), style: "--i:1" }, [s.headline]));
    else if (first) kids.push(h("h1", { "class": "sr-only" }, ["Siroya Jewellers"]));
    if (s.text) kids.push(h("p", { "class": "lede rv", style: "--i:2" }, [s.text]));
    var ctas = [];
    if (s.cta_label && s.cta_link) ctas.push(cta(s.cta_label, s.cta_link, "btn btn-cream"));
    if (s.cta2_label && s.cta2_link) ctas.push(cta(s.cta2_label, s.cta2_link, "btn btn-line"));
    if (ctas.length) kids.push(h("div", { "class": "hero-ctas rv", style: "--i:3" }, ctas));
    return h("div", { "class": "wrap hero-slide-copy" }, [h("div", { "class": "hero-copy" }, kids)]);
  }

  /* Image slide: <picture> with the phone crop when there is one. Images other
     than the first and the next carry data-src until they are about to show. */
  function imageMedia(s, load, priority) {
    var pic = h("picture", { "class": "hero-zoom" });
    if (s.image_mobile) pic.appendChild(h("source", { media: PHONE, "data-srcset": s.image_mobile }));
    var img = h("img", { alt: s.alt || "", decoding: "async", "data-src": s.image, fetchpriority: priority ? "high" : null });
    img.addEventListener("error", function () { img.style.visibility = "hidden"; });
    pic.appendChild(img);
    var m = h("div", { "class": "hero-media" + (s.image_mobile ? " has-mobile" : ""), "data-focus": s.focus }, [pic]);
    if (load) loadMedia(m);
    return m;
  }
  function loadMedia(m) {
    var src = m.querySelector("source[data-srcset]");
    if (src) { src.setAttribute("srcset", src.getAttribute("data-srcset")); src.removeAttribute("data-srcset"); }
    var img = m.querySelector("img[data-src]");
    if (img) { img.setAttribute("src", img.getAttribute("data-src")); img.removeAttribute("data-src"); }
  }
  // Resolves once the slide's image is decoded, or after max ms whatever happens
  function ready(m, max) {
    var img = m.querySelector("img");
    if (!img || !img.getAttribute("src")) return Promise.resolve();
    return new Promise(function (done) {
      var t = setTimeout(done, max);
      var ok = function () { clearTimeout(t); done(); };
      if (img.decode) img.decode().then(ok, ok);
      else if (img.complete) ok();
      else { img.addEventListener("load", ok); img.addEventListener("error", ok); }
    });
  }

  function lowData() {
    var c = navigator.connection || navigator.mozConnection || navigator.webkitConnection;
    return !!(c && (c.saveData || /(?:^|-)(?:2g|3g)$/.test(c.effectiveType || "")));
  }

  /* ---------------- Render ---------------- */
  function render(section, data, opts) {
    opts = opts || {};
    var hero = data && data.slides ? data : cleanHero(data);
    if (!section || !hero) return null;
    if (section._siroyaHero) section._siroyaHero.destroy();

    var mode = hero.mode, N = hero.slides.length;
    var phoneMQ = matchMedia(PHONE);
    var wait = !opts.preview && introPending();
    var offs = [], timers = [];
    function on(t, type, fn, o) {
      if (t.addEventListener) { t.addEventListener(type, fn, o); offs.push(function () { t.removeEventListener(type, fn, o); }); }
      else if (t.addListener) { t.addListener(fn); offs.push(function () { t.removeListener(fn); }); }   // older Safari MediaQueryList
    }
    function later(fn, ms) { var id = setTimeout(fn, ms); timers.push(id); return id; }

    // Whatever is on screen now (the static hero) stays underneath until the new one has faded in
    var old = Array.prototype.slice.call(section.children);
    var crossfade = !opts.instant && !wait && !root.classList.contains("hero-pending") && old.length > 0;
    old.forEach(function (n) { if (crossfade) n.classList.add("hero-old"); else n.remove(); });
    if (crossfade) later(function () { old.forEach(function (n) { n.remove(); }); }, FADE + 300);

    section.setAttribute("data-hero-mode", mode);
    section.setAttribute("data-align", hero.align);
    section.style.setProperty("--hero-ov", String(hero.overlay));
    section.style.setProperty("--hero-interval", hero.interval + "s");
    section.classList.remove("is-cycled", "is-still", "is-held", "has-bar");
    if (mode === "slideshow") {
      section.setAttribute("aria-roledescription", "carousel");
      section.setAttribute("aria-label", "Highlights");
    } else {
      section.removeAttribute("aria-roledescription");
      section.removeAttribute("aria-label");
    }

    // Slides
    var box = h("div", { "class": "hero-slides" });
    var video = null;
    var items = hero.slides.map(function (s, i) {
      var media;
      if (mode === "video") {
        var vm = videoMedia(hero.video, s, phoneMQ.matches, wait);
        media = vm.media; video = vm.video;
      } else {
        media = imageMedia(s, i <= 1, i === 0);
      }
      var el = h("div", { "class": "hero-slide" }, [media, copyBlock(s, i === 0)]);
      if (mode === "slideshow") {
        el.setAttribute("role", "group");
        el.setAttribute("aria-roledescription", "slide");
        el.setAttribute("aria-label", (i + 1) + " of " + N);
      }
      box.appendChild(el);
      return { el: el, media: media };
    });

    // Controls: rotation control first in the tab order, then slide pickers, then previous / next
    var bar = null, toggle = null, dots = [], counter = null;
    if (mode === "slideshow" || video) {
      toggle = h("button", { type: "button", "class": "hero-btn hero-toggle" }, [icon("ph-pause")]);
      var inner = [toggle];
      if (mode === "slideshow") {
        var picker = h("div", { "class": "hero-dots", role: "group", "aria-label": "Choose a slide" });
        hero.slides.forEach(function (s, i) {
          var d = h("button", { type: "button", "class": "hero-dot", "aria-label": "Show slide " + (i + 1) + " of " + N }, [h("i", { "aria-hidden": "true" })]);
          d.addEventListener("click", function () { go(i, "user"); });
          dots.push(d); picker.appendChild(d);
        });
        counter = h("span", { "class": "hero-count", "aria-hidden": "true" });
        var prev = h("button", { type: "button", "class": "hero-btn hero-prev", "aria-label": "Previous slide" }, [icon("ph-arrow-left")]);
        var next = h("button", { type: "button", "class": "hero-btn hero-next", "aria-label": "Next slide" }, [icon("ph-arrow-right")]);
        prev.addEventListener("click", function () { go(cur - 1, "user"); });
        next.addEventListener("click", function () { go(cur + 1, "user"); });
        inner.push(picker, h("span", { "class": "hero-bar-gap" }), counter, prev, next);
      }
      bar = h("div", { "class": "hero-bar" }, [h("div", { "class": "wrap hero-bar-in" }, inner)]);
      section.classList.add("has-bar");
    }
    if (bar) section.appendChild(bar);
    section.appendChild(box);
    root.classList.remove("hero-pending");

    // Copy rises in through the shared .rv reveal (intro.css times it after the intro)
    raf2(function () { each(box.querySelectorAll(".rv"), function (n) { n.classList.add("in"); }); });

    /* ----- Holds: things that pause motion without changing the visitor's choice ----- */
    var holds = { intro: wait, hidden: document.hidden, away: false, hover: false, focus: false };
    function held() { return holds.intro || holds.hidden || holds.away || holds.hover || holds.focus; }
    var sync = function () {};

    if (wait) {
      var introDone = function () {
        if (!holds.intro) return;
        holds.intro = false; sync();
      };
      on(window, "siroya:intro-done", introDone);
      // Safety net if the event is ever missed: the intro classes going away is enough
      var mo = new MutationObserver(function () { if (!introPending()) introDone(); });
      mo.observe(root, { attributes: true, attributeFilter: ["class"] });
      offs.push(function () { mo.disconnect(); });
    }
    on(document, "visibilitychange", function () { holds.hidden = document.hidden; sync(); });
    if ("IntersectionObserver" in window) {
      var io = new IntersectionObserver(function (es) { holds.away = !es[es.length - 1].isIntersecting; sync(); });
      io.observe(section);
      offs.push(function () { io.disconnect(); });
    }

    /* ----- Slideshow ----- */
    var cur = -1, token = 0, leaveT = 0;
    var interval = hero.interval * 1000;
    var playing = mode === "slideshow" && !reduce && !opts.still;   // the visitor's choice (Pause / Play)
    var timer = 0, left = interval, t0 = 0;

    function setInert(el, off) {
      if (off) { el.setAttribute("inert", ""); el.setAttribute("aria-hidden", "true"); }
      else { el.removeAttribute("inert"); el.removeAttribute("aria-hidden"); }
      each(el.querySelectorAll("a, button"), function (a) { if (off) a.setAttribute("tabindex", "-1"); else a.removeAttribute("tabindex"); });
    }
    function tick() { timer = 0; go(cur + 1, "auto"); }
    function run() { if (timer || cur < 0) return; t0 = Date.now(); timer = setTimeout(tick, Math.max(60, left)); }
    function halt() { if (!timer) return; clearTimeout(timer); timer = 0; left = Math.max(0, left - (Date.now() - t0)); }

    function show(n) {
      var prev = cur;
      var focusWasIn = prev > -1 && items[prev].el.contains(document.activeElement);
      cur = n;
      items.forEach(function (it, i) {
        it.el.classList.toggle("is-active", i === n);
        it.el.classList.toggle("is-leaving", i === prev && i !== n);
        if (mode === "slideshow") setInert(it.el, i !== n);
      });
      if (prev > -1) {
        section.classList.add("is-cycled");
        clearTimeout(leaveT);
        leaveT = later(function () { items.forEach(function (it) { it.el.classList.remove("is-leaving"); }); }, FADE + 150);
      }
      dots.forEach(function (d, i) { d.classList.toggle("is-active", i === n); if (i === n) d.setAttribute("aria-current", "true"); else d.removeAttribute("aria-current"); });
      if (counter) counter.innerHTML = "<b>" + String(n + 1).padStart(2, "0") + "</b> / " + String(N).padStart(2, "0");
      if (N > 1) loadMedia(items[(n + 1) % N].media);   // only the next image is fetched ahead
      if (focusWasIn) {
        var target = items[n].el.querySelector("a[href]") || toggle;
        if (target) target.focus({ preventScroll: true });
      }
      halt(); left = interval;
      sync();
    }
    function go(n, how) {
      if (N < 2) return;
      n = ((n % N) + N) % N;
      if (n === cur) return;
      var my = ++token;
      loadMedia(items[n].media);
      halt();
      ready(items[n].media, how === "auto" ? 2500 : 700).then(function () { if (my === token) show(n); });
    }

    if (mode === "slideshow") {
      sync = function () {
        var going = playing && !held();
        section.classList.toggle("is-still", !playing);
        section.classList.toggle("is-held", playing && held());
        if (going) run(); else halt();
        // Announce slide changes only when they are not happening by themselves
        box.setAttribute("aria-live", going ? "off" : "polite");
        paintToggle(playing, "slideshow");
      };
      toggle.addEventListener("click", function () { playing = !playing; halt(); left = interval; sync(); });

      // Pause while the pointer rests on the words or the controls (the hero fills the
      // screen, so pausing for any hover would stop it for good on desktop)
      on(section, "pointerover", function (e) {
        if (e.pointerType !== "mouse") return;
        var v = !!(e.target.closest && e.target.closest(".hero-copy, .hero-btn, .hero-dots, .hero-count"));
        if (v !== holds.hover) { holds.hover = v; sync(); }
      });
      on(section, "pointerleave", function () { if (holds.hover) { holds.hover = false; sync(); } });
      // Pause while keyboard focus is inside
      on(section, "focusin", function (e) {
        var kb = true;
        try { kb = e.target.matches(":focus-visible"); } catch (err) {}
        if (kb !== holds.focus) { holds.focus = kb; sync(); }
      });
      on(section, "focusout", function (e) {
        if (!e.relatedTarget || !section.contains(e.relatedTarget)) { holds.focus = false; sync(); }
      });
      // Previous / next from the keyboard
      on(section, "keydown", function (e) {
        if (e.altKey || e.ctrlKey || e.metaKey) return;
        if (e.key === "ArrowRight" || e.key === "ArrowLeft") { e.preventDefault(); go(cur + (e.key === "ArrowRight" ? 1 : -1), "user"); }
      });
      // Swipe on touch screens (vertical scrolling stays with the browser)
      var sx = null, sy = 0, sid = null;
      on(box, "pointerdown", function (e) { if (e.pointerType === "mouse") return; sx = e.clientX; sy = e.clientY; sid = e.pointerId; });
      on(box, "pointerup", function (e) {
        if (sx === null || e.pointerId !== sid) return;
        var dx = e.clientX - sx, dy = e.clientY - sy;
        sx = null;
        if (Math.abs(dx) > 40 && Math.abs(dx) > Math.abs(dy) * 1.3) go(cur + (dx < 0 ? 1 : -1), "user");
      });
      on(box, "pointercancel", function () { sx = null; });
    }

    /* ----- Video ----- */
    var vctl = null;
    if (video) vctl = videoControl(video, items[0].media, hero, toggle, holds, held, phoneMQ, on, section);
    if (vctl) sync = vctl.sync;
    if (mode === "video" && !video) { section.classList.remove("has-bar"); }

    // First slide: next frame, so its fade (and the slow zoom) actually run
    if (wait || opts.instant) show(0); else raf2(function () { show(0); });

    var api = {
      mode: mode,
      go: function (n) { go(n, "user"); },
      get index() { return cur; },
      destroy: function () {
        offs.forEach(function (f) { f(); }); timers.forEach(clearTimeout);
        clearTimeout(timer); clearTimeout(leaveT);
        if (vctl) vctl.destroy();
        section._siroyaHero = null;
      }
    };
    section._siroyaHero = api;
    emit(mode);
    return api;

    function paintToggle(going, what) {
      if (!toggle) return;
      toggle.setAttribute("aria-label", (going ? "Pause " : "Play ") + what);
      toggle.setAttribute("title", going ? "Pause" : "Play");
      var i = toggle.querySelector("i");
      if (i) i.className = "ph " + (going ? "ph-pause" : "ph-play");
    }
  }

  /* Video slide: <video muted loop playsinline autoplay preload="metadata" poster>.
     Reduced motion, Save-Data or a 2G/3G connection get the cover image only. */
  function videoMedia(v, s, phone, wait) {
    var src = phone && v.src_mobile ? v.src_mobile : v.src;
    var poster = phone && v.poster_mobile ? v.poster_mobile : v.poster || v.poster_mobile;
    if (reduce || lowData()) {
      var still = v.poster || v.poster_mobile || s.image;
      if (still) {
        var phoneStill = v.poster && v.poster_mobile ? v.poster_mobile : still === s.image ? s.image_mobile : "";
        return { media: imageMedia({ image: still, image_mobile: phoneStill, focus: s.focus, alt: s.alt }, true, true), video: null };
      }
    }
    var vid = h("video", {
      "class": "hero-video", muted: true, loop: true, playsinline: true, "webkit-playsinline": true,
      preload: "metadata", poster: poster || null, autoplay: !wait && !reduce && !lowData(),
      disablepictureinpicture: true, disableremoteplayback: true,
      "aria-label": s.alt || null, "aria-hidden": s.alt ? null : "true"
    });
    vid.muted = true; vid.defaultMuted = true;
    vid.setAttribute("src", src);
    var m = h("div", { "class": "hero-media", "data-focus": s.focus }, [vid]);
    return { media: m, video: vid };
  }

  function videoControl(vid, media, hero, toggle, holds, held, phoneMQ, on, section) {
    var want = !reduce && !lowData();     // the visitor's choice (Pause / Play)
    var dead = false;
    function paint() {
      if (!toggle) return;
      toggle.setAttribute("aria-label", want ? "Pause video" : "Play video");
      toggle.setAttribute("title", want ? "Pause" : "Play");
      var i = toggle.querySelector("i");
      if (i) i.className = "ph " + (want ? "ph-pause" : "ph-play");
      section.classList.toggle("is-still", !want);
    }
    function sync() {
      if (dead) return;
      if (want && !held()) {
        var p = vid.play();
        if (p && p.catch) p.catch(function (err) {
          // Autoplay refused (for example iOS Low Power Mode): the cover stays, Play is offered
          if (err && err.name === "NotAllowedError") { want = false; paint(); }
        });
      } else if (!vid.paused) vid.pause();
      paint();
    }
    if (toggle) toggle.addEventListener("click", function () { want = !want; sync(); });
    // The file cannot play here: fall back to the cover image
    vid.addEventListener("error", function () {
      if (dead) return;
      dead = true;
      var v = hero.video, s = hero.slides[0];
      var still = v.poster || v.poster_mobile || s.image;
      if (still) {
        var img = imageMedia({ image: still, image_mobile: v.poster && v.poster_mobile ? v.poster_mobile : "", focus: s.focus, alt: s.alt }, true, false);
        media.replaceChild(img.firstChild, vid);
      }
      section.classList.remove("has-bar", "is-still");
      var bar = section.querySelector(".hero-bar");
      if (bar) bar.remove();
    });
    // Phone and desktop files differ: follow the breakpoint
    on(phoneMQ, "change", function () {
      var v = hero.video;
      var src = phoneMQ.matches && v.src_mobile ? v.src_mobile : v.src;
      var poster = phoneMQ.matches && v.poster_mobile ? v.poster_mobile : v.poster || v.poster_mobile;
      if (dead || vid.getAttribute("src") === src) return;
      if (poster) vid.setAttribute("poster", poster);
      vid.setAttribute("src", src);
      sync();
    });
    on(window, "pageshow", sync);
    paint();
    return { sync: sync, destroy: function () { dead = true; try { vid.pause(); } catch (e) {} } };
  }

  /* ---------------- Featured collection section ---------------- */
  // Waits for site.js to finish the home page (it writes the Sanskriti minis first)
  function whenCatalog(fn) {
    if (root.dataset.catalog) { fn(); return; }
    var done = false;
    var go = function () { if (done) return; done = true; mo.disconnect(); fn(); };
    var mo = new MutationObserver(function () { if (root.dataset.catalog) go(); });
    mo.observe(root, { attributes: true, attributeFilter: ["data-catalog"] });
    setTimeout(go, 6000);
  }
  // Same text, same element: keeps motion.js's word spans (and their reveal state) intact
  function setText(el, text) {
    if (!el || !text || el.textContent.replace(/\s+/g, " ").trim() === text) return;
    if (el.querySelector(".mw")) {
      var frag = document.createDocumentFragment(), n = 0;
      text.split(/\s+/).forEach(function (word, k) {
        if (k) frag.appendChild(document.createTextNode(" "));
        var w = h("span", { "class": "mw" }, [h("span", { "class": "mwi", style: "--w:" + n++ }, [word])]);
        frag.appendChild(w);
      });
      el.textContent = "";
      el.appendChild(frag);
      el.setAttribute("aria-label", text);
    } else el.textContent = text;
  }
  function escRe(s) { return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"); }

  function featured(f) {
    var r = f && f.resolved;
    var box = document.querySelector(".feature");
    if (!r || !r.slug || !box) return;
    var name = str(r.name, 80), kind = str(r.kind, 80);
    if (!name) return;
    var url = linkHref(r.url) || "collection.html?c=" + encodeURIComponent(r.slug);
    // "Sanskriti. Traditions carried forward." -> eyebrow Sanskriti, heading Traditions carried forward.
    var head = str(f.headline, 120).replace(new RegExp("^" + escRe(name) + "\\s*[.:,|\\-\\u2013\\u2014]\\s+", "i"), "");
    if (head.toLowerCase() === name.toLowerCase()) head = "";
    var eyebrow = head ? name : kind || "Featured collection";
    if (!head) head = name;
    var text = str(f.text, 400) || str(r.short, 400);
    var image = mediaPath(f.image) || mediaPath(r.hero) || mediaPath(r.cover);
    var label = str(f.cta_label, 40) || "Discover " + name;

    var pic = box.querySelector(":scope > a");
    var img = pic && pic.querySelector("img");
    if (pic) pic.setAttribute("href", url);
    if (img && image && img.getAttribute("src") !== image) {
      img.setAttribute("src", image);
      img.setAttribute("alt", kind ? name + ", " + kind : name);
      img.style.objectPosition = image === mediaPath(r.hero) ? "66% center" : "center";
    }
    var copy = box.querySelector(".feature-copy");
    if (!copy) return;
    setText(copy.querySelector(".eyebrow"), eyebrow);
    setText(copy.querySelector("h2"), head);
    setText(copy.querySelector(".lede"), text);
    var more = copy.querySelector(".link-arrow");
    if (more) {
      more.setAttribute("href", url);
      if (more.textContent.trim() !== label) {
        more.textContent = label + " ";
        more.appendChild(icon("ph-arrow-right"));
      }
    }

    // Mini products: site.js already shows its default collection; only redo them when it differs
    var S = window.SIROYA;
    if (!S || !Array.isArray(S.products)) return;
    var shown = (S.collections || []).filter(function (c) { return c.slug === "sanskriti"; })[0] || (S.collections || [])[0];
    if (shown && shown.slug === r.slug) return;
    var pool = S.products.filter(function (p) { return p.collection === r.slug; });
    var fp = pool.filter(function (p) { return p.featured; }).concat(pool.filter(function (p) { return !p.featured; })).slice(0, 4);
    var mini = copy.querySelector("#feature-products");
    if (!fp.length) { if (mini) mini.remove(); return; }
    if (!mini) {
      mini = h("div", { "class": "mini-products rv in", style: "--i:2", id: "feature-products" });
      var after = more ? more.closest(".feature-copy > *") : null;
      copy.insertBefore(mini, after);
    }
    mini.dataset.n = fp.length;
    mini.textContent = "";
    fp.forEach(function (p) {
      var im = (p.images || [])[0];
      var a = h("a", { href: "product.html?p=" + encodeURIComponent(p.id), "class": "zoom" }, [
        h("div", { "class": "frame" }, [im ? h("img", { src: im, alt: str(p.name, 200), loading: "lazy", decoding: "async" }) : h("div", { "class": "slot" }, [str(p.name, 200)])]),
        h("p", null, [str(p.name, 200)])
      ]);
      mini.appendChild(a);
    });
  }

  /* ---------------- Boot ---------------- */
  function load() {
    var ctl = window.AbortController ? new AbortController() : null;
    var timeout = new Promise(function (done) { setTimeout(function () { if (ctl) ctl.abort(); done(null); }, TIMEOUT); });
    var req = fetch(API, { cache: "no-store", credentials: "same-origin", headers: { Accept: "application/json" }, signal: ctl ? ctl.signal : undefined })
      .then(function (r) { return r.ok && /json/.test(r.headers.get("content-type") || "") ? r.json() : null; })
      .then(function (d) { return d && typeof d === "object" ? d : null; }, function () { return null; });
    return Promise.race([req, timeout]);
  }
  function domReady(fn) {
    if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", fn, { once: true });
    else fn();
  }

  window.SiroyaHero = { render: render, clean: cleanHero, featured: featured };

  var manual = script && script.hasAttribute("data-manual");
  if (manual || !window.fetch || !window.Promise || !/^https?:$/.test(location.protocol)) return;

  root.classList.add("hero-pending");
  var holdT = setTimeout(function () { root.classList.remove("hero-pending"); }, HOLD);
  var request = load();
  domReady(function () {
    request.then(function (d) {
      var section = document.querySelector(".hero");
      var hero = d && cleanHero(d);
      clearTimeout(holdT);
      var api = null;
      if (section && hero) {
        try { api = render(section, hero); } catch (e) { if (window.console) console.error(e); }
      }
      if (!api) { root.classList.remove("hero-pending"); emit("static"); }
      if (d && d.featured) {
        whenCatalog(function () { try { featured(d.featured); } catch (e) { if (window.console) console.error(e); } });
      }
    });
  });
})();
