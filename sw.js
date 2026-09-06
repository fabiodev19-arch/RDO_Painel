// Service Worker — GTM RDO
// Este app guarda os relatórios no IndexedDB do próprio aparelho, então o
// Service Worker aqui tem um único trabalho: colocar o "app shell" (HTML,
// manifest, ícones) em cache para o app abrir mesmo sem nenhum sinal de
// internet — inclusive na primeira tela, sem precisar já ter sido aberto
// online antes de ir a campo.

var CACHE_NAME = "gtm-rdo-v20";
var APP_SHELL = [
  "./",
  "./index.html",
  "./manifest.webmanifest",
  "./icon-192.png",
  "./icon-512.png"
];

self.addEventListener("install", function (event) {
  event.waitUntil(
    caches.open(CACHE_NAME).then(function (cache) {
      return cache.addAll(APP_SHELL);
    }).then(function () {
      return self.skipWaiting();
    })
  );
});

self.addEventListener("activate", function (event) {
  event.waitUntil(
    caches.keys().then(function (nomes) {
      return Promise.all(
        nomes.filter(function (n) { return n !== CACHE_NAME; })
             .map(function (n) { return caches.delete(n); })
      );
    }).then(function () {
      return self.clients.claim();
    })
  );
});

// Cache-first para o app shell: sempre abre instantâneo e funciona offline.
// Qualquer coisa fora da lista (ex.: uma futura chamada de API) vai direto
// pra rede, sem passar por cache.
self.addEventListener("fetch", function (event) {
  if (event.request.method !== "GET") return;

  event.respondWith(
    caches.match(event.request).then(function (cached) {
      if (cached) return cached;
      return fetch(event.request).catch(function () {
        return caches.match("./index.html");
      });
    })
  );
});
