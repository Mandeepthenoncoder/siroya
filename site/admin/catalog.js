/* Siroya admin: categories and collections.
   Ordered lists (drag or up/down, saved straight away), the homepage switch,
   edit forms, and delete with the force option. */
import { $, $$, h, icon, iconBtn, api, listOf, itemOf, normCategory, normCollection, invalidate, go, toast, toastError, confirmDialog,
  pageHead, emptyState, errorState, skeletonList, skeletonForm, field, switchEl, card, editFrame, wireForm, checkAll, imgSrc, slugify, SLUG_RE,
  plural, debounce, dragSort, moveItem, nextId } from "./lib.js";
import { imageField } from "./media.js";

/* ======================= Shared building blocks ======================= */

/** A list whose order is saved to PUT {endpoint}/order. Moves are optimistic
    and batched; on failure the last saved order comes back. */
export function orderList({ items, endpoint, label, rowParts, noun }) {
  let list = items.slice();
  let saved = list.slice();
  const ul = h("ul", { class: "olist", "aria-label": label });
  const live = h("p", { class: "sr-only", "aria-live": "polite" });
  const say = t => { live.textContent = ""; requestAnimationFrame(() => { live.textContent = t; }); };
  const persist = debounce(async () => {
    const ids = list.map(x => x.id);
    if (ids.join() === saved.map(x => x.id).join()) return;
    try {
      await api(`${endpoint}/order`, { method: "PUT", body: { ids } });
      saved = list.slice();
      list.forEach((x, i) => { x.sort = i; });
      invalidate(endpoint.replace("/", ""));
      toast("Order saved");
    } catch (e) {
      list = saved.slice(); paint();
      toastError(e);
    }
  }, 600);
  function move(from, to, focusAct) {
    if (to < 0 || to >= list.length || from === to) return;
    const item = list[from];
    list = moveItem(list, from, to);
    paint();
    say(`${item.name} moved to position ${to + 1} of ${list.length}.`);
    if (focusAct) {
      const row = ul.querySelector(`[data-id="${item.id}"]`);
      const btn = row?.querySelector(`[data-act="${focusAct}"]`);
      (btn && !btn.disabled ? btn : row?.querySelector(`[data-act="${focusAct === "up" ? "down" : "up"}"]`))?.focus();
    }
    persist();
  }
  function paint() {
    ul.replaceChildren(...list.map((it, i) => {
      const p = rowParts(it, i);
      const up = iconBtn("arrow-up", `Move ${it.name} up`, () => move(list.indexOf(it), list.indexOf(it) - 1, "up"), { disabled: i === 0 });
      const down = iconBtn("arrow-down", `Move ${it.name} down`, () => move(list.indexOf(it), list.indexOf(it) + 1, "down"), { disabled: i === list.length - 1 });
      up.dataset.act = "up"; down.dataset.act = "down";
      return h("li", { class: ["orow", p.cls], dataset: { id: it.id } },
        h("span", { class: "drag-handle", "data-handle": "", title: "Drag to reorder", "aria-hidden": "true" }, icon("dots-six-vertical")),
        h("span", { class: "o-pos", "aria-hidden": "true", text: String(i + 1) }),
        p.thumb, p.main, p.toggle || h("span"),
        h("div", { class: "ud", role: "group", "aria-label": `Order of ${it.name}` }, up, down),
        h("div", { class: "o-actions" }, p.actions));
    }));
  }
  dragSort(ul, ".orow", (from, to) => move(from, to));
  paint();
  return { el: h("div", { class: "olist-wrap" }, ul, live), paint, items: () => list, remove(id) { list = list.filter(x => x.id !== id); saved = saved.filter(x => x.id !== id); paint(); } };
}

/** Product counts: from the API when it sends them, else counted per slug. */
async function fillCounts(items, key) {
  const missing = items.filter(x => x.count == null);
  if (!missing.length) return;
  await Promise.all(missing.map(async x => {
    try { const r = await api("/products", { query: { [key]: x.slug, per: 1, page: 1 } }); x.count = Number(r?.total ?? listOf(r).length) || 0; }
    catch { x.count = null; }
  }));
}
const thumbEl = (src, ratio = "1 / 1") => h("div", { class: "o-thumb", style: { "aspect-ratio": ratio } }, src ? h("img", { src: imgSrc(src), alt: "", loading: "lazy", decoding: "async" }) : h("div", { class: "slot" }, icon("image")));

