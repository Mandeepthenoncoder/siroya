/* Siroya admin: photos.
   Client-side resize (max 2000px long edge, JPEG q0.85, PNG kept when it has
   transparency), upload with per-file progress, a multi-image manager with
   drag and up/down reordering, and a single image field. */
import { h, fill, icon, iconBtn, imgSrc, toast, ApiError, errorText, ensureAuth, dragSort, moveItem, nextId } from "./lib.js";

const MAX_EDGE = 2000;
const JPEG_Q = 0.85;
const MAX_BYTES = 10 * 1024 * 1024;
const ACCEPT = "image/jpeg,image/png,image/webp,image/gif,image/avif,image/heic,image/heif";

/* ---------------- Resize ---------------- */
async function decode(file) {
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
function drawScaled(ctx, src, w0, h0, w, hgt) {
  let cur = src, cw = w0, ch = h0;
  while (cw > w * 2) { // halve in steps for a cleaner downscale
    const nw = Math.round(cw / 2), nh = Math.round(ch / 2);
    const c = document.createElement("canvas"); c.width = nw; c.height = nh;
    const x = c.getContext("2d"); x.imageSmoothingEnabled = true; x.imageSmoothingQuality = "high";
    x.drawImage(cur, 0, 0, nw, nh);
    cur = c; cw = nw; ch = nh;
  }
  ctx.drawImage(cur, 0, 0, w, hgt);
}
function hasAlpha(ctx, w, hgt) {
  const data = ctx.getImageData(0, 0, w, hgt).data;
  for (let i = 3; i < data.length; i += 4) if (data[i] < 255) return true;
  return false;
}
const toBlob = (canvas, type, q) => new Promise(r => canvas.toBlob(b => r(b), type, q));
const toDataUrl = blob => new Promise((res, rej) => { const fr = new FileReader(); fr.onload = () => res(fr.result); fr.onerror = () => rej(new Error("read")); fr.readAsDataURL(blob); });

export async function prepareImage(file) {
  if (file.size > 60 * 1024 * 1024) throw new Error("This file is over 60 MB. Please choose a smaller photo.");
  let src;
  try { src = await decode(file); }
  catch { throw new Error("This file could not be read. Please use a JPG, PNG or WebP photo."); }
  const w0 = src.naturalWidth || src.width, h0 = src.naturalHeight || src.height;
  if (!w0 || !h0) throw new Error("This file could not be read. Please use a JPG, PNG or WebP photo.");
  const scale = Math.min(1, MAX_EDGE / Math.max(w0, h0));
  const w = Math.max(1, Math.round(w0 * scale)), hgt = Math.max(1, Math.round(h0 * scale));
  const canvas = document.createElement("canvas"); canvas.width = w; canvas.height = hgt;
  const ctx = canvas.getContext("2d");
  ctx.imageSmoothingEnabled = true; ctx.imageSmoothingQuality = "high";
  drawScaled(ctx, src, w0, h0, w, hgt);
  src.close?.();
  const mayAlpha = /png|webp|gif|avif/i.test(file.type) || /\.(png|webp|gif|avif)$/i.test(file.name || "");
  let blob, ext;
  if (mayAlpha && hasAlpha(ctx, w, hgt)) {
    blob = await toBlob(canvas, "image/png"); ext = "png";
    if (blob && blob.size > MAX_BYTES * 0.95) { // very large transparent image: WebP keeps the transparency
      const wb = await toBlob(canvas, "image/webp", 0.9);
      if (wb && wb.type === "image/webp") { blob = wb; ext = "webp"; }
    }
  } else {
    blob = await toBlob(canvas, "image/jpeg", JPEG_Q); ext = "jpg";
  }
  if (!blob) throw new Error("This photo could not be processed. Please try a different file.");
  if (blob.size > MAX_BYTES) throw new Error("This image is still over 10 MB after resizing. Please use a smaller photo.");
  const base = (file.name || "photo").replace(/\.[^.]+$/, "").replace(/[^\w.-]+/g, "-").slice(0, 80) || "photo";
  return { dataUrl: await toDataUrl(blob), filename: `${base}.${ext}`, width: w, height: hgt, bytes: blob.size, preview: URL.createObjectURL(blob) };
}

/* ---------------- Upload ---------------- */
let active = 0; const waiting = [];
async function takeSlot() { if (active >= 2) await new Promise(r => waiting.push(r)); active++; }
function freeSlot() { active--; waiting.shift()?.(); }

function postUpload(prep, onProgress, retried = false) {
  return new Promise((resolve, reject) => {
    const x = new XMLHttpRequest();
    x.open("POST", "/api/admin/upload");
    x.withCredentials = true;
    x.setRequestHeader("Content-Type", "application/json");
    x.setRequestHeader("Accept", "application/json");
    x.upload.onprogress = e => { if (e.lengthComputable) onProgress(e.loaded / e.total); };
    x.onload = () => {
      let data = null; try { data = JSON.parse(x.responseText); } catch { /* not JSON */ }
      if (x.status >= 200 && x.status < 300 && data?.url) return resolve(data.url);
      if (x.status === 401 && !retried) return ensureAuth().then(() => postUpload(prep, onProgress, true)).then(resolve, reject);
      reject(new ApiError(errorText(x.status, data), x.status, data));
    };
    x.onerror = () => reject(new ApiError("Upload failed. Check your connection and try again.", 0));
    x.send(JSON.stringify({ filename: prep.filename, dataUrl: prep.dataUrl }));
  });
}

/** Runs one file through resize and upload. job.onUpdate is called on every step. */
export async function runUpload(job) {
  const upd = () => job.onUpdate?.(job);
  job.state = "waiting"; job.pct = 0; job.error = ""; upd();
  await takeSlot();
  try {
    job.state = "preparing"; upd();
    if (!job.prep) job.prep = await prepareImage(job.file);
    job.preview = job.prep.preview;
    job.state = "uploading"; upd();
    job.url = await postUpload(job.prep, p => { job.pct = p; upd(); });
    job.state = "done"; job.pct = 1; job.prep.dataUrl = null; upd();
    return job.url;
  } catch (e) {
    job.state = "error"; job.error = e.message || "Upload failed."; upd();
    throw e;
  } finally { freeSlot(); }
}
const isImageFile = f => /^image\//.test(f.type) || /\.(jpe?g|png|webp|gif|avif|heic|heif)$/i.test(f.name || "");
const fileOf = path => decodeURIComponent(String(path).split("/").pop() || path);
const hasFiles = e => [...(e.dataTransfer?.types || [])].includes("Files");

function progressEl(job) {
  const label = job.state === "waiting" ? "Waiting" : job.state === "preparing" ? "Resizing" : job.state === "uploading" ? `Uploading ${Math.round(job.pct * 100)}%` : job.state === "done" ? "Uploaded" : "Failed";
  return h("div", { class: `prog prog-${job.state}` },
    h("div", { class: "prog-bar", role: "progressbar", "aria-label": `Upload of ${job.file.name}`, "aria-valuemin": "0", "aria-valuemax": "100", "aria-valuenow": String(Math.round(job.pct * 100)) },
      h("span", { style: { width: `${job.state === "preparing" ? 8 : Math.max(4, Math.round(job.pct * 100))}%` } })),
    h("span", { class: "prog-text", text: label }));
}

/* ---------------- Multi image manager (products) ---------------- */
export function imageManager({ images = [], onChange, label = "Photos" }) {
  let rows = images.map(url => ({ key: nextId("img"), url }));
  const inputId = nextId("files");
  const live = h("p", { class: "sr-only", "aria-live": "polite" });
  const list = h("ol", { class: "img-list", "aria-label": label });
  const fileInput = h("input", { type: "file", id: inputId, accept: ACCEPT, multiple: true, class: "sr-only", tabindex: "-1" });
  const drop = h("div", { class: "drop" },
    icon("images", "drop-ic"),
    h("div", { class: "drop-text" },
      h("strong", { text: "Drag photos here" }), " or ",
      h("button", { type: "button", class: "linkish", onclick: () => fileInput.click() }, "choose files")),
    h("p", { class: "hint", text: "JPG, PNG or WebP. Large photos are resized to 2000px automatically. Portrait 4:5 looks best." }),
    h("button", { type: "button", class: "btn btn-secondary drop-btn", onclick: () => fileInput.click() }, icon("upload-simple"), "Add photos"),
    fileInput);
  const el = h("div", { class: "imgman" }, drop, list, live);

  const urls = () => rows.filter(r => r.url).map(r => r.url);
  const changed = () => onChange?.(urls());
  const announce = t => { live.textContent = ""; requestAnimationFrame(() => { live.textContent = t; }); };

  function move(key, dir, focusAct) {
    const i = rows.findIndex(r => r.key === key), j = i + dir;
    if (j < 0 || j >= rows.length) return;
    rows = moveItem(rows, i, j);
    render(); changed();
    announce(`Photo moved to position ${j + 1} of ${rows.length}.`);
    const btn = list.querySelector(`[data-key="${key}"] [data-act="${focusAct}"]`);
    (btn && !btn.disabled ? btn : list.querySelector(`[data-key="${key}"] [data-act="${focusAct === "up" ? "down" : "up"}"]`))?.focus();
  }
  function remove(key) {
    const i = rows.findIndex(r => r.key === key);
    const r = rows[i]; if (!r) return;
    r.job && (r.job.cancelled = true);
    rows.splice(i, 1);
    render(); if (r.url) changed();
    announce("Photo removed. Save to apply.");
    const next = list.querySelectorAll(".img-row")[Math.min(i, rows.length - 1)];
    (next?.querySelector("[data-act=remove]") || fileInput.closest(".imgman").querySelector(".drop-btn"))?.focus();
  }
  function makeMain(key) {
    const i = rows.findIndex(r => r.key === key);
    if (i <= 0) return;
    rows = moveItem(rows, i, 0); render(); changed();
    announce("Photo set as main image.");
    list.querySelector(`[data-key="${key}"] [data-act="down"]`)?.focus();
  }

  function rowEl(r, idx, mainIdx) {
    const isMain = idx === mainIdx;
    const job = r.job;
    const src = r.url ? imgSrc(r.url) : job?.preview || "";
    const thumb = h("div", { class: "img-thumb" },
      src ? h("img", { src, alt: "", loading: "lazy", decoding: "async" }) : h("div", { class: "slot" }, icon(job?.state === "error" ? "warning" : "image")),
      isMain ? h("span", { class: "badge-main", text: "Main" }) : null);
    const info = h("div", { class: "img-info" },
      h("strong", { text: r.url ? (isMain ? "Main image" : `Image ${idx + 1}`) : job.file.name }),
      r.url ? h("span", { class: "muted small", text: isMain ? "Shown first on the site and in lists" : fileOf(r.url) }) : null,
      job && job.state !== "done" ? progressEl(job) : null,
      job?.state === "error" ? h("p", { class: "field-err", role: "alert" }, icon("warning-circle"), " ", job.error) : null);
    const actions = h("div", { class: "img-actions" },
      r.url && !isMain ? iconBtn("star", "Make main image", () => makeMain(r.key), { class: "act-main" }) : null,
      r.url ? h("span", { class: "ud" },
        iconBtn("arrow-up", "Move up", () => move(r.key, -1, "up"), { disabled: idx === 0 }),
        iconBtn("arrow-down", "Move down", () => move(r.key, 1, "down"), { disabled: idx === rows.length - 1 })) : null,
      job?.state === "error" ? iconBtn("arrow-clockwise", "Retry upload", () => start(r)) : null,
      iconBtn("trash", r.url ? "Remove photo" : "Cancel upload", () => remove(r.key), { class: "act-del" }));
    actions.querySelectorAll(".ud button").forEach((b, k) => { b.dataset.act = k ? "down" : "up"; });
    actions.querySelector(".act-del").dataset.act = "remove";
    return h("li", { class: ["img-row", isMain && "is-main", job && !r.url && "is-job"], dataset: { key: r.key } },
      r.url ? h("span", { class: "drag-handle", "data-handle": "", title: "Drag to reorder", "aria-hidden": "true" }, icon("dots-six-vertical")) : h("span", { class: "drag-handle ghost", "aria-hidden": "true" }),
      thumb, info, actions);
  }
  function render() {
    const mainIdx = rows.findIndex(r => r.url);
    list.replaceChildren(...rows.map((r, i) => rowEl(r, i, mainIdx)));
    list.hidden = !rows.length;
    el.classList.toggle("has-images", rows.length > 0);
  }
  function updateRow(r) {
    if (r.job?.cancelled) return;
    const old = list.querySelector(`[data-key="${r.key}"]`);
    if (!old) return;
    const mainIdx = rows.findIndex(x => x.url);
    old.replaceWith(rowEl(r, rows.indexOf(r), mainIdx));
  }
  async function start(r) {
    r.job.onUpdate = () => updateRow(r);
    try {
      const url = await runUpload(r.job);
      if (r.job.cancelled) return;
      r.url = url;
      render(); changed();
      if (r.job.preview) setTimeout(() => URL.revokeObjectURL(r.job.preview), 30000);
      delete r.job;
      if (!busy()) announce("All photos uploaded. Save to apply.");
    } catch (e) {
      if (!r.job?.cancelled) toast(`${r.job.file.name}: ${e.message}`, "error");
    }
  }
  function addFiles(files) {
    const list_ = [...files];
    const ok = list_.filter(isImageFile);
    if (ok.length < list_.length) toast("Some files were skipped because they are not images.", "info");
    const fresh = ok.map(file => ({ key: nextId("img"), job: { file, state: "waiting", pct: 0 } }));
    rows.push(...fresh);
    render();
    fresh.forEach(start);
  }
  function busy() { return rows.some(r => r.job && !r.url && ["waiting", "preparing", "uploading"].includes(r.job.state)); }

  fileInput.addEventListener("change", () => { if (fileInput.files.length) addFiles(fileInput.files); fileInput.value = ""; });
  el.addEventListener("dragover", e => { if (!hasFiles(e)) return; e.preventDefault(); el.classList.add("dragover"); });
  el.addEventListener("dragleave", e => { if (!el.contains(e.relatedTarget)) el.classList.remove("dragover"); });
  el.addEventListener("drop", e => { if (!hasFiles(e)) return; e.preventDefault(); el.classList.remove("dragover"); addFiles(e.dataTransfer.files); });
  dragSort(list, ".img-row:not(.is-job)", (from, to) => {
    const done = rows.filter(r => !(r.job && !r.url));
    const moved = moveItem(done, from, to);
    const pending = rows.filter(r => r.job && !r.url);
    rows = [...moved, ...pending];
    render(); changed();
    announce(`Photo moved to position ${to + 1}.`);
  });
  render();
  return { el, value: urls, busy, set(list_) { rows = list_.map(url => ({ key: nextId("img"), url })); render(); } };
}

/* ---------------- Single image field ---------------- */
export function imageField({ label, value = "", ratio = "4 / 3", hint, onChange, slotLabel }) {
  let url = value || "";
  let job = null;
  const id = nextId("imgf");
  const fileInput = h("input", { type: "file", id, accept: ACCEPT, class: "sr-only", tabindex: "-1" });
  const frame = h("div", { class: "imgf-frame", style: { "aspect-ratio": ratio } });
  const status = h("div", { class: "imgf-status" });
  const btns = h("div", { class: "imgf-btns" });
  const labelId = id + "-l";
  const el = h("div", { class: "field imgf", role: "group", "aria-labelledby": labelId },
    h("div", { class: "label-row" }, h("span", { class: "label", id: labelId, text: label })),
    h("div", { class: "imgf-body" }, frame, h("div", { class: "imgf-side" }, btns, status, hint ? h("p", { class: "hint", text: hint }) : null)),
    fileInput);

  function render() {
    const src = url ? imgSrc(url) : job?.preview || "";
    fill(frame,
      src ? h("img", { src, alt: `${label} preview`, decoding: "async" }) : h("div", { class: "slot" }, h("span", { text: slotLabel || "No image yet" })),
      job && job.state !== "done" && job.state !== "error" ? h("div", { class: "imgf-over" }, progressEl(job)) : null);
    fill(btns,
      h("button", { type: "button", class: "btn btn-secondary btn-sm", onclick: () => fileInput.click(), disabled: !!(job && job.state !== "error") }, icon("upload-simple"), url ? "Replace" : "Upload image"),
      url ? h("button", { type: "button", class: "btn btn-ghost btn-sm", onclick: () => { url = ""; render(); onChange?.(url); } }, icon("trash"), "Remove") : null);
    status.replaceChildren(job?.state === "error" ? h("p", { class: "field-err", role: "alert" }, icon("warning-circle"), " ", job.error) : (url ? h("span", { class: "muted small", text: fileOf(url) }) : ""));
  }
  async function upload(file) {
    if (!isImageFile(file)) { toast("Please choose an image file (JPG, PNG or WebP).", "error"); return; }
    job = { file, state: "waiting", pct: 0, onUpdate: render };
    render();
    try {
      const u = await runUpload(job);
      url = u; const pv = job.preview; job = null; render(); onChange?.(url);
      if (pv) setTimeout(() => URL.revokeObjectURL(pv), 30000);
    } catch (e) { toast(e.message, "error"); render(); }
  }
  fileInput.addEventListener("change", () => { if (fileInput.files[0]) upload(fileInput.files[0]); fileInput.value = ""; });
  frame.addEventListener("dragover", e => { if (!hasFiles(e)) return; e.preventDefault(); frame.classList.add("dragover"); });
  frame.addEventListener("dragleave", () => frame.classList.remove("dragover"));
  frame.addEventListener("drop", e => { if (!hasFiles(e)) return; e.preventDefault(); frame.classList.remove("dragover"); if (e.dataTransfer.files[0]) upload(e.dataTransfer.files[0]); });
  render();
  return { el, value: () => url, busy: () => !!(job && ["waiting", "preparing", "uploading"].includes(job.state)), set(v) { url = v || ""; render(); } };
}
