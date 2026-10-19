// Offline support for CoteCartes.
// - The site itself: network first, so an update shows up at once; the last copy is used offline.
// - Card data (TCGdex): network first too, the last answer is used offline.
// - The reading engine (versioned files on jsDelivr): cache first, it never changes.
// - The card fingerprints (jsDelivr, "empreintes" branch): network first, they are rebuilt every week.
// - The account server is never touched: it must always reach the network.

const SHELL = 'cotecartes-shell-v2';
const DATA = 'cotecartes-data-v1';
const ENGINE = 'cotecartes-engine-v1';
const SHELL_FILES = ['./', 'index.html', 'style.css', 'app.js', 'sync.js', 'fingerprint.js', 'confidentialite.html', 'manifest.webmanifest', 'icons/icon-192.png'];

self.addEventListener('install', (event) => {
  event.waitUntil(caches.open(SHELL).then((c) => c.addAll(SHELL_FILES)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (event) => {
  const keep = [SHELL, DATA, ENGINE];
  event.waitUntil(caches.keys()
    .then((keys) => Promise.all(keys.filter((k) => !keep.includes(k)).map((k) => caches.delete(k))))
    .then(() => self.clients.claim()));
});

async function networkFirst(request, cacheName, cacheKey = request) {
  const cache = await caches.open(cacheName);
  try {
    const res = await fetch(request);
    if (res.ok && res.type !== 'opaque') cache.put(cacheKey, res.clone());
    return res;
  } catch (e) {
    const hit = await cache.match(cacheKey, { ignoreSearch: cacheName === SHELL });
    if (hit) return hit;
    throw e;
  }
}

async function cacheFirst(request, cacheName) {
  const cache = await caches.open(cacheName);
  const hit = await cache.match(request);
  if (hit) return hit;
  const res = await fetch(request);
  if (res.ok && res.type !== 'opaque') cache.put(request, res.clone());
  return res;
}

self.addEventListener('fetch', (event) => {
  const { request } = event;
  if (request.method !== 'GET') return;
  const url = new URL(request.url);
  if (url.origin === self.location.origin) {
    // Pages are stored without their #hash or ?v= so any link finds them offline.
    event.respondWith(networkFirst(request, SHELL));
  } else if (url.host === 'api.tcgdex.net') {
    event.respondWith(networkFirst(request, DATA));
  } else if (url.host === 'cdn.jsdelivr.net' && url.pathname.includes('@empreintes/')) {
    event.respondWith(networkFirst(request, DATA));
  } else if (url.host === 'cdn.jsdelivr.net') {
    event.respondWith(cacheFirst(request, ENGINE));
  }
});
