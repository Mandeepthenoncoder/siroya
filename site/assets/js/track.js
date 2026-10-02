/* Siroya first-party analytics (docs/TRAFFIC-SPEC.md, section 4).
   Sends one page_view per page load and mirrors the dataLayer events that
   site.js and intro.js push, as small JSON beacons to POST /api/track.
   No cookies: a random session id in sessionStorage (siroya_sid) and a
   "seen before" flag in localStorage (siroya_seen). The traffic source is
   fixed per session: the landing URL's utm / gclid and external referrer,
   else the last campaign site.js keeps in siroya_attr (90 days), so later
   pages of a visit keep their source instead of turning "direct".
   Sends nothing with Do Not Track, Global Privacy Control, on file: pages,
   or when localStorage siroya_notrack is set (staff opt-out).
   Load it in <body>, before site.js (after data.js). Never throws. */
(function (w, d) {
  const nav = navigator, loc = location, SS = "sessionStorage", LS = "localStorage", END = "/api/track";
  let q, path, sid, ses;

  // Storage can be blocked: every read and write is guarded
  const store = (s, k, v) => { try { k = "siroya_" + k; return v ? w[s].setItem(k, v) : w[s].getItem(k); } catch (e) {} };
  // Single line, capped at 100 (the server trims); empty values are left out of the JSON.
  // path needs no cut: it is the URL-encoded pathname plus one param (the server caps it at 200)
  const cut = v => v && (v + "").replace(/\s+/g, " ").slice(0, 100) || undefined;
  const val = v => v != "all" && v;
  const attr = f => {
    const o = { src: cut(f("utm_source")), med: cut(f("utm_medium")), cmp: cut(f("utm_campaign")), g: !!(f("gclid") || f("gbraid") || f("wbraid")) };
    return o.src || o.med || o.cmp || o.g ? o : null;
  };

  function send(t, e) {
    try {
      const pt = d.body.dataset.page, l = e.item_list_id || "", o = { i: q.get("p") };
      // Product, collection and category: the page URL (?p=, ?c=), overridden by the event's own fields
      o[pt == "category" ? "k" : "c"] = q.get("c");
      if (/^category-/.test(l)) o.k = l.slice(9); else if (l) o.c = l;
      const b = JSON.stringify(Object.assign({ t, p: path, pt, i: cut(o.i || e.item_id || e.item_name),
        c: cut(val(e.collection) || o.c), k: cut(val(e.category) || o.k), sid, n: ses.n }, ses.a));
      if (!(nav.sendBeacon && nav.sendBeacon(END, new Blob([b], { type: "text/plain" })))) {
        fetch(END, { method: "POST", body: b, keepalive: true }).catch(() => {}); // a string body is sent as text/plain
      }
    } catch (x) {}
  }
  function mirror(e) {
    if (e && /^(view_item(_list)?|filter_collection|whatsapp_click|generate_lead|story_open|intro_complete)$/.test(e.event)) send(e.event, e);
  }
  function pageView() {
    if (d.prerendering) d.addEventListener("prerenderingchange", pageView);
    else send("page_view", {});
  }

  try {
    if (nav.doNotTrack == 1 || nav.globalPrivacyControl || !/^https?:$/.test(loc.protocol) ||
      w.siroyaTrack || store(LS, "notrack")) return;
    w.siroyaTrack = 1;

    // Path: /index.html becomes /; only the p or c param is kept (never gclid or utm)
    q = new URLSearchParams(loc.search);
    path = loc.pathname.replace(/\/index\.html$/, "/") + (loc.search.match(/[?&][pc]=[^&#]*/) || [""])[0].replace("&", "?");

    // Session: id, new or returning visitor, traffic source { src, med, cmp, g, ref }
    sid = store(SS, "sid");
    ses = JSON.parse(store(SS, "ses") || null);
    if (!/^[a-f0-9]{16}$/.test(sid) || !ses) {
      sid = [].map.call(crypto.getRandomValues(new Uint8Array(8)), x => (x + 256).toString(16).slice(1)).join("");
      ses = { n: store(LS, "seen") ? 0 : 1 };
      store(LS, "seen", 1);
      store(SS, "sid", sid);
    }
    let ref = d.referrer && new URL(d.referrer).hostname, a = attr(k => q.get(k)), st;
    if (ref == loc.hostname) ref = "";
    if (a || ref) ses.a = Object.assign(a || {}, { ref: cut(ref) });
    else if (!ses.a) ses.a = (st = JSON.parse(store(LS, "attr") || null)) && Date.now() - st.ts < 7776e6 && attr(k => st[k]) || {};
    store(SS, "ses", JSON.stringify(ses));

    // Mirror dataLayer events, including any pushed before this script ran
    const dl = w.dataLayer = w.dataLayer || [], push = dl.push;
    dl.forEach(mirror);
    dl.push = function () {
      const r = push.apply(dl, arguments);
      [].forEach.call(arguments, mirror);
      return r;
    };
    pageView();
  } catch (e) {}
})(window, document);
