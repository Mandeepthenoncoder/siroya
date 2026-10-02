/* Siroya admin: shared helpers.
   DOM building (textContent only), the one escape helper, API client,
   toasts, dialogs, form fields, drag sorting and formatting. */

/* ---------------- DOM ---------------- */
export const $ = (q, el = document) => el.querySelector(q);
export const $$ = (q, el = document) => [...el.querySelectorAll(q)];

/** The single escape helper. Anything user supplied that has to pass through
    innerHTML goes through this. Prefer h() + textContent everywhere else. */
export const esc = s => String(s ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

const PROPS = new Set(["value", "checked", "disabled", "selected", "hidden", "indeterminate", "multiple", "required", "readOnly"]);

/** h("div", {class: "x", onclick: fn}, "text", child, [children]) */
export function h(tag, props, ...kids) {
  const el = document.createElement(tag);
  if (props) {
    for (const [k, v] of Object.entries(props)) {
      if (v == null || v === false) continue;
      if (k === "class") el.className = Array.isArray(v) ? v.filter(Boolean).join(" ") : v;
      else if (k === "text") el.textContent = v;
      else if (k === "dataset") Object.assign(el.dataset, v);
      else if (k === "style" && typeof v === "object") for (const [sk, sv] of Object.entries(v)) el.style.setProperty(sk, sv);
      else if (k.startsWith("on") && typeof v === "function") el.addEventListener(k.slice(2).toLowerCase(), v);
      else if (PROPS.has(k)) el[k] = v;
      else el.setAttribute(k, v === true ? "" : String(v));
    }
  }
  append(el, kids);
  return el;
}
function append(el, kids) {
  for (const k of kids) {
    if (k == null || k === false || k === true) continue;
    if (Array.isArray(k)) append(el, k);
    else el.append(k instanceof Node ? k : document.createTextNode(String(k)));
  }
}
/** replaceChildren that skips null / false (the DOM method would print "null"). */
export function fill(el, ...kids) {
  el.replaceChildren();
  append(el, kids);
  return el;
}
export const icon = (name, cls = "") => h("i", { class: `${name.startsWith("fill:") ? "ph-fill ph-" + name.slice(5) : "ph ph-" + name}${cls ? " " + cls : ""}`, "aria-hidden": "true" });
export function clear(el) { while (el.firstChild) el.firstChild.remove(); return el; }

let uid = 0;
export const nextId = (p = "f") => `${p}-${++uid}`;

/* ---------------- Formatting ---------------- */
export function slugify(s) {
  return String(s || "").normalize("NFKD").replace(/[̀-ͯ]/g, "").toLowerCase()
    .replace(/&/g, " and ").replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").replace(/-{2,}/g, "-").slice(0, 80).replace(/-+$/, "");
}
export const SLUG_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
export const plural = (n, one, many = one + "s") => `${n.toLocaleString("en-GB")} ${n === 1 ? one : many}`;
const parseDate = d => { if (!d) return null; const t = new Date(/^\d{4}-\d\d-\d\d \d/.test(d) ? d.replace(" ", "T") + (/[zZ]|[+-]\d\d:?\d\d$/.test(d) ? "" : "Z") : d); return isNaN(t) ? null : t; };
export const isOld = (d, days = 7) => { const t = parseDate(d); return !!t && Date.now() - t > days * 86400000; };
export function fmtTime(d) { const t = parseDate(d); return t ? new Intl.DateTimeFormat("en-GB", { hour: "2-digit", minute: "2-digit" }).format(t) : ""; }
export function fmtDate(d, withTime = true) {
  const t = parseDate(d); if (!t) return "";
  return new Intl.DateTimeFormat("en-GB", withTime ? { day: "numeric", month: "short", year: t.getFullYear() === new Date().getFullYear() ? undefined : "numeric", hour: "2-digit", minute: "2-digit" } : { day: "numeric", month: "short", year: "numeric" }).format(t);
}
export function timeAgo(d) {
  const t = parseDate(d); if (!t) return "";
  const s = Math.round((Date.now() - t) / 1000);
  if (s < 60) return "just now";
  if (s < 3600) return `${Math.floor(s / 60)} min ago`;
  if (s < 86400) return `${Math.floor(s / 3600)} h ago`;
  if (s < 86400 * 7) { const n = Math.floor(s / 86400); return n === 1 ? "yesterday" : `${n} days ago`; }
  return new Intl.DateTimeFormat("en-GB", { day: "numeric", month: "short", year: t.getFullYear() === new Date().getFullYear() ? undefined : "numeric" }).format(t);
}
export const digits = s => String(s || "").replace(/\D/g, "");
export function debounce(fn, ms) { let t; return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); }; }

