/* Metsäkartan service worker: pitää sovelluksen ja tallennetut kartat käytettävissä ilman verkkoa. */
'use strict';

var SHELL_CACHE = 'mk-shell-2026-10-18a';
var TILE_CACHE = 'mk-tiles-v1';
var DATA_CACHE = 'mk-data-v1';
var SHELL = [
  './',
  'index.html',
  'app.js',
  'core.js',
  'style.css',
  'manifest.webmanifest',
  'vendor/leaflet/leaflet.js',
  'vendor/leaflet/leaflet.css',
  'vendor/leaflet-rotate/leaflet-rotate.js',
  'icons/icon-192.png',
  'icons/icon-512.png',
  'icons/apple-touch-icon.png'
];

self.addEventListener('install', function (e) {
  e.waitUntil(
    caches.open(SHELL_CACHE)
      .then(function (c) { return c.addAll(SHELL.map(function (u) { return new Request(u, { cache: 'reload' }); })); })
      .then(function () { return self.skipWaiting(); })
  );
});

self.addEventListener('activate', function (e) {
  e.waitUntil(
    caches.keys().then(function (keys) {
      return Promise.all(keys.filter(function (k) {
        return k.indexOf('mk-shell-') === 0 && k !== SHELL_CACHE;
      }).map(function (k) { return caches.delete(k); }));
    }).then(function () { return self.clients.claim(); })
  );
});

function isTile(url) {
  return url.pathname.indexOf('/WGS84_Pseudo-Mercator/') >= 0;
}

/** Karttatiili: tallennettu ensin, sitten verkko (ja tallennus jatkoa varten). */
function tileResponse(request, url) {
  var key = url.origin + url.pathname;
  return caches.open(TILE_CACHE).then(function (cache) {
    return cache.match(key).then(function (hit) {
      if (hit) return hit;
      return fetch(url.href, { mode: 'cors', credentials: 'omit' }).then(function (r) {
        if (r.ok) cache.put(key, r.clone());
        return r;
      }).catch(function () {
        // CORS ei sallittu tai ei verkkoa: yritetään tavallisena kuvapyyntönä ilman tallennusta.
        return fetch(request).catch(function () { return new Response('', { status: 504, statusText: 'Offline' }); });
      });
    });
  });
}

function cacheFirst(request, cacheName) {
  return caches.match(request).then(function (hit) {
    if (hit) return hit;
    return fetch(request).then(function (r) {
      if (r.ok) {
        var copy = r.clone();
        caches.open(cacheName).then(function (c) { c.put(request, copy); });
      }
      return r;
    });
  });
}

function networkFirst(request, cacheName, timeoutMs) {
  return new Promise(function (resolve) {
    var settled = false;
    function fromCache() {
      return caches.match(request).then(function (hit) {
        return hit || new Response('{"areas":[]}', { headers: { 'Content-Type': 'application/json' } });
      });
    }
    var timer = setTimeout(function () {
      if (!settled) { settled = true; fromCache().then(resolve); }
    }, timeoutMs);
    fetch(request, { cache: 'no-cache' }).then(function (r) {
      if (r.ok) {
        var copy = r.clone();
        caches.open(cacheName).then(function (c) { c.put(request, copy); });
      }
      if (!settled) { settled = true; clearTimeout(timer); resolve(r); }
    }).catch(function () {
      if (!settled) { settled = true; clearTimeout(timer); fromCache().then(resolve); }
    });
  });
}

/** Sovelluksen tiedostot: heti välimuistista, päivitys taustalla. */
function staleWhileRevalidate(request) {
  return caches.open(SHELL_CACHE).then(function (cache) {
    return cache.match(request, { ignoreSearch: true }).then(function (hit) {
      var net = fetch(request, { cache: 'no-cache' }).then(function (r) {
        if (r.ok && r.type === 'basic') cache.put(request, r.clone());
        return r;
      }).catch(function () { return hit; });
      return hit || net;
    });
  });
}

self.addEventListener('fetch', function (e) {
  var req = e.request;
  if (req.method !== 'GET') return;
  var url = new URL(req.url);

  if (isTile(url)) { e.respondWith(tileResponse(req, url)); return; }
  if (url.origin !== self.location.origin) return;

  var scope = new URL(self.registration.scope);
  var path = url.pathname.slice(scope.pathname.length);

  if (path === 'data/areas.json') { e.respondWith(networkFirst(req, DATA_CACHE, 5000)); return; }
  if (path.indexOf('data/') === 0) { e.respondWith(cacheFirst(req, DATA_CACHE)); return; }
  if (req.mode === 'navigate') {
    // Heti välimuistista (heikko kenttä ei jumita käynnistystä), päivitys taustalla.
    e.respondWith(caches.open(SHELL_CACHE).then(function (c) {
      return c.match('index.html').then(function (hit) {
        var net = fetch(req, { cache: 'no-cache' }).then(function (r) {
          if (r.ok) c.put('index.html', r.clone());
          return r;
        }).catch(function () { return hit; });
        if (hit) { e.waitUntil(net.catch(function () {})); return hit; }
        return net;
      });
    }));
    return;
  }
  e.respondWith(staleWhileRevalidate(req));
});
