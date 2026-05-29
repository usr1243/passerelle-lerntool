// ============================================================
// SERVICE WORKER – Passerelle Lerntool
// ============================================================
// Strategie: NETWORK-FIRST
//   Online  → immer neueste Version vom Server; Cache wird aktualisiert
//   Offline → Fallback auf lokal gespeicherte Version
//
// Dadurch muss man nie mehr den Cache manuell löschen.
// ============================================================

const CACHE_VERSION = 'passerelle-v3';
const APP_SHELL = './passerelle_lerntool.html';

// INSTALL ── App-Datei lokal speichern + sofort aktivieren
self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_VERSION).then((cache) => {
      return cache.add(APP_SHELL);
    }).then(() => self.skipWaiting())  // Alten SW sofort ersetzen
  );
});

// ACTIVATE ── Alle alten Cache-Versionen löschen
self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(
        keys
          .filter((key) => key !== CACHE_VERSION)
          .map((key) => caches.delete(key))
      )
    ).then(() => self.clients.claim())  // Alle offenen Tabs übernehmen
  );
});

// FETCH ── Network-First: online immer frisch vom Server
self.addEventListener('fetch', (event) => {
  if (event.request.method !== 'GET') return;

  const url = new URL(event.request.url);
  const isAppFile = url.pathname.includes('passerelle_lerntool')
                 || url.pathname.includes('passerelle-sw');

  if (isAppFile) {
    event.respondWith(
      fetch(event.request)
        .then((response) => {
          // Neue Version im Cache ablegen
          if (response && response.status === 200) {
            caches.open(CACHE_VERSION).then((cache) => {
              cache.put(event.request, response.clone());
            });
          }
          return response;
        })
        .catch(() => {
          // Kein Internet → gespeicherte Version als Fallback
          return caches.match(event.request);
        })
    );
  }
  // Alles andere (externe APIs etc.) normal durchlassen
});
