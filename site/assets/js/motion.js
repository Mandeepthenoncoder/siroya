/* Siroya motion system. Tags page elements with motion classes and reveals
   them as they enter the viewport (IntersectionObserver, no scroll
   listeners). Works on content rendered later by site.js through a
   MutationObserver. Adds Lenis smooth scrolling on desktop pointers.
   Styles: assets/css/motion.css. Off entirely for reduced motion. */
(function () {
  "use strict";
  var reduce = matchMedia("(prefers-reduced-motion: reduce)").matches;
  if (reduce || !("IntersectionObserver" in window)) return;
  var root = document.documentElement;
  root.classList.add("m-on");

  // Areas with their own choreography, or UI that must never be hidden
  var SKIP = ".a-open, .timeline, .intro, dialog, .mega, .drawer, .site-header, .site-footer, .story-dialog, .tl-type, .thumbs, .gallery, .lead, .filterbar, .sticky-cta, .wa-float, .cx-panels, .cx-index, .cx-preview";
  var HEADINGS = "main h1, main h2, .c-intro p.big";
  var WIPE = ".feature > a .frame, .feature > .frame, .chapter-media .frame, .story-break .frame, .tile.t-a .frame, .record > .frame, .founders .frame, .pillars .sticky .frame, .c-index .coll-card.wide .frame";
  var PAR = ".feature > a .frame, .feature > .frame, .chapter-media .frame, .story-break .frame, .record > .frame, .tile.t-a .frame";
  var SOFT = ".p-card, .cat, .coll-card, .store, .tile, .count-card, .stat, .spec, .assure > div, .join, .mini-products > a, .c-cat, .cat-tile";
  var RULES = ".rule-gold";
  var EYEBROWS = "main .eyebrow";

  var io = new IntersectionObserver(function (entries) {
    entries.forEach(function (e) {
      if (!e.isIntersecting) return;
      e.target.classList.add("in");
      io.unobserve(e.target);
    });
  }, { rootMargin: "0px 0px -6% 0px", threshold: 0.01 });

  // Cards inside sideways-scrolling rows reveal together when the row arrives,
  // otherwise off-screen cards stay blank until they are swiped into view.
  var rowIO = new IntersectionObserver(function (entries) {
    entries.forEach(function (e) {
      if (!e.isIntersecting) return;
      Array.prototype.forEach.call(e.target.querySelectorAll(".m-soft:not(.in)"), function (c, i) {
        c.style.setProperty("--d", Math.min(i, 5)); c.classList.add("in");
      });
      rowIO.unobserve(e.target);
    });
  }, { rootMargin: "0px 0px -6% 0px", threshold: 0.01 });
  function hScroller(el) {
    for (var p = el.parentElement, k = 0; p && k < 3; p = p.parentElement, k++) {
      var ox = getComputedStyle(p).overflowX;
      if ((ox === "auto" || ox === "scroll") && p.scrollWidth > p.clientWidth + 4) return p;
    }
    return null;
  }

  // Safety net: once the footer shows, nothing above it may stay hidden.
  function revealAll() {
    Array.prototype.forEach.call(document.querySelectorAll(".m-soft:not(.in), .m-wipe:not(.in), .m-split:not(.in), .m-rule:not(.in), .m-eyebrow:not(.in), .rv:not(.in)"), function (el) {
      if (!el.closest(".intro")) el.classList.add("in");
    });
  }

  var introPending = function () { return root.classList.contains("intro-active") || root.classList.contains("intro-pending"); };

  function splitWords(el) {
    if (el.dataset.mSplit || el.querySelector(".gold-text, img, svg, .mw")) return false;
    var n = 0;
    (function walk(node) {
      Array.prototype.slice.call(node.childNodes).forEach(function (c) {
        if (c.nodeType === 3) {
          var parts = c.textContent.split(/(\s+)/), frag = document.createDocumentFragment();
          parts.forEach(function (p) {
            if (!p) return;
            if (/^\s+$/.test(p)) { frag.appendChild(document.createTextNode(" ")); return; }
            var w = document.createElement("span"), wi = document.createElement("span");
            w.className = "mw"; wi.className = "mwi"; wi.textContent = p; wi.style.setProperty("--w", n++);
            w.appendChild(wi); frag.appendChild(w);
          });
          node.replaceChild(frag, c);
        } else if (c.nodeType === 1 && !/^(BR|I)$/.test(c.tagName)) { walk(c); }
      });
    })(el);
    el.dataset.mSplit = "1";
    el.setAttribute("aria-label", el.textContent.replace(/\s+/g, " ").trim());
    return true;
  }

  function staggerIndex(el) {
    var p = el.parentElement, i = 0;
    if (!p) return 0;
    var sib = p.children;
    for (var k = 0; k < sib.length; k++) { if (sib[k] === el) break; if (sib[k].offsetParent !== null) i++; }
    var cols = Math.max(1, Math.round(p.clientWidth / Math.max(1, el.clientWidth || p.clientWidth)));
    return i % Math.min(cols, 6);
  }

  function tag(scope) {
    var q = function (sel) { return Array.prototype.slice.call((scope || document).querySelectorAll(sel)); };
    var skip = function (el) { return !!el.closest(SKIP) || el.dataset.mDone; };

    q(HEADINGS).forEach(function (h) {
      if (skip(h)) return;
      if (!splitWords(h)) return;
      h.dataset.mDone = "1";
      h.classList.remove("rv"); h.classList.add("m-split");
      if (h.closest(".hero")) {
        // Home hero headline waits for the intro curtain
        h.style.setProperty("--m-base", "0.35s");
        if (introPending()) { addEventListener("siroya:intro-done", function () { h.style.setProperty("--m-base", "0.55s"); h.classList.add("in"); }, { once: true }); }
        else requestAnimationFrame(function () { h.classList.add("in"); });
      } else io.observe(h);
    });

    q(WIPE).forEach(function (f) {
      if (skip(f)) return;
      f.dataset.mDone = "1"; f.classList.remove("rv"); f.classList.add("m-wipe");
      io.observe(f);
    });
    q(PAR).forEach(function (f) { if (!f.closest(SKIP)) f.classList.add("m-par"); });

    q(SOFT).forEach(function (c) {
      if (skip(c) || c.closest(".m-soft")) return;
      c.dataset.mDone = "1";
      c.classList.remove("rv");
      c.classList.add("m-soft");
      var row = hScroller(c);
      if (row) { if (!row.dataset.mRow) { row.dataset.mRow = "1"; rowIO.observe(row); } }
      else { c.style.setProperty("--d", staggerIndex(c)); io.observe(c); }
    });

    q(RULES).forEach(function (r) { if (skip(r)) return; r.dataset.mDone = "1"; r.classList.add("m-rule"); io.observe(r); });
    q(EYEBROWS).forEach(function (e) { if (skip(e) || e.closest(".hero")) return; e.dataset.mDone = "1"; e.classList.remove("rv"); e.classList.add("m-eyebrow"); io.observe(e); });
  }

  function start() {
    tag(document);
    var foot = document.querySelector(".site-footer");
    if (foot) new IntersectionObserver(function (es) { if (es[0].isIntersecting) revealAll(); }).observe(foot);
    // Content rendered after the catalog loads (grids, rails, stores)
    var pending = false;
    new MutationObserver(function () {
      if (pending) return;
      pending = true;
      requestAnimationFrame(function () { pending = false; tag(document.querySelector("main") || document); });
    }).observe(document.querySelector("main") || document.body, { childList: true, subtree: true });
    smooth();
  }

  // Lenis smooth scrolling: desktop pointers only, never inside scrollable UI
  function smooth() {
    if (!window.Lenis || matchMedia("(pointer: coarse)").matches || document.body.dataset.page === "admin") return;
    var lenis = new window.Lenis({
      lerp: 0.085, wheelMultiplier: 0.95, anchors: { offset: -84 },
      prevent: function (node) { return !!(node.closest && node.closest("dialog, .drawer, .mega, [data-lenis-prevent], .intro")); }
    });
    window.siroyaLenis = lenis;
    if (window.ScrollTrigger) { lenis.on("scroll", window.ScrollTrigger.update); }
    function raf(t) { lenis.raf(t); requestAnimationFrame(raf); }
    requestAnimationFrame(raf);
    if (introPending()) lenis.stop();
    // Pause behind the intro, the chapter reader and the mobile drawer
    var paused = null;
    new MutationObserver(function () {
      var stop = introPending() || !!document.querySelector("dialog[open], .drawer.open");
      if (stop === paused) return;
      paused = stop;
      stop ? lenis.stop() : lenis.start();
    }).observe(document.documentElement, { subtree: true, attributes: true, attributeFilter: ["open", "class"] });
  }

  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", start); else start();
})();