/** Relative image paths are site-root relative; the admin lives at /admin/. */
export function imgSrc(p) {
  if (!p) return "";
  if (/^(https?:|data:|blob:|\/)/i.test(p)) return p;
  return "../" + p;
}
/** Only allow safe link targets for data coming from the database. */
export function safeHref(u) {
  const s = String(u || "").trim();
  if (!s) return "";
  if (/^(https?:|mailto:|tel:)/i.test(s)) return s;
  if (/^[a-z][a-z0-9+.-]*:/i.test(s)) return ""; // javascript:, data: and friends
  return s;
}

/* ---------------- API ---------------- */
export class ApiError extends Error {
  constructor(message, status = 0, data = null) { super(message); this.status = status; this.data = data; }
}
const STATUS_MSG = {
  400: "Some details are not valid. Please check and try again.",
  401: "Your session has ended. Please sign in again.",
  404: "We could not find that. It may have been deleted.",
  409: "That conflicts with something that already exists.",
  413: "That file is too large. Please use an image under 10 MB.",
  415: "The request was not accepted. Please reload the page.",
  429: "Too many attempts. Please wait a few minutes and try again."
};
export const errorText = (status, data) => (data && typeof data.error === "string" && data.error) || STATUS_MSG[status] || `Something went wrong (error ${status}). Please try again.`;

let authHandler = null; // set by admin.js: returns a promise that resolves once signed in again
export const setAuthHandler = fn => { authHandler = fn; };
export const ensureAuth = () => authHandler ? authHandler() : Promise.reject(new ApiError(STATUS_MSG[401], 401));

/** api("/products", {method, body, query}) talks to /api/admin by default. */
export async function api(path, { method = "GET", body, query, raw = false, auth = true } = {}) {
  let url = path.startsWith("/api/") ? path : "/api/admin" + path;
  if (query) {
    const qs = new URLSearchParams();
    for (const [k, v] of Object.entries(query)) if (v !== "" && v != null) qs.set(k, v);
    const s = qs.toString(); if (s) url += (url.includes("?") ? "&" : "?") + s;
  }
  const opts = { method, credentials: "same-origin", headers: { Accept: "application/json" } };
  if (method !== "GET" && method !== "HEAD") {
    opts.headers["Content-Type"] = "application/json";
    opts.body = JSON.stringify(body ?? {});
  }
  let res;
  try { res = await fetch(url, opts); }
  catch { throw new ApiError("Could not reach the server. Check your connection and try again.", 0); }
  if (raw) return res;
  const text = await res.text();
  let data = null;
  try { data = text ? JSON.parse(text) : null; } catch { data = null; }
  if (res.status === 401 && auth && authHandler) {
    await authHandler(); // throws if the person gives up
    return api(path, { method, body, query, raw, auth: false });
  }
  if (!res.ok) throw new ApiError(errorText(res.status, data), res.status, data);
  return data;
}
/** Lists may come back as a bare array or wrapped. */
export const listOf = (r, key) => Array.isArray(r) ? r : (r && (r.items || r[key] || r.data)) || [];
/** Single objects may come back bare or wrapped. */
export const itemOf = (r, key) => (r && (r.item || r[key] || r.data)) || r;

