// Bump this version whenever a cached app-shell asset changes.
const CACHE_NAME = "scan-shell-v6";
const APP_SHELL = ["./", "./index.html", "./app.js", "./camera.js", "./detection.js", "./image-manipulation.js", "./styles.css", "./styles/base.css", "./styles/layout.css", "./styles/components.css", "./manifest.webmanifest", "./icon.svg", "./icon-192.png", "./icon-512.png", "./jspdf.umd.min.js"];

self.addEventListener("install", event => {
  event.waitUntil(caches.open(CACHE_NAME).then(cache => cache.addAll(APP_SHELL)));
  self.skipWaiting();
});

self.addEventListener("activate", event => {
  event.waitUntil(caches.keys().then(keys => Promise.all(keys.filter(key => key !== CACHE_NAME).map(key => caches.delete(key)))));
  self.clients.claim();
});

self.addEventListener("fetch", event => {
  if (event.request.method !== "GET") return;
  event.respondWith(fetch(event.request).then(response => {
    if (new URL(event.request.url).origin !== self.location.origin) return response;
    const copy = response.clone();
    caches.open(CACHE_NAME).then(cache => cache.put(event.request, copy));
    return response;
  }).catch(() => caches.match(event.request)));
});
