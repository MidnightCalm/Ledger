/* Ledger service worker — cache-first app shell.
   Deliberately never touches api.github.com: sync must always hit the network,
   and a cached/offline fallback there would silently hand back stale data. */
const CACHE = 'ledger-v3';
const ASSETS = [
  './',
  'index.html',
  'style.css',
  'app.js',
  'manifest.webmanifest',
  'icons/icon-180.png',
  'icons/icon-192.png',
  'icons/icon-512.png'
];

self.addEventListener('install', e => {
  e.waitUntil(caches.open(CACHE).then(c => c.addAll(ASSETS)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', e => {
  e.waitUntil(
    caches.keys()
      .then(keys => Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', e => {
  if (e.request.method !== 'GET') return;
  const url = new URL(e.request.url);

  const sameOrigin = url.origin === location.origin;
  const isFont = url.hostname.endsWith('gstatic.com') || url.hostname.endsWith('googleapis.com');
  if (!sameOrigin && !isFont) return; // GitHub API and everything else: straight to the network

  e.respondWith(
    caches.match(e.request, { ignoreSearch: true }).then(hit => {
      if (hit) return hit;
      return fetch(e.request).then(res => {
        if (res.ok || res.type === 'opaque') {
          const copy = res.clone();
          caches.open(CACHE).then(c => c.put(e.request, copy));
        }
        return res;
      }).catch(() => (sameOrigin ? caches.match('index.html') : Response.error()));
    })
  );
});
