/* Siroya admin: traffic.
   Three entry points:
   - renderDashboardTraffic: the "Last 7 days" cards at the top of the dashboard,
   - renderTrafficPage: #/traffic with the Website, Google Search and Google Analytics tabs,
   - renderGoogleSettings: the Google connection section in Settings.
   Charts are hand-built SVG with a keyboard path (arrow keys move between days)
   and a data table for screen readers. Everything that comes from the server goes
   in through textContent or setAttribute (h() and svg()), never innerHTML. */
import { h, fill, icon, api, cached, invalidate, toast, toastError, confirmDialog, emptyState, skel, timeAgo, fmtDate, nextId, debounce } from "./lib.js";

/* ======================= Formatting ======================= */
const LOCALE = "en-GB";
const NF0 = new Intl.NumberFormat(LOCALE, { maximumFractionDigits: 0 });
const NF1 = new Intl.NumberFormat(LOCALE, { minimumFractionDigits: 1, maximumFractionDigits: 1 });
const NFT = new Intl.NumberFormat(LOCALE, { maximumFractionDigits: 1 }); // axis ticks: 2.5%, 4%
const num = v => { const n = Number(v); return Number.isFinite(n) ? n : 0; };
/** Rates arrive as fractions (0.034). A value above 1 is taken as a percentage already. */
const frac = v => { const n = num(v); return n > 1 ? n / 100 : n; };
const fmtInt = v => NF0.format(Math.round(num(v)));
const fmtPct = v => NF1.format(frac(v) * 100) + "%";
const fmtPos = v => num(v) > 0 ? NF1.format(num(v)) : "–";
/** Duration for a stat card: numbers in the display face, units small in the text face. */
function durValue(v) {
  const s = Math.max(0, Math.round(num(v)));
  const m = Math.floor(s / 60);
  const unit = u => h("span", { class: "tr-unit", text: u });
  return m ? [String(m), unit("m"), " ", String(s % 60).padStart(2, "0"), unit("s")] : [String(s), unit("s")];
}
function fmtDur(v) {
  const s = Math.max(0, Math.round(num(v)));
  const m = Math.floor(s / 60);
  return m ? `${m}m ${String(s % 60).padStart(2, "0")}s` : `${s}s`;
}

/* Every number the traffic screens show. kind drives deltas and the chart scale:
   count = relative change, rate = change in percentage points,
   position = lower is better (axis upside down, improvement shown as up). */
const METRICS = {
  visitors: { label: "Visitors", icon: "users", fmt: fmtInt, kind: "count" },
  page_views: { label: "Page views", icon: "browser", fmt: fmtInt, kind: "count" },
  whatsapp_clicks: { label: "WhatsApp clicks", short: "WhatsApp", phone: "WhatsApp", icon: "whatsapp-logo", fmt: fmtInt, kind: "count" },
  leads: { label: "Enquiries", icon: "chat-circle-text", fmt: fmtInt, kind: "count" },
  conversion_rate: { label: "Conversion rate", phone: "Conversion", icon: "target", fmt: fmtPct, kind: "rate", hint: "Visitors who tapped WhatsApp or sent an enquiry" },
  clicks: { label: "Clicks", icon: "cursor-click", fmt: fmtInt, kind: "count" },
  impressions: { label: "Impressions", icon: "eye", fmt: fmtInt, kind: "count" },
  ctr: { label: "Average CTR", short: "CTR", phone: "Avg. CTR", chart: "Click-through rate", icon: "percent", fmt: fmtPct, kind: "rate" },
  position: { label: "Average position", short: "Position", phone: "Avg. position", chart: "Average position", icon: "ranking", fmt: fmtPos, kind: "position" },
  activeUsers: { label: "Active users", icon: "users", fmt: fmtInt, kind: "count" },
  newUsers: { label: "New users", icon: "user-plus", fmt: fmtInt, kind: "count" },
  sessions: { label: "Sessions", icon: "browsers", fmt: fmtInt, kind: "count" },
  engagementRate: { label: "Engagement rate", phone: "Engagement", icon: "hand-tap", fmt: fmtPct, kind: "rate" },
  averageSessionDuration: { label: "Session time", icon: "timer", fmt: fmtDur, kind: "count", duration: true, hint: "Average time per session" }
};

/* ---------------- Dates (YYYY-MM-DD, handled in UTC so nothing shifts a day) ---------------- */
const DAY = 86400000;
const normDate = d => { const s = String(d ?? ""); return /^\d{8}$/.test(s) ? `${s.slice(0, 4)}-${s.slice(4, 6)}-${s.slice(6)}` : s.slice(0, 10); };
const utc = s => { const [y, m, d] = normDate(s).split("-").map(Number); return Date.UTC(y || 1970, (m || 1) - 1, d || 1); };
const addDays = (s, n) => new Date(utc(s) + n * DAY).toISOString().slice(0, 10);
const DF_SHORT = new Intl.DateTimeFormat(LOCALE, { day: "numeric", month: "short", timeZone: "UTC" });
const DF_YEAR = new Intl.DateTimeFormat(LOCALE, { day: "numeric", month: "short", year: "numeric", timeZone: "UTC" });
const DF_DAY = new Intl.DateTimeFormat(LOCALE, { weekday: "short", day: "numeric", month: "short", timeZone: "UTC" });
const DF_FULL = new Intl.DateTimeFormat(LOCALE, { weekday: "long", day: "numeric", month: "long", year: "numeric", timeZone: "UTC" });
const shortDate = s => DF_SHORT.format(utc(s));
const dayDate = s => DF_DAY.format(utc(s));
const fullDate = s => DF_FULL.format(utc(s));
function periodText(from, to) {
  if (!from || !to) return "";
  const a = normDate(from), b = normDate(to);
  return a.slice(0, 4) === b.slice(0, 4) ? `${shortDate(a)} to ${DF_YEAR.format(utc(b))}` : `${DF_YEAR.format(utc(a))} to ${DF_YEAR.format(utc(b))}`;
}

/* ---------------- Names ---------------- */
/** Own keys only. Names from the server (a utm_source, a device, a country code)
    must never reach Object.prototype: "constructor" or "__proto__" would come back
    as a function or an object instead of a [label, icon] pair. */
const own = (map, k) => Object.prototype.hasOwnProperty.call(map, k) ? map[k] : undefined;
const SOURCES = {
  direct: ["Direct", "arrow-square-in"], google_organic: ["Google search", "google-logo"], google_ads: ["Google Ads", "megaphone-simple"],
  other_search: ["Other search engines", "magnifying-glass"], social: ["Social media", "share-network"], whatsapp: ["WhatsApp", "whatsapp-logo"],
  referral: ["Other websites", "link-simple"], instagram: ["Instagram", "instagram-logo"], facebook: ["Facebook", "facebook-logo"],
  youtube: ["YouTube", "youtube-logo"], tiktok: ["TikTok", "tiktok-logo"], newsletter: ["Newsletter", "envelope-simple"], email: ["Email", "envelope-simple"]
};
const CHANNEL_ICONS = { "organic search": "google-logo", "paid search": "megaphone-simple", direct: "arrow-square-in", "organic social": "share-network", "paid social": "share-network",
  referral: "link-simple", email: "envelope-simple", "organic shopping": "shopping-bag", "paid shopping": "shopping-bag", "cross-network": "signpost", unassigned: "question", "organic video": "youtube-logo" };
const DEVICES = { mobile: ["Mobile", "device-mobile"], tablet: ["Tablet", "device-tablet"], desktop: ["Desktop", "desktop"] };
const A3 = { are: "AE", ind: "IN", gbr: "GB", usa: "US", sau: "SA", omn: "OM", qat: "QA", kwt: "KW", bhr: "BH", pak: "PK", can: "CA", aus: "AU", deu: "DE", fra: "FR",
  sgp: "SG", lka: "LK", npl: "NP", bgd: "BD", egy: "EG", jor: "JO", lbn: "LB", irn: "IR", tur: "TR", rus: "RU", chn: "CN", phl: "PH", mys: "MY", idn: "ID", zaf: "ZA",
  ken: "KE", nga: "NG", nld: "NL", ita: "IT", esp: "ES", che: "CH", irl: "IE", nzl: "NZ", jpn: "JP", kor: "KR", hkg: "HK", tha: "TH", bra: "BR", mex: "MX", bel: "BE", swe: "SE" };
let REGIONS = null;
try { REGIONS = new Intl.DisplayNames([LOCALE], { type: "region" }); } catch { /* old browser: show the code */ }
function countryName(c) {
  const s = String(c ?? "").trim();
  if (!s || /^zz/i.test(s)) return "Unknown region";
  const a2 = s.length === 2 ? s.toUpperCase() : own(A3, s.toLowerCase());
  try { return (a2 && REGIONS?.of(a2)) || s.toUpperCase(); } catch { return s.toUpperCase(); }
}

/* ======================= Data ======================= */
const TTL = { traffic: 60000, search: 5 * 60000, analytics: 5 * 60000 };
const GOOGLE_KEYS = ["search:7", "search:28", "search:90", "analytics:7", "analytics:30", "analytics:90"];
/* The API sends previous-period totals only. For the dashed comparison line the
   page borrows the daily rows of the next longer range, which always covers the
   previous period (7 inside 30, 30 inside 90, 28 inside 90). */
const LONGER = { traffic: { 7: 30, 30: 90 }, search: { 7: 28, 28: 90 }, analytics: { 7: 30, 30: 90 } };

function load(kind, range, refresh = false) {
  const key = `${kind}:${range}`;
  if (refresh) invalidate(key);
  return cached(key, () => api("/" + kind, { query: { range, refresh: refresh ? 1 : null } }), TTL[kind] || 60000);
}
const rowsOf = v => Array.isArray(v) ? v : [];
function dailyMap(arr) {
  const list = rowsOf(arr);
  return list.length ? new Map(list.map(x => [normDate(x.day ?? x.date), x])) : null;
}
/** 409 setup codes: not_connected (no key), no_site (no Search Console property chosen),
    no_property (no GA4 property ID). None of them is fixed by retrying. */
function setupCode(e) {
  if (e?.status !== 409) return "";
  const code = e.data?.code;
  if (code === "not_connected" || code === "no_site" || code === "no_property") return code;
  return /not connected/i.test(e.message || "") ? "not_connected" : "";
}
const isNotConnected = e => setupCode(e) === "not_connected";

/** Router ctx when there is one; a harmless stand-in otherwise. */
function useCtx(container, ctx) {
  const c = ctx || {};
  return {
    alive: typeof c.alive === "function" ? () => c.alive() : () => container.isConnected,
    onLeave: fn => { if (typeof c.onLeave === "function") c.onLeave(fn); },
    query: c.query || {},
    raw: c
  };
}

/* ======================= Small parts ======================= */
const SVG_NS = "http://www.w3.org/2000/svg";
function svg(tag, attrs, ...kids) {
  const el = document.createElementNS(SVG_NS, tag);
  for (const [k, v] of Object.entries(attrs || {})) if (v != null && v !== false) el.setAttribute(k, String(v));
  for (const k of kids.flat()) if (k) el.append(k);
  return el;
}

