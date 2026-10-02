/* Siroya admin: entry point.
   Boot and sign in, app shell (sidebar on desktop, tab bar on phones),
   hash router with an unsaved-changes guard, and the dashboard. */
import { $, $$, h, icon, clear, api, ApiError, setAuthHandler, nav, modal, confirmDialog, pageHead, errorState, skel, plural, timeAgo, emptyState, invalidate } from "./lib.js";
import { productsList, productEdit } from "./products.js";
import { categoriesList, categoryEdit, collectionsList, collectionEdit } from "./catalog.js";
import { storesList, storeEdit, leadsView, settingsView, leadContact } from "./more.js";

const app = $("#app");
const LOGO = "../assets/img/logo/siroya-red.png";

const NAV = [
  { key: "dashboard", href: "#/", label: "Dashboard", short: "Home", icon: "house", tab: true },
  { key: "products", href: "#/products", label: "Products", icon: "diamond", tab: true },
  { key: "categories", href: "#/categories", label: "Categories", icon: "squares-four", tab: true },
  { key: "collections", href: "#/collections", label: "Collections", icon: "crown-simple" },
  { key: "stores", href: "#/stores", label: "Stores", icon: "storefront" },
  { key: "leads", href: "#/leads", label: "Leads", icon: "chat-circle-text", tab: true },
  { key: "settings", href: "#/settings", label: "Settings", icon: "gear-six" }
];

const ROUTES = [
  { re: /^\/?$/, view: dashboard, nav: "dashboard", title: "Dashboard" },
  { re: /^\/products$/, view: productsList, nav: "products", title: "Products" },
  { re: /^\/products\/(new|\d+)$/, view: productEdit, nav: "products", title: "Product", detail: true },
  { re: /^\/categories$/, view: categoriesList, nav: "categories", title: "Categories" },
  { re: /^\/categories\/(new|\d+)$/, view: categoryEdit, nav: "categories", title: "Category", detail: true },
  { re: /^\/collections$/, view: collectionsList, nav: "collections", title: "Collections" },
  { re: /^\/collections\/(new|\d+)$/, view: collectionEdit, nav: "collections", title: "Collection", detail: true },
  { re: /^\/stores$/, view: storesList, nav: "stores", title: "Stores" },
  { re: /^\/stores\/(new|\d+)$/, view: storeEdit, nav: "stores", title: "Store", detail: true },
  { re: /^\/leads$/, view: leadsView, nav: "leads", title: "Leads" },
  { re: /^\/settings$/, view: settingsView, nav: "settings", title: "Settings", form: true }
];

/* ---------------- Boot ---------------- */
async function boot() {
  try {
    await api("/me", { auth: false });
    shell();
  } catch (e) {
    if (e.status === 401) login();
    else showFatal(e);
  } finally { app.removeAttribute("aria-busy"); }
}
function showFatal(e) {
  clear(app).append(h("main", { class: "login" },
    h("div", { class: "login-card" },
      h("img", { class: "login-logo", src: LOGO, alt: "Siroya Jewellers", width: 180, height: 70 }),
      errorState(e.status === 429 || e.status >= 500 ? e : new ApiError("The admin server is not responding. Make sure the Siroya server is running (npm start in the project folder), then try again."), () => { clear(app); boot(); }))));
}