/** Delete with confirm, and the force option when products still use it. */
async function deleteWithForce({ endpoint, item, count, kind, unlinkText }) {
  const n = Number(count) || 0;
  const ok = await confirmDialog(n > 0
    ? { title: `Delete ${item.name}?`, message: `${plural(n, "product")} ${n === 1 ? "uses" : "use"} this ${kind}. ${unlinkText} This cannot be undone.`, confirmLabel: `Delete ${kind}`, danger: true, icon: "trash" }
    : { title: `Delete ${item.name}?`, message: `This ${kind} will be removed from the website. This cannot be undone.`, confirmLabel: `Delete ${kind}`, danger: true, icon: "trash" });
  if (!ok) return false;
  try {
    await api(`${endpoint}/${item.id}`, { method: "DELETE", query: n > 0 ? { force: 1 } : null });
  } catch (e) {
    if (e.status !== 409) { toastError(e); return false; }
    const again = await confirmDialog({ title: `${item.name} is still in use`, message: `${e.message} ${unlinkText}`, confirmLabel: `Delete anyway`, danger: true, icon: "trash" });
    if (!again) return false;
    try { await api(`${endpoint}/${item.id}`, { method: "DELETE", query: { force: 1 } }); }
    catch (e2) { toastError(e2); return false; }
  }
  invalidate("categories", "collections");
  toast(`${item.name} deleted`);
  return true;
}

/* ======================= Categories ======================= */
/* Order (sort) is only ever written by PUT /order, so a save never undoes a
   reorder; new items get the next position from the server. */

export async function categoriesList(ctx) {
  const newBtn = h("a", { class: "btn btn-primary", href: "#/categories/new", "aria-label": "New category" }, icon("plus"), h("span", null, "New", h("span", { class: "hide-phone", text: " category" })));
  const summary = h("div", { class: "summary" });
  const strip = h("div", { class: "home-strip", "aria-label": "Homepage preview" });
  const box = h("div", { class: "list-box" }, skeletonList(6));
  ctx.root.append(
    pageHead({ title: "Categories", subtitle: "Switch on the categories that appear in Find your design on the homepage. The order here is the order shoppers see.", actions: [newBtn] }),
    box);
  let cats;
  async function load() {
    try {
      cats = listOf(await api("/categories"), "categories").map(normCategory).sort((a, b) => a.sort - b.sort);
      if (!ctx.alive()) return;
      await fillCounts(cats, "category");
      if (!ctx.alive()) return;
      paint();
    } catch (e) { if (ctx.alive() && e.status !== 401) box.replaceChildren(errorState(e, load)); }
  }
  function paintSummary() {
    const on = cats.filter(c => c.featured);
    summary.replaceChildren(icon(on.length ? "house-line" : "info"),
      h("span", { text: on.length ? `${on.length} of ${plural(cats.length, "category", "categories")} on the homepage.` : "None switched on, so the homepage shows every category." }));
    const show = on.length ? on : cats;
    strip.replaceChildren(h("span", { class: "strip-label", text: "Homepage preview" }),
      h("div", { class: "strip-row" }, show.map(c => h("div", { class: "strip-tile" }, thumbEl(c.image), h("span", { text: c.name })))));
  }
  function paint() {
    if (!cats.length) {
      box.replaceChildren(emptyState({ icon: "squares-four", title: "No categories yet", text: "Categories group products by type, such as Necklaces or Rings, and power Find your design on the homepage.", action: { label: "Add a category", icon: "plus", href: "#/categories/new" } }));
      return;
    }
    const ol = orderList({
      items: cats, endpoint: "/categories", label: "Categories in homepage order", noun: "category",
      rowParts: c => ({
        cls: c.featured ? "is-on" : "",
        thumb: thumbEl(c.image),
        main: h("div", { class: "o-main" },
          h("a", { class: "o-name", href: `#/categories/${c.id}`, text: c.name }),
          h("span", { class: "muted small" }, c.count == null ? "" : h("a", { class: "sublink", href: `#/products?category=${encodeURIComponent(c.slug)}`, text: plural(c.count, "product") }))),
        toggle: homeSwitch(c),
        actions: [
          h("a", { class: "icon-btn", href: `#/categories/${c.id}`, "aria-label": `Edit ${c.name}`, title: "Edit" }, icon("pencil-simple")),
          iconBtn("trash", `Delete ${c.name}`, async () => {
            if (await deleteWithForce({ endpoint: "/categories", item: c, count: c.count, kind: "category", unlinkText: "Those products stay on the website without a category." })) {
              cats = cats.filter(x => x.id !== c.id); ol.remove(c.id); paintSummary();
              if (!cats.length) paint();
            }
          }, { class: "danger" })]
      })
    });
    box.replaceChildren(summary, strip, ol.el);
    paintSummary();
  }
  function homeSwitch(c) {
    let busy = false;
    const sw = switchEl({ label: "Show on homepage", checked: c.featured, small: true, ariaLabel: `Show ${c.name} on homepage` });
    sw.input.addEventListener("click", e => { if (busy) e.preventDefault(); });
    sw.input.addEventListener("change", async () => {
      const on = sw.input.checked;
      busy = true; sw.wrap.setAttribute("aria-busy", "true");
      c.featured = on; sw.wrap.closest(".orow")?.classList.toggle("is-on", on); paintSummary();
      try {
        await api(`/categories/${c.id}`, { method: "PUT", body: { featured: on } });
        invalidate("categories");
        toast(on ? `${c.name} now shows on the homepage` : `${c.name} removed from the homepage`);
      } catch (e) {
        c.featured = !on; sw.input.checked = !on; sw.wrap.closest(".orow")?.classList.toggle("is-on", !on); paintSummary();
        toastError(e);
      } finally { busy = false; sw.wrap.removeAttribute("aria-busy"); }
    });
    return sw.wrap;
  }
  await load();
}

