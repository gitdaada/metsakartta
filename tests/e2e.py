"""Selaintesti: python3 tests/e2e.py <testisivusto> <kuvakansio>

Käynnistää paikallisen palvelimen testisivustolle ja valekarttapalvelun (MML:n tilalla),
ja käy läpi: alueen avaus, napautus, GPS, offline-tallennus, uudelleenlataus ilman verkkoa.
"""
import io
import json
import sys
import threading
import time
from functools import partial
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer, BaseHTTPRequestHandler
from pathlib import Path
from urllib.parse import urlparse, parse_qs

from PIL import Image, ImageDraw
from playwright.sync_api import sync_playwright

SITE = Path(sys.argv[1])
SHOTS = Path(sys.argv[2])
SHOTS.mkdir(parents=True, exist_ok=True)
TILE_REQUESTS = []


class Quiet(SimpleHTTPRequestHandler):
    def log_message(self, *a):
        pass


class TileHandler(BaseHTTPRequestHandler):
    def log_message(self, *a):
        pass

    def do_GET(self):
        u = urlparse(self.path)
        key = parse_qs(u.query).get("api-key", [""])[0]
        TILE_REQUESTS.append(u.path)
        if key == "bad":
            self.send_response(403); self.send_header("Access-Control-Allow-Origin", "*"); self.end_headers(); return
        parts = u.path.rstrip("/").split("/")
        z, y, x = parts[-3], parts[-2], parts[-1].split(".")[0]
        im = Image.new("RGB", (256, 256), (236, 232, 214))
        d = ImageDraw.Draw(im)
        for i in range(0, 256, 64):
            d.line([(i, 0), (i, 256)], fill=(205, 198, 175))
            d.line([(0, i), (256, i)], fill=(205, 198, 175))
        d.rectangle([0, 0, 255, 255], outline=(150, 140, 120))
        d.text((8, 8), f"{z}/{x}/{y}", fill=(90, 80, 60))
        buf = io.BytesIO(); im.save(buf, "PNG")
        body = buf.getvalue()
        self.send_response(200)
        self.send_header("Content-Type", "image/png")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Access-Control-Allow-Origin", "*")
        self.end_headers()
        self.wfile.write(body)


def serve(handler, port):
    srv = ThreadingHTTPServer(("127.0.0.1", port), handler)
    threading.Thread(target=srv.serve_forever, daemon=True).start()
    return srv


WIND_CALLS = []
FMI_MODE = {"mode": "ok"}


def fmi_xml(dir_deg=225.0, spd=4.2, gust=8.1):
    import datetime as dt
    t0 = dt.datetime.now(dt.timezone.utc).replace(minute=0, second=0, microsecond=0) - dt.timedelta(hours=1)
    members = []
    for i in range(62):
        t = (t0 + dt.timedelta(hours=i)).strftime("%Y-%m-%dT%H:%M:%SZ")
        for name, val in (("WindDirection", dir_deg + i), ("WindSpeedMS", spd), ("WindGust", gust),
                          ("Temperature", 8.0 + (14 if 10 <= i <= 14 else 0)), ("Humidity", 85.0 - (50 if 10 <= i <= 14 else 0)),
                          ("Precipitation1h", 0.0)):
            members.append(f"""<wfs:member><BsWfs:BsWfsElement gml:id="e{i}{name}"><BsWfs:Location><gml:Point gml:id="p" srsName="http://www.opengis.net/def/crs/EPSG/0/4258"><gml:pos>61.24 25.10 </gml:pos></gml:Point></BsWfs:Location><BsWfs:Time>{t}</BsWfs:Time><BsWfs:ParameterName>{name}</BsWfs:ParameterName><BsWfs:ParameterValue>{val}</BsWfs:ParameterValue></BsWfs:BsWfsElement></wfs:member>""")
    return ('<?xml version="1.0" encoding="UTF-8"?><wfs:FeatureCollection timeStamp="x" numberMatched="1" numberReturned="1" '
            'xmlns:wfs="http://www.opengis.net/wfs/2.0" xmlns:gml="http://www.opengis.net/gml/3.2" xmlns:BsWfs="http://xml.fmi.fi/schema/wfs/2.0">'
            + "".join(members) + "</wfs:FeatureCollection>")


def om_json():
    import datetime as dt
    t0 = dt.datetime.now(dt.timezone.utc).replace(minute=0, second=0, microsecond=0) - dt.timedelta(hours=1)
    times = [(t0 + dt.timedelta(hours=i)).strftime("%Y-%m-%dT%H:%M") for i in range(61)]
    return json.dumps({"hourly": {"time": times, "wind_direction_10m": [300] * 61, "wind_speed_10m": [1.0] * 61, "wind_gusts_10m": [2.5] * 61}})


