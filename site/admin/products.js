/* Siroya admin: products list and product editor. */
import { $, $$, h, fill, icon, api, listOf, itemOf, normProduct, getCategories, getCollections, invalidate, go, toast, toastError, modal, confirmDialog,
  pageHead, emptyState, errorState, skeletonList, skeletonForm, field, switchEl, card, dirtyTracker, saveState, imgSrc, slugify, SLUG_RE, plural, debounce, statusChip, STATUS, nextId } from "./lib.js";
import { imageManager } from "./media.js";

const PER = 50;
const KEYS = ["q", "collection", "category", "status", "featured", "page"];
let handoff = null; // freshly created product, so the editor does not refetch it
let listHash = "#/products"; // last list view, so Back keeps search and filters

/* ======================= List ======================= */
export async function productsList(ctx) {
  const f = Object.fromEntries(KEYS.map(k => [k, ctx.query[k] || ""]));
  f.page = Math.max(1, parseInt(f.page, 10) || 1);
  const selected = new Set();
  let items = [], total = 0, reqId = 0, first = true;
  let cats = [], colls = [];
  const catName = s => cats.find(c => c.slug === s)?.name || s || "";
  const collName = s => colls.find(c => c.slug === s)?.name || s || "";

  /* Toolbar */
  const search = h("input", { type: "search", class: "search-input", placeholder: "Search products", title: "Searches name, code, web address and description", "aria-label": "Search products by name, code or description", enterkeyhint: "search", autocomplete: "off" });
  search.value = f.q;
  const mkSelect = (label, key, options) => {
    const id = nextId("flt");
    const s = h("select", { id, "aria-label": label }, options.map(o => h("option", { value: o.value }, o.label)));
    s.value = f[key];
    s.addEventListener("change", () => { f[key] = s.value; f.page = 1; changed(); });
    return s;
  };
  const selColl = mkSelect("Collection", "collection", [{ value: "", label: "All collections" }]);
  const selCat = mkSelect("Category", "category", [{ value: "", label: "All categories" }]);
  const selStatus = mkSelect("Status", "status", [{ value: "", label: "Any status" }, { value: "active", label: "Active" }, { value: "draft", label: "Draft" }, { value: "archived", label: "Archived" }]);
  const selFeat = mkSelect("Featured", "featured", [{ value: "", label: "Featured: any" }, { value: "1", label: "Featured only" }, { value: "0", label: "Not featured" }]);
  const clearBtn = h("button", { type: "button", class: "btn btn-ghost btn-sm", onclick: () => { Object.assign(f, { q: "", collection: "", category: "", status: "", featured: "", page: 1 }); search.value = ""; [selColl, selCat, selStatus, selFeat].forEach(s => { s.value = ""; }); changed(); } }, icon("x"), "Clear filters");
  const filtersId = nextId("filters");
  const filters = h("div", { class: "filters", id: filtersId }, selColl, selCat, selStatus, selFeat, clearBtn);
  const filterBadge = h("span", { class: "badge" });
  const filterToggle = h("button", { type: "button", class: "btn btn-secondary filter-toggle", "aria-label": "Filters", "aria-expanded": "false", "aria-controls": filtersId,
    onclick: () => { const open = !filters.classList.contains("open"); filters.classList.toggle("open", open); filterToggle.setAttribute("aria-expanded", String(open)); } }, icon("funnel-simple"), h("span", { class: "ft-label", text: "Filters" }), filterBadge);
  const toolbar = h("div", { class: "toolbar" },
    h("div", { class: "search" }, icon("magnifying-glass"), search, h("kbd", { class: "kbd", title: "Press / to search", text: "/" })),
    filterToggle, filters);

  const listBox = h("div", { class: "list-box", "aria-live": "polite" }, skeletonList(8));
  const pager = h("nav", { class: "pager", "aria-label": "Pages" });

  /* Bulk bar */
  const bulkCount = h("strong", { class: "bulk-count" });
  const ACTIONS = [
    { a: "activate", label: "Make active", icon: "eye" },
    { a: "draft", label: "Move to draft", icon: "note-pencil" },
    { a: "archive", label: "Archive", icon: "archive" },
    { a: "feature", label: "Feature", icon: "star" },
    { a: "unfeature", label: "Unfeature", icon: "star-half" },
    { a: "set_category", label: "Set category", icon: "squares-four" },
    { a: "delete", label: "Delete", icon: "trash", danger: true }
  ];
  const bulk = h("div", { class: "bulkbar", role: "region", "aria-label": "Bulk actions", hidden: true },
    h("div", { class: "bulk-info" }, bulkCount, h("button", { type: "button", class: "linkish", onclick: () => { selected.clear(); paintSelection(); } }, "Clear")),
    h("div", { class: "bulk-actions" }, ACTIONS.map(x => h("button", { type: "button", class: `btn btn-sm ${x.danger ? "btn-danger-ghost" : "btn-secondary"}`, onclick: () => runBulk(x.a) }, icon(x.icon), x.label))),
    h("button", { type: "button", class: "btn btn-primary btn-sm bulk-more", "aria-haspopup": "dialog", onclick: actionSheet }, icon("lightning"), "Actions"));

  const newBtn = h("a", { class: "btn btn-primary", href: "#/products/new" }, icon("plus"), h("span", { text: "New product" }));
  ctx.root.append(pageHead({ title: "Products", subtitle: "Everything shown in collections and categories on the website.", actions: [newBtn] }), toolbar, listBox, pager, bulk);

  /* Keyboard: "/" focuses search */
  const onKey = e => {
    if (e.key === "/" && !e.metaKey && !e.ctrlKey && !/^(input|textarea|select)$/i.test(document.activeElement?.tagName || "") && !document.querySelector("dialog[open]")) { e.preventDefault(); search.focus(); }
  };
  document.addEventListener("keydown", onKey);
  ctx.onLeave(() => document.removeEventListener("keydown", onKey));

  const onSearch = debounce(() => { f.q = search.value.trim(); f.page = 1; changed(); }, 280);
  search.addEventListener("input", onSearch);
  search.addEventListener("keydown", e => { if (e.key === "Escape" && search.value) { search.value = ""; onSearch(); } });

  function activeFilters() { return ["collection", "category", "status", "featured"].filter(k => f[k]).length; }
  function syncUrl() {
    const qs = new URLSearchParams();
    KEYS.forEach(k => { if (f[k] && !(k === "page" && f.page === 1)) qs.set(k, f[k]); });
    const s = qs.toString();
    listHash = "#/products" + (s ? "?" + s : "");
    history.replaceState(null, "", listHash);
    const n = activeFilters();
    filterBadge.textContent = n ? String(n) : ""; filterBadge.hidden = !n;
    clearBtn.hidden = !(n || f.q);
  }
  function changed() { selected.clear(); syncUrl(); load(); }

  async function load() {
    const my = ++reqId;
    listBox.setAttribute("aria-busy", "true");
    listBox.classList.toggle("is-loading", !first);
    try {
      const r = await api("/products", { query: { q: f.q, collection: f.collection, category: f.category, status: f.status, featured: f.featured, page: f.page, per: PER } });
      if (my !== reqId || !ctx.alive()) return;
      items = listOf(r, "products").map(normProduct);
      total = Number(r?.total ?? items.length);
      if (!items.length && f.page > 1 && total > 0) { f.page = 1; syncUrl(); return load(); }
      first = false;
      paint();
    } catch (e) {
      if (my !== reqId || !ctx.alive() || e.status === 401) return;
      listBox.replaceChildren(errorState(e, load)); pager.replaceChildren();
    } finally {
      if (my === reqId) { listBox.removeAttribute("aria-busy"); listBox.classList.remove("is-loading"); }
    }
  }

  function paint() {
    if (!items.length) {
      const filtered = !!(f.q || activeFilters());
      listBox.replaceChildren(filtered
        ? emptyState({ icon: "magnifying-glass", title: "No products match", text: f.q ? `Nothing found for "${f.q}" with these filters.` : "Try a different collection, category or status.", action: { label: "Clear filters", icon: "x", onClick: () => clearBtn.click() } })
        : emptyState({ icon: "diamond", title: "No products yet", text: "Add your first design with photos, details and a description. It goes live on the website as soon as you save it as Active.", action: { label: "Add a product", icon: "plus", href: "#/products/new" } }));
      pager.replaceChildren(); paintSelection();
      return;
    }
    const all = h("input", { type: "checkbox", class: "cb", "aria-label": "Select all products on this page", onchange: e => { items.forEach(p => e.target.checked ? selected.add(p.id) : selected.delete(p.id)); paintSelection(); } });
    const head = h("div", { class: "phead" },
      h("label", { class: "c-check" }, all, h("span", { class: "phone-only", text: "Select all" })),
      h("span", { class: "c-thumb" }), h("span", { class: "c-name", text: "Product" }), h("span", { class: "c-code", text: "Code" }),
      h("span", { class: "c-coll", text: "Collection" }), h("span", { class: "c-cat", text: "Category" }), h("span", { class: "c-status", text: "Status" }), h("span", { class: "c-star", text: "Featured" }),
      h("span", { class: "phead-count muted small", text: plural(total, "product") }));
    listBox.replaceChildren(head, h("ul", { class: "plist" }, items.map(row)));
    paintSelection();
    const from = (f.page - 1) * PER + 1, to = Math.min(total, f.page * PER), pages = Math.max(1, Math.ceil(total / PER));
    fill(pager,
      h("span", { class: "muted", text: `Showing ${from} to ${to} of ${plural(total, "product")}` }),
      pages > 1 ? h("div", { class: "pager-btns" },
        h("button", { type: "button", class: "btn btn-secondary btn-sm", disabled: f.page <= 1, onclick: () => turn(-1) }, icon("caret-left"), "Previous"),
        h("span", { class: "muted small", text: `Page ${f.page} of ${pages}` }),
        h("button", { type: "button", class: "btn btn-secondary btn-sm", disabled: f.page >= pages, onclick: () => turn(1) }, "Next", icon("caret-right"))) : null);
  }
  function turn(d) { f.page += d; selected.clear(); syncUrl(); load(); toolbar.scrollIntoView({ behavior: "smooth", block: "start" }); }

  function row(p) {
    const href = `#/products/${p.id}`;
    const cb = h("input", { type: "checkbox", class: "cb", checked: selected.has(p.id), "aria-label": `Select ${p.name}`,
      onchange: e => { e.target.checked ? selected.add(p.id) : selected.delete(p.id); paintSelection(); } });
    // No-break space before each dot, so a wrapped line never starts with "·"
    const meta = [p.code, collName(p.collection), catName(p.category)].filter(Boolean).join(" · ");
    return h("li", { class: ["prow", selected.has(p.id) && "selected"], dataset: { id: p.id } },
      h("label", { class: "c-check" }, cb),
      h("div", { class: "c-thumb" }, p.images[0] ? h("img", { src: imgSrc(p.images[0]), alt: "", loading: "lazy", decoding: "async" }) : h("div", { class: "slot" }, icon("image"))),
      h("div", { class: "c-name" }, h("a", { class: "pname", href, text: p.name || "Untitled" }), h("span", { class: "muted small ellip c-handle", text: p.handle }), p.code ? h("span", { class: "muted small ellip c-code-sm", text: p.code }) : null, h("span", { class: "c-meta muted small", text: meta })),
      h("div", { class: "c-code", text: p.code }),
      h("div", { class: "c-coll", text: collName(p.collection) }),
      h("div", { class: "c-cat", text: catName(p.category) }),
      h("div", { class: "c-status" }, statusChip(p.status)),
      h("div", { class: "c-star" }, starBtn(p)));
  }
  function starBtn(p) {
    const b = h("button", { type: "button", class: "star" });
    let busy = false;
    const paintStar = () => {
      b.classList.toggle("on", p.featured);
      b.setAttribute("aria-pressed", String(p.featured));
      b.setAttribute("aria-label", `Featured: ${p.name}`);
      b.title = p.featured ? "Featured. Click to remove" : "Click to feature";
      b.replaceChildren(icon(p.featured ? "fill:star" : "star"));
    };
    b.addEventListener("click", async () => {
      if (busy) return;
      busy = true; b.setAttribute("aria-busy", "true");
      const next = !p.featured; p.featured = next; paintStar();
      try {
        await api("/products/bulk", { method: "POST", body: { ids: [p.id], action: next ? "feature" : "unfeature" } });
        toast(next ? `${p.name} is now featured` : `${p.name} is no longer featured`);
      } catch (e) { p.featured = !next; paintStar(); toastError(e); }
      finally { busy = false; b.removeAttribute("aria-busy"); }
    });
    paintStar();
    return b;
  }
  function paintSelection() {
    $$(".prow", listBox).forEach(li => {
      const on = selected.has(Number(li.dataset.id)) || selected.has(li.dataset.id);
      li.classList.toggle("selected", on);
      const cb = $(".cb", li); if (cb) cb.checked = on;
    });
    const all = $(".phead .cb", listBox);
    if (all) {
      const n = items.filter(p => selected.has(p.id)).length;
      all.checked = n > 0 && n === items.length; all.indeterminate = n > 0 && n < items.length;
    }
    bulk.hidden = selected.size === 0;
    document.body.classList.toggle("has-bulk", selected.size > 0);
    bulkCount.replaceChildren(String(selected.size), h("span", { class: "hide-phone", text: selected.size === 1 ? " product" : " products" }), " selected");
  }
  ctx.onLeave(() => document.body.classList.remove("has-bulk"));

  async function actionSheet() {
    const body = h("div", { class: "sheet-list" }, ACTIONS.map(x => h("button", { type: "submit", value: x.a, class: ["sheet-link", x.danger && "danger"] }, icon(x.icon), h("span", { text: x.label }))));
    const v = await modal({ title: `${plural(selected.size, "product")} selected`, body, className: "sheet" });
    if (v) runBulk(v);
  }
  async function pickCategory() {
    const id = nextId("bulkcat");
    const sel = h("select", { id, name: "cat" }, h("option", { value: "" }, "No category"), cats.map(c => h("option", { value: c.slug }, c.name)));
    const v = await modal({
      title: "Set category",
      body: h("div", { class: "field" }, h("label", { for: id, text: `Category for ${plural(selected.size, "product")}` }), sel),
      actions: [{ value: "", label: "Cancel" }, { value: "ok", label: "Apply", class: "btn-primary" }],
      onOpen: () => sel.focus()
    });
    return v === "ok" ? sel.value : null;
  }
  async function runBulk(action) {
    const ids = [...selected];
    if (!ids.length) return;
    let value;
    if (action === "delete") {
      const ok = await confirmDialog({ title: `Delete ${plural(ids.length, "product")}?`, message: ids.length === 1 ? "It will be removed from the website and from this admin. This cannot be undone. To hide it for now, choose Archive instead." : "They will be removed from the website and from this admin. This cannot be undone. To hide them for now, choose Archive instead.", confirmLabel: "Delete", danger: true, icon: "trash" });
      if (!ok) return;
    }
    if (action === "set_category") { value = await pickCategory(); if (value === null) return; }
    bulk.setAttribute("aria-busy", "true");
    $$("button", bulk).forEach(b => { b.disabled = true; });
    try {
      await api("/products/bulk", { method: "POST", body: { ids, action, value } });
      const n = plural(ids.length, "product");
      toast({
        activate: `${n} now active`, draft: `${n} moved to draft`, archive: `${n} archived`, feature: `${n} featured`, unfeature: `${n} no longer featured`,
        set_category: value ? `${n} moved to ${catName(value)}` : `${n} removed from their category`, delete: `${n} deleted`
      }[action] || "Done");
      invalidate("categories", "collections");
      selected.clear(); paintSelection();
      load();
    } catch (e) { toastError(e); }
    finally { bulk.removeAttribute("aria-busy"); $$("button", bulk).forEach(b => { b.disabled = false; }); }
  }

  syncUrl();
  load();
  try {
    [cats, colls] = await Promise.all([getCategories(), getCollections()]);
    if (!ctx.alive()) return;
    cats.forEach(c => selCat.append(h("option", { value: c.slug }, c.name)));
    colls.forEach(c => selColl.append(h("option", { value: c.slug }, c.name + (c.active ? "" : " (hidden)"))));
    selCat.value = f.category; selColl.value = f.collection;
    if (items.length) paint();
  } catch (e) { if (e.status !== 401) toastError(e); }
}