/** Change against the previous period: {tone, arrow, text, say} or null. */
function deltaInfo(cur, prev, kind) {
  if (prev == null || prev === "" || !Number.isFinite(Number(prev))) return null;
  const flat = text => ({ tone: "flat", arrow: "→", text, say: "no change" });
  if (kind === "rate") {
    const d = (frac(cur) - frac(prev)) * 100;
    if (Math.abs(d) < 0.05) return flat("0.0 pts");
    const t = NF1.format(Math.abs(d));
    return { tone: d > 0 ? "good" : "bad", arrow: d > 0 ? "↑" : "↓", text: `${t} pts`, say: `${d > 0 ? "up" : "down"} ${t} percentage points` };
  }
  if (kind === "position") {
    const c = num(cur), p = num(prev);
    if (!c || !p) return null;
    const d = p - c; // a smaller position number is better
    if (Math.abs(d) < 0.05) return flat("0.0");
    const t = NF1.format(Math.abs(d));
    return { tone: d > 0 ? "good" : "bad", arrow: d > 0 ? "↑" : "↓", text: `${t} places`, say: `${d > 0 ? "improved" : "dropped"} by ${t} places` };
  }
  const c = num(cur), p = num(prev);
  if (p === 0) return c === 0 ? flat("0%") : { tone: "good", arrow: "↑", text: "New", say: "new in this period" };
  const pct = (c - p) / p * 100;
  if (Math.abs(pct) < 0.5) return flat("0%");
  const t = Math.abs(pct) < 10 ? NF1.format(Math.abs(pct)) : NF0.format(Math.abs(pct));
  return { tone: pct > 0 ? "good" : "bad", arrow: pct > 0 ? "↑" : "↓", text: `${t}%`, say: `${pct > 0 ? "up" : "down"} ${t}%` };
}
function deltaEl(cur, prev, m, vs) {
  const d = deltaInfo(cur, prev, m.kind);
  if (!d) return null;
  return h("span", { class: `tr-delta is-${d.tone}`, title: `${cap(vs)}: ${m.fmt(prev)}` },
    h("span", { class: "tr-arrow", "aria-hidden": "true", text: d.arrow }),
    h("span", { "aria-hidden": "true", text: d.text }),
    h("span", { class: "sr-only", text: `${d.say} compared with the ${vs} (${m.fmt(prev)})` }));
}
const cap = s => s.charAt(0).toUpperCase() + s.slice(1);

/** Label with a shorter version for phones (CSS swaps them; only one is ever displayed). */
const metricLabel = m => m.phone
  ? h("span", { class: "tr-lbl" }, h("span", { class: "tr-l-long", text: m.label }), h("span", { class: "tr-l-short", text: m.phone }))
  : h("span", { class: "tr-lbl", text: m.label });

/** Stat card, the same card the dashboard already uses, plus a delta and an optional sparkline.
    The period being compared is named once above the cards; each delta also says it to screen readers. */
function kpiCard(key, value, prev, vs, { href, spark } = {}) {
  const m = METRICS[key];
  const delta = deltaEl(value, prev, m, vs);
  return h(href ? "a" : "div", { class: "stat-card tr-kpi", href: href || null, title: m.hint || null },
    h("span", { class: "stat-label" }, icon(m.icon), metricLabel(m)),
    m.duration ? h("strong", { class: "stat-value", "aria-label": m.fmt(value) }, durValue(value)) : h("strong", { class: "stat-value", text: m.fmt(value) }),
    delta ? h("span", { class: "tr-kpi-foot" }, delta) : null,
    spark && spark.length > 1 ? sparkline(spark) : null);
}
function kpiRow(keys, totals, prev, vs, opts = {}) {
  return h("div", { class: `tr-kpis n${keys.length}` }, keys.map(k => kpiCard(k, totals?.[k], prev ? prev[k] : null, vs, { href: opts.href?.(k), spark: opts.spark?.(k) })));
}

/** Decorative trend line for a stat card (the numbers are in the card). */
function sparkline(values) {
  const W = 120, H = 34, n = values.length;
  const vals = values.map(num);
  const max = Math.max(...vals), min = Math.min(...vals);
  const lo = Math.max(0, min - (max - min) * 0.35), span = max - lo || 1; // shape, not size: a little air under the lowest day
  const pts = vals.map((v, i) => [i * W / (n - 1), H - 3 - ((v - lo) / span) * (H - 8)]);
  const line = "M" + pts.map(([x, y]) => `${x.toFixed(1)},${y.toFixed(1)}`).join("L");
  return svg("svg", { class: "tr-spark", viewBox: `0 0 ${W} ${H}`, preserveAspectRatio: "none", "aria-hidden": "true", focusable: "false" },
    svg("path", { class: "tr-spark-area", d: `${line}L${W},${H}L0,${H}Z` }),
    svg("path", { class: "tr-spark-line", d: line, "vector-effect": "non-scaling-stroke" }));
}

/** Short line key for legends and tooltips, drawn like the series itself (solid or dashed). */
const lineKey = prev => svg("svg", { class: `tr-key${prev ? " is-prev" : ""}`, viewBox: "0 0 18 6", width: 18, height: 6, "aria-hidden": "true", focusable: "false" },
  svg("line", { x1: 1, x2: 17, y1: 3, y2: 3 }));

/** Segmented control built on real radio buttons (arrow keys work natively). */
function segmented({ label, options, value, onChange, small = false }) {
  const name = nextId("seg");
  const inputs = [];
  const el = h("fieldset", { class: ["tr-seg", small && "tr-seg-sm"] },
    h("legend", { class: "sr-only", text: label }),
    options.map(op => {
      const input = h("input", { type: "radio", name, value: String(op.value), class: "tr-seg-input", checked: String(op.value) === String(value) });
      input.addEventListener("change", () => { if (input.checked) onChange(op.value); });
      inputs.push(input);
      return h("label", { class: "tr-seg-opt" }, input, h("span", { text: op.label }));
    }));
  return { el, set(v) { inputs.forEach(i => { i.checked = i.value === String(v); }); } };
}

/** Share bars: devices, sources on the dashboard. items: [{label, icon, value}] */
function shareList(items, { valueLabel, fmt = fmtInt } = {}) {
  const total = items.reduce((a, x) => a + num(x.value), 0) || 1;
  return h("ul", { class: "tr-share" }, items.map(x => {
    const pct = num(x.value) / total * 100;
    return h("li", null,
      h("span", { class: "tr-share-name" }, x.icon ? icon(x.icon) : null, h("span", { class: "tr-ellip", text: x.label })),
      h("span", { class: "tr-share-val" }, h("strong", { text: `${NF0.format(pct)}%` }), h("span", { class: "muted", text: valueLabel ? `${fmt(x.value)} ${valueLabel}` : fmt(x.value) })),
      h("span", { class: "tr-bar", "aria-hidden": "true" }, h("span", { style: { width: `${Math.max(pct, 1.5).toFixed(1)}%` } })));
  }));
}

/** Ranked table. cols[0] is the name column ({label, cell(row)}); the rest are numbers
    ({label, get(row), fmt, primary}). Desktop: a real table. Phones: stacked cards. */
function rankTable({ caption, cols, rows, limit = 10, emptyText }) {
  const list = rowsOf(rows);
  if (!list.length) return h("p", { class: "tr-none muted", text: emptyText || "Nothing in this period yet." });
  if (typeof matchMedia === "function" && matchMedia("(max-width: 760px)").matches) limit = Math.min(limit, 5); // stacked cards are taller
  const primary = cols.find(c => c.primary) || cols[1];
  const max = Math.max(...list.map(r => num(primary.get(r))), 0) || 1;
  const trs = list.map((r, i) => h("tr", { hidden: i >= limit },
    h("th", { scope: "row", class: "tr-name-cell" },
      h("div", { class: "tr-name" }, cols[0].cell(r, i)),
      h("span", { class: "tr-bar", "aria-hidden": "true" }, h("span", { style: { width: `${Math.max(num(primary.get(r)) / max * 100, 1.5).toFixed(1)}%` } }))),
    cols.slice(1).map(c => h("td", { class: ["num", c.primary && "is-primary"], "data-label": c.label, text: c.fmt(c.get(r)) }))));
  const table = h("table", { class: "tr-table", style: { "--cols": String(Math.max(1, cols.length - 1)) } },
    h("caption", { class: "sr-only", text: caption }),
    h("thead", null, h("tr", null, cols.map((c, i) => h("th", { scope: "col", class: i ? "num" : null, title: c.title || null, text: c.label })))),
    h("tbody", null, trs));
  if (list.length <= limit) return h("div", { class: "tr-table-wrap" }, table);
  let open = false;
  const more = h("button", { type: "button", class: "btn btn-ghost btn-sm tr-more", "aria-expanded": "false" });
  const paint = () => {
    trs.forEach((tr, i) => { tr.hidden = !open && i >= limit; });
    more.setAttribute("aria-expanded", String(open));
    more.replaceChildren(icon(open ? "caret-up" : "caret-down"), document.createTextNode(open ? "Show fewer" : `Show all ${list.length}`));
  };
  more.addEventListener("click", () => { open = !open; paint(); });
  paint();
  return h("div", { class: "tr-table-wrap" }, table, more);
}
function tableCard(title, ic, body, { note, action, cls } = {}) {
  return h("section", { class: ["card", "tr-rank", cls] },
    h("div", { class: "card-head" }, h("h2", { class: "card-title" }, ic ? icon(ic) : null, h("span", { text: title })), action || null),
    note ? h("p", { class: "muted small tr-card-note", text: note }) : null,
    body);
}

const textCell = v => h("span", { class: "tr-ellip", title: String(v ?? ""), text: String(v ?? "") || "(not set)" });
function sourceCell(src) {
  const k = String(src ?? "").toLowerCase();
  const [name, ic] = own(SOURCES, k) || [String(src ?? "") || "Unknown", "compass"];
  return h("span", { class: "tr-src" }, icon(ic), h("span", { class: "tr-ellip", text: name }));
}
function channelCell(ch) {
  const s = String(ch ?? "") || "Unassigned";
  return h("span", { class: "tr-src" }, icon(own(CHANNEL_ICONS, s.toLowerCase()) || "compass"), h("span", { class: "tr-ellip", text: s }));
}
/** A page as a link to the live page (new tab). Website and GA4 rows link only when
    they are a plain site path ("/..."); a full URL links only for Search Console rows
    (external: true), which Google reports for the site's own property. Anything else
    is shown as text, so a made-up path can never become a link to another site. */
function pageCell(raw, { external = false } = {}) {
  const s = String(raw ?? "");
  let shown = s, href = "";
  if (external && /^https?:\/\//i.test(s)) {
    try { const u = new URL(s); href = u.href; shown = decodeURIComponent(u.pathname + u.search) || "/"; } catch { /* keep the raw text */ }
  } else if (/^\/(?![/\\])[^\s\\]*$/.test(s)) href = ".." + s;
  const label = /^\/(index\.html)?$/.test(shown) ? "Home page" : shown || "(not set)";
  return href
    ? h("a", { class: "tr-link", href, target: "_blank", rel: "noopener noreferrer", title: s }, h("span", { class: "tr-ellip", text: label }), icon("arrow-square-out"))
    : h("span", { class: "tr-ellip", title: s, text: label });
}

