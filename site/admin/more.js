/* Siroya admin: stores, leads and site settings. */
import { $, h, fill, icon, iconBtn, api, listOf, itemOf, normStore, invalidate, go, toast, toastError, confirmDialog,
  pageHead, emptyState, errorState, skeletonList, skeletonForm, field, card, editFrame, wireForm, checkAll, slugify, SLUG_RE,
  plural, fmtDate, fmtTime, isOld, timeAgo, digits, safeHref } from "./lib.js";
import { imageField } from "./media.js";
import { orderList, thumbEl } from "./catalog.js";

/* ======================= Stores ======================= */
export async function storesList(ctx) {
  const newBtn = h("a", { class: "btn btn-primary", href: "#/stores/new", "aria-label": "New store" }, icon("plus"), h("span", null, "New", h("span", { class: "hide-phone", text: " store" })));
  const box = h("div", { class: "list-box" }, skeletonList(4));
  ctx.root.append(pageHead({ title: "Stores", subtitle: "Shown on the homepage and offered as a choice in WhatsApp enquiries, in this order.", actions: [newBtn] }), box);
  async function load() {
    try {
      const stores = listOf(await api("/stores"), "stores").map(normStore).sort((a, b) => a.sort - b.sort);
      if (!ctx.alive()) return;
      if (!stores.length) {
        box.replaceChildren(emptyState({ icon: "storefront", title: "No stores yet", text: "Add your showrooms so shoppers can choose where to visit.", action: { label: "Add a store", icon: "plus", href: "#/stores/new" } }));
        return;
      }
      const ol = orderList({
        items: stores, endpoint: "/stores", label: "Stores in site order", noun: "store",
        rowParts: s => ({
          thumb: thumbEl(s.image, "4 / 3"),
          main: h("div", { class: "o-main" },
            h("a", { class: "o-name", href: `#/stores/${s.id}`, text: s.name }),
            h("span", { class: "muted small ellip", text: [s.address, s.phone].filter(Boolean).join("  ·  ") || "No address yet" })),
          actions: [
            h("a", { class: "icon-btn", href: `#/stores/${s.id}`, "aria-label": `Edit ${s.name}`, title: "Edit" }, icon("pencil-simple")),
            iconBtn("trash", `Delete ${s.name}`, async () => { if (await deleteStore(s)) { ol.remove(s.id); if (!ol.items().length) load(); } }, { class: "danger" })]
        })
      });
      box.replaceChildren(ol.el);
    } catch (e) { if (ctx.alive() && e.status !== 401) box.replaceChildren(errorState(e, load)); }
  }
  await load();
}
async function deleteStore(s) {
  if (!(await confirmDialog({ title: `Delete ${s.name}?`, message: "This store will be removed from the website and from the store choice in enquiries. Past leads keep the store name. This cannot be undone.", confirmLabel: "Delete store", danger: true, icon: "trash" }))) return false;
  try { await api(`/stores/${s.id}`, { method: "DELETE" }); invalidate("stores"); toast(`${s.name} deleted`); return true; }
  catch (e) { toastError(e); return false; }
}

