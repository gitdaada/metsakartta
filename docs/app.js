/* Metsäkartta – offline-kartta metsän iästä Metsähallituksen lupa-alueilla. */
(function () {
  'use strict';

  // ---------------------------------------------------------------------------
  // Asetukset ja tallennus
  // ---------------------------------------------------------------------------

  var MML_BASE = 'https://avoin-karttakuva.maanmittauslaitos.fi/avoin/wmts/1.0.0';
  var MML_LAYERS = {
    maastokartta: { path: 'maastokartta', ext: 'png', estKB: 20, name: 'Maastokartta' },
    ortokuva: { path: 'ortokuva', ext: 'jpg', estKB: 40, name: 'Ilmakuva' }
  };
  var TILE_CACHE = 'mk-tiles-v1';
  var DATA_CACHE = 'mk-data-v1';
  var OFFLINE_ZMIN = 8;
  var TILE_PAD_DEG = 0.004;
  var CONCURRENCY = 6;
  var BIG_DOWNLOAD_MB = 300;

  var store = {
    get: function (k, d) {
      try { var v = localStorage.getItem('mk_' + k); return v === null ? d : JSON.parse(v); } catch (e) { return d; }
    },
    set: function (k, v) {
      try { localStorage.setItem('mk_' + k, JSON.stringify(v)); } catch (e) { /* täynnä tai estetty */ }
    }
  };

  var DEFAULTS = {
    apiKey: '', basemap: 'maastokartta', oldAge: 80, taimikkoM: 7, maxZoom: 16, offlineOrtho: false,
    wakeLock: false, opacity: 0.7, showForest: true, showProtected: true, showMask: true, gpsOn: false,
    mmlBase: ''
  };
  var settings = Object.assign({}, DEFAULTS, store.get('settings', {}));
  function saveSettings() { store.set('settings', settings); }

  var offline = store.get('offline', {}); // { areaId: {version, date, maxZoom, layers, tiles, failed} }
  function saveOffline() { store.set('offline', offline); }

  var S = {
    index: null, areas: [], area: null, forest: null, stats: null,
    boundaryGJ: null, protectedGJ: null, layers: {}, base: null,
    pos: null, watchId: null, follow: false, firstFix: true,
    wakeLock: null, dl: null, tapMarker: null, renderOpts: null
  };

  // ---------------------------------------------------------------------------
  // DOM-apurit
  // ---------------------------------------------------------------------------

  function $(id) { return document.getElementById(id); }
  function h(tag, attrs) {
    var el = document.createElement(tag);
    if (attrs) Object.keys(attrs).forEach(function (k) {
      var v = attrs[k];
      if (v === null || v === undefined || v === false) return;
      if (k === 'text') el.textContent = v;
      else if (k === 'html') el.innerHTML = v;
      else if (k === 'class') el.className = v;
      else if (k.slice(0, 2) === 'on') el.addEventListener(k.slice(2), v);
      else el.setAttribute(k, v === true ? '' : v);
    });
    for (var i = 2; i < arguments.length; i++) {
      var c = arguments[i];
      if (c === null || c === undefined || c === false) continue;
      if (Array.isArray(c)) c.forEach(function (cc) { if (cc) el.appendChild(typeof cc === 'string' ? document.createTextNode(cc) : cc); });
      else el.appendChild(typeof c === 'string' ? document.createTextNode(c) : c);
    }
    return el;
  }
  function esc(s) {
    return String(s === undefined || s === null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }
  function fmtInt(n) { return Math.round(n).toLocaleString('fi-FI'); }
  function fmtMB(bytes) { var mb = bytes / 1e6; return (mb < 10 ? mb.toFixed(1).replace('.', ',') : fmtInt(mb)) + ' Mt'; }
  function fmtDate(ts) { var d = new Date(ts); return d.getDate() + '.' + (d.getMonth() + 1) + '.' + d.getFullYear(); }
  function pct(a, b) { return b ? Math.round(100 * a / b) : 0; }
  function absUrl(u) { return new URL(u, location.href).href; }
  function stripQuery(u) { var i = u.indexOf('?'); return i < 0 ? u : u.slice(0, i); }

  var toastTimer = null;
  function toast(msg, action, ms) {
    var t = $('toast');
    t.textContent = msg;
    if (action) {
      var b = h('button', { type: 'button', text: action.label, onclick: function () { t.hidden = true; action.fn(); } });
      t.appendChild(b);
    }
    t.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(function () { t.hidden = true; }, ms || (action ? 8000 : 4000));
  }

  function isStandalone() {
    return (window.matchMedia && window.matchMedia('(display-mode: standalone)').matches) || window.navigator.standalone === true;
  }
  function isIOS() { return /iphone|ipad|ipod/i.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1); }

  // ---------------------------------------------------------------------------
  // Kartta
  // ---------------------------------------------------------------------------

  var map = L.map('map', { zoomControl: false, maxZoom: 18, minZoom: 4, attributionControl: true, zoomSnap: 0.5 });
  map.attributionControl.setPrefix(false);
  map.setView(store.get('view', { c: [64.0, 26.5], z: 5 }).c, store.get('view', { c: [64.0, 26.5], z: 5 }).z);
  map.createPane('maskPane').style.zIndex = 300;
  map.createPane('forestPane').style.zIndex = 350;
  map.createPane('protCasingPane').style.zIndex = 410;
  map.createPane('protPane').style.zIndex = 420;
  map.createPane('boundaryPane').style.zIndex = 430;
  L.control.scale({ imperial: false, position: 'bottomleft' }).addTo(map);

  map.on('moveend', function () {
    var c = map.getCenter();
    store.set('view', { c: [Number(c.lat.toFixed(5)), Number(c.lng.toFixed(5))], z: map.getZoom() });
  });
  map.on('dragstart', function () { if (S.follow) setFollow(false); });

  function mmlBase() { return (settings.mmlBase || MML_BASE).replace(/\/$/, ''); }
  function mmlTemplate(layer) {
    var L_ = MML_LAYERS[layer];
    return mmlBase() + '/' + L_.path + '/default/WGS84_Pseudo-Mercator/{z}/{y}/{x}.' + L_.ext;
  }
  function mmlTileUrl(layer, z, x, y, key) {
    return mmlTemplate(layer).replace('{z}', z).replace('{y}', y).replace('{x}', x) + '?api-key=' + encodeURIComponent(key);
  }

  function setBasemap() {
    if (S.base) map.removeLayer(S.base);
    var key = (settings.apiKey || '').trim();
    var layer = settings.basemap;
    if (key && MML_LAYERS[layer]) {
      S.base = L.tileLayer(mmlTemplate(layer) + '?api-key=' + encodeURIComponent(key), {
        maxNativeZoom: 16, maxZoom: 18, keepBuffer: 3,
        attribution: '© <a href="https://www.maanmittauslaitos.fi" target="_blank" rel="noopener">Maanmittauslaitos</a>'
      });
    } else {
      S.base = L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', {
        maxNativeZoom: 19, maxZoom: 18,
        attribution: '© <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noopener">OpenStreetMap</a>'
      });
    }
    S.base.addTo(map);
  }

  // Metsäkerros piirretään laitteella tallennetusta rasterista.
  var ForestLayer = L.GridLayer.extend({
    options: { pane: 'forestPane', tileSize: 256, maxZoom: 20, updateWhenZooming: false, keepBuffer: 2 },
    createTile: function (coords) {
      var t = L.DomUtil.create('canvas', 'forest-tile');
      var sz = this.getTileSize();
      t.width = sz.x; t.height = sz.y;
      if (!S.forest) return t;
      var ctx = t.getContext('2d');
      var img = ctx.createImageData(sz.x, sz.y);
      var out = new Uint32Array(img.data.buffer);
      if (MK.renderTile(S.forest, coords.x, coords.y, coords.z, out, renderOpts(), sz.x)) ctx.putImageData(img, 0, 0);
      return t;
    }
  });
  var forestLayer = new ForestLayer({ opacity: settings.opacity });

  function renderOpts() {
    if (!S.renderOpts) {
      var hc = MK.COLORS.hatch;
      S.renderOpts = {
        palette: MK.buildPalette(settings.oldAge),
        taimikkoCode: Math.round(settings.taimikkoM * 5),
        hatchPeriod: 9, hatchWidth: 2,
        hatchColor: MK.packRGBA(hc[0], hc[1], hc[2], 255)
      };
    }
    return S.renderOpts;
  }
  function refreshForest() {
    S.renderOpts = null;
    if (S.forest) S.stats = MK.stats(S.forest, settings.oldAge, Math.round(settings.taimikkoM * 5));
    forestLayer.redraw();
    renderLegend();
  }

  function applyLayerVisibility() {
    toggleLayer(forestLayer, settings.showForest && !!S.forest);
    toggleLayer(S.layers.protCasing, settings.showProtected);
    toggleLayer(S.layers.prot, settings.showProtected);
    toggleLayer(S.layers.mask, settings.showMask);
    toggleLayer(S.layers.mask2, settings.showMask);
  }
  function toggleLayer(layer, on) {
    if (!layer) return;
    if (on && !map.hasLayer(layer)) layer.addTo(map);
    if (!on && map.hasLayer(layer)) map.removeLayer(layer);
  }

  // ---------------------------------------------------------------------------
  // Selite
  // ---------------------------------------------------------------------------

  var legendOpen = store.get('legendOpen', true);
  var LegendControl = L.Control.extend({
    options: { position: 'bottomleft' },
    onAdd: function () {
      var div = L.DomUtil.create('div', 'legend');
      L.DomEvent.disableClickPropagation(div);
      L.DomEvent.disableScrollPropagation(div);
      this._div = div;
      return div;
    }
  });
  var legend = new LegendControl();
  legend.addTo(map);

  function renderLegend() {
    var div = legend._div;
    if (!div) return;
    var C = MK.COLORS, oa = settings.oldAge;
    var grad = 'linear-gradient(90deg,' + MK.cssRGB(C.young) + ',' + MK.cssRGB(C.middle) + ')';
    var hatch = 'repeating-linear-gradient(135deg,' + MK.cssRGB(C.hatch) + ' 0 2px,' + MK.cssRGB(MK.ageColor(5, oa)) + ' 2px 7px)';
    var html = '<button type="button" class="legend-toggle" aria-expanded="' + legendOpen + '">' +
      '<span class="legend-dots"><i style="background:' + MK.cssRGB(C.treeless) + '"></i><i style="background:' + MK.cssRGB(C.young) +
      '"></i><i style="background:' + MK.cssRGB(C.middle) + '"></i><i style="background:' + MK.cssRGB(C.old) + '"></i></span>' +
      '<span>Selite</span></button>';
    if (legendOpen) {
      html += '<ul class="legend-list">' +
        '<li><span class="sw" style="background:' + MK.cssRGB(C.treeless) + '"></span>Puuton</li>' +
        '<li><span class="sw" style="background:' + grad + '"></span><span>Metsä 0–' + (oa - 1) + ' v<small>vihreämpi = nuorempi</small></span></li>' +
        '<li><span class="sw" style="background:' + MK.cssRGB(C.old) + '"></span>Vanha metsä ≥ ' + oa + ' v</li>' +
        '<li><span class="sw" style="background:' + hatch + '"></span>Taimikko (alle ' + String(settings.taimikkoM).replace('.', ',') + ' m)</li>' +
        '<li><span class="sw sw-dash"></span>Luonnonsuojelualue</li>' +
        '<li><span class="sw sw-line"></span>Lupa-alueen raja</li>' +
        '</ul>';
      if (S.stats && S.stats.total) {
        var st = S.stats, forest = st.young + st.old;
        html += '<div class="legend-stats">Vanhaa metsää ' + pct(st.old, forest) + ' % metsästä · puutonta ' +
          pct(st.treeless, st.total) + ' % alasta</div>';
      }
    }
    div.innerHTML = html;
    div.querySelector('.legend-toggle').addEventListener('click', function () {
      legendOpen = !legendOpen; store.set('legendOpen', legendOpen); renderLegend();
    });
  }

  // ---------------------------------------------------------------------------
  // Alueet
  // ---------------------------------------------------------------------------

  function loadIndex() {
    return fetch('data/areas.json', { cache: 'no-cache' })
      .then(function (r) { if (!r.ok) throw new Error('HTTP ' + r.status); return r.json(); })
      .then(function (j) { store.set('index', j); return j; })
      .catch(function () { return store.get('index', { areas: [] }); })
      .then(function (j) { S.index = j; S.areas = j.areas || []; return j; });
  }

  function findArea(id) { for (var i = 0; i < S.areas.length; i++) if (S.areas[i].id === id) return S.areas[i]; return null; }

  function fetchJSON(url) {
    return fetch(url).then(function (r) { if (!r.ok) throw new Error('HTTP ' + r.status); return r.json(); });
  }

  /** Lukee forest.png:n pikselidatan suikaleina (iOS rajoittaa canvasin kokoa). */
  function decodeImage(blob, meta) {
    function fromBitmap(src, w, hgt) {
      var stripH = Math.max(1, Math.min(hgt, Math.floor(4000000 / w)));
      var c = document.createElement('canvas');
      c.width = w; c.height = stripH;
      var ctx = c.getContext('2d', { willReadFrequently: true });
      var all = new Uint8ClampedArray(w * hgt * 4);
      for (var y0 = 0; y0 < hgt; y0 += stripH) {
        var sh = Math.min(stripH, hgt - y0);
        ctx.clearRect(0, 0, w, stripH);
        ctx.drawImage(src, 0, y0, w, sh, 0, 0, w, sh);
        all.set(ctx.getImageData(0, 0, w, sh).data, y0 * w * 4);
      }
      return MK.decodeRGB(all, w, hgt);
    }
    if (window.createImageBitmap) {
      return createImageBitmap(blob, { colorSpaceConversion: 'none', premultiplyAlpha: 'none' })
        .catch(function () { return createImageBitmap(blob); })
        .then(function (bmp) { var d = fromBitmap(bmp, bmp.width, bmp.height); if (bmp.close) bmp.close(); return d; });
    }
    return new Promise(function (resolve, reject) {
      var img = new Image();
      var url = URL.createObjectURL(blob);
      img.onload = function () { URL.revokeObjectURL(url); resolve(fromBitmap(img, img.naturalWidth, img.naturalHeight)); };
      img.onerror = function () { URL.revokeObjectURL(url); reject(new Error('Kuvan purku epäonnistui')); };
      img.src = url;
    });
  }

  function loadForest(a) {
    return fetch(a.forest.file)
      .then(function (r) { if (!r.ok) throw new Error('HTTP ' + r.status); return r.blob(); })
      .then(function (blob) { return decodeImage(blob, a.forest); })
      .then(function (dec) {
        var ck = a.forest.checksum;
        if (ck && (dec.sumR !== ck.sumR || dec.sumG !== ck.sumG)) {
          console.warn('Tarkistussumma ei täsmää', dec.sumR, ck.sumR, dec.sumG, ck.sumG);
          toast('Huom: laite muutti karttakuvaa, ikätiedot voivat olla hieman epätarkkoja.');
        }
        return MK.makeForest(dec, a.forest);
      });
  }

  function clearAreaLayers() {
    ['mask', 'mask2', 'boundaryCasing', 'boundary', 'protCasing', 'prot'].forEach(function (k) {
      if (S.layers[k]) { map.removeLayer(S.layers[k]); S.layers[k] = null; }
    });
    S.forest = null; S.stats = null;
    if (map.hasLayer(forestLayer)) map.removeLayer(forestLayer);
    closeInfo();
  }

  function eachPolygon(gj, fn) {
    (gj.features || []).forEach(function (f) {
      var g = f.geometry;
      if (!g) return;
      if (g.type === 'Polygon') fn(g.coordinates, f);
      else if (g.type === 'MultiPolygon') g.coordinates.forEach(function (p) { fn(p, f); });
    });
  }
  function ringToLatLngs(ring) { return ring.map(function (c) { return [c[1], c[0]]; }); }

  function drawAreaLayers() {
    var bnd = S.boundaryGJ, prot = S.protectedGJ;
    // Himmennys alueen ulkopuolelle: maailma, josta alue on leikattu pois.
    var world = [[-85, -180], [-85, 180], [85, 180], [85, -180]];
    var holes = [], inner = [];
    eachPolygon(bnd, function (rings) {
      holes.push(ringToLatLngs(rings[0]));
      for (var k = 1; k < rings.length; k++) inner.push(ringToLatLngs(rings[k]));
    });
    var maskStyle = { pane: 'maskPane', stroke: false, fillColor: '#0b0f0c', fillOpacity: 0.32, interactive: false };
    S.layers.mask = L.polygon([world].concat(holes), maskStyle);
    S.layers.mask2 = inner.length ? L.polygon(inner, maskStyle) : null;

    S.layers.boundaryCasing = L.geoJSON(bnd, { pane: 'boundaryPane', interactive: false,
      style: { color: '#ffffff', weight: 7, opacity: 0.85, fill: false } }).addTo(map);
    S.layers.boundary = L.geoJSON(bnd, { pane: 'boundaryPane', interactive: false,
      style: { color: '#111111', weight: 3, opacity: 1, fill: false } }).addTo(map);

    S.layers.protCasing = L.geoJSON(prot, { pane: 'protCasingPane', interactive: false,
      style: { color: '#1a1a1a', weight: 5.5, opacity: 0.55, fill: false } });
    S.layers.prot = L.geoJSON(prot, { pane: 'protPane', interactive: false,
      style: { color: '#ffd400', weight: 3, opacity: 1, dashArray: '9 7', lineCap: 'butt', fillColor: '#ffd400', fillOpacity: 0.06 } });
    applyLayerVisibility();
  }

  function fitArea(a) {
    map.fitBounds(a.forest.bounds, { paddingTopLeft: [16, 84], paddingBottomRight: [76, legendOpen ? 240 : 64] });
  }

  function selectArea(id, opts) {
    var a = findArea(id);
    if (!a) return Promise.resolve();
    opts = opts || {};
    clearAreaLayers();
    S.area = a;
    store.set('lastArea', id);
    $('areaName').textContent = a.name;
    if (!opts.keepView) fitArea(a);
    return Promise.all([fetchJSON(a.boundary), fetchJSON(a.protected).catch(function () { return { type: 'FeatureCollection', features: [] }; })])
      .then(function (res) {
        if (S.area !== a) return;
        S.boundaryGJ = res[0]; S.protectedGJ = res[1];
        drawAreaLayers();
        return loadForest(a).then(function (F) {
          if (S.area !== a) return;
          S.forest = F;
          refreshForest();
          applyLayerVisibility();
        });
      })
      .catch(function (e) {
        console.error(e);
        if (!navigator.onLine && !offline[a.id]) toast('Aluetta ei ole tallennettu offline-käyttöön.');
        else toast('Alueen lataus epäonnistui: ' + e.message);
      });
  }

  // ---------------------------------------------------------------------------
  // Napautus: tiedot pisteestä
  // ---------------------------------------------------------------------------

  function closeInfo() {
    $('infoCard').hidden = true;
    if (S.tapMarker) { map.removeLayer(S.tapMarker); S.tapMarker = null; }
  }

  map.on('click', function (e) {
    if (!S.area) return;
    var ll = e.latlng;
    var info = null;
    if (S.forest) {
      var m = MK.lonLatToMerc(ll.lng, ll.lat);
      var i = MK.sampleIndex(S.forest, m[0], m[1]);
      if (i >= 0) info = MK.describe(S.forest.code[i], S.forest.ht[i], settings.oldAge, settings.taimikkoM);
    }
    var prots = [];
    if (S.protectedGJ) (S.protectedGJ.features || []).forEach(function (f) {
      if (MK.geometryContains(f.geometry, ll.lng, ll.lat)) prots.push(f.properties || {});
    });
    var inside = false;
    if (S.boundaryGJ) (S.boundaryGJ.features || []).forEach(function (f) {
      if (MK.geometryContains(f.geometry, ll.lng, ll.lat)) inside = true;
    });
    showInfo(ll, info, prots, inside);
  });

  function showInfo(ll, info, prots, inside) {
    var card = $('infoCard');
    var C = MK.COLORS, color = null;
    if (info) color = info.kind === 'treeless' ? C.treeless : (info.kind === 'old' ? C.old : MK.ageColor(info.age, settings.oldAge));
    var title = info ? info.title : (inside ? 'Ei metsätietoa' : 'Lupa-alueen ulkopuolella');
    var html = '<div class="info-row">' +
      (color ? '<span class="sw" style="background:' + MK.cssRGB(color) + '"></span>' : '') +
      '<div><div class="info-title">' + esc(title) + '</div>' +
      (info ? '<div class="info-detail">' + esc(info.detail) + '</div>' : (inside ? '<div class="info-detail muted">Pelto, vesi tai muu kuin metsätalousmaa</div>' : '')) +
      '</div><button type="button" class="info-close" aria-label="Sulje"><svg viewBox="0 0 24 24"><path d="M6 6l12 12M18 6L6 18" stroke="currentColor" stroke-width="2.4" stroke-linecap="round"/></svg></button></div>';
    var extra = [];
    prots.forEach(function (p) {
      extra.push('<div class="tag"><span class="sw sw-dash"></span><span><b>Suojelualue</b>' +
        (p.nimi ? ': ' + esc(p.nimi) : '') + (p.tyyppi ? ' <span class="muted">(' + esc(p.tyyppi) + ')</span>' : '') + '</span></div>');
    });
    if (info && !inside) extra.push('<div class="warn-text">Lupa-alueen ulkopuolella</div>');
    if (extra.length) html += '<div class="info-extra">' + extra.join('') + '</div>';
    var meta = [ll.lat.toFixed(5).replace('.', ',') + ' N, ' + ll.lng.toFixed(5).replace('.', ',') + ' E'];
    if (S.pos) {
      var d = map.distance(ll, L.latLng(S.pos.coords.latitude, S.pos.coords.longitude));
      meta.push('Sinusta ' + (d < 1000 ? fmtInt(d) + ' m' : (d / 1000).toFixed(1).replace('.', ',') + ' km'));
    }
    if (info) meta.push('Satelliittiarvio 16 m ruudusta');
    html += '<div class="info-meta">' + meta.map(function (m) { return '<span>' + esc(m) + '</span>'; }).join('') + '</div>';
    card.innerHTML = html;
    card.hidden = false;
    card.querySelector('.info-close').addEventListener('click', closeInfo);
    if (S.tapMarker) map.removeLayer(S.tapMarker);
    S.tapMarker = L.marker(ll, { interactive: false, keyboard: false,
      icon: L.divIcon({ className: '', html: '<div class="tap-marker"></div>', iconSize: [0, 0] }) }).addTo(map);
  }

  // ---------------------------------------------------------------------------
  // Oma sijainti
  // ---------------------------------------------------------------------------

  function meIcon(heading) {
    var arrow = (heading === null || heading === undefined || isNaN(heading)) ? '' :
      '<div class="me-arrow" style="transform:rotate(' + Math.round(heading) + 'deg)"></div>';
    return L.divIcon({ className: 'me-marker', html: arrow + '<div class="me-dot"></div>', iconSize: [0, 0] });
  }

  function onPos(p) {
    S.pos = p;
    var ll = L.latLng(p.coords.latitude, p.coords.longitude);
    var acc = p.coords.accuracy || 0;
    var heading = (p.coords.speed && p.coords.speed > 0.6) ? p.coords.heading : null;
    if (!S.layers.me) {
      S.layers.meAcc = L.circle(ll, { radius: acc, color: '#ff7a1a', weight: 1.5, opacity: 0.9, fillColor: '#ff7a1a', fillOpacity: 0.12, interactive: false }).addTo(map);
      S.layers.me = L.marker(ll, { icon: meIcon(heading), interactive: false, keyboard: false, zIndexOffset: 1000 }).addTo(map);
    } else {
      S.layers.meAcc.setLatLng(ll).setRadius(acc);
      S.layers.me.setLatLng(ll).setIcon(meIcon(heading));
    }
    var chip = $('gpsChip');
    chip.hidden = false;
    chip.className = 'chip chip-gps';
    chip.textContent = 'GPS ±' + fmtInt(acc) + ' m';
    if (S.firstFix || S.follow) {
      map.setView(ll, S.firstFix ? Math.max(map.getZoom(), 15) : map.getZoom(), { animate: !S.firstFix });
      S.firstFix = false;
    }
  }

  function onPosErr(err) {
    if (err.code === 1) {
      toast('Sijaintilupa evätty. Salli sijainti selaimen tai puhelimen asetuksista.', null, 7000);
      stopWatch();
    } else if (err.code === 2) {
      toast('Sijaintia ei saatu. Onko GPS päällä?');
    }
  }

  function startWatch() {
    if (!navigator.geolocation) { toast('Laite ei tue sijaintia.'); return; }
    if (S.watchId !== null) return;
    S.firstFix = true;
    S.watchId = navigator.geolocation.watchPosition(onPos, onPosErr, { enableHighAccuracy: true, maximumAge: 3000, timeout: 30000 });
    settings.gpsOn = true; saveSettings();
    $('locateBtn').setAttribute('aria-pressed', 'true');
    var chip = $('gpsChip');
    chip.hidden = false; chip.className = 'chip'; chip.textContent = 'Haetaan GPS…';
  }

  function stopWatch() {
    if (S.watchId !== null) navigator.geolocation.clearWatch(S.watchId);
    S.watchId = null; S.pos = null;
    setFollow(false);
    ['me', 'meAcc'].forEach(function (k) { if (S.layers[k]) { map.removeLayer(S.layers[k]); S.layers[k] = null; } });
    $('gpsChip').hidden = true;
    $('locateBtn').setAttribute('aria-pressed', 'false');
    settings.gpsOn = false; saveSettings();
  }

  function setFollow(on) {
    S.follow = on;
    $('locateBtn').classList.toggle('follow', on);
  }

  $('locateBtn').addEventListener('click', function () {
    if (S.watchId === null) { startWatch(); setFollow(true); return; }
    if (!S.follow) {
      setFollow(true);
      if (S.pos) map.setView([S.pos.coords.latitude, S.pos.coords.longitude], Math.max(map.getZoom(), 14));
      return;
    }
    stopWatch();
    toast('Sijainti pois päältä.');
  });

  // Näyttö päällä maastossa (valinnainen)
  function applyWakeLock() {
    if (settings.wakeLock && 'wakeLock' in navigator && document.visibilityState === 'visible') {
      if (S.wakeLock) return;
      navigator.wakeLock.request('screen').then(function (l) {
        S.wakeLock = l;
        l.addEventListener('release', function () { S.wakeLock = null; });
      }).catch(function () { /* ei tuettu */ });
    } else if (!settings.wakeLock && S.wakeLock) {
      S.wakeLock.release(); S.wakeLock = null;
    }
  }
  document.addEventListener('visibilitychange', applyWakeLock);

  // ---------------------------------------------------------------------------
  // Offline-tallennus
  // ---------------------------------------------------------------------------

  function offlineLayers() {
    if (!(settings.apiKey || '').trim()) return [];
    return settings.offlineOrtho ? ['maastokartta', 'ortokuva'] : ['maastokartta'];
  }

  function estimate(a) {
    var layers = offlineLayers(), n = 0, bytes = a.bytes || 0;
    var count = MK.countTiles(a.forest.bounds, OFFLINE_ZMIN, settings.maxZoom, TILE_PAD_DEG);
    layers.forEach(function (l) { n += count; bytes += count * MML_LAYERS[l].estKB * 1000; });
    return { tiles: n, bytes: bytes };
  }

  function tileKey(layer, z, x, y) { return mmlTemplate(layer).replace('{z}', z).replace('{y}', y).replace('{x}', x); }

  function requestPersist() {
    if (navigator.storage && navigator.storage.persist) return navigator.storage.persist().catch(function () { return false; });
    return Promise.resolve(false);
  }

  function downloadArea(a, ui) {
    if (S.dl) { toast('Tallennus on jo käynnissä.'); return; }
    if (!navigator.onLine) { toast('Tallentaminen vaatii verkkoyhteyden.'); return; }
    var est = estimate(a);
    if (est.bytes > BIG_DOWNLOAD_MB * 1e6 &&
        !confirm('Tallennus on iso (n. ' + fmtMB(est.bytes) + '). Voit pienentää sitä asetuksista valitsemalla tarkkuuden 15. Jatketaanko?')) return;

    var key = (settings.apiKey || '').trim();
    var layers = offlineLayers();
    var tiles = [];
    layers.forEach(function (l) {
      MK.listTiles(a.forest.bounds, OFFLINE_ZMIN, settings.maxZoom, TILE_PAD_DEG).forEach(function (t) { tiles.push([l, t[0], t[1], t[2]]); });
    });
    var job = { ctrl: new AbortController(), done: 0, failed: 0, total: tiles.length + 3, authFail: 0, corsFail: 0, ok: 0, areaId: a.id, ui: ui };
    S.dl = job;
    job.ui.start(job);

    var dataUrls = [a.forest.file, a.boundary, a.protected].map(absUrl);
    var dataCache, tileCache;

    requestPersist()
      .then(function () { return caches.open(DATA_CACHE); })
      .then(function (dc) {
        dataCache = dc;
        return dc.keys().then(function (keys) {
          var prefix = absUrl('data/' + a.id + '/');
          return Promise.all(keys.filter(function (k) {
            return k.url.indexOf(prefix) === 0 && dataUrls.indexOf(k.url) < 0;
          }).map(function (k) { return dc.delete(k); }));
        });
      })
      .then(function () {
        return dataUrls.reduce(function (p, u) {
          return p.then(function () {
            return fetch(u, { cache: 'no-cache', signal: job.ctrl.signal }).then(function (r) {
              if (!r.ok) throw new Error('Tiedostoa ei saatu (' + r.status + ')');
              return dataCache.put(u, r);
            }).then(function () { job.done++; job.ui.update(job); });
          });
        }, Promise.resolve());
      })
      .then(function () { return caches.open(TILE_CACHE); })
      .then(function (tc) {
        tileCache = tc;
        var i = 0;
        function worker() {
          if (job.ctrl.signal.aborted) return Promise.resolve();
          if (i >= tiles.length) return Promise.resolve();
          var t = tiles[i++];
          var k = tileKey(t[0], t[1], t[2], t[3]);
          return tileCache.match(k).then(function (hit) {
            if (hit) return;
            return fetchTile(mmlTileUrl(t[0], t[1], t[2], t[3], key), job, 0).then(function (r) {
              if (r) return tileCache.put(k, r);
            });
          }).then(function () {
            job.done++;
            if (job.done % 10 === 0 || job.done === job.total) job.ui.update(job);
            if (job.authFail >= 5 && job.ok === 0) {
              job.ctrl.abort();
              throw new Error('Maanmittauslaitos hylkäsi API-avaimen. Tarkista avain asetuksista.');
            }
            if (job.corsFail >= 8 && job.ok === 0) {
              job.ctrl.abort();
              throw new Error('Karttatiilien tallennus estettiin (CORS). Metsätieto tallentui, maastokartta ei.');
            }
            return worker();
          });
        }
        var ws = [];
        for (var w = 0; w < CONCURRENCY; w++) ws.push(worker());
        return Promise.all(ws);
      })
      .then(function () {
        if (job.ctrl.signal.aborted) throw new Error('Keskeytetty');
        offline[a.id] = { version: a.version, date: Date.now(), maxZoom: settings.maxZoom, layers: layers, tiles: tiles.length, failed: job.failed };
        saveOffline();
        S.dl = null;
        job.ui.finish(null, job);
        if (S.area && S.area.id === a.id) selectArea(a.id, { keepView: true });
      })
      .catch(function (e) {
        S.dl = null;
        if (e && e.message !== 'Keskeytetty' && e.name !== 'AbortError') console.error(e);
        // Metsätieto on tallessa, vaikka tiilet epäonnistuisivat.
        if (dataCache && job.done >= 3 && !offline[a.id]) {
          offline[a.id] = { version: a.version, date: Date.now(), maxZoom: settings.maxZoom, layers: [], tiles: 0, failed: tiles.length, partial: true };
          saveOffline();
        }
        job.ui.finish(e, job);
      });
  }

  function fetchTile(url, job, attempt) {
    return fetch(url, { mode: 'cors', credentials: 'omit', signal: job.ctrl.signal }).then(function (r) {
      if (r.ok) { job.ok++; return r; }
      if (r.status === 401 || r.status === 403) job.authFail++;
      if (r.status >= 500 && attempt < 2) return wait(800 * (attempt + 1)).then(function () { return fetchTile(url, job, attempt + 1); });
      job.failed++;
      return null;
    }, function (err) {
      if (job.ctrl.signal.aborted) throw err;
      if (attempt < 2) return wait(800 * (attempt + 1)).then(function () { return fetchTile(url, job, attempt + 1); });
      if (err instanceof TypeError) job.corsFail++;
      job.failed++;
      return null;
    });
  }
  function wait(ms) { return new Promise(function (r) { setTimeout(r, ms); }); }

  function removeOffline(a) {
    var rec = offline[a.id];
    var keep = {};
    Object.keys(offline).forEach(function (id) {
      if (id === a.id) return;
      var o = offline[id], other = findArea(id);
      if (!o || !other) return;
      (o.layers || []).forEach(function (l) {
        MK.listTiles(other.forest.bounds, OFFLINE_ZMIN, o.maxZoom || 16, TILE_PAD_DEG).forEach(function (t) { keep[tileKey(l, t[0], t[1], t[2])] = 1; });
      });
    });
    return caches.open(TILE_CACHE).then(function (tc) {
      var dels = [];
      ((rec && rec.layers) || []).forEach(function (l) {
        MK.listTiles(a.forest.bounds, OFFLINE_ZMIN, (rec && rec.maxZoom) || 16, TILE_PAD_DEG).forEach(function (t) {
          var k = tileKey(l, t[0], t[1], t[2]);
          if (!keep[k]) dels.push(tc.delete(k));
        });
      });
      return Promise.all(dels);
    }).then(function () { return caches.open(DATA_CACHE); })
      .then(function (dc) {
        var prefix = absUrl('data/' + a.id + '/');
        return dc.keys().then(function (keys) {
          return Promise.all(keys.filter(function (k) { return k.url.indexOf(prefix) === 0; }).map(function (k) { return dc.delete(k); }));
        });
      })
      .then(function () { delete offline[a.id]; saveOffline(); });
  }

  function clearAllOffline() {
    return Promise.all([caches.delete(TILE_CACHE), caches.delete(DATA_CACHE)]).then(function () { offline = {}; saveOffline(); });
  }

  // ---------------------------------------------------------------------------
  // Alapaneelit
  // ---------------------------------------------------------------------------

  var currentSheet = null;
  function openSheet(name, title, render) {
    currentSheet = { name: name, render: render };
    $('sheetTitle').textContent = title;
    $('backdrop').hidden = false;
    $('sheet').hidden = false;
    renderSheet();
  }
  function renderSheet() {
    if (!currentSheet) return;
    var body = $('sheetBody');
    var scroll = body.scrollTop;
    body.innerHTML = '';
    currentSheet.render(body);
    body.scrollTop = scroll;
  }
  function closeSheet() {
    if (S.dl && currentSheet && currentSheet.name === 'areas') { /* lataus jatkuu taustalla */ }
    currentSheet = null;
    $('sheet').hidden = true;
    $('backdrop').hidden = true;
  }
  $('sheetClose').addEventListener('click', closeSheet);
  $('backdrop').addEventListener('click', closeSheet);
  document.addEventListener('keydown', function (e) { if (e.key === 'Escape') { closeSheet(); closeInfo(); } });

  // --- Alueet ---
  function renderAreasSheet(body) {
    if (!isStandalone()) {
      body.appendChild(h('div', { class: 'notice', html: isIOS()
        ? '<b>Lisää sovellus kotinäytölle</b>, jotta tallennetut kartat säilyvät: Safari → Jaa → <i>Lisää Koti-valikkoon</i>.'
        : '<b>Asenna sovellus</b>, jotta tallennetut kartat säilyvät: selaimen valikko → <i>Asenna sovellus</i> tai <i>Lisää aloitusnäytölle</i>.' }));
    }
    if (!(settings.apiKey || '').trim()) {
      body.appendChild(h('div', { class: 'notice', html: 'Maastokartan offline-tallennus vaatii Maanmittauslaitoksen API-avaimen. ' +
        'Lisää se <a href="#" data-open-settings>asetuksissa</a>. Ilman avainta tallentuu vain metsätieto.' }));
    }
    if (!S.areas.length) {
      body.appendChild(h('p', { class: 'muted', text: 'Alueita ei ole vielä. Lisää aluerajaus repon areas/-kansioon, niin kartta valmistuu muutamassa minuutissa.' }));
      return;
    }
    S.areas.forEach(function (a) { body.appendChild(areaCard(a)); });
    var gen = S.index && S.index.generated;
    if (gen) body.appendChild(h('p', { class: 'muted small', text: 'Kartat päivitetty ' + fmtDate(Date.parse(gen)) + ' · Metsätieto MVMI ' + (S.index.mvmiYear || '') }));
  }

  function areaCard(a) {
    var rec = offline[a.id];
    var active = S.area && S.area.id === a.id;
    var card = h('div', { class: 'area-card' + (active ? ' active' : '') });
    var sub = fmtInt(a.areaHa) + ' ha' + (a.protectedCount ? ' · ' + a.protectedCount + ' suojelualue' + (a.protectedCount === 1 ? '' : 'tta') : '');
    card.appendChild(h('button', { type: 'button', class: 'area-main', onclick: function () { closeSheet(); selectArea(a.id); } },
      h('div', { class: 'area-title', text: a.name }), h('div', { class: 'area-sub', text: sub })));

    var foot = h('div', { class: 'area-offline' });
    var est = estimate(a);
    var status;
    if (rec && rec.version !== a.version) status = h('span', { class: 'status status-warn', text: 'Päivitys saatavilla' });
    else if (rec && rec.partial) status = h('span', { class: 'status status-warn', text: 'Tallennettu ilman maastokarttaa' });
    else if (rec) status = h('span', { class: 'status status-ok', text: '✓ Tallennettu ' + fmtDate(rec.date) + (rec.layers && rec.layers.length ? ' · tarkkuus ' + rec.maxZoom : ' · vain metsätieto') + (rec.failed ? ' · ' + rec.failed + ' tiiltä puuttuu' : '') });
    else status = h('span', { class: 'status muted', text: 'Ei tallennettu offline-käyttöön' });
    foot.appendChild(status);

    var row = h('div', { class: 'btn-row' });
    var progress = h('div', { class: 'progress', hidden: true },
      h('div', { class: 'progress-bar' }, h('span')),
      h('div', { class: 'progress-text' }, h('span', { class: 'pt' }), h('button', { type: 'button', class: 'btn', text: 'Keskeytä',
        onclick: function () { if (S.dl) S.dl.ctrl.abort(); } })));
    var ui = {
      start: function (job) { row.hidden = true; progress.hidden = false; ui.update(job); },
      update: function (job) {
        var p = Math.min(100, Math.round(100 * job.done / job.total));
        progress.querySelector('.progress-bar span').style.width = p + '%';
        progress.querySelector('.pt').textContent = p + ' % · ' + fmtInt(job.done) + ' / ' + fmtInt(job.total);
      },
      finish: function (err, job) {
        if (err) toast(err.name === 'AbortError' || err.message === 'Keskeytetty' ? 'Tallennus keskeytetty.' : err.message, null, 8000);
        else toast('Tallennettu: ' + a.name + (job.failed ? ' (' + job.failed + ' tiiltä epäonnistui, yritä uudelleen)' : ''));
        if (currentSheet && currentSheet.name === 'areas') renderSheet();
      }
    };
    if (S.dl && S.dl.areaId === a.id) {
      S.dl.ui = ui;
      row.hidden = true; progress.hidden = false;
      setTimeout(function () { if (S.dl) ui.update(S.dl); }, 0);
    } else if (S.dl) row.appendChild(h('span', { class: 'muted small', text: 'Toinen tallennus käynnissä…' }));
    else if (!rec || rec.version !== a.version || rec.partial || rec.failed) {
      var label = rec ? (rec.version !== a.version ? 'Päivitä' : 'Täydennä') : 'Tallenna offline';
      row.appendChild(h('button', { type: 'button', class: 'btn btn-primary', text: label + ' (n. ' + fmtMB(est.bytes) + ')',
        onclick: function () { downloadArea(a, ui); } }));
    }
    if (rec && !S.dl) row.appendChild(h('button', { type: 'button', class: 'btn btn-danger', text: 'Poista',
      onclick: function () { removeOffline(a).then(function () { toast('Offline-tiedot poistettu.'); renderSheet(); }); } }));
    foot.appendChild(row);
    foot.appendChild(progress);
    card.appendChild(foot);
    return card;
  }

  // --- Karttatasot ---
  function renderLayersSheet(body) {
    var hasKey = !!(settings.apiKey || '').trim();
    body.appendChild(h('h3', { text: 'Pohjakartta' }));
    var seg = h('div', { class: 'seg', role: 'group', 'aria-label': 'Pohjakartta' });
    [['maastokartta', 'Maastokartta'], ['ortokuva', 'Ilmakuva'], ['osm', 'OpenStreetMap']].forEach(function (o) {
      var on = hasKey ? settings.basemap === o[0] : o[0] === 'osm';
      seg.appendChild(h('button', { type: 'button', 'aria-pressed': String(on), disabled: !hasKey && o[0] !== 'osm', text: o[1],
        onclick: function () { settings.basemap = o[0]; saveSettings(); setBasemap(); renderSheet(); } }));
    });
    body.appendChild(seg);
    if (!hasKey) body.appendChild(h('p', { class: 'muted small', text: 'Maastokartta ja ilmakuva vaativat MML:n API-avaimen. OpenStreetMap toimii vain verkossa.' }));
    else if (settings.basemap === 'ortokuva' && !settings.offlineOrtho) body.appendChild(h('p', { class: 'muted small', text: 'Ilmakuvaa ei tallenneta offline-käyttöön, ellei sitä valita asetuksista.' }));

    body.appendChild(h('h3', { text: 'Metsän ikä' }));
    body.appendChild(toggleRow('Näytä metsän ikä', null, settings.showForest, function (v) { settings.showForest = v; saveSettings(); applyLayerVisibility(); }));
    var range = h('input', { type: 'range', min: '0.2', max: '1', step: '0.05', value: String(settings.opacity), 'aria-label': 'Läpinäkyvyys' });
    range.addEventListener('input', function () { settings.opacity = Number(range.value); forestLayer.setOpacity(settings.opacity); });
    range.addEventListener('change', saveSettings);
    body.appendChild(h('div', { class: 'field' }, h('span', { class: 'label', text: 'Peittävyys' }), range));

    body.appendChild(h('h3', { text: 'Muut tasot' }));
    body.appendChild(toggleRow('Luonnonsuojelualueet', 'Katkoviiva', settings.showProtected, function (v) { settings.showProtected = v; saveSettings(); applyLayerVisibility(); }));
    body.appendChild(toggleRow('Himmennä lupa-alueen ulkopuoli', null, settings.showMask, function (v) { settings.showMask = v; saveSettings(); applyLayerVisibility(); }));
  }

  function toggleRow(label, hint, value, onChange) {
    var input = h('input', { type: 'checkbox', role: 'switch' });
    input.checked = !!value;
    input.addEventListener('change', function () { onChange(input.checked); });
    return h('label', { class: 'toggle' }, h('span', null, label, hint ? h('small', { text: hint }) : null), h('span', { class: 'switch' }, input, h('i')));
  }

  // --- Asetukset ---
  function renderSettingsSheet(body) {
    body.appendChild(h('h3', { text: 'Maanmittauslaitos' }));
    var keyInput = h('input', { class: 'input', type: 'password', autocomplete: 'off', autocapitalize: 'off', spellcheck: 'false', value: settings.apiKey, id: 'apiKey', placeholder: 'API-avain' });
    var show = h('button', { type: 'button', class: 'btn', text: 'Näytä', onclick: function () {
      keyInput.type = keyInput.type === 'password' ? 'text' : 'password'; show.textContent = keyInput.type === 'password' ? 'Näytä' : 'Piilota'; } });
    keyInput.addEventListener('change', function () {
      settings.apiKey = keyInput.value.trim(); if (settings.apiKey && settings.basemap === 'osm') settings.basemap = 'maastokartta';
      saveSettings(); setBasemap(); toast('API-avain tallennettu tähän laitteeseen.');
    });
    body.appendChild(h('div', { class: 'field' },
      h('label', { for: 'apiKey', text: 'API-avain' }),
      h('div', { class: 'input-row' }, keyInput, show),
      h('span', { class: 'hint', html: 'Avain tallentuu vain tähän laitteeseen. <a href="https://www.maanmittauslaitos.fi/rajapinnat/api-avaimen-ohje" target="_blank" rel="noopener">Näin saat avaimen</a>.' })));

    body.appendChild(h('h3', { text: 'Värit' }));
    body.appendChild(numberField('oldAge', 'Vanhan metsän raja (v)', settings.oldAge, 20, 250, 5, 'Vähintään tämän ikäinen metsä näkyy sinisenä.', function (v) { settings.oldAge = v; }));
    body.appendChild(numberField('taimikkoM', 'Taimikon pituusraja (m)', settings.taimikkoM, 1, 15, 0.5, 'Tätä matalampi metsä merkitään vinoviivoin.', function (v) { settings.taimikkoM = v; }));

    body.appendChild(h('h3', { text: 'Offline-tallennus' }));
    var seg = h('div', { class: 'seg', role: 'group', 'aria-label': 'Tarkkuus' });
    [[15, 'Tarkkuus 15 (kevyt)'], [16, 'Tarkkuus 16 (tarkin)']].forEach(function (o) {
      seg.appendChild(h('button', { type: 'button', 'aria-pressed': String(settings.maxZoom === o[0]), text: o[1],
        onclick: function () { settings.maxZoom = o[0]; saveSettings(); renderSheet(); } }));
    });
    body.appendChild(h('div', { class: 'field' }, h('span', { class: 'label', text: 'Maastokartan tarkkuus' }), seg,
      h('span', { class: 'hint', text: 'Taso 16 on tarkin avoimesti saatava. Taso 15 vie noin neljänneksen tilasta.' })));
    body.appendChild(toggleRow('Tallenna myös ilmakuva', 'Noin kaksinkertaistaa tilantarpeen', settings.offlineOrtho, function (v) { settings.offlineOrtho = v; saveSettings(); }));
    body.appendChild(toggleRow('Pidä näyttö päällä', 'Kuluttaa akkua', settings.wakeLock, function (v) { settings.wakeLock = v; saveSettings(); applyWakeLock(); }));

    var storageP = h('p', { class: 'muted small', text: 'Lasketaan tallennustilaa…' });
    body.appendChild(h('h3', { text: 'Tallennustila' }));
    body.appendChild(storageP);
    if (navigator.storage && navigator.storage.estimate) {
      navigator.storage.estimate().then(function (e) {
        storageP.textContent = 'Käytössä ' + fmtMB(e.usage || 0) + (e.quota ? ' / saatavilla ' + fmtMB(e.quota) : '');
      });
    } else storageP.textContent = '';
    body.appendChild(h('button', { type: 'button', class: 'btn btn-danger', text: 'Poista kaikki offline-kartat', onclick: function () {
      if (confirm('Poistetaanko kaikki tallennetut kartat tästä laitteesta?')) clearAllOffline().then(function () { toast('Offline-kartat poistettu.'); renderSheet(); });
    } }));

    body.appendChild(h('h3', { text: 'Tietolähteet' }));
    var attrib = (S.index && S.index.attribution) || [];
    body.appendChild(h('div', { class: 'sources', html:
      '<p>' + attrib.map(esc).join('<br>') + '</p>' +
      '<p>Pohjakartta: © Maanmittauslaitos (CC BY 4.0) tai © OpenStreetMapin tekijät.</p>' +
      '<p>Metsätieto on satelliittikuviin perustuva arvio. Yksittäisen 16 m ruudun arvo voi poiketa todellisuudesta, mutta isompien kuvioiden yleiskuva on luotettavampi. ' +
      'Lupa-alueen raja on käsin piirretty: virallinen raja on eräluvat.fi:n kartassa.</p>' +
      '<p>Sijaintisi käsitellään vain tässä laitteessa eikä sitä lähetetä minnekään.</p>' }));
  }

  function numberField(id, label, value, min, max, step, hint, set) {
    var input = h('input', { class: 'input', type: 'number', inputmode: 'decimal', id: id, min: String(min), max: String(max), step: String(step), value: String(value) });
    input.addEventListener('change', function () {
      var v = Number(String(input.value).replace(',', '.'));
      if (!isFinite(v)) return;
      v = Math.max(min, Math.min(max, v));
      input.value = String(v);
      set(v); saveSettings(); refreshForest();
    });
    return h('div', { class: 'field' }, h('label', { for: id, text: label }), input, h('span', { class: 'hint', text: hint }));
  }

  $('areaBtn').addEventListener('click', function () { openSheet('areas', 'Lupa-alueet', renderAreasSheet); });
  $('layersBtn').addEventListener('click', function () { openSheet('layers', 'Karttatasot', renderLayersSheet); });
  $('settingsBtn').addEventListener('click', function () { openSheet('settings', 'Asetukset', renderSettingsSheet); });
  $('zoomInBtn').addEventListener('click', function () { map.zoomIn(); });
  $('zoomOutBtn').addEventListener('click', function () { map.zoomOut(); });
  $('sheetBody').addEventListener('click', function (e) {
    var t = e.target.closest('[data-open-settings]');
    if (t) { e.preventDefault(); openSheet('settings', 'Asetukset', renderSettingsSheet); }
  });

  // ---------------------------------------------------------------------------
  // Verkon tila ja service worker
  // ---------------------------------------------------------------------------

  function updateNet() { $('netChip').hidden = navigator.onLine; }
  window.addEventListener('online', updateNet);
  window.addEventListener('offline', updateNet);
  updateNet();

  if ('serviceWorker' in navigator) {
    var hadController = !!navigator.serviceWorker.controller;
    navigator.serviceWorker.register('sw.js').catch(function (e) { console.warn('SW-rekisteröinti epäonnistui', e); });
    navigator.serviceWorker.addEventListener('controllerchange', function () {
      if (hadController) toast('Sovellus päivitetty.', { label: 'Lataa uudelleen', fn: function () { location.reload(); } });
      hadController = true;
    });
  }

  // ---------------------------------------------------------------------------
  // Käynnistys
  // ---------------------------------------------------------------------------

  setBasemap();
  renderLegend();
  if (settings.wakeLock) applyWakeLock();

  loadIndex().then(function () {
    var last = store.get('lastArea', null);
    if (S.index && S.index.attribution) {
      forestLayer.options.attribution = S.index.attribution.join(' · ');
    }
    if (last && findArea(last)) selectArea(last, { keepView: true });
    else if (S.areas.length === 1) selectArea(S.areas[0].id);
    else openSheet('areas', 'Lupa-alueet', renderAreasSheet);
    // Päivitysilmoitus tallennetuille alueille
    var stale = S.areas.filter(function (a) { return offline[a.id] && offline[a.id].version !== a.version; });
    if (stale.length && navigator.onLine) toast('Karttapäivitys saatavilla: ' + stale.map(function (a) { return a.name; }).join(', '),
      { label: 'Näytä', fn: function () { openSheet('areas', 'Lupa-alueet', renderAreasSheet); } });
    if (settings.gpsOn) startWatch();
  });

  // Testejä varten
  window.__mk = { S: S, settings: settings, map: map, selectArea: selectArea, offline: function () { return offline; } };
})();