/* ---------------- Sign in ---------------- */
function passwordField(id) {
  const input = h("input", { id, name: "password", type: "password", autocomplete: "current-password", required: true, enterkeyhint: "go", "aria-describedby": id + "-err" });
  const toggle = h("button", { type: "button", class: "icon-btn pw-toggle", "aria-label": "Show password", "aria-pressed": "false",
    onclick: () => {
      const show = input.type === "password";
      input.type = show ? "text" : "password";
      toggle.setAttribute("aria-pressed", String(show));
      toggle.setAttribute("aria-label", show ? "Hide password" : "Show password");
      toggle.replaceChildren(icon(show ? "eye-slash" : "eye"));
      input.focus();
    } }, icon("eye"));
  const err = h("p", { class: "field-err", id: id + "-err", role: "alert", hidden: true });
  const wrap = h("div", { class: "field" }, h("label", { for: id, text: "Password" }), h("div", { class: "pw-wrap" }, input, toggle), err);
  return {
    wrap, input,
    error(msg) {
      err.hidden = !msg; err.replaceChildren(...(msg ? [icon("warning-circle"), document.createTextNode(" " + msg)] : []));
      wrap.classList.toggle("invalid", !!msg);
      msg ? input.setAttribute("aria-invalid", "true") : input.removeAttribute("aria-invalid");
    }
  };
}
async function attemptLogin(password) {
  try { await api("/login", { method: "POST", body: { password }, auth: false }); return null; }
  catch (e) {
    if (e.status === 401) return e.data?.error || "That password is not right. Please try again.";
    if (e.status === 429) return e.data?.error || "Too many attempts. Please wait 15 minutes and try again.";
    return e.message;
  }
}
function login(message) {
  document.title = "Sign in | Siroya Admin";
  const pw = passwordField("login-pw");
  const btn = h("button", { type: "submit", class: "btn btn-primary btn-block" }, h("span", { class: "lbl", text: "Sign in" }), icon("arrow-right"));
  const form = h("form", { class: "login-card", novalidate: true },
    h("img", { class: "login-logo", src: LOGO, alt: "Siroya Jewellers", width: 180, height: 70 }),
    h("h1", { text: "Store admin" }),
    h("p", { class: "muted", text: message || "Sign in to manage products, categories and enquiries." }),
    pw.wrap, btn);
  form.addEventListener("submit", async e => {
    e.preventDefault();
    const v = pw.input.value;
    if (!v) { pw.error("Enter the admin password."); pw.input.focus(); return; }
    pw.error("");
    btn.disabled = true; btn.querySelector(".lbl").textContent = "Signing in…";
    const err = await attemptLogin(v);
    if (!err) { shell(); return; }
    btn.disabled = false; btn.querySelector(".lbl").textContent = "Sign in";
    pw.error(err); pw.input.select();
  });
  clear(app).append(h("main", { class: "login" }, form, h("a", { class: "login-back", href: "../" }, icon("arrow-left"), "Back to the website")));
  pw.input.focus();
}

/* Session ended in the middle of work: sign in again in a dialog so nothing is lost. */
let reauthing = null;
function reauth() {
  if (!$(".shell")) return Promise.reject(new ApiError("Please sign in.", 401));
  return reauthing ||= new Promise((resolve, reject) => {
    const pw = passwordField("reauth-pw");
    const btn = h("button", { type: "submit", class: "btn btn-primary" }, h("span", { class: "lbl", text: "Sign in" }));
    const d = h("dialog", { class: "dlg", "aria-labelledby": "reauth-t" });
    let done = false;
    const form = h("form", { novalidate: true },
      h("div", { class: "dlg-head" }, h("h2", { id: "reauth-t", text: "Please sign in again" })),
      h("div", { class: "dlg-body" }, h("p", { text: "Your session has ended. Enter the admin password to carry on. Anything you have not saved is still here." }), pw.wrap),
      h("div", { class: "dlg-actions" }, h("button", { type: "button", class: "btn btn-secondary", onclick: () => d.close() }, "Sign out"), btn));
    form.addEventListener("submit", async e => {
      e.preventDefault();
      if (!pw.input.value) { pw.error("Enter the admin password."); return; }
      btn.disabled = true; btn.querySelector(".lbl").textContent = "Signing in…";
      const err = await attemptLogin(pw.input.value);
      btn.disabled = false; btn.querySelector(".lbl").textContent = "Sign in";
      if (err) { pw.error(err); pw.input.select(); return; }
      done = true; d.close(); resolve();
    });
    d.addEventListener("cancel", e => e.preventDefault()); // Esc should not silently drop work
    d.addEventListener("close", () => {
      d.remove(); reauthing = null;
      if (!done) { reject(new ApiError("Signed out.", 401)); if (nav.current) nav.current.isDirty = () => false; login("You have been signed out."); }
    });
    d.append(form); document.body.append(d); d.showModal(); pw.input.focus();
  });
}
setAuthHandler(reauth);