export async function storeEdit(ctx) {
  const id = ctx.params[0], isNew = id === "new";
  ctx.root.append(pageHead({ title: isNew ? "New store" : "Loading store", back: { href: "#/stores", label: "Stores" } }), skeletonForm());
  let store;
  if (isNew) store = normStore({ name: "", slug: "" });
  else {
    store = listOf(await api("/stores"), "stores").map(normStore).find(s => String(s.id) === id);
    if (!store) throw Object.assign(new Error("We could not find that store. It may have been deleted."), { status: 404 });
  }
  if (!ctx.alive()) return;
  ctx.setTitle(isNew ? "New store" : store.name);

  const slugAuto = { on: isNew };
  const name = field({ label: "Store name", name: "name", required: true, maxlength: 80, value: store.name, placeholder: "e.g. Meena Bazaar", validate: v => v.trim() ? "" : "Enter the store name." });
  const slug = field({ label: "Short name", name: "slug", maxlength: 60, value: store.slug, spellcheck: "false", hint: "Used internally. Lowercase letters, numbers and hyphens.", validate: v => !v || SLUG_RE.test(v) ? "" : "Use lowercase letters, numbers and single hyphens." });
  const address = field({ label: "Address", name: "address", type: "textarea", rows: 3, maxlength: 300, value: store.address, placeholder: "e.g. Cosmo Lane, Meena Bazaar, Al Fahidi, Bur Dubai" });
  const hours = field({ label: "Opening hours", name: "hours", maxlength: 160, value: store.hours, placeholder: "e.g. Daily 10am to 10pm, Friday from 4pm", optional: true });
  const phone = field({ label: "Phone", name: "phone", type: "tel", maxlength: 40, value: store.phone, placeholder: "e.g. +971 4 225 4254", optional: true, autocomplete: "off" });
  const map = field({ label: "Google Maps link", name: "map", type: "url", maxlength: 500, value: store.map, placeholder: "https://maps.google.com/...", optional: true, inputmode: "url",
    hint: "Open the store in Google Maps, tap Share, and paste the link here.",
    validate: v => !v || /^https?:\/\/\S+\.\S+/i.test(v) ? "" : "Paste the full link, starting with https://" });
  map.input.addEventListener("blur", () => { const v = map.value().trim(); if (v && !/^https?:\/\//i.test(v) && /\.\w/.test(v)) { map.set("https://" + v); map.check(); } });
  const image = imageField({ label: "Store photo", value: store.image, ratio: "4 / 3", slotLabel: "Store photo 4:3", hint: "Landscape 4:3. The storefront or the showroom inside.", onChange: () => wf.update() });
  name.input.addEventListener("input", () => { if (slugAuto.on) slug.set(slugify(name.value())); });
  slug.input.addEventListener("input", () => { slugAuto.on = isNew && !slug.value(); });
  slug.input.addEventListener("blur", () => { const v = slug.value().trim(); if (v && !SLUG_RE.test(v)) { slug.set(slugify(v)); slug.check(); } });

  const mapLink = h("a", { class: "btn btn-secondary", target: "_blank", rel: "noopener noreferrer" }, icon("map-pin"), h("span", { text: "Open map" }));
  const fr = editFrame({ formId: "store-form", isNew, title: isNew ? "New store" : store.name, back: { href: "#/stores", label: "Stores" }, createLabel: "Create store", actions: [mapLink] });
  const form = h("form", { id: "store-form", class: "edit-grid", novalidate: true },
    h("div", { class: "col" }, card("Details", h("div", { class: "grid-2" }, name.wrap, slug.wrap), address.wrap, h("div", { class: "grid-2" }, hours.wrap, phone.wrap), map.wrap)),
    h("div", { class: "col col-side" }, card("Photo", image.el),
      isNew ? null : h("section", { class: "card card-quiet" }, h("button", { type: "button", class: "btn btn-danger-ghost btn-block", onclick: async () => { if (await deleteStore(store)) { ctx.isDirty = () => false; go("#/stores"); } } }, icon("trash"), "Delete store"))));
  ctx.root.replaceChildren(fr.head, form, fr.savebar);
  const paint = () => { const u = safeHref(map.value().trim()); mapLink.hidden = !/^https?:/i.test(u); if (u) mapLink.href = u; };
  const values = () => ({ name: name.value().trim(), slug: slug.value().trim(), address: address.value().trim(), hours: hours.value().trim(), phone: phone.value().trim(), map: map.value().trim(), image: image.value() });
  const wf = wireForm(ctx, form, {
    values, isNew, ss: fr.ss, busy: image.busy, onUpdate: paint,
    save: async () => {
      if (!checkAll([name, slug, map])) return false;
      const body = values();
      let r;
      try { r = isNew ? await api("/stores", { method: "POST", body }) : await api(`/stores/${id}`, { method: "PUT", body }); }
      catch (e) { if (e.status === 409) slug.error(e.message); throw e; }
      const out = normStore({ ...store, ...body, ...(itemOf(r, "store") || {}) });
      invalidate("stores");
      if (isNew) {
        ctx.isDirty = () => false;
        toast(`${out.name} created`);
        go(out.id != null ? `#/stores/${out.id}` : "#/stores", { replace: true });
        return true;
      }
      store = out; if (out.slug !== slug.value()) slug.set(out.slug);
      fr.setTitle(out.name); ctx.setTitle(out.name);
      toast("Saved");
      return true;
    }
  });
}

/* ======================= Leads ======================= */
const LEADS_PER = 25;

/** Phone as a tel: link plus a WhatsApp button. */
export function leadContact(l, compact = false) {
  const raw = String(l.phone || "").trim();
  const d = digits(raw);
  if (d.length < 6) return h("span", { class: "muted", text: raw || "No number" });
  return h("span", { class: ["contact", compact && "compact"] },
    compact ? null : h("a", { class: "tel", href: `tel:+${d}`, text: raw }),
    h("a", { class: "icon-btn wa", href: `https://wa.me/${d}`, target: "_blank", rel: "noopener noreferrer", "aria-label": `WhatsApp ${l.name || raw}`, title: "Open in WhatsApp" }, icon("whatsapp-logo")),
    compact ? h("a", { class: "icon-btn", href: `tel:+${d}`, "aria-label": `Call ${l.name || raw}`, title: "Call" }, icon("phone")) : null);
}
function sourceOf(l) {
  const ads = l.gclid || l.gbraid || l.wbraid;
  const camp = l.utm_campaign || "";
  const src = [l.utm_source, l.utm_medium].filter(Boolean).join(" / ");
  return h("div", { class: "src" },
    ads ? h("span", { class: "chip chip-ads" }, icon("google-logo"), "Google Ads") : null,
    camp ? h("span", { class: "src-camp", text: camp }) : null,
    !ads && !camp ? h("span", { class: "muted small", text: src || "Direct" }) : (src && !ads ? h("span", { class: "muted small", text: src }) : null));
}
export async function leadsView(ctx) {
  let page = Math.max(1, parseInt(ctx.query.page, 10) || 1);
  const exportBtn = h("a", { class: "btn btn-secondary", href: "/api/admin/leads.csv", download: "" }, icon("file-csv"), h("span", { text: "Export CSV" }));
  const box = h("div", { class: "list-box" }, skeletonList(8));
  const pager = h("nav", { class: "pager", "aria-label": "Pages" });
  ctx.root.append(pageHead({ title: "Leads", subtitle: "WhatsApp enquiries sent from product pages, newest first.", actions: [exportBtn] }), box, pager);
  async function load() {
    box.setAttribute("aria-busy", "true");
    try {
      const r = await api("/leads", { query: { page, per: LEADS_PER } });
      if (!ctx.alive()) return;
      const items = listOf(r, "leads");
      const total = Number(r?.total ?? items.length);
      if (!items.length && page > 1 && total > 0) { page = 1; history.replaceState(null, "", "#/leads"); return load(); }
      if (!items.length) {
        box.replaceChildren(emptyState({ icon: "chat-circle-text", title: "No leads yet", text: "When a shopper sends a WhatsApp enquiry from a product page, a copy appears here with the product, store and campaign.", action: { label: "Open the website", icon: "arrow-square-out", href: "../" } }));
        pager.replaceChildren(); exportBtn.hidden = true;
        return;
      }
      exportBtn.hidden = false;
      const head = h("div", { class: "lhead", "aria-hidden": "true" }, ["Received", "Name", "Phone", "Interested in", "Store and time", "Source"].map(t => h("span", { text: t })));
      box.replaceChildren(head, h("ul", { class: "llist" }, items.map(l => {
        const when = l.when_pref ?? l.when ?? "";
        const url = safeHref(l.url);
        const prod = [l.product, l.code ? `(${l.code})` : ""].filter(Boolean).join(" ");
        return h("li", { class: "lrow" },
          h("div", { class: "l-date" }, h("time", { datetime: l.created_at || "", title: fmtDate(l.created_at), text: timeAgo(l.created_at) }), h("span", { class: "muted small phone-hide", text: isOld(l.created_at) ? fmtTime(l.created_at) : fmtDate(l.created_at) })),
          h("div", { class: "l-name" }, h("strong", { text: l.name || "No name" })),
          h("div", { class: "l-phone" }, leadContact(l)),
          h("div", { class: "l-prod" },
            prod ? (/^https?:/i.test(url) ? h("a", { href: url, target: "_blank", rel: "noopener noreferrer", class: "link" }, prod, icon("arrow-square-out")) : h("span", { text: prod })) : h("span", { class: "muted", text: "General enquiry" }),
            l.collection ? h("span", { class: "muted small", text: l.collection }) : null),
          h("div", { class: "l-store" }, h("span", { text: l.store || "Any store" }), when ? h("span", { class: "muted small", text: when }) : null),
          h("div", { class: "l-src" }, sourceOf(l)));
      })));
      const pages = Math.max(1, Math.ceil(total / LEADS_PER));
      const from = (page - 1) * LEADS_PER + 1, to = Math.min(total, page * LEADS_PER);
      fill(pager,
        h("span", { class: "muted", text: `Showing ${from} to ${to} of ${plural(total, "lead")}` }),
        pages > 1 ? h("div", { class: "pager-btns" },
          h("button", { type: "button", class: "btn btn-secondary btn-sm", disabled: page <= 1, onclick: () => turn(-1) }, icon("caret-left"), "Newer"),
          h("span", { class: "muted small", text: `Page ${page} of ${pages}` }),
          h("button", { type: "button", class: "btn btn-secondary btn-sm", disabled: page >= pages, onclick: () => turn(1) }, "Older", icon("caret-right"))) : null);
    } catch (e) { if (ctx.alive() && e.status !== 401) { box.replaceChildren(errorState(e, load)); pager.replaceChildren(); } }
    finally { box.removeAttribute("aria-busy"); }
  }
  function turn(d) { page += d; history.replaceState(null, "", page > 1 ? `#/leads?page=${page}` : "#/leads"); load(); window.scrollTo({ top: 0, behavior: "smooth" }); }
  await load();
}

/* ======================= Settings ======================= */
export async function settingsView(ctx) {
  ctx.root.append(pageHead({ title: "Settings" }), skeletonForm());
  const site = itemOf(await api("/settings"), "site") || {};
  if (!ctx.alive()) return;
  const socials = site.socials || {};
  const wa = field({ label: "WhatsApp number", name: "whatsapp", type: "text", inputmode: "numeric", maxlength: 15, value: digits(site.whatsapp), autocomplete: "off", required: true,
    hint: "Country code first, digits only, for example 971565006398. Every Enquire button on the website opens a chat with this number.",
    validate: v => !v ? "Enter the WhatsApp number." : !/^\d+$/.test(v) ? "Use digits only." : v.length < 8 || v.length > 15 ? "Enter the full number with country code, 8 to 15 digits." : "" });
  const waNote = h("p", { class: "note", hidden: true }, icon("info"), " Spaces, + and other symbols are removed automatically.");
  wa.input.addEventListener("input", () => {
    const v = wa.input.value, d = digits(v);
    if (v !== d) { wa.input.value = d; waNote.hidden = false; }
  });
  const waTest = h("a", { class: "btn btn-secondary btn-sm", target: "_blank", rel: "noopener noreferrer" }, icon("whatsapp-logo"), "Test this number");
  const phone = field({ label: "Phone", name: "phone", type: "tel", maxlength: 40, value: site.phone || "", placeholder: "e.g. +971 4 225 4254", hint: "Shown in the footer and on the contact links." });
  const email = field({ label: "Email", name: "email", type: "email", maxlength: 120, value: site.email || "", inputmode: "email", placeholder: "e.g. hello@siroya.com",
    validate: v => !v || /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v) ? "" : "Enter a valid email address." });
  const urlCheck = v => !v || /^https?:\/\/\S+\.\S+/i.test(v) ? "" : "Paste the full link, starting with https://";
  const social = (key, label, ph) => {
    const f = field({ label, name: key, type: "url", inputmode: "url", maxlength: 300, value: socials[key] || "", placeholder: ph, optional: true, validate: urlCheck });
    f.input.addEventListener("blur", () => { const v = f.value().trim(); if (v && !/^https?:\/\//i.test(v) && /\.\w/.test(v)) { f.set("https://" + v.replace(/^\/+/, "")); f.check(); } });
    return f;
  };
  const ig = social("instagram", "Instagram", "instagram.com/siroyajewellers");
  const fb = social("facebook", "Facebook", "facebook.com/siroyajewellers");
  const yt = social("youtube", "YouTube", "youtube.com/@siroyajewellers");

  const fr = editFrame({ formId: "settings-form", isNew: false, title: "Settings" });
  const form = h("form", { id: "settings-form", class: "edit-grid single", novalidate: true },
    h("div", { class: "col" },
      card("WhatsApp enquiries", wa.wrap, waNote, h("div", { class: "row-gap" }, waTest)),
      card("Contact", h("div", { class: "grid-2" }, phone.wrap, email.wrap)),
      card("Social links", h("p", { class: "muted small card-sub", text: "Leave a link empty to hide that icon on the website." }), ig.wrap, fb.wrap, yt.wrap)));
  ctx.root.replaceChildren(fr.head, h("p", { class: "page-sub page-sub-solo", text: "Contact details used across the website." }), form, fr.savebar);
  const paint = () => { const d = wa.value(); waTest.hidden = d.length < 8; waTest.href = `https://wa.me/${d}`; };
  const values = () => ({ whatsapp: wa.value().trim(), phone: phone.value().trim(), email: email.value().trim(),
    socials: { ...socials, instagram: ig.value().trim(), facebook: fb.value().trim(), youtube: yt.value().trim() } });
  wireForm(ctx, form, {
    values, isNew: false, ss: fr.ss, onUpdate: paint,
    save: async () => {
      if (!checkAll([wa, email, ig, fb, yt])) return false;
      await api("/settings", { method: "PUT", body: values() });
      waNote.hidden = true;
      toast("Saved");
      return true;
    }
  });
}
