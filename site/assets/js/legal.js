/* Legal pages (privacy, terms, refund, exchange). Marks the section being
   read in the "On this page" list (IntersectionObserver, no scroll
   listeners), fades table edges while there is more to swipe to, closes the
   phone contents list after a jump, and builds the WhatsApp link from
   window.SIROYA.site.whatsapp. Styles: assets/css/legal.css. */
(function () {
  "use strict";
  var $$ = function (q, el) { return Array.prototype.slice.call((el || document).querySelectorAll(q)); };
  var reduce = matchMedia("(prefers-reduced-motion: reduce)").matches;
  var hasIO = "IntersectionObserver" in window;

  /* ---------- WhatsApp ---------- */
  function waHref(a) {
    var S = window.SIROYA || {};
    var num = String((S.site && S.site.whatsapp) || "").replace(/\D/g, "");
    if (!num) return null;
    var topic = a.getAttribute("data-policy") || "policies";
    return "https://wa.me/" + num + "?text=" + encodeURIComponent("Hello Siroya Jewellers, I have a question about your " + topic + ".");
  }
  $$("[data-legal-wa]").forEach(function (a) {
    var set = function () { var h = waHref(a); if (h) a.href = h; };
    set();
    // Rebuilt on click too, so a number updated by the live catalog is used
    a.addEventListener("click", set);
  });

  /* ---------- Table of contents ---------- */
  var links = $$(".lg-toc a[href^='#']");
  var byId = {};
  links.forEach(function (a) {
    var id = decodeURIComponent(a.getAttribute("href").slice(1));
    (byId[id] = byId[id] || []).push(a);
  });
  var targets = Object.keys(byId).map(function (id) { return document.getElementById(id); }).filter(Boolean);
  targets.sort(function (a, b) { return a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING ? -1 : 1; });
  var aside = document.querySelector(".lg-aside");
  var current = [];

  // Keep the current link in view when the desktop list is taller than the screen
  function keepVisible() {
    if (!aside || !current.length || aside.scrollHeight <= aside.clientHeight + 1) return;
    var link = byId[current[current.length - 1].id].filter(function (a) { return aside.contains(a); })[0];
    if (!link) return;
    var ar = aside.getBoundingClientRect(), lr = link.getBoundingClientRect(), pad = 56, d = 0;
    if (lr.top < ar.top + pad) d = lr.top - (ar.top + pad);
    else if (lr.bottom > ar.bottom - pad) d = lr.bottom - (ar.bottom - pad);
    if (d) aside.scrollTo({ top: aside.scrollTop + d, behavior: reduce ? "auto" : "smooth" });
  }

  function setActive(els) {
    if (els.length === current.length && els.every(function (el, i) { return el === current[i]; })) return;
    current.forEach(function (el) { byId[el.id].forEach(function (a) { a.removeAttribute("aria-current"); }); });
    current = els;
    current.forEach(function (el) { byId[el.id].forEach(function (a) { a.setAttribute("aria-current", "location"); }); });
    keepVisible();
  }

  if (hasIO && targets.length) {
    // A thin reading line 30% down the screen. Sections are contiguous, so one
    // section (plus its parent, for 4.1 to 4.3) sits on the line at a time.
    var onLine = [];
    var io = new IntersectionObserver(function (entries) {
      entries.forEach(function (e) {
        var i = onLine.indexOf(e.target);
        if (e.isIntersecting && i < 0) onLine.push(e.target);
        if (!e.isIntersecting && i > -1) onLine.splice(i, 1);
      });
      if (onLine.length) { setActive(targets.filter(function (t) { return onLine.indexOf(t) > -1; })); return; }
      // Above the first section the first entry is current; below the last
      // section (closing panel, footer) the last one stays current.
      if (targets[0].getBoundingClientRect().top > innerHeight * 0.3) setActive([targets[0]]);
    }, { rootMargin: "-30% 0px -69% 0px", threshold: 0 });
    targets.forEach(function (t) { io.observe(t); });
  }

  // Lets the mouse wheel scroll the desktop list itself (not the page, via
  // Lenis) only when the list is taller than the screen.
  if (aside && "ResizeObserver" in window) {
    new ResizeObserver(function () {
      aside.toggleAttribute("data-lenis-prevent", aside.scrollHeight > aside.clientHeight + 1);
    }).observe(aside);
  }

  // Phones: close the contents list first, then jump, so the jump lands on
  // the heading instead of overshooting by the height of the open list.
  var mobile = document.querySelector(".lg-toc-m");
  if (mobile) mobile.addEventListener("click", function (e) {
    var a = e.target.closest("a[href^='#']");
    if (!a) return;
    var t = document.getElementById(decodeURIComponent(a.getAttribute("href").slice(1)));
    if (!t) return;
    e.preventDefault();
    e.stopPropagation();
    mobile.open = false;
    try { history.pushState(null, "", "#" + t.id); } catch (err) {}
    if (window.siroyaLenis) window.siroyaLenis.scrollTo(t, { offset: -84 });
    else t.scrollIntoView({ behavior: reduce ? "auto" : "smooth", block: "start" });
    if (!t.hasAttribute("tabindex")) t.setAttribute("tabindex", "-1");
    t.focus({ preventScroll: true });
  });

  /* ---------- Tables: edge fades and swipe hint ---------- */
  $$(".lg-table").forEach(function (box) {
    var sc = box.querySelector(".lg-scroll");
    var cells = sc ? sc.querySelectorAll("thead th") : [];
    if (!cells.length || !hasIO) return;
    // The first and last header cells, watched inside the scroller, tell
    // whether there is more table to the left or right.
    var first = cells[0], last = cells[cells.length - 1];
    var tio = new IntersectionObserver(function (entries) {
      entries.forEach(function (e) {
        sc.classList.toggle(e.target === first ? "fade-l" : "fade-r", e.intersectionRatio < 0.98);
      });
      var can = sc.scrollWidth > sc.clientWidth + 2;
      box.classList.toggle("can-scroll", can);
      // A scrollable region must be reachable by keyboard
      if (can) sc.tabIndex = 0; else sc.removeAttribute("tabindex");
    }, { root: sc, threshold: [0, 0.98, 1] });
    tio.observe(first);
    tio.observe(last);
  });
})();