/* Cached lists for selects (categories, collections, stores). */
const cache = new Map();
export async function cached(key, loader, ttl = 30000) {
  const hit = cache.get(key);
  if (hit && Date.now() - hit.t < ttl) return hit.p;
  const p = loader().catch(e => { cache.delete(key); throw e; });
  cache.set(key, { t: Date.now(), p });
  return p;
}
export const invalidate = (...keys) => keys.length ? keys.forEach(k => cache.delete(k)) : cache.clear();
export const getCategories = () => cached("categories", async () => listOf(await api("/categories"), "categories").map(normCategory).sort((a, b) => a.sort - b.sort));
export const getCollections = () => cached("collections", async () => listOf(await api("/collections"), "collections").map(normCollection).sort((a, b) => a.sort - b.sort));

const bool = v => v === true || v === 1 || v === "1" || v === "true";
const countOf = o => {
  for (const k of ["product_count", "products_count", "productCount", "count", "products"]) if (typeof o[k] === "number") return o[k];
  return null;
};
export const normCategory = c => ({ ...c, image: c.image ?? c.img ?? "", description: c.description ?? "", featured: bool(c.featured), sort: Number(c.sort) || 0, count: countOf(c) });
export const normCollection = c => ({ ...c, kind: c.kind ?? "", short: c.short ?? "", intro: c.intro ?? "", quote: c.quote ?? "", hero: c.hero ?? "", cover: c.cover ?? "",
  chapters: Array.isArray(c.chapters) ? c.chapters : (() => { try { return JSON.parse(c.chapters || "[]"); } catch { return []; } })(),
  active: c.active == null ? true : bool(c.active), sort: Number(c.sort) || 0, count: countOf(c) });
export const normProduct = p => ({ ...p, handle: p.handle ?? (typeof p.id === "string" ? p.id : ""), code: p.code ?? "", collection: p.collection ?? "", category: p.category ?? "",
  metal: p.metal ?? "", weight: p.weight ?? "", stones: p.stones ?? "", description: p.description ?? "",
  images: Array.isArray(p.images) ? p.images : (() => { try { return JSON.parse(p.images || "[]"); } catch { return []; } })(),
  featured: bool(p.featured), status: p.status || "active" });
export const normStore = s => ({ ...s, address: s.address ?? "", hours: s.hours ?? "", phone: s.phone ?? "", map: s.map ?? "", image: s.image ?? s.img ?? "", sort: Number(s.sort) || 0 });

/* ---------------- Navigation ---------------- */
export const nav = { render: null, current: null };
/** Navigate inside the admin. {replace} swaps the history entry. */
export function go(hash, { replace = false } = {}) {
  if (replace) { history.replaceState(null, "", hash); nav.render?.(); }
  else if (location.hash === hash) nav.render?.();
  else location.hash = hash;
}

/* ---------------- Toasts ---------------- */
export function toast(message, type = "success", ms) {
  const box = $("#toasts");
  const t = h("div", { class: `toast toast-${type}`, role: type === "error" ? "alert" : "status" },
    icon(type === "error" ? "warning-circle" : type === "info" ? "info" : "check-circle"),
    h("span", { text: message }),
    h("button", { type: "button", class: "toast-x", "aria-label": "Dismiss", onclick: () => close() }, icon("x")));
  box.append(t);
  requestAnimationFrame(() => t.classList.add("in"));
  let timer = setTimeout(close, ms ?? (type === "error" ? 7000 : 3200));
  t.addEventListener("mouseenter", () => clearTimeout(timer));
  t.addEventListener("mouseleave", () => { timer = setTimeout(close, 2000); });
  function close() { clearTimeout(timer); t.classList.remove("in"); setTimeout(() => t.remove(), 250); }
  while (box.children.length > 4) box.firstElementChild.remove();
}
export const toastError = e => toast(e?.message || "Something went wrong. Please try again.", "error");

