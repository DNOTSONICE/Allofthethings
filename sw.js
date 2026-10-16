// Offline support: caches the app files so it opens without a connection.
// Bump VERSION whenever any file below changes so phones pick up the update.
const VERSION = 'v25';
const CACHE = `wetcheck-${VERSION}`;
const FILES = [
  './',
  './index.html',
  './styles.css',
  './js/app.js',
  './js/db.js',
  './js/ui.js',
  './js/photo.js',
  './js/issues.js',
  './js/location.js',
  './js/pdf.js',
  './js/backup.js',
  './js/zip.js',
  './js/signature.js',
  './js/vendor/jspdf.umd.min.js',
  './data/issues.json',
  './fonts/great-vibes.woff2',
  './fonts/dancing-script.woff2',
  './fonts/homemade-apple.woff2',
  './manifest.webmanifest',
  './icons/icon-192.png',
  './icons/icon-512.png',
  './icons/icon-maskable-512.png',
  './icons/apple-touch-icon.png',
];

self.addEventListener('install', (e) => {
  // cache: 'reload' skips the browser's HTTP cache, so a new version never mixes in old files.
  e.waitUntil(
    caches.open(CACHE)
      .then((c) => c.addAll(FILES.map((f) => new Request(f, { cache: 'reload' }))))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

// Network first so updates show up when online; fall back to the cache offline.
// cache: 'no-cache' checks with the server every time instead of trusting GitHub Pages'
// 10-minute browser cache, which could pair a new page with old scripts.
self.addEventListener('fetch', (e) => {
  if (e.request.method !== 'GET' || new URL(e.request.url).origin !== location.origin) return;
  e.respondWith(
    fetch(e.request, { cache: 'no-cache' })
      .then((res) => {
        const copy = res.clone();
        caches.open(CACHE).then((c) => c.put(e.request, copy));
        return res;
      })
      .catch(() => caches.match(e.request, { ignoreSearch: true }).then((r) => r || caches.match('./index.html')))
  );
});
