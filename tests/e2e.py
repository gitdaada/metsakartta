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
        page = ctx.new_page()
        page.on("console", lambda m: errors.append(f"console.{m.type}: {m.text}") if m.type in ("error", "warning") else None)
        page.on("pageerror", lambda e: errors.append(f"pageerror: {e}"))

        page.goto("http://127.0.0.1:8000/")
        page.wait_for_function("window.__mk && window.__mk.S.forest", timeout=15000)
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
        assert "Suojelualue" in info2, info2
        page.screenshot(path=str(SHOTS / "03-suojelualue.png"))
        page.click(".info-close")

        # GPS
        page.click("#locateBtn")
        page.wait_for_selector(".me-dot")
        page.wait_for_timeout(800)
        gps = page.inner_text("#gpsChip")
        print("GPS:", gps)
        page.screenshot(path=str(SHOTS / "04-gps.png"))

        # Offline-tallennus
        page.click("#areaBtn")
        page.wait_for_selector(".area-card")
        page.screenshot(path=str(SHOTS / "05-alueet.png"))
        n_before = len(TILE_REQUESTS)
        page.click("text=Tallenna offline")
        page.wait_for_function("window.__mk.offline()['9999-testialue'] && !window.__mk.S.dl", timeout=60000)
        page.wait_for_timeout(500)
        rec = page.evaluate("window.__mk.offline()['9999-testialue']")
        print("TALLENNETTU:", json.dumps(rec), "tiilipyyntöjä", len(TILE_REQUESTS) - n_before)
        assert rec["failed"] == 0 and rec["tiles"] > 50, rec
        page.screenshot(path=str(SHOTS / "06-tallennettu.png"))
        page.click("#sheetClose")

        # Ilman verkkoa: uudelleenlataus ja eri kohta kartalla
        ctx.set_offline(True)
        page.evaluate("window.__mk.map.setView([61.25, 25.13], 15)")
        page.reload()
        page.wait_for_function("window.__mk && window.__mk.S.forest", timeout=15000)
        page.evaluate("window.__mk.map.setView([61.229, 25.08], 15)")
        page.wait_for_timeout(2500)
        tiles = page.evaluate("""() => {
          const imgs = [...document.querySelectorAll('.leaflet-tile-pane img.leaflet-tile')];
          return {total: imgs.length, loaded: imgs.filter(i => i.classList.contains('leaflet-tile-loaded') && i.naturalWidth > 0).length};
        }""")
        print("OFFLINE TIILET:", tiles, "verkko:", page.evaluate("navigator.onLine"))
        assert tiles["loaded"] >= max(1, tiles["total"] - 2), tiles
        page.screenshot(path=str(SHOTS / "07-offline.png"))

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
        legend = page.inner_text(".legend")
        assert "≥ 60 v" in legend, legend
        page.screenshot(path=str(SHOTS / "10-raja60.png"))
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