/* ---------------- Dialogs ---------------- */
/** Generic modal built on <dialog>. Resolves with the value of the button pressed (or null). */
export function modal({ title, body, actions = [], className = "", onOpen }) {
  return new Promise(resolve => {
    const titleId = nextId("dlg");
    const d = h("dialog", { class: `dlg ${className}`, "aria-labelledby": titleId });
    const form = h("form", { method: "dialog" },
      h("div", { class: "dlg-head" }, h("h2", { id: titleId, text: title }),
        h("button", { type: "submit", value: "", class: "icon-btn", "aria-label": "Close", formnovalidate: true }, icon("x"))),
      h("div", { class: "dlg-body" }, body),
      actions.length ? h("div", { class: "dlg-actions" }, actions.map(a =>
        h("button", { type: "submit", value: a.value, class: `btn ${a.class || "btn-secondary"}`, autofocus: a.autofocus || false, formnovalidate: a.value === "" || a.novalidate || false }, a.icon ? icon(a.icon) : null, a.label))) : null);
    d.append(form);
    form.addEventListener("submit", e => {
      const v = e.submitter?.value ?? "";
      d._result = v;
    });
    d.addEventListener("close", () => { resolve(d._result || null); d.remove(); });
    d.addEventListener("click", e => { if (e.target === d) d.close(); }); // backdrop click
    document.body.append(d);
    d.showModal();
    onOpen?.(d);
  });
}
/** confirmDialog({title, message, confirmLabel, danger}) -> Promise<boolean> */
export async function confirmDialog({ title, message, confirmLabel = "Confirm", cancelLabel = "Cancel", danger = false, icon: ic }) {
  const body = typeof message === "string" ? h("p", { text: message }) : message;
  const v = await modal({
    title, body, className: danger ? "dlg-danger" : "",
    actions: [{ value: "", label: cancelLabel, class: "btn-secondary", autofocus: true },
      { value: "ok", label: confirmLabel, class: danger ? "btn-danger" : "btn-primary", icon: ic }]
  });
  return v === "ok";
}

/* ---------------- Page parts ---------------- */
export function pageHead({ title, subtitle, back, actions = [], meta }) {
  return h("header", { class: "page-head" },
    back ? h("a", { class: "back", href: back.href }, icon("arrow-left"), back.label) : null,
    h("div", { class: "title-row" }, h("h1", { class: "page-title", text: title, tabindex: "-1" }), meta || null),
    subtitle ? h("p", { class: "page-sub", text: subtitle }) : null,
    actions.length ? h("div", { class: "page-actions" }, actions) : null);
}
export function emptyState({ icon: ic = "sparkle", title, text, action }) {
  return h("div", { class: "empty" },
    h("div", { class: "empty-ic" }, icon(ic)),
    h("h2", { text: title }),
    text ? h("p", { text }) : null,
    action ? (action.href
      ? h("a", { class: "btn btn-primary", href: action.href }, action.icon ? icon(action.icon) : null, action.label)
      : h("button", { type: "button", class: "btn btn-primary", onclick: action.onClick }, action.icon ? icon(action.icon) : null, action.label)) : null);
}
export function errorState(e, retry) {
  return h("div", { class: "empty empty-error", role: "alert" },
    h("div", { class: "empty-ic" }, icon("cloud-warning")),
    h("h2", { text: "This page could not load" }),
    h("p", { text: e?.message || "Something went wrong." }),
    retry ? h("button", { type: "button", class: "btn btn-secondary", onclick: retry }, icon("arrow-clockwise"), "Try again") : null);
}
export const skel = (cls = "") => h("span", { class: `skel ${cls}`, "aria-hidden": "true" });
export function skeletonList(n = 6, variant = "row") {
  return h("div", { class: `skel-list skel-${variant}`, role: "status", "aria-label": "Loading" },
    Array.from({ length: n }, () => h("div", { class: "skel-item" }, skel("sq"), h("div", { class: "skel-lines" }, skel("l1"), skel("l2")), skel("pill"))));
}
export function skeletonForm() {
  return h("div", { class: "edit-grid", role: "status", "aria-label": "Loading" },
    h("div", { class: "col" }, [0, 1].map(() => h("div", { class: "card" }, skel("h"), [0, 1, 2].map(() => h("div", { class: "skel-field" }, skel("lbl"), skel("inp")))))),
    h("div", { class: "col" }, h("div", { class: "card" }, skel("h"), skel("inp"), skel("inp"))));
}