/* ---------------- Shell ---------------- */
let view;
function shell() {
  document.title = "Siroya Admin";
  const sideLinks = NAV.map(n => h("a", { href: n.href, class: "side-link", dataset: { nav: n.key } }, icon(n.icon), h("span", { text: n.label })));
  const tabLinks = NAV.filter(n => n.tab).map(n => h("a", { href: n.href, class: "tab", dataset: { nav: n.key } }, icon(n.icon), h("span", { text: n.short || n.label })));
  const moreKeys = NAV.filter(n => !n.tab).map(n => n.key);
  const moreBtn = h("button", { type: "button", class: "tab", dataset: { more: moreKeys.join(" ") }, "aria-haspopup": "dialog", onclick: openMore }, icon("dots-three-outline"), h("span", { text: "More" }));
  view = h("main", { id: "view", class: "view", tabindex: "-1" });
  clear(app).append(h("div", { class: "shell" },
    h("aside", { class: "sidebar" },
      h("a", { class: "brand", href: "#/", "aria-label": "Siroya admin home" }, h("img", { src: LOGO, alt: "Siroya Jewellers", width: 132, height: 51 }), h("span", { class: "brand-tag", text: "Admin" })),
      h("nav", { class: "side-nav", "aria-label": "Main" }, sideLinks),
      h("div", { class: "side-foot" },
        h("a", { class: "side-link", href: "../", target: "_blank", rel: "noopener" }, icon("arrow-square-out"), h("span", { text: "View website" })),
        h("button", { type: "button", class: "side-link", onclick: logout }, icon("sign-out"), h("span", { text: "Log out" })))),
    h("header", { class: "topbar" },
      h("a", { class: "brand", href: "#/", "aria-label": "Siroya admin home" }, h("img", { src: LOGO, alt: "Siroya Jewellers", width: 96, height: 37 }), h("span", { class: "brand-tag", text: "Admin" })),
      h("a", { class: "icon-btn", href: "../", target: "_blank", rel: "noopener", "aria-label": "View website", title: "View website" }, icon("arrow-square-out"))),
    view,
    h("nav", { class: "tabbar", "aria-label": "Main" }, tabLinks, moreBtn)));
  render();
}
function openMore() {
  const items = NAV.filter(n => !n.tab);
  const body = h("div", { class: "sheet-list" },
    items.map(n => h("a", { href: n.href, class: "sheet-link", onclick: () => d().close() }, icon(n.icon), h("span", { text: n.label }), icon("caret-right", "chev"))),
    h("a", { href: "../", target: "_blank", rel: "noopener", class: "sheet-link" }, icon("arrow-square-out"), h("span", { text: "View website" })),
    h("button", { type: "button", class: "sheet-link", onclick: () => { d().close(); logout(); } }, icon("sign-out"), h("span", { text: "Log out" })));
  const d = () => body.closest("dialog");
  modal({ title: "More", body, className: "sheet" });
}
async function logout() {
  if (nav.current?.isDirty?.() && !(await confirmLeave())) return;
  try { await api("/logout", { method: "POST", body: {}, auth: false }); } catch { /* signing out locally anyway */ }
  invalidate();
  if (nav.current) nav.current.isDirty = () => false;
  login("You have signed out.");
  history.replaceState(null, "", "#/");
}