/* ======================= Editor ======================= */
const METALS = ["22K Gold", "18K Gold", "18K Gold, Natural Diamond", "18K Gold, Lab Grown Diamond", "18K Gold, Solitaire", "22K Gold, Precious Stones", "Platinum", "Silver"];
const STATUS_HINT = { active: "Visible on the website.", draft: "Hidden while you prepare it.", archived: "Hidden and kept for your records." };

export async function productEdit(ctx) {
  const id = ctx.params[0];
  const isNew = id === "new";
  const back = { href: listHash, label: "Products" };
  ctx.root.append(pageHead({ title: isNew ? "New product" : "Loading product", back }), skeletonForm());
  let prod;
  const [pr, cats, colls] = await Promise.all([
    isNew ? Promise.resolve({ name: "", handle: "", code: "", collection: ctx.query.collection || "", category: ctx.query.category || "", metal: "", weight: "", stones: "", description: "", images: [], featured: false, status: "active" })
      : handoff && String(handoff.id) === id ? Promise.resolve(handoff) : api(`/products/${id}`).then(r => itemOf(r, "product")),
    getCategories().catch(() => []), getCollections().catch(() => [])
  ]);
  handoff = null;
  if (!ctx.alive()) return;
  prod = normProduct(pr);
  ctx.setTitle(isNew ? "New product" : prod.name || "Product");

  /* Fields */
  const name = field({ label: "Product name", name: "name", required: true, maxlength: 120, value: prod.name, placeholder: "e.g. Lakshmi Haaram", validate: v => v.trim() ? "" : "Enter a product name." });
  const handle = field({ label: "Web address", name: "handle", maxlength: 80, value: prod.handle, prefix: "product.html?p=", spellcheck: "false",
    hint: isNew ? "Filled in from the name. Lowercase letters, numbers and hyphens." : "Changing this changes the product's web address, so links shared earlier will stop working.",
    validate: v => !v || SLUG_RE.test(v) ? "" : "Use lowercase letters, numbers and single hyphens, for example lakshmi-haaram." });
  const code = field({ label: "Product code", name: "code", maxlength: 40, value: prod.code, placeholder: "e.g. SJ-SAN-1040", hint: "Shown on the product page and in WhatsApp enquiries." });
  const desc = field({ label: "Description", name: "description", type: "textarea", rows: 7, maxlength: 2000, counter: true, value: prod.description, hint: "Tell the story: the craft, the occasion, how it feels to wear. Two to four sentences works well." });
  const metalList = nextId("metals");
  const metal = field({ label: "Metal", name: "metal", maxlength: 80, value: prod.metal, list: metalList, placeholder: "e.g. 22K Gold" });
  const weight = field({ label: "Weight", name: "weight", maxlength: 40, value: prod.weight, placeholder: "e.g. 24.5 g" });
  const stones = field({ label: "Stones", name: "stones", maxlength: 160, value: prod.stones, placeholder: "e.g. Rubies, kemp stones" });
  const status = field({ label: "Status", name: "status", type: "select", value: prod.status, options: Object.entries(STATUS).map(([value, label]) => ({ value, label })), hint: STATUS_HINT[prod.status] });
  const optWithMissing = (list, cur, none, labelOf) => {
    const opts = [{ value: "", label: none }, ...list.map(x => ({ value: x.slug, label: labelOf(x) }))];
    if (cur && !list.some(x => x.slug === cur)) opts.push({ value: cur, label: `${cur} (not found)` });
    return opts;
  };
  const collection = field({ label: "Collection", name: "collection", type: "select", value: prod.collection, options: optWithMissing(colls, prod.collection, "No collection", c => c.name + (c.active ? "" : " (hidden)")) });
  const category = field({ label: "Category", name: "category", type: "select", value: prod.category, options: optWithMissing(cats, prod.category, "No category", c => c.name) });
  const featured = switchEl({ label: "Featured", desc: "Highlight this product on the website.", checked: prod.featured });
  const photosNote = h("p", { class: "note", hidden: true }, icon("info"), " No photos yet. The website shows a placeholder until you add one.");
  const im = imageManager({ images: prod.images, onChange: () => { update(); } });
  const handleAuto = { on: isNew && !prod.handle };

  /* Live preview, same markup as the public product card */
  const pvFrame = h("div", { class: "frame" });
  const pvName = h("h3"), pvMeta = h("div", { class: "meta" });
  const preview = h("div", { class: "p-card", "aria-hidden": "true" }, pvFrame, h("div", null, pvName, pvMeta), h("span", { class: "enq" }, icon("whatsapp-logo"), "Enquire"));
  let pvKey = "";
  function paintPreview() {
    const imgs = im.value();
    pvName.textContent = name.value().trim() || "Product name";
    pvMeta.textContent = metal.value().trim();
    const key = imgs.slice(0, 2).join("|");
    if (key !== pvKey) {
      pvKey = key;
      pvFrame.replaceChildren(...(imgs[0]
        ? [h("img", { src: imgSrc(imgs[0]), alt: "" }), imgs[1] ? h("img", { class: "alt", src: imgSrc(imgs[1]), alt: "" }) : null].filter(Boolean)
        : [h("div", { class: "slot", text: "Product photo 4:5" })]));
    }
  }

  /* Header + save bars */
  const saveBtns = [0, 1].map(() => h("button", { type: "submit", class: "btn btn-primary", form: "product-form", dataset: { label: isNew ? "Create product" : "Save" } }, icon("check"), h("span", { class: "lbl", text: isNew ? "Create product" : "Save" })));
  const stateEls = [0, 1].map(() => h("span", { class: "save-state", role: "status" }));
  const ss = saveState(saveBtns, stateEls);
  const viewLink = h("a", { class: "btn btn-secondary", target: "_blank", rel: "noopener" }, icon("arrow-square-out"), h("span", { text: "View on site" }));
  const chip = h("span", { class: "head-chip" });
  const head = pageHead({ title: isNew ? "New product" : prod.name || "Untitled", back, meta: chip, actions: [stateEls[0], viewLink, saveBtns[0]] });
  const savebar = h("div", { class: "savebar" }, stateEls[1], saveBtns[1]);
  function paintHead(saved) {
    $(".page-title", head).textContent = isNew ? "New product" : saved.name || "Untitled";
    chip.replaceChildren(isNew ? "" : statusChip(saved.status));
    const live = !isNew && saved.status === "active" && saved.handle;
    viewLink.hidden = !live;
    if (live) viewLink.href = `../product.html?p=${encodeURIComponent(saved.handle)}`;
  }

  const delBtn = isNew ? null : h("button", { type: "button", class: "btn btn-danger-ghost btn-block", onclick: del }, icon("trash"), "Delete product");
  const form = h("form", { id: "product-form", class: "edit-grid", novalidate: true },
    h("div", { class: "col" },
      card("Details", name.wrap, handle.wrap, code.wrap, desc.wrap),
      card("Photos", h("p", { class: "muted small card-sub", text: "The first photo is the main image. The second shows when a shopper hovers over the product." }), im.el),
      card("Specifications", h("datalist", { id: metalList }, METALS.map(m => h("option", { value: m }))), h("div", { class: "grid-2" }, metal.wrap, weight.wrap), stones.wrap)),
    h("div", { class: "col col-side" },
      card("Visibility", status.wrap, featured.wrap, photosNote),
      card("Organise", collection.wrap, category.wrap),
      h("section", { class: "card" }, h("h2", { class: "card-title", text: "Preview" }), h("p", { class: "muted small card-sub", text: "How the product card looks on the website." }), h("div", { class: "preview-wrap" }, preview)),
      delBtn ? h("section", { class: "card card-quiet" }, delBtn) : null));
  ctx.root.replaceChildren(head, form, savebar);

  /* State */
  const values = () => ({
    name: name.value().trim(), handle: handle.value().trim(), code: code.value().trim(), description: desc.value().trim(),
    metal: metal.value().trim(), weight: weight.value().trim(), stones: stones.value().trim(),
    status: status.value(), collection: collection.value(), category: category.value(),
    featured: featured.input.checked, images: im.value()
  });
  const tracker = dirtyTracker(values);
  ctx.guard(() => tracker.isDirty() || im.busy());
  let saving = false;
  function update() {
    paintPreview();
    $(".hint", status.wrap).textContent = STATUS_HINT[status.value()] || "";
    photosNote.hidden = !(status.value() === "active" && !im.value().length);
    if (!saving) ss.set(tracker.isDirty() ? "dirty" : isNew ? "new" : "clean");
  }
  name.input.addEventListener("input", () => { if (handleAuto.on) handle.set(slugify(name.value())); });
  handle.input.addEventListener("input", () => { handleAuto.on = isNew && !handle.value(); });
  handle.input.addEventListener("blur", () => { const v = handle.value().trim(); if (v && !SLUG_RE.test(v)) { handle.set(slugify(v)); handle.check(); } });
  form.addEventListener("input", update);
  form.addEventListener("change", update);
  form.addEventListener("submit", e => { e.preventDefault(); save(); });
  const onKey = e => { if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "s") { e.preventDefault(); save(); } };
  document.addEventListener("keydown", onKey);
  ctx.onLeave(() => document.removeEventListener("keydown", onKey));
  paintHead(prod); update();

  async function save() {
    if (saving) return;
    const checks = [name, handle].map(x => [x, x.check()]);
    const bad = checks.find(([, ok]) => !ok);
    if (bad) { bad[0].input.focus(); toast("Please fix the highlighted field.", "error"); return; }
    if (im.busy()) { toast("Photos are still uploading. Save again when they finish.", "info"); return; }
    saving = true; ss.set("saving");
    const body = values();
    try {
      const r = isNew ? await api("/products", { method: "POST", body }) : await api(`/products/${id}`, { method: "PUT", body });
      const out = itemOf(r, "product");
      const saved = normProduct({ ...prod, ...body, ...(out && typeof out === "object" ? out : {}) });
      invalidate("categories", "collections");
      if (isNew) {
        ctx.isDirty = () => false;
        toast(`${saved.name} created`);
        if (saved.id != null && saved.id !== "") { handoff = saved; go(`#/products/${saved.id}`, { replace: true }); }
        else go("#/products");
        return;
      }
      prod = saved;
      if (saved.handle && saved.handle !== handle.value()) handle.set(saved.handle);
      tracker.reset(); saving = false;
      ss.set("clean"); paintHead(saved); ctx.setTitle(saved.name);
      toast("Saved");
    } catch (e) {
      saving = false; ss.set("error");
      if (e.status === 409) { handle.error(e.message); handle.input.focus(); }
      toastError(e);
    } finally { saving = false; }
  }
  async function del() {
    const ok = await confirmDialog({ title: "Delete this product?", message: `${prod.name || "This product"} will be removed from the website and from this admin. This cannot be undone. To hide it for now, set the status to Archived instead.`, confirmLabel: "Delete product", danger: true, icon: "trash" });
    if (!ok) return;
    try {
      await api(`/products/${id}`, { method: "DELETE" });
      ctx.isDirty = () => false;
      invalidate("categories", "collections");
      toast(`${prod.name || "Product"} deleted`);
      go(listHash);
    } catch (e) { toastError(e); }
  }
}
