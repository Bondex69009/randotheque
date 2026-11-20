/* Randothèque – service worker : permet d'installer le site comme une appli et de rouvrir
   les pages déjà consultées sans réseau. Toujours le réseau d'abord (les données changent souvent),
   la copie locale seulement en secours (ou si le réseau ne répond pas en 6 s, utile en montagne).
   Mode terrain (assets/terrain.js) : les randos « emportées hors ligne » ont leur propre cache
   (rt-terrain:…) avec la trace et le fond de carte IGN ; les fonds de carte n'en sortent que depuis là.
   Les bibliothèques d'unpkg.com (versions figées) sont gardées dans rt-libs. */
const CACHE = 'randotheque-v3';
const LIBS = 'rt-libs';
const SHELL = ['./', './index.html', './manifest.webmanifest'];
const TILE_HOSTS = /(^|\.)(data\.geopf\.fr|tile\.opentopomap\.org|tile\.openstreetmap\.org)$/;

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL)).catch(() => {}));
  self.skipWaiting();
});

self.addEventListener('activate', (e) => {
  // Seulement les anciennes versions du cache général : jamais les randos emportées ni les bibliothèques
  e.waitUntil(caches.keys().then((keys) => Promise.all(keys
    .filter((k) => k.startsWith('randotheque-') && k !== CACHE)
    .map((k) => caches.delete(k)))));
  self.clients.claim();
});

// Une seule version gardée par fichier « ?v=… » (data/randos.js change à chaque mise à jour)
async function putLatest(req, res) {
  const c = await caches.open(CACHE);
  const url = new URL(req.url);
  if (url.searchParams.has('v')) {
    for (const old of await c.keys()) {
      const u = new URL(old.url);
      if (u.pathname === url.pathname && u.href !== url.href) c.delete(old);
    }
  }
  await c.put(req, res);
}

const timeout = (ms) => new Promise((_, reject) => setTimeout(() => reject(new Error('délai')), ms));

self.addEventListener('fetch', (e) => {
  const req = e.request;
  const url = new URL(req.url);
  if (req.method !== 'GET' || !/^https?:$/.test(url.protocol)) return;
  // Requêtes de scripts de « workers » (ex. carte 3D) : laissées au navigateur
  if (req.destination === 'worker' || req.destination === 'sharedworker') return;

  if (url.origin !== self.location.origin) {
    // Fond de carte : la copie emportée d'abord (mode terrain), sinon le réseau, sans rien garder
    if (TILE_HOSTS.test(url.hostname)) {
      e.respondWith(caches.match(req.url).then((hit) => hit || fetch(req)));
      return;
    }
    // Leaflet & co (versions figées) : copie locale d'abord
    if (url.hostname === 'unpkg.com') {
      e.respondWith(caches.match(req.url).then((hit) => hit || fetch(req).then((res) => {
        if (res.ok && res.type === 'cors') { const copy = res.clone(); caches.open(LIBS).then((c) => c.put(req.url, copy)).catch(() => {}); }
        return res;
      })));
    }
    return; // polices et autres sites : navigateur seul
  }

  // Fichiers lourds (GPX, audio) : réseau seul
  if (/\.(gpx|mp3|m4a|ogg|wav)$/i.test(url.pathname)) return;
  const fallback = () => caches.match(req, { ignoreSearch: req.mode === 'navigate' })
    .then((hit) => hit || (req.mode === 'navigate' ? caches.match('./') : Response.error()));
  const network = fetch(req).then((res) => {
    if (res.ok && res.type === 'basic') putLatest(req, res.clone()).catch(() => {});
    return res;
  });
  network.catch(() => {}); // évite l'alerte « promesse rejetée » quand la copie locale a déjà répondu
  e.respondWith(
    caches.match(req, { ignoreSearch: req.mode === 'navigate' }).then((hit) => (hit
      ? Promise.race([network, timeout(6000)]).catch(() => hit)
      : network.catch(fallback))),
  );
});
