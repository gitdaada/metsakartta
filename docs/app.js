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
    apiKey: '', basemap: 'maastokartta', oldAge: 80, taimikkoM: 7, treelessM: 0.5, maxZoom: 16, offlineOrtho: false,
    wakeLock: false, opacity: 0.7, showForest: true, showProtected: true, showMask: true, gpsOn: false,
    showWind: true, fanLengthM: 200, showRain: true, showCuts: true,
    mmlBase: ''
  };
  function num(v, d, min, max) { v = Number(v); return isFinite(v) ? Math.max(min, Math.min(max, v)) : d; }
  function sanitizeSettings(raw) {
    var s = Object.assign({}, DEFAULTS, raw && typeof raw === 'object' ? raw : {});
    s.apiKey = typeof s.apiKey === 'string' ? s.apiKey.replace(/[^A-Za-z0-9._~-]/g, '') : '';
    s.basemap = ['maastokartta', 'ortokuva', 'osm'].indexOf(s.basemap) >= 0 ? s.basemap : DEFAULTS.basemap;
    s.oldAge = Math.round(num(s.oldAge, DEFAULTS.oldAge, 20, 250));
    s.taimikkoM = num(s.taimikkoM, DEFAULTS.taimikkoM, 1, 15);
    s.treelessM = num(s.treelessM, DEFAULTS.treelessM, 0, 3);
    s.maxZoom = s.maxZoom === 15 ? 15 : 16;
    s.opacity = num(s.opacity, DEFAULTS.opacity, 0.2, 1);
    ['offlineOrtho', 'wakeLock', 'showForest', 'showProtected', 'showMask', 'gpsOn', 'showWind', 'showRain', 'showCuts'].forEach(function (k) { s[k] = !!s[k]; });
    s.fanLengthM = [100, 200, 300, 500].indexOf(Number(s.fanLengthM)) >= 0 ? Number(s.fanLengthM) : DEFAULTS.fanLengthM;
    s.mmlBase = typeof s.mmlBase === 'string' ? s.mmlBase : '';
    return s;
  }
  var settings = sanitizeSettings(store.get('settings', {}));
  function saveSettings() { store.set('settings', settings); }

  var offline = store.get('offline', {}); // { areaId: {version, date, maxZoom, layers, tiles, failed} }
  function saveOffline() { store.set('offline', offline); }

  var S = {
    index: null, areas: [], area: null, forest: null, stats: null,
    boundaryGJ: null, protectedGJ: null, cutsGJ: null, layers: {}, base: null,
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

  // Kartan voi kääntää kahdella sormella (leaflet-rotate). Pohjoinen palautetaan kompassipainikkeesta.
  var CAN_ROTATE = typeof L.Map.prototype.setBearing === 'function';
  var map = L.map('map', { zoomControl: false, maxZoom: 18, minZoom: 4, attributionControl: true, zoomSnap: 0.5,
    rotate: CAN_ROTATE, touchRotate: CAN_ROTATE, shiftKeyRotate: CAN_ROTATE, rotateControl: false, compassBearing: false, bearing: 0 });
  map.attributionControl.setPrefix(false);
  map.setView(store.get('view', { c: [64.0, 26.5], z: 5 }).c, store.get('view', { c: [64.0, 26.5], z: 5 }).z);
  function bearing() { return CAN_ROTATE && map.getBearing ? map.getBearing() || 0 : 0; }
  // Omat tasot kääntyvät kartan mukana (rotatePane); tuuliviuhka piirretään näytön koordinaateissa.
  function makePane(name, z, fixed) {
    var parent = CAN_ROTATE ? map.getPane(fixed ? 'norotatePane' : 'rotatePane') : undefined;
    map.createPane(name, parent).style.zIndex = z;
  }
  makePane('maskPane', 300);
  makePane('forestPane', 350);
  makePane('cutsPane', 400);
  makePane('protCasingPane', 410);
  makePane('protPane', 420);
  makePane('boundaryPane', 430);
  makePane('rainPane', 380);
  makePane('windPane', 435, true);
  L.control.scale({ imperial: false, position: 'bottomleft' }).addTo(map);

  map.on('moveend', function () {
    var c = map.getCenter();
    store.set('view', { c: [Number(c.lat.toFixed(5)), Number(c.lng.toFixed(5))], z: map.getZoom() });
  });
  map.on('dragstart', function () { if (S.follow) setFollow(false); });

  // Testikäyttöön: vaihtoehtoinen karttapalvelin hyväksytään vain, kun sovellus itse ajetaan paikallisesti.
  function mmlBase() {
    var local = /^(localhost|127\.0\.0\.1)$/.test(location.hostname);
    if (local && /^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?\//.test(settings.mmlBase)) return settings.mmlBase.replace(/\/$/, '');
    return MML_BASE;
  }
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
        attribution: '© <a href="https://www.maanmittauslaitos.fi" target="_blank" rel="noopener">MML</a>'
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
        treelessCode: Math.round(settings.treelessM * 5),
        hatchPeriod: 9, hatchWidth: 2,
        hatchColor: MK.packRGBA(hc[0], hc[1], hc[2], 255)
      };
    }
    return S.renderOpts;
  }
  function refreshForest() {
    S.renderOpts = null;
    if (S.forest) S.stats = MK.stats(S.forest, settings.oldAge, Math.round(settings.taimikkoM * 5), Math.round(settings.treelessM * 5));
    forestLayer.redraw();
    renderLegend();
  }

  function applyLayerVisibility() {
    toggleLayer(forestLayer, settings.showForest && !!S.forest);
    toggleLayer(S.layers.protCasing, settings.showProtected);
    toggleLayer(S.layers.prot, settings.showProtected);
    toggleLayer(S.layers.cutsCasing, settings.showCuts);
    toggleLayer(S.layers.cuts, settings.showCuts);
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

  var legendOpen = false; // selite on oletuksena piilossa; avataan painikkeesta
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

  // Leaflet tunnistaa kartan ohi menevät napautukset elementin vanhemmista: sisältö vaihdetaan vasta
  // napautuksen jälkeen, ettei se päädy kartalle (ja avaa tietokorttia selitteen alta).
  function legendButton(btn, open) {
    L.DomEvent.on(btn, 'click', function (e) {
      L.DomEvent.stop(e);
      legendOpen = open;
      setTimeout(renderLegend, 0);
    });
  }

  function renderLegend() {
    var div = legend._div;
    if (!div) return;
    var C = MK.COLORS, oa = settings.oldAge;
    var grad = 'linear-gradient(90deg,' + MK.cssRGB(C.young) + ',' + MK.cssRGB(C.middle) + ')';
    var hatch = 'repeating-linear-gradient(135deg,' + MK.cssRGB(C.hatch) + ' 0 2px,' + MK.cssRGB(MK.ageColor(5, oa)) + ' 2px 7px)';
    div.classList.toggle('legend-closed', !legendOpen);
    if (!legendOpen) {
      div.innerHTML = '<button type="button" class="legend-fab" aria-label="Näytä selite" aria-expanded="false">' +
        '<svg viewBox="0 0 24 24" aria-hidden="true">' +
        '<rect x="2.5" y="3.5" width="6" height="4.5" rx="1" fill="' + MK.cssRGB(C.treeless) + '"/>' +
        '<rect x="2.5" y="9.75" width="6" height="4.5" rx="1" fill="' + MK.cssRGB(C.young) + '"/>' +
        '<rect x="2.5" y="16" width="6" height="4.5" rx="1" fill="' + MK.cssRGB(C.old) + '"/>' +
        '<path d="M11.5 5.75h10M11.5 12h10M11.5 18.25h10" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg></button>';
      legendButton(div.querySelector('.legend-fab'), true);
      return;
    }
    var html = '<div class="legend-head"><span>Selite</span><button type="button" class="legend-close" aria-label="Piilota selite" aria-expanded="true">' +
      '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M6 6l12 12M18 6L6 18" stroke="currentColor" stroke-width="2.4" stroke-linecap="round"/></svg></button></div>';
    {
      html += '<ul class="legend-list">' +
        '<li><span class="sw" style="background:' + MK.cssRGB(C.treeless) + '"></span><span>Puuton' + (settings.treelessM > 0 ? '<small>tai taimet alle ' + String(settings.treelessM).replace('.', ',') + ' m</small>' : '') + '</span></li>' +
        '<li><span class="sw" style="background:' + grad + '"></span><span>Metsä 0–' + (oa - 1) + ' v<small>vihreämpi = nuorempi</small></span></li>' +
        '<li><span class="sw" style="background:' + MK.cssRGB(C.old) + '"></span>Vanha metsä ≥ ' + oa + ' v</li>' +
        '<li><span class="sw" style="background:' + hatch + '"></span>Taimikko (alle ' + String(settings.taimikkoM).replace('.', ',') + ' m)</li>' +
        '<li><span class="sw sw-dash"></span>Luonnonsuojelualue</li>' +
        '<li><span class="sw sw-line"></span>Lupa-alueen raja</li>' +
        (settings.showWind ? '<li><span class="sw sw-wind"></span>Tuuliviuhka (hajusi kulku)</li>' : '') +
        (settings.showRain ? '<li><span class="sw sw-rain"></span><span>Sade 0–2 h<small>heikko → kova</small></span></li>' : '') +
        (settings.showCuts ? '<li><span class="sw sw-cut"></span><span>Uusi hakkuuaukko<small>' + ((S.index && S.index.mvmiYear) || 2023) + ' jälkeen, latvusmalli tai ilmakuva</small></span></li>' +
          '<li><span class="sw sw-cut-dash"></span><span>Hakkuuilmoitus<small>toteutuminen ei varmaa</small></span></li>' : '') +
        '</ul>';
      if (S.stats && S.stats.total) {
        var st = S.stats, forest = st.young + st.old;
        html += '<div class="legend-stats">Vanhaa metsää ' + pct(st.old, forest) + ' % metsästä · puutonta ' +
          pct(st.treeless, st.total) + ' % alasta</div>';
      }
    }
    div.innerHTML = html;
    legendButton(div.querySelector('.legend-close'), false);
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
    ['mask', 'mask2', 'boundaryCasing', 'boundary', 'protCasing', 'prot', 'cutsCasing', 'cuts'].forEach(function (k) {
      if (S.layers[k]) { map.removeLayer(S.layers[k]); S.layers[k] = null; }
    });
    S.forest = null; S.stats = null; S.cutsGJ = null;
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

    // Uudet hakkuut: tunnistettu aukko yhtenäisellä viivalla, pelkkä ilmoitus katkoviivalla.
    var cuts = S.cutsGJ || { type: 'FeatureCollection', features: [] };
    var cutColor = MK.cssRGB(MK.COLORS.treeless);
    S.layers.cutsCasing = L.geoJSON(cuts, { pane: 'cutsPane', interactive: false, style: function (f) {
      return isDetectedCut(f.properties) ? { color: '#ffffff', weight: 5.5, opacity: 0.8, fill: false } :
        { color: '#ffffff', weight: 4.5, opacity: 0.6, fill: false, dashArray: '8 6', lineCap: 'butt' };
    } });
    S.layers.cuts = L.geoJSON(cuts, { pane: 'cutsPane', interactive: false, attribution: 'Metsäkeskus', style: function (f) {
      return isDetectedCut(f.properties) ? { color: cutColor, weight: 2.5, opacity: 1, fillColor: cutColor, fillOpacity: 0.3 } :
        { color: cutColor, weight: 2.2, opacity: 1, dashArray: '8 6', lineCap: 'butt', fillColor: cutColor, fillOpacity: 0.06 };
    } });
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
    loadWindCache(a);
    updateWindUi();
    refreshWind(a);
    if (!opts.keepView) fitArea(a);
    var empty = function () { return { type: 'FeatureCollection', features: [] }; };
    return Promise.all([fetchJSON(a.boundary), fetchJSON(a.protected).catch(empty), a.cuts ? fetchJSON(a.cuts).catch(empty) : empty()])
      .then(function (res) {
        if (S.area !== a) return;
        S.boundaryGJ = res[0]; S.protectedGJ = res[1]; S.cutsGJ = res[2];
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
      if (i >= 0) info = MK.describe(S.forest.code[i], S.forest.ht[i], settings.oldAge, settings.taimikkoM, settings.treelessM);
    }
    var prots = [];
    if (S.protectedGJ) (S.protectedGJ.features || []).forEach(function (f) {
      if (MK.geometryContains(f.geometry, ll.lng, ll.lat)) prots.push(f.properties || {});
    });
    var inside = false;
    if (S.boundaryGJ) (S.boundaryGJ.features || []).forEach(function (f) {
      if (MK.geometryContains(f.geometry, ll.lng, ll.lat)) inside = true;
    });
    var cuts = [];
    if (S.cutsGJ && settings.showCuts) (S.cutsGJ.features || []).forEach(function (f) {
      if (MK.geometryContains(f.geometry, ll.lng, ll.lat)) cuts.push(f.properties || {});
    });
    showInfo(ll, info, prots, inside, cuts);
  });

  function isDetectedCut(p) { return !!p && p.lahde !== 'ilmoitus'; }
  var CUT_SOURCE = { latvusmalli: 'latvusmalli', ilmakuva: 'ilmakuva' };
  function cutSourceText(p) { return (CUT_SOURCE[p.lahde] || 'kaukokartoitus') + (p.vuosi ? ' ' + p.vuosi : ''); }
  function fmtHa(v) { v = Number(v); return isFinite(v) && v > 0 ? (v < 10 ? v.toFixed(1).replace('.', ',') : fmtInt(v)) + ' ha' : ''; }
  function fmtMonth(d) { var m = /^(\d{4})-(\d{2})/.exec(String(d || '')); return m ? Number(m[2]) + '/' + m[1] : ''; }

  function showInfo(ll, info, prots, inside, cuts) {
    var card = $('infoCard');
    var C = MK.COLORS, color = null;
    cuts = cuts || [];
    var detected = cuts.filter(isDetectedCut), declared = cuts.filter(function (p) { return !isDetectedCut(p); });
    if (info) color = info.kind === 'treeless' ? C.treeless : (info.kind === 'old' ? C.old : MK.ageColor(info.age, settings.oldAge));
    var title = info ? info.title : (inside ? 'Ei metsätietoa' : 'Lupa-alueen ulkopuolella');
    var detail = info ? info.detail : '';
    if (detected.length && info && info.kind !== 'treeless') {
      // Metsätieto on vanhempi kuin hakkuu: näytetään ensin uusi tilanne.
      color = C.treeless;
      title = 'Hakkuuaukko (' + cutSourceText(detected[0]) + ')';
      detail = 'Metsätiedossa ' + ((S.index && S.index.mvmiYear) || '') + ': ' + info.title.toLowerCase() + ', ' + info.detail.charAt(0).toLowerCase() + info.detail.slice(1);
    }
    var html = '<div class="info-row">' +
      (color ? '<span class="sw" style="background:' + MK.cssRGB(color) + '"></span>' : '') +
      '<div><div class="info-title">' + esc(title) + '</div>' +
      (info ? '<div class="info-detail">' + esc(detail) + '</div>' : (inside ? '<div class="info-detail muted">Pelto, vesi tai muu kuin metsätalousmaa</div>' : '')) +
      '</div><button type="button" class="info-close" aria-label="Sulje"><svg viewBox="0 0 24 24"><path d="M6 6l12 12M18 6L6 18" stroke="currentColor" stroke-width="2.4" stroke-linecap="round"/></svg></button></div>';
    var extra = [];
    detected.forEach(function (p) {
      extra.push('<div class="tag"><span class="sw sw-cut"></span><span><b>Uusi hakkuuaukko</b> <span class="muted">(' +
        esc(cutSourceText(p)) + (fmtHa(p.ha) ? ', ' + esc(fmtHa(p.ha)) : '') + ')</span></span></div>');
    });
    declared.forEach(function (p) {
      var when = fmtMonth(p.pvm);
      var state = p.vahv ? 'näkyy latvusmallissa ' + (p.vahvVuosi || '') : 'toteutuminen ei varmaa';
      extra.push('<div class="tag"><span class="sw sw-cut-dash"></span><span><b>Hakkuuilmoitus</b>' + (when ? ' ' + esc(when) : '') +
        (p.tapa ? ': ' + esc(String(p.tapa).toLowerCase()) : '') + ' <span class="muted">(' + esc(state.trim()) + ')</span></span></div>');
    });
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
  // Kartan kääntäminen
  // ---------------------------------------------------------------------------

  function updateCompass() {
    var b = bearing(), btn = $('compassBtn');
    var off = Math.abs(((b % 360) + 540) % 360 - 180) > 0.5;
    btn.hidden = !off;
    btn.querySelector('svg').style.transform = 'rotate(' + Math.round(b) + 'deg)';
  }
  if (CAN_ROTATE) {
    $('compassBtn').addEventListener('click', function () { map.setBearing(0); });
    map.on('rotate', function () {
      updateCompass();
      updateWindUi();
      if (S.layers.me && S.pos) S.layers.me.setIcon(meIcon(S.heading));
    });
    installRotateThreshold(12);
  }

  // Kahden sormen nipistys kääntäisi karttaa herkästi myös zoomatessa. Kääntö alkaa vasta,
  // kun sormia on kierretty kynnyskulman verran, ja jatkuu siitä ilman nykäystä.
  function installRotateThreshold(deg) {
    var tg = map.touchGestures;
    if (!tg || typeof tg._onTouchStart !== 'function' || typeof tg._onTouchMove !== 'function') return;
    // Kosketuksen kuuntelija on rekisteröity jo kartan luonnissa: vaihdetaan se uuteen.
    var wasOn = tg.enabled();
    if (wasOn) tg.disable();
    var start = tg._onTouchStart, move = tg._onTouchMove;
    function angle(e) {
      var p1 = map.mouseEventToContainerPoint(e.touches[0]), p2 = map.mouseEventToContainerPoint(e.touches[1]);
      return { a: Math.atan2(p1.y - p2.y, p1.x - p2.x) * 180 / Math.PI, v: p1.subtract(p2) };
    }
    tg._onTouchStart = function (e) {
      var r = start.apply(this, arguments);
      if (e.touches && e.touches.length === 2) { this._mkA0 = angle(e).a; this._mkFree = false; }
      return r;
    };
    tg._onTouchMove = function (e) {
      if (this.rotate && this._rotating && !this._mkFree && e.touches && e.touches.length === 2) {
        var g = angle(e), d = ((g.a - this._mkA0) % 360 + 540) % 360 - 180;
        if (Math.abs(d) < deg) {
          this._rotating = false;
          try { return move.apply(this, arguments); } finally { this._rotating = true; }
        }
        // Kynnys ylitetty: aloitetaan kääntö tästä asennosta (sama laskenta kuin laajennuksessa).
        this._mkFree = true;
        this._startTheta = Math.atan(g.v.x / g.v.y);
        this._startBearing = map.getBearing();
        if (g.v.y < 0) this._startBearing += 180;
      }
      return move.apply(this, arguments);
    };
    if (wasOn) tg.enable();
  }

  // ---------------------------------------------------------------------------
  // Oma sijainti
  // ---------------------------------------------------------------------------

  function meIcon(heading) {
    var arrow = (heading === null || heading === undefined || isNaN(heading)) ? '' :
      '<div class="me-arrow" style="transform:rotate(' + Math.round(heading + bearing()) + 'deg)"></div>';
    return L.divIcon({ className: 'me-marker', html: arrow + '<div class="me-dot"></div>', iconSize: [0, 0] });
  }

  function onPos(p) {
    S.pos = p;
    var ll = L.latLng(p.coords.latitude, p.coords.longitude);
    var acc = p.coords.accuracy || 0;
    var heading = (p.coords.speed && p.coords.speed > 0.6) ? p.coords.heading : null;
    S.heading = heading;
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
    drawWindFan();
    refreshRain();
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
    drawWindFan();
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
    var dataUrls = [a.forest.file, a.boundary, a.protected, a.cuts].filter(Boolean).map(absUrl);
    var job = { ctrl: new AbortController(), done: 0, failed: 0, total: tiles.length + dataUrls.length, authFail: 0, corsFail: 0, ok: 0, areaId: a.id, ui: ui };
    S.dl = job;
    job.ui.start(job);

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
        refreshWind(a, { force: true });
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
    var sub = fmtInt(a.areaHa) + ' ha' + (a.protectedCount ? ' · ' + a.protectedCount + ' suojelualue' + (a.protectedCount === 1 ? '' : 'tta') : '') +
      (a.cutsCount ? ' · ' + a.cutsCount + ' uutta hakkuuaukkoa' : '');
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
    range.addEventListener('input', function () { settings.opacity = Number(range.value); applyForestOpacity(); });
    range.addEventListener('change', saveSettings);
    body.appendChild(h('div', { class: 'field' }, h('span', { class: 'label', text: 'Peittävyys' }), range));

    body.appendChild(h('h3', { text: 'Muut tasot' }));
    body.appendChild(toggleRow('Luonnonsuojelualueet', 'Katkoviiva', settings.showProtected, function (v) { settings.showProtected = v; saveSettings(); applyLayerVisibility(); }));
    body.appendChild(toggleRow('Uudet hakkuut', 'Metsätiedon jälkeen tehdyt aukot ja hakkuuilmoitukset', settings.showCuts, function (v) {
      settings.showCuts = v; saveSettings(); applyLayerVisibility(); renderLegend();
    }));
    body.appendChild(toggleRow('Himmennä lupa-alueen ulkopuoli', null, settings.showMask, function (v) { settings.showMask = v; saveSettings(); applyLayerVisibility(); }));
    body.appendChild(toggleRow('Sade-ennuste 0–2 h', 'MET Norway · haetaan sijaintisi ympäriltä vain, kun sovellus on auki', settings.showRain, function (v) {
      settings.showRain = v; saveSettings(); renderLegend();
      if (v) refreshRain(true); else stopRainPlay();
      updateRainUi();
    }));
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
      settings.apiKey = keyInput.value.trim().replace(/[^A-Za-z0-9._~-]/g, ''); keyInput.value = settings.apiKey; if (settings.apiKey && settings.basemap === 'osm') settings.basemap = 'maastokartta';
      saveSettings(); setBasemap(); toast('API-avain tallennettu tähän laitteeseen.');
    });
    body.appendChild(h('div', { class: 'field' },
      h('label', { for: 'apiKey', text: 'API-avain' }),
      h('div', { class: 'input-row' }, keyInput, show),
      h('span', { class: 'hint', html: 'Avain tallentuu vain tähän laitteeseen. <a href="https://www.maanmittauslaitos.fi/rajapinnat/api-avaimen-ohje" target="_blank" rel="noopener">Näin saat avaimen</a>.' })));

    body.appendChild(h('h3', { text: 'Värit' }));
    body.appendChild(numberField('oldAge', 'Vanhan metsän raja (v)', settings.oldAge, 20, 250, 5, 'Vähintään tämän ikäinen metsä näkyy sinisenä.', function (v) { settings.oldAge = v; }));
    body.appendChild(numberField('treelessM', 'Puuttoman raja (m)', settings.treelessM, 0, 3, 0.1, 'Uudistusala, jonka taimet ovat tätä matalampia, näkyy punaisena aukkona. 0 = vain täysin puuton.', function (v) { settings.treelessM = v; }));
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
      'Sen jälkeiset hakkuut tunnistetaan Metsäkeskuksen latvusmallista ja Maanmittauslaitoksen ilmakuvista. Hakkuuilmoitus kertoo vain aikeesta: hakkuu voi olla vielä tekemättä. ' +
      'Lupa-alueen raja on käsin piirretty: virallinen raja on eräluvat.fi:n kartassa.</p>' +
      '<p>Tuuliennuste: Ilmatieteen laitos (CC BY 4.0), varalla Open-Meteo (CC BY 4.0). Sade-ennuste: MET Norway (CC BY 4.0).</p>' +
      '<p>Sijaintisi käsitellään tässä laitteessa. Tuuliennuste haetaan lupa-alueen keskipisteeseen. Kun sadetaso on päällä ja sovellus auki, ' +
      'sijaintisi noin 1 km tarkkuudella (25 pisteen ruudukko 7,5 km säteellä) lähetetään MET Norwaylle sade-ennusteen hakua varten. ' +
      'Sovellus ei hae mitään taustalla.</p>' +
      '<p>Ohjelman lähdekoodi ja yhteystiedot: <a href="https://github.com/gitdaada/metsakartta" target="_blank" rel="noopener">github.com/gitdaada/metsakartta</a></p>' }));
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
  $('windBtn').addEventListener('click', function () { openSheet('wind', 'Tuuli', renderWindSheet); });
  $('settingsBtn').addEventListener('click', function () { openSheet('settings', 'Asetukset', renderSettingsSheet); });
  $('zoomInBtn').addEventListener('click', function () { map.zoomIn(); });
  $('zoomOutBtn').addEventListener('click', function () { map.zoomOut(); });
  $('sheetBody').addEventListener('click', function (e) {
    var t = e.target.closest('[data-open-settings]');
    if (t) { e.preventDefault(); openSheet('settings', 'Asetukset', renderSettingsSheet); }
  });

  // ---------------------------------------------------------------------------
  // Tuuli ja tuuliviuhka
  // ---------------------------------------------------------------------------

  var FMI_WFS = 'https://opendata.fmi.fi/wfs';
  var OPEN_METEO = 'https://api.open-meteo.com/v1/forecast';
  var WIND_MAX_AGE = 60 * 60 * 1000;
  var windManual = (function (m) {
    return m && isFinite(Number(m.dir)) ? { dir: MK.norm360(Math.round(Number(m.dir))), at: Number(m.at) || Date.now() } : null;
  })(store.get('windManual', null));
  S.wind = null;
  S.windLoading = false;

  function fmt1(n) { return (Math.round(n * 10) / 10).toString().replace('.', ','); }
  function fmtWhen(ms) {
    var d = new Date(ms), now = new Date();
    var hm = d.toLocaleTimeString('fi-FI', { hour: '2-digit', minute: '2-digit' });
    return (d.toDateString() === now.toDateString() ? 'klo ' : d.getDate() + '.' + (d.getMonth() + 1) + '. klo ') + hm;
  }
  function windPoint(a) { return [Math.round(a.center[0] * 100) / 100, Math.round(a.center[1] * 100) / 100]; }
  function windKey(a) { return 'wind_' + a.id; }
  function loadWindCache(a) {
    var w = store.get(windKey(a), null);
    S.wind = w && Array.isArray(w.series) ? w : null;
  }
  function isoHour(ms) { var d = new Date(ms); d.setUTCMinutes(0, 0, 0); return d.toISOString().replace('.000Z', 'Z'); }

  function fetchWithTimeout(url, ms, cacheMode) {
    var c = new AbortController();
    var t = setTimeout(function () { c.abort(); }, ms);
    return fetch(url, { signal: c.signal, credentials: 'omit', cache: cacheMode || 'no-store' })
      .then(function (r) { clearTimeout(t); return r; }, function (e) { clearTimeout(t); throw e; });
  }

  function fetchFmi(lat, lon, params) {
    var now = Date.now();
    var q = 'service=WFS&version=2.0.0&request=getFeature' +
      '&storedquery_id=fmi::forecast::edited::weather::scandinavia::point::simple' +
      '&latlon=' + lat + ',' + lon + '&parameters=' + params + '&timestep=60' +
      '&starttime=' + isoHour(now - 3600000) + '&endtime=' + isoHour(now + 60 * 3600000);
    return fetchWithTimeout(FMI_WFS + '?' + q, 15000).then(function (r) { return r.text(); }).then(function (txt) {
      var s = MK.parseFmiWind(txt);
      if (!s.length) throw new Error('FMI: ei tuulitietoa');
      return s;
    });
  }

  function fetchOpenMeteo(lat, lon) {
    var q = 'latitude=' + lat + '&longitude=' + lon +
      '&hourly=wind_speed_10m,wind_direction_10m,wind_gusts_10m&wind_speed_unit=ms&timezone=GMT&past_hours=1&forecast_hours=60';
    return fetchWithTimeout(OPEN_METEO + '?' + q, 15000).then(function (r) {
      if (!r.ok) throw new Error('Open-Meteo HTTP ' + r.status);
      return r.json();
    }).then(function (j) {
      var s = MK.parseOpenMeteoWind(j);
      if (!s.length) throw new Error('Open-Meteo: ei tuulitietoa');
      return s;
    });
  }

  /** Hakee alueen tuulen tuntiennusteen (n. 60 h) ja tallentaa sen laitteeseen offline-käyttöä varten. */
  function refreshWind(a, opts) {
    a = a || S.area; opts = opts || {};
    if (!a || S.windLoading || !navigator.onLine) return Promise.resolve(false);
    var cached = store.get(windKey(a), null);
    if (!opts.force && cached && Date.now() - cached.fetched < WIND_MAX_AGE) return Promise.resolve(false);
    var pt = windPoint(a), src = 'fmi';
    S.windLoading = true;
    updateWindUi({ noFan: true });
    return fetchFmi(pt[0], pt[1], 'WindDirection,WindSpeedMS,WindGust')
      .catch(function (e) {
        if (/^FMI:/.test(e.message)) return fetchFmi(pt[0], pt[1], 'WindDirection,WindSpeedMS');
        throw e;
      })
      .catch(function (e) {
        console.warn('FMI ei käytettävissä, käytetään Open-Meteota:', e && e.message);
        src = 'open-meteo';
        return fetchOpenMeteo(pt[0], pt[1]);
      })
      .then(function (series) {
        var w = { areaId: a.id, series: series, fetched: Date.now(), source: src, lat: pt[0], lon: pt[1] };
        store.set(windKey(a), w);
        if (S.area && S.area.id === a.id) S.wind = w;
        return true;
      })
      .catch(function (e) {
        console.warn('Tuuliennusteen haku epäonnistui:', e && e.message);
        if (opts.force) toast('Tuuliennustetta ei saatu: ' + (e && e.message));
        return false;
      })
      .then(function (ok) { S.windLoading = false; updateWindUi(); return ok; });
  }

  function currentWind() {
    if (windManual) return { dir: windManual.dir, spd: null, gust: null, manual: true, at: windManual.at };
    if (!S.wind || !S.wind.series) return null;
    var e = MK.pickWind(S.wind.series, Date.now());
    return e ? { dir: e.dir, spd: e.spd, gust: e.gust, t: e.t, manual: false } : null;
  }

  // Viuhka piirretään omalle canvas-pinnalleen: liukuväri, elävät reunat ja myötätuuleen kulkevat hajuhiukkaset.
  var REDUCED_MOTION = !!(window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches);
  var FAN_RGB = '196,60,255';

  var WindFanLayer = L.Layer.extend({
    initialize: function () { this._fan = null; this._raf = 0; this._parts = []; this._last = 0; this._prev = 0; },
    setFan: function (fan) {
      var reseed = !this._fan || this._fan.bearing !== fan.bearing;
      this._fan = fan;
      if (reseed) this._seed();
      this._draw();
      return this;
    },
    onAdd: function (map) {
      var c = this._canvas = L.DomUtil.create('canvas', 'wind-canvas');
      c.setAttribute('aria-hidden', 'true');
      map.getPane('windPane').appendChild(c);
      map.on('zoomstart', this._hide, this);
      map.on('zoomend moveend resize viewreset', this._show, this);
      map.on('move rotate', this._draw, this);
      this._loopFn = this._loop.bind(this);
      this._show();
      if (!REDUCED_MOTION) this._raf = requestAnimationFrame(this._loopFn);
    },
    onRemove: function (map) {
      if (this._raf) cancelAnimationFrame(this._raf);
      this._raf = 0;
      map.off('zoomstart', this._hide, this);
      map.off('zoomend moveend resize viewreset', this._show, this);
      map.off('move rotate', this._draw, this);
      L.DomUtil.remove(this._canvas);
      this._canvas = null;
    },
    _hide: function () { this._hidden = true; if (this._canvas) this._canvas.style.visibility = 'hidden'; },
    _show: function () { this._hidden = false; if (this._canvas) this._canvas.style.visibility = ''; this._draw(); },
    _seed: function () {
      this._parts = [];
      for (var i = 0; i < 26; i++) this._parts.push(this._newPart(Math.random()));
    },
    _newPart: function (s) {
      return { s: s, u: (Math.random() * 2 - 1) * 0.85, k: 0.7 + Math.random() * 0.6, ph: Math.random() * 6.283, sz: 0.7 + Math.random() * 0.6 };
    },
    _loop: function (now) {
      this._raf = requestAnimationFrame(this._loopFn);
      if (now - this._last < 33) return; // n. 30 kuvaa sekunnissa riittää ja säästää akkua
      var dt = this._prev ? Math.min(0.1, (now - this._prev) / 1000) : 0;
      this._prev = now; this._last = now;
      var f = this._fan;
      if (f && dt) {
        // Kierroksen kesto 7 s (tyyni) ... 2,5 s (kova tuuli)
        var rate = 1 / Math.max(2.5, 7 - (f.spd === null ? 3 : f.spd) * 0.8);
        for (var i = 0; i < this._parts.length; i++) {
          var p = this._parts[i];
          p.s += dt * rate * p.k;
          if (p.s > 1) this._parts[i] = this._newPart(0);
        }
      }
      this._draw(now);
    },
    _draw: function (now) {
      var map = this._map, c = this._canvas, f = this._fan;
      if (!map || !c || this._hidden) return;
      var size = map.getSize(), dpr = Math.min(window.devicePixelRatio || 1, 2);
      if (c.width !== Math.round(size.x * dpr) || c.height !== Math.round(size.y * dpr)) {
        c.width = Math.round(size.x * dpr); c.height = Math.round(size.y * dpr);
        c.style.width = size.x + 'px'; c.style.height = size.y + 'px';
      }
      // Kangas peittää näkymän: sijoitetaan kääntymättömään tasoon näytön vasempaan yläkulmaan.
      L.DomUtil.setPosition(c, CAN_ROTATE ? L.point(0, 0).subtract(map._getMapPanePos()) : map.containerPointToLayerPoint([0, 0]));
      var ctx = c.getContext('2d');
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.clearRect(0, 0, size.x, size.y);
      if (!f) return;
      var o = map.latLngToContainerPoint([f.lat, f.lon]);
      var e = map.latLngToContainerPoint(MK.destPoint(f.lat, f.lon, f.bearing, f.len));
      var dx = e.x - o.x, dy = e.y - o.y, Lpx = Math.sqrt(dx * dx + dy * dy);
      if (Lpx < 6) return;
      var a = Math.atan2(dy, dx), h = f.half * Math.PI / 180;
      // Kartan tapahtumat kutsuvat tätä tapahtumaoliolla, joten aika luetaan vain numerosta.
      var t = REDUCED_MOTION ? 0 : (typeof now === 'number' ? now : performance.now()) / 1000;
      var cosA = Math.cos(a), sinA = Math.sin(a);

      // Rungon muoto: alkaa pyöreänä sijaintisi ympäriltä, levenee myötätuuleen ja päättyy pyöristettyyn,
      // hitaasti aaltoilevaan päähän. Paikalliset koordinaatit: x tuulen suuntaan, y sivulle.
      var w0 = 7, tanH = Math.tan(h), xEnd = Lpx * 0.9;
      function L2S(x, y) { return [o.x + x * cosA - y * sinA, o.y + x * sinA + y * cosA]; }
      function shape(scale) {
        var pts = [], n = 22, i, s, x, wob, b;
        var W = function (xx) { return (w0 + tanH * xx) * scale; };
        for (i = 0; i <= n; i++) {          // vasen reuna
          s = i / n; x = s * xEnd;
          wob = 1 + 0.13 * Math.sin(5.2 * s + t * 0.9) + 0.07 * Math.sin(11 * s - t * 1.3);
          pts.push(L2S(x, -W(x) * wob));
        }
        var We = W(xEnd);
        for (i = 1; i < n; i++) {           // pyöristetty, aaltoileva kaukopää
          b = -Math.PI / 2 + Math.PI * i / n;
          wob = 1 + 0.12 * Math.sin(3 * b + t * 0.8) + 0.06 * Math.sin(7 * b - t * 1.2);
          pts.push(L2S(xEnd + We * 0.6 * Math.cos(b) * wob, We * Math.sin(b) * (1 + 0.05 * Math.sin(5 * b + t))));
        }
        for (i = n; i >= 0; i--) {          // oikea reuna
          s = i / n; x = s * xEnd;
          wob = 1 + 0.13 * Math.sin(4.7 * s - t * 0.8 + 1.7) + 0.07 * Math.sin(9.5 * s + t * 1.1);
          pts.push(L2S(x, W(x) * wob));
        }
        for (i = 1; i < 8; i++) {           // pyöreä alku sijaintisi takana
          b = Math.PI / 2 + Math.PI * i / 8;
          pts.push(L2S(w0 * scale * 0.8 * Math.cos(b), w0 * scale * Math.sin(b)));
        }
        return pts;
      }
      var grad = ctx.createRadialGradient(o.x, o.y, 0, o.x, o.y, Lpx * 1.05);
      grad.addColorStop(0, 'rgba(' + FAN_RGB + ',0.95)');
      grad.addColorStop(0.3, 'rgba(' + FAN_RGB + ',0.7)');
      grad.addColorStop(0.7, 'rgba(' + FAN_RGB + ',0.3)');
      grad.addColorStop(1, 'rgba(' + FAN_RGB + ',0)');
      ctx.fillStyle = grad;
      // Useita sisäkkäisiä, läpikuultavia kerroksia: keskilinja vahvin ja reunat pehmeästi haalenevat.
      for (var li = 0; li < 8; li++) {
        var pts = shape(1 - li * 0.1);
        ctx.globalAlpha = 0.16;
        ctx.beginPath();
        ctx.moveTo(pts[0][0], pts[0][1]);
        for (var i = 1; i < pts.length; i++) ctx.lineTo(pts[i][0], pts[i][1]);
        ctx.closePath();
        ctx.fill();
      }
      ctx.globalAlpha = 1;
      if (f.manual) {
        var op = shape(1);
        ctx.setLineDash([6, 5]);
        ctx.strokeStyle = 'rgba(' + FAN_RGB + ',0.75)';
        ctx.lineWidth = 1.5;
        ctx.beginPath();
        ctx.moveTo(op[0][0], op[0][1]);
        for (var j = 1; j < op.length; j++) ctx.lineTo(op[j][0], op[j][1]);
        ctx.closePath();
        ctx.stroke();
        ctx.setLineDash([]);
      }
      if (REDUCED_MOTION) return;
      // Hajuhiukkaset: lähtevät sijainnistasi, kulkevat myötätuuleen, kasvavat ja haalenevat.
      for (var k = 0; k < this._parts.length; k++) {
        var pt = this._parts[k];
        var px = pt.s * xEnd * 1.05;
        var xy = L2S(px, pt.u * (w0 + tanH * px) * (0.8 + 0.2 * Math.sin(t * 0.7 + pt.ph)) + 3 * Math.sin(t * 2.1 + pt.ph));
        var alpha = 0.7 * Math.min(1, pt.s * 8) * Math.pow(1 - pt.s, 1.3);
        var rad = (1.6 + 4.2 * pt.s) * pt.sz;
        var pg = ctx.createRadialGradient(xy[0], xy[1], 0, xy[0], xy[1], rad);
        pg.addColorStop(0, 'rgba(248,226,255,' + alpha.toFixed(3) + ')');
        pg.addColorStop(1, 'rgba(' + FAN_RGB + ',0)');
        ctx.fillStyle = pg;
        ctx.beginPath();
        ctx.arc(xy[0], xy[1], rad, 0, 6.2832);
        ctx.fill();
      }
    }
  });

  function drawWindFan() {
    var w = currentWind();
    if (!settings.showWind || !w || !S.pos) {
      if (S.layers.wind) { map.removeLayer(S.layers.wind); S.layers.wind = null; }
      return;
    }
    var fan = {
      lat: S.pos.coords.latitude, lon: S.pos.coords.longitude, bearing: MK.norm360(w.dir + 180),
      half: MK.fanHalfAngle(w.spd), len: settings.fanLengthM, spd: w.spd, manual: !!w.manual
    };
    if (!S.layers.wind) S.layers.wind = new WindFanLayer().addTo(map);
    S.layers.wind.setFan(fan);
  }

  function updateWindUi(opts) {
    opts = opts || {};
    var btn = $('windBtn'), arrow = btn.querySelector('.wind-arrow'), spd = $('windSpd');
    var w = currentWind();
    btn.hidden = !S.area && !windManual;
    if (w) {
      arrow.style.transform = 'rotate(' + Math.round(MK.norm360(w.dir + 180 + bearing())) + 'deg)';
      arrow.style.opacity = '1';
      spd.textContent = w.manual ? 'oma' : (w.spd !== null ? Math.round(w.spd) + ' m/s' : '');
      btn.setAttribute('aria-label', 'Tuuli ' + MK.windFromName(w.dir) + (w.spd !== null ? ' ' + fmt1(w.spd) + ' m/s' : '') + '. Avaa tuulitiedot.');
    } else {
      arrow.style.transform = 'rotate(0deg)';
      arrow.style.opacity = '0.3';
      spd.textContent = S.windLoading ? '…' : '–';
      btn.setAttribute('aria-label', 'Tuuli: ei tietoa. Avaa tuulitiedot.');
    }
    btn.classList.toggle('manual', !!(w && w.manual));
    if (!opts.noFan) drawWindFan();
    if (!opts.noSheet && currentSheet && currentSheet.name === 'wind') renderSheet();
  }

  function arrowSvg(rot, size) {
    return '<svg viewBox="0 0 24 24" width="' + size + '" height="' + size + '" style="transform:rotate(' + Math.round(rot) + 'deg)" aria-hidden="true">' +
      '<path d="M12 2l6 8h-4v12h-4V10H6z" fill="currentColor"/></svg>';
  }

  function renderWindSheet(body) {
    var w = currentWind();
    if (w) {
      var line2 = (w.gust !== null && w.gust !== undefined ? 'Puuskissa ' + fmt1(w.gust) + ' m/s · ' : '') + 'Hajusi kulkee ' + MK.windToName(w.dir);
      body.appendChild(h('div', { class: 'wind-now' },
        h('span', { class: 'wind-dial', html: arrowSvg(MK.norm360(w.dir + 180), 40) }),
        h('div', null,
          h('div', { class: 'wind-title', text: 'Tuuli ' + MK.windFromName(w.dir) + (w.spd !== null ? ' ' + fmt1(w.spd) + ' m/s' : '') }),
          h('div', { class: 'muted small', text: line2 }),
          h('div', { class: 'muted small', text: w.manual ? 'Oma havainto ' + fmtWhen(w.at) : 'Ennuste ' + fmtWhen(w.t) }))));
      if (!w.manual && w.spd !== null && w.spd < 1.5) {
        body.appendChild(h('div', { class: 'notice', text: 'Heikko tuuli: suunta on epävarma ja voi vaihdella, joten viuhka on leveä.' }));
      }
    } else {
      body.appendChild(h('p', { class: 'muted', text: S.windLoading ? 'Haetaan tuuliennustetta…' :
        (S.area ? 'Ei voimassa olevaa tuuliennustetta. Hae ennuste verkossa tai aseta suunta itse.' : 'Valitse ensin lupa-alue.') }));
    }
    if (settings.showWind && !S.pos) body.appendChild(h('p', { class: 'muted small', text: 'Viuhka näkyy kartalla, kun oma sijainti on päällä.' }));

    // Ennuste
    body.appendChild(h('h3', { text: 'Ennuste' }));
    if (S.wind && S.wind.series && S.wind.series.length) {
      var now = Date.now(), list = h('div', { class: 'wind-list' });
      S.wind.series.filter(function (e) { return e.t >= now - 30 * 60000; }).slice(0, 8).forEach(function (e) {
        list.appendChild(h('div', { class: 'wind-row' },
          h('span', { class: 'wind-t', text: new Date(e.t).toLocaleTimeString('fi-FI', { hour: '2-digit', minute: '2-digit' }) }),
          h('span', { class: 'wind-mini', html: arrowSvg(MK.norm360(e.dir + 180), 18) }),
          h('span', { text: MK.windFromName(e.dir) + (e.spd !== null ? ' ' + fmt1(e.spd) + ' m/s' : '') + (e.gust !== null ? ' (' + fmt1(e.gust) + ')' : '') })));
      });
      body.appendChild(list);
      var last = S.wind.series[S.wind.series.length - 1];
      body.appendChild(h('p', { class: 'muted small', text: (S.wind.source === 'fmi' ? 'Ilmatieteen laitos' : 'Open-Meteo') +
        ' · haettu ' + fmtWhen(S.wind.fetched) + ' · voimassa ' + fmtWhen(last.t) + ' asti · lupa-alueen keskipiste' }));
    } else {
      body.appendChild(h('p', { class: 'muted small', text: 'Ennustetta ei ole tallennettu tälle alueelle.' }));
    }
    body.appendChild(h('div', { class: 'btn-row' }, h('button', { type: 'button', class: 'btn', disabled: !navigator.onLine || S.windLoading || !S.area,
      text: navigator.onLine ? 'Päivitä ennuste' : 'Päivitys vaatii verkon',
      onclick: function () { refreshWind(S.area, { force: true }); } })));

    // Oma havainto
    body.appendChild(h('h3', { text: 'Oma havainto' }));
    body.appendChild(toggleRow('Käytä omaa havaintoa', 'Esim. savu, lumi tai kuiva heinä', !!windManual, function (v) {
      if (v) {
        var cw = currentWind();
        windManual = { dir: cw ? Math.round(cw.dir / 5) * 5 % 360 : 0, at: Date.now() };
      } else windManual = null;
      store.set('windManual', windManual);
      updateWindUi();
    }));
    if (windManual) {
      var lbl = h('div', { class: 'wind-manual-label' });
      var setLbl = function () { lbl.textContent = 'Tuuli ' + MK.windFromName(windManual.dir) + ' (' + windManual.dir + '°) → hajusi kulkee ' + MK.windToName(windManual.dir); };
      setLbl();
      var range = h('input', { type: 'range', min: '0', max: '355', step: '5', value: String(windManual.dir), 'aria-label': 'Tuulen tulosuunta asteina' });
      range.addEventListener('input', function () {
        windManual = { dir: Number(range.value), at: Date.now() };
        setLbl();
        updateWindUi({ noSheet: true });
      });
      range.addEventListener('change', function () { store.set('windManual', windManual); });
      body.appendChild(h('div', { class: 'field' }, lbl, range,
        h('div', { class: 'wind-scale' }, h('span', { text: 'P' }), h('span', { text: 'I' }), h('span', { text: 'E' }), h('span', { text: 'L' }), h('span', { text: 'P' }))));
    }

    // Näyttö
    body.appendChild(h('h3', { text: 'Viuhka' }));
    body.appendChild(toggleRow('Näytä tuuliviuhka', 'Lähtee omasta sijainnistasi myötätuuleen', settings.showWind, function (v) {
      settings.showWind = v; saveSettings(); renderLegend(); updateWindUi();
    }));
    var seg = h('div', { class: 'seg', role: 'group', 'aria-label': 'Viuhkan pituus' });
    [100, 200, 300, 500].forEach(function (m) {
      seg.appendChild(h('button', { type: 'button', 'aria-pressed': String(settings.fanLengthM === m), text: m + ' m',
        onclick: function () { settings.fanLengthM = m; saveSettings(); updateWindUi(); } }));
    });
    body.appendChild(h('div', { class: 'field' }, h('span', { class: 'label', text: 'Viuhkan pituus' }), seg));
    body.appendChild(h('p', { class: 'muted small', text: 'Ennuste kuvaa tuulta avoimessa maastossa 10 metrin korkeudella. Metsässä maan tasolla tuuli on heikompaa ja kääntyilee maaston mukaan, joten viuhka näyttää vain yleissuunnan. Viuhkan leveys kertoo epävarmuudesta: mitä heikompi tuuli, sitä leveämpi viuhka.' }));
  }

  // Kellon ja verkon mukana: tunnin vaihtuessa uusi ennustearvo, verkossa vanhentunut ennuste päivitetään.
  setInterval(function () {
    updateWindUi({ noSheet: true });
    if (S.area && navigator.onLine) refreshWind(S.area);
  }, 60000);
  window.addEventListener('online', function () { if (S.area) refreshWind(S.area); });

  // ---------------------------------------------------------------------------
  // Sade: MET Norwayn tutkaennuste (nowcast) 0–2 h, 5 x 5 pisteen ruudukko ±7,5 km
  // ---------------------------------------------------------------------------

  var MET_NOWCAST = 'https://api.met.no/weatherapi/nowcast/2.0/complete';
  var RAIN_HALF_KM = 7.5, RAIN_N = 5, RAIN_IMG = 72;
  var RAIN_MAX_AGE = 5 * 60 * 1000, RAIN_MOVE_KM = 2.5, RAIN_MIN_GAP = 60 * 1000;
  S.rain = null; S.rainLoading = false; S.rainIdx = 0; S.rainPlay = 0; S.rainPinned = false;
  var rainCanvas = document.createElement('canvas');
  rainCanvas.width = rainCanvas.height = RAIN_IMG;

  function hm(ms) { return new Date(ms).toLocaleTimeString('fi-FI', { hour: '2-digit', minute: '2-digit' }); }

  function rainCenter() {
    if (S.pos) return { lat: S.pos.coords.latitude, lon: S.pos.coords.longitude, gps: true };
    var c = map.getCenter();
    return { lat: c.lat, lon: c.lng, gps: false };
  }

  /** Hakuja tehdään vain, kun sadetaso on päällä, verkko on käytössä ja sovellus on näkyvissä. */
  function canFetchRain() { return settings.showRain && navigator.onLine && document.visibilityState === 'visible'; }

  function refreshRain(force) {
    if (!canFetchRain() || S.rainLoading) return Promise.resolve(false);
    var c = rainCenter();
    var grid = MK.rainGrid(c.lat, c.lon, RAIN_HALF_KM, RAIN_N);
    if (!force && S.rain) {
      var age = Date.now() - S.rain.fetched;
      var moved = map.distance(grid.center, S.rain.grid.center) > RAIN_MOVE_KM * 1000;
      var gpsNow = c.gps && !S.rain.gps;
      if (!(age > RAIN_MAX_AGE || gpsNow || (moved && age > RAIN_MIN_GAP))) return Promise.resolve(false);
    }
    S.rainLoading = true;
    updateRainUi();
    var results = new Array(grid.points.length), next = 0, failed = 0, covBad = 0;
    function one(k) {
      var p = grid.points[k];
      return fetchWithTimeout(MET_NOWCAST + '?lat=' + p.lat + '&lon=' + p.lon, 15000, 'default').then(function (r) {
        if (!r.ok) throw new Error('MET HTTP ' + r.status);
        return r.json();
      }).then(function (j) {
        var res = MK.parseNowcast(j);
        if (res.coverage !== 'ok') covBad++;
        results[k] = res;
      }).catch(function (e) {
        failed++;
        console.warn('Sade-ennusteen haku epäonnistui:', e && e.message);
      });
    }
    // Kolme hakua kerrallaan ja pieni tauko: MET Norwayn kokonaisraja on 20 hakua sekunnissa.
    function worker() {
      if (next >= grid.points.length) return Promise.resolve();
      var k = next++;
      return one(k).then(function () { return wait(150); }).then(worker);
    }
    return Promise.all([worker(), worker(), worker()]).then(function () {
      S.rainLoading = false;
      if (failed === grid.points.length) {
        updateRainUi();
        if (force) toast('Sade-ennustetta ei saatu.');
        return false;
      }
      var fr = MK.rainFrames(results, RAIN_N);
      var mid = Math.floor(grid.points.length / 2);
      S.rain = {
        grid: grid, gps: c.gps, fetched: Date.now(), times: fr.times, frames: fr.frames,
        center: results[mid] ? results[mid].series : [], coverageBad: covBad, failed: failed
      };
      buildRainImages();
      S.rainPinned = false;
      S.rainIdx = currentRainIdx();
      updateRainUi();
      return true;
    });
  }

  function buildRainImages() {
    var r = S.rain, ctx = rainCanvas.getContext('2d'), img = ctx.createImageData(RAIN_IMG, RAIN_IMG);
    r.urls = []; r.has = []; r.anyRain = false;
    r.frames.forEach(function (f) {
      var out = MK.renderRain(f, RAIN_N, RAIN_IMG, img.data);
      ctx.putImageData(img, 0, 0);
      r.urls.push(rainCanvas.toDataURL('image/png'));
      r.has.push(out.any);
      if (out.any) r.anyRain = true;
    });
  }

  function currentRainIdx() {
    var r = S.rain, now = Date.now();
    if (!r || !r.times.length) return 0;
    for (var k = 0; k < r.times.length; k++) if (r.times[k] >= now - 150000) return k;
    return -1;
  }

  function rainExpired() {
    var r = S.rain;
    return !r || !r.times.length || r.times[r.times.length - 1] < Date.now() - 5 * 60000;
  }

  function applyForestOpacity() {
    var dim = !!(S.layers.rain && S.rain && S.rain.anyRain);
    forestLayer.setOpacity(settings.opacity * (dim ? 0.75 : 1));
  }

  function drawRain() {
    var r = S.rain, k = S.rainIdx;
    var show = settings.showRain && r && r.urls && !rainExpired() && k >= 0 && k < r.urls.length && r.anyRain;
    if (!show) {
      if (S.layers.rain) { map.removeLayer(S.layers.rain); S.layers.rain = null; }
    } else if (!S.layers.rain) {
      S.layers.rain = L.imageOverlay(r.urls[k], r.grid.bounds, { pane: 'rainPane', interactive: false, className: 'rain-img' }).addTo(map);
    } else {
      S.layers.rain.setBounds(L.latLngBounds(r.grid.bounds));
      S.layers.rain.setUrl(r.urls[k]);
    }
    applyForestOpacity();
  }

  function rainHereText(r) {
    var who = r.gps ? 'Kohdallasi' : 'Kartan keskellä';
    var sm = MK.rainSummary(r.center, Date.now());
    if (!r.anyRain) return 'Ei sadetta 7,5 km säteellä seuraavan 2 h aikana.';
    if (!sm) return '';
    if (sm.state === 'raining') return who + ' sataa nyt' + (sm.until ? ', taukoa n. klo ' + hm(sm.until) : '') + '.';
    if (sm.state === 'coming') return who + ' sade alkaa n. klo ' + hm(sm.at) + '.';
    return who + ' ei sada, lähistöllä sadetta.';
  }

  /** Nostaa oikean reunan painikkeet sadepalkin yläpuolelle, jos palkki ulottuu niiden alle. */
  function liftFabs() {
    var bar = $('rainBar'), fabs = document.querySelector('.fabs'), lift = 0;
    if (bar && fabs && !bar.hidden) {
      var b = bar.getBoundingClientRect(), f = fabs.getBoundingClientRect();
      if (b.right > f.left - 4) lift = Math.ceil(window.innerHeight - b.top + 10);
    }
    document.documentElement.style.setProperty('--fab-lift', lift + 'px');
  }
  window.addEventListener('resize', liftFabs);

  function updateRainUi() {
    var bar = $('rainBar'), slider = $('rainSlider'), play = $('rainPlay'), timeEl = $('rainTime'), here = $('rainHere');
    try { return updateRainUiInner(bar, slider, play, timeEl, here); } finally { liftFabs(); }
  }

  function updateRainUiInner(bar, slider, play, timeEl, here) {
    if (!settings.showRain) { bar.hidden = true; stopRainPlay(); drawRain(); return; }
    bar.hidden = false;
    var r = S.rain;
    if (!r || rainExpired()) {
      slider.disabled = true; play.disabled = true; slider.max = '0'; slider.value = '0';
      timeEl.textContent = 'Sade';
      here.textContent = S.rainLoading ? 'Haetaan sade-ennustetta…' :
        (!navigator.onLine ? 'Sade-ennuste vaatii verkkoyhteyden.' : (r ? 'Sade-ennuste vanhentui, päivitetään…' : 'Ei vielä sadetietoa.'));
      drawRain();
      return;
    }
    if (!S.rainPinned && !S.rainPlay) S.rainIdx = Math.max(0, currentRainIdx());
    S.rainIdx = Math.max(0, Math.min(S.rainIdx, r.times.length - 1));
    slider.max = String(r.times.length - 1);
    slider.value = String(S.rainIdx);
    slider.disabled = !r.anyRain;
    play.disabled = !r.anyRain;
    var t = r.times[S.rainIdx], mins = Math.round((t - Date.now()) / 60000);
    timeEl.textContent = (mins <= 2 ? 'Nyt' : '+' + mins + ' min') + ' · klo ' + hm(t);
    here.textContent = rainHereText(r) + (r.coverageBad ? ' Tutkakattavuus osin heikko.' : '') +
      (S.rainLoading ? ' Päivitetään…' : ' Päivitetty klo ' + hm(r.fetched) + '.');
    drawRain();
  }

  function setPlayIcon(playing) {
    $('rainPlay').innerHTML = playing ?
      '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M7 5h3.5v14H7zM13.5 5H17v14h-3.5z" fill="currentColor"/></svg>' :
      '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M8 5l11 7-11 7z" fill="currentColor"/></svg>';
    $('rainPlay').setAttribute('aria-label', playing ? 'Pysäytä' : 'Toista sade-ennuste');
  }
  function startRainPlay() {
    if (S.rainPlay || !S.rain || !S.rain.times.length) return;
    S.rainPinned = true;
    S.rainPlay = setInterval(function () {
      var r = S.rain;
      if (!r || rainExpired()) { stopRainPlay(); return; }
      S.rainIdx = (S.rainIdx + 1) % r.times.length;
      updateRainUi();
    }, 450);
    setPlayIcon(true);
  }
  function stopRainPlay() {
    if (S.rainPlay) clearInterval(S.rainPlay);
    S.rainPlay = 0;
    setPlayIcon(false);
  }

  $('rainSlider').addEventListener('input', function () {
    stopRainPlay();
    S.rainPinned = true;
    S.rainIdx = Number($('rainSlider').value);
    updateRainUi();
  });
  $('rainPlay').addEventListener('click', function () { if (S.rainPlay) stopRainPlay(); else startRainPlay(); });
  $('rainNow').addEventListener('click', function () { stopRainPlay(); S.rainPinned = false; updateRainUi(); });
  $('rainHide').addEventListener('click', function () {
    settings.showRain = false; saveSettings(); renderLegend(); updateRainUi();
    toast('Sadetaso piilotettu. Saat sen takaisin Karttatasot-valikosta.');
  });

  // Päivitys vain sovelluksen ollessa auki: minuutin välein tarkistus (haku itse rajoittaa tiheyden).
  setInterval(function () { refreshRain(); updateRainUi(); }, 60000);
  document.addEventListener('visibilitychange', function () {
    if (document.visibilityState === 'visible') refreshRain(); else stopRainPlay();
  });
  window.addEventListener('online', function () { refreshRain(); });
  map.on('moveend', function () { if (!S.pos) refreshRain(); });

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
      forestLayer.options.attribution = 'Luke, Syke, Ilmatieteen laitos (CC BY 4.0)';
    }
    if (last && findArea(last)) selectArea(last, { keepView: true });
    else if (S.areas.length === 1) selectArea(S.areas[0].id);
    else openSheet('areas', 'Lupa-alueet', renderAreasSheet);
    // Päivitysilmoitus tallennetuille alueille
    var stale = S.areas.filter(function (a) { return offline[a.id] && offline[a.id].version !== a.version; });
    if (stale.length && navigator.onLine) toast('Karttapäivitys saatavilla: ' + stale.map(function (a) { return a.name; }).join(', '),
      { label: 'Näytä', fn: function () { openSheet('areas', 'Lupa-alueet', renderAreasSheet); } });
    if (settings.gpsOn) startWatch();
    setPlayIcon(false);
    updateRainUi();
    // Jos GPS on päällä, ensimmäinen sadehaku tehdään sijainnin mukaan (onPos); muuten kartan keskeltä.
    if (settings.gpsOn) setTimeout(function () { refreshRain(); }, 8000); else refreshRain();
  });

  // Testejä varten
  window.__mk = { S: S, settings: settings, map: map, selectArea: selectArea, offline: function () { return offline; },
    refreshWind: refreshWind, currentWind: currentWind, refreshRain: refreshRain };
})();