export async function categoryEdit(ctx) {
  const id = ctx.params[0], isNew = id === "new";
  ctx.root.append(pageHead({ title: isNew ? "New category" : "Loading category", back: { href: "#/categories", label: "Categories" } }), skeletonForm());
  let cat;
  if (isNew) cat = normCategory({ name: "", slug: "", description: "", image: "", featured: true });
  else {
    const list = listOf(await api("/categories"), "categories").map(normCategory);
    cat = list.find(c => String(c.id) === id);
    if (!cat) throw Object.assign(new Error("We could not find that category. It may have been deleted."), { status: 404 });
    if (cat.count == null) await fillCounts([cat], "category");
  }
  if (!ctx.alive()) return;
  ctx.setTitle(isNew ? "New category" : cat.name);

  const slugAuto = { on: isNew };
  const name = field({ label: "Name", name: "name", required: true, maxlength: 60, value: cat.name, placeholder: "e.g. Necklaces", validate: v => v.trim() ? "" : "Enter a name." });
  const slug = field({ label: "Web address", name: "slug", maxlength: 60, value: cat.slug, prefix: "category.html?c=", spellcheck: "false",
    hint: isNew ? "Filled in from the name." : "Changing this changes the category's web address.",
    validate: v => !v || SLUG_RE.test(v) ? "" : "Use lowercase letters, numbers and single hyphens." });
  const desc = field({ label: "Description", name: "description", type: "textarea", rows: 4, maxlength: 600, counter: true, value: cat.description, optional: true, hint: "One or two sentences shown at the top of the category page." });
  const image = imageField({ label: "Tile image", value: cat.image, ratio: "1 / 1", slotLabel: "Category image 1:1", hint: "Square image used on the homepage tile and the category page.", onChange: () => { wf.update(); } });
  const featured = switchEl({ label: "Show on homepage", desc: "Adds this category to Find your design on the homepage.", checked: cat.featured });
  name.input.addEventListener("input", () => { if (slugAuto.on) slug.set(slugify(name.value())); });
  slug.input.addEventListener("input", () => { slugAuto.on = isNew && !slug.value(); });
  slug.input.addEventListener("blur", () => { const v = slug.value().trim(); if (v && !SLUG_RE.test(v)) { slug.set(slugify(v)); slug.check(); } });

  const tileImg = h("div", { class: "frame" }), tileName = h("span");
  const tile = h("div", { class: "cat-tile", "aria-hidden": "true" }, tileImg, tileName);
  const viewLink = h("a", { class: "btn btn-secondary", target: "_blank", rel: "noopener" }, icon("arrow-square-out"), h("span", { text: "View on site" }));
  const fr = editFrame({ formId: "cat-form", isNew, title: isNew ? "New category" : cat.name, back: { href: "#/categories", label: "Categories" }, createLabel: "Create category", actions: [viewLink] });
  const links = isNew ? null : h("section", { class: "card card-quiet" },
    h("a", { class: "btn btn-secondary btn-block", href: `#/products?category=${encodeURIComponent(cat.slug)}` }, icon("diamond"), cat.count == null ? "See products" : `See ${plural(cat.count, "product")}`),
    h("button", { type: "button", class: "btn btn-danger-ghost btn-block", onclick: del }, icon("trash"), "Delete category"));
  const form = h("form", { id: "cat-form", class: "edit-grid", novalidate: true },
    h("div", { class: "col" }, card("Details", name.wrap, slug.wrap, desc.wrap), card("Image", image.el)),
    h("div", { class: "col col-side" },
      card("Homepage", featured.wrap),
      h("section", { class: "card" }, h("h2", { class: "card-title", text: "Preview" }), h("p", { class: "muted small card-sub", text: "The tile in Find your design." }), h("div", { class: "preview-wrap narrow" }, tile)),
      links));
  ctx.root.replaceChildren(fr.head, form, fr.savebar);

  let tileKey = null;
  const paint = () => {
    tileName.textContent = name.value().trim() || "Category";
    const src = image.value();
    if (src !== tileKey) { tileKey = src; tileImg.replaceChildren(src ? h("img", { src: imgSrc(src), alt: "" }) : h("div", { class: "slot", text: "Image 1:1" })); }
    viewLink.hidden = isNew; if (!isNew) viewLink.href = `../category.html?c=${encodeURIComponent(cat.slug)}`;
  };
  const values = () => ({ name: name.value().trim(), slug: slug.value().trim(), description: desc.value().trim(), image: image.value(), featured: featured.input.checked });
  const wf = wireForm(ctx, form, {
    values, isNew, ss: fr.ss, busy: image.busy, onUpdate: paint,
    save: async () => {
      if (!checkAll([name, slug])) return false;
      const body = values();
      let r;
      try { r = isNew ? await api("/categories", { method: "POST", body }) : await api(`/categories/${id}`, { method: "PUT", body }); }
      catch (e) { if (e.status === 409) slug.error(e.message); throw e; }
      const out = normCategory({ ...cat, ...body, ...(itemOf(r, "category") || {}) });
      invalidate("categories");
      if (isNew) {
        ctx.isDirty = () => false;
        toast(`${out.name} created`);
        go(out.id != null ? `#/categories/${out.id}` : "#/categories", { replace: true });
        return true;
      }
      cat = out; if (out.slug !== slug.value()) slug.set(out.slug);
      fr.setTitle(out.name); ctx.setTitle(out.name); paint();
      toast("Saved");
      return true;
    }
  });
  async function del() {
    if (await deleteWithForce({ endpoint: "/categories", item: cat, count: cat.count, kind: "category", unlinkText: "Those products stay on the website without a category." })) {
      ctx.isDirty = () => false; go("#/categories");
    }
  }
}

