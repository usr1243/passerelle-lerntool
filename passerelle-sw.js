// ============================================================
// SERVICE WORKER – Passerelle Lerntool
// ============================================================
// Was dieser Service Worker tut:
//   1. Beim ersten Öffnen: speichert die App-Datei lokal
//   2. Danach: lädt die App IMMER vom Gerät (nicht vom Internet)
//   3. Update: prüft im Hintergrund ob es eine neue Version gibt
//
// Resultat:
//   - App öffnet sich auch ohne Internet
//   - Daten (localStorage) bleiben beim iOS-App-Modus in einer
//     eigenen Sandbox — unabhängig von Safari
// ============================================================

const CACHE_VERSION = 'passerelle-v1';
const APP_SHELL = './passerelle_lerntool.html';

// INSTALL ── App-Datei lokal speichern
self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_VERSION).then((cache) => {
      return cache.add(APP_SHELL);
    }).then(() => self.skipWaiting())
  );
});

// ACTIVATE ── Alte Cache-Versionen aufräumen
self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(
        keys
          .filter((key) => key !== CACHE_VERSION)
          .map((key) => caches.delete(key))
      )
    ).then(() => self.clients.claim())
  );
});

// FETCH ── Cache-first mit Hintergrund-Update
self.addEventListener('fetch', (event) => {
  // Nur GET-Requests behandeln
  if (event.request.method !== 'GET') return;

  // Nur eigene App-Requests (nicht Google Fonts etc.)
  const url = new URL(event.request.url);
  const isAppFile = url.pathname.includes('passerelle_lerntool');

  if (isAppFile) {
    // Cache-First: zuerst lokale Kopie, im Hintergrund update prüfen
    event.respondWith(
      caches.open(CACHE_VERSION).then((cache) => {
        return cache.match(event.request).then((cached) => {
          const networkFetch = fetch(event.request).then((response) => {
            if (response && response.status === 200) {
              cache.put(event.request, response.clone());
            }
            return response;
          }).catch(() => cached); // Kein Internet: nutze Cache

          // Sofort aus Cache laden (kein Warten auf Netzwerk)
          return cached || networkFetch;
        });
      })
    );
  }
  // Andere Requests (Fonts etc.) normal durchlassen
});
