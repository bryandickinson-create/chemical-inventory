// ============================================================
// Retired beta service worker
// ============================================================
// The beta build was promoted to the site root. This worker exists
// only to retire itself on devices that installed the beta: browsers
// re-fetch sw.js on navigation, see this version, and run it. It
// drops the beta caches and unregisters, so the beta stops serving a
// frozen copy of the app and /beta/ falls through to the redirect page.
// Safe to delete once no devices have the beta installed.
// ============================================================

self.addEventListener('install', () => self.skipWaiting());

self.addEventListener('activate', (event) => {
    event.waitUntil((async () => {
        for (const name of await caches.keys()) {
            if (name.startsWith('chem-inv-beta')) await caches.delete(name);
        }
        await self.registration.unregister();
        // Reload any open beta windows so they pick up the redirect.
        for (const client of await self.clients.matchAll({ type: 'window' })) {
            client.navigate(client.url);
        }
    })());
});

// No fetch handler: everything goes straight to the network.
