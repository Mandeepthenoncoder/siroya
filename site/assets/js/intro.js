/* Homepage intro: "Siroya Jewellers. Jewellers to the World."
   A dotted gold world map ripples out from Dubai, routes draw out to the
   world, and dots glow under the visitor's pointer or finger. Lifts like a
   curtain to reveal the hero. Once per session (force with ?intro=1),
   skippable, reduced-motion safe.
   Land mask: Natural Earth 110m (world-atlas), rasterised to 160x72 dots. */
(function () {
  "use strict";
  var KEY = "siroya_intro_seen";
  var force = /[?&]intro=1/.test(location.search);
  var seen = false;
  try { seen = sessionStorage.getItem(KEY) === "1"; } catch (e) {}
  if (seen && !force) return;
  try { sessionStorage.setItem(KEY, "1"); } catch (e) {}

  var reduce = matchMedia("(prefers-reduced-motion: reduce)").matches;
  var W = 160, H = 72, LAT_TOP = 80, LAT_BOT = -58;
  var MASK = "AAAAAm//////AAfwAAAAfgAAAAAAAAA7H/z///8AA0AABgAPwAAAAAAAAE+/+Af//wAAAABwA//gB2AAAAAA///8Af/+AAAAAcEP//+DAADA/AH////B//4AADwDx///////AAH//////+H//gAA/gA///////7+f/////////////4APgCAAAAAAAD//////////////HHwAYAAAAAAABn/////8eB8A4AP////////////A/////4PgDgAAD9///////////4D/P///AeQCAAAPz/////////58ABwH//+B/gAAAYfP////////gOAAMAH///H+AAABh5////////4BwAAAAf///f+AAAPH/////////8HAAAAAf//9/8AAA///////////wYAAAAB/////wAAA///////////AAAAAAD////3gAAD//////////0AAAAAAH////0AAAH///3//////QAAAAAAf///8AAAAf/5+f/////5AAAAAAD///+AAAAPz/g5//////MAAAAAAP///4AAAA+b//z/////wgAAAAAAf//+AAAADwN//P////uCAAAAAAB///4AAAAP+m///////M4AAAAAAD///AAAAAf4I//////4/gAAAAAAH//4AAAAD/5B//////xwAAAAAAAP//AAAAAf/////////CAAAAAAAAf/sAAAAB/////////+AAAAAAAAB/gcAAAAP////f////wAAAAAAAAD+AwAAAB////+/////AAAAAAAAAH4FAAAAH///3/j///0AAAAAEAAAHjsAAAA/////+H//8AAAAAAIAAAeYeAAAD///+/wPx+wAAAAAAAAAA/haAAAH///7+A+D8GAAAAAAAAAA/gAAAA////3wDwPwYAAAAAAAAAAeAAAAD////8AHAfhgAAAAAAAAAAYYAAAP////IAcB+DAAAAAAAAAAAr+AAAf////gAwCwMAAAAAAAAAAB/8AAA////+ADAYAwAAAAAAAAAAB/8AAB////wAGAwZAAAAAAAAAAAH/4AADD///AAAPDgAAAAAAAAAAAf/wAAAD//4AAAceAAAAAAAAAAAD//AAAAP//AAAAz/gAAAAAAAAAAP//AAAA//4AAADvY0AAAAAAAAAA///gAAD//AAAAGdt8QAAAAAAAAD///gAAH/8AAAAMGD7AAAAAAAAAP//+AAAf/wAAAAeAHxgAAAAAAAAf//4AAB//AAAAAL4NhAAAAAAAAB///AAAD/8AAAAAAASAAAAAAAAAD//4AAAf/xAAAAAA5AAAAAAAAAAP//gAAB//GAAAAAfmAIIAAAAAAAf/+AAAH/94AAAAD/4AjAAAAAAAA//4AAAf/HAAAAAP/gAAAAAAAAAB//AAAA/8cAAAAH//AQAAAAAAAAP/8AAAD/xwAAAA//+AAAAAAAAAA//AAAAP/GAAAAD//8AAAAAAAAAD/4AAAA/4AAAAAP//wAAAAAAAAAP/gAAAB/gAAAAA///gAAAAAAAAA/8AAAAH8AAAAAB//8AAAAAAAAAD/gAAAAPgAAAAAH7/wAAAAAAAAAP+AAAAA8AAAAAAeD/AAAAAAAAAB/gAAAAAAAAAAAAAH4AQAAAAAAAH+AAAAAAAAAAAAAAPgBgAAAAAAAfgAAAAAAAAAAAAAAAAGAAAAAAAB8AAAAAAAAAAAAAAAwAwAAAAAAAHgAAAAAAAAAAAAAABAGAAAAAAAA+AAAAAAAAAAAAAAAAAwAAAAAAAD4AAAAAAAAAAAAAAAAAAAAAAAAAPAAAAAAAAAAgAAAAAAAAAAAAAAA8QAAAAAAAAAAAAAAAAAAAAAAAABwAAAAAAAAAAAAAAAAAAAAAAAAADgAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";

  // Decode the bitmask into land dots
  var raw = atob(MASK), dots = [];
  for (var i = 0; i < W * H; i++) {
    if ((raw.charCodeAt(i >> 3) >> (7 - (i & 7))) & 1) dots.push({ gx: i % W, gy: (i / W) | 0, a: 0, glow: 0 });
  }
  function toGrid(lon, lat) { return { gx: (lon + 180) / 360 * W, gy: (LAT_TOP - lat) / (LAT_TOP - LAT_BOT) * H }; }
  var HOME = toGrid(55.3, 25.2); // Dubai
  // Illustrative routes only: no claim about specific markets
  var ROUTES = [[72.8, 19.1], [-0.1, 51.5], [-74, 40.7], [-79.4, 43.7], [103.8, 1.35], [151.2, -33.9], [36.8, -1.3], [28, -26.2],
    [46.7, 24.7], [58.4, 23.6], [51.5, 25.3], [114.2, 22.3], [101.7, 3.1], [3.4, 6.5], [-87.6, 41.9], [77.6, 12.9], [2.35, 48.85]]
    .map(function (p, k) { var g = toGrid(p[0], p[1]); return { gx: g.gx, gy: g.gy, delay: 0.55 + k * 0.07 }; });

  // Overlay markup
  var el = document.createElement("div");
  el.className = "intro";
  el.setAttribute("role", "dialog");
  el.setAttribute("aria-label", "Siroya Jewellers, Jewellers to the World since 1976");
  el.innerHTML =
    '<canvas class="intro-map" aria-hidden="true"></canvas>' +
    '<button class="intro-skip" type="button">Skip intro</button>' +
    '<div class="intro-copy">' +
      '<span class="intro-since">Since 1976</span>' +
      '<img class="intro-logo" src="assets/img/logo/siroya-white.png" alt="Siroya Jewellers">' +
      '<p class="intro-line" aria-label="Jewellers to the World"></p>' +
      '<span class="intro-rule" aria-hidden="true"></span>' +
      '<button class="intro-enter btn btn-cream" type="button">Enter</button>' +
    '</div>';
  var line = el.querySelector(".intro-line");
  "Jewellers to the World".split("").forEach(function (ch, k) {
    var s = document.createElement("span");
    s.setAttribute("aria-hidden", "true");
    s.textContent = ch === " " ? " " : ch;
    s.style.setProperty("--k", k);
    line.appendChild(s);
  });
  document.documentElement.classList.add("intro-active");
  document.body.appendChild(el);
  document.documentElement.classList.remove("intro-pending");
  requestAnimationFrame(function () { requestAnimationFrame(function () { el.classList.add("play"); }); });

  // Canvas layout
  var cv = el.querySelector("canvas"), ctx = cv.getContext("2d");
  var dpr = Math.min(window.devicePixelRatio || 1, 2), cw, ch, cell, ox, oy, hx = 0, hy = 0;
  function layout() {
    cw = el.clientWidth; ch = el.clientHeight;
    cv.width = Math.round(cw * dpr); cv.height = Math.round(ch * dpr);
    cv.style.width = cw + "px"; cv.style.height = ch + "px";
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    var phone = cw < 700;
    var mapW = Math.min(cw * (phone ? 1.6 : 0.94), 1500);
    cell = mapW / W;
    ox = phone ? cw / 2 - HOME.gx * cell : (cw - mapW) / 2; // phones: centre on the Gulf
    oy = ch * (phone ? 0.33 : 0.41) - (H * cell) / 2;
  }
  layout();
  addEventListener("resize", layout);

  var px = -9999, py = -9999, lastMove = 0;
  el.addEventListener("pointermove", function (e) { px = e.clientX; py = e.clientY; lastMove = performance.now(); });
  el.addEventListener("pointerdown", function (e) { px = e.clientX; py = e.clientY; lastMove = performance.now(); });
  el.addEventListener("pointerleave", function () { px = py = -9999; });

  var t0 = performance.now(), raf = 0, done = false;
  var entering = 0, released = false, homeX = 0, homeY = 0;
  var canMask = window.CSS && CSS.supports && (CSS.supports("mask-image", "radial-gradient(black, white)") || CSS.supports("-webkit-mask-image", "radial-gradient(black, white)"));
  function ease(x) { x = Math.min(Math.max(x, 0), 1); return 1 - Math.pow(1 - x, 3); }
  function inOut(x) { x = Math.min(Math.max(x, 0), 1); return x < 0.5 ? 4 * x * x * x : 1 - Math.pow(-2 * x + 2, 3) / 2; }

  function frame(now) {
    var t = reduce ? 4 : (now - t0) / 1000;
    var active = px > -999;
    var tgx = active ? (px / cw - 0.5) * -14 : 0, tgy = active ? (py / ch - 0.5) * -10 : 0;
    hx += (tgx - hx) * 0.06; hy += (tgy - hy) * 0.06;
    ctx.clearRect(0, 0, cw, ch);
    var hxp = ox + hx + HOME.gx * cell, hyp = oy + hy + HOME.gy * cell;
    homeX = hxp; homeY = hyp;
    var e = entering ? (now - entering) / 1000 : 0;
    var zoomP = entering ? inOut(e / 1.5) : 0, fadeRoutes = 1 - zoomP;
    ctx.save();
    if (zoomP > 0) { var z = 1 + zoomP * 5; ctx.translate(hxp, hyp); ctx.scale(z, z); ctx.translate(-hxp, -hyp); }
    var ripple = t * 95; // grid cells per second, outward from Dubai
    var r = Math.max(0.9, cell * 0.2);
    for (var i = 0; i < dots.length; i++) {
      var d = dots[i];
      var x = ox + hx + (d.gx + 0.5) * cell, y = oy + hy + (d.gy + 0.5) * cell;
      if (x < -10 || x > cw + 10) continue;
      var dist = Math.hypot(d.gx - HOME.gx, (d.gy - HOME.gy) * 1.2);
      var target = dist < ripple ? 0.32 : 0;
      var front = t < 2.4 ? Math.max(0, 1 - Math.abs(dist - ripple) / 6) : 0;
      var pd = Math.hypot(x - px, y - py);
      var hover = pd < 110 ? Math.pow(1 - pd / 110, 2) : 0;
      d.a += (target - d.a) * 0.12;
      d.glow += (Math.max(front * 0.7, hover) - d.glow) * 0.18;
      var alpha = Math.min(1, d.a + d.glow * 0.75 + zoomP * 0.35);
      if (alpha < 0.01) continue;
      ctx.fillStyle = d.glow > 0.05 ? "rgba(236,206,146," + alpha + ")" : "rgba(196,160,98," + alpha + ")";
      ctx.beginPath(); ctx.arc(x, y, r * (1 + d.glow * 0.9), 0, 6.2832); ctx.fill();
    }
    for (var k = 0; k < ROUTES.length; k++) {
      var R = ROUTES[k], p = ease((t - R.delay) / 1.1);
      if (p <= 0 || fadeRoutes <= 0.02) continue;
      ctx.globalAlpha = fadeRoutes;
      var ex = ox + hx + R.gx * cell, ey = oy + hy + R.gy * cell;
      var mx = (hxp + ex) / 2, my = (hyp + ey) / 2 - Math.hypot(ex - hxp, ey - hyp) * 0.28;
      var g = ctx.createLinearGradient(hxp, hyp, ex, ey);
      g.addColorStop(0, "rgba(226,194,131,0.85)"); g.addColorStop(1, "rgba(226,194,131,0.15)");
      ctx.strokeStyle = g; ctx.lineWidth = 1.1; ctx.beginPath();
      var steps = 40, n = Math.max(1, Math.round(steps * p));
      for (var s = 0; s <= n; s++) {
        var u = s / steps, a1 = (1 - u) * (1 - u), b1 = 2 * (1 - u) * u, c1 = u * u;
        var qx = a1 * hxp + b1 * mx + c1 * ex, qy = a1 * hyp + b1 * my + c1 * ey;
        if (s) ctx.lineTo(qx, qy); else ctx.moveTo(qx, qy);
      }
      ctx.stroke();
      if (p >= 1) {
        var pulse = 0.5 + 0.5 * Math.sin(now / 420 + k);
        ctx.fillStyle = "rgba(236,206,146," + (0.55 + pulse * 0.35) + ")";
        ctx.beginPath(); ctx.arc(ex, ey, 2.2 + pulse * 1.2, 0, 6.2832); ctx.fill();
      }
    }
    ctx.globalAlpha = 1;
    ctx.restore();
    var hp = 0.5 + 0.5 * Math.sin(now / 300);
    ctx.fillStyle = "rgba(226,194,131," + (0.18 * hp) + ")";
    ctx.beginPath(); ctx.arc(hxp, hyp, 10 + hp * 10, 0, 6.2832); ctx.fill();
    ctx.fillStyle = "#F5F2EC"; ctx.beginPath(); ctx.arc(hxp, hyp, 3.2 + zoomP * 4, 0, 6.2832); ctx.fill();
    if (entering) {
      var irisP = inOut((e - 0.55) / 1.35);
      if (irisP > 0) {
        if (!released) release();
        var maxR = Math.hypot(Math.max(hxp, cw - hxp), Math.max(hyp, ch - hyp)) + 160;
        var rad = irisP * maxR;
        el.style.setProperty("--cx", hxp + "px"); el.style.setProperty("--cy", hyp + "px"); el.style.setProperty("--r", rad + "px");
        // a gold ring rides the edge of the opening
        ctx.save();
        ctx.strokeStyle = "rgba(236,206,146," + (0.85 * (1 - irisP * 0.7)) + ")";
        ctx.lineWidth = 1.5; ctx.shadowColor = "rgba(226,194,131,0.9)"; ctx.shadowBlur = 24;
        ctx.beginPath(); ctx.arc(hxp, hyp, rad + 46, 0, 6.2832); ctx.stroke();
        ctx.restore();
        if (irisP >= 1) { finish(); return; }
      }
    }
    if (!done) raf = requestAnimationFrame(frame);
  }
  raf = requestAnimationFrame(frame);

  function onKey(e) { if (e.key === "Escape" || e.key === "Enter") exit(); }
  function onWheel(e) { if (e.deltaY > 20) exit(); }
  // Hand the page over: hero, header and smooth scroll start their entrance
  function release() {
    if (released) return;
    released = true;
    document.documentElement.classList.remove("intro-active");
    document.body.classList.add("intro-done");
    dispatchEvent(new CustomEvent("siroya:intro-done"));
    if (window.dataLayer) window.dataLayer.push({ event: "intro_complete" });
  }
  function finish() {
    if (done) return;
    done = true; cancelAnimationFrame(raf); removeEventListener("resize", layout); el.remove();
  }
  function exit() {
    if (entering || el.classList.contains("out")) return;
    removeEventListener("keydown", onKey);
    removeEventListener("wheel", onWheel);
    if (reduce || !canMask) {
      // Simple curtain lift (or fade for reduced motion)
      el.classList.add("out"); release();
      setTimeout(finish, reduce ? 350 : 1300);
      return;
    }
    // Enter: copy dissolves, the map dives into Dubai, a gold ring opens onto the site
    entering = performance.now();
    el.classList.add("entering", "iris");
    px = py = -9999;
    setTimeout(finish, 4000); // safety net
  }
  el.querySelector(".intro-enter").addEventListener("click", exit);
  el.querySelector(".intro-skip").addEventListener("click", exit);
  addEventListener("keydown", onKey);
  addEventListener("wheel", onWheel, { passive: true });
  var swipeY = null;
  el.addEventListener("touchstart", function (e) { swipeY = e.touches[0].clientY; }, { passive: true });
  el.addEventListener("touchend", function (e) { if (swipeY !== null && swipeY - e.changedTouches[0].clientY > 50) exit(); swipeY = null; });
  setTimeout(function () { var b = el.querySelector(".intro-enter"); if (b) b.focus({ preventScroll: true }); }, reduce ? 100 : 2700);

  // Auto-continue after the sequence, but never while the visitor is playing with the map (max 12 s)
  (function wait() {
    if (el.classList.contains("out")) return;
    var now = performance.now(), t = now - t0;
    if (t > 12000 || (t > (reduce ? 1800 : 5600) && now - lastMove > 1400)) return exit();
    setTimeout(wait, 250);
  })();
})();
