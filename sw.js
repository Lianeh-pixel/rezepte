/* Offline-Unterstützung: App-Dateien werden zwischengespeichert, Daten kommen immer frisch von Supabase. */
const VERSION = "rb-v75";
const SHELL = ["./", "index.html", "style.css", "app.js", "config.js", "nutrition.js", "vendor/supabase.js", "vendor/jspdf.umd.min.js", "manifest.webmanifest?i=7", "icons/icon-192.png?i=7", "icons/icon-512.png?i=7", "icons/icon-maskable-512.png?i=7", "icons/icon-monochrome-512.png?i=7", "icons/apple-touch-icon.png?i=7", "icons/icon.svg?i=7", "icons/icon-dark.svg?i=4", "icons/icon-light.svg?i=4", "icons/standard.svg", "icons/kat-kuchen.svg", "icons/kat-kekse.svg", "icons/kat-brot.svg", "icons/kat-dessert.svg", "icons/kat-hauptgericht.svg", "icons/kat-suppen.svg", "icons/kat-saucen.svg", "icons/kat-beilagen.svg", "icons/kat-grundrezepte.svg", "icons/favicon-32.png?i=7"];
self.addEventListener("install", e => { e.waitUntil(caches.open(VERSION).then(c => c.addAll(SHELL)).then(() => self.skipWaiting())); });
self.addEventListener("activate", e => { e.waitUntil(caches.keys().then(keys => Promise.all(keys.filter(k => k !== VERSION).map(k => caches.delete(k)))).then(() => self.clients.claim())); });
self.addEventListener("fetch", e => {
  const url = new URL(e.request.url);
  if (e.request.method !== "GET") return;
  const sameOrigin = url.origin === self.location.origin;
  const fonts = url.hostname.endsWith("fonts.googleapis.com") || url.hostname.endsWith("fonts.gstatic.com");
  if (!sameOrigin && !fonts) return; // Supabase & Fotos: immer Netzwerk
  // Netzwerk zuerst (damit Updates sofort ankommen), bei Offline aus dem Zwischenspeicher
  e.respondWith(fetch(e.request, sameOrigin ? { cache: "no-cache" } : {}).then(res => {
    if (res.ok) { const copy = res.clone(); caches.open(VERSION).then(c => c.put(e.request, copy)); }
    return res;
  }).catch(() => caches.match(e.request, { ignoreSearch: true }).then(r => r || caches.match("index.html"))));
});
