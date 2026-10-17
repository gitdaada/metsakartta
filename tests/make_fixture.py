"""Tekee testisivuston: docs/-kopio + synteettinen alue samalla koodauksella kuin build.py.

python3 tests/make_fixture.py <kohdekansio>
"""
import json
import math
import shutil
import sys
from pathlib import Path

import numpy as np
from matplotlib.path import Path as MPath
from scipy.ndimage import gaussian_filter

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT / "pipeline"))
import build  # noqa: E402

R = build.EARTH_R


def ll2m(lon, lat):
    return R * math.radians(lon), R * math.log(math.tan(math.pi / 4 + math.radians(lat) / 2))


def main(dest: Path):
    if dest.exists():
        shutil.rmtree(dest)
    shutil.copytree(ROOT / "docs", dest)
    idx_html = dest / "index.html"
    h = idx_html.read_text(encoding="utf-8")
    assert "https://avoin-karttakuva.maanmittauslaitos.fi" in h
    idx_html.write_text(h.replace("https://avoin-karttakuva.maanmittauslaitos.fi",
                                  "https://avoin-karttakuva.maanmittauslaitos.fi http://127.0.0.1:8001"), encoding="utf-8")
    data = dest / "data"
    if data.exists():
        shutil.rmtree(data)
    data.mkdir()

    # Testialue Evon suunnalla (ei virallinen raja)
    ring = [(25.040, 61.215), (25.120, 61.205), (25.165, 61.230), (25.150, 61.262),
            (25.085, 61.270), (25.045, 61.250), (25.040, 61.215)]
    hole = [(25.095, 61.235), (25.110, 61.235), (25.110, 61.243), (25.095, 61.243), (25.095, 61.235)]
    prot = [(25.120, 61.240), (25.150, 61.238), (25.155, 61.255), (25.125, 61.258), (25.120, 61.240)]

    lat_c = 61.238
    res = round(16 / math.cos(math.radians(lat_c)), 3)
    xs = [ll2m(lo, la)[0] for lo, la in ring]
    ys = [ll2m(lo, la)[1] for lo, la in ring]
    x0 = math.floor(min(xs) / res) * res
    y1 = math.ceil(max(ys) / res) * res
    w = int(math.ceil((max(xs) - x0) / res))
    h = int(math.ceil((y1 - min(ys)) / res))

    rng = np.random.default_rng(7)
    field = gaussian_filter(rng.normal(size=(h, w)), 9)
    field = (field - field.min()) / (field.max() - field.min())
    age = np.clip((field ** 1.3) * 170, 0, 250).astype(np.int32)
    # aukkoja
    cut = gaussian_filter(rng.normal(size=(h, w)), 6) > 0.07
    age[cut] = 0
    hgt = np.clip(age * 2.4 + rng.normal(0, 8, size=(h, w)), 0, 330).astype(np.int32)
    hgt[cut] = 0
    # osa aukoista taimikkoa
    seedl = cut & (gaussian_filter(rng.normal(size=(h, w)), 5) > 0.0)
    age[seedl] = rng.integers(3, 15, size=int(seedl.sum()))
    hgt[seedl] = rng.integers(0, 50, size=int(seedl.sum()))
    # järvi (ei metsätalousmaata)
    yy, xx = np.mgrid[0:h, 0:w]
    lake = ((yy - h * 0.35) / (h * 0.08)) ** 2 + ((xx - w * 0.3) / (w * 0.1)) ** 2 < 1
    age[lake] = 32767
    hgt[lake] = 32767

    r, g = build.classify(age, hgt, [32766, 32767])
    # maski: alue miinus reikä
    px = (np.arange(w) + 0.5) * res + x0
    py = y1 - (np.arange(h) + 0.5) * res
    PX, PY = np.meshgrid(px, py)
    pts = np.column_stack([PX.ravel(), PY.ravel()])
    outer = MPath([ll2m(*p) for p in ring]).contains_points(pts).reshape(h, w)
    inner = MPath([ll2m(*p) for p in hole]).contains_points(pts).reshape(h, w)
    inside = outer & ~inner
    r[~inside] = 0
    g[~inside] = 0
    rr, gg, cx0, cy1 = build.crop_to_content(r, g, x0, y1, res)

    aid = "9999-testialue"
    out = data / aid
    out.mkdir()
    build.write_forest_png(out / "forest.png", rr, gg)
    meta = build.forest_meta(rr, gg, cx0, cy1, res)
    boundary = {"type": "FeatureCollection", "features": [{"type": "Feature", "properties": {"nimi": "Testialue"},
                "geometry": {"type": "Polygon", "coordinates": [ring, hole]}}]}
    protected = {"type": "FeatureCollection", "features": [{"type": "Feature",
                 "properties": {"nimi": "Testin aarnialue <img src=x onerror=alert(1)>", "tyyppi": "Vanhojen metsien suojelualue", "lahde": "Valtion luonnonsuojelualue"},
                 "geometry": {"type": "Polygon", "coordinates": [prot]}}]}
    (out / "boundary.geojson").write_text(json.dumps(boundary))
    (out / "protected.geojson").write_text(json.dumps(protected))

    def box(lo0, la0, lo1, la1):
        return [[[lo0, la0], [lo1, la0], [lo1, la1], [lo0, la1], [lo0, la0]]]
    cuts = {"type": "FeatureCollection", "features": [
        {"type": "Feature", "properties": {"lahde": "latvusmalli", "vuosi": 2025, "ha": 6.3},
         "geometry": {"type": "Polygon", "coordinates": box(25.066, 61.2215, 25.078, 61.2265)}},
        {"type": "Feature", "properties": {"lahde": "ilmoitus", "pvm": "2024-06-18", "tapa": "Avohakkuu", "ha": 4.1,
                                           "vahv": True, "vahvVuosi": 2025},
         "geometry": {"type": "Polygon", "coordinates": box(25.067, 61.222, 25.077, 61.226)}},
        {"type": "Feature", "properties": {"lahde": "ilmoitus", "pvm": "2026-05-04", "tapa": "Siemenpuuhakkuu <b>x</b>",
                                           "ha": 2.2, "vahv": False},
         "geometry": {"type": "Polygon", "coordinates": box(25.128, 61.2225, 25.140, 61.2265)}},
    ]}
    (out / "cuts.geojson").write_text(json.dumps(cuts, ensure_ascii=False))
    files = [(out / f).read_bytes() for f in ("forest.png", "boundary.geojson", "protected.geojson", "cuts.geojson")]
    ver = build.sha1_bytes(*files)[:12]
    entry = {
        "id": aid, "name": "9999 Testialue<script>alert(2)</script>", "areaHa": 1450, "center": [61.238, 25.1], "version": ver,
        "bytes": sum(len(b) for b in files),
        "forest": dict(meta, file=f"data/{aid}/forest.png?v={ver}"),
        "boundary": f"data/{aid}/boundary.geojson?v={ver}",
        "protected": f"data/{aid}/protected.geojson?v={ver}",
        "cuts": f"data/{aid}/cuts.geojson?v={ver}", "cutsCount": 1, "declCount": 2, "chmYears": [2025],
        "protectedCount": 1, "built": "2026-10-15T07:00:00Z",
    }
    index = {"generated": "2026-10-15T07:00:00Z", "encoding": 1, "mvmiYear": 2023,
             "attribution": [build.FOREST_ATTRIBUTION.format(year=2023), build.PROTECTED_ATTRIBUTION, build.CUTS_ATTRIBUTION], "areas": [entry]}
    (data / "areas.json").write_text(json.dumps(index, ensure_ascii=False, indent=1))
    print(f"fixture: {w}x{h} -> {meta['width']}x{meta['height']}, versio {ver}")


if __name__ == "__main__":
    main(Path(sys.argv[1]))