def handle_fmi(route):
    WIND_CALLS.append(route.request.url)
    hdr = {"Access-Control-Allow-Origin": "*"}
    if FMI_MODE["mode"] == "down":
        route.abort()
    else:
        route.fulfill(status=200, headers=hdr, content_type="text/xml", body=fmi_xml())


MET_CALLS = []


def met_json(lat, lon):
    import datetime as dt, math
    now = dt.datetime.now(dt.timezone.utc)
    t0 = now.replace(second=0, microsecond=0) + dt.timedelta(minutes=5 - now.minute % 5)
    ts = []
    for k in range(24):
        clon = 24.96 + 0.008 * k                      # sadesolu liikkuu lännestä itään
        r = 3.0 * math.exp(-(((lon - clon) / 0.02) ** 2 + ((lat - 61.24) / 0.03) ** 2))
        d = {"precipitation_rate": round(r, 1)}
        if k == 0:
            d["air_temperature"] = 6.0
        ts.append({"time": (t0 + dt.timedelta(minutes=5 * k)).strftime("%Y-%m-%dT%H:%M:%SZ"), "data": {"instant": {"details": d}}})
    return json.dumps({"type": "Feature", "geometry": {"type": "Point", "coordinates": [lon, lat, 100]},
                       "properties": {"meta": {"updated_at": now.strftime("%Y-%m-%dT%H:%M:%SZ"), "radar_coverage": "ok"}, "timeseries": ts}})


def handle_met(route):
    from urllib.parse import urlparse, parse_qs
    q = parse_qs(urlparse(route.request.url).query)
    MET_CALLS.append((q["lat"][0], q["lon"][0]))
    route.fulfill(status=200, headers={"Access-Control-Allow-Origin": "*", "Cache-Control": "max-age=60"},
                  content_type="application/json", body=met_json(float(q["lat"][0]), float(q["lon"][0])))


def handle_om(route):
    WIND_CALLS.append(route.request.url)
    route.fulfill(status=200, headers={"Access-Control-Allow-Origin": "*"}, content_type="application/json", body=om_json())


