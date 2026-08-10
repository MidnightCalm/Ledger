/* Ledger service worker.

   Same-origin app files are network-first: a deployed update must never be held
   hostage by a stale cache, which is exactly what cache-first did. The cache is
   still written on every successful fetch, so it remains a complete offline
   copy — it is just the fallback rather than the first choice.

   IMPORTANT: those network fetches must opt out of the browser's HTTP cache.
   A plain fetch(request) uses the default cache mode, so the HTTP cache answers
   it — and GitHub Pages serves this app with Cache-Control: max-age=600. That
   made "network-first" a lie for ten minutes after every deploy: the worker
   asked for the network and the HTTP cache handed back the old file. Every
   network read here therefore sets an explicit cache mode.

   Fonts stay cache-first (they are immutable and versioned by URL).
   api.github.com is deliberately untouched: sync must always hit the network,
   and an offline fallback there would silently hand back stale data. */
const CACHE = 'ledger-2.4.2';
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

/* Bypass the HTTP cache for a network read. Falls back to the original request
   if a browser refuses to rebuild it (navigation requests are the awkward case). */
function fresh(request, mode) {
  try {
    return new Request(request, { cache: mode || 'no-store' });
  } catch (err) {
    return request;
  }
}

self.addEventListener('install', e => {
  e.waitUntil(
    caches.open(CACHE)
      // not cache.addAll: its fetches would go through the HTTP cache too, so a
      // fresh install could precache the very files it is meant to replace
      .then(c => Promise.all(ASSETS.map(u =>
        fetch(fresh(new Request(u, { credentials: 'same-origin' }), 'reload'))
          .then(res => { if (res.ok) return c.put(u, res); })
      )))
      .then(() => self.skipWaiting())
  );
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

  if (sameOrigin) {
    e.respondWith(
      fetch(fresh(e.request)).then(res => {
        if (res.ok) {
          const copy = res.clone();
          caches.open(CACHE).then(c => c.put(e.request, copy));
        }
        return res;
      }).catch(() =>
        caches.match(e.request, { ignoreSearch: true }).then(hit => hit || caches.match('index.html'))
      )
    );
    return;
  }

  e.respondWith(
    caches.match(e.request, { ignoreSearch: true }).then(hit => hit || fetch(e.request).then(res => {
      if (res.ok || res.type === 'opaque') {
        const copy = res.clone();
        caches.open(CACHE).then(c => c.put(e.request, copy));
      }
      return res;
    }))
  );
});