/* ---------------- Router ---------------- */
let token = 0;
let lastHash = location.hash || "#/";
function parseHash() {
  const raw = decodeURI(location.hash.slice(1) || "/");
  const [path, qs = ""] = raw.split("?");
  return { path, query: Object.fromEntries(new URLSearchParams(qs)) };
}
async function render() {
  if (!view || !view.isConnected) return;
  const { path, query } = parseHash();
  const route = ROUTES.find(r => r.re.test(path));
  if (!route) { history.replaceState(null, "", "#/"); return render(); }
  const prev = nav.current;
  prev?.cleanup.forEach(fn => { try { fn(); } catch { /* ignore */ } });
  const my = ++token;
  const ctx = {
    params: path.match(route.re).slice(1), query, root: view, route,
    alive: () => my === token,
    isDirty: () => false,
    cleanup: [],
    onLeave(fn) { this.cleanup.push(fn); },
    guard(fn) { this.isDirty = fn; },
    setTitle(t) { document.title = `${t} | Siroya Admin`; }
  };
  nav.current = ctx;
  lastHash = location.hash || "#/";
  $$("[data-nav]").forEach(a => {
    const on = a.dataset.nav === route.nav;
    a.classList.toggle("active", on);
    on ? a.setAttribute("aria-current", "page") : a.removeAttribute("aria-current");
  });
  $$("[data-more]").forEach(b => b.classList.toggle("active", b.dataset.more.split(" ").includes(route.nav)));
  document.body.classList.toggle("is-detail", !!route.detail);
  document.body.classList.toggle("has-savebar", !!(route.detail || route.form));
  ctx.setTitle(route.title);
  clear(view);
  const samePage = prev && prev.route === route && !route.detail;
  if (!samePage) window.scrollTo(0, 0);
  try { await route.view(ctx); }
  catch (e) {
    if (!ctx.alive()) return;
    if (e.status === 401) return;
    clear(view).append(errorState(e, () => render()));
  }
  if (ctx.alive() && !samePage && prev) $("h1", view)?.focus({ preventScroll: true });
}
nav.render = render;

function confirmLeave() {
  return confirmDialog({ title: "Leave without saving?", message: "You have changes that are not saved yet. If you leave now they will be lost.", confirmLabel: "Leave without saving", cancelLabel: "Keep editing", danger: true });
}
// Links inside the app: ask before leaving a page with unsaved changes.
document.addEventListener("click", async e => {
  const a = e.target.closest("a[href^='#/']");
  if (!a || e.defaultPrevented || e.metaKey || e.ctrlKey || e.shiftKey || e.button !== 0) return;
  const href = a.getAttribute("href");
  if (href === location.hash && !nav.current?.isDirty?.()) { e.preventDefault(); render(); return; }
  if (!nav.current?.isDirty?.()) return;
  e.preventDefault();
  if (await confirmLeave()) { nav.current.isDirty = () => false; location.hash = href; }
}, true);
// Back and forward buttons.
window.addEventListener("hashchange", async () => {
  if (nav.current?.isDirty?.()) {
    const target = location.hash;
    history.pushState(null, "", lastHash);
    if (!(await confirmLeave())) return;
    nav.current.isDirty = () => false;
    location.hash = target;
    return;
  }
  render();
});
window.addEventListener("beforeunload", e => { if (nav.current?.isDirty?.()) { e.preventDefault(); e.returnValue = ""; } });

