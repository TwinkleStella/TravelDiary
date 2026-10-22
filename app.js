/* TravelDiary · 旅行日记 — a globe you light up, one moment at a time.
   Everything lives in this browser (IndexedDB). No accounts, no outside servers. */
(() => {
  "use strict";

  // ---------------------------------------------------------------- constants
  const K_A1 = 2.6;      // zoom where countries split into provinces / states
  const K_CITY = 7;      // zoom where Chinese provinces split into cities
  const MAX_PHOTOS = 99;
  const CN = "156";
  const $ = (s) => document.querySelector(s);
  const canvas = $("#globe"), ctx = canvas.getContext("2d"), app = $("#app");
  const reduceMotion = matchMedia("(prefers-reduced-motion: reduce)").matches;

  // Country light colours: one hue per country, picked to sit well together.
  const PALETTE = ["#F49A4C", "#E8607A", "#F2C443", "#6FB89B", "#58A6D6", "#8C7BD1", "#E07B54", "#3FB1AA",
                   "#D774B2", "#9DB654", "#6A8EE0", "#C99A5E", "#EF8FA3", "#4E9F7F"];
  const FIXED = { "156": 1, "410": 4, "392": 8, "458": 3, "764": 0, "840": 10, "250": 5, "826": 11, "704": 9, "702": 7 };

  // ---------------------------------------------------------------- helpers
  function h(tag, attrs, ...kids) {
    const el = document.createElement(tag);
    if (attrs) for (const [k, v] of Object.entries(attrs)) {
      if (v == null || v === false) continue;
      if (k === "class") el.className = v;
      else if (k === "style") el.style.cssText = v;
      else if (k.startsWith("on")) el.addEventListener(k.slice(2), v);
      else el.setAttribute(k, v === true ? "" : v);
    }
    for (const kid of kids.flat(Infinity)) if (kid != null && kid !== false) el.append(kid.nodeType ? kid : document.createTextNode(String(kid)));
    return el;
  }
  const svg = (paths) => { const s = document.createElementNS("http://www.w3.org/2000/svg", "svg"); s.setAttribute("viewBox", "0 0 24 24"); s.innerHTML = paths; return s; };
  const ICON = {
    back: '<path d="M15 5l-7 7 7 7"/>', close: '<path d="M6 6l12 12M18 6L6 18"/>',
    pin: '<path d="M12 21s-6.5-6.2-6.5-11a6.5 6.5 0 0113 0c0 4.8-6.5 11-6.5 11z"/><circle cx="12" cy="10" r="2.3"/>',
    globe: '<circle cx="12" cy="12" r="8.5"/><path d="M3.5 12h17M12 3.5c2.6 2.8 2.6 14.2 0 17M12 3.5c-2.6 2.8-2.6 14.2 0 17"/>',
    city: '<path d="M4 20V9l5-3v14M9 20V4l7 3v13M16 20v-8l4 2v6M2.5 20h19"/>',
    map: '<path d="M9 4l6 2 5-2v14l-5 2-6-2-5 2V6z"/><path d="M9 4v14M15 6v14"/>',
  };
  const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
  const hash = (s) => { let x = 2166136261; for (let i = 0; i < s.length; i++) { x ^= s.charCodeAt(i); x = Math.imul(x, 16777619); } return x >>> 0; };
  function toast(msg, ms = 2600) { const t = $("#toast"); t.textContent = msg; t.hidden = false; clearTimeout(toast.t); toast.t = setTimeout(() => (t.hidden = true), ms); }
  const today = () => { const d = new Date(); d.setMinutes(d.getMinutes() - d.getTimezoneOffset()); return d.toISOString().slice(0, 10); };
  const fmtDate = (s) => { if (!s) return ""; const [y, m, d] = s.split("-"); return `${y} 年 ${+m} 月 ${+d} 日`; };
  const fmtCoord = ([lon, lat]) => `${Math.abs(lat).toFixed(2)}°${lat >= 0 ? "N" : "S"} · ${Math.abs(lon).toFixed(2)}°${lon >= 0 ? "E" : "W"}`;
  const yearOf = (e) => +(e.date || "").slice(0, 4) || new Date(e.createdAt).getFullYear();

  function countryColor(id) {
    const i = FIXED[id] != null ? FIXED[id] : hash("c" + id) % PALETTE.length;
    return PALETTE[i];
  }
  function shade(hex, amt) { // amt -1..1 lighten/darken
    const n = parseInt(hex.slice(1), 16); let r = n >> 16, g = (n >> 8) & 255, b = n & 255;
    const t = amt < 0 ? 0 : 255, p = Math.abs(amt);
    r = Math.round((t - r) * p + r); g = Math.round((t - g) * p + g); b = Math.round((t - b) * p + b);
    return "#" + ((1 << 24) + (r << 16) + (g << 8) + b).toString(16).slice(1);
  }
  function regionColor(f) {
    const base = countryColor(f.country);
    if (f.level === "c") return base;
    const j = ((hash(f.key) % 1000) / 1000 - 0.5) * 0.28;
    return shade(base, j);
  }

  // ---------------------------------------------------------------- theme tokens
  const C = {};
  const dark = () => { const t = document.documentElement.dataset.theme; return t ? t === "dark" : matchMedia("(prefers-color-scheme: dark)").matches; };
  function readColors() {
    const cs = getComputedStyle(document.documentElement);
    for (const k of ["ocean", "ocean-2", "halo", "grat", "land", "land-line", "sub-line", "lit-line", "sel", "me", "fg", "muted", "bg"]) C[k] = cs.getPropertyValue("--" + k).trim();
    C.font = cs.getPropertyValue("--f-body").trim();
    dirty();
  }
  matchMedia("(prefers-color-scheme: dark)").addEventListener("change", readColors);

  // ---------------------------------------------------------------- geo state
  let countries = [], provinces = [], countryMesh = null, provMesh = null;
  const byKey = new Map();          // key -> feature
  const a1 = new Map();             // countryId -> {features, mesh} | Promise
  const cities = new Map();         // provinceId -> {features, mesh} | Promise
  let dataIndex = { a1: {}, cn: {} };

  function prepare(f, extra) {
    Object.assign(f, extra);
    if (d3.geoArea(f) > 2 * Math.PI) rewind(f);
    f.b = d3.geoBounds(f); f.c = d3.geoCentroid(f);
    const [[x0, y0], [x1, y1]] = f.b;
    f.r = Math.max(d3.geoDistance(f.c, [x0, y0]), d3.geoDistance(f.c, [x1, y1]), d3.geoDistance(f.c, [x0, y1]), d3.geoDistance(f.c, [x1, y0]));
    if (!isFinite(f.r) || f.r > Math.PI) f.r = Math.PI;
    f.area = d3.geoArea(f);
    byKey.set(f.key, f);
    return f;
  }
  function rewind(f) {
    // fix only the polygons that are wound inside-out (they would cover the whole globe)
    const g = f.geometry;
    const fix = (poly) => { if (d3.geoArea({ type: "Polygon", coordinates: poly }) > 2 * Math.PI) poly.forEach((r) => r.reverse()); };
    if (g.type === "Polygon") fix(g.coordinates);
    else if (g.type === "MultiPolygon") g.coordinates.forEach(fix);
  }
  async function getJSON(url) { const r = await fetch(url); if (!r.ok) throw new Error(url + " " + r.status); return r.json(); }

  function loadA1(id) {
    if (a1.has(id)) return a1.get(id);
    if (!dataIndex.a1[id]) { a1.set(id, null); return null; }
    const p = getJSON(`data/a1/${id}.json`).then((t) => {
      const country = byKey.get("C:" + id);
      const fs = topojson.feature(t, t.objects.r).features.map((f) => prepare(f, {
        level: "a", key: "A:" + f.id, country: id, name: f.properties.n || f.properties.e || "未命名地区", full: f.properties.n || f.properties.e || "未命名地区", en: f.properties.e, cname: country ? country.name : "",
      }));
      const v = { features: fs, mesh: topojson.mesh(t, t.objects.r, (a, b) => a !== b) };
      a1.set(id, v); dirty(); return v;
    }).catch((e) => { console.warn(e); a1.delete(id); return null; });
    a1.set(id, p); return p;
  }
  function loadCities(pid) {
    if (cities.has(pid)) return cities.get(pid);
    if (!dataIndex.cn[pid]) { cities.set(pid, null); return null; }
    const prov = byKey.get("P:" + pid);
    const p = getJSON(`data/cn/${pid}.json`).then((t) => {
      const fs = topojson.feature(t, t.objects.r).features.map((f) => prepare(f, {
        level: "y", key: "Y:" + f.id, country: CN, prov: pid, name: f.properties.n, full: f.properties.n, cname: "中国", pname: prov ? prov.name : "",
      }));
      const v = { features: fs, mesh: topojson.mesh(t, t.objects.r, (a, b) => a !== b) };
      cities.set(pid, v); dirty(); return v;
    }).catch((e) => { console.warn(e); cities.delete(pid); return null; });
    cities.set(pid, p); return p;
  }
  const ready = (m, id) => { const v = m.get(id); return v && !(v instanceof Promise) ? v : null; };

  // ---------------------------------------------------------------- moments store (IndexedDB)
  let idb = null, moments = [];
  const urlCache = new Map(); // blob -> objectURL
  function srcOf(p) {
    if (!p) return "";
    if (p.blob) { let u = urlCache.get(p.blob); if (!u) { u = URL.createObjectURL(p.blob); urlCache.set(p.blob, u); } return u; }
    return p.data || "";
  }
  function openDB() {
    return new Promise((res) => {
      try {
        const rq = indexedDB.open("traveldiary", 1);
        rq.onupgradeneeded = () => rq.result.createObjectStore("moments", { keyPath: "id" });
        rq.onsuccess = () => res(rq.result); rq.onerror = () => res(null); rq.onblocked = () => res(null);
      } catch { res(null); }
    });
  }
  function tx(mode, fn) {
    return new Promise((res, rej) => {
      const t = idb.transaction("moments", mode); const st = t.objectStore("moments"); const rq = fn(st);
      t.oncomplete = () => res(rq && rq.result); t.onerror = t.onabort = () => rej(t.error || new Error("存储失败"));
    });
  }
  async function loadMoments() {
    idb = await openDB();
    if (!idb) { moments = []; toast("这个浏览器不支持本地存储，记录无法保存。试试 Safari 或 Chrome。", 5000); return; }
    moments = (await tx("readonly", (s) => s.getAll())) || [];
  }
  async function putMoment(m) { await tx("readwrite", (s) => s.put(m)); }
  async function delMoment(id) { await tx("readwrite", (s) => s.delete(id)); }

  // ---------------------------------------------------------------- derived state
  const state = { year: "all", sheet: null, stack: [], pick: null, selected: null, hover: null, me: null };
  let lit = new Set(), litColorKey = new Map();
  function inYear(m) { return state.year === "all" || yearOf(m) === state.year; }
  function chainKeys(m) { return [m.keys.c, m.keys.a, m.keys.y].filter(Boolean); }
  function recompute() {
    lit = new Set();
    const shown = moments.filter(inYear);
    for (const m of shown) chainKeys(m).forEach((k) => lit.add(k));
    renderYears(); renderStats(shown);
    if (state.sheet) renderSheet();
    dirty();
  }
  function counts(list) {
    const c = new Set(), a = new Set(), y = new Set();
    for (const m of list) {
      c.add(m.keys.c);
      if (m.keys.a) a.add(m.keys.a);
      if (m.keys.y) y.add(m.keys.y);
      else if (m.place) y.add("T:" + m.place.name);
    }
    return { c: c.size, a: a.size, y: y.size, m: list.length };
  }
  function renderStats(list) {
    const n = counts(list);
    $("#stats").replaceChildren(
      h("span", null, h("b", null, n.c), "国家与地区"), h("span", null, h("b", null, n.a), "省 · 州"),
      h("span", null, h("b", null, n.y), "城市"), h("span", null, h("b", null, n.m), "瞬间"));
  }
  function yearsList() {
    const ys = new Set(moments.map(yearOf)); ys.add(new Date().getFullYear());
    return [...ys].sort((a, b) => b - a);
  }
  function coverFor(list) { const m = list.slice().sort((a, b) => (b.date || "").localeCompare(a.date || ""))[0]; return m && m.photos && m.photos[0]; }
  function renderYears() {
    const items = [{ y: "all", label: "此生" }, ...yearsList().map((y) => ({ y, label: String(y) }))];
    $("#years").replaceChildren(...items.map(({ y, label }) => {
      const list = y === "all" ? moments : moments.filter((m) => yearOf(m) === y);
      const cov = coverFor(list);
      const inner = cov ? h("img", { src: srcOf(cov), alt: "" }) : (y === "all" ? h("img", { src: "icons/icon-192.png", alt: "" }) : h("div", { class: "num" }, String(y).slice(2)));
      return h("button", { class: "yr" + (state.year === y ? " on" : ""), type: "button", "aria-pressed": state.year === y ? "true" : "false",
        onclick: () => { state.year = y; recompute(); if (state.sheet && state.sheet.type === "book") renderSheet(); } },
        h("div", { class: "ring" }, h("div", { class: "ring-in" }, inner)), h("small", null, label));
    }));
  }

  // ---------------------------------------------------------------- projection + drawing
  let W = 0, H = 0, dpr = 1, base = 1, k = 1, rot = [-104, -30, 0];
  const proj = d3.geoOrthographic().clipAngle(90).precision(0.35);
  const path = d3.geoPath(proj, ctx);
  const grat = d3.geoGraticule10();
  let raf = 0, pulse = null;
  const dirty = () => { if (!raf) raf = requestAnimationFrame(frame); };
  const level = () => (k >= K_CITY ? "y" : k >= K_A1 ? "a" : "c");
  const center = () => [-rot[0], -rot[1]];
  function viewAngle() { const r = base * k; const half = Math.hypot(W, H) / 2; return half >= r ? Math.PI / 2 : Math.asin(half / r); }
  function visible(f, cen, va) { return d3.geoDistance(f.c, cen) < Math.min(Math.PI / 2, va) + f.r; }

  function drawList() {
    // The finest set of features drawn at the current zoom, plus the meshes for inner borders.
    const L = level(), cen = center(), va = viewAngle();
    const feats = [], meshes = [];
    for (const f of countries) {
      if (!visible(f, cen, va)) continue;
      if (L === "c") { feats.push(f); continue; }
      if (f.id === CN || f.id === "344" || f.id === "446") continue;
      const v = ready(a1, f.id);
      if (v) { feats.push(...v.features); meshes.push(v.mesh); }
      else { feats.push(f); if (!a1.has(f.id)) loadA1(f.id); }
    }
    if (L !== "c") {
      const cnVis = byKey.get("C:" + CN) && visible(byKey.get("C:" + CN), cen, va);
      if (cnVis) {
        for (const p of provinces) {
          if (!visible(p, cen, va)) continue;
          if (L === "y") {
            const v = ready(cities, p.id);
            if (v) { feats.push(...v.features); meshes.push(v.mesh); continue; }
            if (!cities.has(p.id)) loadCities(p.id);
          }
          feats.push(p);
        }
        meshes.push(provMesh);
      }
    }
    return { feats, meshes, L, cen, va };
  }

  function frame(now) {
    raf = 0;
    if (pulse && now - pulse.t0 < 1600) dirty(); else pulse = null;
    if (state.me) dirty();
    draw(now);
  }

  function draw(now) {
    if (!countries.length) return;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, W, H);
    proj.translate([W / 2, H / 2 + yOffset()]).scale(base * k).rotate(rot);
    const r = base * k, [cx, cy] = proj.translate();
    const { feats, meshes, L, cen } = drawList();
    const isDark = dark();

    // ocean
    const g = ctx.createRadialGradient(cx - r * .35, cy - r * .4, r * .05, cx, cy, r);
    g.addColorStop(0, C.ocean); g.addColorStop(1, C["ocean-2"]);
    ctx.save(); ctx.shadowColor = C.halo; ctx.shadowBlur = 50;
    ctx.beginPath(); path({ type: "Sphere" }); ctx.fillStyle = g; ctx.fill(); ctx.restore();
    ctx.beginPath(); path(grat); ctx.strokeStyle = C.grat; ctx.lineWidth = .6; ctx.stroke();

    // land
    const groups = new Map();
    ctx.beginPath();
    for (const f of feats) {
      if (isLitF(f)) { const col = regionColor(f); if (!groups.has(col)) groups.set(col, []); groups.get(col).push(f); }
      else path(f);
    }
    ctx.fillStyle = C.land; ctx.fill();
    for (const [col, list] of groups) {
      ctx.save();
      if (isDark) { ctx.shadowColor = col; ctx.shadowBlur = 16; }
      ctx.beginPath(); for (const f of list) path(f);
      ctx.fillStyle = col; ctx.fill(); ctx.restore();
    }

    // borders
    if (meshes.length) { ctx.beginPath(); for (const m of meshes) path(m); ctx.strokeStyle = C["sub-line"]; ctx.lineWidth = .8; ctx.stroke(); }
    if (groups.size && L !== "c") {
      ctx.beginPath(); for (const list of groups.values()) for (const f of list) path(f);
      ctx.strokeStyle = C["lit-line"]; ctx.lineWidth = .8; ctx.stroke();
    }
    ctx.beginPath(); path(countryMesh); ctx.strokeStyle = C["land-line"]; ctx.lineWidth = L === "c" ? .6 : 1.1; ctx.stroke();

    // pulse when a place lights up
    if (pulse) {
      const t = (now - pulse.t0) / 1600;
      ctx.save(); ctx.globalAlpha = Math.max(0, 1 - t); ctx.shadowColor = pulse.col; ctx.shadowBlur = 50 * (1 - t) + 8;
      ctx.beginPath(); path(pulse.f); ctx.fillStyle = pulse.col; ctx.fill(); ctx.restore();
    }
    // hover / selection
    if (state.hover && state.hover !== state.selected) { ctx.beginPath(); path(state.hover); ctx.globalAlpha = .5; ctx.strokeStyle = C.sel; ctx.lineWidth = 1.2; ctx.stroke(); ctx.globalAlpha = 1; }
    if (state.selected) { ctx.beginPath(); path(state.selected); ctx.strokeStyle = C.sel; ctx.lineWidth = 2; ctx.stroke(); }

    // town pins (places that are finer than any outline, like Kota Kinabalu)
    if (L !== "c") drawPins(cen);
    if (state.me) drawMe(now, cen);
    if (L !== "c") drawLabels(feats, cen, L);
  }

  function drawPins(cen) {
    const seen = new Set();
    ctx.font = `600 11px ${C.font}`; ctx.textAlign = "left"; ctx.textBaseline = "middle";
    for (const m of moments) {
      if (!m.place || !inYear(m)) continue;
      const id = m.place.name + m.place.lon;
      if (seen.has(id)) continue; seen.add(id);
      const ll = [m.place.lon, m.place.lat];
      if (d3.geoDistance(ll, cen) > Math.PI / 2 - .02) continue;
      const p = proj(ll); if (!p) continue;
      const col = countryColor(m.keys.c.slice(2));
      ctx.beginPath(); ctx.arc(p[0], p[1], 7, 0, 7); ctx.fillStyle = col; ctx.globalAlpha = .25; ctx.fill(); ctx.globalAlpha = 1;
      ctx.beginPath(); ctx.arc(p[0], p[1], 3.6, 0, 7); ctx.fillStyle = col; ctx.fill(); ctx.lineWidth = 1.5; ctx.strokeStyle = C.bg; ctx.stroke();
      if (k > K_A1 + 1.5) { ctx.fillStyle = C.fg; ctx.fillText(m.place.name, p[0] + 9, p[1]); }
    }
  }
  function drawMe(now, cen) {
    const ll = [state.me.lon, state.me.lat];
    if (d3.geoDistance(ll, cen) > Math.PI / 2 - .02) return;
    const p = proj(ll); if (!p) return;
    const t = ((now || 0) % 2000) / 2000;
    ctx.beginPath(); ctx.arc(p[0], p[1], 6 + t * 16, 0, 7); ctx.fillStyle = C.me; ctx.globalAlpha = .35 * (1 - t); ctx.fill(); ctx.globalAlpha = 1;
    ctx.beginPath(); ctx.arc(p[0], p[1], 6, 0, 7); ctx.fillStyle = C.me; ctx.fill(); ctx.lineWidth = 2.5; ctx.strokeStyle = "#fff"; ctx.stroke();
  }
  function drawLabels(feats, cen, L) {
    const rects = [];
    const cand = feats.filter((f) => d3.geoDistance(f.c, cen) < 1.2)
      .map((f) => ({ f, on: isLitF(f), px: proj(f.c) }))
      .filter((o) => o.px)
      .sort((a, b) => (b.on - a.on) || (b.f.area - a.f.area));
    const fs = clamp(10 + (k - K_A1) * .35, 11, 14);
    ctx.textAlign = "center"; ctx.textBaseline = "middle";
    let n = 0;
    for (const { f, on, px } of cand) {
      if (n > 140) break;
      const name = shortName(f);
      const minPx = (Math.sqrt(f.area) * base * k);
      if (!on && minPx < name.length * fs * .9) continue;
      ctx.font = `${on ? 600 : 400} ${fs}px ${C.font}`;
      const w = ctx.measureText(name).width, x0 = px[0] - w / 2 - 3, y0 = px[1] - fs / 2 - 2, x1 = px[0] + w / 2 + 3, y1 = px[1] + fs / 2 + 2;
      if (rects.some((r) => !(x1 < r[0] || x0 > r[2] || y1 < r[1] || y0 > r[3]))) continue;
      rects.push([x0, y0, x1, y1]); n++;
      if (on) { ctx.lineWidth = 3; ctx.strokeStyle = "rgba(0,0,0,.18)"; ctx.strokeText(name, px[0], px[1]); ctx.fillStyle = "#fff"; }
      else ctx.fillStyle = C.muted;
      ctx.fillText(name, px[0], px[1]);
    }
  }
  function shortName(f) {
    if (f.level === "c") return f.name;
    let n = f.name || "";
    if (f.level === "a" && f.country !== CN) n = n.replace(/(特别自治道|特别自治市|广域市|特别市)$/, "");
    return n;
  }
  function isLitF(f) {
    if (f.level === "c" && (f.id === "344" || f.id === "446")) return lit.has("C:" + CN);
    return lit.has(f.key);
  }

  let sheetOffset = 0;
  function yOffset() { return -sheetOffset; }
  function resize() {
    const r = app.getBoundingClientRect();
    W = r.width; H = r.height; dpr = Math.min(window.devicePixelRatio || 1, 2);
    canvas.width = Math.round(W * dpr); canvas.height = Math.round(H * dpr);
    base = Math.min(W, H) * .40;
    updateOffset(); dirty();
  }
  function updateOffset() {
    // On phones the bottom sheet covers the lower half: lift the globe so the chosen place stays visible.
    const sh = $("#sheet");
    sheetOffset = (!sh.hidden && W <= 720) ? Math.min(H * .28, sh.getBoundingClientRect().height / 2) : 0;
    const shiftX = (!sh.hidden && W > 720) ? -Math.min(215, W * .2) : 0;
    proj.translate([W / 2 + shiftX, H / 2 - sheetOffset]);
    canvasShiftX = shiftX;
  }
  let canvasShiftX = 0;
  new ResizeObserver(resize).observe(app);


  // ---------------------------------------------------------------- interaction
  const sel = d3.select(canvas);
  let prevT = d3.zoomIdentity, programmatic = false, anim = null;
  const zoom = d3.zoom().scaleExtent([0.75, 60]).clickDistance(6)
    .on("start", (e) => { if (!e.sourceEvent) return; if (e.sourceEvent.type !== "wheel") canvas.classList.add("dragging"); stopAnim(); hideHint(); })
    .on("end", () => canvas.classList.remove("dragging"))
    .on("zoom", (e) => {
      const t = e.transform;
      if (!programmatic) {
        if (Math.abs(t.k - prevT.k) > 1e-6) k = t.k;
        else {
          const deg = 180 / (Math.PI * proj.scale());
          rot[0] += (t.x - prevT.x) * deg;
          rot[1] = clamp(rot[1] - (t.y - prevT.y) * deg, -89, 89);
        }
        updateDepth();
      }
      prevT = t; $("#tip").hidden = true; state.hover = null; dirty();
    });
  sel.call(zoom).on("dblclick.zoom", null);
  function syncZoom() { programmatic = true; sel.call(zoom.transform, d3.zoomIdentity.scale(k)); programmatic = false; }
  function stopAnim() { if (anim) { anim.stop(); anim = null; } }
  function flyTo(ll, targetK, dur = 1100) {
    stopAnim(); state.hover = null;
    const from = center(), k0 = k, ip = d3.geoInterpolate(from, ll);
    if (reduceMotion) dur = 0;
    const step = (t) => { const e = d3.easeCubicInOut(t); const p = ip(e); rot = [-p[0], -p[1], 0]; k = Math.exp(Math.log(k0) + (Math.log(targetK) - Math.log(k0)) * e); syncZoom(); updateDepth(); dirty(); };
    if (!dur) { step(1); return; }
    anim = d3.timer((el) => { const t = Math.min(1, el / dur); step(t); if (t >= 1) stopAnim(); });
  }
  function fitK(f) {
    const [[x0, y0], [x1, y1]] = f.b; let dx = x1 - x0; if (dx < 0) dx += 360;
    const span = Math.max(dx, (y1 - y0) * 1.15, .25);
    let kk = clamp(70 / span, 1, 40);
    if (f.level === "a") kk = clamp(kk, K_A1 + .4, K_CITY - .3);
    if (f.level === "y") kk = Math.max(kk, K_CITY + .5);
    if (f.level === "c") kk = Math.min(kk, K_A1 - .1);
    return kk;
  }
  function updateDepth() {
    const L = level();
    document.querySelectorAll("#depth i").forEach((i) => i.classList.toggle("on", i.dataset.l === L));
  }
  function hideHint() { const el = $("#hint"); if (el) el.remove(); }

  function inB(f, lon, lat) {
    const [[x0, y0], [x1, y1]] = f.b;
    if (lat < y0 - .02 || lat > y1 + .02) return false;
    return x0 <= x1 ? lon >= x0 - .02 && lon <= x1 + .02 : lon >= x0 - .02 || lon <= x1 + .02;
  }
  function hit(list, ll) {
    // several shapes can claim a point near the date line; the smallest one is the right answer
    let best = null;
    for (const f of list) if (inB(f, ll[0], ll[1]) && d3.geoContains(f, ll) && (!best || f.area < best.area)) best = f;
    return best;
  }
  function pickAt(px, py) {
    const ll = proj.invert([px, py]);
    if (!ll || isNaN(ll[0]) || d3.geoDistance(ll, center()) > Math.PI / 2 - .01) return null;
    const { feats } = drawList();
    return hit(feats, ll) || null;
  }

  let hq = null;
  canvas.addEventListener("pointermove", (e) => {
    if (e.pointerType !== "mouse" || e.buttons) return;
    hq = [e.offsetX, e.offsetY];
    requestAnimationFrame(() => {
      if (!hq) return; const [x, y] = hq; hq = null;
      const f = pickAt(x, y);
      if (f !== state.hover) { state.hover = f; dirty(); }
      canvas.classList.toggle("pointing", !!f);
      const tip = $("#tip");
      if (f) { tip.replaceChildren(fullName(f), h("small", null, isLitF(f) ? "已点亮" : "尚未点亮")); tip.style.left = x + "px"; tip.style.top = y + "px"; tip.hidden = false; }
      else tip.hidden = true;
    });
  });
  canvas.addEventListener("pointerleave", () => { state.hover = null; $("#tip").hidden = true; dirty(); });
  sel.on("click", (e) => {
    const [x, y] = d3.pointer(e, canvas);
    let f = pickAt(x, y);
    hideHint();
    if (!f) return;
    if (f.level === "c" && (f.id === "344" || f.id === "446")) f = byKey.get("C:" + CN);
    if (state.pick) { const cb = state.pick; endPick(); cb(chainOf(f)); return; }
    openPlace(f, true);
  });

  $("#zin").onclick = () => { stopAnim(); sel.transition().duration(reduceMotion ? 0 : 320).call(zoom.scaleBy, 1.8); };
  $("#zout").onclick = () => { stopAnim(); sel.transition().duration(reduceMotion ? 0 : 320).call(zoom.scaleBy, 1 / 1.8); };
  $("#btnLocate").onclick = () => locate((chain, me) => { openPlaceChain(chain); });
  $("#fab").onclick = () => openComposer(null);
  $("#btnBook").onclick = () => openSheet({ type: "book" }, true);
  $("#btnSearch").onclick = () => openSheet({ type: "search", mode: "go" }, true);
  $("#btnMore").onclick = () => openSheet({ type: "more" }, true);
  $("#pickCancel").onclick = () => { const back = state.pickReturn; endPick(); if (back) openSheet(back, false); };
  document.addEventListener("keydown", (e) => {
    if (e.key !== "Escape") return;
    if (!$("#lightbox").hidden) closeLightbox(); else if (state.pick) $("#pickCancel").click(); else if (state.sheet) closeSheet();
  });

  // ---------------------------------------------------------------- places & chains
  function fullName(f) {
    if (f.level === "y") return `${f.pname} · ${f.name}`;
    if (f.level === "a") return f.country === CN ? f.full : `${f.cname} · ${f.name}`;
    return f.name;
  }
  function chainOf(f) {
    if (f.level === "c") return { c: f };
    if (f.level === "a") return { c: byKey.get("C:" + f.country), a: f };
    return { c: byKey.get("C:" + CN), a: byKey.get("P:" + f.prov), y: f };
  }
  const finest = (ch) => ch.y || ch.a || ch.c;
  function chainName(ch) { return ch.place ? ch.place.name : finest(ch).name; }
  function chainCrumbs(ch) {
    const parts = [ch.c && ch.c.name, ch.a && ch.a.name, ch.y && ch.y.name, ch.place && ch.place.name].filter(Boolean);
    return [...new Set(parts)];
  }

  async function resolvePoint(lon, lat) {
    const ll = [lon, lat];
    // small islands can fall between simplified outlines: then take the closest shore within ~70 km
    let c = hit(countries, ll) || nearest(countries, ll);
    if (!c) return null;
    if (c.id === "344" || c.id === "446" || c.id === CN) {
      c = byKey.get("C:" + CN);
      const p = hit(provinces, ll) || nearest(provinces, ll, .02);
      if (!p) return { c };
      const cv = await loadCities(p.id);
      const y = cv ? (hit(cv.features, ll) || nearest(cv.features, ll, .02)) : null;
      return y ? { c, a: p, y } : { c, a: p };
    }
    const v = await loadA1(c.id);
    const a = v ? (hit(v.features, ll) || nearest(v.features, ll, .03)) : null;
    return a ? { c, a } : { c };
  }
  function nearest(list, ll, maxRad = .011) {
    const pad = maxRad * 57.3 + .2;
    let best = null, bd = maxRad;
    for (const f of list) {
      const [[x0, y0], [x1, y1]] = f.b;
      if (ll[1] < y0 - pad || ll[1] > y1 + pad) continue;
      if (x0 <= x1 && (ll[0] < x0 - pad || ll[0] > x1 + pad)) continue;
      const g = f.geometry, polys = g.type === "Polygon" ? [g.coordinates] : g.coordinates;
      for (const poly of polys) for (const pt of poly[0]) { const d = d3.geoDistance(pt, ll); if (d < bd) { bd = d; best = f; } }
    }
    return best;
  }
  async function featureForKey(key, m) {
    if (byKey.has(key)) return byKey.get(key);
    if (key.startsWith("A:") && m) await loadA1(m.keys.c.slice(2));
    if (key.startsWith("Y:")) await loadCities(key.slice(2, 4) + "0000");
    return byKey.get(key) || null;
  }

  // ---------------------------------------------------------------- geolocation
  function locate(done) {
    const btn = $("#btnLocate");
    if (!("geolocation" in navigator)) { toast("这个浏览器不支持定位，可以搜索地点。"); return; }
    btn.classList.add("busy"); toast("正在寻找你…", 8000);
    navigator.geolocation.getCurrentPosition(async (pos) => {
      btn.classList.remove("busy");
      const lon = pos.coords.longitude, lat = pos.coords.latitude;
      state.me = { lon, lat };
      const chain = await resolvePoint(lon, lat);
      if (!chain) { toast("你似乎在海上，这里没有可以点亮的陆地。"); flyTo([lon, lat], 3); return; }
      $("#toast").hidden = true;
      done(chain, { lon, lat });
    }, (err) => {
      btn.classList.remove("busy");
      const msg = err.code === 1 ? "没有拿到定位权限。可以在系统设置里允许浏览器定位，或者直接搜索地点。"
        : err.code === 3 ? "定位超时了。请确认手机定位已打开，或者直接搜索地点。"
        : "暂时定位不到你。可以直接搜索地点，或在地图上点选。";
      toast(msg, 5000);
    }, { enableHighAccuracy: false, timeout: 15000, maximumAge: 5 * 60 * 1000 });
  }

  // ---------------------------------------------------------------- search
  let places = null, placesP = null;
  function loadPlaces() {
    if (places) return Promise.resolve(places);
    if (!placesP) placesP = getJSON("data/places.json").then((p) => (places = p)).catch(() => { placesP = null; return []; });
    return placesP;
  }
  const TYPE_RANK = { c: 0, p: 1, y: 2, a: 3, t: 4 };
  const TYPE_LABEL = { c: "国家与地区", p: "中国 · 省级", y: "中国 · 城市", a: "省 · 州", t: "城市 · 小镇" };
  function search(q) {
    q = q.trim().toLowerCase(); if (!q) return [];
    const out = [];
    for (const r of places) {
      const zh = (r[0] || "").toLowerCase(), en = (r[1] || "").toLowerCase();
      let s = -1;
      if (zh === q || en === q) s = 0;
      else if (zh.startsWith(q) || en.startsWith(q)) s = 1;
      else if (zh.includes(q) || (q.length > 2 && en.includes(q))) s = 2;
      if (s < 0) continue;
      const tr = TYPE_RANK[r[4]] ?? 5;
      const extra = r[4] === "t" ? (r[6] || 10) / 20 : 0;
      out.push({ r, score: s * 10 + tr + extra });
    }
    out.sort((a, b) => a.score - b.score);
    const seen = new Set(), res = [];
    for (const o of out) { const key = o.r[0] + Math.round(o.r[2]) + Math.round(o.r[3]); if (seen.has(key)) continue; seen.add(key); res.push(o.r); if (res.length >= 40) break; }
    return res;
  }
  function countryNameAt(lon, lat) { const c = hit(countries, [lon, lat]); return c ? (c.id === "344" || c.id === "446" ? "中国" : c.name) : ""; }
  async function chainFromResult(r) {
    const [zh, en, lon, lat, type] = r;
    if (type === "c") { const c = byKey.get("C:" + r[5]); return c ? { c } : null; }
    if (type === "p") { const p = byKey.get(r[6]); return p ? { c: byKey.get("C:" + CN), a: p } : null; }
    if (type === "y") { const pid = r[6].slice(2, 4) + "0000"; await loadCities(pid); const y = byKey.get(r[6]); if (y) return chainOf(y); }
    const ch = await resolvePoint(lon, lat);
    if (!ch) return null;
    if (type === "t") ch.place = { name: zh, lon, lat };
    return ch;
  }

  // ---------------------------------------------------------------- sheet
  function openSheet(view, fresh) {
    if (fresh) state.stack = [];
    else if (state.sheet && state.sheet !== view) state.stack.push(state.sheet);
    state.sheet = view;
    const sh = $("#sheet"); sh.hidden = false;
    renderSheet();
    updateOffset(); dirty();
  }
  function back() {
    const prev = state.stack.pop();
    if (prev) { state.sheet = prev; renderSheet(); } else closeSheet();
  }
  function closeSheet() {
    state.sheet = null; state.stack = []; state.selected = null;
    $("#sheet").hidden = true; updateOffset(); dirty();
  }
  function head(title, opts = {}) {
    const left = state.stack.length ? h("button", { class: "ib", type: "button", "aria-label": "返回", onclick: back }, svg(ICON.back)) : h("span");
    return h("div", null, h("div", { class: "grab" }),
      h("div", { class: "sh-head" }, left, h("h3", null, title), h("button", { class: "ib", type: "button", "aria-label": "关闭", onclick: closeSheet }, svg(ICON.close))));
  }
  function renderSheet() {
    const sh = $("#sheet"), v = state.sheet; if (!v) return;
    const body = sh.querySelector(".sh-body"); const keep = sh.dataset.v === viewId(v) && body ? body.scrollTop : 0;
    let parts;
    if (v.type === "place") parts = placeView(v);
    else if (v.type === "compose") parts = composeView(v);
    else if (v.type === "book") parts = bookView(v);
    else if (v.type === "search") parts = searchView(v);
    else if (v.type === "post") parts = postView(v);
    else parts = moreView(v);
    sh.classList.toggle("short", v.type === "more");
    sh.replaceChildren(...parts);
    sh.dataset.v = viewId(v);
    const nb = sh.querySelector(".sh-body"); if (nb && keep) nb.scrollTop = keep;
  }
  const viewId = (v) => v.type + ":" + (v.key || v.id || "");

  // ----- place
  function openPlace(f, fly) {
    state.selected = f;
    openSheet({ type: "place", key: f.key, chain: chainOf(f) }, true);
    if (fly) flyTo(f.c, Math.max(Math.min(k, K_CITY + 6), fitK(f) * (f.level === "c" ? .9 : 1)), 900);
  }
  function openPlaceChain(ch) {
    const f = finest(ch);
    state.selected = f;
    openSheet({ type: "place", key: f.key, chain: ch }, true);
    flyTo(ch.place ? [ch.place.lon, ch.place.lat] : f.c, ch.place ? Math.max(fitK(f), K_A1 + 2) : fitK(f), 1000);
  }
  function placeView(v) {
    const ch = v.chain, f = finest(ch);
    const list = momentsFor(v.key, ch.place).sort((a, b) => (b.date || "").localeCompare(a.date || "") || b.createdAt - a.createdAt);
    const on = list.length > 0;
    const col = countryColor(ch.c.id);
    const crumbs = chainCrumbs(ch); crumbs.pop();
    const title = ch.place ? ch.place.name : (f.level === "a" && f.country === CN ? f.full : f.name);
    const hero = h("div", { class: "place-hero" },
      crumbs.length ? h("div", { class: "crumbs" }, crumbs.join(" · ")) : h("div", { class: "crumbs" }, f.level === "c" ? "国家与地区" : ""),
      h("h2", null, title),
      h("div", { class: "coord" }, fmtCoord(ch.place ? [ch.place.lon, ch.place.lat] : f.c)),
      h("span", { class: "lit-pill" + (on ? " on" : ""), style: `--c:${col}` }, h("i"), on ? `已点亮 · ${list.length} 个瞬间` : "尚未点亮"));
    const body = h("div", { class: "sh-body" }, hero);
    const pad = h("div", { class: "pad" });
    if (!on) pad.append(h("p", { class: "lead" }, "这里还在等你。留下一张照片、一句话，它就会亮起来。"));
    pad.append(h("button", { class: "btn-ig", type: "button", onclick: () => openComposer(ch) }, on ? "再留一个瞬间" : "点亮此地"));
    // finer places inside this one
    const subs = subPlaces(ch);
    if (subs) pad.append(subs);
    body.append(pad);
    list.forEach((m) => body.append(postCard(m)));
    return [head(title), body];
  }
  function momentsFor(key, place) {
    return moments.filter((m) => {
      if (place) return m.place && m.place.name === place.name && Math.abs(m.place.lon - place.lon) < 1e-3;
      return chainKeys(m).includes(key);
    });
  }
  function subPlaces(ch) {
    const f = finest(ch); if (ch.place) return null;
    let note = null, kids = [];
    if (f.level === "c" && f.id === CN) note = "放大地图，中国会按省、再按城市分开点亮。";
    else if (f.level === "c" && dataIndex.a1[f.id]) note = "放大地图，可以按省 · 州点亮。";
    else if (f.level === "a" && f.country === CN && dataIndex.cn[f.id]) note = "继续放大，可以精确到城市。";
    // lit children
    const seen = new Map();
    for (const m of moments) {
      if (!chainKeys(m).includes(f.key)) continue;
      const kid = f.level === "c" ? (m.keys.a ? [m.keys.a, m.names.a] : null) : f.level === "a" ? (m.keys.y ? [m.keys.y, m.names.y] : m.place ? ["T:" + m.place.name, m.place.name] : null) : (m.place ? ["T:" + m.place.name, m.place.name] : null);
      if (kid && !seen.has(kid[0])) seen.set(kid[0], { key: kid[0], name: kid[1], m });
    }
    kids = [...seen.values()];
    if (!note && !kids.length) return null;
    const box = h("div", { style: "display:grid;gap:10px" });
    if (note) box.append(h("p", { class: "note" }, note));
    if (kids.length) box.append(h("div", { class: "subs" }, kids.map((x) => h("button", { class: "sub", type: "button", style: `--c:${countryColor(x.m.keys.c.slice(2))}`, onclick: async () => {
      if (x.key.startsWith("T:")) { const ch2 = await chainFromMoment(x.m); openPlaceChain(ch2); return; }
      const ff = await featureForKey(x.key, x.m); if (ff) openPlace(ff, true);
    } }, h("i"), x.name))));
    return box;
  }
  async function chainFromMoment(m) {
    const ch = {};
    ch.c = await featureForKey(m.keys.c, m);
    if (m.keys.a) ch.a = await featureForKey(m.keys.a, m);
    if (m.keys.y) ch.y = await featureForKey(m.keys.y, m);
    if (m.place) ch.place = m.place;
    return ch;
  }

  // ----- post card
  function postCard(m, opts = {}) {
    const col = countryColor(m.keys.c.slice(2));
    const name = m.place ? m.place.name : (m.names.y || m.names.a || m.names.c);
    const crumbs = [m.names.c, m.names.a, m.names.y, m.place && m.place.name].filter(Boolean);
    const photos = m.photos || [];
    const del = h("button", { class: "link", type: "button" }, "删除");
    let armed = false;
    del.onclick = async () => {
      if (!armed) { armed = true; del.textContent = "再点一次删除"; del.classList.add("danger"); setTimeout(() => { if (!del.disabled) { armed = false; del.textContent = "删除"; del.classList.remove("danger"); } }, 3500); return; }
      del.disabled = true;
      try { await delMoment(m.id); moments = moments.filter((x) => x.id !== m.id); toast("这个瞬间已删除"); if (state.sheet && state.sheet.type === "post") back(); recompute(); }
      catch (e) { del.disabled = false; toast("没删掉，再试一次"); }
    };
    const count = h("span", { class: "car-count" }, `1/${photos.length}`);
    const dots = h("div", { class: "dots" }, photos.length > 1 ? photos.slice(0, 12).map((_, i) => h("i", { class: i === 0 ? "on" : "" })) : null);
    const track = h("div", { class: "car-track" }, photos.map((p, i) => h("button", { type: "button", "aria-label": `查看第 ${i + 1} 张`, onclick: () => openLightbox(photos, i) }, h("img", { src: srcOf(p), alt: "", loading: "lazy", decoding: "async" }))));
    track.addEventListener("scroll", () => {
      const i = Math.round(track.scrollLeft / track.clientWidth);
      count.textContent = `${i + 1}/${photos.length}`;
      dots.querySelectorAll("i").forEach((d, j) => d.classList.toggle("on", j === Math.min(i, 11)));
    }, { passive: true });
    return h("article", { class: "post" },
      h("div", { class: "post-h" },
        h("div", { class: "av" }, h("span", { style: `--c:${col}` }, name.slice(0, 1))),
        h("div", { class: "who" }, h("b", null, name), h("small", null, crumbs.join(" · "))), del),
      photos.length ? h("div", { class: "car" }, track, photos.length > 1 ? count : null) : null,
      photos.length > 1 ? dots : null,
      h("div", { class: "post-b" },
        m.note ? h("p", { class: "cap" }, m.note) : null,
        h("div", { class: "when" }, h("span", null, fmtDate(m.date)))));
  }
  function postView(v) {
    const m = moments.find((x) => x.id === v.id);
    if (!m) return [head("瞬间"), h("div", { class: "sh-body" }, h("div", { class: "blank" }, "这个瞬间已经不在了。"))];
    const goto = h("div", { class: "pad" }, h("button", { class: "btn-line", type: "button", onclick: async () => { const ch = await chainFromMoment(m); openPlaceChain(ch); } }, "在地球上看看这里"));
    return [head(m.place ? m.place.name : (m.names.y || m.names.a || m.names.c)), h("div", { class: "sh-body" }, postCard(m), goto)];
  }

  // ----- composer
  const draft = { chain: null, note: "", date: today(), files: [] };
  function openComposer(ch) {
    if (ch) draft.chain = ch;
    else if (!draft.chain) draft.chain = null;
    openSheet({ type: "compose" }, !ch);
  }
  function composeView() {
    const ch = draft.chain;
    const body = h("div", { class: "sh-body compose" });
    // location
    const locBox = h("div", { class: "loc" }, svg(ICON.pin),
      h("div", { class: "what" }, ch ? [h("b", null, chainName(ch)), h("small", null, chainCrumbs(ch).slice(0, -1).join(" · ") || "国家与地区")] : [h("b", null, "这一刻在哪里？"), h("small", null, "定位、搜索，或在地图上选一处")]));
    const opts = h("div", { class: "loc-opts" },
      h("button", { class: "btn-line", type: "button", onclick: () => locate((c2) => { draft.chain = c2; renderSheet(); flyTo(c2.place ? [c2.place.lon, c2.place.lat] : finest(c2).c, fitK(finest(c2))); }) }, "此刻所在"),
      h("button", { class: "btn-line", type: "button", onclick: () => openSheet({ type: "search", mode: "pick" }, false) }, "搜索地点"),
      h("button", { class: "btn-line", type: "button", onclick: () => startPick((c2) => { draft.chain = c2; openSheet({ type: "compose" }, true); }) }, "在地图上选"));
    const ta = h("textarea", { id: "note", "aria-label": "这一刻的文字", placeholder: "此刻的光线、风，和你。", maxlength: "5000" });
    ta.value = draft.note;
    const grid = h("div", { class: "ph-grid" });
    const fileIn = h("input", { type: "file", accept: "image/*", multiple: true, class: "sr", id: "photos" });
    const dateIn = h("input", { type: "date", id: "date", value: draft.date, max: today() });
    const need = h("div", { class: "need" });
    const err = h("p", { class: "err", hidden: true });
    const go = h("button", { class: "btn-ig", type: "button" });

    function validate() {
      const lack = [];
      if (!draft.chain) lack.push("一个地点");
      if (!draft.files.length) lack.push("一张照片");
      if (!draft.note.trim()) lack.push("一句话");
      need.textContent = lack.length ? "还差" + lack.join("、") : `${draft.files.length} 张照片 · 准备好了`;
      go.disabled = lack.length > 0;
      const already = draft.chain && momentsFor(finest(draft.chain).key, draft.chain.place).length;
      go.textContent = already ? "留下这个瞬间" : "点亮";
    }
    function drawGrid() {
      grid.replaceChildren(
        ...draft.files.map((x, i) => h("div", { class: "ph" }, h("img", { src: x.url, alt: "" }),
          i === 0 ? h("span", { class: "first" }, "封面") : null,
          h("button", { class: "x", type: "button", "aria-label": "移除", onclick: () => { URL.revokeObjectURL(x.url); draft.files.splice(i, 1); drawGrid(); validate(); } }, "×"))),
        ...(draft.files.length < MAX_PHOTOS ? [h("label", { class: "add", for: "photos" }, h("div", null, h("b", null, "+"), draft.files.length ? "继续添加" : "添加照片"))] : []));
    }
    fileIn.onchange = () => {
      for (const file of fileIn.files) {
        if (draft.files.length >= MAX_PHOTOS) { toast(`一个瞬间最多 ${MAX_PHOTOS} 张照片`); break; }
        if (file.type && !file.type.startsWith("image/")) continue;
        draft.files.push({ file, url: URL.createObjectURL(file) });
      }
      fileIn.value = ""; drawGrid(); validate();
    };
    ta.oninput = () => { draft.note = ta.value; validate(); };
    dateIn.onchange = () => { draft.date = dateIn.value || today(); };
    go.onclick = async () => {
      if (go.disabled) return;
      err.hidden = true; go.disabled = true;
      try {
        const m = await saveMoment((s) => (go.textContent = s));
        const ch2 = draft.chain, f = finest(ch2), wasLit = lit.has(f.key);
        draft.files.forEach((x) => URL.revokeObjectURL(x.url));
        draft.note = ""; draft.files = []; draft.date = today(); draft.chain = null;
        if (state.year !== "all" && yearOf(m) !== state.year) state.year = "all";
        recompute();
        pulse = { f, col: regionColor(f), t0: performance.now() };
        toast(wasLit ? `又一个瞬间，留在了${chainName(ch2)}。` : `${chainName(ch2)}，亮了。`);
        state.selected = f;
        openSheet({ type: "place", key: f.key, chain: ch2 }, true);
        flyTo(ch2.place ? [ch2.place.lon, ch2.place.lat] : f.c, fitK(f), 900);
      } catch (e) {
        console.error(e);
        err.textContent = "没能保存：" + (e.message || "请再试一次") + (/decode|load|image/i.test(String(e.message)) ? "。如果是 HEIC 照片，请换成 JPG 再试。" : "");
        err.hidden = false; validate();
      }
    };

    body.append(locBox, opts, ta, grid, fileIn,
      h("label", { class: "meta-row", for: "date" }, h("span", null, "日期"), dateIn),
      h("div", { class: "send" }, err, go, need));
    drawGrid(); validate();
    return [head("新的瞬间"), body];
  }
  async function compress(file, maxSide = 2048, q = .86) {
    let src;
    try { src = await createImageBitmap(file, { imageOrientation: "from-image" }); }
    catch {
      const url = URL.createObjectURL(file);
      try { src = await new Promise((res, rej) => { const i = new Image(); i.onload = () => res(i); i.onerror = () => rej(new Error("无法读取图片")); i.src = url; }); }
      finally { setTimeout(() => URL.revokeObjectURL(url), 1000); }
    }
    const w0 = src.width || src.naturalWidth, h0 = src.height || src.naturalHeight;
    const s = Math.min(1, maxSide / Math.max(w0, h0));
    const w = Math.round(w0 * s), hh = Math.round(h0 * s);
    const cv = document.createElement("canvas"); cv.width = w; cv.height = hh;
    cv.getContext("2d").drawImage(src, 0, 0, w, hh);
    if (src.close) src.close();
    const blob = await new Promise((res) => cv.toBlob(res, "image/jpeg", q));
    if (!blob) throw new Error("无法压缩图片");
    return { blob, w, h: hh };
  }
  async function saveMoment(progress) {
    if (!idb) throw new Error("这个浏览器无法保存记录");
    const ch = draft.chain, photos = [];
    for (let i = 0; i < draft.files.length; i++) {
      progress(`整理照片 ${i + 1}/${draft.files.length}`);
      photos.push(await compress(draft.files[i].file));
    }
    progress("正在保存…");
    const m = {
      id: "m" + Date.now().toString(36) + Math.random().toString(36).slice(2, 6),
      keys: { c: ch.c.key, a: ch.a ? ch.a.key : null, y: ch.y ? ch.y.key : null },
      names: { c: ch.c.name, a: ch.a ? (ch.a.country === CN ? ch.a.name : ch.a.name) : null, y: ch.y ? ch.y.name : null },
      place: ch.place || null,
      date: draft.date || today(), note: draft.note.trim(), photos, createdAt: Date.now(),
    };
    try { await putMoment(m); }
    catch (e) { throw new Error(/quota/i.test(String(e && e.name)) ? "手机存储空间不够了" : "存储失败"); }
    moments.push(m);
    if (navigator.storage && navigator.storage.persist) navigator.storage.persist().catch(() => {});
    return m;
  }

  // ----- pick on map
  function startPick(cb) {
    state.pickReturn = state.sheet;
    state.pick = cb; $("#pickbar").hidden = false; canvas.classList.add("picking");
    $("#sheet").hidden = true; updateOffset(); dirty();
  }
  function endPick() { state.pick = null; $("#pickbar").hidden = true; canvas.classList.remove("picking"); }

  // ----- yearbook
  function bookView() {
    const list = moments.filter(inYear).sort((a, b) => (b.date || "").localeCompare(a.date || "") || b.createdAt - a.createdAt);
    const n = counts(list);
    const isAll = state.year === "all";
    const title = isAll ? "此生足迹" : `${state.year} · 年度图鉴`;
    const cov = coverFor(list);
    const countriesLit = [...new Map(list.map((m) => [m.keys.c, m])).values()];
    const prof = h("div", { class: "prof" },
      h("div", { class: "prof-top" },
        h("div", { class: "prof-av" }, h("img", { src: cov ? srcOf(cov) : "icons/icon-192.png", alt: "" })),
        h("div", { class: "prof-nums" },
          h("div", null, h("b", null, n.c), h("small", null, "国家与地区")), h("div", null, h("b", null, n.a), h("small", null, "省 · 州")),
          h("div", null, h("b", null, n.y), h("small", null, "城市")), h("div", null, h("b", null, n.m), h("small", null, "瞬间")))),
      h("div", null, h("h2", null, title),
        h("p", null, list.length ? (isAll ? `从第一个瞬间到现在，你一共点亮了 ${n.c} 个国家与地区、${n.y} 座城市。` : `这一年，你把光留在了 ${n.c} 个国家与地区、${n.y} 座城市。`) : "这一页还空着。")),
      countriesLit.length ? h("div", { class: "tags" }, countriesLit.map((m) => h("button", { class: "tag", type: "button", style: `--c:${countryColor(m.keys.c.slice(2))}`, onclick: async () => { const c = await featureForKey(m.keys.c, m); if (c) openPlace(c, true); } }, h("i"), m.names.c))) : null,
      h("div", { class: "years", style: "padding:4px 0" }, [{ y: "all", label: "此生" }, ...yearsList().map((y) => ({ y, label: String(y) }))].map(({ y, label }) =>
        h("button", { class: "tag", type: "button", style: state.year === y ? "background:var(--fg);color:var(--bg)" : "", onclick: () => { state.year = y; recompute(); } }, label))));
    const grid = list.length ? h("div", { class: "grid3" }, list.map((m) => {
      const p = m.photos && m.photos[0];
      return h("button", { class: "cell", type: "button", "aria-label": m.place ? m.place.name : (m.names.y || m.names.a || m.names.c), onclick: () => openSheet({ type: "post", id: m.id }, false) },
        p ? h("img", { src: srcOf(p), alt: "", loading: "lazy" }) : null,
        m.photos.length > 1 ? h("span", { class: "stack" }, "▣ " + m.photos.length) : null,
        h("span", { class: "nm" }, m.place ? m.place.name : (m.names.y || m.names.a || m.names.c)));
    })) : h("div", { class: "blank" }, h("b", null, isAll ? "the world is waiting" : "a quiet year"), isAll ? "去过的地方，轻点一下，留下一张照片和一句话。" : "这一年还没有被点亮的地方。");
    return [head(title), h("div", { class: "sh-body" }, prof, grid)];
  }

  // ----- search
  function searchView(v) {
    const input = h("input", { type: "search", id: "q", placeholder: "搜索城市、岛屿、国家…", autocomplete: "off", enterkeyhint: "search", value: v.q || "" });
    const res = h("div", { class: "res" });
    const run = async () => {
      v.q = input.value;
      if (!places) { res.replaceChildren(h("div", { class: "blank" }, "正在展开地名册…")); await loadPlaces(); }
      const out = search(input.value);
      if (!input.value.trim()) { res.replaceChildren(h("div", { class: "blank" }, "试试「济州」「亚庇」「温州」「Kyoto」")); return; }
      if (!out.length) { res.replaceChildren(h("div", { class: "blank" }, `没有找到「${input.value.trim()}」。试试英文名，或者在地图上直接点选。`)); return; }
      res.replaceChildren(...out.map((r) => {
        const sub = r[4] === "c" ? TYPE_LABEL.c : `${countryNameAt(r[2], r[3]) || ""}${r[4] === "y" || r[4] === "p" ? "" : ""} · ${TYPE_LABEL[r[4]]}`.replace(/^ · /, "");
        const ico = r[4] === "c" ? ICON.globe : r[4] === "a" || r[4] === "p" ? ICON.map : r[4] === "y" ? ICON.city : ICON.pin;
        return h("button", { type: "button", onclick: async () => {
          const ch = await chainFromResult(r);
          if (!ch) { toast("这里暂时无法定位到地图上"); return; }
          if (v.mode === "pick") { draft.chain = ch; back(); flyTo(ch.place ? [ch.place.lon, ch.place.lat] : finest(ch).c, fitK(finest(ch))); }
          else openPlaceChain(ch);
        } }, h("span", { class: "ico" }, svg(ico)), h("span", null, h("b", null, r[0]), h("small", null, [sub, r[1] && r[1] !== r[0] ? r[1] : ""].filter(Boolean).join(" · "))));
      }));
    };
    let t = 0; input.addEventListener("input", () => { clearTimeout(t); t = setTimeout(run, 120); });
    setTimeout(() => { input.focus(); run(); }, 60);
    return [head(v.mode === "pick" ? "选择地点" : "搜索"), h("div", { class: "search" }, input), h("div", { class: "sh-body" }, res)];
  }

  // ----- backup & settings
  function moreView() {
    const fileIn = h("input", { type: "file", accept: "application/json,.json", class: "sr", id: "restore" });
    const status = h("p", { class: "note" });
    const exportBtn = h("button", { class: "btn-line", type: "button" }, "导出备份");
    exportBtn.onclick = async () => {
      exportBtn.disabled = true; status.textContent = "正在打包…";
      try {
        const out = [];
        for (const m of moments) {
          const photos = [];
          for (const p of m.photos) photos.push({ w: p.w, h: p.h, data: p.blob ? await blobToData(p.blob) : p.data });
          out.push({ ...m, photos });
        }
        const blob = new Blob([JSON.stringify({ app: "traveldiary", v: 1, exportedAt: new Date().toISOString(), moments: out })], { type: "application/json" });
        const a = h("a", { href: URL.createObjectURL(blob), download: `TravelDiary-备份-${today()}.json` });
        document.body.append(a); a.click(); setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 4000);
        status.textContent = `已导出 ${moments.length} 个瞬间（${(blob.size / 1048576).toFixed(1)} MB）。存到网盘或电脑里最安心。`;
      } catch (e) { status.textContent = "导出失败：" + e.message; }
      exportBtn.disabled = false;
    };
    fileIn.onchange = async () => {
      const f = fileIn.files[0]; fileIn.value = ""; if (!f) return;
      status.textContent = "正在恢复…";
      try {
        const j = JSON.parse(await f.text());
        if (j.app !== "traveldiary" || !Array.isArray(j.moments)) throw new Error("这不是 TravelDiary 的备份文件");
        let added = 0; const have = new Set(moments.map((m) => m.id));
        for (const m of j.moments) {
          if (have.has(m.id)) continue;
          const photos = [];
          for (const p of m.photos || []) photos.push({ w: p.w, h: p.h, blob: await (await fetch(p.data)).blob() });
          const mm = { ...m, photos }; await putMoment(mm); moments.push(mm); added++;
        }
        recompute(); status.textContent = `恢复了 ${added} 个瞬间。`;
      } catch (e) { status.textContent = "恢复失败：" + e.message; }
    };
    const standalone = matchMedia("(display-mode: standalone)").matches || navigator.standalone;
    return [head("备份与设置"), h("div", { class: "sh-body" }, h("div", { class: "pad" },
      h("div", { class: "card" }, h("h4", null, "备份与恢复"),
        h("p", { class: "note" }, "所有照片和文字只保存在这台设备的这个浏览器里，不会上传到任何服务器。定期导出一份备份，换手机或清理浏览器后也能找回。"),
        h("div", { class: "row-btns" }, exportBtn, h("label", { class: "btn-line", for: "restore", style: "display:inline-block" }, "从备份恢复"), fileIn), status),
      h("div", { class: "card" }, h("h4", null, standalone ? "已添加到主屏幕" : "添加到主屏幕"),
        h("p", { class: "note" }, "iPhone：用 Safari 打开这个网址，点底部的分享按钮，选「添加到主屏幕」。", h("br"), "安卓：在浏览器菜单里选「添加到主屏幕」或「安装应用」。", h("br"), "注意：主屏幕上的 TravelDiary 和浏览器里的各自保存记录，建议固定在一个地方使用。")),
      h("p", { class: "note", style: "text-align:center" }, "TravelDiary · 旅行日记 — 走过的地方，会替你发光。")))];
  }
  const blobToData = (b) => new Promise((res, rej) => { const r = new FileReader(); r.onload = () => res(r.result); r.onerror = rej; r.readAsDataURL(b); });

  // ----- lightbox
  function openLightbox(photos, i) {
    const box = $("#lightbox");
    const n = h("div", { class: "lb-n" }, `${i + 1} / ${photos.length}`);
    const track = h("div", { class: "lb-track" }, photos.map((p) => h("div", null, h("img", { src: srcOf(p), alt: "" }))));
    track.addEventListener("scroll", () => { n.textContent = `${Math.round(track.scrollLeft / track.clientWidth) + 1} / ${photos.length}`; }, { passive: true });
    box.replaceChildren(track, n, h("button", { class: "lb-x", type: "button", "aria-label": "关闭", onclick: closeLightbox }, "×"));
    box.hidden = false;
    requestAnimationFrame(() => { track.scrollLeft = i * track.clientWidth; });
  }
  function closeLightbox() { $("#lightbox").hidden = true; $("#lightbox").replaceChildren(); }

  // ---------------------------------------------------------------- boot
  async function boot() {
    readColors();
    let world;
    try { [world, dataIndex] = await Promise.all([getJSON("data/world.json"), getJSON("data/index.json")]); }
    catch (e) { $("#loading").textContent = "地图没有加载出来，请检查网络后刷新。"; return; }
    countries = topojson.feature(world.world, world.world.objects.countries).features.map((f) =>
      prepare(f, { level: "c", key: "C:" + f.id, id: String(f.id), country: String(f.id), name: f.properties.name, en: f.properties.en }));
    provinces = topojson.feature(world.prov, world.prov.objects.p).features.map((f) =>
      prepare(f, { level: "a", key: "P:" + String(f.id).replace("CN-", ""), id: String(f.id).replace("CN-", ""), country: CN, name: f.properties.name, full: f.properties.full, cname: "中国" }));
    countryMesh = topojson.mesh(world.world, world.world.objects.countries);
    provMesh = topojson.mesh(world.prov, world.prov.objects.p, (a, b) => a !== b);
    $("#loading").remove();
    rot = [-60, -20, 0]; k = .9; syncZoom(); updateDepth();
    resize();
    await loadMoments();
    recompute();
    flyTo([104, 32], 1.05, 1600);
    setTimeout(hideHint, 9000);
  }
  // translate horizontal shift for wide screens
  const _translate = proj.translate.bind(proj);
  proj.translate = function (t) { if (!arguments.length) return _translate(); return _translate([W / 2 + canvasShiftX, t[1]]); };

  if ("serviceWorker" in navigator && window.isSecureContext) {
    window.addEventListener("load", () => navigator.serviceWorker.register("sw.js").catch(() => {}));
  }
  window.__wl = { proj: () => proj, flyTo, byKey, resolvePoint, moments: () => moments };
  boot();
})();