/* ======================= Collections ======================= */

export async function collectionsList(ctx) {
  const newBtn = h("a", { class: "btn btn-primary", href: "#/collections/new", "aria-label": "New collection" }, icon("plus"), h("span", null, "New", h("span", { class: "hide-phone", text: " collection" })));
  const box = h("div", { class: "list-box" }, skeletonList(6));
  ctx.root.append(pageHead({ title: "Collections", subtitle: "Each collection has its own storyline page. Hidden collections and their pages are not shown on the website.", actions: [newBtn] }), box);
  let colls;
  async function load() {
    try {
      colls = listOf(await api("/collections"), "collections").map(normCollection).sort((a, b) => a.sort - b.sort);
      if (!ctx.alive()) return;
      await fillCounts(colls, "collection");
      if (!ctx.alive()) return;
      paint();
    } catch (e) { if (ctx.alive() && e.status !== 401) box.replaceChildren(errorState(e, load)); }
  }
  function paint() {
    if (!colls.length) {
      box.replaceChildren(emptyState({ icon: "crown-simple", title: "No collections yet", text: "Create a collection to give a family of designs its own story page.", action: { label: "Add a collection", icon: "plus", href: "#/collections/new" } }));
      return;
    }
    const ol = orderList({
      items: colls, endpoint: "/collections", label: "Collections in site order", noun: "collection",
      rowParts: c => ({
        cls: c.active ? "is-on" : "is-off",
        thumb: thumbEl(c.cover, "3 / 4"),
        main: h("div", { class: "o-main" },
          h("a", { class: "o-name", href: `#/collections/${c.id}`, text: c.name }),
          h("span", { class: "muted small o-meta" },
            c.kind ? h("span", { text: c.kind }) : null,
            c.kind && c.count != null ? h("span", { class: "o-sep", text: "  ·  " }) : null,
            c.count == null ? null : h("span", { class: "nowrap", text: plural(c.count, "product") }))),
        toggle: activeSwitch(c),
        actions: [
          h("a", { class: "icon-btn", href: `#/collections/${c.id}`, "aria-label": `Edit ${c.name}`, title: "Edit" }, icon("pencil-simple")),
          iconBtn("trash", `Delete ${c.name}`, async () => {
            if (await deleteWithForce({ endpoint: "/collections", item: c, count: c.count, kind: "collection", unlinkText: "Those products stay in the admin without a collection." })) {
              colls = colls.filter(x => x.id !== c.id); ol.remove(c.id); if (!colls.length) paint();
            }
          }, { class: "danger" })]
      })
    });
    box.replaceChildren(ol.el);
  }
  function activeSwitch(c) {
    let busy = false;
    const sw = switchEl({ label: "Show on website", checked: c.active, small: true, ariaLabel: `Show ${c.name} on website` });
    sw.input.addEventListener("click", e => { if (busy) e.preventDefault(); });
    sw.input.addEventListener("change", async () => {
      const on = sw.input.checked;
      busy = true; sw.wrap.setAttribute("aria-busy", "true");
      c.active = on; sw.wrap.closest(".orow")?.classList.toggle("is-off", !on);
      try {
        await api(`/collections/${c.id}`, { method: "PUT", body: { active: on } });
        invalidate("collections");
        toast(on ? `${c.name} is live on the website` : `${c.name} is now hidden`);
      } catch (e) {
        c.active = !on; sw.input.checked = !on; sw.wrap.closest(".orow")?.classList.toggle("is-off", on);
        toastError(e);
      } finally { busy = false; sw.wrap.removeAttribute("aria-busy"); }
    });
    return sw.wrap;
  }
  await load();
}