/* ======================= Trend chart ======================= */
/** Line and area chart. set({metric, points:[{date,v}], prev:[{date,v}|null]|null, curLabel, prevLabel, title}). */
function trendChart(onLeave) {
  const gradId = nextId("tr-grad");
  const wrap = h("div", { class: "tr-chart" });
  const tip = h("div", { class: "tr-tip", hidden: true, "aria-hidden": "true" });
  const tableBox = h("div", { class: "sr-only tr-dtable" });
  let o = null, lastW = 0, active = -1, focusIdx = -1;

  const ro = typeof ResizeObserver === "function" ? new ResizeObserver(() => { const w = wrap.clientWidth; if (w && Math.abs(w - lastW) > 0.5) draw(); }) : null;
  ro?.observe(wrap);
  onLeave(() => ro?.disconnect());
  if (!ro) window.addEventListener("resize", debounce(() => draw(), 150));

  function niceTicks(lo, hi, count, integer) {
    if (!(hi > lo)) hi = lo + (integer ? count : 1);
    const raw = (hi - lo) / count;
    const mag = 10 ** Math.floor(Math.log10(raw));
    const r = raw / mag;
    let step = (r <= 1 ? 1 : r <= 2 ? 2 : r <= 2.5 ? 2.5 : r <= 5 ? 5 : 10) * mag;
    if (integer && step % 1) step = step < 1 ? 1 : Math.ceil(step);
    const a = Math.floor(lo / step + 1e-9) * step, b = Math.ceil(hi / step - 1e-9) * step;
    const out = [];
    for (let v = a; v <= b + step / 2; v += step) out.push(+v.toFixed(10));
    if (out.length < 2) out.push(+(a + step).toFixed(10));
    return out;
  }

  function draw() {
    const W = Math.round(wrap.clientWidth);
    if (!W || !o) return;
    lastW = W;
    const m = o.metric, isPos = m.kind === "position", isRate = m.kind === "rate";
    const pts = o.points, n = pts.length;
    const prev = o.prev && o.prev.some(Boolean) ? o.prev : null;
    const val = v => isRate ? frac(v) : num(v);
    const ok = v => v != null && Number.isFinite(v) && (!isPos || v > 0);
    const curVals = pts.map(p => val(p.v));
    const prevVals = prev ? prev.map(p => p ? val(p.v) : null) : [];
    const all = [...curVals, ...prevVals].filter(ok);
    const H = W < 520 ? 220 : 272;
    let ticks;
    if (isPos) {
      const lo = all.length ? Math.max(1, Math.floor(Math.min(...all) - 0.25)) : 1;
      const hi = all.length ? Math.ceil(Math.max(...all) + 0.25) : 10;
      ticks = niceTicks(lo, hi, 4, true);
      /* Position 0 does not exist. With a step of 1 the axis simply starts at 1; with a
         larger step 0 stays as the unlabelled top edge, so the gaps stay even (0, 3, 6...
         shown as  -, 3, 6...) instead of forcing 1 into the first slot (1, 3, 6...). */
      if (ticks[0] < 1 && ticks[1] - ticks[0] <= 1) {
        ticks = ticks.filter(v => v >= 1);
        if (ticks.length < 2) ticks.push(ticks[ticks.length - 1] + 1);
      }
    } else ticks = niceTicks(0, all.length ? Math.max(...all) : 0, W < 520 ? 4 : 5, !isRate);
    const y0 = ticks[0], y1 = ticks[ticks.length - 1];
    const tickText = v => isRate ? `${NFT.format(v * 100)}%` : NF0.format(v);
    const longest = Math.max(...ticks.map(v => tickText(v).length));
    const padL = Math.max(30, Math.round(longest * 7.2) + 16), padR = 14, padT = 16, padB = 30;
    const pw = Math.max(10, W - padL - padR), ph = H - padT - padB;
    const x = i => padL + (n <= 1 ? pw / 2 : i * pw / (n - 1));
    const y = v => isPos ? padT + (v - y0) / (y1 - y0 || 1) * ph : padT + ph - (v - y0) / (y1 - y0 || 1) * ph;
    const path = vals => {
      let d = "", pen = false;
      vals.forEach((v, i) => {
        if (!ok(v)) { pen = false; return; }
        d += `${pen ? "L" : "M"}${x(i).toFixed(1)},${y(v).toFixed(1)}`; pen = true;
      });
      return d;
    };
    const curPath = path(curVals);
    const base = padT + ph;

    /* x labels: a regular step counted back from the latest day (daily, every 2 days,
       weekly, fortnightly...), so the gaps are even and the same weekday repeats */
    const maxLabels = Math.max(2, Math.floor(pw / (W < 520 ? 62 : 78)));
    const step = [1, 2, 7, 14, 28, 56].find(s => Math.ceil(n / s) <= maxLabels) || Math.ceil(n / maxLabels);
    const xIdx = [];
    for (let i = n - 1; i >= 0; i -= step) xIdx.unshift(i);
    const anchorOf = i => n <= 1 ? "middle" : x(i) - padL < 22 ? "start" : padL + pw - x(i) < 22 ? "end" : "middle";

    const grid = svg("g", { class: "tr-axis", "aria-hidden": "true" },
      ticks.map((v, i) => svg("line", { class: (!isPos && i === 0) ? "tr-baseline" : "tr-gridline", x1: padL, x2: W - padR, y1: y(v).toFixed(1), y2: y(v).toFixed(1) })),
      ticks.map(v => isPos && v < 1 ? null : svg("text", { class: "tr-ytick", x: padL - 10, y: y(v).toFixed(1), "text-anchor": "end", "dominant-baseline": "middle" }, document.createTextNode(tickText(v)))),
      xIdx.map(i => svg("text", { class: "tr-xtick", x: x(i).toFixed(1), y: H - 9, "text-anchor": anchorOf(i) }, document.createTextNode(shortDate(pts[i].date)))));

    const marks = svg("g", { class: "tr-marks", "aria-hidden": "true" },
      svg("defs", null, svg("linearGradient", { id: gradId, x1: 0, x2: 0, y1: 0, y2: 1 },
        svg("stop", { offset: "0%", class: "tr-grad-top" }), svg("stop", { offset: "100%", class: "tr-grad-bottom" }))),
      !isPos && curPath && n > 1 ? svg("path", { class: "tr-area", d: `${curPath}L${x(n - 1).toFixed(1)},${base}L${x(0).toFixed(1)},${base}Z`, fill: `url(#${gradId})` }) : null,
      prev ? svg("path", { class: "tr-prev-line", d: path(prevVals) }) : null,
      curPath ? svg("path", { class: "tr-line", d: curPath }) : null,
      n <= 14 ? curVals.map((v, i) => ok(v) ? svg("circle", { class: "tr-dot", cx: x(i).toFixed(1), cy: y(v).toFixed(1), r: 4 }) : null)
        : ok(curVals[n - 1]) ? svg("circle", { class: "tr-dot", cx: x(n - 1).toFixed(1), cy: y(curVals[n - 1]).toFixed(1), r: 4 }) : null);

    const cross = svg("line", { class: "tr-cross", y1: padT, y2: base, visibility: "hidden" });
    const ring = svg("circle", { class: "tr-focus-ring", r: 9, visibility: "hidden" });
    const hotPrev = svg("circle", { class: "tr-hot-prev", r: 4, visibility: "hidden" });
    const hot = svg("circle", { class: "tr-hot", r: 5, visibility: "hidden" });

    /* Keyboard: one tab stop, arrow keys between days. Each point is labelled for screen readers. */
    const unit = m.label.toLowerCase();
    const ptsG = svg("g", { class: "tr-pts", role: "list", "aria-label": `${o.title}, ${o.curLabel.toLowerCase()}. Use the arrow keys to move between days.` },
      pts.map((p, i) => {
        const v = curVals[i], pv = prev?.[i] ? prevVals[i] : null;
        const say = `${fullDate(p.date)}: ${ok(v) ? m.fmt(isRate ? v : p.v) : "no data"} ${isRate || isPos ? "" : unit}`.trim() +
          (prev?.[i] ? `. ${o.prevLabel}, ${fullDate(prev[i].date)}: ${ok(pv) ? m.fmt(isRate ? pv : prev[i].v) : "no data"}` : "");
        return svg("circle", { class: "tr-pt", role: "listitem", "aria-label": say, tabindex: "-1", "data-i": i, cx: x(i).toFixed(1), cy: (ok(v) ? y(v) : base).toFixed(1), r: 7 });
      }));
    const circles = [...ptsG.querySelectorAll(".tr-pt")];
    const roving = Math.min(n - 1, focusIdx >= 0 ? focusIdx : n - 1);
    circles[roving]?.setAttribute("tabindex", "0");

    const el = svg("svg", { class: "tr-svg", viewBox: `0 0 ${W} ${H}`, width: W, height: H, role: "group", "aria-roledescription": "chart", "aria-label": `${o.title}, ${o.curLabel.toLowerCase()}` },
      grid, marks, cross, hotPrev, hot, ring, ptsG);

    function show(i, byKeyboard = false) {
      if (i < 0 || i >= n) return;
      active = i;
      const cx = x(i), v = curVals[i];
      cross.setAttribute("x1", cx.toFixed(1)); cross.setAttribute("x2", cx.toFixed(1)); cross.setAttribute("visibility", "visible");
      if (ok(v)) { hot.setAttribute("cx", cx.toFixed(1)); hot.setAttribute("cy", y(v).toFixed(1)); hot.setAttribute("visibility", "visible"); }
      else hot.setAttribute("visibility", "hidden");
      const pv = prev?.[i] ? prevVals[i] : null;
      if (ok(pv)) { hotPrev.setAttribute("cx", cx.toFixed(1)); hotPrev.setAttribute("cy", y(pv).toFixed(1)); hotPrev.setAttribute("visibility", "visible"); }
      else hotPrev.setAttribute("visibility", "hidden");
      ring.setAttribute("visibility", byKeyboard ? "visible" : "hidden");
      if (byKeyboard) { ring.setAttribute("cx", cx.toFixed(1)); ring.setAttribute("cy", (ok(v) ? y(v) : base).toFixed(1)); }
      fill(tip,
        h("div", { class: "tr-tip-date", text: dayDate(pts[i].date) }),
        h("div", { class: "tr-tip-row" }, lineKey(false), h("strong", { text: ok(v) ? m.fmt(isRate ? v : pts[i].v) : "No data" }), h("span", { class: "tr-tip-label", text: m.short || m.label })),
        prev?.[i] ? h("div", { class: "tr-tip-row is-prev" }, lineKey(true), h("span", { class: "tr-tip-val", text: ok(pv) ? m.fmt(isRate ? pv : prev[i].v) : "No data" }), h("span", { class: "tr-tip-label", text: shortDate(prev[i].date) })) : null);
      tip.hidden = false;
      const tw = tip.offsetWidth;
      const left = cx + 14 + tw > W - 4 ? Math.max(4, cx - 14 - tw) : cx + 14;
      tip.style.left = `${left}px`;
      tip.style.top = `${padT}px`;
    }
    function hide() {
      active = -1;
      [cross, hot, hotPrev, ring].forEach(e => e.setAttribute("visibility", "hidden"));
      tip.hidden = true;
    }
    const indexAt = clientX => {
      const r = el.getBoundingClientRect();
      const px = (clientX - r.left) * (W / r.width);
      return Math.max(0, Math.min(n - 1, Math.round(n <= 1 ? 0 : (px - padL) / (pw / (n - 1)))));
    };
    el.addEventListener("pointermove", e => show(indexAt(e.clientX)));
    el.addEventListener("pointerdown", e => show(indexAt(e.clientX)));
    el.addEventListener("pointerleave", () => { if (!ptsG.contains(document.activeElement)) hide(); else show(focusIdx, true); });
    ptsG.addEventListener("focusin", e => {
      const i = Number(e.target.dataset?.i);
      if (!Number.isInteger(i)) return;
      circles.forEach((c, j) => c.setAttribute("tabindex", j === i ? "0" : "-1"));
      let kb = true;
      try { kb = e.target.matches(":focus-visible"); } catch { /* older browsers: always show the ring */ }
      focusIdx = i; show(i, kb);
    });
    ptsG.addEventListener("focusout", e => { if (!ptsG.contains(e.relatedTarget)) hide(); });
    ptsG.addEventListener("keydown", e => {
      const i = Number(e.target.dataset?.i);
      if (!Number.isInteger(i)) return;
      const to = { ArrowRight: i + 1, ArrowLeft: i - 1, ArrowUp: i + 1, ArrowDown: i - 1, Home: 0, End: n - 1, PageUp: i - 7, PageDown: i + 7 }[e.key];
      if (to == null) { if (e.key === "Escape") e.target.blur(); return; }
      e.preventDefault();
      circles[Math.max(0, Math.min(n - 1, to))].focus();
    });

    const hadFocus = wrap.contains(document.activeElement) ? focusIdx : -1;
    const keep = active;
    wrap.replaceChildren(el, tip);
    tip.hidden = true;
    if (hadFocus >= 0) circles[hadFocus]?.focus({ preventScroll: true });
    else if (keep >= 0 && keep < n) show(keep);
  }

  function table() {
    if (!o) return;
    const m = o.metric, isRate = m.kind === "rate";
    const prev = o.prev && o.prev.some(Boolean) ? o.prev : null;
    const f = v => m.fmt(isRate ? frac(v) : v);
    fill(tableBox, h("table", { class: "tr-table tr-table-plain" },
      h("caption", { text: `${o.title}, ${o.curLabel.toLowerCase()}` }),
      h("thead", null, h("tr", null, h("th", { scope: "col", text: "Date" }), h("th", { scope: "col", class: "num", text: o.curLabel }), prev ? h("th", { scope: "col", class: "num", text: o.prevLabel }) : null)),
      h("tbody", null, o.points.map((p, i) => h("tr", null,
        h("th", { scope: "row", text: dayDate(p.date) }),
        h("td", { class: "num", text: f(p.v) }),
        prev ? h("td", { class: "num", text: prev[i] ? `${f(prev[i].v)} (${shortDate(prev[i].date)})` : "–" }) : null)))));
  }

  return {
    el: h("div", { class: "tr-chart-box" }, wrap, tableBox),
    tableBox,
    set(opts) { o = opts; focusIdx = -1; active = -1; draw(); table(); },
    redraw() { draw(); table(); }
  };
}

