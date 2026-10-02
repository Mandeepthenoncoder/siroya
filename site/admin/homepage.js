/* Siroya admin: homepage.
   #/homepage edits the landing page banner in one of three modes (single
   image, slideshow, video), its look (shade, text position, slide timing)
   and the featured collection further down. A live preview mirrors the
   public hero at desktop and phone sizes as you type.
   Export: renderHomepage(container, ctx).
   Text from the server only ever goes in through textContent and
   setAttribute (h()), never innerHTML. */
import { $, $$, h, fill, icon, iconBtn, api, itemOf, listOf, normProduct, getCollections, getCategories, toast, confirmDialog,
  pageHead, errorState, skeletonForm, field, editFrame, dirtyTracker, imgSrc, nextId, dragSort, moveItem,
  ensureAuth, errorText, ApiError } from "./lib.js";
import { runUpload, imageField } from "./media.js";

/* ======================= Rules (kept in step with the server) ======================= */
const MODES = ["image", "slideshow", "video"];
const FOCI = ["left", "center", "right"];
const MAX_SLIDES = 6;
const CAP = { eyebrow: 50, headline: 70, text: 160, alt: 140, label: 30, link: 300, fHeadline: 70, fText: 200 };
const LINK_RE = /^[a-z0-9][a-z0-9\-_/.?=&#%]*$/i;
const HTTPS_RE = /^https:\/\/[^\s"'<>]+$/i;
const LINK_MSG = "Use a page on this site, such as collections.html, or a full address starting with https://";
const VIDEO_MAX = 80 * 1024 * 1024;
const VIDEO_GOOD = 20 * 1024 * 1024;
const IMG_ACCEPT = "image/jpeg,image/png,image/webp,image/gif,image/avif,image/heic,image/heif";
const JPEG_Q = 0.85;
/* The preview renders the real page size, then scales it down. */
const DESK = { w: 1440, h: 900 }, PHONE = { w: 390, h: 844 };
/* object-position for each focus choice, as in siroya.css and hero.css
   (desktop photo on a desktop screen or on a phone screen). */
const POS = {
  desktop: { left: "30% center", center: "50% center", right: "68% center" },
  phone: { left: "26% center", center: "50% center", right: "72% center" }
};
const MODE_OPTS = [
  { value: "image", label: "Single image", icon: "image", desc: "One photo with your headline and buttons on top." },
  { value: "slideshow", label: "Slideshow", icon: "images", desc: "Up to 6 photos that fade from one to the next." },
  { value: "video", label: "Video", icon: "video-camera", desc: "A short muted video that loops behind your headline." }
];
const FOCUS_LABEL = { left: "Left", center: "Centre", right: "Right" };

export const validLink = v => HTTPS_RE.test(v) || (LINK_RE.test(v) && !v.includes(".."));

/* ======================= Data ======================= */
const S = v => (typeof v === "string" ? v : v == null ? "" : String(v));
const line = v => S(v).replace(/\s+/g, " ").trim();
const clamp = (n, a, b) => Math.min(b, Math.max(a, n));
const blankSlide = () => ({ image: "", image_mobile: "", focus: "right", eyebrow: "", headline: "", text: "", cta_label: "", cta_link: "", cta2_label: "", cta2_link: "", alt: "" });
const TEXT_KEYS = ["eyebrow", "headline", "text", "cta_label", "cta_link", "cta2_label", "cta2_link", "alt"];

function normSlide(x) {
  const s = blankSlide();
  if (!x || typeof x !== "object") return s;
  for (const k of Object.keys(s)) if (k !== "focus") s[k] = S(x[k]);
  s.focus = FOCI.includes(x.focus) ? x.focus : "right";
  return s;
}
/** Server data (or nothing) to the editor's state, with every field present. */
function normalize(raw) {
  const r = raw && typeof raw === "object" ? raw : {};
  const hero = r.hero && typeof r.hero === "object" ? r.hero : {};
  const slides = (Array.isArray(hero.slides) ? hero.slides : []).slice(0, MAX_SLIDES).map(normSlide);
  if (!slides.length) slides.push(blankSlide());
  const v = hero.video && typeof hero.video === "object" ? hero.video : {};
  const f = r.featured && typeof r.featured === "object" ? r.featured : {};
  const ov = hero.overlay == null || hero.overlay === "" ? NaN : Number(hero.overlay);
  const iv = Number(hero.interval);
  return {
    hero: {
      mode: MODES.includes(hero.mode) ? hero.mode : "image",
      slides,
      video: { src: S(v.src), src_mobile: S(v.src_mobile), poster: S(v.poster), poster_mobile: S(v.poster_mobile) },
      interval: Number.isFinite(iv) ? clamp(Math.round(iv), 4, 12) : 6,
      overlay: Number.isFinite(ov) ? clamp(Math.round(ov * 100) / 100, 0, 0.8) : 0.45,
      align: hero.align === "center" ? "center" : "left"
    },
    featured: { collection: S(f.collection), image: S(f.image), headline: S(f.headline), text: S(f.text), cta_label: S(f.cta_label) }
  };
}
/** What gets saved: single-line, trimmed text, only the documented fields. */
function snapshot(st) {
  const h_ = st.hero, v = h_.video, f = st.featured;
  return {
    hero: {
      mode: h_.mode,
      slides: h_.slides.map(s => {
        const o = { image: S(s.image), image_mobile: S(s.image_mobile), focus: s.focus };
        for (const k of TEXT_KEYS) o[k] = line(s[k]);
        return o;
      }),
      video: { src: S(v.src), src_mobile: S(v.src_mobile), poster: S(v.poster), poster_mobile: S(v.poster_mobile) },
      interval: h_.interval, overlay: h_.overlay, align: h_.align
    },
    featured: { collection: S(f.collection), image: S(f.image), headline: line(f.headline), text: line(f.text), cta_label: line(f.cta_label) }
  };
}

/* ======================= Small helpers ======================= */
const fmtBytes = b => b < 1048576 ? `${Math.max(1, Math.round(b / 1024))} KB` : `${(b / 1048576).toFixed(b < 10 * 1048576 ? 1 : 0)} MB`;
const fmtDur = sec => { const s = Math.round(sec); return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`; };
const fileOf = p => { const last = String(p).split("/").pop() || String(p); try { return decodeURIComponent(last); } catch { return last; } };
const hasFiles = e => [...(e.dataTransfer?.types || [])].includes("Files");
const isImageFile = f => /^image\//.test(f.type) || /\.(jpe?g|png|webp|gif|avif|heic|heif)$/i.test(f.name || "");
const reducedMotion = () => { try { return matchMedia("(prefers-reduced-motion: reduce)").matches; } catch { return false; } };

/** Pasted addresses tidied: own site to a relative path, http to https, no leading slash. */
function tidyLink(v) {
  let s = S(v).trim();
  if (!s) return "";
  const own = location.origin + "/";
  if (s.startsWith(own)) s = s.slice(own.length);
  if (/^http:\/\//i.test(s)) s = "https://" + s.slice(7);
  else if (/^www\./i.test(s)) s = "https://" + s;
  if (!/^https:\/\//i.test(s)) s = s.replace(/^(\.\/|\/)+/, "");
  return s;
}

/** Router ctx is optional; a bare container works too. */
function useCtx(container, ctx) {
  const c = ctx || {};
  return {
    alive: () => (typeof c.alive === "function" ? c.alive() : true) && container.isConnected,
    guard: fn => { if (typeof c.guard === "function") c.guard(fn); else c.isDirty = fn; },
    onLeave: fn => { if (typeof c.onLeave === "function") c.onLeave(fn); },
    setTitle: t => { if (typeof c.setTitle === "function") c.setTitle(t); }
  };
}

/** Segmented control on real radio buttons (arrow keys move between options). */
function segmented({ label, labelledby, options, value, onChange, className = "" }) {
  const name = nextId("seg");
  const inputs = [];
  const el = h("div", { class: ["hp-seg", className], role: "radiogroup", "aria-label": labelledby ? null : label, "aria-labelledby": labelledby || null },
    options.map(op => {
      const input = h("input", { type: "radio", name, value: op.value, class: "hp-seg-input", checked: op.value === value, "aria-describedby": op.describedby || null });
      input.addEventListener("change", () => { if (input.checked) onChange(op.value); });
      inputs.push(input);
      return h("label", { class: "hp-seg-opt" }, input,
        h("span", { class: "hp-seg-box" }, op.visual || (op.icon ? icon(op.icon) : null), h("span", { class: "hp-seg-label", text: op.label })));
    }));
  return { el, set(v) { inputs.forEach(i => { i.checked = i.value === v; }); }, focus() { (inputs.find(i => i.checked) || inputs[0]).focus(); } };
}

/** Slider with its value shown beside the label. */
function rangeField({ label, min, max, step, value, fmt, hint, ends, onInput }) {
  const id = nextId("rng");
  const out = h("output", { class: "hp-range-val", for: id });
  const input = h("input", { type: "range", id, min, max, step, value, class: "hp-range", "aria-describedby": hint ? id + "-h" : null });
  const paint = () => {
    const v = Number(input.value);
    out.textContent = fmt(v);
    input.style.setProperty("--pct", `${((v - min) / (max - min)) * 100}%`);
    input.setAttribute("aria-valuetext", fmt(v));
  };
  input.addEventListener("input", () => { paint(); onInput(Number(input.value)); });
  paint();
  const wrap = h("div", { class: "field hp-rangef" },
    h("div", { class: "label-row" }, h("label", { for: id, text: label }), out),
    input,
    ends ? h("div", { class: "hp-range-ends", "aria-hidden": "true" }, h("span", { text: ends[0] }), h("span", { text: ends[1] })) : null,
    hint ? h("p", { class: "hint", id: id + "-h", text: hint }) : null);
  return { wrap, input, set(v) { input.value = v; paint(); } };
}

/** Same markup as the progress bars in media.js. */
function progressBar(job) {
  const pct = Math.round((job.pct || 0) * 100);
  const label = job.state === "waiting" ? "Waiting" : job.state === "preparing" ? "Resizing" : job.state === "uploading" ? `Uploading ${pct}%` : job.state === "done" ? "Uploaded" : "Failed";
  return h("div", { class: `prog prog-${job.state}` },
    h("div", { class: "prog-bar", role: "progressbar", "aria-label": `Upload of ${job.file.name}`, "aria-valuemin": "0", "aria-valuemax": "100", "aria-valuenow": String(pct) },
      h("span", { style: { width: `${job.state === "preparing" ? 8 : Math.max(4, pct)}%` } })),
    h("span", { class: "prog-text", text: label }));
}

/* ======================= Banner photos: resize then upload ======================= */
async function decodeImage(file) {
  if ("createImageBitmap" in window) {
    try { return await createImageBitmap(file, { imageOrientation: "from-image" }); } catch { /* fall back to <img> */ }
  }
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.decoding = "async";
    img.onload = () => { resolve(img); setTimeout(() => URL.revokeObjectURL(url), 5000); };
    img.onerror = () => { URL.revokeObjectURL(url); reject(new Error("unreadable")); };
    img.src = url;
  });
}
/** Long edge down to maxEdge, JPEG q0.85 on a cream ground (banners never need transparency). */
async function prepareBanner(file, maxEdge) {
  if (file.size > 60 * 1048576) throw new Error("This file is over 60 MB. Please choose a smaller photo.");
  let src;
  try { src = await decodeImage(file); } catch { throw new Error("This file could not be read. Please use a JPG, PNG or WebP photo."); }
  const w0 = src.naturalWidth || src.width, h0 = src.naturalHeight || src.height;
  if (!w0 || !h0) throw new Error("This file could not be read. Please use a JPG, PNG or WebP photo.");
  const scale = Math.min(1, maxEdge / Math.max(w0, h0));
  const w = Math.max(1, Math.round(w0 * scale)), hh = Math.max(1, Math.round(h0 * scale));
  let cur = src, cw = w0, ch = h0;
  while (cw > w * 2) { // halve in steps for a cleaner downscale
    const nw = Math.round(cw / 2), nh = Math.round(ch / 2);
    const c = document.createElement("canvas"); c.width = nw; c.height = nh;
    const x = c.getContext("2d"); x.imageSmoothingEnabled = true; x.imageSmoothingQuality = "high";
    x.drawImage(cur, 0, 0, nw, nh);
    cur = c; cw = nw; ch = nh;
  }
  const canvas = document.createElement("canvas"); canvas.width = w; canvas.height = hh;
  const ctx = canvas.getContext("2d");
  ctx.fillStyle = "#F5F2EC"; ctx.fillRect(0, 0, w, hh);
  ctx.imageSmoothingEnabled = true; ctx.imageSmoothingQuality = "high";
  ctx.drawImage(cur, 0, 0, w, hh);
  src.close?.();
  const blob = await new Promise(r => canvas.toBlob(b => r(b), "image/jpeg", JPEG_Q));
  if (!blob) throw new Error("This photo could not be processed. Please try a different file.");
  if (blob.size > 10 * 1048576) throw new Error("This image is still over 10 MB after resizing. Please use a smaller photo.");
  const dataUrl = await new Promise((res, rej) => { const fr = new FileReader(); fr.onload = () => res(fr.result); fr.onerror = () => rej(new Error("This photo could not be read.")); fr.readAsDataURL(blob); });
  const base = (file.name || "banner").replace(/\.[^.]+$/, "").replace(/[^\w.-]+/g, "-").slice(0, 80) || "banner";
  return { dataUrl, filename: `${base}.jpg`, width: w, height: hh, bytes: blob.size, preview: URL.createObjectURL(blob), srcW: w0, srcH: h0 };
}

/** One banner photo: frame, Upload/Replace, Remove, progress, a size note and inline errors. */
function bannerImage({ label, value = "", ratio, hint, required = false, optional = false, maxEdge, kind, empty, onChange, onBusy }) {
  let url = S(value), job = null, info = null;
  const id = nextId("bimg"), labelId = id + "-l", errId = id + "-e", hintId = id + "-h";
  const fileInput = h("input", { type: "file", accept: IMG_ACCEPT, class: "sr-only", tabindex: "-1", "aria-hidden": "true" });
  const frame = h("div", { class: "hpimg-frame", style: { "aspect-ratio": ratio } });
  const mainBtn = h("button", { type: "button", class: "btn btn-secondary btn-sm", "aria-describedby": errId, onclick: () => { if (!active()) fileInput.click(); } });
  const removeBtn = h("button", { type: "button", class: "btn btn-ghost btn-sm", onclick: remove }, icon("trash"), "Remove");
  const status = h("div", { class: "hpimg-status" });
  const err = h("p", { class: "field-err", id: errId, hidden: true });
  const el = h("div", { class: ["field", "hpimg", `hpimg-${kind}`], role: "group", "aria-labelledby": labelId, "aria-describedby": hint ? hintId : null },
    h("div", { class: "label-row" }, h("span", { class: "label", id: labelId }, label,
      required ? h("span", { class: "req", "aria-hidden": "true", text: " *" }) : null,
      optional ? h("span", { class: "opt", text: " (optional)" }) : null)),
    frame, h("div", { class: "hpimg-btns" }, mainBtn, removeBtn), status, err,
    hint ? h("p", { class: "hint", id: hintId, text: hint }) : null, fileInput);

  function active() { return !!(job && ["waiting", "preparing", "uploading"].includes(job.state)); }
  function paintFrame() {
    const src = url ? imgSrc(url) : job?.preview || "";
    if (frame.dataset.src !== src || !frame.firstChild) {
      frame.dataset.src = src;
      fill(frame, src ? h("img", { src, alt: "", decoding: "async" })
        : h("button", { type: "button", class: "hpimg-empty", tabindex: "-1", "aria-hidden": "true", onclick: () => fileInput.click() }, icon("image"), h("span", { text: empty })));
    }
    frame.querySelector(".imgf-over")?.remove();
    if (active()) frame.append(h("div", { class: "imgf-over" }, progressBar(job)));
  }
  function qualityNote() {
    if (!info) return null;
    const { w, h: hh } = info;
    let msg = "";
    if (kind === "desktop") {
      if (hh > w) msg = `This photo is portrait (${w} x ${hh}). The banner is wide, so the top and bottom will be cut off. A wide photo works best here.`;
      else if (w < 1600) msg = `This photo is ${w} x ${hh}, so it may look soft on large screens. 2400 x 1350 is best.`;
    } else if (kind === "phone" && w > hh * 1.05) msg = `This photo is landscape (${w} x ${hh}). A portrait 4:5 photo fills a phone screen better.`;
    return msg ? h("p", { class: "note hp-note" }, icon("info"), h("span", { text: msg })) : null;
  }
  function render() {
    paintFrame();
    fill(mainBtn, icon("upload-simple"), url ? "Replace" : "Upload image");
    mainBtn.setAttribute("aria-disabled", String(active()));
    removeBtn.hidden = !url || active();
    fill(status,
      job?.state === "error" ? h("p", { class: "field-err", role: "alert" }, icon("warning-circle"), " ", job.error) : null,
      url && !active() ? h("span", { class: "muted small hpimg-name", text: fileOf(url) }) : null,
      url ? qualityNote() : null);
  }
  function remove() {
    url = ""; info = null; render(); onChange?.(url);
    mainBtn.focus();
  }
  async function upload(file) {
    if (active()) return;
    if (!isImageFile(file)) { api_.error("Please choose an image file (JPG, PNG or WebP)."); return; }
    api_.error("");
    job = { file, state: "preparing", pct: 0, onUpdate: render };
    render(); onBusy?.();
    try {
      job.prep = await prepareBanner(file, maxEdge);
      info = { w: job.prep.srcW, h: job.prep.srcH };
      const u = await runUpload(job);
      const pv = job.preview;
      url = u; job = null; render(); onChange?.(url); onBusy?.();
      if (pv) setTimeout(() => URL.revokeObjectURL(pv), 30000);
    } catch (e) {
      if (job) { job.state = "error"; job.error = e.message || "Upload failed."; }
      info = null; render(); onBusy?.();
      toast(e.message || "Upload failed.", "error");
    }
  }
  fileInput.addEventListener("change", () => { if (fileInput.files[0]) upload(fileInput.files[0]); fileInput.value = ""; });
  frame.addEventListener("dragover", e => { if (!hasFiles(e)) return; e.preventDefault(); frame.classList.add("dragover"); });
  frame.addEventListener("dragleave", () => frame.classList.remove("dragover"));
  frame.addEventListener("drop", e => { if (!hasFiles(e)) return; e.preventDefault(); frame.classList.remove("dragover"); if (e.dataTransfer.files[0]) upload(e.dataTransfer.files[0]); });
  render();
  const api_ = {
    el, value: () => url, busy: active,
    set(v) { url = S(v); info = null; render(); },
    error(msg) {
      err.hidden = !msg;
      if (msg) err.replaceChildren(icon("warning-circle"), document.createTextNode(" " + msg)); else err.replaceChildren();
      el.classList.toggle("invalid", !!msg);
    },
    focus() { mainBtn.focus(); }
  };
  return api_;
}

/* ======================= Video: raw upload with progress ======================= */
function videoType(file) {
  const ext = (String(file.name).split(".").pop() || "").toLowerCase();
  return file.type || (ext === "webm" ? "video/webm" : ext === "mp4" || ext === "m4v" ? "video/mp4" : ext === "mov" ? "video/quicktime" : "");
}
/** POST the file as the raw request body; resolves with the saved url. */
function sendVideo(job, onProgress, retried = false) {
  return new Promise((resolve, reject) => {
    const x = new XMLHttpRequest();
    job.xhr = x;
    x.open("POST", "/api/admin/upload-video");
    x.withCredentials = true;
    x.setRequestHeader("Content-Type", videoType(job.file));
    x.setRequestHeader("Accept", "application/json");
    const name = String(job.file.name || "video").normalize("NFKD").replace(/[^\w. -]+/g, "").slice(-120) || "video";
    x.setRequestHeader("X-Filename", name);
    x.upload.onprogress = e => { if (e.lengthComputable) { job.pct = e.loaded / e.total; onProgress(); } };
    x.onload = () => {
      let data = null; try { data = JSON.parse(x.responseText); } catch { /* not JSON */ }
      if (x.status >= 200 && x.status < 300 && data?.url) return resolve(data.url);
      if (x.status === 401 && !retried) return ensureAuth().then(() => sendVideo(job, onProgress, true)).then(resolve, reject);
      const msg = data?.error ? data.error
        : x.status === 413 ? "This video is over 80 MB. Please export a shorter or smaller version."
        : x.status === 415 ? "Please choose an MP4 or WebM video."
        : errorText(x.status, data);
      reject(new ApiError(msg, x.status, data));
    };
    x.onerror = () => reject(new ApiError("Upload failed. Check your connection and try again.", 0));
    x.onabort = () => reject(Object.assign(new ApiError("Upload cancelled.", 0), { aborted: true }));
    x.send(job.file);
  });
}

function videoField({ label, value = "", required = false, optional = false, hint, ratio = "16 / 9", onChange, onBusy }) {
  let url = S(value), job = null, meta = null, local = "";
  const id = nextId("vid"), labelId = id + "-l", errId = id + "-e", hintId = id + "-h";
  const fileInput = h("input", { type: "file", accept: "video/mp4,video/webm,.mp4,.webm", class: "sr-only", tabindex: "-1", "aria-hidden": "true" });
  const chooseLink = h("button", { type: "button", class: "linkish", onclick: () => fileInput.click() }, "choose a file");
  const chooseBtn = h("button", { type: "button", class: "btn btn-secondary drop-btn", onclick: () => fileInput.click() }, icon("upload-simple"), "Choose video");
  const drop = h("div", { class: "drop hpvid-drop", style: { "aspect-ratio": ratio } },
    icon("film-strip", "drop-ic"),
    h("div", { class: "drop-text" }, h("strong", { text: "Drag a video here" }), " or ", chooseLink),
    h("p", { class: "hint", text: "MP4 or WebM, up to 80 MB" }),
    chooseBtn);
  const media = h("div", { class: "hpvid-media", style: { "aspect-ratio": ratio } });
  const name = h("strong", { class: "hpvid-name" });
  const facts = h("span", { class: "muted small hpvid-facts" });
  const prog = h("div", { class: "hpvid-prog" });
  const warn = h("div", { class: "hpvid-warn" });
  const pickBtn = h("button", { type: "button", class: "btn btn-secondary btn-sm", "aria-describedby": errId, onclick: () => fileInput.click() });
  const removeBtn = h("button", { type: "button", class: "btn btn-ghost btn-sm", onclick: remove }, icon("trash"), "Remove");
  const cancelBtn = h("button", { type: "button", class: "btn btn-ghost btn-sm", onclick: () => job?.xhr?.abort() }, icon("x"), "Cancel upload");
  const retryBtn = h("button", { type: "button", class: "btn btn-secondary btn-sm", onclick: () => job && start() }, icon("arrow-clockwise"), "Try again");
  const filled = h("div", { class: "hpvid-filled" }, media, h("div", { class: "hpvid-info" }, name, facts), prog, warn,
    h("div", { class: "hpimg-btns" }, pickBtn, retryBtn, cancelBtn, removeBtn));
  const err = h("p", { class: "field-err", id: errId, hidden: true });
  const el = h("div", { class: ["field", "hpvid", ratio === "4 / 5" && "hpvid-portrait"], role: "group", "aria-labelledby": labelId, "aria-describedby": hint ? hintId : null },
    h("div", { class: "label-row" }, h("span", { class: "label", id: labelId }, label,
      required ? h("span", { class: "req", "aria-hidden": "true", text: " *" }) : null,
      optional ? h("span", { class: "opt", text: " (optional)" }) : null)),
    drop, filled, err, hint ? h("p", { class: "hint", id: hintId, text: hint }) : null, fileInput);

  const active = () => !!(job && job.state === "uploading");
  function makeVideo(src) {
    const v = h("video", { src, loop: true, playsinline: true, preload: "metadata", controls: true, "aria-label": `${label} preview` });
    v.muted = true; v.defaultMuted = true;
    if (!reducedMotion()) { v.autoplay = true; v.play?.().catch(() => { /* autoplay can be refused */ }); }
    v.addEventListener("loadedmetadata", () => {
      meta = { ...(meta || {}), w: v.videoWidth, h: v.videoHeight, d: v.duration };
      paintInfo();
    });
    return v;
  }
  function paintInfo() {
    name.textContent = job ? job.file.name : fileOf(url);
    const parts = [];
    if (meta?.size) parts.push(fmtBytes(meta.size));
    if (meta?.d && Number.isFinite(meta.d)) parts.push(fmtDur(meta.d));
    if (meta?.w) parts.push(`${meta.w} x ${meta.h}`);
    facts.textContent = parts.join("  ·  ");
    const notes = [];
    if (meta?.size > VIDEO_GOOD) notes.push(`Over 20 MB, so phones on mobile data wait longer before it plays. Under 20 MB is best.`);
    if (meta?.d > 30) notes.push("Longer than 30 seconds. 10 to 20 seconds is best.");
    fill(warn, notes.map(n => h("p", { class: "note hp-note" }, icon("info"), h("span", { text: n }))));
  }
  function paintProg() {
    if (!job) { fill(prog); return; }
    if (job.state === "error") { fill(prog, h("p", { class: "field-err", role: "alert" }, icon("warning-circle"), " ", job.error)); return; }
    const pct = Math.round(job.pct * 100);
    const bar = $(".prog-bar", prog);
    const text = pct >= 100 ? "Saving on the server…" : `Uploading ${pct}%  ·  ${fmtBytes(job.file.size * job.pct)} of ${fmtBytes(job.file.size)}`;
    if (bar) {
      bar.setAttribute("aria-valuenow", String(pct));
      bar.firstChild.style.width = `${Math.max(3, pct)}%`;
      $(".prog-text", prog).textContent = text;
      return;
    }
    fill(prog, h("div", { class: "prog prog-uploading" },
      h("div", { class: "prog-bar", role: "progressbar", "aria-label": `Upload of ${job.file.name}`, "aria-valuemin": "0", "aria-valuemax": "100", "aria-valuenow": String(pct) },
        h("span", { style: { width: `${Math.max(3, pct)}%` } })),
      h("span", { class: "prog-text", text })));
  }
  function render() {
    const has = !!(url || job);
    drop.hidden = has; filled.hidden = !has;
    const src = job ? local : url ? imgSrc(url) : "";
    if (media.dataset.src !== src) { media.dataset.src = src; fill(media, src ? makeVideo(src) : null); }
    fill(pickBtn, icon("upload-simple"), url || job ? "Choose another" : "Choose video");
    pickBtn.hidden = active();
    retryBtn.hidden = job?.state !== "error";
    cancelBtn.hidden = !active();
    removeBtn.hidden = !url || !!job;
    paintInfo(); paintProg();
  }
  function check(file) {
    const type = videoType(file);
    if (/quicktime/.test(type)) return "This is a .mov file. Please export it as MP4 (H.264) and try again.";
    if (!/^video\/(mp4|webm)$/.test(type)) return "Please choose an MP4 or WebM video.";
    if (!file.size) return "This file is empty. Please choose another video.";
    if (file.size > VIDEO_MAX) return `This video is ${fmtBytes(file.size)}. The limit is 80 MB and under 20 MB is best. Please export a shorter or smaller version.`;
    return "";
  }
  function pick(file) {
    if (active()) return;
    const problem = check(file);
    if (problem) { api_.error(problem); return; }
    api_.error("");
    if (local) URL.revokeObjectURL(local);
    local = URL.createObjectURL(file);
    meta = { size: file.size };
    job = { file, pct: 0, state: "uploading" };
    start();
  }
  async function start() {
    const my = job;
    my.state = "uploading"; my.pct = 0; my.error = "";
    render(); onBusy?.();
    try {
      const u = await sendVideo(my, () => { if (job === my) paintProg(); });
      if (job !== my) return;
      url = u; job = null; render(); onChange?.(url); onBusy?.();
      setTimeout(() => { if (!job && local) { URL.revokeObjectURL(local); local = ""; } }, 15000);
    } catch (e) {
      if (job !== my) return;
      if (e.aborted) { job = null; meta = null; render(); onBusy?.(); pickBtn.focus(); return; }
      my.state = "error"; my.error = e.message || "Upload failed."; render(); onBusy?.();
      toast(e.message || "Upload failed.", "error");
    }
  }
  function remove() {
    url = ""; meta = null; render(); onChange?.(url);
    ($$("button", drop).find(b => b.offsetParent) || chooseLink).focus();
  }
  // a saved video: ask the server for its size once
  async function sizeOfSaved() {
    if (!url) return;
    try {
      const r = await fetch(imgSrc(url), { method: "HEAD", credentials: "same-origin" });
      const n = Number(r.headers.get("content-length"));
      if (r.ok && n > 0 && !job) { meta = { ...(meta || {}), size: n }; paintInfo(); }
    } catch { /* size is a nicety */ }
  }
  fileInput.addEventListener("change", () => { if (fileInput.files[0]) pick(fileInput.files[0]); fileInput.value = ""; });
  el.addEventListener("dragover", e => { if (!hasFiles(e) || active()) return; e.preventDefault(); el.classList.add("dragover"); });
  el.addEventListener("dragleave", e => { if (!el.contains(e.relatedTarget)) el.classList.remove("dragover"); });
  el.addEventListener("drop", e => { if (!hasFiles(e)) return; e.preventDefault(); el.classList.remove("dragover"); if (e.dataTransfer.files[0]) pick(e.dataTransfer.files[0]); });
  render(); sizeOfSaved();
  const api_ = {
    el, value: () => url, busy: active,
    error(msg) {
      err.hidden = !msg;
      if (msg) err.replaceChildren(icon("warning-circle"), document.createTextNode(" " + msg)); else err.replaceChildren();
      el.classList.toggle("invalid", !!msg);
    },
    focus() { (drop.hidden ? pickBtn : ($$("button", drop).find(b => b.offsetParent) || chooseLink)).focus(); },
    destroy() { job?.xhr?.abort(); if (local) URL.revokeObjectURL(local); }
  };
  return api_;
}

/* ======================= Page ======================= */
// preview size, remembered while the admin stays open; phones start on Phone
let device = (() => { try { return matchMedia("(max-width: 760px)").matches ? "phone" : "desktop"; } catch { return "desktop"; } })();
const SUBTITLE = "Choose what shoppers see first, and which collection is featured further down. Changes go live when you save.";

export async function renderHomepage(container, ctx) {
  const cx = useCtx(container, ctx);
  cx.setTitle("Homepage");
  fill(container, pageHead({ title: "Homepage", subtitle: SUBTITLE }), skeletonForm());
  let data, lists;
  try {
    const [hp, colls, cats] = await Promise.allSettled([api("/homepage"), getCollections(), getCategories()]);
    if (!cx.alive()) return;
    if (hp.status === "rejected") throw hp.reason;
    data = normalize(itemOf(hp.value, "homepage"));
    lists = { colls: colls.status === "fulfilled" ? colls.value : null, cats: cats.status === "fulfilled" ? cats.value : [] };
  } catch (e) {
    if (!cx.alive() || e?.status === 401) return;
    fill(container, pageHead({ title: "Homepage" }), errorState(e, () => renderHomepage(container, ctx)));
    return;
  }
  editor(container, cx, data, lists);
}

function editor(container, cx, st, lists) {
  const { colls, cats } = lists;
  const FORM_ID = nextId("hp-form");
  const cards = new Map(); // slide object -> its card
  const cleanups = [];
  let activeIdx = 0, saving = false, tracker = null, pv = null;
  const live = h("p", { class: "sr-only", "aria-live": "polite" });
  const say = t => { live.textContent = ""; requestAnimationFrame(() => { live.textContent = t; }); };
  cx.onLeave(() => { cleanups.forEach(fn => { try { fn(); } catch { /* ignore */ } }); cleanups.length = 0; });

  /* ---------- Header, save state and the phone save bar ---------- */
  const viewLink = h("a", { class: "btn btn-secondary", href: "../index.html", target: "_blank", rel: "noopener", title: "Opens the website in a new tab" },
    icon("arrow-square-out"), h("span", null, "View", h("span", { class: "hide-phone", text: " homepage" })));
  const fr = editFrame({ formId: FORM_ID, isNew: false, title: "Homepage", actions: [viewLink] });
  const saveBtns = [...$$("button[type=submit]", fr.head), ...$$("button[type=submit]", fr.savebar)];
  const ss = { set(s, t) { fr.ss.set(s, t); saveBtns.forEach(b => { b.disabled = s === "saving" || s === "clean"; }); } };
  const alertBox = h("div", { class: "hp-alert", role: "alert", hidden: true });

  function changed() {
    if (!tracker) return;
    if (!saving) ss.set(tracker.isDirty() ? "dirty" : "clean");
    pv?.schedule();
  }
  const bind = (f, obj, k, after) => f.input.addEventListener("input", () => { obj[k] = f.input.value; after?.(); });
  const singleLine = ta => {
    ta.addEventListener("keydown", e => { if (e.key === "Enter") e.preventDefault(); });
    ta.addEventListener("input", () => { if (/[\r\n]/.test(ta.value)) { const p = ta.selectionStart; ta.value = ta.value.replace(/[\r\n]+/g, " "); ta.setSelectionRange(p, p); } });
  };
  const T = f => ({ error: m => f.error(m), focus: () => f.input.focus() });

  /* ---------- Link choices: pages, collections, categories, or a custom link ---------- */
  const linkGroups = [
    { label: "Pages", items: [["Homepage", "index.html"], ["All collections", "collections.html"], ["Our story", "about.html"], ["Our stores", "index.html#stores"]] },
    colls?.length ? { label: "Collections", items: colls.map(c => [c.name + (c.active ? "" : " (hidden)"), `collection.html?c=${c.slug}`]) } : null,
    cats?.length ? { label: "Categories", items: cats.map(c => [c.name, `category.html?c=${c.slug}`]) } : null
  ].filter(Boolean);
  const knownLinks = new Set(linkGroups.flatMap(g => g.items.map(i => i[1])));
  const CUSTOM = "__custom__";

  function linkPicker({ value, onChange }) {
    const id = nextId("lnk"), errId = id + "-err";
    const sel = h("select", { id, "aria-describedby": errId },
      h("option", { value: "" }, "Choose a page"),
      linkGroups.map(g => h("optgroup", { label: g.label }, g.items.map(([t, v]) => h("option", { value: v }, t)))),
      h("option", { value: CUSTOM }, "Custom link…"));
    const custom = h("input", { type: "text", inputmode: "url", autocomplete: "off", spellcheck: "false", maxlength: CAP.link,
      placeholder: "e.g. collection.html?c=nexa or https://…", "aria-label": "Custom link address", "aria-describedby": errId });
    const err = h("p", { class: "field-err", id: errId, hidden: true });
    const wrap = h("div", { class: "field hp-link" }, h("div", { class: "label-row" }, h("label", { for: id, text: "Goes to" })), sel, custom, err);
    let cur = S(value).trim();
    if (!cur) sel.value = "";
    else if (knownLinks.has(cur)) sel.value = cur;
    else { sel.value = CUSTOM; custom.value = cur; }
    custom.hidden = sel.value !== CUSTOM;
    const set = v => { cur = v; onChange(v); };
    const check = () => { const ok = !cur || validLink(cur); api_.error(ok ? "" : LINK_MSG); return ok; };
    sel.addEventListener("change", () => {
      if (sel.value === CUSTOM) { custom.hidden = false; set(tidyLink(custom.value)); custom.focus(); }
      else { custom.hidden = true; set(sel.value); }
      api_.error("");
    });
    custom.addEventListener("input", () => { set(custom.value.trim()); if (wrap.classList.contains("invalid")) check(); });
    custom.addEventListener("blur", () => {
      const v = tidyLink(custom.value);
      if (v !== custom.value) { custom.value = v; set(v); changed(); }
      if (cur) check();
    });
    const api_ = {
      el: wrap,
      error(msg) {
        err.hidden = !msg;
        if (msg) err.replaceChildren(icon("warning-circle"), document.createTextNode(" " + msg)); else err.replaceChildren();
        wrap.classList.toggle("invalid", !!msg);
        [sel, custom].forEach(x => (msg && (x === custom ? !custom.hidden : custom.hidden)) ? x.setAttribute("aria-invalid", "true") : x.removeAttribute("aria-invalid"));
      },
      focus() { (custom.hidden ? sel : custom).focus(); }
    };
    return api_;
  }

  function buttonSet({ title, optional, s, lk, ln, ph }) {
    const label = field({ label: "Button text", name: lk, maxlength: CAP.label, value: s[lk], placeholder: ph });
    bind(label, s, lk);
    const link = linkPicker({ value: s[ln], onChange: v => { s[ln] = v; } });
    const el = h("fieldset", { class: "hp-btnset" },
      h("legend", { class: "hp-legend" }, title, optional ? h("span", { class: "opt", text: " (optional)" }) : null),
      h("div", { class: "grid-2" }, label.wrap, link.el));
    return { el, label, link };
  }

  /* ---------- One slide ---------- */
  function focusOptions() {
    return FOCI.map(v => ({ value: v, label: FOCUS_LABEL[v], visual: h("span", { class: `hp-fv hp-fv-${v}`, "aria-hidden": "true" }) }));
  }
  function slideCard(s) {
    const key = nextId("slide");
    let open = false, mode = "", idx = 0;
    const desk = bannerImage({ label: "Desktop image", required: true, value: s.image, ratio: "16 / 9", maxEdge: 2400, kind: "desktop", empty: "Wide photo 16:9",
      hint: "Wide 16:9 photo, ideally 2400 x 1350. Bigger photos are resized for you.",
      onChange: v => { s.image = v; paintHead(); changed(); }, onBusy: changed });
    const phone = bannerImage({ label: "Phone image", optional: true, value: s.image_mobile, ratio: "4 / 5", maxEdge: 1600, kind: "phone", empty: "Portrait 4:5",
      hint: "Portrait 4:5 for phones. Leave empty to use the desktop image.",
      onChange: v => { s.image_mobile = v; changed(); }, onBusy: changed });
    const focusId = nextId("focus");
    const focus = segmented({ labelledby: focusId, value: s.focus, className: "hp-seg-focus", options: focusOptions(), onChange: v => { s.focus = v; } });
    const focusWrap = h("div", { class: "field" },
      h("div", { class: "label-row" }, h("span", { class: "label", id: focusId, text: "Keep in view" })),
      focus.el,
      h("p", { class: "hint", text: "Narrower screens show only part of the wide photo. Choose the side that must stay visible." }));
    const alt = field({ label: "Image description", name: "alt", maxlength: CAP.alt, counter: true, value: s.alt,
      placeholder: "e.g. A bride wearing a gold temple necklace", hint: "Read aloud by screen readers. Describe what the photo shows." });
    const eyebrow = field({ label: "Small line above the headline", name: "eyebrow", maxlength: CAP.eyebrow, counter: true, optional: true, value: s.eyebrow, placeholder: "e.g. Jewellers to the world since 1976" });
    const headline = field({ label: "Headline", name: "headline", maxlength: CAP.headline, counter: true, value: s.headline, placeholder: "e.g. Jewellery that feels like home" });
    const text = field({ label: "Text", name: "text", type: "textarea", rows: 2, maxlength: CAP.text, counter: true, optional: true, value: s.text, placeholder: "One or two short sentences" });
    singleLine(text.input);
    bind(alt, s, "alt"); bind(eyebrow, s, "eyebrow"); bind(headline, s, "headline", () => paintHead()); bind(text, s, "text");
    const b1 = buttonSet({ title: "Main button", s, lk: "cta_label", ln: "cta_link", ph: "e.g. Explore collections" });
    const b2 = buttonSet({ title: "Second button", optional: true, s, lk: "cta2_label", ln: "cta2_link", ph: "e.g. Our story" });

    const thumb = h("span", { class: "hp-thumb", "aria-hidden": "true" });
    const nameEl = h("strong", { class: "hp-tname-n" }), sumEl = h("span", { class: "hp-tname-s" });
    const bodyId = key + "-body";
    const toggle = h("button", { type: "button", class: "hp-toggle", "aria-expanded": "false", "aria-controls": bodyId,
      onclick: () => { if (!open) closeOthers(s); setOpen(!open); if (open) setActive(st.hero.slides.indexOf(s)); } },
      thumb, h("span", { class: "hp-tname" }, nameEl, sumEl), icon("caret-down", "hp-caret"));
    const up = iconBtn("arrow-up", "Move up", () => moveSlide(s, -1, "up")); up.dataset.act = "up";
    const down = iconBtn("arrow-down", "Move down", () => moveSlide(s, 1, "down")); down.dataset.act = "down";
    const del = iconBtn("trash", "Remove slide", () => removeSlide(s), { class: "danger" }); del.dataset.act = "remove";
    const head = h("div", { class: "hp-slide-head" },
      h("span", { class: "drag-handle", "data-handle": "", title: "Drag to reorder", "aria-hidden": "true" }, icon("dots-six-vertical")),
      toggle, h("div", { class: "ud hp-ud" }, up, down, del));
    const sub = t => h("h3", { class: "hp-sub", text: t });
    const mediaSec = h("div", { class: "hp-sec" }, sub("Photo"), h("div", { class: "hp-imgs" }, desk.el, phone.el), focusWrap, alt.wrap);
    const wordsSec = h("div", { class: "hp-sec" }, sub("Words"), eyebrow.wrap, headline.wrap, text.wrap);
    const btnSec = h("div", { class: "hp-sec" }, sub("Buttons"), b1.el, b2.el, h("p", { class: "hint", text: "Leave the button text empty to hide that button." }));
    const body = h("div", { class: "hp-slide-body", id: bodyId }, mediaSec, wordsSec, btnSec);
    const el = h("li", { class: "hp-slide", dataset: { key } }, head, body);
    el.addEventListener("focusin", () => setActive(st.hero.slides.indexOf(s)));

    function paintHead() {
      nameEl.textContent = `Slide ${idx + 1}`;
      sumEl.textContent = line(s.headline) || "No headline yet";
      const src = s.image ? imgSrc(s.image) : "";
      if (thumb.dataset.src !== src || !thumb.firstChild) {
        thumb.dataset.src = src;
        fill(thumb, src ? h("img", { src, alt: "", loading: "lazy", decoding: "async" }) : icon("image"));
      }
      up.setAttribute("aria-label", `Move slide ${idx + 1} up`); up.title = "Move up";
      down.setAttribute("aria-label", `Move slide ${idx + 1} down`); down.title = "Move down";
      del.setAttribute("aria-label", `Remove slide ${idx + 1}`); del.title = "Remove slide";
    }
    function applyOpen() {
      const shown = mode !== "slideshow" || open;
      body.hidden = !shown;
      toggle.setAttribute("aria-expanded", String(shown));
      el.classList.toggle("is-open", shown);
    }
    function setOpen(v) { open = v; applyOpen(); }
    function setMode(m, i, n) {
      mode = m; idx = i;
      el.classList.toggle("is-list", m === "slideshow");
      head.hidden = m !== "slideshow";
      mediaSec.hidden = m === "video";
      up.disabled = i === 0; down.disabled = i === n - 1; del.disabled = n <= 1;
      paintHead(); applyOpen();
    }
    const targets = { image: desk, image_mobile: phone, alt: T(alt), eyebrow: T(eyebrow), headline: T(headline), text: T(text),
      cta_label: T(b1.label), cta_link: b1.link, cta2_label: T(b2.label), cta2_link: b2.link };
    return {
      el, setMode, setOpen, isOpen: () => open,
      busy: () => desk.busy() || phone.busy(),
      target: k => targets[k] || null,
      clearErrors: () => Object.values(targets).forEach(t => t.error("")),
      focusFirst: () => desk.focus(),
      focusHead: () => toggle.focus()
    };
  }

  /* ---------- Banner type ---------- */
  const modeHintId = nextId("modehint");
  const modeHint = h("p", { class: "hint hp-mode-hint", id: modeHintId });
  const modeSeg = segmented({ label: "Banner type", value: st.hero.mode, className: "hp-seg-modes",
    options: MODE_OPTS.map(o => ({ ...o, describedby: modeHintId })), onChange: v => { st.hero.mode = v; applyMode(); changed(); } });
  const modeCard = h("section", { class: "card hp-first" },
    h("h2", { class: "card-title", text: "Top banner" }),
    h("p", { class: "muted small card-sub", text: "The first thing shoppers see on the homepage. Switching keeps what you have entered for each type." }),
    modeSeg.el, modeHint);

  /* ---------- Slides ---------- */
  const slidesTitle = h("h2", { class: "card-title" });
  const slideCount = h("span", { class: "hp-count" });
  const slidesSub = h("p", { class: "muted small card-sub" });
  const keptNote = h("p", { class: "note hp-kept", hidden: true });
  const list = h("ol", { class: "hp-slides", "aria-label": "Slides" });
  const addBtn = h("button", { type: "button", class: "btn btn-secondary", onclick: addSlide }, icon("plus"), "Add slide");
  const addNote = h("span", { class: "muted small" });
  const addRow = h("div", { class: "hp-add" }, addBtn, addNote);
  const slidesCard = h("section", { class: "card" }, h("div", { class: "card-head hp-head" }, slidesTitle, slideCount), slidesSub, keptNote, list, addRow);
  st.hero.slides.forEach((s, i) => { const c = slideCard(s); cards.set(s, c); if (i === 0) c.setOpen(true); list.append(c.el); });

  /* One slide open at a time keeps a long slideshow easy to scan. */
  function closeOthers(keep) { cards.forEach((c, x) => { if (x !== keep) c.setOpen(false); }); }
  function addSlide() {
    if (st.hero.slides.length >= MAX_SLIDES) return;
    const s = blankSlide();
    st.hero.slides.push(s);
    const c = slideCard(s); cards.set(s, c);
    list.append(c.el);
    closeOthers(s); c.setOpen(true);
    applyMode(); changed();
    setActive(st.hero.slides.length - 1);
    say(`Slide ${st.hero.slides.length} added.`);
    c.el.scrollIntoView({ block: "start", behavior: reducedMotion() ? "auto" : "smooth" });
    c.focusFirst();
  }
  async function removeSlide(s) {
    const i = st.hero.slides.indexOf(s);
    if (i < 0 || st.hero.slides.length <= 1) return;
    const has = s.image || s.image_mobile || TEXT_KEYS.some(k => line(s[k]));
    if (has && !(await confirmDialog({ title: `Remove slide ${i + 1}?`, message: "Its photos and words come out of the slideshow when you save.", confirmLabel: "Remove slide", danger: true, icon: "trash" }))) return;
    const c = cards.get(s);
    st.hero.slides.splice(i, 1); cards.delete(s); c.el.remove();
    activeIdx = Math.min(activeIdx > i ? activeIdx - 1 : activeIdx, st.hero.slides.length - 1);
    applyMode(); changed(); pv.show(activeIdx);
    say(`Slide ${i + 1} removed. Save to apply.`);
    cards.get(st.hero.slides[Math.min(i, st.hero.slides.length - 1)])?.focusHead();
  }
  function reorder(from, to) {
    st.hero.slides = moveItem(st.hero.slides, from, to);
    list.append(...st.hero.slides.map(x => cards.get(x).el));
    activeIdx = to;
    applyMode(); changed(); pv.show(to);
    say(`Slide moved to position ${to + 1} of ${st.hero.slides.length}.`);
  }
  function moveSlide(s, dir, act) {
    const i = st.hero.slides.indexOf(s), j = i + dir;
    if (j < 0 || j >= st.hero.slides.length) return;
    reorder(i, j);
    const el = cards.get(s).el;
    const b = el.querySelector(`[data-act="${act}"]`);
    (b && !b.disabled ? b : el.querySelector(`[data-act="${act === "up" ? "down" : "up"}"]`))?.focus();
  }
  dragSort(list, ".hp-slide", (from, to) => { if (st.hero.mode === "slideshow") reorder(from, to); });
  function setActive(i) {
    if (i < 0) return;
    activeIdx = st.hero.mode === "slideshow" ? i : 0;
    cards.forEach((c, s) => c.el.classList.toggle("is-active", st.hero.mode === "slideshow" && st.hero.slides.indexOf(s) === activeIdx));
    pv?.show(activeIdx);
  }

  /* ---------- Video ---------- */
  function videoCard() {
    const v = st.hero.video;
    const main = videoField({ label: "Video", required: true, value: v.src,
      hint: "Best results: 1920 x 1080, under 20 MB, 10 to 20 seconds. It always plays muted, so it needs no sound.",
      onChange: x => { v.src = x; changed(); say(x ? "Video uploaded. Save to publish it." : "Video removed."); }, onBusy: changed });
    const poster = bannerImage({ label: "Cover image", required: true, value: v.poster, ratio: "16 / 9", maxEdge: 2400, kind: "desktop", empty: "Cover 16:9",
      hint: "Shows while the video loads, and instead of it on slow connections or for visitors who prefer less motion. A still from the video works well.",
      onChange: x => { v.poster = x; changed(); }, onBusy: changed });
    const mVid = videoField({ label: "Phone video", optional: true, value: v.src_mobile, ratio: "4 / 5",
      hint: "A portrait version for phones. Leave empty to use the main video.",
      onChange: x => { v.src_mobile = x; changed(); }, onBusy: changed });
    const mPoster = bannerImage({ label: "Phone cover image", optional: true, value: v.poster_mobile, ratio: "4 / 5", maxEdge: 1600, kind: "phone", empty: "Cover 4:5",
      hint: "Portrait 4:5. Leave empty to use the main cover image.",
      onChange: x => { v.poster_mobile = x; changed(); }, onBusy: changed });
    const el = h("section", { class: "card hp-video-card" },
      h("h2", { class: "card-title", text: "Video" }),
      h("p", { class: "muted small card-sub", text: "A short clip that loops silently behind your words." }),
      h("div", { class: "hp-imgs hp-imgs-even" }, main.el, poster.el),
      h("div", { class: "hp-sec" }, h("h3", { class: "hp-sub", text: "For phones" }), h("div", { class: "hp-imgs hp-imgs-even" }, mVid.el, mPoster.el)));
    const targets = { src: main, poster, src_mobile: mVid, poster_mobile: mPoster };
    cleanups.push(() => { main.destroy(); mVid.destroy(); });
    return {
      el, busy: () => main.busy() || poster.busy() || mVid.busy() || mPoster.busy(),
      target: k => targets[k] || null,
      clearErrors: () => Object.values(targets).forEach(t => t.error(""))
    };
  }
  const vc = videoCard();

  /* ---------- Look ---------- */
  const alignLabel = nextId("align");
  const alignSeg = segmented({ labelledby: alignLabel, value: st.hero.align, className: "hp-seg-align",
    options: [{ value: "left", label: "Left", icon: "text-align-left" }, { value: "center", label: "Centre", icon: "text-align-center" }],
    onChange: v => { st.hero.align = v; } });
  const shade = rangeField({ label: "Shade behind the text", min: 0, max: 80, step: 5, value: Math.round(st.hero.overlay * 100), fmt: v => `${v}%`, ends: ["None", "Strong"],
    hint: "Darkens the photo so white text stays easy to read. 45% suits most photos.", onInput: v => { st.hero.overlay = v / 100; } });
  const timing = rangeField({ label: "Time per slide", min: 4, max: 12, step: 1, value: st.hero.interval, fmt: v => `${v} seconds`, ends: ["4 s", "12 s"],
    hint: "How long each slide stays before the next one fades in.", onInput: v => { st.hero.interval = v; } });
  const lookCard = h("section", { class: "card hp-look" },
    h("h2", { class: "card-title", text: "Look" }),
    h("div", { class: "field" }, h("div", { class: "label-row" }, h("span", { class: "label", id: alignLabel, text: "Text position" })), alignSeg.el),
    shade.wrap, timing.wrap);

  /* ---------- Featured collection ---------- */
  function featuredCard() {
    const f = st.featured;
    const bySlug = slug => (colls || []).find(c => c.slug === slug);
    const opts = (colls || []).map(c => ({ value: c.slug, label: c.name + (c.active ? "" : " (hidden)") }));
    if (f.collection && !bySlug(f.collection)) opts.push({ value: f.collection, label: colls ? `${f.collection} (not found)` : f.collection });
    if (!f.collection) opts.unshift({ value: "", label: "Choose a collection" });
    const sel = field({ label: "Collection", name: "featured-collection", type: "select", value: f.collection, options: opts,
      hint: colls ? "Its photo, story and a few of its designs appear in this band." : "The collection list could not load. Reload the page to choose a different one." });
    const head = field({ label: "Headline", name: "featured-headline", maxlength: CAP.fHeadline, counter: true, optional: true, value: f.headline });
    const text = field({ label: "Text", name: "featured-text", type: "textarea", rows: 3, maxlength: CAP.fText, counter: true, optional: true, value: f.text });
    singleLine(text.input);
    const cta = field({ label: "Link text", name: "featured-cta", maxlength: CAP.label, optional: true, value: f.cta_label });
    const img = imageField({ label: "Image", value: f.image, ratio: "4 / 5", slotLabel: "Uses the collection photo",
      hint: "Optional, portrait 4:5. Leave empty to use the collection's own photo.", onChange: v => { f.image = v; paint(); changed(); } });
    sel.input.addEventListener("change", () => { f.collection = sel.value(); paint(); });
    bind(head, f, "headline", () => paint()); bind(text, f, "text", () => paint()); bind(cta, f, "cta_label", () => paint());

    const pvFrame = h("div", { class: "hp-feat-frame" });
    const pvEyebrow = h("span", { class: "hp-feat-eyebrow" }), pvHead = h("h3", { class: "hp-feat-h" }), pvText = h("p", { class: "hp-feat-p" });
    const pvMinis = h("div", { class: "hp-feat-minis" });
    const pvLink = h("span", { class: "hp-feat-link" });
    const preview = h("div", { class: "hp-feat", "aria-hidden": "true" }, pvFrame, h("div", { class: "hp-feat-copy" }, pvEyebrow, pvHead, pvText, pvMinis, pvLink));
    const prodCache = new Map();
    const productsOf = slug => {
      if (!prodCache.has(slug)) prodCache.set(slug, api("/products", { query: { collection: slug, status: "active", per: 12, page: 1 } })
        .then(r => { const items = listOf(r, "products").map(normProduct); return [...items.filter(p => p.featured), ...items.filter(p => !p.featured)].slice(0, 3); })
        .catch(() => []));
      return prodCache.get(slug);
    };
    let frameKey = null, minisKey = null;
    function paint() {
      const c = bySlug(f.collection);
      const name = c?.name || f.collection || "Collection";
      head.input.placeholder = `Empty uses: ${name}`;
      text.input.placeholder = c?.short ? `Empty uses: ${c.short}` : "";
      cta.input.placeholder = `Empty uses: Discover ${name}`;
      pvEyebrow.textContent = name;
      pvHead.textContent = line(f.headline) || name;
      pvText.textContent = line(f.text) || c?.short || "";
      fill(pvLink, line(f.cta_label) || `Discover ${name}`, icon("arrow-right"));
      const src = f.image || c?.hero || c?.cover || "";
      if (src !== frameKey) { frameKey = src; fill(pvFrame, src ? h("img", { src: imgSrc(src), alt: "", decoding: "async", style: { "object-position": f.image ? "50% center" : "66% center" } }) : h("div", { class: "slot", text: "Collection photo" })); }
      if (f.collection !== minisKey) {
        minisKey = f.collection;
        fill(pvMinis);
        if (f.collection) productsOf(f.collection).then(items => {
          if (minisKey !== f.collection) return;
          fill(pvMinis, items.map(p => h("span", { class: "hp-feat-mini" }, p.images[0] ? h("img", { src: imgSrc(p.images[0]), alt: "", loading: "lazy" }) : null)));
        });
      }
    }
    paint();
    const el = h("section", { class: "card hp-featured" },
      h("h2", { class: "card-title", text: "Featured collection" }),
      h("p", { class: "muted small card-sub", text: "The band further down the homepage. Empty fields use the collection's own name, line and photo." }),
      h("div", { class: "hp-feat-grid" }, h("div", { class: "hp-feat-fields" }, sel.wrap, head.wrap, text.wrap, cta.wrap), h("div", { class: "hp-feat-side" }, img.el)),
      h("div", { class: "hp-feat-pv" }, h("span", { class: "strip-label", text: "Preview" }), preview));
    const targets = { collection: T(sel), headline: T(head), text: T(text), cta_label: T(cta),
      image: { error: () => {}, focus: () => $("button", img.el)?.focus() } };
    return { el, busy: img.busy, target: k => targets[k] || null, clearErrors: () => [sel, head, text, cta].forEach(x => x.error("")) };
  }
  const feat = featuredCard();

  /* ---------- Live preview ---------- */
  pv = previewPanel();
  function previewPanel() {
    let mediaKey = "", headerKey = "", chromeKey = "", pvIdx = 0, playing = false, timer = 0, raf = 0;
    const devSeg = segmented({ label: "Preview size", value: device, className: "hp-seg-sm",
      options: [{ value: "desktop", label: "Desktop", icon: "desktop" }, { value: "phone", label: "Phone", icon: "device-mobile" }],
      onChange: v => { device = v; paint(); } });
    const header = h("div", { class: "hpv-header" });
    const media = h("div", { class: "hpv-media" });
    const shadeEl = h("div", { class: "hpv-shade" });
    const copy = h("div", { class: "hpv-copy" });
    const chrome = h("div", { class: "hpv-chrome" });
    const heroEl = h("div", { class: "hpv-hero" }, media, shadeEl, h("div", { class: "hpv-wrap" }, copy), chrome);
    const site = h("div", { class: "hpv-site" }, header, heroEl);
    const emptyEl = h("div", { class: "hp-stage-empty" }, icon("image"), h("span", { text: "Add a photo to see your banner here" }));
    const stage = h("div", { class: "hp-stage", "aria-hidden": "true", inert: true }, site, emptyEl);
    const pos = h("span", { class: "hp-pv-pos" });
    const prevB = iconBtn("caret-left", "Previous slide", () => step(-1));
    const nextB = iconBtn("caret-right", "Next slide", () => step(1));
    const playB = h("button", { type: "button", class: "btn btn-secondary btn-sm hp-play", "aria-pressed": "false", onclick: () => (playing ? stop() : start()) });
    const ctrls = h("div", { class: "hp-pv-ctrls" }, prevB, pos, nextB, playB);
    const note = h("p", { class: "hint hp-pv-note" });
    const el = h("section", { class: "card hp-preview", "aria-labelledby": "hp-pv-title" },
      h("div", { class: "hp-pv-head" }, h("h2", { class: "card-title", id: "hp-pv-title", text: "Live preview" }), devSeg.el),
      stage, ctrls, note);

    const cur = () => (st.hero.mode === "slideshow" ? clamp(pvIdx, 0, st.hero.slides.length - 1) : 0);
    function paintHeader(phone) {
      const logo = h("img", { class: "hpv-logo", src: "../assets/img/logo/siroya-white.png", alt: "" });
      const wa = h("span", { class: "hpv-icon" }, icon("whatsapp-logo"));
      fill(header, phone
        ? [h("span", { class: "hpv-nav" }, h("span", { class: "hpv-icon" }, icon("list"))), logo, h("span", { class: "hpv-nav hpv-nav-r" }, wa)]
        : [h("span", { class: "hpv-nav" }, h("span", { text: "Collections" }), h("span", { text: "Our Story" }), h("span", { text: "Stores" })), logo,
          h("span", { class: "hpv-nav hpv-nav-r" }, h("span", { text: "All Jewellery" }), wa)]);
    }
    const slotEl = text => h("div", { class: "hpv-slot" }, h("span", { text }));
    function paintMedia(mode, phone) {
      const hero = st.hero;
      if (mode === "video") {
        const v = hero.video;
        const src = phone ? v.src_mobile || v.src : v.src;
        const poster = phone ? v.poster_mobile || v.poster : v.poster;
        const objPos = POS[phone ? "phone" : "desktop"][hero.slides[0]?.focus] || POS.desktop.right;
        if (src) {
          const vid = h("video", { class: "hpv-img", src: imgSrc(src), loop: true, playsinline: true, preload: "auto", poster: poster ? imgSrc(poster) : null, style: { "object-position": objPos } });
          vid.muted = true; vid.defaultMuted = true;
          fill(media, vid);
          if (!reducedMotion()) { vid.autoplay = true; vid.play?.().catch(() => { /* poster stays */ }); }
        } else fill(media, h("div", { class: "hpv-slide on" }, poster ? h("img", { class: "hpv-img", src: imgSrc(poster), alt: "", style: { "object-position": objPos } }) : slotEl("Add a video and a cover image")));
        return;
      }
      const slides = mode === "slideshow" ? hero.slides : hero.slides.slice(0, 1);
      fill(media, slides.map((s, k) => {
        const own = phone && s.image_mobile;
        const path = own ? s.image_mobile : s.image;
        const objPos = own ? "50% 50%" : POS[phone ? "phone" : "desktop"][s.focus] || POS.desktop.right;
        return h("div", { class: ["hpv-slide", own && "has-mobile"] },
          path ? h("img", { class: "hpv-img", src: imgSrc(path), alt: "", decoding: "async", style: { "object-position": objPos } })
            : slotEl(mode === "slideshow" ? `Slide ${k + 1} photo` : "Banner photo"));
      }));
    }
    function paintCopy(s) {
      const eyebrow = line(s.eyebrow), head = line(s.headline), text = line(s.text), b1 = line(s.cta_label), b2 = line(s.cta2_label);
      fill(copy,
        eyebrow ? h("span", { class: "hpv-eyebrow", text: eyebrow }) : null,
        head ? h("div", { class: "hpv-h1", text: head }) : null,
        text ? h("p", { class: "hpv-lede", text }) : null,
        b1 || b2 ? h("div", { class: "hpv-ctas" }, b1 ? h("span", { class: "hpv-btn hpv-btn-cream", text: b1 }) : null, b2 ? h("span", { class: "hpv-btn hpv-btn-line", text: b2 }) : null) : null);
    }
    /* Same order as the public bar: Pause / Play, one line per slide, count, previous, next. */
    function paintChrome(mode, i, phone, hasVideo) {
      const n = st.hero.slides.length;
      const key = JSON.stringify([mode, i, n, phone, playing, st.hero.interval, hasVideo]);
      if (key === chromeKey) return;
      chromeKey = key;
      chrome.style.setProperty("--dur", `${st.hero.interval}s`);
      const btn = ic => h("span", { class: "hpv-ctl" }, icon(ic));
      const pad = k => String(k).padStart(2, "0");
      if (mode === "image" || (mode === "video" && !hasVideo)) { fill(chrome); return; }
      if (mode === "video") { fill(chrome, h("div", { class: "hpv-bar" }, h("span", { class: "hpv-gap" }), btn("pause"))); return; }
      fill(chrome, h("div", { class: "hpv-bar" },
        btn(playing ? "pause" : "play"),
        h("span", { class: "hpv-lines" }, Array.from({ length: n }, (_, k) => h("span", { class: ["hpv-line", k === i && "on"] }, h("b")))),
        h("span", { class: "hpv-gap" }),
        h("span", { class: "hpv-count" }, h("b", { text: pad(i + 1) }), ` / ${pad(n)}`),
        phone ? null : btn("arrow-left"), phone ? null : btn("arrow-right")));
    }
    function paint() {
      const hero = st.hero, mode = hero.mode, phone = device === "phone", D = phone ? PHONE : DESK;
      stage.dataset.device = device;
      stage.style.aspectRatio = `${D.w} / ${D.h}`;
      site.style.width = `${D.w}px`; site.style.height = `${D.h}px`;
      site.classList.toggle("is-phone", phone);
      if (headerKey !== device) { headerKey = device; paintHeader(phone); }
      const srcs = mode === "video" ? [hero.video.src, hero.video.src_mobile, hero.video.poster, hero.video.poster_mobile, hero.slides[0]?.focus]
        : (mode === "slideshow" ? hero.slides : hero.slides.slice(0, 1)).map(s => [s.image, s.image_mobile, s.focus]);
      const key = JSON.stringify([mode, device, srcs]);
      if (key !== mediaKey) { mediaKey = key; paintMedia(mode, phone); }
      const i = cur();
      const hasVideo = mode === "video" && !!(phone ? hero.video.src_mobile || hero.video.src : hero.video.src);
      $$(".hpv-slide", media).forEach((n, k) => n.classList.toggle("on", mode === "video" || k === i));
      heroEl.dataset.mode = mode;
      heroEl.dataset.align = hero.align;
      heroEl.classList.toggle("has-bar", mode === "slideshow" || hasVideo);
      heroEl.classList.toggle("is-playing", playing);
      heroEl.style.setProperty("--hero-ov", String(hero.overlay));
      const s = hero.slides[i] || blankSlide();
      paintCopy(s);
      paintChrome(mode, i, phone, hasVideo);
      const n = hero.slides.length;
      ctrls.hidden = mode !== "slideshow";
      pos.textContent = `Slide ${i + 1} of ${n}`;
      prevB.disabled = nextB.disabled = n < 2;
      playB.disabled = n < 2;
      playB.setAttribute("aria-pressed", String(playing));
      fill(playB, icon(playing ? "pause" : "play"), playing ? "Pause" : "Play");
      const noPhoto = mode === "video" ? !hero.video.src && !hero.video.poster : !s.image && !(phone && s.image_mobile);
      emptyEl.hidden = !noPhoto || !!line(s.headline);
      emptyEl.lastChild.textContent = mode === "video" ? "Add a video to see your banner here" : "Add a photo to see your banner here";
      note.textContent = mode === "slideshow"
        ? (playing ? `Playing every ${hero.interval} seconds, as on the website.` : "Shows the slide you are editing. Press Play to watch them change.")
        : mode === "video" ? "The video plays muted, as on the website." : "Updates as you type.";
      fit();
    }
    function fit() {
      const D = device === "phone" ? PHONE : DESK;
      const w = stage.clientWidth;
      if (w) site.style.transform = `scale(${w / D.w})`;
    }
    function tick() {
      clearTimeout(timer);
      timer = setTimeout(() => { if (!playing) return; pvIdx = (cur() + 1) % st.hero.slides.length; paint(); tick(); }, st.hero.interval * 1000);
    }
    function start() { if (st.hero.mode !== "slideshow" || st.hero.slides.length < 2) return; playing = true; chromeKey = ""; paint(); tick(); say("Preview playing."); }
    function stop() { if (!playing) return; playing = false; clearTimeout(timer); chromeKey = ""; paint(); }
    function step(d) {
      const n = st.hero.slides.length;
      pvIdx = (cur() + d + n) % n; chromeKey = "";
      if (playing) tick();
      paint();
    }
    const ro = new ResizeObserver(fit);
    ro.observe(stage);
    cleanups.push(() => { ro.disconnect(); clearTimeout(timer); cancelAnimationFrame(raf); });
    return {
      el, paint,
      schedule() { if (!raf) raf = requestAnimationFrame(() => { raf = 0; paint(); }); },
      show(i) {
        const was = playing;
        playing = false; clearTimeout(timer);
        if (pvIdx === i && !was) return;
        pvIdx = i; chromeKey = "";
        this.schedule();
      }
    };
  }

  /* ---------- Mode switching ---------- */
  function applyMode() {
    const m = st.hero.mode, n = st.hero.slides.length;
    modeHint.textContent = MODE_OPTS.find(o => o.value === m).desc;
    vc.el.hidden = m !== "video";
    timing.wrap.hidden = m !== "slideshow";
    slidesTitle.textContent = m === "slideshow" ? "Slides" : m === "video" ? "Text on the video" : "Banner";
    slidesSub.textContent = m === "slideshow" ? "Shown in this order. Drag a slide or use the arrows to change the order."
      : m === "video" ? "Shown over the video, with the same shade and position as a photo." : "One photo with your words and buttons on top.";
    slideCount.hidden = m !== "slideshow";
    slideCount.textContent = `${n} of ${MAX_SLIDES}`;
    addRow.hidden = m !== "slideshow";
    addBtn.disabled = n >= MAX_SLIDES;
    addNote.textContent = n >= MAX_SLIDES ? "A slideshow holds up to 6 slides." : "";
    keptNote.hidden = m === "slideshow" || n < 2;
    fill(keptNote, icon("info"), h("span", { text: `${n === 2 ? "Slide 2 is" : `Slides 2 to ${n} are`} kept for the slideshow. ${m === "video" ? "The video uses the words of slide 1." : "Single image uses slide 1."}` }));
    st.hero.slides.forEach((s, i) => { const c = cards.get(s); c.setMode(m, i, n); c.el.hidden = m !== "slideshow" && i > 0; });
    list.classList.toggle("is-list", m === "slideshow");
    if (m !== "slideshow") activeIdx = 0;
    activeIdx = Math.min(activeIdx, n - 1);
    cards.forEach((c, s) => c.el.classList.toggle("is-active", m === "slideshow" && n > 1 && st.hero.slides.indexOf(s) === activeIdx));
    pv?.show(activeIdx);
    pv?.schedule();
  }

  /* ---------- Validation and errors ---------- */
  const busy = () => [...cards.values()].some(c => c.busy()) || vc.busy() || feat.busy();
  function clearErrors() {
    cards.forEach(c => c.clearErrors()); vc.clearErrors(); feat.clearErrors();
    alertBox.hidden = true; alertBox.replaceChildren();
  }
  function reveal(p) {
    if (p.card && st.hero.mode === "slideshow") { p.card.setOpen(true); }
    p.t.focus();
  }
  function validate() {
    clearErrors();
    const m = st.hero.mode, slides = st.hero.slides, problems = [];
    slides.forEach((s, i) => {
      const c = cards.get(s), shown = m === "slideshow" || i === 0;
      if (m !== "video" && shown && !s.image) problems.push({ t: c.target("image"), card: c, msg: m === "slideshow" && slides.length > 1 ? "Add a desktop image, or remove this slide." : "Add a desktop image." });
      [["cta_label", "cta_link"], ["cta2_label", "cta2_link"]].forEach(([lk, ln]) => {
        if (!line(s[lk])) return;
        const v = S(s[ln]).trim();
        const msg = !v ? "Choose where this button goes." : !validLink(v) ? LINK_MSG : "";
        if (msg) problems.push({ t: c.target(ln), card: c, msg, hidden: !shown, slide: i });
      });
    });
    if (m === "video") {
      if (!st.hero.video.src) problems.push({ t: vc.target("src"), msg: "Add a video." });
      if (!st.hero.video.poster) problems.push({ t: vc.target("poster"), msg: "Add a cover image. It shows while the video loads." });
    }
    if (colls?.length && !st.featured.collection) problems.push({ t: feat.target("collection"), msg: "Choose a collection to feature." });
    if (!problems.length) return true;
    problems.forEach(p => { p.t.error(p.msg); if (p.card && !p.hidden && m === "slideshow") p.card.setOpen(true); });
    const shown = problems.filter(p => !p.hidden);
    if (shown.length) {
      reveal(shown[0]);
      toast(shown.length > 1 ? "Please fix the highlighted fields." : "Please fix the highlighted field.", "error");
    } else toast(`Slide ${problems[0].slide + 1} has a button link that needs fixing. Choose Slideshow to edit it.`, "error");
    return false;
  }
  /** Server messages name the field in words ("Slide 2 button 1 needs a link"). */
  function pathFromMessage(msg) {
    const m = /^Slide (\d+) (desktop image|needs a desktop image|phone image|focus|eyebrow|headline|text|button ([12]) (?:label|link|needs a link)|image description)/i.exec(msg);
    if (m) {
      const what = m[2].toLowerCase();
      const key = what.includes("desktop image") ? "image" : what === "phone image" ? "image_mobile" : what === "image description" ? "alt"
        : m[3] ? `cta${m[3] === "2" ? "2" : ""}_${/label/.test(what) ? "label" : "link"}` : what;
      return `hero.slides.${Number(m[1]) - 1}.${key}`;
    }
    const rules = [[/^Phone cover image/i, "video.poster_mobile"], [/^Phone video/i, "video.src_mobile"], [/^(Video cover image|Add a cover image)/i, "video.poster"],
      [/^(Video\b|Upload a video)/i, "video.src"], [/^Featured image/i, "featured.image"], [/^Featured headline/i, "featured.headline"],
      [/^Featured text/i, "featured.text"], [/^Featured button/i, "featured.cta_label"], [/collection/i, "featured.collection"]];
    const hit = rules.find(([re]) => re.test(msg));
    return hit ? hit[1] : "";
  }
  /** Server errors may name a field: {error, field: "hero.slides.1.cta_link"}, or only in words. */
  function locate(data, msg) {
    const path = S(data?.field || data?.path) || pathFromMessage(S(msg));
    if (!path) return null;
    let m = /slides\W*(\d+)\W*([a-z_0-9]+)\W*$/i.exec(path);
    if (m) {
      const i = Number(m[1]), s = st.hero.slides[i], c = s && cards.get(s), t = c?.target(m[2]);
      if (t) return { t, card: c, hidden: !(st.hero.mode === "slideshow" || i === 0) };
    }
    m = /video\W*([a-z_]+)\W*$/i.exec(path);
    if (m && vc.target(m[1])) return { t: vc.target(m[1]), hidden: st.hero.mode !== "video" };
    m = /featured\W*([a-z_]+)\W*$/i.exec(path);
    if (m && feat.target(m[1])) return { t: feat.target(m[1]) };
    return null;
  }
  function showServerError(e) {
    const msg = e?.message || "The homepage could not be saved. Please try again.";
    const p = locate(e?.data, msg);
    if (p) p.t.error(msg);
    fill(alertBox, icon("warning-circle"),
      h("div", { class: "hp-alert-text" }, h("strong", { text: "Not saved. " }), h("span", { text: msg })),
      p && !p.hidden ? h("button", { type: "button", class: "btn btn-secondary btn-sm", onclick: () => reveal(p) }, "Show me") : null);
    alertBox.hidden = false;
    if (p && !p.hidden) reveal(p);
    else window.scrollTo({ top: 0, behavior: reducedMotion() ? "auto" : "smooth" });
  }

  /* ---------- Save ---------- */
  async function save() {
    if (saving) return;
    if (busy()) { toast("A photo or video is still uploading. Save again when it finishes.", "info"); return; }
    if (!validate()) return;
    if (!tracker.isDirty()) { ss.set("clean"); return; }
    saving = true; ss.set("saving");
    const body = snapshot(st);
    try {
      const r = await api("/homepage", { method: "PUT", body });
      saving = false;
      const saved = normalize(itemOf(r, "homepage") || body);
      if (JSON.stringify(snapshot(saved)) !== JSON.stringify(body)) {
        // the server adjusted something: show exactly what was saved
        cleanups.forEach(fn => { try { fn(); } catch { /* ignore */ } }); cleanups.length = 0;
        editor(container, cx, saved, lists);
      } else { tracker.reset(); ss.set("clean"); }
      toast("Homepage saved. It is live on the website now.");
    } catch (e) {
      saving = false; ss.set("error");
      if (e?.status === 401) return;
      showServerError(e);
    }
  }

  /* ---------- Layout ---------- */
  const main = h("div", { class: "hp-main" }, alertBox, modeCard, vc.el, slidesCard, lookCard, feat.el);
  const side = h("aside", { class: "hp-side", "aria-label": "Live preview" }, pv.el);
  const form = h("form", { id: FORM_ID, class: "hp-grid", novalidate: true }, main, side);
  fill(container, fr.head, h("p", { class: "page-sub page-sub-solo", text: SUBTITLE }), form, fr.savebar, live);

  tracker = dirtyTracker(() => snapshot(st));
  cx.guard(() => tracker.isDirty() || busy());
  form.addEventListener("input", changed);
  form.addEventListener("change", changed);
  form.addEventListener("submit", e => { e.preventDefault(); save(); });
  const onKey = e => { if ((e.ctrlKey || e.metaKey) && !e.altKey && e.key.toLowerCase() === "s") { e.preventDefault(); save(); } };
  document.addEventListener("keydown", onKey);
  cleanups.push(() => document.removeEventListener("keydown", onKey));
  applyMode();
  setActive(0);
  pv.paint();
  ss.set("clean");
}