function chaptersEditor(chapters, onChange) {
  let list = chapters.map(c => ({ key: nextId("ch"), title: c.title || "", text: c.text || "", img: c.img || "" }));
  const fields = new Map();
  const wrap = h("div", { class: "chapters" });
  const live = h("p", { class: "sr-only", "aria-live": "polite" });
  const addBtn = h("button", { type: "button", class: "btn btn-secondary", onclick: add }, icon("plus"), "Add chapter");
  const el = h("div", null, wrap, live, addBtn);
  const busy = () => [...fields.values()].some(f => f.image.busy());
  function paint(focus) {
    fields.clear();
    wrap.replaceChildren(...list.map((c, i) => {
      const title = field({ label: "Title", name: `ch-title-${i}`, maxlength: 120, value: c.title, placeholder: "e.g. Carved from devotion" });
      const text = field({ label: "Text", name: `ch-text-${i}`, type: "textarea", rows: 4, maxlength: 1000, counter: true, value: c.text });
      const image = imageField({ label: "Image", value: c.img, ratio: "4 / 5", slotLabel: "Story image 4:5", onChange: v => { c.img = v; onChange(); } });
      title.input.addEventListener("input", () => { c.title = title.value(); });
      text.input.addEventListener("input", () => { c.text = text.value(); });
      fields.set(c.key, { title, text, image });
      const up = iconBtn("arrow-up", `Move chapter ${i + 1} up`, () => move(i, i - 1, "up"), { disabled: i === 0 });
      const down = iconBtn("arrow-down", `Move chapter ${i + 1} down`, () => move(i, i + 1, "down"), { disabled: i === list.length - 1 });
      up.dataset.act = "up"; down.dataset.act = "down";
      return h("fieldset", { class: "chapter", dataset: { key: c.key } },
        h("legend", { class: "sr-only", text: `Chapter ${i + 1}` }),
        h("div", { class: "chapter-head" }, h("strong", { text: `Chapter ${i + 1}` }),
          h("div", { class: "ud" }, up, down, iconBtn("trash", `Remove chapter ${i + 1}`, () => remove(i), { class: "danger" }))),
        h("div", { class: "chapter-grid" }, h("div", null, title.wrap, text.wrap), image.el));
    }));
    if (!list.length) wrap.append(h("p", { class: "muted", text: "No chapters yet. Chapters tell the collection's story between the products." }));
    if (focus) focus();
  }
  function move(i, j, act) {
    if (j < 0 || j >= list.length) return;
    if (busy()) { toast("Wait for the photo upload to finish before reordering.", "info"); return; }
    const key = list[i].key;
    list = moveItem(list, i, j); paint(() => {
      const b = wrap.querySelector(`[data-key="${key}"] [data-act="${act}"]`);
      (b && !b.disabled ? b : wrap.querySelector(`[data-key="${key}"] [data-act="${act === "up" ? "down" : "up"}"]`))?.focus();
    });
    live.textContent = `Chapter moved to position ${j + 1}.`;
    onChange();
  }
  async function remove(i) {
    const c = list[i];
    if ((c.title || c.text || c.img) && !(await confirmDialog({ title: `Remove chapter ${i + 1}?`, message: "Its title, text and image will be removed when you save.", confirmLabel: "Remove chapter", danger: true }))) return;
    list.splice(i, 1); paint(); onChange();
    live.textContent = "Chapter removed.";
    addBtn.focus();
  }
  function add() {
    const c = { key: nextId("ch"), title: "", text: "", img: "" };
    list.push(c); paint(() => fields.get(c.key)?.title.input.focus()); onChange();
  }
  paint();
  return { el, value: () => list.map(({ title, text, img }) => ({ title: title.trim(), text: text.trim(), img })), busy };
}