/** Chart card: title, legend, metric switch, table toggle, chart. series(key) -> {points, prev} */
function chartCard(cu, { metrics, series, curLabel, prevLabel }) {
  let key = metrics[0];
  const title = h("h2", { class: "card-title" });
  const legend = h("div", { class: "tr-legend" });
  const chart = trendChart(cu.onLeave);
  let tableOn = false;
  const tableBtn = h("button", { type: "button", class: "btn btn-ghost btn-sm tr-table-btn", "aria-pressed": "false",
    onclick: () => {
      tableOn = !tableOn;
      tableBtn.setAttribute("aria-pressed", String(tableOn));
      chart.tableBox.classList.toggle("sr-only", !tableOn);
      chart.tableBox.classList.toggle("is-open", tableOn);
    } }, icon("table"), h("span", { text: "Data table" }));
  const sw = metrics.length > 1 ? segmented({ label: "Chart shows", small: true, value: key,
    options: metrics.map(k => ({ value: k, label: METRICS[k].short || METRICS[k].label })),
    onChange: v => { key = v; paint(); } }) : null;
  function paint() {
    const m = METRICS[key];
    const s = series(key);
    const t = `${m.chart || m.label} per day`;
    title.textContent = t;
    const hasPrev = !!(s.prev && s.prev.some(Boolean));
    fill(legend,
      h("span", { class: "tr-leg" }, lineKey(false), curLabel),
      hasPrev ? h("span", { class: "tr-leg" }, lineKey(true), prevLabel) : null,
      m.kind === "position" ? h("span", { class: "tr-leg muted", text: "Higher on the chart is better" }) : null);
    chart.set({ metric: m, points: s.points, prev: s.prev, curLabel, prevLabel, title: t });
  }
  const el = h("section", { class: "card tr-chart-card" },
    h("div", { class: "tr-chart-head" }, h("div", { class: "tr-chart-titles" }, title, legend), h("div", { class: "tr-chart-tools" }, sw?.el, tableBtn)),
    chart.el);
  return { el, paint };
}

/* ======================= States ======================= */
/** "Today so far" from the live part of the website report (the charts hold complete days only). */
function todayText(today, { long = false } = {}) {
  const v = num(today?.visitors);
  if (!v) return "";
  const parts = [`${fmtInt(v)} ${v === 1 ? "visitor" : "visitors"}`];
  if (long) parts.push(`${fmtInt(today.page_views)} page ${num(today.page_views) === 1 ? "view" : "views"}`);
  if (num(today.whatsapp_clicks)) parts.push(`${fmtInt(today.whatsapp_clicks)} WhatsApp ${num(today.whatsapp_clicks) === 1 ? "click" : "clicks"}`);
  if (num(today.leads)) parts.push(`${fmtInt(today.leads)} ${num(today.leads) === 1 ? "enquiry" : "enquiries"}`);
  return `Today so far: ${parts.join(", ")}`;
}
const collecting = today => {
  const t = todayText(today, { long: true });
  return h("div", { class: "card tr-empty-card" }, emptyState({ icon: "chart-line-up", title: "Collecting data",
    text: t
      ? `${t}. The charts and the change from the period before show complete days, so they start tomorrow.`
      : "Numbers appear after the first visits. Visits are counted on the website itself, without cookies. Today's visits show here within a minute; the charts fill in day by day." }));
};

/** Google says something is missing in the setup: a call to action, never a Retry. */
function googleSetupState(code, isSearch) {
  if (code === "no_site") {
    return { icon: "google-logo", title: "Choose your Search Console property",
      text: "Google is connected. Pick the Search Console property for this website in Settings, Google connection, and this report fills in.",
      action: { label: "Choose the property", icon: "gear-six", href: "#/settings?section=google" } };
  }
  if (code === "no_property") {
    return { icon: "chart-bar", title: "Add your GA4 property ID",
      text: "Google is connected. Add the numeric GA4 property ID in Settings, Google connection, to see Google Analytics here.",
      action: { label: "Add the property ID", icon: "gear-six", href: "#/settings?section=google" } };
  }
  return { icon: isSearch ? "google-logo" : "chart-bar",
    title: isSearch ? "Connect Google Search Console" : "Connect Google Analytics",
    text: isSearch
      ? "See the Google searches that bring people to the website: clicks, impressions, click-through rate and position for every query and page."
      : "See users, sessions, channels and landing pages from your Google Analytics 4 property, next to the website numbers.",
    action: { label: "Set up the connection", icon: "plugs-connected", href: "#/settings?section=google" } };
}

/** Google failed and the server sent the last saved copy instead. */
const staleNote = d => h("p", { class: "note tr-stale", role: "status" }, icon("warning-circle"),
  h("span", null, h("strong", { text: "Showing saved Google data. " }),
    `${d.error || "Google could not be reached."}${d.fetched_at ? ` These numbers are from ${timeAgo(d.fetched_at)}.` : ""}`));

function googleProblem(kind, e, retry) {
  const isSearch = kind === "search";
  const code = setupCode(e);
  if (code) return h("div", { class: "card tr-empty-card" }, emptyState(googleSetupState(code, isSearch)));
  return errorCard(e, retry, { title: "Google data could not load", settings: true });
}
function errorCard(e, retry, { title = "Traffic numbers could not load", settings = false } = {}) {
  return h("div", { class: "card tr-empty-card" }, h("div", { class: "empty empty-error", role: "alert" },
    h("div", { class: "empty-ic" }, icon("cloud-warning")),
    h("h2", { text: title }),
    h("p", { text: e?.message || "Something went wrong. Please try again." }),
    h("div", { class: "tr-actions-center" },
      h("button", { type: "button", class: "btn btn-secondary", onclick: retry }, icon("arrow-clockwise"), "Retry"),
      settings ? h("a", { class: "btn btn-ghost", href: "#/settings?section=google" }, icon("gear-six"), "Connection settings") : null)));
}
function skeletonPanel(n) {
  return h("div", { class: "tr-stack", role: "status", "aria-label": "Loading" },
    h("div", { class: `tr-kpis n${n}` }, Array.from({ length: n }, () => h("div", { class: "stat-card" }, skel("l2"), skel("big"), skel("l1")))),
    h("div", { class: "card tr-chart-card" }, skel("h"), h("span", { class: "skel tr-skel-chart", "aria-hidden": "true" })),
    h("div", { class: "tr-grid" }, [0, 1].map(() => h("div", { class: "card" }, skel("h"),
      h("div", { class: "card-pad" }, [0, 1, 2, 3].map(() => h("div", { class: "skel-item" }, h("div", { class: "skel-lines" }, skel("l1"), skel("l2")), skel("pill"))))))));
}

/* ======================= Page: #/traffic ======================= */
const TABS = [
  { key: "website", kind: "traffic", label: "Website", short: "Website", icon: "globe-simple", ranges: [7, 30, 90], kpis: 5 },
  { key: "search", kind: "search", label: "Google Search", short: "Search", icon: "google-logo", ranges: [7, 28, 90], kpis: 4 },
  { key: "analytics", kind: "analytics", label: "Google Analytics", short: "Analytics", icon: "chart-bar", ranges: [7, 30, 90], kpis: 5 }
];

