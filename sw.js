/* TravelDiary service worker: the app opens offline once visited; map data is cached as it is used. */
const VERSION = "td-1";
const SHELL = ["./", "index.html", "app.js", "manifest.webmanifest", "vendor/d3.min.js", "vendor/topojson-client.min.js",
  "fonts/cg-500i.woff2", "fonts/cg-400.woff2", "icons/icon-192.png", "icons/apple-touch-icon.png", "icons/favicon-64.png",
  "data/world.json", "data/index.json"];
self.addEventListener("install", (e) => { e.waitUntil(caches.open(VERSION).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting())); });
self.addEventListener("activate", (e) => {
  e.waitUntil(caches.keys().then((ks) => Promise.all(ks.filter((k) => k !== VERSION).map((k) => caches.delete(k)))).then(() => self.clients.claim()));
});
self.addEventListener("fetch", (e) => {
  const req = e.request;
  if (req.method !== "GET" || new URL(req.url).origin !== location.origin) return;
  const url = new URL(req.url);
  const isData = url.pathname.includes("/data/") || url.pathname.includes("/vendor/") || url.pathname.includes("/fonts/") || url.pathname.includes("/icons/");
  if (isData) {
    // cache first: map data never changes within a version
    e.respondWith(caches.match(req).then((hit) => hit || fetch(req).then((res) => {
      if (res.ok) { const copy = res.clone(); caches.open(VERSION).then((c) => c.put(req, copy)); }
      return res;
    })));
  } else {
    // network first for the page and code so updates arrive; fall back to cache offline
    e.respondWith(fetch(req).then((res) => {
      if (res.ok) { const copy = res.clone(); caches.open(VERSION).then((c) => c.put(req, copy)); }
      return res;
    }).catch(() => caches.match(req).then((hit) => hit || caches.match("index.html"))));
  }
});
