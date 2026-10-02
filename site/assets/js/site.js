/* Siroya site runtime: shared header/footer, reveal motion, collection,
   category, product and about page rendering, WhatsApp lead capture with
   Google Ads attribution. No framework. The catalog comes from /api/catalog
   when the Node server runs, otherwise from data.js (static hosting). */
(function () {
  const S = window.SIROYA;
  const $ = (q, el = document) => el.querySelector(q);
  const $$ = (q, el = document) => [...el.querySelectorAll(q)];
  const params = new URLSearchParams(location.search);
  const page = document.body.dataset.page;
  const reduce = matchMedia("(prefers-reduced-motion: reduce)").matches;

  const esc = s => String(s ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  const media = (src, label, dark) => src
    ? `<img src="${esc(src)}" alt="${esc(label)}" loading="lazy" decoding="async">`
    : `<div class="slot${dark ? " dark" : ""}">${esc(label)}</div>`;
  const coll = slug => S.collections.find(c => c.slug === slug);
  const catOf = slug => S.categories.find(c => c.slug === slug);
  const productUrl = p => `product.html?p=${encodeURIComponent(p.id)}`;
  const collUrl = c => `collection.html?c=${encodeURIComponent(c.slug)}`;
  const catUrl = c => `category.html?c=${encodeURIComponent(c.slug)}`;
  const bySort = (a, b) => (a.sort ?? 0) - (b.sort ?? 0);
  const plural = (n, word) => `${n} ${word}${n === 1 ? "" : "s"}`;
  const setMeta = text => { const m = $('meta[name="description"]'); if (m) m.setAttribute("content", text.replace(/\s+/g, " ").trim()); };
  // All categories in admin order; menus list every one of them
  const allCats = () => [...S.categories].sort(bySort);
  // Home page, footer: categories marked "Show on homepage" (all of them if none are marked)
  function featuredCats() {
    const all = allCats(), f = all.filter(c => c.featured !== false);
    return f.length ? f : all;
  }

  /* ---------------- Attribution (Google Ads) ----------------
     Keeps gclid / gbraid / wbraid / utm_* for 90 days so a lead sent days
     later is still tied to the ad click. */
  const ATTR_KEY = "siroya_attr";
  const attrKeys = ["gclid", "gbraid", "wbraid", "utm_source", "utm_medium", "utm_campaign", "utm_term", "utm_content"];
  (function captureAttribution() {
    const found = {};
    attrKeys.forEach(k => { if (params.get(k)) found[k] = params.get(k); });
    if (!Object.keys(found).length) return;
    found.landing = location.pathname + location.search;
    found.ts = Date.now();
    try { localStorage.setItem(ATTR_KEY, JSON.stringify(found)); } catch (e) {}
  })();
  function getAttribution() {
    try {
      const a = JSON.parse(localStorage.getItem(ATTR_KEY) || "null");
      if (a && Date.now() - a.ts < 90 * 864e5) return a;
    } catch (e) {}
    return {};
  }
  window.dataLayer = window.dataLayer || [];
  function track(event, data) { window.dataLayer.push(Object.assign({ event }, data)); }

  function waLink(text) { return `https://wa.me/${S.site.whatsapp}?text=${encodeURIComponent(text)}`; }

  /* Store a lead copy on the server. Never blocks or throws: the WhatsApp
     hand-off must happen whatever the network does. */
  function saveLead(lead) {
    if (location.protocol === "file:") return;
    const endpoint = S.site.leadEndpoint || "/api/leads";
    const body = JSON.stringify(lead);
    try {
      if (window.fetch) {
        fetch(endpoint, { method: "POST", headers: { "Content-Type": "text/plain;charset=UTF-8" }, body, keepalive: true, credentials: "same-origin" })
          .then(r => { if (!r.ok && r.status !== 404 && r.status !== 405 && r.status !== 501) console.warn("Lead not stored:", r.status); })
          .catch(() => { try { navigator.sendBeacon && navigator.sendBeacon(endpoint, new Blob([body], { type: "text/plain;charset=UTF-8" })); } catch (e) {} });
      } else if (navigator.sendBeacon) {
        navigator.sendBeacon(endpoint, new Blob([body], { type: "text/plain;charset=UTF-8" }));
      }
    } catch (e) {}
  }
  function waGeneral() { return waLink("Hello Siroya Jewellers, I would like to know more about your collections."); }

  /* ---------------- Header / footer ---------------- */
  const LOGO_DARK = "assets/img/logo/siroya-red.png";
  const LOGO_LIGHT = "assets/img/logo/siroya-white.png";
  const telHref = phone => `tel:${String(phone).replace(/[^\d+]/g, "")}`;

  // Header shell renders once, straight away. navLists() fills the mega menu
  // and drawer, and runs again if the live catalog differs from data.js.
  function header() {
    const el = $("#site-header");
    if (!el) return;
    const here = page;
    el.innerHTML = `
      <div class="wrap">
        <nav class="nav nav-left" aria-label="Primary">
          <button class="icon-btn nav-toggle" aria-label="Open menu" aria-controls="drawer" aria-expanded="false" data-open-drawer><i class="ph ph-list"></i></button>
          <button type="button" data-mega aria-expanded="false" aria-controls="mega">Collections</button>
          <a href="about.html" ${here === "about" ? 'aria-current="page"' : ""}>Our Story</a>
          <a href="index.html#stores">Stores</a>
        </nav>
        <a class="logo" href="index.html" aria-label="Siroya Jewellers home">
          <img class="logo-dark" src="${LOGO_DARK}" alt="Siroya Jewellers">
          <img class="logo-light" src="${LOGO_LIGHT}" alt="">
        </a>
        <nav class="nav nav-right" aria-label="Secondary">
          <a class="hide-sm" href="collections.html" ${here === "collections" ? 'aria-current="page"' : ""}>All Jewellery</a>
          <a class="icon-btn" href="${waGeneral()}" target="_blank" rel="noopener" aria-label="Chat on WhatsApp" data-wa="header"><i class="ph ph-whatsapp-logo"></i></a>
        </nav>
      </div>
      <div class="mega" id="mega"><div class="wrap mega-grid"></div></div>`;

    if (document.body.dataset.overHero !== undefined) {
      el.classList.add("over-hero");
      const sentinel = document.createElement("div");
      sentinel.style.cssText = "position:absolute;top:80px;height:1px;width:1px";
      document.body.prepend(sentinel);
      new IntersectionObserver(([e]) => el.classList.toggle("over-hero", e.isIntersecting && !el.classList.contains("mega-open"))).observe(sentinel);
    }

    const btn = $("[data-mega]", el), mega = $("#mega", el);
    let closeT;
    const open = v => {
      mega.classList.toggle("open", v); btn.setAttribute("aria-expanded", v);
      el.classList.toggle("mega-open", v);
      if (v) el.classList.remove("over-hero");
      else if (document.body.dataset.overHero !== undefined && scrollY < 80) el.classList.add("over-hero");
    };
    // Hover opens the menu on desktop; a click that lands right after that
    // hover must not toggle it shut again (keyboard and touch still toggle).
    let hoverOpenedAt = 0;
    btn.addEventListener("click", () => {
      if (Date.now() - hoverOpenedAt < 600) return;
      open(!mega.classList.contains("open"));
    });
    [btn, mega].forEach(n => {
      n.addEventListener("mouseenter", () => {
        clearTimeout(closeT);
        if (matchMedia("(hover:hover)").matches) { if (!mega.classList.contains("open")) hoverOpenedAt = Date.now(); open(true); }
      });
      n.addEventListener("mouseleave", () => { closeT = setTimeout(() => open(false), 180); });
    });
    document.addEventListener("keydown", e => { if (e.key === "Escape") { open(false); drawer(false); } });

    // Mobile drawer
    const d = document.createElement("div");
    d.className = "drawer"; d.id = "drawer"; d.setAttribute("aria-hidden", "true"); d.inert = true;
    d.setAttribute("role", "dialog"); d.setAttribute("aria-label", "Menu");
    d.innerHTML = `
      <div class="drawer-top"><img src="${LOGO_LIGHT}" alt="Siroya Jewellers" style="height:34px;width:auto"><button class="icon-btn" aria-label="Close menu" data-close-drawer><i class="ph ph-x"></i></button></div>
      <nav class="drawer-nav" aria-label="Mobile"></nav>
      <a class="btn btn-cream drawer-cta" href="${waGeneral()}" target="_blank" rel="noopener" data-wa="drawer"><i class="ph ph-whatsapp-logo"></i>Chat on WhatsApp</a>`;
    document.body.appendChild(d);
    const toggle = $("[data-open-drawer]", el);
    const drawer = v => {
      d.classList.toggle("open", v); d.setAttribute("aria-hidden", !v); d.inert = !v;
      toggle.setAttribute("aria-expanded", v);
      document.body.style.overflow = v ? "hidden" : "";
      if (v) $("[data-close-drawer]", d).focus(); else if (d.contains(document.activeElement)) toggle.focus();
    };
    toggle.addEventListener("click", () => drawer(true));
    $("[data-close-drawer]", d).addEventListener("click", () => drawer(false));
    // Same-page links (Stores) would otherwise leave the drawer open
    d.addEventListener("click", e => { if (e.target.closest("a")) drawer(false); });
    navLists();
  }

  function navLists() {
    const cats = allCats();
    const mega = $("#mega .mega-grid");
    if (mega) mega.innerHTML = `
      <div class="mega-col">
        <p class="mega-h">Collections</p>
        <div class="mega-list">${S.collections.map(c => `<a href="${collUrl(c)}"><span>${esc(c.name)}</span><span>${esc(c.kind)}</span></a>`).join("")}</div>
        <a class="link-arrow mega-all" href="collections.html">All collections <i class="ph ph-arrow-right"></i></a>
      </div>
      ${cats.length ? `<div class="mega-col">
        <p class="mega-h">Shop by category</p>
        <div class="mega-cats${cats.length > 8 ? " two" : ""}">${cats.map(c => `<a href="${catUrl(c)}">${esc(c.name)}</a>`).join("")}</div>
      </div>` : ""}
      <div class="mega-feature">
        ${S.collections.slice(0, 3).map(c => `<a class="zoom" href="${collUrl(c)}"><div class="frame">${media(c.cover, c.name + " cover")}</div><p>${esc(c.name)}</p></a>`).join("")}
      </div>`;
    const dn = $("#drawer .drawer-nav");
    if (dn) dn.innerHTML = `
      <a class="d-main" href="collections.html">All Jewellery <i class="ph ph-arrow-right"></i></a>
      <p class="d-h">Collections</p>
      <div class="d-sub">${S.collections.map(c => `<a href="${collUrl(c)}">${esc(c.name)}</a>`).join("")}</div>
      ${cats.length ? `<p class="d-h">Shop by category</p>
      <div class="d-sub">${cats.map(c => `<a href="${catUrl(c)}">${esc(c.name)}</a>`).join("")}</div>` : ""}
      <a class="d-main" href="about.html">Our Story <i class="ph ph-arrow-right"></i></a>
      <a class="d-main" href="index.html#stores">Stores <i class="ph ph-arrow-right"></i></a>`;
  }

  /* Footer. Desktop shows every column; phones turn each column into a
     <details> accordion (closed by default) so the footer stays short. */
  const footMQ = matchMedia("(max-width: 760px)");
  function syncFoot() {
    $$("#site-footer [data-foot-col]").forEach(d => {
      d.open = !footMQ.matches;
      $("summary", d).tabIndex = footMQ.matches ? 0 : -1;
    });
  }
  footMQ.addEventListener?.("change", syncFoot);

  function footer() {
    const el = $("#site-footer");
    if (!el) return;
    const s = S.site, soc = s.socials || {}, since = s.since || 1976;
    const socials = [["instagram", "Instagram", "instagram-logo"], ["facebook", "Facebook", "facebook-logo"], ["youtube", "YouTube", "youtube-logo"]].filter(([k]) => soc[k]);
    const cats = featuredCats();
    const col = (title, body) => `
      <details class="foot-col" data-foot-col open>
        <summary><h2 class="foot-h">${title}</h2><i class="ph ph-plus" aria-hidden="true"></i></summary>
        <div class="foot-body">${body}</div>
      </details>`;
    const ext = 'target="_blank" rel="noopener"';
    el.innerHTML = `
      <div class="wrap">
        <div class="foot-top">
          <p class="foot-line">Your family jewellers <span class="gold-text">since ${esc(since)}</span></p>
          <a class="btn btn-gold" href="${waGeneral()}" ${ext} data-wa="footer"><i class="ph ph-whatsapp-logo"></i>Chat on WhatsApp</a>
        </div>
        <div class="foot-grid">
          <div class="foot-brand">
            <a class="foot-logo" href="index.html" aria-label="Siroya Jewellers home"><img src="${LOGO_LIGHT}" alt="Siroya Jewellers"></a>
            <p>The trusted Indian family jeweller in Dubai, bringing the world's finest designs to your celebrations.</p>
            ${socials.length ? `<div class="socials">${socials.map(([k, label, icon]) => `<a href="${esc(soc[k])}" ${ext} aria-label="${label}"><i class="ph ph-${icon}"></i></a>`).join("")}</div>` : ""}
          </div>
          ${col("Collections", `<ul class="two-col">${S.collections.map(c => `<li><a href="${collUrl(c)}">${esc(c.name)}</a></li>`).join("")}</ul>`)}
          ${cats.length ? col("Shop by category", `<ul>${cats.map(c => `<li><a href="${catUrl(c)}">${esc(c.name)}</a></li>`).join("")}</ul>`) : ""}
          ${S.stores.length ? col("Visit", `<ul class="foot-stores">${S.stores.map(st => `
            <li>
              <b>${esc(st.name)}</b>
              <span class="foot-acts">
                ${st.phone ? `<a href="${telHref(st.phone)}" aria-label="Call ${esc(st.name)}, ${esc(st.phone)}"><i class="ph ph-phone"></i>${esc(st.phone)}</a>` : ""}
                ${st.map ? `<a href="${esc(st.map)}" ${ext} aria-label="Directions to ${esc(st.name)}"><i class="ph ph-map-pin"></i>Directions</a>` : ""}
              </span>
            </li>`).join("")}</ul>`) : ""}
          ${col("Help", `<ul>
            <li><a href="about.html">Our story</a></li>
            <li><a href="contact.html">Contact us</a></li>
            <li><a href="${waLink("Hello Siroya Jewellers, I would like to book a visit to one of your stores.")}" ${ext} data-wa="footer-visit">Book a visit via WhatsApp</a></li>
            <li><a href="exchange-policy.html">Exchange and buyback</a></li>
            ${s.email ? `<li><a href="mailto:${esc(s.email)}"><i class="ph ph-envelope-simple"></i>${esc(s.email)}</a></li>` : ""}
          </ul>`)}
        </div>
        <div class="foot-base">
          <ul class="foot-pay" role="list" aria-label="Payment methods we accept in store">${[["amex", "American Express"], ["apple-pay", "Apple Pay"], ["tabby", "Tabby"], ["mastercard", "Mastercard"], ["visa", "Visa"]].map(([f, alt]) => `<li><img src="assets/img/payments/${f}.svg" alt="${alt}" width="38" height="24" loading="lazy" decoding="async"></li>`).join("")}</ul>
          <ul class="foot-legal" role="list" aria-label="Policies">${[["privacy-policy.html", "Privacy policy"], ["contact.html", "Contact information"], ["terms-of-service.html", "Terms of service"], ["refund-policy.html", "Refund policy"], ["exchange-policy.html", "Exchange and buyback"]].map(([href, label]) => `<li><a href="${href}">${label}</a></li>`).join("")}</ul>
          <p class="foot-copy">&copy; ${new Date().getFullYear()}, SIROYA Jewellers</p>
          <p class="foot-since">Jewellers to the world since ${esc(since)}</p>
        </div>
      </div>`;
    $$("[data-foot-col] summary", el).forEach(sm => sm.addEventListener("click", e => { if (!footMQ.matches) e.preventDefault(); }));
    syncFoot();
  }

  // Floating WhatsApp: appears once the visitor scrolls past the first screen
  // (so it never sits on the hero buttons) and steps aside wherever the page
  // already offers WhatsApp: the footer, the WhatsApp join card, the store
  // cards ("Book a visit") and the full-screen collection chapters on
  // collections.html (each has its own Enquire button, which the float would
  // otherwise cover on phones).
  // Zones where the float steps aside. waAvoid() runs again once the page body
  // has rendered, so blocks built from the catalog (the WhatsApp join card,
  // store cards with their own "Book a visit") are covered too.
  const WA_AVOID = "#site-footer, #cx-panels, .join, .stores";
  let waIO = null;
  function waAvoid() { if (waIO) $$(WA_AVOID).forEach(z => waIO.observe(z)); }
  function floatingWA() {
    if (page === "product") return; // the product page has its own sticky enquiry bar
    const a = document.createElement("a");
    a.className = "wa-float away"; a.href = waGeneral(); a.target = "_blank"; a.rel = "noopener";
    a.setAttribute("aria-label", "Chat with us on WhatsApp"); a.dataset.wa = "float";
    a.innerHTML = '<i class="ph ph-whatsapp-logo"></i>';
    document.body.appendChild(a);
    let past = false;
    const covering = new Set();
    const upd = () => a.classList.toggle("away", !past || covering.size > 0);
    const onScroll = () => { const v = scrollY > innerHeight * 0.4; if (v !== past) { past = v; upd(); } };
    addEventListener("scroll", onScroll, { passive: true });
    onScroll();
    if (!("IntersectionObserver" in window)) return;
    waIO = new IntersectionObserver(es => { es.forEach(e => e.isIntersecting ? covering.add(e.target) : covering.delete(e.target)); upd(); });
    waAvoid();
  }

  // Every WhatsApp click is a conversion signal for Ads
  document.addEventListener("click", e => {
    const a = e.target.closest("[data-wa]");
    if (a) track("whatsapp_click", Object.assign({ wa_location: a.dataset.wa, page_type: page }, getAttribution()));
  });

  /* ---------------- Motion ---------------- */
  function reveals(root = document) {
    const els = $$(".rv:not(.in)", root);
    if (reduce || !("IntersectionObserver" in window)) { els.forEach(e => e.classList.add("in")); return; }
    const io = new IntersectionObserver(entries => entries.forEach(en => {
      if (en.isIntersecting) { en.target.classList.add("in"); io.unobserve(en.target); }
    }), { rootMargin: "0px 0px -8% 0px", threshold: 0.08 });
    // Anything already on screen reveals at once (staggered by --i). Without
    // this, hero buttons sitting low on a phone screen never met the threshold
    // and stayed invisible until the visitor scrolled.
    const fold = innerHeight;
    els.forEach(e => {
      const r = e.getBoundingClientRect();
      if (r.top < fold && r.bottom > 0) requestAnimationFrame(() => e.classList.add("in"));
      else io.observe(e);
    });
  }
  // Horizontal scrollers (chip rows) fade only on the side that has more to show
  function fades(root = document) {
    $$("[data-fade]", root).forEach(el => {
      const upd = () => {
        const max = el.scrollWidth - el.clientWidth;
        el.classList.toggle("fade-l", el.scrollLeft > 4);
        el.classList.toggle("fade-r", max > 4 && el.scrollLeft < max - 4);
      };
      el.addEventListener("scroll", upd, { passive: true });
      addEventListener("resize", upd, { passive: true });
      upd();
    });
  }
  function rails() {
    $$("[data-rail]").forEach(wrap => {
      const r = $(".rail", wrap);
      if (!r) return;
      $$("[data-dir]", wrap).forEach(b => b.addEventListener("click", () =>
        r.scrollBy({ left: Number(b.dataset.dir) * r.clientWidth * 0.8, behavior: reduce ? "auto" : "smooth" })));
      // A rail that fits its row has nothing to scroll: hide the arrows (and
      // let category tiles share the row). Measured at the natural tile size.
      let raf = 0;
      const upd = () => {
        raf = 0;
        wrap.classList.remove("rail-static");
        wrap.classList.toggle("rail-static", r.scrollWidth <= r.clientWidth + 2);
      };
      upd();
      addEventListener("resize", () => { if (!raf) raf = requestAnimationFrame(upd); }, { passive: true });
    });
  }
  function countUp(root = document) {
    const els = $$("[data-count]", root);
    const run = el => {
      const end = Number(el.dataset.count), suffix = el.dataset.suffix || "";
      const fmt = v => (el.hasAttribute("data-plain") ? String(v) : v.toLocaleString()) + suffix;
      if (reduce) { el.textContent = fmt(end); return; }
      const t0 = performance.now(), dur = 1600;
      const step = t => {
        const k = Math.min(1, (t - t0) / dur), v = Math.round(end * (1 - Math.pow(1 - k, 3)));
        el.textContent = fmt(v);
        if (k < 1) requestAnimationFrame(step);
      };
      requestAnimationFrame(step);
    };
    const io = new IntersectionObserver(es => es.forEach(e => { if (e.isIntersecting) { run(e.target); io.unobserve(e.target); } }), { threshold: 0.5 });
    els.forEach(e => io.observe(e));
  }

  /* ---------------- Shared blocks ---------------- */
  const collCard = (c, extra = "") => `
    <a class="coll-card zoom ${extra}" href="${collUrl(c)}">
      <div class="frame">${media(c.cover, c.name + " cover, portrait 3:4")}
        <div class="over"><span>${esc(c.kind)}</span><h3>${esc(c.name)}</h3>${extra.includes("with-desc") && c.short ? `<p>${esc(c.short)}</p>` : ""}</div>
      </div>
    </a>`;
  // Metal and stone line: it may wrap only after a comma, never inside a
  // phrase ("18K Gold, / Lab Grown Diamond", not "18K Gold, Lab / Grown")
  const metaHTML = s => String(s ?? "").split(/,\s*/).filter(Boolean).map(x => `<span class="nw">${esc(x)}</span>`).join(", ");
  // Product card: name clamped to two lines and a fixed meta row, so cards in
  // a row always share one height and "Enquire" never collides with the text.
  const productCard = (p, i = 0) => {
    const im = p.images || [];
    return `
    <a class="p-card zoom rv" style="--i:${i % 4}" href="${productUrl(p)}">
      <div class="frame">${im[0] ? `<img src="${esc(im[0])}" alt="${esc(p.name)}" loading="lazy" decoding="async">${im[1] ? `<img class="alt" src="${esc(im[1])}" alt="" loading="lazy" decoding="async">` : ""}` : media("", "Product photo 4:5")}</div>
      <div class="p-body"><h3>${esc(p.name)}</h3><p class="meta">${metaHTML(p.metal)}</p></div>
      <span class="enq"><i class="ph ph-whatsapp-logo"></i>Enquire</span>
    </a>`;
  };
  const catTile = (c, i = 0, rv = true) => `
    <a class="cat zoom${rv ? " rv" : ""}" style="--i:${i % 6}" href="${catUrl(c)}">
      <div class="frame">${media(c.img, c.name)}</div><span>${esc(c.name)}</span>
    </a>`;
  const joinBlock = () => `
    <section class="pad-sm"><div class="wrap">
      <div class="join rv">
        <div><h2>See new designs first on WhatsApp</h2><p class="lede" style="margin-top:10px">New collections, store events and festive launches, shared directly by our team.</p></div>
        <a class="btn btn-red" href="${waLink("Hello Siroya Jewellers, please add me to your new designs updates.")}" target="_blank" rel="noopener" data-wa="join"><i class="ph ph-whatsapp-logo"></i>Join on WhatsApp</a>
      </div>
    </div></section>`;
  // A product grid that ends on a part row closes with a tile spanning the
  // empty columns, so the last row never looks unfinished
  const gridCols = el => {
    const t = el ? getComputedStyle(el).gridTemplateColumns : "";
    return t && t !== "none" ? t.trim().split(/\s+/).length : 4;
  };
  const gridFill = (n, cols, text, waText) => {
    const left = n % cols;
    if (cols < 2 || !left) return "";
    return `<a class="grid-fill rv" style="grid-column: span ${cols - left}" href="${waLink(waText)}" target="_blank" rel="noopener" data-wa="grid-fill">
        <i class="ph ph-whatsapp-logo" aria-hidden="true"></i><span class="gf-text">${esc(text)}</span><span class="link-arrow">Ask our team <i class="ph ph-arrow-right"></i></span></a>`;
  };
  const emptyState = (text, waText, label = "Ask on WhatsApp") => `
    <div class="empty"><i class="ph ph-sparkle"></i><p>${esc(text)}</p>
      <a class="btn btn-red" href="${waLink(waText)}" target="_blank" rel="noopener" data-wa="empty"><i class="ph ph-whatsapp-logo"></i>${esc(label)}</a></div>`;
  // Sticky chip row: scrolls sideways on phones, count stays pinned on the right
  const filterBar = (label, chips) => `
    <div class="filterbar" id="designs"><div class="wrap fb">
      <div class="chips" role="toolbar" aria-label="${esc(label)}" data-fade>
        <button class="chip active" data-k="all" aria-pressed="true">All</button>
        ${chips.map(([k, name]) => `<button class="chip" data-k="${esc(k)}" aria-pressed="false">${esc(name)}</button>`).join("")}
      </div>
      <span class="count" aria-live="polite"></span>
    </div></div>`;
  function bindChips(onPick) {
    $$(".filterbar .chip").forEach(b => b.addEventListener("click", () => {
      $$(".filterbar .chip").forEach(x => { x.classList.toggle("active", x === b); x.setAttribute("aria-pressed", x === b); });
      onPick(b.dataset.k);
      // A shorter result would leave a shopper who had scrolled into the grid
      // looking at the footer, as if nothing matched. Bring the first designs
      // back up under the header and filter bar.
      const grid = $("#grid"), fb = $(".filterbar"), head = $("#site-header");
      let moved = false;
      if (grid && fb) {
        const top = Math.max(0, grid.getBoundingClientRect().top + scrollY - fb.offsetHeight - (head ? head.offsetHeight : 0) - 8);
        if (scrollY > top + 1) {
          moved = true;
          if (window.siroyaLenis) window.siroyaLenis.scrollTo(top);
          else scrollTo({ top, behavior: reduce ? "auto" : "smooth" });
        }
      }
      // Keep the picked chip in view (instantly while the page itself scrolls,
      // as two smooth scrolls at once can cancel each other)
      const row = b.parentElement;
      if (row) {
        const l = b.offsetLeft - row.offsetLeft, r = l + b.offsetWidth;
        const left = l < row.scrollLeft ? l - 24 : r > row.scrollLeft + row.clientWidth ? r - row.clientWidth + 40 : null;
        if (left !== null) row.scrollTo({ left, behavior: moved || reduce ? "auto" : "smooth" });
      }
    }));
  }
  const notFound = (title, text) => `
    <section class="pad"><div class="wrap nf">
      <span class="eyebrow">Siroya Jewellers</span>
      <h1>${esc(title)}</h1>
      <p class="lede">${esc(text)}</p>
      <div class="hero-ctas"><a class="btn btn-red" href="collections.html">Explore collections</a><a class="btn btn-line" href="${waGeneral()}" target="_blank" rel="noopener" data-wa="not-found"><i class="ph ph-whatsapp-logo"></i>Ask our team</a></div>
      ${S.categories.length ? `<div class="cats nf-cats" style="--cols:${Math.min(6, S.categories.length)};--cols-t:${Math.min(4, S.categories.length)}">${allCats().map((c, i) => catTile(c, i, false)).join("")}</div>` : ""}
    </div></section>`;

  /* ---------------- Home ---------------- */
  // Balanced rows: 7 tiles become 4 + 3 rather than 6 + 1
  const balance = (n, max) => n <= max ? n : Math.ceil(n / Math.ceil(n / max));
  function home() {
    $("#home-collections").innerHTML = S.collections.map(c => collCard(c)).join("");

    // Featured collection minis: featured designs first, four on phones (2 x 2), three on desktop
    const f = coll("sanskriti") || S.collections[0];
    const pool = f ? S.products.filter(p => p.collection === f.slug) : [];
    // Each photo once: four designs sharing one stand-in photo would read as a
    // broken strip, so the strip waits until at least two have their own
    const seen = new Set();
    const fp = [...pool.filter(p => p.featured), ...pool.filter(p => !p.featured)].filter(p => {
      const k = (p.images || [])[0];
      if (!k || seen.has(k)) return false;
      seen.add(k); return true;
    }).slice(0, 4);
    const mini = $("#feature-products");
    if (fp.length >= 2) {
      mini.dataset.n = fp.length;
      mini.innerHTML = fp.map(p => `<a href="${productUrl(p)}" class="zoom"><div class="frame">${media((p.images || [])[0], p.name)}</div><p>${esc(p.name)}</p></a>`).join("");
    } else mini.remove();

    // Counts in the copy follow the catalog
    const words = ["", "One", "Two", "Three", "Four", "Five", "Six", "Seven", "Eight", "Nine", "Ten", "Eleven", "Twelve"];
    const nc = S.collections.length, ns = S.stores.length, cl = $("#home-coll-lede"), st = $("#home-stores-title");
    if (cl && nc > 1 && words[nc]) cl.textContent = `${words[nc]} houses of design, each with its own story.`;
    if (st && ns) st.textContent = ns === 1 ? "Visit us in Dubai" : words[ns] ? `${words[ns]} stores across Dubai` : "Our stores across Dubai";

    // Find your design: featured categories, any count from 1 to 12
    const cats = featuredCats(), box = $("#home-cats");
    if (!cats.length) { box.closest("section").remove(); }
    else {
      box.style.setProperty("--cols", balance(cats.length, 6));
      box.style.setProperty("--cols-t", balance(cats.length, 4));
      box.classList.toggle("few", cats.length <= 2);
      box.innerHTML = cats.map((c, i) => catTile(c, i)).join("");
    }
    $("#home-stores").innerHTML = storesHTML();
    $("#home-join").innerHTML = joinBlock();
  }
  function storesHTML() {
    return S.stores.map((s, i) => `
      <article class="store rv" style="--i:${i}">
        <div class="frame">${media(s.img, s.name + " storefront 4:3")}</div>
        <h3>${esc(s.name)}</h3>
        <p>${esc(s.address)}${s.hours ? `<br>${esc(s.hours)}` : ""}${s.phone ? `<br><a href="${telHref(s.phone)}">${esc(s.phone)}</a>` : ""}</p>
        <div class="actions">
          ${s.map ? `<a class="link-arrow" href="${esc(s.map)}" target="_blank" rel="noopener">Directions <i class="ph ph-arrow-right"></i></a>` : ""}
          <a class="link-arrow" href="${waLink(`Hello Siroya Jewellers, I would like to visit your ${s.name} store.`)}" target="_blank" rel="noopener" data-wa="store">Book a visit <i class="ph ph-arrow-right"></i></a>
        </div>
      </article>`).join("");
  }

  /* ---------------- Collections index ---------------- */
  // Editorial rhythm for any number of collections: rows of wide + narrow,
  // three narrow, narrow + wide; a single leftover closes as a full-width card.
  function indexLayout(n) {
    const out = [];
    let twos = 0;
    for (let row = 0; out.length < n; row++) {
      const size = Math.min(row % 2 ? 3 : 2, n - out.length);
      if (size === 1) out.push("full");
      else if (size === 2) out.push(...(twos++ % 2 ? ["", "wide"] : ["wide", ""]));
      else out.push("", "", "");
    }
    return out;
  }
  function collectionsIndex() {
    const n = S.collections.length, layout = indexLayout(n);
    // On phones and tablets: two per row, with the first (and an odd last) card full width
    const mFull = i => i === 0 || (i === n - 1 && (n - 1) % 2 === 1);
    $("#c-index").innerHTML = S.collections.map((c, i) => collCard(c, `rv with-desc ${layout[i] || ""}${mFull(i) ? " m-full" : ""}`)).join("");
    $("#c-join").innerHTML = joinBlock();
  }

  /* ---------------- Collection page ---------------- */
  function collection() {
    const c = coll(params.get("c")) || S.collections[0];
    if (!c) { $("#collection").innerHTML = notFound("Collections coming soon", "Our team is preparing this collection. Ask us on WhatsApp what is in store today."); return; }
    document.title = `${c.name} ${c.kind} | Siroya Jewellers`.replace(/\s+/g, " ");
    setMeta(`${c.name} by Siroya Jewellers. ${c.short} Visit our Dubai stores or enquire on WhatsApp.`);
    const items = S.products.filter(p => p.collection === c.slug).sort(bySort);
    const cats = allCats().filter(k => items.some(p => p.category === k.slug));
    const [ch1, ch2] = c.chapters || [];

    $("#collection").innerHTML = `
      <section class="c-hero">
        <div class="hero-media">${c.hero ? `<img src="${esc(c.hero)}" alt="${esc(c.name)} campaign" fetchpriority="high">` : media("", `${c.name} campaign hero, 16:9`, true)}</div>
        <div class="wrap"><div class="hero-copy">
          <span class="tag rv">${esc(c.kind)}</span>
          <h1 class="rv" style="--i:1">${esc(c.name)}</h1>
          <p class="lede rv" style="--i:2">${esc(c.short)}</p>
          <div class="hero-ctas rv" style="--i:3">
            <a class="btn btn-cream" href="#designs">View designs</a>
            <a class="btn btn-line" href="${waLink(`Hello Siroya Jewellers, I am interested in the ${c.name} collection.`)}" target="_blank" rel="noopener" data-wa="collection-hero"><i class="ph ph-whatsapp-logo"></i>Enquire</a>
          </div>
        </div></div>
      </section>

      ${c.intro ? `<section class="pad"><div class="wrap c-intro">
        <hr class="rule-gold rv">
        <p class="big rv">${esc(c.intro)}</p>
      </div></section>` : ""}

      ${ch1 ? `<section class="pad band-paper"><div class="wrap chapter">
        <div class="chapter-media rv"><div class="frame">${media(ch1.img, "Story image, portrait 4:5")}</div></div>
        <div class="chapter-copy">
          <span class="num rv">The story</span>
          <h2 class="rv" style="--i:1">${esc(ch1.title)}</h2>
          <p class="lede rv" style="--i:2">${esc(ch1.text)}</p>
        </div>
      </div></section>` : ""}

      <div class="shop">
        ${filterBar("Filter designs by category", cats.length > 1 ? cats.map(k => [k.slug, k.name]) : [])}
        <section class="pad-sm"><div class="wrap"><div class="grid-products" id="grid"></div></div></section>
      </div>

      ${S.collections.length > 1 ? `<section class="pad band-paper" data-rail>
        <div class="wrap rail-head">
          <h2>More collections</h2>
          <div class="rail-controls"><button data-dir="-1" aria-label="Previous"><i class="ph ph-arrow-left"></i></button><button data-dir="1" aria-label="Next"><i class="ph ph-arrow-right"></i></button></div>
        </div>
        <div class="rail">${S.collections.filter(x => x !== c).map(x => collCard(x)).join("")}</div>
      </section>` : ""}
      <div>${joinBlock()}</div>`;

    // Grid with Zoya-style story breaks between full rows of designs
    const grid = $("#grid"), count = $(".filterbar .count");
    const colsNow = () => gridCols(grid);
    let current = "all", lastCols = 0;
    const breakHTML = flip => `
      <div class="story-break rv ${flip ? "flip" : ""}">
        <div class="frame">${media(ch2?.img || c.cover, "Editorial image, landscape")}</div>
        <div class="quote">${ch2 && !flip ? `<h3>${esc(ch2.title)}</h3><p>${esc(ch2.text)}</p>` : `<p>${esc(c.quote || c.short)}</p><a class="link-arrow" href="about.html">Our story <i class="ph ph-arrow-right"></i></a>`}</div>
      </div>`;
    function render(cat) {
      current = cat;
      const list = cat === "all" ? items : items.filter(p => p.category === cat);
      count.textContent = plural(list.length, "design");
      if (!list.length) {
        const kn = cat === "all" ? "" : (catOf(cat)?.name || "").toLowerCase();
        grid.innerHTML = emptyState(`New ${c.name} designs arrive in store first. Ask our team what is available today.`, `Hello Siroya Jewellers, do you have ${c.name} ${kn} designs available?`.replace(/\s+/g, " "));
        return;
      }
      // Breaks only ever follow a complete row: after one row on a 4-column
      // grid (two rows on narrower grids), then every two rows (four on
      // phones), and never with fewer than two designs left to follow.
      const cols = colsNow();
      lastCols = cols;
      const first = cols >= 4 ? cols : cols * 2, every = cols >= 3 ? cols * 2 : 8;
      let html = "", breaks = 0;
      list.forEach((p, i) => {
        html += productCard(p, i);
        const n = i + 1;
        const due = n === first || (n > first && (n - first) % every === 0);
        if (cat === "all" && due && list.length - n >= Math.min(cols, 2)) html += breakHTML(breaks++ % 2 === 1);
      });
      html += gridFill(list.length, cols, `More ${c.name} designs are waiting in our stores.`, `Hello Siroya Jewellers, I would like to see more ${c.name} designs.`);
      grid.innerHTML = html;
      reveals(grid);
    }
    bindChips(k => { render(k); track("filter_collection", { collection: c.slug, category: k }); });
    render("all");
    // The column count changes at these widths, so the breaks move with it.
    // Only a real change of columns rebuilds the grid (a rebuild resets the
    // reveal state, so a needless one would blank the designs for a moment).
    ["(max-width: 1100px)", "(max-width: 640px)", "(max-width: 339px)"].forEach(q => matchMedia(q).addEventListener?.("change", () => { if (colsNow() !== lastCols) render(current); }));
    track("view_item_list", { item_list_id: c.slug, item_list_name: c.name });
  }

  /* ---------------- Category page ---------------- */
  function category() {
    const root = $("#category");
    const k = catOf(params.get("c"));
    if (!k) {
      document.title = "Shop by category | Siroya Jewellers";
      root.innerHTML = notFound("Find your design", "We could not find that category, but there is plenty to explore. Choose a category below or ask our team on WhatsApp.");
      return;
    }
    document.title = `${k.name} | Siroya Jewellers Dubai`;
    setMeta(`${k.name} by Siroya Jewellers. ${k.description || ""} Visit our Dubai stores or enquire on WhatsApp.`);
    const items = S.products.filter(p => p.category === k.slug).sort(bySort);
    const colls = S.collections.filter(c => items.some(p => p.collection === c.slug));
    const others = allCats().filter(x => x.slug !== k.slug);
    const lname = k.name.toLowerCase();

    root.innerHTML = `
      <section class="cat-hero"><div class="wrap">
        <nav class="crumbs" aria-label="Breadcrumb"><a href="index.html">Home</a><span aria-hidden="true">/</span><a href="collections.html">Jewellery</a><span aria-hidden="true">/</span><span aria-current="page">${esc(k.name)}</span></nav>
        <div class="cat-hero-grid${k.img ? "" : " no-img"}">
          <div class="cat-hero-copy">
            <span class="eyebrow rv">Shop by category</span>
            <h1 class="rv" style="--i:1">${esc(k.name)}</h1>
            ${k.description ? `<p class="lede rv" style="--i:2">${esc(k.description)}</p>` : ""}
            ${items.length ? `<p class="cat-stat rv" style="--i:3">${plural(items.length, "design")}${colls.length > 1 ? ` across ${plural(colls.length, "collection")}` : colls.length ? ` from ${esc(colls[0].name)}` : ""}</p>` : ""}
          </div>
          ${k.img ? `<div class="cat-hero-media rv" style="--i:1"><div class="frame">${media(k.img, k.name)}</div></div>` : ""}
        </div>
      </div></section>

      <div class="shop">
        ${items.length ? filterBar(`Filter ${lname} by collection`, colls.length > 1 ? colls.map(c => [c.slug, c.name]) : []) : ""}
        <section class="pad-sm cat-results"><div class="wrap"><div class="grid-products" id="grid"></div></div></section>
      </div>

      ${others.length ? `<section class="pad band-paper" data-rail>
        <div class="wrap rail-head">
          <h2>Other categories</h2>
          <div class="rail-controls"><button data-dir="-1" aria-label="Previous"><i class="ph ph-arrow-left"></i></button><button data-dir="1" aria-label="Next"><i class="ph ph-arrow-right"></i></button></div>
        </div>
        <div class="rail rail-cats">${others.map((x, i) => catTile(x, i, false)).join("")}</div>
      </section>` : ""}
      <div>${joinBlock()}</div>`;

    const grid = $("#grid"), count = $(".filterbar .count");
    let current = "all", lastCols = 0;
    function render(ck) {
      current = ck;
      const list = ck === "all" ? items : items.filter(p => p.collection === ck);
      if (count) count.textContent = plural(list.length, "design");
      if (!list.length) {
        grid.innerHTML = emptyState(`New designs arrive in our stores first. Tell us what you have in mind and our team will share what is available today.`, `Hello Siroya Jewellers, I am looking for ${lname}. Which designs do you have available?`);
        return;
      }
      const cols = lastCols = gridCols(grid);
      grid.innerHTML = list.map(productCard).join("") + gridFill(list.length, cols, `More ${lname} are waiting in our stores.`, `Hello Siroya Jewellers, I am looking for ${lname}. Which designs do you have available?`);
      reveals(grid);
    }
    bindChips(ck => { render(ck); track("filter_category", { category: k.slug, collection: ck }); });
    render("all");
    // The closing tile follows the column count
    ["(max-width: 1100px)", "(max-width: 640px)", "(max-width: 339px)"].forEach(q => matchMedia(q).addEventListener?.("change", () => { if (gridCols(grid) !== lastCols) render(current); }));
    track("view_item_list", { item_list_id: `category-${k.slug}`, item_list_name: k.name });
  }

  /* ---------------- Product page ---------------- */
  function product() {
    const p = S.products.find(x => x.id === params.get("p")) || (params.get("p") ? null : S.products[0]);
    if (!p) {
      document.title = "Design not found | Siroya Jewellers";
      $("#product").innerHTML = notFound("This design has moved", "It may have found its new home already. Explore our collections, or ask our team for something similar.");
      return;
    }
    const k = catOf(p.category);
    const c = coll(p.collection) || { slug: "", name: k ? k.name : "Siroya Jewellers", kind: "", short: "", intro: "" };
    const cUrl = c.slug ? collUrl(c) : k ? catUrl(k) : "collections.html";
    document.title = `${p.name} | ${c.name} | Siroya Jewellers`;
    setMeta(`${p.name}${p.metal ? ` in ${p.metal}` : ""}${c.slug ? ` from the ${c.name} collection` : ""} by Siroya Jewellers, Dubai. Enquire on WhatsApp for price and availability.`);
    const imgs = (p.images || []).length ? p.images : [""];
    const related = S.products.filter(x => x.id !== p.id && (c.slug ? x.collection === c.slug : x.category === p.category)).sort(bySort).slice(0, 4);
    const specs = [["Collection", c.slug ? c.name : ""], ["Category", k?.name], ["Metal", p.metal], ["Weight", p.weight || "On request"], ["Stones", p.stones], ["Design code", p.code]].filter(([, v]) => v);
    const desc = (p.description || "").trim();
    // Short descriptions sit under the title; long ones live in Design details
    const lede = desc && desc.length <= 220 ? desc : c.short;

    $("#product").innerHTML = `
      <div class="wrap">
        <nav class="crumbs" aria-label="Breadcrumb"><a href="index.html">Home</a><span aria-hidden="true">/</span>${c.slug ? `<a href="${cUrl}">${esc(c.name)}</a><span aria-hidden="true">/</span>` : k ? `<a href="${catUrl(k)}">${esc(k.name)}</a><span aria-hidden="true">/</span>` : ""}<span aria-current="page">${esc(p.name)}</span></nav>
        <div class="pdp">
          <div class="gallery${imgs.length < 2 ? " single" : ""}">
            <div class="thumbs">${imgs.map((src, i) => `<button class="${i ? "" : "active"}" data-i="${i}" aria-label="View image ${i + 1}">${src ? `<img src="${esc(src)}" alt="">` : media("", String(i + 1))}</button>`).join("")}</div>
            <div class="frame main-shot" id="main-shot">${imgs[0] ? `<img src="${esc(imgs[0])}" alt="${esc(p.name)}, product photo" fetchpriority="high">` : media("", p.name + ", product photo 4:5")}</div>
            <div class="swipe" aria-roledescription="carousel" aria-label="${esc(p.name)} photos">
              <div class="swipe-track" tabindex="0">${imgs.map((src, i) => `<div class="frame" role="group" aria-label="Photo ${i + 1} of ${imgs.length}">${src ? `<img src="${esc(src)}" alt="${i ? "" : esc(p.name)}"${i ? ' loading="lazy"' : ""} decoding="async">` : media("", "Product photo")}</div>`).join("")}</div>
              ${imgs.length > 1 ? `<div class="swipe-dots" aria-hidden="true">${imgs.map((_, i) => `<span class="${i ? "" : "on"}"></span>`).join("")}</div>` : ""}
            </div>
          </div>

          <div class="pdp-info">
            <a class="coll-link" href="${cUrl}"><span>${esc(c.name)}</span>${c.kind ? `<span class="kind">${esc(c.kind)}</span>` : ""}</a>
            <h1>${esc(p.name)}</h1>
            ${lede ? `<p class="lede">${esc(lede)}</p>` : ""}
            <div class="specs">${specs.map(([key, v]) => `<div class="spec"><small>${esc(key)}</small><b>${esc(v)}</b></div>`).join("")}</div>

            <div class="lead" id="lead">
              <div><h2>Enquire on WhatsApp</h2><p class="sub">Price, availability and a video call from the store. Our team usually replies within the hour.</p></div>
              <form novalidate>
                <div style="display:grid;gap:14px">
                  <div class="field"><label for="f-name">Your name</label><input id="f-name" name="name" autocomplete="name" required><span class="err">Please tell us your name.</span></div>
                  <div class="field"><label for="f-phone">Mobile number</label>
                    <div class="phone-row">
                      <select id="f-cc" name="cc" aria-label="Country code">
                        ${[["+971", "UAE"], ["+91", "India"], ["+966", "KSA"], ["+968", "Oman"], ["+974", "Qatar"], ["+973", "Bahrain"], ["+965", "Kuwait"], ["+44", "UK"], ["+1", "US/CA"]].map(([v, n]) => `<option value="${v}">${v} ${n}</option>`).join("")}
                      </select>
                      <input id="f-phone" name="phone" type="tel" inputmode="tel" autocomplete="tel-national" required>
                    </div><span class="err">Please enter a valid mobile number.</span></div>
                  <div class="row-2">
                    <div class="field"><label for="f-store">Preferred store</label><select id="f-store" name="store"><option value="">Any store</option>${S.stores.map(s => `<option>${esc(s.name)}</option>`).join("")}</select></div>
                    <div class="field"><label for="f-when">Best time</label><select id="f-when" name="when"><option>Any time</option><option>Morning</option><option>Afternoon</option><option>Evening</option></select></div>
                  </div>
                  <button class="btn btn-red" type="submit"><i class="ph ph-whatsapp-logo"></i>Send enquiry</button>
                  <p class="fine">Opens WhatsApp with your enquiry ready to send. No payment needed.</p>
                </div>
              </form>
              <div class="lead-ok" role="status">
                <i class="ph ph-check-circle"></i>
                <h3>Thank you</h3>
                <p class="sub">Your enquiry is ready in WhatsApp. If it did not open, use the button below.</p>
                <a class="link-arrow" id="wa-again" target="_blank" rel="noopener">Open WhatsApp <i class="ph ph-arrow-right"></i></a>
              </div>
            </div>

            <div class="assure">
              <div><i class="ph ph-seal-check"></i>Certified gold and diamonds</div>
              <div><i class="ph ph-arrows-clockwise"></i>Clear exchange and buyback</div>
              <div><i class="ph ph-users-three"></i>Family jewellers since 1976</div>
            </div>

            <div class="acc">
              <details open><summary>Design details <i class="ph ph-plus"></i></summary><div class="body prose">${esc(desc || [c.slug ? `From the ${c.name} collection.` : "", c.intro].join(" ").trim() || "Ask our team for weight, stones and finish details.")}</div></details>
              <details><summary>Exchange and buyback <i class="ph ph-plus"></i></summary><div class="body">Clear, written policies on exchange and buyback. Our team will explain every term before you choose.</div></details>
              <details><summary>Visit or video call <i class="ph ph-plus"></i></summary><div class="body">See this design at any of our Dubai stores, or ask for a live video call on WhatsApp.</div></details>
            </div>
          </div>
        </div>
      </div>

      ${related.length ? `<section class="pad-sm band-paper"><div class="wrap">
        <div class="rail-head"><h2>More from ${esc(c.name)}</h2><a class="link-arrow" href="${cUrl}">View ${c.slug ? "collection" : "all"} <i class="ph ph-arrow-right"></i></a></div>
        <div class="grid-products related">${related.map(productCard).join("")}</div>
      </div></section>` : ""}

      <div class="sticky-cta"><a class="btn btn-red" href="#lead"><i class="ph ph-whatsapp-logo"></i>Enquire on WhatsApp</a></div>`;
    document.body.classList.add("has-sticky");

    // The sticky enquiry bar (phones and tablets) shows from the first screen,
    // so there is always something to tap. It steps aside while the enquiry
    // form itself, or the footer (with its own WhatsApp button), is on screen.
    const bar = $(".sticky-cta");
    // The bar brings the whole enquiry card into view below the sticky header
    // (#lead has a scroll margin) and moves focus to it, without opening the
    // phone keyboard
    const leadBox = $("#lead");
    leadBox.tabIndex = -1;
    $("a", bar).addEventListener("click", e => {
      e.preventDefault();
      if (window.siroyaLenis) window.siroyaLenis.scrollTo(leadBox, { offset: -(($("#site-header")?.offsetHeight || 64) + 12) });
      else leadBox.scrollIntoView({ behavior: reduce ? "auto" : "smooth", block: "start" });
      leadBox.focus({ preventScroll: true });
    });
    let formInView = false, footInView = false;
    const updBar = () => bar.classList.toggle("away", formInView || footInView);
    updBar();
    if ("IntersectionObserver" in window) {
      new IntersectionObserver(([e]) => { formInView = e.isIntersecting; updBar(); }, { threshold: 0.15 }).observe($("#lead"));
      const foot = $("#site-footer");
      if (foot) new IntersectionObserver(([e]) => { footInView = e.isIntersecting; updBar(); }).observe(foot);
    }

    // Phone gallery: swipe between photos, dots follow
    const track_ = $(".swipe-track"), dots = $$(".swipe-dots span");
    if (track_ && dots.length) track_.addEventListener("scroll", () => {
      const i = Math.round(track_.scrollLeft / Math.max(1, track_.clientWidth));
      dots.forEach((d, k) => d.classList.toggle("on", k === i));
    }, { passive: true });

    // Gallery
    const main = $("#main-shot");
    $$(".thumbs button").forEach(b => b.addEventListener("click", () => {
      $$(".thumbs button").forEach(x => x.classList.toggle("active", x === b));
      main.innerHTML = media(imgs[b.dataset.i], p.name + ", product photo 4:5");
    }));
    main.addEventListener("mousemove", e => {
      const img = $("img", main); if (!img || reduce || !matchMedia("(hover:hover)").matches) return;
      const r = main.getBoundingClientRect();
      img.style.transformOrigin = `${((e.clientX - r.left) / r.width) * 100}% ${((e.clientY - r.top) / r.height) * 100}%`;
      img.style.transform = "scale(1.8)";
    });
    main.addEventListener("mouseleave", () => { const img = $("img", main); if (img) img.style.transform = ""; });

    // Lead capture
    const form = $("#lead form"), box = $("#lead");
    form.addEventListener("submit", e => {
      e.preventDefault();
      const name = form.name.value.trim(), phone = form.phone.value.replace(/[^\d]/g, "");
      const fName = form.name.closest(".field"), fPhone = form.phone.closest(".field");
      fName.classList.toggle("invalid", !name);
      fPhone.classList.toggle("invalid", phone.length < 7 || phone.length > 13);
      if (!name || phone.length < 7 || phone.length > 13) { $(".invalid input", form)?.focus(); return; }

      const attr = getAttribution();
      const lead = {
        name, phone: `${form.cc.value} ${phone}`, store: form.store.value || "Any store", when: form.when.value,
        product: p.name, code: p.code, collection: c.name, url: location.href.split("?")[0] + `?p=${encodeURIComponent(p.id)}`, ...attr
      };
      const msg = [
        `Hello Siroya Jewellers, I am interested in this design:`,
        `${p.name}${p.code ? ` (${p.code})` : ""}${c.slug ? `, ${c.name} collection` : ""}`,
        lead.url,
        ``,
        `Name: ${name}`,
        `Mobile: ${lead.phone}`,
        `Preferred store: ${lead.store}`,
        `Best time: ${lead.when}`,
        attr.utm_campaign ? `Ref: ${attr.utm_campaign}` : ""
      ].filter((l, i, a) => l !== "" || a[i - 1] !== "").join("\n").trim();
      const url = waLink(msg);

      track("generate_lead", { lead_source: "product_whatsapp", item_id: p.code, item_name: p.name, item_list_name: c.name, ...attr });
      // Keep a copy of every lead on our server (admin > Enquiries). Always attempted; on plain static
      // hosting the request simply fails and WhatsApp still opens. text/plain keeps it a simple request,
      // keepalive lets it finish while WhatsApp opens; sendBeacon is the fallback for older browsers.
      saveLead(lead);

      $("#wa-again").href = url;
      box.classList.add("done");
      window.open(url, "_blank", "noopener");
    });
    track("view_item", { item_id: p.code, item_name: p.name, item_list_name: c.name });
  }

  /* ---------------- About page ---------------- */
  function about() {
    $("#about-stores").innerHTML = storesHTML();
    $("#about-join").innerHTML = joinBlock();

    // Manifesto: words light up as the paragraph scrolls through
    const man = $(".manifesto p");
    if (man) {
      man.innerHTML = man.textContent.trim().split(/\s+/).map(w => `<span class="w">${esc(w)}</span>`).join(" ");
      const words = $$(".w", man);
      if (!reduce) {
        const io = new IntersectionObserver(es => es.forEach(e => e.target.classList.toggle("on", e.isIntersecting)), { rootMargin: "0px 0px -45% 0px" });
        words.forEach(w => io.observe(w));
      }
    }

    // Pillars: one active at a time, image follows
    const pillars = $$(".pillar"), pImg = $("#pillar-img");
    const pio = new IntersectionObserver(es => es.forEach(e => {
      if (!e.isIntersecting) return;
      pillars.forEach(x => x.classList.toggle("on", x === e.target));
      if (pImg) pImg.innerHTML = media(e.target.dataset.img, e.target.dataset.label);
    }), { rootMargin: "-45% 0px -45% 0px" });
    pillars.forEach(x => pio.observe(x));

    storyDialog();

    // Opening headline line reveal + pinned horizontal timeline (GSAP)
    const tl = $(".timeline");
    const canPin = window.gsap && window.ScrollTrigger && !reduce && matchMedia("(min-width: 900px)").matches;
    if (window.gsap && !reduce) {
      gsap.from(".a-open h1 .line > span", { yPercent: 110, duration: 1.2, ease: "expo.out", stagger: 0.12, delay: 0.1 });
      gsap.from(".a-open .lede, .a-open .btn", { opacity: 0, y: 16, duration: 1, ease: "expo.out", delay: 0.6, stagger: 0.1 });
    }
    if (!canPin) { tl.classList.add("static"); return; }
    gsap.registerPlugin(ScrollTrigger);
    const track_ = $(".tl-track", tl);
    const dist = () => track_.scrollWidth - innerWidth;
    gsap.to(track_, {
      x: () => -dist(), ease: "none",
      scrollTrigger: { trigger: tl, start: () => `top ${$("#site-header").offsetHeight}px`, end: () => "+=" + dist(), pin: true, scrub: 1, invalidateOnRefresh: true,
        onUpdate: s => { $(".tl-progress span", tl).style.transform = `scaleX(${s.progress})`; } }
    });
    gsap.from(".a-open .year-ghost", { yPercent: 30, ease: "none", scrollTrigger: { trigger: ".a-open", start: "top top", end: "bottom top", scrub: true } });
  }

  /* Chapter reader: each timeline card carries its full story in a hidden
     .tl-story block (kept in the HTML for search engines). "Read the story"
     opens it in a dialog with the archive photo, with prev / next. */
  function storyDialog() {
    const items = $$(".tl-item");
    if (!items.length) return;
    const dlg = document.createElement("dialog");
    dlg.className = "story-dialog";
    dlg.setAttribute("aria-labelledby", "sd-title");
    dlg.innerHTML = `
      <div class="sd-grid">
        <div class="sd-media"></div>
        <div class="sd-body">
          <div class="sd-top"><span class="sd-count"></span><button class="icon-btn sd-close" aria-label="Close story"><i class="ph ph-x"></i></button></div>
          <div class="sd-year gold-text"></div>
          <h2 id="sd-title"></h2>
          <div class="sd-text"></div>
          <div class="sd-nav">
            <button class="btn btn-line sd-prev"><i class="ph ph-arrow-left"></i>Previous</button>
            <button class="btn btn-red sd-next">Next chapter<i class="ph ph-arrow-right"></i></button>
          </div>
        </div>
      </div>`;
    document.body.appendChild(dlg);
    let cur = 0;
    const show = i => {
      cur = (i + items.length) % items.length;
      const it = items[cur], img = $("img", it);
      const typeFrame = $(".tl-type", it), sm = $(".sd-media", dlg);
      sm.classList.toggle("type", !img && !!typeFrame);
      sm.innerHTML = img ? `<img src="${img.getAttribute("src")}" alt="${esc(img.alt)}">` : (typeFrame ? typeFrame.innerHTML : "");
      $(".sd-year", dlg).textContent = $(".tl-year", it).textContent;
      $("#sd-title", dlg).textContent = $("h3", it).textContent;
      $(".sd-text", dlg).innerHTML = ($(".tl-story", it) || $("p", it)).innerHTML;
      $(".sd-count", dlg).textContent = `Chapter ${cur + 1} of ${items.length}`;
      $(".sd-prev", dlg).disabled = cur === 0;
      $(".sd-next", dlg).innerHTML = cur === items.length - 1 ? 'Close<i class="ph ph-x"></i>' : 'Next chapter<i class="ph ph-arrow-right"></i>';
      $(".sd-body", dlg).scrollTop = 0;
      dlg.classList.remove("swap"); void dlg.offsetWidth; dlg.classList.add("swap");
    };
    items.forEach((it, i) => {
      const b = $(".tl-more", it);
      if (b) b.addEventListener("click", () => { show(i); dlg.showModal(); track("story_open", { chapter: $(".tl-year", it).textContent.trim() }); });
    });
    $(".sd-close", dlg).addEventListener("click", () => dlg.close());
    $(".sd-prev", dlg).addEventListener("click", () => show(cur - 1));
    $(".sd-next", dlg).addEventListener("click", () => cur === items.length - 1 ? dlg.close() : show(cur + 1));
    dlg.addEventListener("click", e => { if (e.target === dlg) dlg.close(); });
    dlg.addEventListener("keydown", e => {
      if (e.key === "ArrowRight" && cur < items.length - 1) show(cur + 1);
      if (e.key === "ArrowLeft" && cur > 0) show(cur - 1);
    });
  }

  /* ---------------- Boot ----------------
     Header and footer render straight away from data.js. The page body waits
     for the live catalog (Node server, /api/catalog) for up to 2.5 s, then
     renders; on static hosting the request fails fast and data.js is used. */
  async function loadCatalog() {
    if (!window.fetch || location.protocol === "file:") return false;
    const ctl = window.AbortController ? new AbortController() : null;
    const timer = setTimeout(() => ctl && ctl.abort(), 2500);
    try {
      const r = await fetch("/api/catalog", { cache: "no-store", headers: { Accept: "application/json" }, signal: ctl ? ctl.signal : undefined });
      if (!r.ok || !/json/.test(r.headers.get("content-type") || "")) return false;
      const d = await r.json();
      if (!d || !Array.isArray(d.collections) || !Array.isArray(d.products)) return false;
      S.site = Object.assign({}, S.site, d.site || {});
      ["categories", "collections", "products", "stores"].forEach(k => { if (Array.isArray(d[k])) S[k] = d[k]; });
      return true;
    } catch (e) {
      return false;
    } finally {
      clearTimeout(timer);
    }
  }
  const karat = v => typeof v === "string" ? v.replace(/\b(\d{1,2})k\b/g, "$1K") : v;
  // The seed catalog gives every design the same temporary ring photo. Until
  // real photos are uploaded in the admin, designs outside Rings show their
  // category's photo instead, so a necklace never appears as a ring.
  const TEMP_PHOTO = /^assets\/img\/products\/ring-[12]\.jpg$/;
  function normalise() {
    S.products.forEach(p => {
      if (!Array.isArray(p.images)) p.images = [];
      p.id = String(p.id ?? p.handle ?? ""); p.metal = karat(p.metal);
      if (p.category !== "rings" && p.images.length && p.images.every(src => TEMP_PHOTO.test(src))) {
        const k = catOf(p.category);
        p.images = k && k.img ? [k.img] : [];
      }
    });
    S.collections.forEach(c => { if (!Array.isArray(c.chapters)) c.chapters = []; c.short = karat(c.short); c.intro = karat(c.intro); });
  }

  // A missing or mistyped image path shows the soft brand placeholder rather
  // than a broken-image icon (hover shots simply step aside).
  document.addEventListener("error", e => {
    const img = e.target;
    if (!(img instanceof HTMLImageElement) || img.dataset.failed) return;
    const box = img.closest(".frame, .thumbs button");
    if (!box) return;
    img.dataset.failed = "1";
    img.style.display = "none";
    if (!img.classList.contains("alt") && !box.querySelector(":scope > .slot")) box.insertAdjacentHTML("beforeend", '<div class="slot" aria-hidden="true"></div>');
  }, true);

  normalise();
  header(); footer(); floatingWA();
  loadCatalog().then(live => {
    if (live) { normalise(); navLists(); footer(); }
    document.documentElement.dataset.catalog = live ? "live" : "static";
    try {
      ({ home, collections: collectionsIndex, collection, category, product, about }[page] || (() => {}))();
    } catch (e) {
      console.error(e);
    }
    rails(); reveals(); countUp(); fades(); waAvoid();
  });
})();
