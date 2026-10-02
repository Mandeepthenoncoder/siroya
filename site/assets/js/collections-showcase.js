/* Collections showcase (collections.html).
   1. An editorial index: every collection as a large line of type. On desktop
      the cover image floats beside the pointer while hovering a name.
   2. One full-screen chapter per collection. Chapters are sticky, so each new
      collection slides over the last like turning the pages of a lookbook.
   3. A slim side guide (desktop) shows which collection is in view.
   Waits for site.js to load the catalog (html[data-catalog]), so it shows
   live data from the admin when the Node server is running. */
(function () {
  "use strict";
  var S = window.SIROYA;
  var root = document.documentElement;
  var reduce = matchMedia("(prefers-reduced-motion: reduce)").matches;
  var esc = function (s) { return String(s == null ? "" : s).replace(/[&<>"']/g, function (c) { return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]; }); };
  var url = function (c) { return "collection.html?c=" + encodeURIComponent(c.slug); };
  var wa = function (c) { return "https://wa.me/" + String((S.site && S.site.whatsapp) || "").replace(/\D/g, "") + "?text=" + encodeURIComponent("Hello Siroya Jewellers, I would like to know more about the " + c.name + " collection."); };

  function render() {
    var list = (S.collections || []).slice();
    var idx = document.getElementById("cx-index"), panels = document.getElementById("cx-panels"), guide = document.getElementById("cx-guide");
    if (!idx || !panels) return;
    if (!list.length) {
      idx.innerHTML = '<p class="lede">Our collections are being prepared. Ask our team on WhatsApp what is in store today.</p>';
      return;
    }
    var counts = {};
    (S.products || []).forEach(function (p) { counts[p.collection] = (counts[p.collection] || 0) + 1; });

    idx.innerHTML = list.map(function (c) {
      return '<a class="cx-row" href="#' + esc(c.slug) + '" data-img="' + esc(c.cover || c.hero) + '">' +
        '<span class="cx-name">' + esc(c.name) + '</span>' +
        '<span class="cx-kind">' + esc(c.kind) + '</span>' +
        '<i class="ph ph-arrow-down-right" aria-hidden="true"></i></a>';
    }).join("");

    panels.innerHTML = list.map(function (c, i) {
      var n = counts[c.slug] || 0;
      var img = c.hero || c.cover, port = c.cover || c.hero;
      return '<section class="cx-panel" id="' + esc(c.slug) + '" aria-label="' + esc(c.name) + '" style="--z:' + (i + 1) + '">' +
        '<div class="cx-media">' +
          // Portrait screens (phones, and tablets held upright) get the 3:4 cover
          (img ? '<picture>' + (port ? '<source media="(max-width: 760px), (max-aspect-ratio: 1/1)" srcset="' + esc(port) + '">' : "") +
            '<img src="' + esc(img) + '" alt="' + esc(c.name + ", " + c.kind) + '" loading="' + (i < 1 ? "eager" : "lazy") + '" decoding="async"></picture>'
               : '<div class="slot dark" aria-hidden="true"></div>') +
        '</div>' +
        '<div class="wrap cx-copy">' +
          '<span class="cx-tag">' + esc(c.kind) + '</span>' +
          '<h2 class="cx-title">' + esc(c.name) + '</h2>' +
          '<p class="cx-short">' + esc(c.short || c.intro) + '</p>' +
          '<div class="cx-ctas">' +
            '<a class="btn btn-cream" href="' + url(c) + '" aria-label="Explore ' + esc(c.name) + '">Explore<span class="cx-cta-name"> ' + esc(c.name) + '</span></a>' +
            '<a class="btn btn-line" href="' + wa(c) + '" target="_blank" rel="noopener" data-wa="collections-showcase"><i class="ph ph-whatsapp-logo"></i>Enquire</a>' +
          '</div>' +
          (n ? '<span class="cx-count">' + n + ' design' + (n === 1 ? "" : "s") + ' online. Visit a store to see more.</span>' : "") +
        '</div>' +
      '</section>';
    }).join("");

    if (guide) {
      guide.innerHTML = list.map(function (c) {
        return '<a href="#' + esc(c.slug) + '" data-for="' + esc(c.slug) + '"><span class="cx-g-line" aria-hidden="true"></span><span class="cx-g-name">' + esc(c.name) + '</span></a>';
      }).join("");
    }

    var close = document.getElementById("cx-wa");
    if (close) close.href = "https://wa.me/" + String((S.site && S.site.whatsapp) || "").replace(/\D/g, "") + "?text=" + encodeURIComponent("Hello Siroya Jewellers, could you help me choose a design?");
    var all = document.querySelector('.nav a[href="collections.html"]');
    if (all) all.setAttribute("aria-current", "page");
    wire(list);
  }

  function wire(list) {
    // Guide: highlight the chapter in view; hide the guide outside the chapters
    var guide = document.getElementById("cx-guide"), panelsEl = document.getElementById("cx-panels");
    if (guide && "IntersectionObserver" in window) {
      var links = {};
      Array.prototype.forEach.call(guide.querySelectorAll("a"), function (a) { links[a.dataset.for] = a; });
      var io = new IntersectionObserver(function (es) {
        es.forEach(function (e) {
          if (!e.isIntersecting) return;
          Object.keys(links).forEach(function (k) { links[k].classList.toggle("on", k === e.target.id); });
        });
      }, { rootMargin: "-45% 0px -45% 0px" });
      Array.prototype.forEach.call(document.querySelectorAll(".cx-panel"), function (p) { io.observe(p); });
      new IntersectionObserver(function (es) { guide.classList.toggle("show", es[0].isIntersecting); }, { rootMargin: "-40% 0px -40% 0px" }).observe(panelsEl);
    }

    // While a chapter sits under it, the header turns transparent with the
    // light logo (as over the home hero), so each photograph runs to the top
    // of the screen instead of meeting a solid cream bar
    var hd = document.getElementById("site-header");
    if (hd && panelsEl) {
      var ticking = false;
      var paintHd = function () {
        ticking = false;
        var r = panelsEl.getBoundingClientRect(), y = hd.offsetHeight / 2;
        hd.classList.toggle("over-hero", r.top <= y && r.bottom > y && !hd.classList.contains("mega-open"));
      };
      addEventListener("scroll", function () { if (!ticking) { ticking = true; requestAnimationFrame(paintHd); } }, { passive: true });
      addEventListener("resize", paintHd, { passive: true });
      paintHd();
    }

    // Each chapter's copy rises as it arrives
    if (!reduce && "IntersectionObserver" in window) {
      var cio = new IntersectionObserver(function (es) {
        es.forEach(function (e) { if (e.isIntersecting) { e.target.classList.add("in"); cio.unobserve(e.target); } });
      }, { threshold: 0.35 });
      Array.prototype.forEach.call(document.querySelectorAll(".cx-panel"), function (p) { cio.observe(p); });
    } else {
      Array.prototype.forEach.call(document.querySelectorAll(".cx-panel"), function (p) { p.classList.add("in"); });
    }

    // Index rows cascade in
    var idxEl = document.getElementById("cx-index");
    if (idxEl) {
      Array.prototype.forEach.call(idxEl.querySelectorAll(".cx-row"), function (r, i) { r.style.setProperty("--d", i); });
      if (reduce || !("IntersectionObserver" in window)) idxEl.classList.add("in");
      else { var iio = new IntersectionObserver(function (es) { if (es[0].isIntersecting) { idxEl.classList.add("in"); iio.disconnect(); } }, { threshold: 0.05 }); iio.observe(idxEl); }
    }

    // Index hover preview (desktop pointers only)
    var fine = matchMedia("(hover: hover) and (pointer: fine)").matches;
    var prev = document.getElementById("cx-preview"), idx = document.getElementById("cx-index");
    if (!fine || !prev || !idx || reduce) return;
    var img = prev.querySelector("img"), tx = 0, ty = 0, x = 0, y = 0, running = false;
    function loop() {
      x += (tx - x) * 0.14; y += (ty - y) * 0.14;
      prev.style.transform = "translate3d(" + x + "px," + y + "px,0) translate(-50%,-50%)";
      if (running) requestAnimationFrame(loop);
    }
    idx.addEventListener("pointerenter", function () { running = true; requestAnimationFrame(loop); });
    idx.addEventListener("pointerleave", function () { running = false; prev.classList.remove("on"); });
    idx.addEventListener("pointermove", function (e) {
      // a fixed lane right of the longest name; only the height follows the pointer
      var r = idx.getBoundingClientRect(), longest = 0;
      Array.prototype.forEach.call(idx.querySelectorAll(".cx-name"), function (n) { longest = Math.max(longest, n.getBoundingClientRect().right - r.left); });
      tx = Math.min(r.width - prev.offsetWidth / 2 - 80, Math.max(r.width * 0.68, longest + prev.offsetWidth / 2 + 48));
      ty = e.clientY - r.top;
    });
    Array.prototype.forEach.call(idx.querySelectorAll(".cx-row"), function (row) {
      row.addEventListener("pointerenter", function () {
        if (row.dataset.img) { if (img.getAttribute("src") !== row.dataset.img) img.src = row.dataset.img; prev.classList.add("on"); }
      });
    });
  }

  function whenCatalog(fn) {
    if (root.dataset.catalog) return fn();
    var mo = new MutationObserver(function () { if (root.dataset.catalog) { mo.disconnect(); fn(); } });
    mo.observe(root, { attributes: true, attributeFilter: ["data-catalog"] });
  }
  whenCatalog(render);
})();