export async function collectionEdit(ctx) {
  const id = ctx.params[0], isNew = id === "new";
  ctx.root.append(pageHead({ title: isNew ? "New collection" : "Loading collection", back: { href: "#/collections", label: "Collections" } }), skeletonForm());
  let coll;
  if (isNew) coll = normCollection({ name: "", slug: "", active: true, chapters: [] });
  else {
    const list = listOf(await api("/collections"), "collections").map(normCollection);
    coll = list.find(c => String(c.id) === id);
    if (!coll) throw Object.assign(new Error("We could not find that collection. It may have been deleted."), { status: 404 });
    if (coll.count == null) await fillCounts([coll], "collection");
  }
  if (!ctx.alive()) return;
  ctx.setTitle(isNew ? "New collection" : coll.name);

  const slugAuto = { on: isNew };
  const name = field({ label: "Name", name: "name", required: true, maxlength: 60, value: coll.name, placeholder: "e.g. Sanskriti", validate: v => v.trim() ? "" : "Enter a name." });
  const slug = field({ label: "Web address", name: "slug", maxlength: 60, value: coll.slug, prefix: "collection.html?c=", spellcheck: "false",
    hint: isNew ? "Filled in from the name." : "Changing this changes the page address. Update any Google Ads that link to it.",
    validate: v => !v || SLUG_RE.test(v) ? "" : "Use lowercase letters, numbers and single hyphens." });
  const kind = field({ label: "Type", name: "kind", maxlength: 60, value: coll.kind, placeholder: "e.g. Temple Jewellery", hint: "A short label shown above the name." });
  const short = field({ label: "Short line", name: "short", maxlength: 160, counter: true, value: coll.short, placeholder: "e.g. Temple jewellery for weddings and festivals.", hint: "Shown on collection cards." });
  const intro = field({ label: "Introduction", name: "intro", type: "textarea", rows: 5, maxlength: 1200, counter: true, value: coll.intro, hint: "Opens the collection page." });
  const quote = field({ label: "Quote", name: "quote", maxlength: 200, value: coll.quote, optional: true, placeholder: "e.g. Traditions carried forward, one generation to the next." });
  const hero = imageField({ label: "Hero image", value: coll.hero, ratio: "16 / 9", slotLabel: "Hero 16:9", hint: "Wide banner at the top of the collection page. Keep the subject in the right third.", onChange: () => wf.update() });
  const cover = imageField({ label: "Cover image", value: coll.cover, ratio: "3 / 4", slotLabel: "Cover 3:4", hint: "Portrait image for collection cards.", onChange: () => wf.update() });
  const chapters = chaptersEditor(coll.chapters, () => wf.update());
  const active = switchEl({ label: "Show on website", desc: "When off, the collection and its page are hidden.", checked: coll.active });
  name.input.addEventListener("input", () => { if (slugAuto.on) slug.set(slugify(name.value())); });
  slug.input.addEventListener("input", () => { slugAuto.on = isNew && !slug.value(); });
  slug.input.addEventListener("blur", () => { const v = slug.value().trim(); if (v && !SLUG_RE.test(v)) { slug.set(slugify(v)); slug.check(); } });

  const pvImg = h("div", { class: "frame" }), pvKind = h("span"), pvName = h("h3");
  const preview = h("div", { class: "coll-card", "aria-hidden": "true" }, pvImg, h("div", { class: "over" }, pvKind, pvName));
  const viewLink = h("a", { class: "btn btn-secondary", target: "_blank", rel: "noopener" }, icon("arrow-square-out"), h("span", { text: "View on site" }));
  const fr = editFrame({ formId: "coll-form", isNew, title: isNew ? "New collection" : coll.name, back: { href: "#/collections", label: "Collections" }, createLabel: "Create collection", actions: [viewLink] });
  const links = isNew ? null : h("section", { class: "card card-quiet" },
    h("a", { class: "btn btn-secondary btn-block", href: `#/products?collection=${encodeURIComponent(coll.slug)}` }, icon("diamond"), coll.count == null ? "See products" : `See ${plural(coll.count, "product")}`),
    h("a", { class: "btn btn-secondary btn-block", href: `#/products/new?collection=${encodeURIComponent(coll.slug)}` }, icon("plus"), "Add a product to it"),
    h("button", { type: "button", class: "btn btn-danger-ghost btn-block", onclick: del }, icon("trash"), "Delete collection"));
  const form = h("form", { id: "coll-form", class: "edit-grid", novalidate: true },
    h("div", { class: "col" },
      card("Details", name.wrap, slug.wrap, h("div", { class: "grid-2" }, kind.wrap, quote.wrap), short.wrap, intro.wrap),
      card("Images", h("div", { class: "stack" }, hero.el, cover.el)),
      card("Story chapters", h("p", { class: "muted small card-sub", text: "Chapters appear between the products on the collection page. Use them to tell the craft and the occasion." }), chapters.el)),
    h("div", { class: "col col-side" },
      card("Visibility", active.wrap),
      h("section", { class: "card" }, h("h2", { class: "card-title", text: "Preview" }), h("p", { class: "muted small card-sub", text: "The collection card on the website." }), h("div", { class: "preview-wrap narrow" }, preview)),
      links));
  ctx.root.replaceChildren(fr.head, form, fr.savebar);

  let pvKey = null;
  const paint = () => {
    pvKind.textContent = kind.value().trim();
    pvName.textContent = name.value().trim() || "Collection";
    const src = cover.value();
    if (src !== pvKey) { pvKey = src; pvImg.replaceChildren(src ? h("img", { src: imgSrc(src), alt: "" }) : h("div", { class: "slot", text: "Cover 3:4" })); }
    viewLink.hidden = isNew || !coll.active;
    if (!isNew) viewLink.href = `../collection.html?c=${encodeURIComponent(coll.slug)}`;
  };
  const values = () => ({ name: name.value().trim(), slug: slug.value().trim(), kind: kind.value().trim(), short: short.value().trim(), intro: intro.value().trim(), quote: quote.value().trim(),
    hero: hero.value(), cover: cover.value(), chapters: chapters.value(), active: active.input.checked });
  const wf = wireForm(ctx, form, {
    values, isNew, ss: fr.ss, busy: () => hero.busy() || cover.busy() || chapters.busy(), onUpdate: paint,
    save: async () => {
      if (!checkAll([name, slug])) return false;
      const body = values();
      let r;
      try { r = isNew ? await api("/collections", { method: "POST", body }) : await api(`/collections/${id}`, { method: "PUT", body }); }
      catch (e) { if (e.status === 409) slug.error(e.message); throw e; }
      const out = normCollection({ ...coll, ...body, ...(itemOf(r, "collection") || {}) });
      invalidate("collections");
      if (isNew) {
        ctx.isDirty = () => false;
        toast(`${out.name} created`);
        go(out.id != null ? `#/collections/${out.id}` : "#/collections", { replace: true });
        return true;
      }
      coll = out; if (out.slug !== slug.value()) slug.set(out.slug);
      fr.setTitle(out.name); ctx.setTitle(out.name); paint();
      toast("Saved");
      return true;
    }
  });
  async function del() {
    if (await deleteWithForce({ endpoint: "/collections", item: coll, count: coll.count, kind: "collection", unlinkText: "Those products stay in the admin without a collection." })) {
      ctx.isDirty = () => false; go("#/collections");
    }
  }
}
export { thumbEl };
