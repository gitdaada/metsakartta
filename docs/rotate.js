/*
 * Metsäkartta: kartan kääntö.
 *
 * Koko Leaflet-karttasäiliö käännetään CSS-muunnoksella näkymän keskipisteen ympäri. Säiliö on
 * näkymän lävistäjän kokoinen, joten käännetty kartta peittää näkymän kaikissa asennoissa.
 * Leafletin omat eleet (siirto, nipistyszoomaus, tuplanapautus) toimivat sellaisinaan, kun
 * kosketuskohdat muunnetaan käännettyyn koordinaatistoon. Karttatiilet ladataan vain näkyvälle
 * alueelle, joten kääntämätön kartta ei lataa ylimääräisiä tiiliä.
 *
 * Suunta (bearing) on kartan kääntökulma asteina myötäpäivään. Maantieteellinen suunta d näkyy
 * näytöllä kulmassa d + bearing (0 = ylös). Esimerkiksi bearing 270 tuo idän näytön yläreunaan.
 */
(function (global) {
  'use strict';

  var RAD = Math.PI / 180;

  function norm360(b) { b = b % 360; return b < 0 ? b + 360 : b; }
  /** Kulmien erotus b - a välillä -180...180. */
  function angleDiff(a, b) { return ((b - a) % 360 + 540) % 360 - 180; }

  /** Säiliön koko ja paikka näkymän keskelle. Palauttaa true, jos jokin muuttui. */
  function layout(wrap, el, st) {
    var W = wrap.clientWidth, H = wrap.clientHeight;
    if (!W || !H) return false;
    var D = Math.ceil(Math.sqrt(W * W + H * H)) + 2;
    // Kokonaislukusiirtymä pitää kartan terävänä, kun sitä ei ole käännetty.
    var Dx = D + ((D - W) % 2), Dy = D + ((D - H) % 2);
    if (st && st.W === W && st.H === H && st.Dx === Dx && st.Dy === Dy) return false;
    el.style.width = Dx + 'px';
    el.style.height = Dy + 'px';
    el.style.left = ((W - Dx) / 2) + 'px';
    el.style.top = ((H - Dy) / 2) + 'px';
    if (st) { st.W = W; st.H = H; st.Dx = Dx; st.Dy = Dy; }
    return true;
  }

  /** Näytöltä näkyvän alueen ympäröivä suorakaide kartan omassa (kääntämättömässä) koordinaatistossa. */
  function visibleSize(st) {
    var c = Math.abs(st.cos), s = Math.abs(st.sin);
    return L.point(Math.ceil(st.W * c + st.H * s), Math.ceil(st.W * s + st.H * c));
  }

  /** Näytön piste (clientX, clientY) -> säiliön piste. */
  function screenToContainer(st, cx, cy) {
    var r = st.wrap.getBoundingClientRect();
    var x = cx - r.left - st.W / 2, y = cy - r.top - st.H / 2;
    return L.point(st.cos * x + st.sin * y + st.Dx / 2, -st.sin * x + st.cos * y + st.Dy / 2);
  }

  /** Säiliön piste -> näytön piste (clientX, clientY). */
  function containerToScreen(st, p) {
    var r = st.wrap.getBoundingClientRect();
    var x = p.x - st.Dx / 2, y = p.y - st.Dy / 2;
    return L.point(st.cos * x - st.sin * y + st.W / 2 + r.left, st.sin * x + st.cos * y + st.H / 2 + r.top);
  }

  // ---------------------------------------------------------------------------
  // Leafletin laajennukset (koskevat vain karttaa, jolle install() on ajettu)
  // ---------------------------------------------------------------------------

  var patched = false;
  function patchLeaflet() {
    if (patched) return;
    patched = true;

    // Napautukset, nipistys ja tuplanapautus: kosketuskohta käännettyyn koordinaatistoon.
    var toContainer = L.Map.prototype.mouseEventToContainerPoint;
    L.Map.prototype.mouseEventToContainerPoint = function (e) {
      var st = this._mkRot;
      return st ? screenToContainer(st, e.clientX, e.clientY) : toContainer.call(this, e);
    };

    // Tiilet vain näkyvälle alueelle (sama laskenta kuin Leafletissa, mutta näkymän koolla).
    var tiledBounds = L.GridLayer.prototype._getTiledPixelBounds;
    L.GridLayer.prototype._getTiledPixelBounds = function (center) {
      var map = this._map, st = map && map._mkRot;
      if (!st) return tiledBounds.call(this, center);
      var zoom = map._animatingZoom ? Math.max(map._animateToZoom, map.getZoom()) : map.getZoom(),
          scale = map.getZoomScale(zoom, this._tileZoom),
          pixelCenter = map.project(center, this._tileZoom).floor(),
          half = visibleSize(st).divideBy(scale * 2);
      return new L.Bounds(pixelCenter.subtract(half), pixelCenter.add(half));
    };

    // Yhden sormen siirto: sormen liike näytöllä muunnetaan kartan suuntaiseksi. Liike kertyy
    // pala kerrallaan, joten kompassin kääntäessä karttaa kesken siirron kartta ei nytkähdä.
    var dragMove = L.Draggable.prototype._onMove;
    L.Draggable.prototype._onMove = function (e) {
      var st = this._dragStartTarget && this._dragStartTarget._mkRot;
      if (!st || !this._enabled || !this._startPoint || (e.touches && e.touches.length > 1)) return dragMove.call(this, e);
      var first = e.touches && e.touches.length === 1 ? e.touches[0] : e;
      if (this._mkStart !== this._startPoint) {
        this._mkStart = this._startPoint;
        this._mkLast = [this._startPoint.x, this._startPoint.y];
        this._mkAcc = [0, 0];
      }
      var dx = first.clientX - this._mkLast[0], dy = first.clientY - this._mkLast[1];
      this._mkLast = [first.clientX, first.clientY];
      this._mkAcc[0] += st.cos * dx + st.sin * dy;
      this._mkAcc[1] += -st.sin * dx + st.cos * dy;
      // Leaflet jakaa siirron säiliön skaalalla, joka käännetyllä säiliöllä ei ole 1: kumotaan se.
      var sc = this._parentScale || { x: 1, y: 1 };
      var p = { clientX: this._startPoint.x + this._mkAcc[0] * sc.x, clientY: this._startPoint.y + this._mkAcc[1] * sc.y };
      return dragMove.call(this, {
        touches: e.touches ? [p] : undefined,
        clientX: p.clientX, clientY: p.clientY,
        target: e.target, srcElement: e.srcElement, type: e.type, originalEvent: e,
        preventDefault: function () { if (e.cancelable !== false) e.preventDefault(); },
        stopPropagation: function () { e.stopPropagation(); }
      });
    };
  }

  /**
   * Ottaa kääntämisen käyttöön kartalle. wrap = näkymän kokoinen elementti, jonka sisällä
   * Leaflet-säiliö on. Kutsu layout(wrap, säiliö) ennen L.map-kutsua, jotta kartan koko on oikea.
   * Asetukset: threshold = kahden sormen kiertokulma (astetta), jonka jälkeen kääntö alkaa.
   * Tapahtumat kartalla: 'rotate' (suunta muuttui), 'rotatestart' (käyttäjä aloitti käännön sormin).
   */
  function install(map, wrap, opts) {
    opts = opts || {};
    patchLeaflet();
    var el = map.getContainer();
    var st = { wrap: wrap, bearing: 0, cos: 1, sin: 0, W: 0, H: 0, Dx: 0, Dy: 0 };
    layout(wrap, el, st);
    el._mkRot = st;
    map._mkRot = st;
    el.classList.add('mk-rot');
    el.style.setProperty('--mk-unrot', '0deg');

    // Painikkeet ja tekijätiedot pysyvät pystyssä näkymän reunoilla: siirretään ne käännettävän säiliön ulkopuolelle.
    var ui = L.DomUtil.create('div', 'leaflet-container leaflet-touch mk-map-ui', wrap);
    if (map._controlContainer) ui.appendChild(map._controlContainer);

    function relayout() {
      if (layout(wrap, el, st)) {
        map.invalidateSize({ pan: true });
        scheduleTiles();
      }
    }
    if (global.ResizeObserver) new global.ResizeObserver(relayout).observe(wrap);
    global.addEventListener('resize', relayout);

    // --- Karttatiilten päivitys kääntämisen jälkeen ---
    var tilesTimer = 0, tilesLast = 0;
    function scheduleTiles() {
      if (tilesTimer) return;
      tilesTimer = setTimeout(function () {
        tilesTimer = 0;
        tilesLast = Date.now();
        refreshTiles();
      }, Math.max(0, 150 - (Date.now() - tilesLast)));
    }
    function refreshTiles() {
      if (!map._loaded) return;
      if (map._animatingZoom) { scheduleTiles(); return; }
      var z = map.getZoom();
      map.eachLayer(function (l) {
        // Vain lisää puuttuvia tiiliä nykyiselle tasolle; tason vaihdot hoitaa Leaflet itse.
        if (l instanceof L.GridLayer && l._map && l._tileZoom !== undefined && Math.abs(z - l._tileZoom) <= 1) l._update();
      });
    }

    // --- Suunta ---
    function setBearing(b) {
      b = norm360(Number(b) || 0);
      if (Math.abs(angleDiff(st.bearing, b)) < 1e-6) return map;
      st.bearing = b;
      st.cos = Math.cos(b * RAD);
      st.sin = Math.sin(b * RAD);
      el.style.transform = b ? 'rotate(' + b.toFixed(3) + 'deg)' : '';
      el.style.setProperty('--mk-unrot', (b ? -Number(b.toFixed(3)) : 0) + 'deg');
      map.fire('rotate', { bearing: b });
      scheduleTiles();
      return map;
    }
    function getBearing() { return st.bearing; }

    // --- Kahden sormen kääntö ---
    // Nipistys kääntäisi karttaa herkästi myös zoomatessa: kääntö alkaa vasta, kun sormia on kierretty
    // kynnyskulman verran, ja jatkuu siitä ilman nykäystä. Leafletin nipistyszoomaus toimii samaan aikaan,
    // joten kartta kääntyy sormien välisen pisteen ympäri.
    var threshold = Math.max(0, Number(opts.threshold) || 0), g = null;
    function pairAngle(t) { return Math.atan2(t[1].clientY - t[0].clientY, t[1].clientX - t[0].clientX) / RAD; }
    function begin(e) {
      g = e.touches && e.touches.length === 2 && opts.touchRotate !== false ?
        { last: pairAngle(e.touches), acc: 0, b0: st.bearing, free: threshold === 0 } : null;
    }
    function move(e) {
      if (!g || !e.touches || e.touches.length !== 2) return;
      var a = pairAngle(e.touches);
      g.acc += angleDiff(g.last, a);
      g.last = a;
      if (!g.free) {
        if (Math.abs(g.acc) < threshold) return;
        g.free = true;
        g.acc = 0;
        g.b0 = st.bearing;
        map.fire('rotatestart', { manual: true });
        return;
      }
      setBearing(g.b0 + g.acc);
    }
    function end(e) {
      if (e.touches && e.touches.length === 2) { begin(e); return; }
      g = null;
      scheduleTiles();
    }
    // Kaappausvaihe: suunta päivitetään ennen kuin Leafletin nipistyszoomaus laskee sormien paikat.
    var opt = { passive: true, capture: true };
    el.addEventListener('touchstart', begin, opt);
    document.addEventListener('touchmove', move, opt);
    document.addEventListener('touchend', end, opt);
    document.addEventListener('touchcancel', end, opt);

    // --- Näkymän sovitus käännetyllä kartalla ---
    function fitBounds(bounds, o) {
      o = o || {};
      bounds = L.latLngBounds(bounds);
      var tl = L.point(o.paddingTopLeft || [0, 0]), br = L.point(o.paddingBottomRight || [0, 0]);
      var z0 = map.getZoom();
      var a = map.project(bounds.getNorthWest(), z0), b = map.project(bounds.getSouthEast(), z0);
      var w = Math.abs(b.x - a.x), h = Math.abs(b.y - a.y), c = Math.abs(st.cos), s = Math.abs(st.sin);
      var bw = Math.max(1e-9, w * c + h * s), bh = Math.max(1e-9, w * s + h * c);
      var aw = Math.max(1, st.W - tl.x - br.x), ah = Math.max(1, st.H - tl.y - br.y);
      var zoom = map.getScaleZoom(Math.min(aw / bw, ah / bh), z0);
      var snap = map.options.zoomSnap;
      if (snap) zoom = Math.floor(Math.round(zoom / (snap / 100)) * (snap / 100) / snap) * snap;
      if (!isFinite(zoom)) zoom = map.getMaxZoom();
      zoom = Math.max(map.getMinZoom(), Math.min(o.maxZoom || map.getMaxZoom(), zoom));
      // Reunojen erot siirtävät keskipistettä näytöllä; muunnetaan siirtymä kartan suuntaan.
      var ox = (br.x - tl.x) / 2, oy = (br.y - tl.y) / 2;
      var off = L.point(st.cos * ox + st.sin * oy, -st.sin * ox + st.cos * oy);
      var mid = map.project(bounds.getSouthWest(), zoom).add(map.project(bounds.getNorthEast(), zoom)).divideBy(2).add(off);
      return map.setView(map.unproject(mid, zoom), zoom, o);
    }

    var api = {
      setBearing: setBearing,
      getBearing: getBearing,
      fitBounds: fitBounds,
      /** Näkyvän alueen ympäröivä suorakaide säiliön koordinaateissa: {x, y, w, h}. */
      visibleRect: function () {
        var v = visibleSize(st);
        return { x: Math.floor((st.Dx - v.x) / 2), y: Math.floor((st.Dy - v.y) / 2), w: v.x, h: v.y };
      },
      screenToLatLng: function (p) { p = L.point(p); return map.containerPointToLatLng(screenToContainer(st, p.x, p.y)); },
      latLngToScreen: function (ll) { return containerToScreen(st, map.latLngToContainerPoint(ll)); },
      refreshTiles: scheduleTiles
    };
    map.setBearing = setBearing;
    map.getBearing = getBearing;
    return api;
  }

  global.MKRotate = { layout: layout, install: install, angleDiff: angleDiff, norm360: norm360 };
})(window);
