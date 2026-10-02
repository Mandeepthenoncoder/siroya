/* Contact page (contact.html). Keeps the three contact cards in step with
   the live site details and renders the stores once site.js has loaded the
   catalog (it sets html[data-catalog] when done). Styles: contact.css. */
(function () {
  "use strict";
  const S = window.SIROYA;
  if (!S) return;
  const root = document.documentElement;
  const $ = (q, el = document) => el.querySelector(q);
  const $$ = (q, el = document) => [...el.querySelectorAll(q)];
  const reduce = matchMedia("(prefers-reduced-motion: reduce)").matches;

  const esc = s => String(s ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  const telHref = phone => `tel:${String(phone).replace(/[^\d+]/g, "")}`;
  const waNumber = () => String((S.site && S.site.whatsapp) || "").replace(/\D/g, "");
  const waLink = text => `https://wa.me/${waNumber()}?text=${encodeURIComponent(text)}`;
  // 971565006398 -> +971 56 500 6398
  function waDisplay(d) {
    if (/^971\d{9}$/.test(d)) return `+971 ${d.slice(3, 5)} ${d.slice(5, 8)} ${d.slice(8)}`;
    return d ? `+${d}` : "";
  }

  /* Reveal: content added after site.js ran its own reveal pass */
  let io = null;
  function reveal(scope) {
    const els = $$(".rv:not(.in)", scope || $("#contact") || document);
    if (reduce || !("IntersectionObserver" in window)) { els.forEach(e => e.classList.add("in")); return; }
    if (!io) io = new IntersectionObserver(entries => entries.forEach(en => {
      if (en.isIntersecting) { en.target.classList.add("in"); io.unobserve(en.target); }
    }), { rootMargin: "0px 0px -6% 0px", threshold: 0.06 });
    els.forEach(e => {
      const r = e.getBoundingClientRect();
      if (r.top < innerHeight && r.bottom > 0) requestAnimationFrame(() => e.classList.add("in"));
      else io.observe(e);
    });
  }

  /* Contact cards: follow site details from the catalog, hide any that are empty */
  function syncActions() {
    const s = S.site || {};
    const set = (key, href, value) => {
      const a = $(`.ct-act[data-act="${key}"]`);
      if (!a) return;
      if (!value) { a.hidden = true; return; }
      a.hidden = false;
      a.href = href;
      const v = $("[data-val]", a);
      if (v) v.textContent = value;
    };
    const wa = waNumber();
    set("whatsapp", waLink("Hello Siroya Jewellers, I would like some help from your team."), wa && waDisplay(wa));
    set("phone", s.phone ? telHref(s.phone) : "", s.phone || "");
    set("email", s.email ? `mailto:${s.email}` : "", s.email || "");
  }

  /* Stores */
  function storeCard(st, i) {
    const name = esc(st.name);
    const img = st.img
      ? `<img src="${esc(st.img)}" alt="${name} store front, Siroya Jewellers" loading="lazy" decoding="async">`
      : `<div class="slot">${name}</div>`;
    return `
      <article class="ct-store rv" style="--i:${i % 2}">
        <div class="frame ct-store-media">${img}</div>
        <div class="ct-store-body">
          <h3>${name}</h3>
          <ul class="ct-store-info">
            ${st.address ? `<li><i class="ph ph-map-pin" aria-hidden="true"></i><span>${esc(st.address)}</span></li>` : ""}
            ${st.hours ? `<li><i class="ph ph-clock" aria-hidden="true"></i><span>${esc(st.hours)}</span></li>` : ""}
            ${st.phone ? `<li class="tel"><i class="ph ph-phone" aria-hidden="true"></i><a href="${telHref(st.phone)}" aria-label="Call ${name}, ${esc(st.phone)}">${esc(st.phone)}</a></li>` : ""}
          </ul>
          <div class="ct-store-acts">
            ${st.map ? `<a class="ct-btn ct-btn-line" href="${esc(st.map)}" target="_blank" rel="noopener" aria-label="Directions to ${name}, opens Google Maps"><i class="ph ph-navigation-arrow" aria-hidden="true"></i>Directions</a>` : ""}
            ${waNumber() ? `<a class="ct-btn ct-btn-red" href="${waLink(`Hello Siroya Jewellers, I would like to book a visit to your ${st.name} store.`)}" target="_blank" rel="noopener" data-wa="contact-store" aria-label="Book a visit to ${name} on WhatsApp"><i class="ph ph-whatsapp-logo" aria-hidden="true"></i>Book a visit</a>` : ""}
          </div>
        </div>
      </article>`;
  }
  function renderStores() {
    const box = $("#ct-stores");
    if (!box) return;
    const stores = Array.isArray(S.stores) ? S.stores : [];
    box.innerHTML = stores.length
      ? stores.map(storeCard).join("")
      : `<p class="ct-empty">Message us on <a href="${waLink("Hello Siroya Jewellers, which of your stores is nearest to me?")}" target="_blank" rel="noopener" data-wa="contact-store">WhatsApp</a> and we will guide you to our nearest store.</p>`;
    box.dataset.n = stores.length;
    box.removeAttribute("aria-busy");
  }

  function ready() {
    try {
      syncActions();
      renderStores();
    } catch (e) {
      console.error(e);
    }
    reveal();
  }

  // Cards and static blocks reveal straight away; stores wait for the catalog
  reveal();
  if (root.dataset.catalog) ready();
  else {
    const mo = new MutationObserver(() => {
      if (!root.dataset.catalog) return;
      mo.disconnect();
      ready();
    });
    mo.observe(root, { attributes: true, attributeFilter: ["data-catalog"] });
  }
})();