/* ---------------- Forms ---------------- */
/** field({label, name, type, value, hint, required, maxlength, options, rows, counter, prefix})
    Returns {wrap, input, error(msg), value()} */
export function field(o) {
  const id = nextId(o.name || "f");
  const hintId = id + "-hint", errId = id + "-err";
  let input;
  if (o.type === "select") {
    input = h("select", { id, name: o.name, required: o.required || false },
      (o.options || []).map(op => h("option", { value: op.value, selected: String(op.value) === String(o.value ?? "") }, op.label)));
  } else if (o.type === "textarea") {
    input = h("textarea", { id, name: o.name, rows: o.rows || 4, maxlength: o.maxlength, placeholder: o.placeholder, required: o.required || false });
    input.value = o.value ?? "";
  } else {
    input = h("input", { id, name: o.name, type: o.type || "text", maxlength: o.maxlength, placeholder: o.placeholder, required: o.required || false,
      inputmode: o.inputmode, autocomplete: o.autocomplete || "off", spellcheck: o.spellcheck ?? null, list: o.list, pattern: o.pattern, enterkeyhint: o.enterkeyhint });
    input.value = o.value ?? "";
  }
  const describe = [o.hint ? hintId : null, errId].filter(Boolean).join(" ");
  input.setAttribute("aria-describedby", describe);
  const counter = o.counter && o.maxlength ? h("span", { class: "counter", "aria-live": "off" }) : null;
  const updCount = () => { if (counter) { const n = input.value.length; counter.textContent = `${n.toLocaleString("en-GB")} / ${Number(o.maxlength).toLocaleString("en-GB")}`; counter.classList.toggle("near", n > o.maxlength * 0.9); } };
  updCount(); input.addEventListener("input", updCount);
  const err = h("p", { class: "field-err", id: errId, hidden: true });
  const wrap = h("div", { class: ["field", o.class] },
    h("div", { class: "label-row" },
      h("label", { for: id }, o.label, o.required ? h("span", { class: "req", "aria-hidden": "true", text: " *" }) : null, o.optional ? h("span", { class: "opt", text: " (optional)" }) : null),
      counter),
    o.prefix ? h("div", { class: "affix" }, h("span", { class: "prefix", text: o.prefix }), input) : input,
    o.hint ? h("p", { class: "hint", id: hintId, text: o.hint }) : null,
    err);
  const api_ = {
    wrap, input,
    value: () => input.value,
    set(v) { input.value = v ?? ""; updCount(); },
    error(msg) {
      if (msg) { err.replaceChildren(icon("warning-circle"), document.createTextNode(" " + msg)); err.hidden = false; input.setAttribute("aria-invalid", "true"); wrap.classList.add("invalid"); }
      else { err.hidden = true; err.textContent = ""; input.removeAttribute("aria-invalid"); wrap.classList.remove("invalid"); }
      return !msg;
    }
  };
  if (o.validate) {
    const run = () => api_.error(o.validate(input.value));
    input.addEventListener("blur", () => { if (input.value || wrap.classList.contains("invalid")) run(); });
    input.addEventListener("input", () => { if (wrap.classList.contains("invalid")) run(); });
    api_.check = run;
  } else api_.check = () => true;
  return api_;
}
/** Accessible on/off switch. */
export function switchEl({ label, checked = false, desc, onChange, small = false, ariaLabel }) {
  const id = nextId("sw");
  const input = h("input", { type: "checkbox", role: "switch", id, checked, class: "sw-input", "aria-label": ariaLabel || null });
  if (desc) input.setAttribute("aria-describedby", id + "-d");
  if (onChange) input.addEventListener("change", () => onChange(input.checked, input));
  const wrap = h("label", { class: ["switch", small && "switch-sm"], for: id },
    input, h("span", { class: "sw-track", "aria-hidden": "true" }, h("span", { class: "sw-knob" })),
    label ? h("span", { class: "sw-text" }, h("span", { class: "sw-label", text: label }), desc ? h("span", { class: "sw-desc", id: id + "-d", text: desc }) : null) : null);
  return { wrap, input };
}
export const card = (title, ...kids) => h("section", { class: "card" }, title ? h("h2", { class: "card-title", text: title }) : null, ...kids);

