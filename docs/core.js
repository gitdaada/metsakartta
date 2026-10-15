/*
 * Metsäkartan ydinlogiikka: värit, ruutujen piirto, koordinaatit ja tiililaskenta.
 * Ei riippuvuuksia DOMiin, jotta tätä voi testata erikseen.
 *
 * forest.png:n koodaus (ks. pipeline/build.py):
 *   R: 0 = ei tietoa, 1 = puuton, 2..255 = ikä + 2 (vuotta)
 *   G: keskipituus 0,2 m:n portain
 */
(function (root) {
  'use strict';

  var EARTH_R = 6378137;
  var WORLD = 2 * Math.PI * EARTH_R;
  var HALF = WORLD / 2;

  var COLORS = {
    treeless: [214, 40, 40],
    young: [0, 150, 50],      // nuorin metsä: voimakkain vihreä
    middle: [205, 232, 175],  // vanhenemista kohti haalistuu
    old: [30, 90, 200],       // vanha metsä
    hatch: [0, 70, 22]        // taimikon vinoviivoitus
  };

  function packRGBA(r, g, b, a) {
    // Little-endian Uint32 -> tavujärjestys R,G,B,A
    return ((a << 24) | (b << 16) | (g << 8) | r) >>> 0;
  }

  function lerp(a, b, t) { return Math.round(a + (b - a) * t); }

  function ageColor(age, oldAge) {
    if (age >= oldAge) return COLORS.old.slice();
    var t = oldAge > 1 ? Math.max(0, Math.min(1, age / (oldAge - 1))) : 0;
    return [lerp(COLORS.young[0], COLORS.middle[0], t),
            lerp(COLORS.young[1], COLORS.middle[1], t),
            lerp(COLORS.young[2], COLORS.middle[2], t)];
  }

  function buildPalette(oldAge) {
    var p = new Uint32Array(256);
    p[0] = 0;
    p[1] = packRGBA(COLORS.treeless[0], COLORS.treeless[1], COLORS.treeless[2], 255);
    for (var c = 2; c < 256; c++) {
      var col = ageColor(c - 2, oldAge);
      p[c] = packRGBA(col[0], col[1], col[2], 255);
    }
    return p;
  }

  function cssRGB(c) { return 'rgb(' + c[0] + ',' + c[1] + ',' + c[2] + ')'; }

  // --- Koordinaatit ---------------------------------------------------------

  function lonLatToMerc(lon, lat) {
    var x = EARTH_R * lon * Math.PI / 180;
    var y = EARTH_R * Math.log(Math.tan(Math.PI / 4 + lat * Math.PI / 360));
    return [x, y];
  }

  function mercToLonLat(x, y) {
    return [x / EARTH_R * 180 / Math.PI,
            (2 * Math.atan(Math.exp(y / EARTH_R)) - Math.PI / 2) * 180 / Math.PI];
  }

  function lon2tile(lon, z) { return Math.floor((lon + 180) / 360 * Math.pow(2, z)); }
  function lat2tile(lat, z) {
    var r = lat * Math.PI / 180;
    return Math.floor((1 - Math.log(Math.tan(r) + 1 / Math.cos(r)) / Math.PI) / 2 * Math.pow(2, z));
  }

  /** bounds = [[s, w], [n, e]]; padDeg laajentaa reunoja. */
  function tileRange(bounds, z, padDeg) {
    var pad = padDeg || 0;
    var s = bounds[0][0] - pad, w = bounds[0][1] - pad * 2, n = bounds[1][0] + pad, e = bounds[1][1] + pad * 2;
    return { z: z, x0: lon2tile(w, z), x1: lon2tile(e, z), y0: lat2tile(n, z), y1: lat2tile(s, z) };
  }

  function countTiles(bounds, zmin, zmax, padDeg) {
    var n = 0;
    for (var z = zmin; z <= zmax; z++) {
      var r = tileRange(bounds, z, padDeg);
      n += (r.x1 - r.x0 + 1) * (r.y1 - r.y0 + 1);
    }
    return n;
  }

  function listTiles(bounds, zmin, zmax, padDeg) {
    var out = [];
    for (var z = zmin; z <= zmax; z++) {
      var r = tileRange(bounds, z, padDeg);
      for (var x = r.x0; x <= r.x1; x++) for (var y = r.y0; y <= r.y1; y++) out.push([z, x, y]);
    }
    return out;
  }

  // --- Metsärasteri -----------------------------------------------------------

  /** Purkaa getImageData-datan koodiksi ja pituudeksi sekä laskee tarkistussummat. */
  function decodeRGB(data, w, h) {
    var n = w * h;
    var code = new Uint8Array(n), ht = new Uint8Array(n);
    var sumR = 0, sumG = 0;
    for (var i = 0, j = 0; i < n; i++, j += 4) {
      code[i] = data[j]; ht[i] = data[j + 1];
      sumR += data[j]; sumG += data[j + 1];
    }
    return { code: code, ht: ht, sumR: sumR, sumG: sumG };
  }

  /** forest = {code, ht, w, h, mx0, my0, mx1, my1, rx, ry} */
  function makeForest(decoded, meta) {
    var b = meta.mercBounds;
    return {
      code: decoded.code, ht: decoded.ht, w: meta.width, h: meta.height,
      mx0: b[0], my0: b[1], mx1: b[2], my1: b[3],
      rx: (b[2] - b[0]) / meta.width, ry: (b[3] - b[1]) / meta.height
    };
  }

  function sampleIndex(F, mx, my) {
    var sx = Math.floor((mx - F.mx0) / F.rx);
    var sy = Math.floor((F.my1 - my) / F.ry);
    if (sx < 0 || sy < 0 || sx >= F.w || sy >= F.h) return -1;
    return sy * F.w + sx;
  }

  /**
   * Piirtää yhden 256 px karttatiilen out-taulukkoon (Uint32Array, 65536).
   * opts: {palette, taimikkoCode, treelessCode, hatchPeriod, hatchWidth, hatchColor}
   * treelessCode: nuoret (alle 20 v) ruudut, joiden pituuskoodi on tätä pienempi, näytetään puuttomina.
   * Palauttaa true, jos tiileen piirtyi jotain.
   */
  function renderTile(F, x, y, z, out, opts, size) {
    var S = size || 256;
    var res = WORLD / (S * Math.pow(2, z));
    var tx0 = x * S * res - HALF;
    var ty0 = HALF - y * S * res;
    if (tx0 > F.mx1 || tx0 + S * res < F.mx0 || ty0 < F.my0 || ty0 - S * res > F.my1) return false;

    var cols = new Int32Array(S);
    for (var px = 0; px < S; px++) {
      var sx = Math.floor((tx0 + (px + 0.5) * res - F.mx0) / F.rx);
      cols[px] = (sx >= 0 && sx < F.w) ? sx : -1;
    }
    var pal = opts.palette, tcode = opts.taimikkoCode, lcode = opts.treelessCode || 0, per = opts.hatchPeriod || 9,
        hw = opts.hatchWidth || 2, hcol = opts.hatchColor, code = F.code, ht = F.ht;
    var gx0 = x * S, any = false;
    for (var py = 0; py < S; py++) {
      var sy = Math.floor((F.my1 - (ty0 - (py + 0.5) * res)) / F.ry);
      if (sy < 0 || sy >= F.h) continue;
      var base = sy * F.w, gy = y * S + py, row = py * S;
      for (px = 0; px < S; px++) {
        var c0 = cols[px];
        if (c0 < 0) continue;
        var i = base + c0, c = code[i];
        if (c === 0) continue;
        if (c >= 2 && c < 22 && ht[i] < lcode) c = 1;
        var col = pal[c];
        if (c >= 2 && tcode > 0 && ht[i] < tcode && ((gx0 + px + gy) % per) < hw) col = hcol;
        out[row + px] = col;
        any = true;
      }
    }
    return any;
  }

  /** Kuvaus napautetusta ruudusta. */
  function describe(c, h, oldAge, taimikkoM, treelessM) {
    if (!c) return null;
    if (c === 1) return { kind: 'treeless', title: 'Puuton', detail: 'Aukea, hakkuuaukko tai avosuo' };
    var age = c - 2, heightM = h * 0.2;
    if (age < 20 && h < Math.round((treelessM || 0) * 5)) {
      return { kind: 'treeless', title: 'Puuton / uudistusala', age: age, heightM: heightM,
        detail: 'Taimet alle ' + String(treelessM).replace('.', ',') + ' m' + (age > 0 ? ' · ikä n. ' + age + ' v' : '') };
    }
    var taimikko = heightM < taimikkoM;
    var kind = age >= oldAge ? 'old' : 'forest';
    var title = (taimikko ? 'Taimikko' : (kind === 'old' ? 'Vanha metsä' : (age < oldAge / 2 ? 'Nuori metsä' : 'Keski-ikäinen metsä')));
    var detail = 'Ikä n. ' + age + ' v' + (h > 0 ? ' · pituus n. ' + (heightM >= 10 ? Math.round(heightM) : heightM.toFixed(1).replace('.', ',')) + ' m' : '');
    return { kind: kind, taimikko: taimikko, age: age, heightM: heightM, title: title, detail: detail };
  }

  /** Osuusluvut metsäalasta. */
  function stats(F, oldAge, taimikkoCode, treelessCode) {
    var t = 0, young = 0, old = 0, taim = 0, total = 0, code = F.code, ht = F.ht;
    for (var i = 0, n = code.length; i < n; i++) {
      var c = code[i];
      if (!c) continue;
      total++;
      if (c === 1 || (c < 22 && ht[i] < (treelessCode || 0))) { t++; continue; }
      if (c - 2 >= oldAge) old++; else young++;
      if (ht[i] < taimikkoCode) taim++;
    }
    return { total: total, treeless: t, young: young, old: old, taimikko: taim };
  }

  // --- Geometria ---------------------------------------------------------------

  function ringContains(ring, x, y) {
    var inside = false;
    for (var i = 0, j = ring.length - 1; i < ring.length; j = i++) {
      var xi = ring[i][0], yi = ring[i][1], xj = ring[j][0], yj = ring[j][1];
      if (((yi > y) !== (yj > y)) && (x < (xj - xi) * (y - yi) / (yj - yi) + xi)) inside = !inside;
    }
    return inside;
  }

  function polygonContains(rings, x, y) {
    if (!rings.length || !ringContains(rings[0], x, y)) return false;
    for (var k = 1; k < rings.length; k++) if (ringContains(rings[k], x, y)) return false;
    return true;
  }

  function geometryContains(geom, lon, lat) {
    if (!geom) return false;
    if (geom.type === 'Polygon') return polygonContains(geom.coordinates, lon, lat);
    if (geom.type === 'MultiPolygon') {
      for (var i = 0; i < geom.coordinates.length; i++) if (polygonContains(geom.coordinates[i], lon, lat)) return true;
    }
    if (geom.type === 'GeometryCollection') {
      for (var g = 0; g < geom.geometries.length; g++) if (geometryContains(geom.geometries[g], lon, lat)) return true;
    }
    return false;
  }

  /** Tiilen välimuistiavain ilman api-avainta: sama tiili säilyy, vaikka avain vaihtuu. */
  function tileCacheKey(url) {
    var q = url.indexOf('?');
    return q < 0 ? url : url.slice(0, q);
  }

  root.MK = {
    EARTH_R: EARTH_R, WORLD: WORLD, COLORS: COLORS,
    packRGBA: packRGBA, ageColor: ageColor, buildPalette: buildPalette, cssRGB: cssRGB,
    lonLatToMerc: lonLatToMerc, mercToLonLat: mercToLonLat,
    lon2tile: lon2tile, lat2tile: lat2tile, tileRange: tileRange, countTiles: countTiles, listTiles: listTiles,
    decodeRGB: decodeRGB, makeForest: makeForest, sampleIndex: sampleIndex, renderTile: renderTile,
    describe: describe, stats: stats, geometryContains: geometryContains, tileCacheKey: tileCacheKey
  };
})(typeof self !== 'undefined' ? self : this);
