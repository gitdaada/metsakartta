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
    var code = new Uint8Array(n), ht = new Uint8Array(n), bl = new Uint8Array(n);
    var sumR = 0, sumG = 0, sumB = 0;
    for (var i = 0, j = 0; i < n; i++, j += 4) {
      code[i] = data[j]; ht[i] = data[j + 1]; bl[i] = data[j + 2];
      sumR += data[j]; sumG += data[j + 1]; sumB += data[j + 2];
    }
    return { code: code, ht: ht, bl: bl, sumR: sumR, sumG: sumG, sumB: sumB };
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

  // --- Tuuli -------------------------------------------------------------------

  var DIR_FROM = ['pohjoisesta', 'koillisesta', 'idästä', 'kaakosta', 'etelästä', 'lounaasta', 'lännestä', 'luoteesta'];
  var DIR_TO = ['pohjoiseen', 'koilliseen', 'itään', 'kaakkoon', 'etelään', 'lounaaseen', 'länteen', 'luoteeseen'];

  function norm360(d) { d = d % 360; return d < 0 ? d + 360 : d; }
  function sector8(deg) { return Math.round(norm360(deg) / 45) % 8; }
  /** Tuulen tulosuunta (meteorologinen, mistä puhaltaa) sanana: "lounaasta". */
  function windFromName(deg) { return DIR_FROM[sector8(deg)]; }
  /** Suunta, johon tuuli (ja haju) kulkee: "koilliseen". */
  function windToName(deg) { return DIR_TO[sector8(deg + 180)]; }

  /** Viuhkan puolikulma asteina tuulen nopeuden mukaan (heikko tuuli = epävarma suunta = leveä). */
  function fanHalfAngle(speed) {
    if (speed === null || speed === undefined || !isFinite(speed)) return 25;
    if (speed < 1.5) return 45;
    if (speed < 3) return 30;
    if (speed < 6) return 22;
    return 15;
  }

  /** Piste etäisyyden ja suunnan päässä (pallomalli). Palauttaa [lat, lon]. */
  function destPoint(lat, lon, bearingDeg, distM) {
    var R = 6371008.8, d = distM / R, b = bearingDeg * Math.PI / 180;
    var p1 = lat * Math.PI / 180, l1 = lon * Math.PI / 180;
    var p2 = Math.asin(Math.sin(p1) * Math.cos(d) + Math.cos(p1) * Math.sin(d) * Math.cos(b));
    var l2 = l1 + Math.atan2(Math.sin(b) * Math.sin(d) * Math.cos(p1), Math.cos(d) - Math.sin(p1) * Math.sin(p2));
    return [p2 * 180 / Math.PI, ((l2 * 180 / Math.PI + 540) % 360) - 180];
  }

  /** Viuhkan kaistale [r0, r1] metriä, keskisuunta bearing, puolikulma half. Palauttaa renkaan [[lat, lon], ...]. */
  function fanBand(lat, lon, bearing, half, r0, r1, steps) {
    var n = steps || 16, ring = [], i, a;
    for (i = 0; i <= n; i++) { a = bearing - half + (2 * half * i / n); ring.push(destPoint(lat, lon, a, r1)); }
    if (r0 <= 0) ring.push([lat, lon]);
    else for (i = n; i >= 0; i--) { a = bearing - half + (2 * half * i / n); ring.push(destPoint(lat, lon, a, r0)); }
    return ring;
  }

  function cleanNum(v) {
    if (v === null || v === undefined || v === '') return null;
    var n = Number(v);
    return isFinite(n) ? n : null;
  }

  /** Ilmatieteen laitoksen WFS "simple" -vastaus -> [{t, dir, spd, gust}]. Heittää virheen, jos vastaus on virheilmoitus. */
  function parseFmiWind(xmlText, DOMParserCtor) {
    var P = DOMParserCtor || (typeof DOMParser !== 'undefined' ? DOMParser : null);
    var doc = new P().parseFromString(xmlText, 'application/xml');
    if (doc.getElementsByTagName('parsererror').length) throw new Error('FMI: virheellinen XML');
    var ex = doc.getElementsByTagNameNS('*', 'ExceptionText');
    if (ex.length) throw new Error('FMI: ' + (ex[0].textContent || 'virhe').trim().slice(0, 160));
    var els = doc.getElementsByTagNameNS('*', 'BsWfsElement'), byT = {};
    for (var i = 0; i < els.length; i++) {
      var el = els[i];
      var t = Date.parse((el.getElementsByTagNameNS('*', 'Time')[0] || {}).textContent);
      var name = ((el.getElementsByTagNameNS('*', 'ParameterName')[0] || {}).textContent || '').trim();
      var val = cleanNum(((el.getElementsByTagNameNS('*', 'ParameterValue')[0] || {}).textContent || '').trim());
      if (!isFinite(t)) continue;
      var e = byT[t] || (byT[t] = { t: t, dir: null, spd: null, gust: null, temp: null, rh: null, prec: null });
      if (name === 'WindDirection') e.dir = val;
      else if (name === 'WindSpeedMS') e.spd = val;
      else if (name === 'WindGust') e.gust = val;
      else if (name === 'Temperature') e.temp = val;
      else if (name === 'Humidity') e.rh = val;
      else if (name === 'Precipitation1h') e.prec = val;
    }
    return Object.keys(byT).map(function (k) { return byT[k]; })
      .filter(function (e) { return e.dir !== null; })
      .sort(function (a, b) { return a.t - b.t; });
  }

  /** Open-Meteo JSON -> [{t, dir, spd, gust}] (ajat GMT). */
  function parseOpenMeteoWind(j) {
    var hr = j && j.hourly;
    if (!hr || !hr.time) throw new Error('Open-Meteo: odottamaton vastaus');
    var out = [];
    for (var i = 0; i < hr.time.length; i++) {
      var t = Date.parse(hr.time[i] + (/Z$|[+-]\d\d:?\d\d$/.test(hr.time[i]) ? '' : 'Z'));
      var dir = cleanNum(hr.wind_direction_10m && hr.wind_direction_10m[i]);
      if (!isFinite(t) || dir === null) continue;
      out.push({ t: t, dir: dir, spd: cleanNum(hr.wind_speed_10m && hr.wind_speed_10m[i]), gust: cleanNum(hr.wind_gusts_10m && hr.wind_gusts_10m[i]),
                 temp: cleanNum(hr.temperature_2m && hr.temperature_2m[i]), rh: cleanNum(hr.relative_humidity_2m && hr.relative_humidity_2m[i]),
                 prec: cleanNum(hr.precipitation && hr.precipitation[i]) });
    }
    return out;
  }

  /** Lähin ennustetunti hetkelle now (enintään 90 min päässä), muuten null. */
  function pickWind(series, now) {
    var best = null, bd = Infinity;
    (series || []).forEach(function (e) { var d = Math.abs(e.t - now); if (d < bd) { bd = d; best = e; } });
    return bd <= 90 * 60 * 1000 ? best : null;
  }

  // --- Sade (MET Norway Nowcast) -----------------------------------------------

  function round4(v) { return Math.round(v * 1e4) / 1e4; }

  /** n x n -pisteruudukko ±halfKm keskipisteen ympärillä. Keskipiste pyöristetään ~1 km tarkkuuteen. */
  function rainGrid(lat, lon, halfKm, n) {
    var cLat = Math.round(lat * 100) / 100, cLon = Math.round(lon * 50) / 50; // 0,01° lat ≈ 1,1 km, 0,02° lon ≈ 1,1 km (60–70° N)
    var dLat = halfKm / 111.32, dLon = halfKm / (111.32 * Math.cos(cLat * Math.PI / 180));
    var pts = [];
    for (var j = 0; j < n; j++) {      // j = rivi pohjoisesta etelään
      for (var i = 0; i < n; i++) {    // i = sarake lännestä itään
        var fy = n > 1 ? j / (n - 1) : 0.5, fx = n > 1 ? i / (n - 1) : 0.5;
        pts.push({ i: i, j: j, lat: round4(cLat + dLat - 2 * dLat * fy), lon: round4(cLon - dLon + 2 * dLon * fx) });
      }
    }
    return { center: [cLat, cLon], bounds: [[round4(cLat - dLat), round4(cLon - dLon)], [round4(cLat + dLat), round4(cLon + dLon)]], points: pts, n: n };
  }

  /** MET Nowcast 2.0 -vastaus -> {coverage, series: [{t, r}]} (r = mm/h tai null). */
  function parseNowcast(j) {
    var p = j && j.properties;
    if (!p || !Array.isArray(p.timeseries)) throw new Error('MET: odottamaton vastaus');
    var cov = (p.meta && p.meta.radar_coverage) || 'unknown';
    var series = [];
    p.timeseries.forEach(function (e) {
      var t = Date.parse(e.time);
      var d = e.data && e.data.instant && e.data.instant.details;
      if (!isFinite(t)) return;
      series.push({ t: t, r: d ? cleanNum(d.precipitation_rate) : null });
    });
    return { coverage: String(cov), series: series };
  }

  /** Yhdistää pisteiden aikasarjat kehyksiksi: times[k], frames[k][j*n+i] (mm/h tai null). */
  function rainFrames(results, n) {
    var tset = {};
    results.forEach(function (r) { if (r) r.series.forEach(function (e) { tset[e.t] = 1; }); });
    var times = Object.keys(tset).map(Number).sort(function (a, b) { return a - b; });
    var idx = {};
    times.forEach(function (t, k) { idx[t] = k; });
    var frames = times.map(function () { var f = new Array(n * n); for (var q = 0; q < f.length; q++) f[q] = null; return f; });
    results.forEach(function (r, pi) {
      if (!r) return;
      r.series.forEach(function (e) { if (e.r !== null) frames[idx[e.t]][pi] = e.r; });
    });
    return { times: times, frames: frames };
  }

  // Sateen värit: syaani -> keltainen -> oranssi (punainen, vihreä, sininen ja violetti ovat jo käytössä).
  var RAIN_STOPS = [
    [0.1, [165, 243, 252, 0.35]],
    [0.5, [34, 211, 238, 0.45]],
    [2, [253, 224, 71, 0.55]],
    [5, [251, 146, 60, 0.64]],
    [10, [234, 88, 12, 0.72]]
  ];
  function rainColor(r) {
    if (r === null || r === undefined || !(r >= RAIN_STOPS[0][0])) return null;
    for (var k = RAIN_STOPS.length - 1; k >= 0; k--) {
      if (r >= RAIN_STOPS[k][0]) {
        if (k === RAIN_STOPS.length - 1) return RAIN_STOPS[k][1].slice();
        var a = RAIN_STOPS[k], b = RAIN_STOPS[k + 1], f = (r - a[0]) / (b[0] - a[0]);
        return [lerp(a[1][0], b[1][0], f), lerp(a[1][1], b[1][1], f), lerp(a[1][2], b[1][2], f), a[1][3] + (b[1][3] - a[1][3]) * f];
      }
    }
    return null;
  }

  /**
   * Piirtää kehyksen size x size RGBA-kuvaksi: bilineaarinen interpolointi ruudukon pisteiden välillä,
   * pyöreä rajaus ja pehmeä reuna. Puuttuvat arvot tulkitaan nollaksi.
   */
  function renderRain(frame, n, size, out) {
    var data = out || new Uint8ClampedArray(size * size * 4), any = false;
    for (var y = 0; y < size; y++) {
      for (var x = 0; x < size; x++) {
        var o = (y * size + x) * 4;
        var u = (x + 0.5) / size, v = (y + 0.5) / size;
        var dx = u - 0.5, dy = v - 0.5, rr = Math.sqrt(dx * dx + dy * dy) * 2; // 0 keskellä, 1 ympyrän reunalla
        if (rr >= 1) { data[o + 3] = 0; continue; }
        var gx = u * (n - 1), gy = v * (n - 1);
        var i0 = Math.min(n - 2, Math.floor(gx)), j0 = Math.min(n - 2, Math.floor(gy));
        var fx = gx - i0, fy = gy - j0;
        var g = function (i, j) { var val = frame[j * n + i]; return val === null || val === undefined ? 0 : val; };
        var r = g(i0, j0) * (1 - fx) * (1 - fy) + g(i0 + 1, j0) * fx * (1 - fy) + g(i0, j0 + 1) * (1 - fx) * fy + g(i0 + 1, j0 + 1) * fx * fy;
        var c = rainColor(r);
        if (!c) { data[o + 3] = 0; continue; }
        var edge = rr > 0.82 ? Math.max(0, (1 - rr) / 0.18) : 1;
        data[o] = c[0]; data[o + 1] = c[1]; data[o + 2] = c[2]; data[o + 3] = Math.round(255 * c[3] * edge);
        any = true;
      }
    }
    return { data: data, any: any };
  }

  /** Lyhyt yhteenveto yhden pisteen sarjasta: sataako nyt, milloin alkaa tai loppuu. */
  function rainSummary(series, now) {
    var s = (series || []).filter(function (e) { return e.t >= now - 5 * 60000; });
    if (!s.length) return null;
    var wet = function (e) { return e.r !== null && e.r >= 0.1; };
    var max = 0; s.forEach(function (e) { if (e.r !== null && e.r > max) max = e.r; });
    if (wet(s[0])) {
      var stop = null;
      for (var k = 1; k < s.length; k++) if (!wet(s[k])) { stop = s[k].t; break; }
      return { state: 'raining', rate: s[0].r, until: stop, max: max };
    }
    for (var m = 1; m < s.length; m++) if (wet(s[m])) return { state: 'coming', at: s[m].t, rate: s[m].r, max: max };
    return { state: 'dry', max: max };
  }

  /** Tiilen välimuistiavain ilman api-avainta: sama tiili säilyy, vaikka avain vaihtuu. */
  function tileCacheKey(url) {
    var q = url.indexOf('?');
    return q < 0 ? url : url.slice(0, q);
  }


  // --- Aurinko -----------------------------------------------------------------
  // Auringon nousu ja lasku tähtitieteellisillä kaavoilla (NOAA; sama laskentatapa kuin SunCalc-kirjastossa).
  // Tarkkuus noin minuutti. Toimii ilman verkkoa.

  var RAD = Math.PI / 180, DAYMS = 86400000, J1970 = 2440588, J2000 = 2451545, OBL = RAD * 23.4397, J0 = 0.0009;
  function toDays(ms) { return ms / DAYMS - 0.5 + J1970 - J2000; }
  function fromJulian(j) { return (j + 0.5 - J1970) * DAYMS; }

  /**
   * Auringon tapahtumat sen vuorokauden osalta, jonka keskipäivä on lähinnä hetkeä ms (anna paikallinen keskipäivä).
   * Palauttaa {noon, rise, set, dawn, dusk}; rise/set = null ja polar = 'day' | 'night', jos aurinko ei nouse tai laske.
   * dawn/dusk = porvarillinen hämärä (aurinko 6° horisontin alla).
   */
  function sunTimes(ms, lat, lon) {
    var lw = RAD * -lon, phi = RAD * lat, d = toDays(ms);
    var n = Math.round(d - J0 - lw / (2 * Math.PI));
    var ds = J0 + lw / (2 * Math.PI) + n;
    var M = RAD * (357.5291 + 0.98560028 * ds);
    var C = RAD * (1.9148 * Math.sin(M) + 0.02 * Math.sin(2 * M) + 0.0003 * Math.sin(3 * M));
    var L = M + C + RAD * 102.9372 + Math.PI;
    var dec = Math.asin(Math.sin(OBL) * Math.sin(L));
    var Jnoon = J2000 + ds + 0.0053 * Math.sin(M) - 0.0069 * Math.sin(2 * L);
    function at(h0) {
      var cosH = (Math.sin(h0 * RAD) - Math.sin(phi) * Math.sin(dec)) / (Math.cos(phi) * Math.cos(dec));
      if (cosH > 1) return { polar: 'night' };
      if (cosH < -1) return { polar: 'day' };
      var w = Math.acos(cosH);
      var a = J0 + (w + lw) / (2 * Math.PI) + n;
      var Jset = J2000 + a + 0.0053 * Math.sin(M) - 0.0069 * Math.sin(2 * L);
      return { set: fromJulian(Jset), rise: fromJulian(Jnoon - (Jset - Jnoon)) };
    }
    var s = at(-0.833), c = at(-6);
    return { noon: fromJulian(Jnoon), rise: s.rise || null, set: s.set || null, polar: s.polar || null,
             dawn: c.rise || null, dusk: c.set || null };
  }

  /** Paikallinen keskipäivä päivälle, johon hetki ms kuuluu (+ dayOffset päivää). */
  function localNoon(ms, dayOffset) {
    var d = new Date(ms);
    d.setHours(12, 0, 0, 0);
    if (dayOffset) d.setDate(d.getDate() + dayOffset);
    return d.getTime();
  }

  /**
   * Seuraava auringon tapahtuma hetkestä now: {kind: 'rise'|'set'|'dusk', at, today, tomorrow, polar}.
   * today/tomorrow = sunTimes-tulokset.
   */
  function sunStatus(now, lat, lon) {
    var today = sunTimes(localNoon(now, 0), lat, lon), tomorrow = sunTimes(localNoon(now, 1), lat, lon);
    var r = { today: today, tomorrow: tomorrow, kind: null, at: null, polar: today.polar };
    if (today.polar) return r;
    if (now < today.rise) { r.kind = 'rise'; r.at = today.rise; }
    else if (now < today.set) { r.kind = 'set'; r.at = today.set; }
    else if (today.dusk && now < today.dusk) { r.kind = 'dusk'; r.at = today.dusk; }
    else if (tomorrow.rise) { r.kind = 'rise'; r.at = tomorrow.rise; r.nextDay = true; }
    else r.polar = tomorrow.polar;
    return r;
  }

  // --- Koiran hajuolosuhteet ---------------------------------------------------------
  // Suuntaa antava arvio: viileä ja kostea sää sekä kohtalainen tuuli kantavat hajua parhaiten.
  // Kuumuus, kuivuus, kova tuuli, tyyni, pakkanen ja rankkasade heikentävät.

  function scentIndex(w) {
    if (!w || w.temp === null || w.temp === undefined || w.rh === null || w.rh === undefined) return null;
    var score = 100, notes = [], t = w.temp, rh = w.rh, v = w.spd, p = w.prec;
    if (t < -5) { score -= 25; notes.push('pakkanen'); }
    else if (t < 0) { score -= 10; notes.push('pakkasta'); }
    else if (t > 25) { score -= 40; notes.push('helle'); }
    else if (t > 20) { score -= 25; notes.push('lämmin'); }
    else if (t > 15) { score -= 10; notes.push('lämpöä'); }
    if (rh < 40) { score -= 30; notes.push('hyvin kuiva ilma'); }
    else if (rh < 55) { score -= 15; notes.push('kuiva ilma'); }
    if (v !== null && v !== undefined) {
      if (v < 0.5) { score -= 20; notes.push('tyyntä, haju ei kulje'); }
      else if (v < 1) { score -= 10; notes.push('lähes tyyntä'); }
      else if (v > 9) { score -= 30; notes.push('kova tuuli hajottaa hajun'); }
      else if (v > 6) { score -= 15; notes.push('navakka tuuli'); }
    }
    if (p !== null && p !== undefined && p > 2) { score -= 20; notes.push('runsas sade'); }
    score = Math.max(0, Math.min(100, score));
    var level = score >= 75 ? 'hyvä' : (score >= 50 ? 'kohtalainen' : 'heikko');
    if (!notes.length) notes.push('viileää ja kosteaa, sopiva tuuli');
    return { score: score, level: level, notes: notes };
  }

  // --- Kompassi --------------------------------------------------------------------

  /**
   * Laitteen yläreunan kompassisuunta (0 = pohjoinen, myötäpäivään) laitteen asentotiedoista.
   * alpha = absoluuttinen kiertymä (deviceorientationabsolute), beta = kallistus, screenAngle = näytön kierto.
   * iOS: webkitCompassHeading on valmiiksi kompassisuunta. Palauttaa null, jos suunta ei ole luotettava.
   */
  function compassHeading(e, screenAngle) {
    var sa = Number(screenAngle) || 0;
    if (e && typeof e.webkitCompassHeading === 'number' && isFinite(e.webkitCompassHeading)) return norm360(e.webkitCompassHeading + sa);
    if (!e || typeof e.alpha !== 'number' || !isFinite(e.alpha)) return null;
    if (typeof e.beta === 'number' && Math.abs(e.beta) > 80) return null; // pystyssä: yläreunan suunta epävakaa
    return norm360(360 - e.alpha + sa);
  }

  /** Lyhin kulmaero b - a välillä -180...180. */
  function angleDiff(a, b) { return ((b - a) % 360 + 540) % 360 - 180; }

  // --- Elinympäristö ---------------------------------------------------------------

  var HABITAT_LEVELS = [128, 191]; // 0,5 = sopiva, 0,75 = hyvä

  /**
   * Piirtää valitun lajin elinympäristön tiileen. hab = Uint8Array (0-255) samassa ruudukossa kuin metsärasteri.
   * colors = [sopiva, hyvä] (packRGBA).
   */
  function renderHabitatTile(F, hab, x, y, z, out, colors, size) {
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
    var any = false, l0 = HABITAT_LEVELS[0], l1 = HABITAT_LEVELS[1];
    for (var py = 0; py < S; py++) {
      var sy = Math.floor((F.my1 - (ty0 - (py + 0.5) * res)) / F.ry);
      if (sy < 0 || sy >= F.h) continue;
      var base = sy * F.w, row = py * S;
      for (px = 0; px < S; px++) {
        var c0 = cols[px];
        if (c0 < 0) continue;
        var v = hab[base + c0];
        if (v < l0) continue;
        out[row + px] = v >= l1 ? colors[1] : colors[0];
        any = true;
      }
    }
    return any;
  }

  function habitatLevel(v) { return v >= HABITAT_LEVELS[1] ? 2 : (v >= HABITAT_LEVELS[0] ? 1 : 0); }

  root.MK = {
    EARTH_R: EARTH_R, WORLD: WORLD, COLORS: COLORS,
    packRGBA: packRGBA, ageColor: ageColor, buildPalette: buildPalette, cssRGB: cssRGB,
    lonLatToMerc: lonLatToMerc, mercToLonLat: mercToLonLat,
    lon2tile: lon2tile, lat2tile: lat2tile, tileRange: tileRange, countTiles: countTiles, listTiles: listTiles,
    decodeRGB: decodeRGB, makeForest: makeForest, sampleIndex: sampleIndex, renderTile: renderTile,
    describe: describe, stats: stats, geometryContains: geometryContains, tileCacheKey: tileCacheKey,
    norm360: norm360, windFromName: windFromName, windToName: windToName, fanHalfAngle: fanHalfAngle,
    destPoint: destPoint, fanBand: fanBand, parseFmiWind: parseFmiWind, parseOpenMeteoWind: parseOpenMeteoWind,
    pickWind: pickWind,
    rainGrid: rainGrid, parseNowcast: parseNowcast, rainFrames: rainFrames, rainColor: rainColor,
    renderRain: renderRain, rainSummary: rainSummary, RAIN_STOPS: RAIN_STOPS,
    sunTimes: sunTimes, sunStatus: sunStatus, localNoon: localNoon, scentIndex: scentIndex,
    compassHeading: compassHeading, angleDiff: angleDiff,
    renderHabitatTile: renderHabitatTile, habitatLevel: habitatLevel, HABITAT_LEVELS: HABITAT_LEVELS
  };
})(typeof self !== 'undefined' ? self : this);