/** Track whether an edit form differs from its saved state. */
export function dirtyTracker(snapshot) {
  let base = JSON.stringify(snapshot());
  return { isDirty: () => JSON.stringify(snapshot()) !== base, reset: () => { base = JSON.stringify(snapshot()); } };
}

/** Save button state helper used by edit pages (header + phone save bar). */
export function saveState(buttons, statusEls) {
  let state = "clean";
  const set = (s, text) => {
    state = s;
    buttons.forEach(b => {
      b.disabled = s === "saving";
      b.classList.toggle("is-saving", s === "saving");
      const ic = b.querySelector("i");
      if (ic) ic.className = s === "saving" ? "ph ph-spinner-gap" : "ph ph-check";
      const label = b.querySelector(".lbl");
      if (label) label.textContent = s === "saving" ? "Saving…" : (b.dataset.label || "Save");
    });
    statusEls.forEach(el => {
      el.dataset.state = s;
      el.replaceChildren(icon(s === "dirty" ? "circle" : s === "saving" ? "spinner-gap" : s === "error" ? "warning-circle" : "check-circle"),
        document.createTextNode(" " + (text || ({ clean: "All changes saved", dirty: "Unsaved changes", saving: "Saving…", error: "Not saved", new: "Not saved yet" }[s]))));
    });
  };
  return { set, get: () => state };
}

/** Header with save state + Save button, and the phone save bar. */
export function editFrame({ formId, isNew, title, back, saveLabel = "Save", createLabel = "Create", actions = [], meta }) {
  const label = isNew ? createLabel : saveLabel;
  const saveBtns = [0, 1].map(() => h("button", { type: "submit", class: "btn btn-primary", form: formId, dataset: { label } }, icon("check"), h("span", { class: "lbl", text: label })));
  const stateEls = [0, 1].map(() => h("span", { class: "save-state", role: "status" }));
  const ss = saveState(saveBtns, stateEls);
  const head = pageHead({ title, back, meta, actions: [stateEls[0], ...actions, saveBtns[0]] });
  const savebar = h("div", { class: "savebar" }, stateEls[1], saveBtns[1]);
  return { head, savebar, ss, setTitle: t => { $(".page-title", head).textContent = t; } };
}
/** Dirty tracking, unsaved-changes guard, Ctrl/Cmd+S and submit for an edit form. */
export function wireForm(ctx, form, { values, isNew, ss, busy = () => false, save, onUpdate }) {
  const tracker = dirtyTracker(values);
  const state = { saving: false };
  ctx.guard(() => tracker.isDirty() || busy());
  const update = () => { onUpdate?.(); if (!state.saving) ss.set(tracker.isDirty() ? "dirty" : isNew ? "new" : "clean"); };
  form.addEventListener("input", update);
  form.addEventListener("change", update);
  const run = async () => {
    if (state.saving) return;
    if (busy()) { toast("A photo is still uploading. Save again when it finishes.", "info"); return; }
    state.saving = true; ss.set("saving");
    try {
      const ok = await save();
      state.saving = false;
      if (ok === false) { ss.set(tracker.isDirty() ? "dirty" : isNew ? "new" : "clean"); return; }
      tracker.reset(); ss.set("clean");
    } catch (e) { state.saving = false; ss.set("error"); toastError(e); }
  };
  form.addEventListener("submit", e => { e.preventDefault(); run(); });
  const onKey = e => { if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "s") { e.preventDefault(); run(); } };
  document.addEventListener("keydown", onKey);
  ctx.onLeave(() => document.removeEventListener("keydown", onKey));
  update();
  return { tracker, update, state };
}
/** Validate a list of fields, focus the first bad one. */
export function checkAll(fields) {
  const bad = fields.map(f => [f, f.check()]).filter(([, ok]) => !ok).map(([f]) => f);
  if (bad.length) { bad[0].input.focus(); toast(bad.length > 1 ? "Please fix the highlighted fields." : "Please fix the highlighted field.", "error"); return false; }
  return true;
}