def main():
    serve(partial(Quiet, directory=str(SITE)), 8000)
    serve(TileHandler, 8001)
    errors = []
    with sync_playwright() as p:
        browser = p.chromium.launch()
        ctx = browser.new_context(viewport={"width": 390, "height": 844}, device_scale_factor=2, is_mobile=True,
                                  has_touch=True, geolocation={"latitude": 61.2395, "longitude": 25.072},
                                  permissions=["geolocation"], locale="fi-FI")
        ctx.add_init_script("""
          if (!localStorage.getItem('mk_settings')) localStorage.setItem('mk_settings', JSON.stringify({
            apiKey: 'testikey', mmlBase: 'http://127.0.0.1:8001/avoin/wmts/1.0.0', maxZoom: 15 }));
        """)
        ctx.route("https://opendata.fmi.fi/**", handle_fmi)
        ctx.route("https://api.open-meteo.com/**", handle_om)
        ctx.route("https://api.met.no/**", handle_met)
        page = ctx.new_page()
        page.on("console", lambda m: errors.append(f"console.{m.type}: {m.text}") if m.type in ("error", "warning") else None)
        page.on("pageerror", lambda e: errors.append(f"pageerror: {e}"))
        page.on("dialog", lambda d: (errors.append(f"pageerror: XSS dialog {d.message}"), d.dismiss()))

        page.goto("http://127.0.0.1:8000/")
        page.wait_for_function("() => window.__mk && window.__mk.S.forest", timeout=15000)
        page.evaluate("navigator.serviceWorker.ready")
        page.wait_for_timeout(1500)
        page.screenshot(path=str(SHOTS / "01-kartta.png"))

        # Napautus vanhaan metsään
        pt = page.evaluate("""() => {
          const S = window.__mk.S, F = S.forest, map = window.__mk.map;
          const b = map.getBounds();
          for (let sy = Math.floor(F.h*0.2); sy < F.h*0.8; sy += 3) for (let sx = Math.floor(F.w*0.2); sx < F.w*0.8; sx += 3) {
            const c = F.code[sy*F.w+sx];
            if (c >= 82+20) {
              const mx = F.mx0 + (sx+0.5)*F.rx, my = F.my1 - (sy+0.5)*F.ry;
              const ll = MK.mercToLonLat(mx, my);
              const ll2 = L.latLng(ll[1], ll[0]);
              if (!b.contains(ll2)) continue;
              const p = map.latLngToContainerPoint(ll2);
              if (p.y < 140 || p.y > 560 || p.x < 30 || p.x > 300) continue;
              return {x: p.x, y: p.y, age: c-2};
            }
          }
          return null;
        }""")
        assert pt, "vanhaa metsää ei löytynyt näkymästä"
        page.mouse.click(pt["x"], pt["y"])
        page.wait_for_selector("#infoCard:not([hidden])")
        info = page.inner_text("#infoCard")
        print("INFO:", info.replace("\n", " | "))
        import re
        m = re.search(r"Ikä n\. (\d+) v", info)
        assert "Vanha metsä" in info and m and int(m.group(1)) >= 80, (info, pt)
        page.screenshot(path=str(SHOTS / "02-napautus.png"))
        page.click(".info-close")

        # Suojelualueen napautus
        sp = page.evaluate("""() => { const p = window.__mk.map.latLngToContainerPoint([61.249, 25.138]); return {x:p.x, y:p.y}; }""")
        page.mouse.click(sp["x"], sp["y"])
        page.wait_for_selector("#infoCard:not([hidden])")
        info2 = page.inner_text("#infoCard")
        print("INFO2:", info2.replace("\n", " | "))
        assert "Suojelualue" in info2 and "<img src=x" in info2, info2
        assert page.evaluate("document.querySelectorAll('#infoCard img, #infoCard script').length") == 0
        assert "<script>" in page.inner_text("#areaName")
        page.screenshot(path=str(SHOTS / "03-suojelualue.png"))
        page.click(".info-close")

        # Uudet hakkuut: latvusmallin aukko, vahvistettu ilmoitus ja pelkkä ilmoitus
        page.wait_for_function("() => window.__mk.S.cutsGJ && window.__mk.S.layers.cuts && window.__mk.map.hasLayer(window.__mk.S.layers.cuts)")
        assert page.evaluate("window.__mk.S.cutsGJ.features.length") == 3
        page.evaluate("window.__mk.map.setView([61.224, 25.072], 15, {animate: false})")
        page.wait_for_timeout(500)
        cp = page.evaluate("() => { const p = window.__mk.map.latLngToContainerPoint([61.224, 25.072]); return {x:p.x, y:p.y}; }")
        page.mouse.click(cp["x"], cp["y"])
        page.wait_for_selector("#infoCard:not([hidden])")
        cinfo = page.inner_text("#infoCard")
        print("HAKKUU:", cinfo.replace("\n", " | "))
        assert "Hakkuuaukko (latvusmalli 2025)" in cinfo and "Uusi hakkuuaukko" in cinfo, cinfo
        assert "Hakkuuilmoitus 6/2024: avohakkuu" in cinfo and "näkyy latvusmallissa 2025" in cinfo, cinfo
        assert "Metsätiedossa 2023" in cinfo, cinfo
        page.screenshot(path=str(SHOTS / "17-hakkuu.png"))
        page.click(".info-close")
        page.evaluate("window.__mk.map.setView([61.2245, 25.134], 15, {animate: false})")
        page.wait_for_timeout(400)
        dp = page.evaluate("() => { const p = window.__mk.map.latLngToContainerPoint([61.2245, 25.134]); return {x:p.x, y:p.y}; }")
        page.mouse.click(dp["x"], dp["y"])
        page.wait_for_selector("#infoCard:not([hidden])")
        dinfo = page.inner_text("#infoCard")
        print("ILMOITUS:", dinfo.replace("\n", " | "))
        assert "Hakkuuilmoitus 5/2026: siemenpuuhakkuu <b>x</b>" in dinfo and "toteutuminen ei varmaa" in dinfo, dinfo
        assert "Hakkuuaukko" not in dinfo.split("\n")[0], dinfo
        assert page.evaluate("document.querySelectorAll('#infoCard b').length") == 1   # vain oma otsikko, ei syötteen <b>
        page.screenshot(path=str(SHOTS / "18-ilmoitus.png"))
        page.click(".info-close")
        page.click(".legend-fab")
        page.wait_for_selector(".legend-close")
        assert "Uusi hakkuuaukko" in page.inner_text(".legend") and "Hakkuuilmoitus" in page.inner_text(".legend")
        page.click(".legend-close")
        page.wait_for_selector(".legend-fab")
        page.click("#layersBtn")
        page.click("text=Uudet hakkuut")
        assert not page.evaluate("window.__mk.map.hasLayer(window.__mk.S.layers.cuts)")
        page.click("text=Uudet hakkuut")
        assert page.evaluate("window.__mk.map.hasLayer(window.__mk.S.layers.cuts)")
        page.click("#sheetClose")
        page.evaluate("window.__mk.map.setView([61.2395, 25.072], 14, {animate: false})")

        # GPS
        page.click("#locateBtn")
        page.wait_for_selector(".me-dot")
        page.wait_for_timeout(800)
        gps = page.inner_text("#gpsChip")
        print("GPS:", gps)
        page.screenshot(path=str(SHOTS / "04-gps.png"))

        # Tuuli: ennuste Ilmatieteen laitokselta, viuhka GPS-pisteestä
        page.wait_for_function("() => window.__mk.S.wind && window.__mk.S.layers.wind", timeout=15000)
        fmi_url = [u for u in WIND_CALLS if "opendata.fmi.fi" in u][-1]
        print("FMI-HAKU:", fmi_url.split("latlon=")[1].split("&")[0], "lähde:", page.evaluate("window.__mk.S.wind.source"))
        assert "latlon=61.24,25.1" in fmi_url and "61.2395" not in fmi_url, fmi_url   # alueen keskipiste, ei GPS
        assert page.inner_text("#windSpd").strip() == "4 m/s", page.inner_text("#windSpd")
        page.wait_for_timeout(600)
        fan = page.evaluate("""() => {
          const lay = window.__mk.S.layers.wind, f = lay._fan, map = window.__mk.map, c = lay._canvas;
          const dpr = c.width / map.getSize().x, ctx = c.getContext('2d');
          const alphaAt = (b, d) => { const ll = MK.destPoint(f.lat, f.lon, b, d); const p = map.latLngToContainerPoint(ll);
            return ctx.getImageData(Math.round(p.x*dpr), Math.round(p.y*dpr), 1, 1).data[3]; };
          return { bearing: f.bearing, half: f.half, down25: alphaAt(f.bearing, f.len*0.25), down60: alphaAt(f.bearing, f.len*0.6),
                   up: alphaAt(f.bearing + 180, f.len*0.3), side: alphaAt(f.bearing + 90, f.len*0.3) };
        }""")
        print("VIUHKA:", fan)
        # lounaistuuli (225-227) -> haju koilliseen; liukuväri: lähellä vahvempi kuin kauempana; vastatuuleen ei mitään
        assert 40 <= fan["bearing"] <= 50 and fan["down25"] > fan["down60"] > 0 and fan["up"] == 0 and fan["side"] == 0, fan
        page.screenshot(path=str(SHOTS / "12-tuuliviuhka.png"))

        # Aurinko ja hajuolosuhteet
        page.wait_for_selector("#sunChip:not([hidden])")
        sun = page.inner_text("#sunChip")
        print("AURINKO:", sun)
        import re as _re
        assert _re.search(r"(Nousee|Laskee|Hämärä) \d{1,2}\.\d{2} · ", sun), sun
        page.click("#sunChip")
        stxt = page.inner_text("#sheetBody")
        assert "Auringonnousu" in stxt and "Auringonlasku" in stxt and "sijaintisi" in stxt, stxt
        page.click("#sheetClose")
        page.wait_for_selector("#scentChip:not([hidden])")
        print("HAJU:", page.inner_text("#scentChip"))
        assert page.inner_text("#scentChip").strip() == "Haju: hyvä"
        page.click("#scentChip")
        htxt = page.inner_text("#sheetBody")
        print("HAJUPANEELI:", htxt.split("\n")[0:3])
        assert "Hajuolosuhteet: hyvä" in htxt and "8 °C" in htxt and "heikko" in htxt, htxt   # iltapäivän kuiva ja lämmin jakso
        page.click("#sheetClose")

        # Kartan kääntö kahdella sormella (CDP-kosketustapahtumat)
        cdp = ctx.new_cdp_session(page)

        def twist(total_deg, steps=12, r=90):
            import math as _m
            cx, cy = 195, 420
            def pts(a):
                rad = _m.radians(a)
                return [{"x": cx + r * _m.cos(rad), "y": cy + r * _m.sin(rad), "id": 1},
                        {"x": cx - r * _m.cos(rad), "y": cy - r * _m.sin(rad), "id": 2}]
            cdp.send("Input.dispatchTouchEvent", {"type": "touchStart", "touchPoints": pts(0)})
            for i in range(1, steps + 1):
                cdp.send("Input.dispatchTouchEvent", {"type": "touchMove", "touchPoints": pts(total_deg * i / steps)})
                page.wait_for_timeout(16)
            cdp.send("Input.dispatchTouchEvent", {"type": "touchEnd", "touchPoints": []})
            page.wait_for_timeout(400)
            return page.evaluate("window.__mk.map.getBearing()")

        b_small = twist(8)
        print("KÄÄNTÖ 8°:", round(b_small, 1))
        assert abs(b_small) < 0.5, b_small          # kynnys estää vahingossa kääntymisen
        assert page.get_attribute("#compassBtn", "aria-label") == "Käännä kartta katsomasuuntaan"
        b_big = twist(50)
        print("KÄÄNTÖ 50°:", round(b_big, 1))
        assert 25 <= abs(b_big) <= 45, b_big
        assert page.get_attribute("#compassBtn", "aria-label") == "Käännä pohjoinen ylös"
        fan2 = page.evaluate("""() => {
          const lay = window.__mk.S.layers.wind, f = lay._fan, map = window.__mk.map, c = lay._canvas;
          const dpr = c.width / map.getSize().x, ctx = c.getContext('2d');
          const alphaAt = (b, d) => { const ll = MK.destPoint(f.lat, f.lon, b, d); const p = map.latLngToContainerPoint(ll);
            return ctx.getImageData(Math.round(p.x*dpr), Math.round(p.y*dpr), 1, 1).data[3]; };
          return { down25: alphaAt(f.bearing, f.len*0.25), up: alphaAt(f.bearing + 180, f.len*0.3) };
        }""")
        print("VIUHKA KÄÄNNETYSSÄ:", fan2)
        assert fan2["down25"] > 0 and fan2["up"] == 0, fan2
        # Napautus osuu oikeaan paikkaan käännetyllä kartalla
        tgt = page.evaluate("() => { const ll = window.__mk.map.containerPointToLatLng([150, 300]); return [ll.lat, ll.lng]; }")
        page.mouse.click(150, 300)
        page.wait_for_selector("#infoCard:not([hidden])")
        coord = page.inner_text("#infoCard .info-meta")
        print("NAPAUTUS KÄÄNNETYSSÄ:", coord.split("\n")[0], "odotettu", round(tgt[0], 5), round(tgt[1], 5))
        assert f"{tgt[0]:.5f}".replace(".", ",") in coord, (coord, tgt)
        page.screenshot(path=str(SHOTS / "19-kaannetty.png"))
        page.click(".info-close")
        page.click("#compassBtn")
        page.wait_for_timeout(300)
        assert abs(page.evaluate("window.__mk.map.getBearing()")) < 0.5
        # Kompassiseuranta: puhelimen suunta 270° (länteen) -> kartan kääntö 90°
        assert page.is_visible("#compassBtn")                   # kompassiseuranta päällä asetuksissa
        page.click("#compassBtn")
        for _ in range(6):
            page.evaluate("window.dispatchEvent(new DeviceOrientationEvent('deviceorientationabsolute', {alpha: 90, beta: 35, gamma: 0, absolute: true}))")
            page.wait_for_timeout(80)
        bc = page.evaluate("window.__mk.map.getBearing()")
        print("KOMPASSI 270°: kartan kääntö", round(bc, 1), "seuranta", page.evaluate("window.__mk.S.compass.on"))
        assert abs(bc - 90) < 2 and "follow" in page.get_attribute("#compassBtn", "class"), bc
        page.screenshot(path=str(SHOTS / "20-kompassi.png"))
        twist(40)                                                # käsin kääntö lopettaa seurannan
        assert not page.evaluate("window.__mk.S.compass.on")
        page.click("#compassBtn")
        page.wait_for_timeout(200)
        assert abs(page.evaluate("window.__mk.map.getBearing()")) < 0.5
        page.click("#windBtn")
        page.wait_for_selector(".wind-now")
        wtxt = page.inner_text("#sheetBody")
        print("TUULI:", wtxt.split("\n")[0:3])
        assert "lounaasta" in wtxt and "koilliseen" in wtxt and "Ilmatieteen laitos" in wtxt, wtxt
        page.screenshot(path=str(SHOTS / "13-tuulipaneeli.png"))
        page.click("text=Käytä omaa havaintoa")
        page.wait_for_selector("input[type=range][aria-label^='Tuulen']")
        page.evaluate("""() => { const r = document.querySelector("input[aria-label^='Tuulen']"); r.value = '90';
          r.dispatchEvent(new Event('input', {bubbles:true})); r.dispatchEvent(new Event('change', {bubbles:true})); }""")
        cw = page.evaluate("window.__mk.currentWind()")
        assert cw["manual"] and cw["dir"] == 90, cw
        assert "idästä" in page.inner_text("#sheetBody")
        page.screenshot(path=str(SHOTS / "14-oma-havainto.png"))
        page.click("text=Käytä omaa havaintoa")
        page.wait_for_function("() => !window.__mk.currentWind().manual")
        # Varalähde: FMI ei vastaa -> Open-Meteo
        FMI_MODE["mode"] = "down"
        n_err = len(errors)
        ok = page.evaluate("window.__mk.refreshWind(window.__mk.S.area, {force: true})")
        src = page.evaluate("window.__mk.S.wind.source")
        print("VARALÄHDE:", ok, src, page.inner_text("#windSpd"))
        assert ok and src == "open-meteo", (ok, src)
        assert any("api.open-meteo.com" in u and "latitude=61.24" in u for u in WIND_CALLS)
        # Tahallisen katkon odotetut virheilmoitukset pois
        errors[n_err:] = [e for e in errors[n_err:] if "Failed to load resource" not in e and "FMI ei käytettävissä" not in e]
        page.click("#sheetClose")
        FMI_MODE["mode"] = "ok"
        page.evaluate("window.__mk.refreshWind(window.__mk.S.area, {force: true})")
        page.wait_for_function("() => window.__mk.S.wind.source === 'fmi'")

        # Sade: MET Norwayn tutkaennuste sijainnin ympäriltä
        page.wait_for_function("() => window.__mk.S.rain && window.__mk.S.rain.gps && !window.__mk.S.rainLoading", timeout=30000)
        decs = max(len(v.split(".")[1]) if "." in v else 0 for c in MET_CALLS for v in c)
        rain = page.evaluate("""() => { const r = window.__mk.S.rain; return { n: r.grid.points.length, center: r.grid.center,
          steps: r.times.length, any: r.anyRain, overlay: !!window.__mk.S.layers.rain }; }""")
        print("SADE:", rain, "hakuja", len(MET_CALLS), "desimaaleja max", decs)
        assert rain["n"] == 25 and rain["steps"] == 24 and rain["any"] and rain["overlay"] and decs <= 4, rain
        assert rain["center"] == [61.24, 25.08], rain                     # pyöristetty ~1 km
        assert len(MET_CALLS) <= 50, len(MET_CALLS)
        here = page.inner_text("#rainHere")
        print("SADE KOHDALLA:", page.inner_text("#rainTime"), "|", here)
        assert "Kohdallasi sade alkaa" in here, here
        page.screenshot(path=str(SHOTS / "15-sade-nyt.png"))
        u0 = page.evaluate("window.__mk.S.layers.rain._url")
        page.evaluate("""() => { const s = document.getElementById('rainSlider'); s.value = '15'; s.dispatchEvent(new Event('input', {bubbles:true})); }""")
        u15 = page.evaluate("window.__mk.S.layers.rain._url")
        assert u0 != u15 and "+" in page.inner_text("#rainTime"), page.inner_text("#rainTime")
        print("SADE +75 MIN:", page.inner_text("#rainTime"))
        page.screenshot(path=str(SHOTS / "16-sade-75min.png"))
        page.click("#rainNow")
        # Sadepalkin painikkeet eivät jää oikean reunan painikkeiden alle
        covered = page.evaluate("""() => ['rainPlay', 'rainNow', 'rainHide', 'rainSlider'].filter(id => {
          const el = document.getElementById(id), b = el.getBoundingClientRect();
          const hit = document.elementFromPoint(b.left + b.width / 2, b.top + b.height / 2);
          return !(hit && (hit === el || el.contains(hit))); })""")
        fab_gap = page.evaluate("""() => document.getElementById('rainBar').getBoundingClientRect().top -
          document.querySelector('.fabs').getBoundingClientRect().bottom""")
        print("SADEPALKKI: peitossa", covered, "rako painikkeisiin", round(fab_gap), "px")
        assert not covered and fab_gap >= 4, (covered, fab_gap)
        # Piilotus: taso pois ja uusia hakuja ei tehdä
        n_calls = len(MET_CALLS)
        page.click("#rainHide")
        page.evaluate("window.__mk.refreshRain(true)")
        page.wait_for_timeout(500)
        assert page.evaluate("!window.__mk.S.layers.rain") and page.is_hidden("#rainBar") and len(MET_CALLS) == n_calls
        page.click("#layersBtn")
        page.click("text=Sade-ennuste 0–2 h")
        page.wait_for_function("() => window.__mk.S.layers.rain && !window.__mk.S.rainLoading", timeout=30000)
        page.click("#sheetClose")

        # Havainnot ja saalis: lomake aukeaa ylhäältä, vaikka edellinen paneeli olisi vieritetty alas
        page.click("#settingsBtn")
        page.evaluate("document.getElementById('sheetBody').scrollTop = 99999")
        page.click("#sheetClose")
        page.click("#obsBtn")
        page.wait_for_selector("text=Oma sijainti (±")
        form = page.evaluate("""() => { const b = document.getElementById('sheetBody');
          return { top: b.scrollTop, fits: b.scrollHeight <= b.clientHeight + 4, h: b.scrollHeight, ch: b.clientHeight }; }""")
        print("LOMAKE:", form)
        assert form["top"] == 0 and form["fits"], form
        page.screenshot(path=str(SHOTS / "25-lomake.png"))
        page.click("#sheetBody button:has-text('Teeri')")
        page.click("#sheetBody button:has-text('Saalis')")
        page.click("#sheetBody button:has-text('Koiras')")
        page.fill("input[aria-label='Lisätieto']", "Seisoi koivikossa <img src=x onerror=alert(5)>")
        page.click("#sheetBody button:has-text('Tallenna')")
        page.wait_for_function("() => window.__mk.obs().length === 1")
        ob = page.evaluate("window.__mk.obs()[0]")
        print("MERKINTÄ:", {k: ob[k] for k in ("laji", "tyyppi", "n", "sp", "note", "area")})
        assert ob["laji"] == "teeri" and ob["tyyppi"] == "saalis" and ob["sp"] == "koiras" and abs(ob["lat"] - 61.2395) < 0.001
        # Toinen merkintä kartalta valitusta kohdasta
        page.click("#obsBtn")
        page.click("text=Valitse kartalta")
        page.wait_for_selector("#sheet", state="hidden")
        page.mouse.click(120, 330)
        page.wait_for_selector("text=Kartalta valittu kohta")
        assert page.evaluate("document.getElementById('sheetBody').scrollTop") == 0
        page.click("#sheetBody button:has-text('Metso')")
        page.click("#sheetBody button:has-text('Seisonta')")
        page.click("#sheetBody button:has-text('Tallenna')")
        page.wait_for_function("() => window.__mk.obs().length === 2")
        assert page.evaluate("document.querySelectorAll('.obs-pin').length") >= 2
        page.click(".obs-pin.obs-saalis")
        page.wait_for_selector("#infoCard:not([hidden]) .obs-del")
        oinfo = page.inner_text("#infoCard")
        print("MERKINNÄN TIEDOT:", oinfo.replace("\n", " | "))
        assert "Teeri · Saalis" in oinfo and "<img src=x" in oinfo and "koiras" in oinfo
        assert page.evaluate("document.querySelectorAll('#infoCard img').length") == 0
        page.screenshot(path=str(SHOTS / "21-merkinta.png"))
        page.click(".info-close")
        page.click("#obsBtn")
        page.click("text=Kaikki merkinnät (2)")
        ltxt = page.inner_text("#sheetBody")
        print("SAALISYHTEENVETO:", [l for l in ltxt.split("\n") if l.startswith("Teeri")][:1])
        assert "Teeri 1 (1 koiras)" in ltxt and "Metso · Seisonta" in ltxt, ltxt
        page.screenshot(path=str(SHOTS / "22-saalis.png"))
        page.click("#sheetClose")

        # Elinympäristö: metso
        page.click("#layersBtn")
        page.click("#sheetBody .seg button:has-text('Metso')")
        page.wait_for_function("() => window.__mk.S.hab && window.__mk.map.hasLayer && document.querySelector('.leaflet-habitat-pane canvas')", timeout=10000)
        page.click("#sheetClose")
        hp = page.evaluate("""() => {
          const S = window.__mk.S, F = S.forest, map = window.__mk.map, b = map.getBounds();
          for (let sy = 5; sy < F.h - 5; sy += 2) for (let sx = 5; sx < F.w - 5; sx += 2) {
            const i = sy * F.w + sx;
            if (S.hab.metso[i] >= 200) {
              const ll = MK.mercToLonLat(F.mx0 + (sx + 0.5) * F.rx, F.my1 - (sy + 0.5) * F.ry);
              const p = map.latLngToContainerPoint([ll[1], ll[0]]);
              if (b.contains([ll[1], ll[0]]) && p.y > 160 && p.y < 520 && p.x > 90 && p.x < 300) return {x: p.x, y: p.y};
            }
          }
          return null; }""")
        assert hp, "metson elinympäristöä ei näkymässä"
        page.mouse.click(hp["x"], hp["y"])
        page.wait_for_selector("#infoCard:not([hidden])")
        hinfo = page.inner_text("#infoCard")
        print("ELINYMPÄRISTÖ:", hinfo.replace("\n", " | "))
        assert "Metson elinympäristö: hyvä" in hinfo, hinfo
        page.screenshot(path=str(SHOTS / "23-metso.png"))
        page.click(".info-close")
        page.click("#layersBtn")
        page.click("#sheetBody .seg button:has-text('Pois')")
        page.click("#sheetClose")

        # Asetuksissa toimintojen yhteenveto
        page.click("#settingsBtn")
        ftxt = page.inner_text("#sheetBody")
        assert "toiminnot" in ftxt.lower() and "Kanalintujen elinympäristö: metso, teeri ja pyy" in ftxt and "Koiran hajuolosuhteet" in ftxt, ftxt[:300]
        page.screenshot(path=str(SHOTS / "24-toiminnot.png"))
        page.click("#sheetClose")

        # Offline-tallennus
        page.click("#areaBtn")
        page.wait_for_selector(".area-card")
        page.screenshot(path=str(SHOTS / "05-alueet.png"))
        n_before = len(TILE_REQUESTS)
        page.click("text=Tallenna offline")
        page.wait_for_function("() => window.__mk.offline()['9999-testialue'] && !window.__mk.S.dl", timeout=60000)
        page.wait_for_timeout(500)
        rec = page.evaluate("window.__mk.offline()['9999-testialue']")
        print("TALLENNETTU:", json.dumps(rec), "tiilipyyntöjä", len(TILE_REQUESTS) - n_before)
        assert rec["failed"] == 0 and rec["tiles"] > 50, rec
        cached = page.evaluate("caches.open('mk-data-v1').then(c => c.keys()).then(ks => ks.map(k => k.url))")
        assert any("cuts.geojson" in u for u in cached) and any("habitat.png" in u for u in cached), cached
        page.screenshot(path=str(SHOTS / "06-tallennettu.png"))
        page.click("#sheetClose")

        # Ilman verkkoa: uudelleenlataus ja eri kohta kartalla
        ctx.set_offline(True)
        page.evaluate("window.__mk.map.setView([61.25, 25.13], 15)")
        page.reload()
        page.wait_for_function("() => window.__mk && window.__mk.S.forest", timeout=15000)
        page.evaluate("window.__mk.map.setView([61.229, 25.08], 15)")
        page.wait_for_timeout(2500)
        tiles = page.evaluate("""() => {
          const imgs = [...document.querySelectorAll('.leaflet-tile-pane img.leaflet-tile')];
          return {total: imgs.length, loaded: imgs.filter(i => i.classList.contains('leaflet-tile-loaded') && i.naturalWidth > 0).length};
        }""")
        print("OFFLINE TIILET:", tiles, "verkko:", page.evaluate("navigator.onLine"))
        assert tiles["loaded"] >= max(1, tiles["total"] - 2), tiles
        page.screenshot(path=str(SHOTS / "07-offline.png"))
        # Tuuliennuste toimii ilman verkkoa tallennetusta datasta
        page.wait_for_function("() => window.__mk.currentWind() !== null", timeout=5000)
        print("OFFLINE TUULI:", page.inner_text("#windSpd"), page.evaluate("window.__mk.currentWind().dir"))

        # Tasot ja asetukset
        page.click("#layersBtn")
        page.wait_for_timeout(300)
        page.screenshot(path=str(SHOTS / "08-tasot.png"))
        page.click("#sheetClose")
        page.click("#settingsBtn")
        page.wait_for_timeout(500)
        page.screenshot(path=str(SHOTS / "09-asetukset.png"))
        page.fill("#oldAge", "60")
        page.press("#oldAge", "Enter")
        page.dispatch_event("#oldAge", "change")
        page.click("#sheetClose")
        page.wait_for_timeout(800)
        assert page.query_selector(".legend-fab") is not None    # selite piilossa oletuksena
        page.click(".legend-fab")
        page.wait_for_selector(".legend-close")
        legend = page.inner_text(".legend")
        assert "≥ 60 v" in legend, legend
        page.screenshot(path=str(SHOTS / "10-raja60.png"))
        page.click(".legend-close")
        page.wait_for_selector(".legend-fab")
        # Taimikon vinoviivoitus lähikuvassa
        tp = page.evaluate("""() => {
          const F = window.__mk.S.forest; let best = null;
          for (let sy = 2; sy < F.h-2; sy++) for (let sx = 2; sx < F.w-2; sx++) {
            let n = 0;
            for (let dy=-2; dy<=2; dy++) for (let dx=-2; dx<=2; dx++) { const i=(sy+dy)*F.w+sx+dx; if (F.code[i]>=2 && F.ht[i]<35) n++; }
            if (n >= 20) { best = [sx, sy]; break; }
          }
          if (!best) return null;
          const ll = MK.mercToLonLat(F.mx0+(best[0]+0.5)*F.rx, F.my1-(best[1]+0.5)*F.ry);
          window.__mk.map.setView([ll[1], ll[0]], 16, {animate:false});
          return ll;
        }""")
        print("TAIMIKKO:", tp)
        page.wait_for_timeout(1200)
        page.screenshot(path=str(SHOTS / "11-taimikko.png"))
        ctx.set_offline(False)
        browser.close()

    print("\n".join(errors) if errors else "Ei konsolivirheitä")
    bad = [e for e in errors if "pageerror" in e or "console.error" in e]
    if bad:
        sys.exit(1)
    print("E2E OK")


if __name__ == "__main__":
    main()