/* ---------------- Dashboard ---------------- */
function greeting() {
  const hr = new Date().getHours();
  return hr < 12 ? "Good morning" : hr < 17 ? "Good afternoon" : "Good evening";
}
async function dashboard(ctx) {
  const today = new Intl.DateTimeFormat("en-GB", { weekday: "long", day: "numeric", month: "long" }).format(new Date());
  const statsBox = h("div", { class: "stats" }, Array.from({ length: 4 }, () => h("div", { class: "stat-card" }, skel("l2"), skel("big"), skel("l1"))));
  const leadsBox = h("div", { class: "card-pad" }, Array.from({ length: 4 }, () => h("div", { class: "skel-item" }, h("div", { class: "skel-lines" }, skel("l1"), skel("l2")))));
  const quick = [
    { href: "#/products/new", icon: "plus-circle", label: "Add a product", text: "Photos, details and description" },
    { href: "#/categories", icon: "squares-four", label: "Homepage categories", text: "Choose what shows in Find your design" },
    { href: "#/collections", icon: "crown-simple", label: "Collections", text: "Stories, heroes and chapters" },
    { href: "/api/admin/leads.csv", icon: "file-csv", label: "Export leads", text: "Download every enquiry as CSV", download: true },
    { href: "../", icon: "arrow-square-out", label: "View website", text: "See the live site in a new tab", external: true }
  ];
  ctx.root.append(
    pageHead({ title: greeting(), subtitle: today }),
    statsBox,
    h("div", { class: "dash-grid" },
      h("section", { class: "card" },
        h("div", { class: "card-head" }, h("h2", { class: "card-title", text: "Latest leads" }), h("a", { class: "link", href: "#/leads" }, "View all", icon("arrow-right"))),
        leadsBox),
      h("section", { class: "card" },
        h("h2", { class: "card-title", text: "Quick actions" }),
        h("ul", { class: "quick" }, quick.map(q => h("li", null,
          h("a", { href: q.href, class: "quick-link", target: q.external ? "_blank" : null, rel: q.external ? "noopener" : null, download: q.download ? "" : null },
            h("span", { class: "quick-ic" }, icon(q.icon)),
            h("span", { class: "quick-text" }, h("strong", { text: q.label }), h("span", { class: "muted small", text: q.text })),
            icon("caret-right", "chev"))))))));

  const [stats, leads] = await Promise.allSettled([api("/stats"), api("/leads", { query: { page: 1, per: 5 } })]);
  if (!ctx.alive()) return;
  if (stats.status === "fulfilled") {
    const s = stats.value || {};
    const p = s.products || {};
    const num = v => Number(v || 0);
    const cards = [
      { href: "#/products", icon: "diamond", label: "Live products", value: num(p.active), note: `${plural(num(p.draft), "draft")}, ${num(p.archived)} archived` },
      { href: "#/categories", icon: "squares-four", label: "Categories", value: num(s.categories), note: "Necklaces, rings and more" },
      { href: "#/collections", icon: "crown-simple", label: "Collections", value: num(s.collections), note: "Storyline pages" },
      { href: "#/leads", icon: "chat-circle-text", label: "Leads", value: num(s.leads?.total), note: `${num(s.leads?.last7)} in the last 7 days`, accent: num(s.leads?.last7) > 0 }
    ];
    statsBox.replaceChildren(...cards.map(c => h("a", { class: ["stat-card", c.accent && "accent"], href: c.href },
      h("span", { class: "stat-label" }, icon(c.icon), c.label),
      h("strong", { class: "stat-value", text: c.value.toLocaleString("en-GB") }),
      h("span", { class: "stat-note", text: c.note }))));
  } else {
    if (stats.reason?.status === 401) return;
    statsBox.replaceChildren(h("div", { class: "card card-pad muted" }, icon("warning-circle"), " Numbers could not load. ", stats.reason?.message || ""));
  }
  if (leads.status === "fulfilled") {
    const items = (leads.value?.items || []).slice(0, 5);
    leadsBox.replaceChildren(items.length
      ? h("ul", { class: "mini-leads" }, items.map(l => h("li", null,
        h("div", { class: "ml-main" },
          h("strong", { text: l.name || "No name" }),
          h("span", { class: "muted small", text: [l.product, l.store].filter(Boolean).join(", ") || "General enquiry" })),
        h("div", { class: "ml-side" }, h("span", { class: "muted small", text: timeAgo(l.created_at) }), leadContact(l, true)))))
      : emptyState({ icon: "chat-circle-text", title: "No leads yet", text: "WhatsApp enquiries from product pages will appear here." }));
  } else if (leads.reason?.status !== 401) {
    leadsBox.replaceChildren(h("p", { class: "muted" }, leads.reason?.message || "Leads could not load."));
  }
}

boot();
