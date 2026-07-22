// ============================================================
// Service worker - offline app shell
// ============================================================
// Caches the static files so the app opens with no network. All
// data traffic (Firebase, PubChem, Gemini) is deliberately never
// cached; the app's own SyncedDB handles offline data.
// Bump CACHE_VERSION whenever app.js/style.css/index.html change.
// ============================================================

const CACHE_PREFIX = 'chem-inv-app';
const CACHE_VERSION = CACHE_PREFIX + '-v5';

// Cache names used by earlier builds, cleaned up on activate.
const LEGACY_CACHES = ['chem-inv-v1', 'chem-inv-beta-v1'];

const SHELL = [
    './',
    './index.html',
    './setup.html',
    './app.js',
    './style.css',
    './manifest.webmanifest',
    './icons/icon-192.png',
    './icons/icon-512.png',
    './icons/apple-touch-icon.png',
    'https://cdnjs.cloudflare.com/ajax/libs/xlsx/0.18.5/xlsx.full.min.js',
];

self.addEventListener('install', (event) => {
    event.waitUntil(
        caches.open(CACHE_VERSION)
            // addAll is all-or-nothing; cache entries individually so one
            // unreachable file can't fail the whole install.
            .then(cache => Promise.all(
                SHELL.map(url => cache.add(url).catch(err =>
                    console.warn('[sw] could not cache', url, err)
                ))
            ))
            .then(() => self.skipWaiting())
    );
});

self.addEventListener('activate', (event) => {
    event.waitUntil(
        caches.keys()
            // Only drop our own older versions. Caches are shared per-origin,
            // so deleting everything would clobber anything else served here.
            .then(keys => Promise.all(
                keys.filter(k => (k.startsWith(CACHE_PREFIX) || LEGACY_CACHES.includes(k))
                        && k !== CACHE_VERSION)
                    .map(k => caches.delete(k))
            ))
            .then(() => self.clients.claim())
    );
});

// Hosts whose responses must always come from the network.
const DATA_HOSTS = [
    'firebaseio.com',
    'firebasedatabase.app',
    'googleapis.com',
    'pubchem.ncbi.nlm.nih.gov',
];

function isDataRequest(url) {
    return DATA_HOSTS.some(host => url.hostname.endsWith(host));
}

self.addEventListener('fetch', (event) => {
    const request = event.request;
    if (request.method !== 'GET') return;

    const url = new URL(request.url);
    if (isDataRequest(url)) return; // let the network handle it, fail loudly if offline

    // Navigations: prefer fresh markup, fall back to the cached shell offline.
    if (request.mode === 'navigate') {
        event.respondWith(
            fetch(request)
                .then(response => {
                    const copy = response.clone();
                    caches.open(CACHE_VERSION).then(c => c.put('./index.html', copy));
                    return response;
                })
                .catch(() => caches.match('./index.html', { ignoreSearch: true }))
        );
        return;
    }

    // Static assets. The exact-URL lookup comes first on purpose: bumping
    // app.js?v=NN must miss the cache and hit the network, otherwise the
    // deploy's own cache-buster would be defeated by this worker. Only when
    // the network is unavailable do we fall back to a query-insensitive
    // match, which is what makes a fresh version number still work offline.
    event.respondWith(
        caches.match(request).then(cached => {
            const network = fetch(request)
                .then(response => {
                    if (response && response.ok) {
                        const copy = response.clone();
                        caches.open(CACHE_VERSION).then(c => c.put(request, copy));
                    }
                    return response;
                })
                .catch(() => caches.match(request, { ignoreSearch: true }));

            // Cached exact match: serve instantly, refresh in the background.
            if (cached) {
                network.catch(() => { /* background refresh is best-effort */ });
                return cached;
            }
            return network;
        })
    );
});