/* ---------------- Drag sorting ---------------- */
/** Rows (matching rowSel inside container) become draggable by their [data-handle].
    onMove(fromIndex, toIndex) is called after a drop. Touch users use the up/down buttons. */
export function dragSort(container, rowSel, onMove) {
  let dragEl = null;
  const rows = () => $$(rowSel, container);
  container.addEventListener("pointerdown", e => {
    const handle = e.target.closest("[data-handle]");
    const row = handle?.closest(rowSel);
    if (row && e.pointerType === "mouse") row.draggable = true;
  });
  container.addEventListener("pointerup", () => rows().forEach(r => { if (r !== dragEl) r.draggable = false; }));
  container.addEventListener("dragstart", e => {
    const row = e.target.closest?.(rowSel);
    if (!row || !row.draggable) return;
    dragEl = row; row.classList.add("dragging");
    e.dataTransfer.effectAllowed = "move";
    try { e.dataTransfer.setData("text/plain", "row"); } catch { /* old browsers */ }
  });
  const clearMarks = () => rows().forEach(r => r.classList.remove("drop-before", "drop-after"));
  container.addEventListener("dragover", e => {
    if (!dragEl) return;
    const row = e.target.closest(rowSel);
    e.preventDefault(); e.dataTransfer.dropEffect = "move";
    clearMarks();
    if (!row || row === dragEl) return;
    const r = row.getBoundingClientRect();
    row.classList.add(e.clientY < r.top + r.height / 2 ? "drop-before" : "drop-after");
  });
  container.addEventListener("dragleave", e => { if (!container.contains(e.relatedTarget)) clearMarks(); });
  container.addEventListener("drop", e => {
    if (!dragEl) return;
    e.preventDefault();
    const list = rows();
    const target = e.target.closest(rowSel);
    const from = list.indexOf(dragEl);
    let to = from;
    if (target && target !== dragEl) {
      const r = target.getBoundingClientRect();
      to = list.indexOf(target) + (e.clientY < r.top + r.height / 2 ? 0 : 1);
      if (to > from) to -= 1;
    }
    clearMarks();
    if (to !== from) onMove(from, to);
  });
  container.addEventListener("dragend", () => {
    clearMarks();
    if (dragEl) { dragEl.classList.remove("dragging"); dragEl.draggable = false; }
    dragEl = null;
  });
}
export function moveItem(arr, from, to) { const a = arr.slice(); const [x] = a.splice(from, 1); a.splice(to, 0, x); return a; }

/** Small icon-only button with a tooltip-like label. */
export const iconBtn = (ic, label, onclick, extra = {}) => h("button", { type: "button", class: `icon-btn ${extra.class || ""}`, "aria-label": label, title: label, onclick, disabled: extra.disabled || false }, icon(ic));

/** Status chip for products. */
export const STATUS = { active: "Active", draft: "Draft", archived: "Archived" };
export const statusChip = s => h("span", { class: `chip chip-${STATUS[s] ? s : "draft"}` }, STATUS[s] || s || "Draft");
