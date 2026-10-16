// Offline support: caches the app files so it opens without a connection.
// Bump VERSION whenever any file below changes so phones pick up the update.
const VERSION = 'v40';
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
// A connection that is back but barely working can leave a request hanging, so after a few
// seconds the cached copy is used instead. Only page loads fall back to index.html: a
// script answered with a page would break the feature that asked for it.
const NETWORK_WAIT = 4000;

self.addEventListener('fetch', (e) => {
  if (e.request.method !== 'GET' || new URL(e.request.url).origin !== location.origin) return;
  const cached = () => caches.match(e.request, { ignoreSearch: true })
    .then((r) => r || (e.request.mode === 'navigate' ? caches.match('./index.html') : undefined));
  const network = fetch(e.request, { cache: 'no-cache' }).then((res) => {
    if (res.ok) {
      const copy = res.clone();
      caches.open(CACHE).then((c) => c.put(e.request, copy));
    }
    return res;
  });
  e.respondWith(new Promise((resolve, reject) => {
    let done = false;
    const finish = (r) => {
      if (!done && r) {
        done = true;
        resolve(r);
      }
    };
    const fallback = () => cached().then((r) => {
      if (r) finish(r);
      else network.then(finish, () => !done && reject(new TypeError('offline')));
    });
    const timer = setTimeout(fallback, NETWORK_WAIT);
    network.then((r) => {
      clearTimeout(timer);
      finish(r);
    }, () => {
      clearTimeout(timer);
      fallback();
    });
  }));
});
