// Network-first cache of the app shell so Cycle Nav still opens with a bad connection.

const CACHE = 'cyclenav-v55';
const SHELL = ['./', 'index.html', 'styles.css', 'manifest.webmanifest', 'icons/icon.svg', 'profiles/calm.brf',
  'js/app.js', 'js/native.js', 'js/geo.js', 'js/geocode.js', 'js/memory.js', 'js/nav.js', 'js/router.js', 'js/store.js', 'js/theme.js', 'js/mapstyle.js', 'js/i18n.js', 'js/offline.js', 'js/weather.js', 'js/brouter-native.js', 'js/sheet.js',
  'vendor/pbf.js', 'vendor/vector-tile.js', 'vendor/point-geometry.js',
  'vendor/leaflet.js', 'vendor/leaflet.css', 'vendor/maplibre-gl.js', 'vendor/maplibre-gl.css', 'vendor/leaflet-maplibre-gl.js'];

self.addEventListener('install', e => {
  e.waitUntil(caches.open(CACHE).then(c => c.addAll(SHELL.map(u => new Request(u, { cache: 'reload' })))).then(() => self.skipWaiting()));
});

self.addEventListener('activate', e => {
  e.waitUntil(caches.keys()
    .then(keys => Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k))))
    .then(() => self.clients.claim()));
});

self.addEventListener('fetch', e => {
  const url = new URL(e.request.url);
  if (e.request.method !== 'GET' || url.origin !== location.origin) return;
  e.respondWith(
    // revalidate with the server: GitHub Pages lets browsers cache files for 10 minutes
    fetch(e.request, { cache: 'no-cache' })
      .then(res => {
        const copy = res.clone();
        caches.open(CACHE).then(c => c.put(e.request, copy));
        return res;
      })
      .catch(() => caches.match(e.request))
  );
});