export async function renderTrafficPage(container, ctx) {
  const cu = useCtx(container, ctx);
  let tab = TABS.find(t => t.key === cu.query.tab) || TABS[0];
  let ri = tab.ranges.indexOf(Number(cu.query.range));
  if (ri < 0) ri = 1;
  let reqId = 0;

  const tabBtns = TABS.map(t => h("button", { type: "button", role: "tab", id: `tr-tab-${t.key}`, class: "tr-tab", "aria-controls": "tr-panel", "aria-selected": "false", tabindex: "-1",
    onclick: () => select(t) }, icon(t.icon), h("span", { class: "tr-tab-long", text: t.label }), h("span", { class: "tr-tab-short", text: t.short })));
  const tablist = h("div", { class: "tr-tabs", role: "tablist", "aria-label": "Traffic source" }, tabBtns);
  tablist.addEventListener("keydown", e => {
    const i = TABS.indexOf(tab);
    const j = { ArrowRight: (i + 1) % TABS.length, ArrowLeft: (i - 1 + TABS.length) % TABS.length, Home: 0, End: TABS.length - 1 }[e.key];
    if (j == null) return;
    e.preventDefault(); select(TABS[j]); tabBtns[j].focus();
  });

  const rangeBox = h("div", { class: "tr-range" });
  const period = h("span", { class: "tr-period" });
  const updated = h("span", { class: "tr-updated" });
  const refreshBtn = h("button", { type: "button", class: "btn btn-ghost btn-sm", onclick: () => show({ refresh: true }) }, icon("arrow-clockwise"), h("span", { text: "Refresh" }));
  const sync = h("div", { class: "tr-sync", hidden: true }, updated, refreshBtn);
  const panel = h("div", { id: "tr-panel", class: "tr-panel", role: "tabpanel", tabindex: "-1" });

  const head = h("header", { class: "page-head" },
    h("div", { class: "title-row" }, h("h1", { class: "page-title", text: "Traffic", tabindex: "-1" })),
    h("p", { class: "page-sub", text: "How many people visit, where they come from and what makes them get in touch." }),
    h("div", { class: "page-actions" }, h("a", { class: "btn btn-secondary", href: "#/settings?section=google", "aria-label": "Google connection settings" }, icon("plugs-connected"), h("span", { class: "hide-phone", text: "Google connection" }))));
  fill(container, head, tablist, h("div", { class: "tr-toolbar" }, rangeBox, period, sync), panel);

  function paintTabs() {
    tabBtns.forEach((b, i) => {
      const on = TABS[i] === tab;
      b.setAttribute("aria-selected", String(on)); b.tabIndex = on ? 0 : -1; b.classList.toggle("active", on);
    });
    panel.setAttribute("aria-labelledby", `tr-tab-${tab.key}`);
  }
  function paintRange() {
    const seg = segmented({ label: "Date range", value: tab.ranges[ri], options: tab.ranges.map(r => ({ value: r, label: `${r} days` })),
      onChange: v => { ri = tab.ranges.indexOf(Number(v)); show(); } });
    fill(rangeBox, seg.el);
  }
  function syncUrl() {
    if (!/^#\/traffic(\?|$)/.test(location.hash)) return;
    history.replaceState(null, "", `#/traffic?tab=${tab.key}&range=${tab.ranges[ri]}`);
  }
  function select(t) {
    if (t === tab) return;
    tab = t; paintTabs(); paintRange(); show();
  }

  async function show({ refresh = false } = {}) {
    const my = ++reqId;
    const range = tab.ranges[ri];
    syncUrl();
    const keep = panel.dataset.tab === tab.key && panel.dataset.ok === "1";
    if (keep) panel.classList.add("is-loading");
    else { fill(panel, skeletonPanel(tab.kpis)); period.replaceChildren(); sync.hidden = true; }
    panel.setAttribute("aria-busy", "true");
    refreshBtn.disabled = true;
    try {
      const data = await load(tab.kind, range, refresh);
      if (my !== reqId || !cu.alive()) return;
      const live = { ok: () => my === reqId && cu.alive(), cu };
      panel.dataset.tab = tab.key;
      panel.dataset.ok = "1";
      rangeBox.hidden = false;
      const daily = rowsOf(data?.daily);
      const dates = periodText(data?.from || daily[0]?.day || daily[0]?.date, data?.to || daily[daily.length - 1]?.day || daily[daily.length - 1]?.date);
      fill(period, dates ? h("span", { class: "tr-period-dates", text: dates }) : null, h("span", { class: "tr-period-vs", text: `vs the previous ${range} days` }));
      if (tab.key === "website") { sync.hidden = true; renderWebsite(panel, data || {}, range, live); }
      else {
        updated.textContent = data?.fetched_at ? `Google data from ${timeAgo(data.fetched_at)}` : "";
        updated.title = data?.fetched_at ? fmtDate(data.fetched_at) : "";
        sync.hidden = false;
        (tab.key === "search" ? renderSearch : renderAnalytics)(panel, data || {}, range, live);
        if (data?.stale) panel.prepend(staleNote(data)); // Google failed: the server sent its last copy
      }
      /* The server answers a refresh with 200 in every case: throttled (refreshed
         less than 5 minutes ago, same data), stale (Google failed, saved data) or
         cached:false (fresh from Google). Only the last one is a refresh. */
      if (refresh) {
        if (data?.throttled) toast("Google data was refreshed a moment ago. Try again in a few minutes.", "info");
        else if (data?.stale) toast("Google could not be reached. The saved numbers are still shown.", "error");
        else if (data?.cached === false) toast("Google data refreshed");
      }
    } catch (e) {
      if (my !== reqId || !cu.alive() || e.status === 401) return;
      if (refresh && e.status === 429 && panel.dataset.ok === "1") { toast("Google data was refreshed a moment ago. Try again in a few minutes.", "info"); return; }
      if (refresh && panel.dataset.ok === "1") { toastError(e); return; }
      panel.dataset.ok = "";
      sync.hidden = true; period.replaceChildren();
      rangeBox.hidden = !!setupCode(e); // nothing to scope until Google is set up
      fill(panel, tab.key === "website" ? errorCard(e, () => show()) : googleProblem(tab.key, e, () => show()));
    } finally {
      if (my === reqId) { panel.classList.remove("is-loading"); panel.removeAttribute("aria-busy"); refreshBtn.disabled = false; }
    }
  }

  paintTabs(); paintRange();
  await show();
}

/* ---------------- Website tab ---------------- */
function renderWebsite(panel, d, range, live) {
  const t = d.totals || {}, p = d.previous || null;
  const daily = rowsOf(d.daily).map(x => ({ ...x, date: normDate(x.day ?? x.date) }));
  const quiet = o => !o || (!num(o.visitors) && !num(o.page_views));
  if (quiet(t) && quiet(p) && daily.every(x => !num(x.visitors) && !num(x.page_views))) { fill(panel, collecting(d.today)); return; }

  const vs = `previous ${range} days`;
  const today = todayText(d.today, { long: true });
  let prevMap = dailyMap(d.previous_daily);
  const chart = chartCard(live.cu, {
    metrics: ["visitors", "page_views", "whatsapp_clicks", "leads"], curLabel: `Last ${range} days`, prevLabel: `Previous ${range} days`,
    series: key => ({
      points: daily.map(x => ({ date: x.date, v: num(x[key]) })),
      prev: prevMap ? daily.map(x => { const pd = addDays(x.date, -range); const r = prevMap.get(pd); return r ? { date: pd, v: num(r[key]) } : null; }) : null
    })
  });

  const counts = { visitors: "Visitors", whatsapp_clicks: "WhatsApp", leads: "Enquiries" };
  const countCols = Object.entries(counts).map(([k, label], i) => ({ label, title: METRICS[k].label, get: r => r[k], fmt: fmtInt, primary: i === 0 }));
  const dev = rowsOf(d.devices).map(x => { const k = String(x.device || "").toLowerCase(); const [label, ic] = own(DEVICES, k) || [String(x.device || "") || "Other", "devices"]; return { label, icon: ic, value: x.visitors }; });
  const nvr = d.new_vs_returning || {};
  const nNew = num(nvr.new), nRet = num(nvr.returning), nAll = nNew + nRet;

  fill(panel,
    h("p", { class: "tr-today muted small" }, icon("clock"),
      h("span", { text: `Complete days up to yesterday.${today ? ` ${today}.` : " No visits yet today."}` })),
    kpiRow(["visitors", "page_views", "whatsapp_clicks", "leads", "conversion_rate"], t, p, vs),
    chart.el,
    h("div", { class: "tr-grid" },
      tableCard("Sources", "compass", rankTable({ caption: "Visitors by source", rows: d.sources, limit: 8,
        cols: [{ label: "Source", cell: r => sourceCell(r.source) }, ...countCols], emptyText: "No visits in this period yet." })),
      tableCard("Campaigns", "megaphone-simple", rankTable({ caption: "Visitors by campaign", rows: d.campaigns, limit: 8,
        cols: [{ label: "Campaign", cell: r => textCell(r.campaign) }, ...countCols],
        emptyText: "No campaign visits in this period. Links tagged with utm_campaign, for example from Google Ads or Instagram, show up here." }))),
    h("div", { class: "tr-grid" },
      tableCard("Top products", "diamond", rankTable({ caption: "Most viewed products", rows: d.top_products, limit: 8,
        cols: [{ label: "Product", cell: r => textCell(r.name || r.item) }, { label: "Views", get: r => r.views, fmt: fmtInt, primary: true },
          { label: "WhatsApp", title: "WhatsApp clicks", get: r => r.whatsapp_clicks, fmt: fmtInt }, { label: "Enquiries", get: r => r.leads, fmt: fmtInt }],
        emptyText: "No product views in this period yet." })),
      tableCard("Top pages", "browser", rankTable({ caption: "Most viewed pages", rows: d.top_pages, limit: 8,
        cols: [{ label: "Page", cell: r => pageCell(r.path) }, { label: "Views", get: r => r.views, fmt: fmtInt, primary: true }, { label: "Visitors", get: r => r.visitors, fmt: fmtInt }],
        emptyText: "No page views in this period yet." }))),
    h("div", { class: "tr-grid" },
      tableCard("Top collections", "crown-simple", rankTable({ caption: "Most viewed collections", rows: d.top_collections, limit: 8,
        cols: [{ label: "Collection", cell: r => textCell(r.name || r.collection) }, { label: "Views", get: r => r.views, fmt: fmtInt, primary: true }],
        emptyText: "No collection views in this period yet." })),
      h("section", { class: "card tr-rank" },
        h("div", { class: "card-head" }, h("h2", { class: "card-title" }, icon("devices"), h("span", { text: "Audience" }))),
        h("h3", { class: "tr-sub", text: "Devices" }),
        dev.length ? shareList(dev, { valueLabel: "visitors" }) : h("p", { class: "tr-none muted", text: "No visits in this period yet." }),
        h("h3", { class: "tr-sub", text: "New and returning" }),
        nAll ? splitBar([{ label: "New", value: nNew }, { label: "Returning", value: nRet }]) : h("p", { class: "tr-none muted", text: "No visits in this period yet." }))));
  chart.paint();

  const longer = LONGER.traffic[range];
  if (!prevMap && longer) {
    load("traffic", longer).then(L => {
      if (!live.ok()) return;
      prevMap = dailyMap(L?.daily);
      chart.paint();
    }).catch(() => { /* the comparison line is a bonus */ });
  }
}

/** Two-part bar with a 2px gap and labels, so colour is never the only signal. */
function splitBar(parts) {
  const total = parts.reduce((a, x) => a + num(x.value), 0) || 1;
  return h("div", { class: "tr-split" },
    h("div", { class: "tr-split-bar", "aria-hidden": "true" }, parts.map((x, i) => h("span", { class: `seg-${i}`, style: { "flex-grow": String(Math.max(num(x.value), total * 0.01)) } }))),
    h("ul", { class: "tr-split-legend" }, parts.map((x, i) => h("li", null,
      h("span", { class: `tr-swatch seg-${i}`, "aria-hidden": "true" }),
      h("span", { text: x.label }),
      h("strong", { text: `${NF0.format(num(x.value) / total * 100)}%` }),
      h("span", { class: "muted", text: fmtInt(x.value) })))));
}

/* ---------------- Google Search tab ---------------- */
function renderSearch(panel, d, range, live) {
  const t = d.totals || {}, p = d.previous || null;
  const daily = rowsOf(d.daily).map(x => ({ ...x, date: normDate(x.date ?? x.day) }));
  if (!num(t.impressions) && !num(t.clicks) && daily.every(x => !num(x.impressions))) {
    fill(panel, h("div", { class: "card tr-empty-card" }, emptyState({ icon: "google-logo", title: "No search data yet",
      text: "Google shows data a few days after a property is added to Search Console. If the website is new to Google, check back later this week." })));
    return;
  }
  const vs = `previous ${range} days`;
  let prevMap = dailyMap(d.previous_daily);
  const val = (r, key) => key === "ctr" ? frac(r.ctr) : num(r[key]);
  const chart = chartCard(live.cu, {
    metrics: ["clicks", "impressions", "ctr", "position"], curLabel: `Last ${range} days`, prevLabel: `Previous ${range} days`,
    series: key => ({
      points: daily.map(x => ({ date: x.date, v: val(x, key) })),
      prev: prevMap ? daily.map(x => { const pd = addDays(x.date, -range); const r = prevMap.get(pd); return r ? { date: pd, v: val(r, key) } : null; }) : null
    })
  });
  const gscCols = [
    { label: "Clicks", get: r => r.clicks, fmt: fmtInt, primary: true },
    { label: "Impr.", title: "Impressions", get: r => r.impressions, fmt: fmtInt },
    { label: "CTR", title: "Click-through rate", get: r => r.ctr, fmt: fmtPct },
    { label: "Position", title: "Average position", get: r => r.position, fmt: fmtPos }
  ];
  const dev = rowsOf(d.devices).map(x => { const k = String(x.device || "").toLowerCase(); const [label, ic] = own(DEVICES, k) || [String(x.device || "") || "Other", "devices"]; return { label, icon: ic, value: x.clicks }; });

  fill(panel,
    kpiRow(["clicks", "impressions", "ctr", "position"], t, p, vs),
    chart.el,
    tableCard("Search queries", "magnifying-glass", rankTable({ caption: "Top Google search queries", rows: d.queries, limit: 10,
      cols: [{ label: "Query", cell: r => textCell(r.query) }, ...gscCols], emptyText: "No queries in this period. Google hides very rare searches for privacy." }),
    { note: "What people typed into Google before they saw or clicked the website. Data is usually two to three days behind." }),
    h("div", { class: "tr-grid tr-grid-wide" },
      tableCard("Pages", "browser", rankTable({ caption: "Top pages in Google Search", rows: d.pages, limit: 10,
        cols: [{ label: "Page", cell: r => pageCell(r.page, { external: true }) }, ...gscCols], emptyText: "No pages in this period yet." })),
      h("div", { class: "tr-col" },
        h("section", { class: "card tr-rank" },
          h("div", { class: "card-head" }, h("h2", { class: "card-title" }, icon("devices"), h("span", { text: "Devices" }))),
          dev.length ? shareList(dev, { valueLabel: "clicks" }) : h("p", { class: "tr-none muted", text: "No clicks in this period yet." })),
        tableCard("Countries", "globe-hemisphere-east", rankTable({ caption: "Clicks by country", rows: d.countries, limit: 10,
          cols: [{ label: "Country", cell: r => textCell(countryName(r.country)) }, { label: "Clicks", get: r => r.clicks, fmt: fmtInt, primary: true }, { label: "Impr.", title: "Impressions", get: r => r.impressions, fmt: fmtInt }],
          emptyText: "No clicks in this period yet." })))));
  chart.paint();

  const longer = LONGER.search[range];
  if (!prevMap && longer) {
    load("search", longer).then(L => { if (!live.ok()) return; prevMap = dailyMap(L?.daily); chart.paint(); }).catch(() => { /* optional */ });
  }
}

/* ---------------- Google Analytics tab ---------------- */
function renderAnalytics(panel, d, range, live) {
  const t = d.totals || {}, p = d.previous || null;
  const daily = rowsOf(d.daily).map(x => ({ ...x, date: normDate(x.date ?? x.day) }));
  if (!num(t.activeUsers) && !num(t.sessions) && daily.every(x => !num(x.activeUsers) && !num(x.sessions))) {
    fill(panel, h("div", { class: "card tr-empty-card" }, emptyState({ icon: "chart-bar", title: "No Analytics data yet",
      text: "Google Analytics starts showing numbers a day or two after the property begins collecting. Check that the GA4 tag is on the website." })));
    return;
  }
  const vs = `previous ${range} days`;
  let prevMap = dailyMap(d.previous_daily);
  const chart = chartCard(live.cu, {
    metrics: ["activeUsers", "sessions"], curLabel: `Last ${range} days`, prevLabel: `Previous ${range} days`,
    series: key => ({
      points: daily.map(x => ({ date: x.date, v: num(x[key]) })),
      prev: prevMap ? daily.map(x => { const pd = addDays(x.date, -range); const r = prevMap.get(pd); return r ? { date: pd, v: num(r[key]) } : null; }) : null
    })
  });
  fill(panel,
    kpiRow(["activeUsers", "newUsers", "sessions", "engagementRate", "averageSessionDuration"], t, p, vs),
    chart.el,
    h("div", { class: "tr-grid" },
      tableCard("Channels", "signpost", rankTable({ caption: "Sessions by channel", rows: d.channels, limit: 10,
        cols: [{ label: "Channel", cell: r => channelCell(r.channel) }, { label: "Sessions", get: r => r.sessions, fmt: fmtInt, primary: true }, { label: "Users", get: r => r.users ?? r.activeUsers, fmt: fmtInt }],
        emptyText: "No sessions in this period yet." })),
      tableCard("Landing pages", "browser", rankTable({ caption: "Sessions by landing page", rows: d.landing_pages, limit: 10,
        cols: [{ label: "Page", cell: r => pageCell(r.page) }, { label: "Sessions", get: r => r.sessions, fmt: fmtInt, primary: true }],
        emptyText: "No sessions in this period yet." }))));
  chart.paint();
  const longer = LONGER.analytics[range];
  if (!prevMap && longer) {
    load("analytics", longer).then(L => { if (!live.ok()) return; prevMap = dailyMap(L?.daily); chart.paint(); }).catch(() => { /* optional */ });
  }
}

/* ======================= Dashboard row ======================= */
export async function renderDashboardTraffic(container, ctx) {
  const cu = useCtx(container, ctx);
  container.classList.add("tr-dash");
  const titleId = nextId("tr-dash");
  const kpis = h("div", { class: "stats tr-dash-kpis", role: "status", "aria-label": "Loading" },
    Array.from({ length: 4 }, () => h("div", { class: "stat-card" }, skel("l2"), skel("big"), skel("l1"))));
  const cardSkel = () => h("div", { class: "card" }, skel("h"), skel("l1"), h("span", { class: "skel tr-skel-line" }), skel("l2"));
  const row = h("div", { class: "tr-dash-row" }, cardSkel(), cardSkel());
  const todayLine = h("span", { class: "tr-eyebrow-note tr-dash-today", hidden: true });
  container.setAttribute("aria-labelledby", titleId);
  fill(container,
    h("div", { class: "tr-dash-head" },
      h("div", { class: "tr-dash-titles" },
        h("h2", { class: "tr-eyebrow", id: titleId }, icon("chart-line-up"), h("span", { text: "Last 7 days" })),
        h("span", { class: "tr-eyebrow-note", text: "Seven complete days to yesterday, compared with the 7 days before" }),
        todayLine),
      h("a", { class: "link", href: "#/traffic" }, "View traffic", icon("arrow-right"))),
    kpis, row);

  const [tr, sc] = await Promise.allSettled([load("traffic", 7), load("search", 7)]);
  if (!cu.alive()) return;

  /* Website cards */
  let sourcesCard = null;
  if (tr.status === "fulfilled") {
    const d = tr.value || {};
    const t = d.totals || {}, p = d.previous || null;
    const daily = rowsOf(d.daily);
    kpis.removeAttribute("role"); kpis.removeAttribute("aria-label");
    const today = todayText(d.today);
    const quiet = o => !o || (!num(o.visitors) && !num(o.page_views));
    if (quiet(t) && quiet(p) && daily.every(x => !num(x.visitors))) {
      kpis.replaceWith(h("div", { class: "card tr-collect" },
        h("span", { class: "tr-collect-ic" }, icon("chart-line-up")),
        h("div", null, h("strong", { text: "Collecting data" }), h("p", { class: "muted small", text: today
          ? `${today}. Visitors, WhatsApp clicks and enquiries show here day by day from tomorrow, with the change from the week before.`
          : "Numbers appear after the first visits. Visitors, WhatsApp clicks and enquiries will show here with the change from the week before." }))));
    } else {
      if (today) { todayLine.textContent = `${today}.`; todayLine.hidden = false; }
      kpis.replaceChildren(...["visitors", "whatsapp_clicks", "leads", "conversion_rate"].map(k =>
        kpiCard(k, t[k], p ? p[k] : null, "previous 7 days", {
          href: "#/traffic?tab=website&range=7",
          /* daily rows carry no rate, so the conversion line shows the shape of (WhatsApp + enquiries) per visitor */
          spark: k === "conversion_rate" ? daily.map(x => num(x.visitors) ? (num(x.whatsapp_clicks) + num(x.leads)) / num(x.visitors) : 0) : daily.map(x => num(x[k]))
        })));
      const src = rowsOf(d.sources).slice().sort((a, b) => num(b.visitors) - num(a.visitors));
      if (src.length) {
        const top = src.slice(0, 4);
        const rest = src.slice(4).reduce((a, x) => a + num(x.visitors), 0);
        const items = top.map(x => { const k = String(x.source || "").toLowerCase(); const [label, ic] = own(SOURCES, k) || [String(x.source || "") || "Unknown", "compass"]; return { label, icon: ic, value: x.visitors }; });
        if (rest > 0) items.push({ label: "Everything else", icon: "dots-three", value: rest });
        sourcesCard = h("section", { class: "card tr-mini" },
          h("div", { class: "card-head" }, h("h2", { class: "card-title" }, icon("compass"), h("span", { text: "Where visitors came from" })),
            h("a", { class: "link", href: "#/traffic?tab=website&range=7" }, "Details", icon("arrow-right"))),
          shareList(items, { valueLabel: "visitors" }));
      }
    }
  } else {
    if (tr.reason?.status === 401) return;
    kpis.replaceWith(h("div", { class: "card tr-collect is-error", role: "alert" },
      h("span", { class: "tr-collect-ic" }, icon("warning-circle")),
      h("div", null, h("strong", { text: "Traffic numbers could not load" }), h("p", { class: "muted small", text: tr.reason?.message || "Something went wrong." })),
      h("button", { type: "button", class: "btn btn-secondary btn-sm", onclick: () => { invalidate("traffic:7"); renderDashboardTraffic(container, ctx); } }, icon("arrow-clockwise"), "Retry")));
  }

  /* Google Search mini card, or the call to connect it */
  let searchCard;
  if (sc.status === "fulfilled") {
    const d = sc.value || {};
    const t = d.totals || {}, p = d.previous || null;
    const queries = rowsOf(d.queries).slice().sort((a, b) => num(b.clicks) - num(a.clicks)).slice(0, 3);
    searchCard = h("section", { class: "card tr-mini" },
      h("div", { class: "card-head" }, h("h2", { class: "card-title" }, icon("google-logo"), h("span", { text: "Google Search" })),
        h("a", { class: "link", href: "#/traffic?tab=search&range=7" }, "Open report", icon("arrow-right"))),
      h("div", { class: "tr-mini-stats" }, ["clicks", "impressions", "position"].map(k => {
        const m = METRICS[k];
        return h("div", { class: "tr-mini-stat" },
          h("span", { class: "tr-mini-label" }, metricLabel(m)),
          h("strong", { class: "tr-mini-value", text: m.fmt(t[k]) }),
          deltaEl(t[k], p ? p[k] : null, m, "previous 7 days"));
      })),
      queries.length ? h("div", { class: "tr-topq" },
        h("h3", { class: "tr-sub", text: "Top searches" }),
        h("ol", { class: "tr-topq-list" }, queries.map(r => h("li", null,
          h("span", { class: "tr-ellip", title: String(r.query ?? ""), text: String(r.query ?? "") }),
          h("span", { class: "tr-topq-val", text: `${fmtInt(r.clicks)} ${num(r.clicks) === 1 ? "click" : "clicks"}` }))))) : null,
      d.stale ? h("p", { class: "tr-mini-err", role: "status" }, icon("warning-circle"), h("span", { text: `Saved data: ${d.error || "Google could not be reached."}` })) : null,
      h("p", { class: "muted small tr-card-foot", text: d.fetched_at ? `Seven days ending yesterday. Google data from ${timeAgo(d.fetched_at)}.` : "Seven days ending yesterday." }));
  } else if (setupCode(sc.reason) === "no_site") {
    searchCard = h("section", { class: "card tr-mini tr-cta" },
      h("span", { class: "quick-ic" }, icon("google-logo")),
      h("h2", { class: "card-title", text: "Choose your Search Console property" }),
      h("p", { class: "muted small", text: "Google is connected. Pick the Search Console property for this website and the search numbers appear here." }),
      h("a", { class: "btn btn-secondary btn-sm", href: "#/settings?section=google" }, icon("gear-six"), "Choose the property"));
  } else if (isNotConnected(sc.reason)) {
    searchCard = h("section", { class: "card tr-mini tr-cta" },
      h("span", { class: "quick-ic" }, icon("google-logo")),
      h("h2", { class: "card-title", text: "Connect Search Console" }),
      h("p", { class: "muted small", text: "See which Google searches bring shoppers to the website, and where the pages rank." }),
      h("ul", { class: "tr-cta-list" }, [["cursor-click", "Clicks and impressions from Google"], ["magnifying-glass", "The searches people typed"], ["ranking", "Average position, week by week"]].map(([ic, t]) =>
        h("li", null, icon(ic), h("span", { text: t })))),
      h("a", { class: "btn btn-secondary btn-sm", href: "#/settings?section=google" }, icon("plugs-connected"), "Set up the connection"));
  } else {
    if (sc.reason?.status === 401) return;
    searchCard = h("section", { class: "card tr-mini" },
      h("div", { class: "card-head" }, h("h2", { class: "card-title" }, icon("google-logo"), h("span", { text: "Google Search" })),
        h("a", { class: "link", href: "#/settings?section=google" }, "Settings", icon("arrow-right"))),
      h("p", { class: "tr-mini-err", role: "alert" }, icon("warning-circle"), h("span", { text: sc.reason?.message || "Google data could not load." })),
      h("button", { type: "button", class: "btn btn-secondary btn-sm", onclick: async e => {
        e.currentTarget.disabled = true; invalidate("search:7");
        try { await load("search", 7); } catch { /* repaint shows it */ }
        if (cu.alive()) renderDashboardTraffic(container, ctx);
      } }, icon("arrow-clockwise"), "Retry"));
  }
  fill(row, searchCard, sourcesCard);
  row.classList.toggle("is-single", !sourcesCard);
}

/* ======================= Settings: Google connection ======================= */
const GSC_RE = /^sc-domain:[a-z0-9-]+(\.[a-z0-9-]+)+$/i;
const URL_PREFIX_RE = /^https?:\/\/[^\s/?#]+\/\S*$/i;

/** Validate a pasted or chosen key in the browser. Only client_email is ever shown back. */
function parseKey(text) {
  const raw = String(text || "").trim();
  if (!raw) return { error: "" };
  if (raw.length > 20000) return { error: "This is too large to be a key file. Choose the small .json file Google downloaded." };
  let j;
  try { j = JSON.parse(raw); } catch { return { error: "This is not valid JSON. Use the whole file, from the first { to the last }." }; }
  if (!j || typeof j !== "object" || Array.isArray(j)) return { error: "This is not a service account key." };
  if (j.type !== "service_account") return { error: "This is not a service account key. In Google Cloud, open the service account, then Keys, Add key, Create new key, JSON." };
  const email = typeof j.client_email === "string" ? j.client_email.trim() : "";
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return { error: "The key has no valid client_email. Download a new JSON key." };
  if (typeof j.private_key !== "string" || !/-----BEGIN (RSA )?PRIVATE KEY-----[\s\S]+-----END (RSA )?PRIVATE KEY-----/.test(j.private_key)) {
    return { error: "The key has no private key. Download a new JSON key from Google Cloud." };
  }
  return { email, text: raw };
}
const siteValue = s => typeof s === "string" ? s : (s?.siteUrl || s?.site || s?.url || "");
function siteLabel(v) {
  if (/^sc-domain:/i.test(v)) return `${v.slice(10)} (domain property)`;
  return `${v} (URL prefix)`;
}
const PERMS = { siteOwner: "Owner", siteFullUser: "Full", siteRestrictedUser: "Restricted", siteUnverifiedUser: "Unverified" };

export async function renderGoogleSettings(container, ctx) {
  const cu = useCtx(container, ctx);
  const titleId = nextId("gs-title");
  container.classList.add("tr-gs-mount");
  const pill = h("span", { class: "chip tr-status" });
  const body = h("div", { class: "tr-gs-body" },
    h("div", { class: "skel-field" }, skel("lbl"), skel("inp")), h("div", { class: "skel-field" }, skel("lbl"), skel("inp")));
  const card = h("section", { class: "card tr-gs", id: "google", "aria-labelledby": titleId },
    h("div", { class: "tr-gs-head" },
      h("div", null,
        h("h2", { class: "card-title", id: titleId, tabindex: "-1" }, icon("google-logo"), h("span", { text: "Google connection" })),
        h("p", { class: "muted small", text: "Search Console and Google Analytics reports on the Traffic page. One read-only key serves both." })),
      pill),
    body);
  fill(container, card);
  if (cu.query.section === "google") requestAnimationFrame(() => { card.scrollIntoView({ block: "start" }); card.querySelector(".card-title")?.focus({ preventScroll: true }); });

  let status = null;      // GET /google
  let key = null;         // {email, text} loaded in this browser, not yet saved
  let replacing = false;  // connected, but the person wants to load a new key
  let sites = [];         // from the last test
  let result = null;      // last test result
  let fields = null;      // {gsc, ga4, gscManual}
  let dirtyFn = () => false;

  /* Chain onto the page's own unsaved-changes guard (the Settings form sets one with
     wireForm). Done after a microtask so it also works when called before wireForm. */
  if (cu.raw && typeof cu.raw.guard === "function") {
    queueMicrotask(() => {
      const before = typeof cu.raw.isDirty === "function" ? cu.raw.isDirty : () => false;
      cu.raw.guard(() => { try { return !!before.call(cu.raw) || dirtyFn(); } catch { return dirtyFn(); } });
    });
  }

  async function loadStatus() {
    try { status = await api("/google"); }
    catch (e) {
      if (!cu.alive() || e.status === 401) return false;
      paintPill("err", "Unavailable");
      fill(body, h("div", { class: "empty empty-error tr-gs-error", role: "alert" },
        h("div", { class: "empty-ic" }, icon("cloud-warning")),
        h("h2", { text: "The Google connection could not load" }),
        h("p", { text: e.message }),
        h("button", { type: "button", class: "btn btn-secondary", onclick: () => { fill(body, skel("inp")); loadStatus().then(ok => ok && paint()); } }, icon("arrow-clockwise"), "Retry")));
      return false;
    }
    return cu.alive();
  }
  function paintPill(state, text) {
    pill.className = `chip tr-status is-${state}`;
    pill.replaceChildren(icon(state === "on" ? "check-circle" : state === "err" ? "warning-circle" : "circle-dashed"), document.createTextNode(text));
  }
  const emailChip = email => h("span", { class: "tr-email" },
    h("code", { text: email }),
    h("button", { type: "button", class: "icon-btn", "aria-label": "Copy the service account email", title: "Copy email",
      onclick: async () => {
        try { await navigator.clipboard.writeText(email); toast("Email copied"); }
        catch { toast("Copy did not work here. Select the email and copy it.", "info"); }
      } }, icon("copy")));

  function guide(open) {
    const email = key?.email || status?.client_email || "";
    const ext = (href, text) => h("a", { class: "link", href, target: "_blank", rel: "noopener noreferrer" }, text, icon("arrow-square-out"));
    const steps = [
      ["Create a Google Cloud project", "Any name works, for example Siroya reporting. No billing is needed.", [ext("https://console.cloud.google.com/projectcreate", "Create a project")]],
      ["Turn on two APIs", "In that project, enable the Google Search Console API and the Google Analytics Data API.", [ext("https://console.cloud.google.com/apis/library/searchconsole.googleapis.com", "Search Console API"), ext("https://console.cloud.google.com/apis/library/analyticsdata.googleapis.com", "Analytics Data API")]],
      ["Create a service account", "IAM and admin, Service accounts, Create service account. Skip the optional roles.", [ext("https://console.cloud.google.com/iam-admin/serviceaccounts", "Service accounts")]],
      ["Create a JSON key", "Open the service account, then Keys, Add key, Create new key, JSON. A small .json file downloads. Keep it private, like a password.", []],
      ["Add it to Search Console", "Search Console, Settings, Users and permissions, Add user. Paste the service account email and choose Restricted.", [ext("https://search.google.com/search-console/users", "Users and permissions")]],
      ["Add it to Google Analytics", "Admin, Property access management, Add users. Paste the same email with the Viewer role.", [ext("https://analytics.google.com/analytics/web/", "Google Analytics")]],
      ["Load the key here", "Choose the .json file below and press Connect and test. Then pick the Search Console property and add the GA4 property ID.", []]
    ];
    return h("details", { class: "tr-guide", open: open || null },
      h("summary", null, icon("list-numbers"), h("span", { text: "Setup guide" }), h("span", { class: "muted small", text: "about 10 minutes" }), icon("caret-down", "tr-caret")),
      h("ol", { class: "tr-steps" }, steps.map(([title, text, links], i) => h("li", null,
        h("span", { class: "tr-step-n", "aria-hidden": "true", text: String(i + 1) }),
        h("div", { class: "tr-step-body" },
          h("strong", { text: title }),
          h("p", { class: "muted small", text }),
          (i === 4 || i === 5) && email ? emailChip(email) : null,
          links.length ? h("div", { class: "tr-step-links" }, links) : null)))));
  }

  function keyBlock() {
    if (status?.connected && !replacing && !key) {
      return h("div", { class: "tr-keyrow" },
        h("span", { class: "tr-key-ic" }, icon("key")),
        h("div", { class: "tr-keyrow-text" }, h("strong", { text: "Key saved on the server" }), h("span", { class: "muted small", text: "For safety it is never shown again." })),
        h("button", { type: "button", class: "btn btn-secondary btn-sm", onclick: () => { replacing = true; paint(); body.querySelector("input[type=file]")?.focus(); } }, icon("arrow-clockwise"), "Replace key"));
    }
    if (key) {
      return h("div", { class: "tr-keyrow is-loaded", role: "status" },
        h("span", { class: "tr-key-ic" }, icon("seal-check")),
        h("div", { class: "tr-keyrow-text" }, h("strong", { text: "Key ready to save" }), h("span", { class: "tr-ellip small", text: key.email })),
        h("button", { type: "button", class: "btn btn-ghost btn-sm", onclick: () => { key = null; paint(); } }, icon("x"), "Use a different key"));
    }
    const fileId = nextId("gs-file"), taId = nextId("gs-key"), errId = taId + "-err", hintId = taId + "-hint";
    const err = h("p", { class: "field-err", id: errId, hidden: true });
    const showErr = msg => {
      err.hidden = !msg;
      err.replaceChildren(...(msg ? [icon("warning-circle"), document.createTextNode(" " + msg)] : []));
      wrap.classList.toggle("invalid", !!msg);
      msg ? ta.setAttribute("aria-invalid", "true") : ta.removeAttribute("aria-invalid");
    };
    const accept = text => {
      const r = parseKey(text);
      if (r.text) { key = { email: r.email, text: r.text }; ta.value = ""; paint(); toast("Key loaded. Press Connect and test to save it.", "info"); return true; }
      showErr(r.error); return false;
    };
    const file = h("input", { type: "file", id: fileId, accept: ".json,application/json", class: "sr-only tr-file" });
    file.addEventListener("change", async () => {
      const f = file.files?.[0];
      file.value = "";
      if (!f) return;
      if (f.size > 20000) { showErr("This file is too large to be a key file. Choose the small .json file Google downloaded."); return; }
      try { accept(await f.text()); } catch { showErr("That file could not be read. Try again or paste its contents below."); }
    });
    const ta = h("textarea", { id: taId, rows: 4, class: "tr-mono", placeholder: '{ "type": "service_account", "client_email": "…", "private_key": "…" }', spellcheck: "false", autocomplete: "off", autocapitalize: "off", "aria-describedby": `${hintId} ${errId}` });
    const tryParse = debounce(() => { const v = ta.value.trim(); if (v.endsWith("}")) accept(v); }, 250);
    ta.addEventListener("input", () => { if (!ta.value.trim()) showErr(""); else tryParse(); });
    ta.addEventListener("blur", () => { if (ta.value.trim()) accept(ta.value); });
    const drop = h("div", { class: "tr-drop" },
      file,
      h("label", { for: fileId, class: "btn btn-secondary" }, icon("file-arrow-up"), "Choose key file"),
      h("span", { class: "muted small", text: "or drop the .json file here" }));
    drop.addEventListener("dragover", e => { e.preventDefault(); drop.classList.add("dragover"); });
    drop.addEventListener("dragleave", () => drop.classList.remove("dragover"));
    drop.addEventListener("drop", async e => {
      e.preventDefault(); drop.classList.remove("dragover");
      const f = e.dataTransfer?.files?.[0];
      if (!f) return;
      if (f.size > 20000) { showErr("This file is too large to be a key file."); return; }
      accept(await f.text());
    });
    const wrap = h("div", { class: "field tr-keyfield" },
      h("div", { class: "label-row" }, h("label", { for: taId, text: "Service account key (JSON)" }),
        replacing ? h("button", { type: "button", class: "linkish small", onclick: () => { replacing = false; paint(); } }, "Keep the saved key") : null),
      drop,
      h("p", { class: "hint", id: hintId, text: "Or paste the contents of the file. It is checked here first, and only the service account email is shown back." }),
      ta, err);
    return wrap;
  }

  function propertyFields() {
    const saved = { gsc: status?.gsc_site || "", ga4: status?.ga4_property || "" };
    if (!fields) fields = { gsc: saved.gsc, ga4: saved.ga4, gscManual: false };
    const gscId = nextId("gs-site"), ga4Id = nextId("gs-ga4");
    let gscInput;
    const list = [...new Set(sites.map(siteValue).filter(Boolean))];
    if (list.length && !fields.gscManual) {
      const opts = [{ value: "", label: "Choose a property" }, ...list.map(v => ({ value: v, label: siteLabel(v) }))];
      if (fields.gsc && !list.includes(fields.gsc)) opts.push({ value: fields.gsc, label: `${fields.gsc} (saved, not visible to this key)` });
      gscInput = h("select", { id: gscId, name: "gsc_site", "aria-describedby": gscId + "-hint " + gscId + "-err" }, opts.map(o => h("option", { value: o.value, selected: o.value === fields.gsc }, o.label)));
    } else {
      gscInput = h("input", { id: gscId, name: "gsc_site", type: "text", placeholder: "sc-domain:siroya.com", spellcheck: "false", autocomplete: "off", autocapitalize: "off", "aria-describedby": gscId + "-hint " + gscId + "-err" });
      gscInput.value = fields.gsc;
    }
    const ga4Input = h("input", { id: ga4Id, name: "ga4_property", type: "text", inputmode: "numeric", placeholder: "e.g. 412345678", autocomplete: "off", "aria-describedby": ga4Id + "-hint " + ga4Id + "-err" });
    ga4Input.value = fields.ga4;
    const gscErr = h("p", { class: "field-err", id: gscId + "-err", hidden: true });
    const ga4Err = h("p", { class: "field-err", id: ga4Id + "-err", hidden: true });
    const setErr = (input, el, msg) => {
      el.hidden = !msg;
      el.replaceChildren(...(msg ? [icon("warning-circle"), document.createTextNode(" " + msg)] : []));
      el.closest(".field").classList.toggle("invalid", !!msg);
      msg ? input.setAttribute("aria-invalid", "true") : input.removeAttribute("aria-invalid");
      return !msg;
    };
    const onChange = () => { fields.gsc = gscInput.value.trim(); fields.ga4 = ga4Input.value.trim(); refreshButtons(); };
    gscInput.addEventListener("input", onChange); gscInput.addEventListener("change", onChange);
    ga4Input.addEventListener("input", () => {
      const v = ga4Input.value.replace(/^\s*properties\//i, "").replace(/\s+/g, "");
      if (v !== ga4Input.value) ga4Input.value = v;
      onChange();
      if (ga4Input.closest(".field").classList.contains("invalid")) check();
    });
    gscInput.addEventListener("blur", () => {
      let v = gscInput.value.trim();
      if (/^https?:\/\/[^\s/?#]+$/i.test(v)) { v += "/"; gscInput.value = v; onChange(); }
      if (v) check();
    });
    function check() {
      const g = gscInput.value.trim(), a = ga4Input.value.trim();
      const okG = setErr(gscInput, gscErr, !g || GSC_RE.test(g) || URL_PREFIX_RE.test(g) ? "" : "Use sc-domain:example.com for a domain property, or the full address ending in / for a URL-prefix property.");
      const okA = setErr(ga4Input, ga4Err, !a || /^\d{5,15}$/.test(a) ? "" : "Use the numeric property ID, for example 412345678. It is not the G- measurement ID.");
      if (!okG) gscInput.focus(); else if (!okA) ga4Input.focus();
      return okG && okA;
    }
    const gscHint = list.length
      ? `This key can see ${list.length === 1 ? "1 property" : `${list.length} properties`}.`
      : status?.connected ? "Press Test connection to list the properties this key can see." : "Filled in after Connect and test. You can also type it.";
    const el = h("div", { class: "grid-2 tr-props" },
      h("div", { class: "field" },
        h("div", { class: "label-row" }, h("label", { for: gscId, text: "Search Console property" }),
          list.length ? h("button", { type: "button", class: "linkish small", onclick: () => { fields.gscManual = !fields.gscManual; paint(); } }, fields.gscManual ? "Pick from the list" : "Type it instead") : null),
        gscInput,
        h("p", { class: "hint", id: gscId + "-hint", text: gscHint }), gscErr),
      h("div", { class: "field" },
        h("div", { class: "label-row" }, h("label", { for: ga4Id }, "GA4 property ID", h("span", { class: "opt", text: " (optional)" }))),
        ga4Input,
        h("p", { class: "hint", id: ga4Id + "-hint", text: "Google Analytics, Admin, Property details. A number, not the G- measurement ID." }), ga4Err));
    return { el, check, saved };
  }

  function resultBox() {
    if (!result) return null;
    if (!result.ok) {
      return h("div", { class: "tr-result is-bad", role: "alert" }, icon("warning-circle"),
        h("div", null, h("strong", { text: "The connection test failed" }), h("p", { text: result.error || "Google did not accept the key." })));
    }
    const list = [...new Set(sites.map(siteValue).filter(Boolean))];
    const chosen = fields?.gsc || status?.gsc_site || "";
    const lines = [
      ["ok", `Signed in to Google as ${status?.client_email || key?.email || "the service account"}.`],
      list.length ? ["ok", `Search Console: ${list.length === 1 ? "1 property" : `${list.length} properties`} found.`]
        : ["warn", `Search Console: no properties yet. Add ${status?.client_email || "the service account email"} as a user in Search Console, then test again.`],
      chosen && list.length && !list.includes(chosen) ? ["warn", `This key cannot see ${chosen}. Add the email as a user on that property, or pick another one.`] : null,
      status?.ga4_property || fields?.ga4
        ? (result.ga4_ok ? ["ok", "Google Analytics: the property answered."] : ["warn", `Google Analytics: ${result.ga4_error || result.error || "no access yet. Add the email to the property with the Viewer role."}`])
        : ["info", "Google Analytics: add the GA4 property ID to test it too."]
    ].filter(Boolean);
    const bad = lines.some(l => l[0] === "warn");
    return h("div", { class: `tr-result ${bad ? "is-warn" : "is-good"}`, role: "status" }, icon(bad ? "info" : "check-circle"),
      h("div", null, h("strong", { text: bad ? "Connected, with something to fix" : "Everything works" }),
        h("ul", { class: "tr-result-list" }, lines.map(([k, t]) => h("li", { class: `is-${k}` }, icon(k === "ok" ? "check" : k === "warn" ? "warning" : "info"), h("span", { text: t }))))));
  }

  let buttons = {};
  let props = null;
  const isDirty = () => !!key || (!!props && (fields.gsc !== props.saved.gsc || fields.ga4 !== props.saved.ga4));
  dirtyFn = isDirty;
  function refreshButtons() {
    const { save, test } = buttons;
    if (!save) return;
    const dirty = isDirty();
    if (status?.connected) {
      save.disabled = !dirty || save.classList.contains("is-saving");
      test.querySelector(".lbl").textContent = dirty ? "Save and test" : "Test connection";
    }
  }
  function busy(btn, on, label) {
    btn.disabled = on;
    btn.classList.toggle("is-saving", on);
    btn.querySelector("i").className = on ? "ph ph-spinner-gap" : `ph ph-${btn.dataset.icon}`;
    btn.querySelector(".lbl").textContent = on ? label : btn.dataset.label;
  }
  const mkBtn = (cls, ic, label, onclick) => h("button", { type: "button", class: `btn ${cls}`, dataset: { icon: ic, label }, onclick }, icon(ic), h("span", { class: "lbl", text: label }));

  async function save({ quiet = false } = {}) {
    if (!props.check()) return false;
    const body_ = {};
    if (key) body_.service_account_json = key.text;
    if (fields.gsc !== props.saved.gsc || fields.gsc) body_.gsc_site = fields.gsc;
    if (fields.ga4 !== props.saved.ga4 || fields.ga4) body_.ga4_property = fields.ga4;
    const r = await api("/google", { method: "PUT", body: body_ });
    key = null; replacing = false;
    status = r && typeof r.connected === "boolean" ? r : await api("/google");
    fields = { gsc: status.gsc_site || "", ga4: status.ga4_property || "", gscManual: fields.gscManual };
    invalidate(...GOOGLE_KEYS);
    if (!quiet) toast("Google connection saved");
    return true;
  }
  async function test() {
    let r;
    try { r = await api("/google/test", { method: "POST", body: {} }); }
    catch (e) { if (e.status === 401) throw e; r = { ok: false, error: e.message, sites: [] }; }
    result = r || { ok: false };
    sites = rowsOf(r?.sites);
    if (result.ok && !fields.gsc) {
      const list = [...new Set(sites.map(siteValue).filter(Boolean))];
      if (list.length === 1) fields.gsc = list[0];
    }
    try { const s = await api("/google"); if (s && typeof s.connected === "boolean") status = s; } catch { /* keep the old status */ }
    invalidate(...GOOGLE_KEYS);
  }
  async function run(btn, label, fn) {
    busy(btn, true, label);
    try { await fn(); }
    catch (e) { if (e.status !== 401) toastError(e); } // save problems; test problems land in the result box
    finally { if (cu.alive()) { busy(btn, false); paint(); } }
  }

  function paint() {
    if (!cu.alive()) return;
    const connected = !!status?.connected;
    const err = connected && status.last_error;
    const showErrNote = err && !(result && !result.ok);
    paintPill(connected ? (err ? "err" : "on") : "off", connected ? (err ? "Needs attention" : "Connected") : "Not connected");

    const facts = connected ? h("dl", { class: "tr-facts" },
      h("div", null, h("dt", { text: "Service account" }), h("dd", null, status.client_email ? emailChip(status.client_email) : h("span", { class: "muted", text: "Unknown" }))),
      h("div", null, h("dt", { text: "Search Console" }), h("dd", { text: status.gsc_site ? siteLabel(status.gsc_site) : "Not chosen yet" })),
      h("div", null, h("dt", { text: "Google Analytics" }), h("dd", { text: status.ga4_property ? `Property ${status.ga4_property}` : "Not set" })),
      h("div", null, h("dt", { text: "Last updated" }), h("dd", { title: status.last_sync ? fmtDate(status.last_sync) : null, text: status.last_sync ? timeAgo(status.last_sync) : status.connected_at ? `Connected ${timeAgo(status.connected_at)}` : "Not yet" }))) : null;

    props = propertyFields();
    buttons = {};
    let actions;
    if (connected) {
      buttons.save = mkBtn("btn-primary", "check", "Save connection", () => run(buttons.save, "Saving…", () => save()));
      buttons.test = mkBtn("btn-secondary", "plugs-connected", "Test connection", () => run(buttons.test, "Testing…", async () => { if (isDirty() && !(await save({ quiet: true }))) return; await test(); }));
      buttons.disconnect = mkBtn("btn-danger-ghost", "link-break", "Disconnect", disconnect);
      actions = h("div", { class: "tr-gs-actions" }, h("div", { class: "tr-gs-actions-main" }, buttons.save, buttons.test), buttons.disconnect);
    } else {
      buttons.save = mkBtn("btn-primary", "plugs-connected", "Connect and test", () => {
        if (!key) { toast("Choose the JSON key file first.", "error"); body.querySelector("input[type=file]")?.focus(); return; }
        run(buttons.save, "Connecting…", async () => { if (await save({ quiet: true })) { await test(); if (result?.ok) toast("Google connected"); } });
      });
      buttons.test = buttons.save;
      actions = h("div", { class: "tr-gs-actions" }, h("div", { class: "tr-gs-actions-main" }, buttons.save));
    }

    fill(body,
      facts,
      showErrNote ? h("p", { class: "note tr-note-err", role: "alert" }, icon("warning-circle"), h("span", null, h("strong", { text: "Last update failed. " }), status.last_error)) : null,
      guide(!connected),
      h("form", { class: "tr-gs-form", novalidate: true, onsubmit: e => { e.preventDefault(); buttons.save.click(); } },
        keyBlock(),
        props.el,
        h("div", { "aria-live": "polite" }, resultBox()),
        actions));
    refreshButtons();
  }

  async function disconnect() {
    const ok = await confirmDialog({
      title: "Disconnect Google?",
      message: "The key is deleted from this server and the Google Search and Google Analytics reports stop updating. Website numbers are not affected. The key itself keeps working until you also delete it in Google Cloud (IAM and admin, Service accounts, the account, Keys). You can connect again at any time.",
      confirmLabel: "Disconnect", danger: true, icon: "link-break"
    });
    if (!ok) return;
    busy(buttons.disconnect, true, "Disconnecting…");
    try {
      await api("/google", { method: "DELETE" });
      key = null; replacing = false; sites = []; result = null; fields = null;
      invalidate(...GOOGLE_KEYS);
      toast("Google disconnected");
      if (await loadStatus()) paint();
    } catch (e) {
      if (e.status !== 401) toastError(e);
      if (cu.alive()) busy(buttons.disconnect, false);
    }
  }

  if (await loadStatus()) paint();
}
