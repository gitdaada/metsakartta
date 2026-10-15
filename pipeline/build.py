#!/usr/bin/env python3
"""
Metsäkartan esikäsittely.

Lukee areas/-kansion aluerajaukset (GeoJSON) ja tuottaa jokaiselle alueelle
docs/data/<alue>/ -kansioon:

  forest.png         Puuston ikä ja pituus 16 m ruuduissa (Web Mercator).
                     Punainen kanava (R):  0 = ei tietoa / alueen ulkopuolella
                                           1 = puuton
                                           2-255 = ikä vuosina + 2 (enintään 253 v)
                     Vihreä kanava (G):    keskipituus 2 dm:n portain (G * 0.2 = metriä)
                     Sininen kanava (B):   ei käytössä (0)
  boundary.geojson   Lupa-alueen raja (WGS84)
  protected.geojson  Luonnonsuojelualueet alueella ja sen reunalla (WGS84)

sekä docs/data/areas.json -luettelon, jonka sovellus lukee.

Värit ja ikärajat päätetään vasta sovelluksessa, joten esimerkiksi vanhan metsän
rajan voi muuttaa puhelimen asetuksista ilman uutta ajoa.

Ajetaan GitHub Actionsissa (.github/workflows/build-maps.yml).
Paikallisesti:  python pipeline/build.py [--force] [--only ALUE]
"""
from __future__ import annotations

import argparse
import datetime as dt
import hashlib
import json
import math
import os
import re
import shutil
import sys
import time
import traceback
import zipfile
from pathlib import Path

import numpy as np

ROOT = Path(__file__).resolve().parent.parent
AREAS_DIR = ROOT / "areas"
OUT_DIR = ROOT / "docs" / "data"
CACHE_DIR = Path(os.environ.get("MK_CACHE_DIR", ROOT / ".cache"))
CONFIG_PATH = ROOT / "pipeline" / "config.json"

ENCODING_VERSION = 1          # nosta, jos forest.png:n koodaus muuttuu
EARTH_R = 6378137.0
USER_AGENT = "metsakartta-build/1.0 (+https://github.com)"

FOREST_ATTRIBUTION = "Metsätieto: Luonnonvarakeskus, MVMI {year} (CC BY 4.0)"
PROTECTED_ATTRIBUTION = "Suojelualueet: Syke / Metsähallitus (CC BY 4.0)"


# ---------------------------------------------------------------------------
# Puhtaat apufunktiot (testattavissa ilman paikkatietokirjastoja)
# ---------------------------------------------------------------------------

def classify(age: np.ndarray, height: np.ndarray, nodata_codes) -> tuple[np.ndarray, np.ndarray]:
    """Muuntaa MVMI:n iän (v) ja keskipituuden (dm) sovelluksen koodeiksi.

    Puuton = sekä ikä että pituus ovat 0. Jos jompikumpi on yli 0, ruudussa on
    puustoa (myös taimikot), ja se näytetään metsänä.
    """
    a = age.astype(np.int32)
    h = height.astype(np.int32)
    invalid = np.isin(a, nodata_codes) | np.isin(h, nodata_codes) | (a < 0) | (h < 0)
    treeless = ~invalid & (a <= 0) & (h <= 0)
    forest = ~invalid & ~treeless

    r = np.zeros(a.shape, dtype=np.uint8)
    g = np.zeros(a.shape, dtype=np.uint8)
    r[treeless] = 1
    r[forest] = (np.clip(a[forest], 0, 253) + 2).astype(np.uint8)
    g[forest] = np.clip(np.rint(h[forest] / 2.0), 0, 255).astype(np.uint8)
    return r, g


def merc_to_lonlat(x: float, y: float) -> tuple[float, float]:
    lon = math.degrees(x / EARTH_R)
    lat = math.degrees(2.0 * math.atan(math.exp(y / EARTH_R)) - math.pi / 2.0)
    return lon, lat


def crop_to_content(r: np.ndarray, g: np.ndarray, x0: float, y1: float, res: float):
    """Rajaa kuvan tyhjät reunat pois. x0/y1 = vasen yläkulma (Mercator), res = ruutukoko."""
    rows = np.where(r.any(axis=1))[0]
    cols = np.where(r.any(axis=0))[0]
    if rows.size == 0:
        return None
    r0, r1 = int(rows[0]), int(rows[-1]) + 1
    c0, c1 = int(cols[0]), int(cols[-1]) + 1
    r = r[r0:r1, c0:c1]
    g = g[r0:r1, c0:c1]
    nx0 = x0 + c0 * res
    ny1 = y1 - r0 * res
    return r, g, nx0, ny1


def write_forest_png(path: Path, r: np.ndarray, g: np.ndarray) -> None:
    """Kirjoittaa RGB-PNG:n ilman väriprofiileja (selain lukee arvot sellaisenaan)."""
    from PIL import Image
    rgb = np.dstack([r, g, np.zeros_like(r)])
    Image.fromarray(rgb, mode="RGB").save(path, format="PNG", optimize=True)


def forest_meta(r: np.ndarray, g: np.ndarray, x0: float, y1: float, res: float) -> dict:
    h, w = r.shape
    x1 = x0 + w * res
    y0 = y1 - h * res
    lon0, lat0 = merc_to_lonlat(x0, y0)
    lon1, lat1 = merc_to_lonlat(x1, y1)
    return {
        "width": int(w),
        "height": int(h),
        "res": res,
        "mercBounds": [round(x0, 3), round(y0, 3), round(x1, 3), round(y1, 3)],
        "bounds": [[round(lat0, 6), round(lon0, 6)], [round(lat1, 6), round(lon1, 6)]],
        # Tarkistussummat: sovellus vertaa näihin ja varoittaa, jos selain muuttaa arvoja.
        "checksum": {"sumR": int(r.astype(np.int64).sum()), "sumG": int(g.astype(np.int64).sum())},
    }


def slugify(name: str) -> str:
    s = name.lower()
    for a, b in (("ä", "a"), ("ö", "o"), ("å", "a")):
        s = s.replace(a, b)
    s = re.sub(r"[^a-z0-9]+", "-", s).strip("-")
    return s or "alue"


def name_from_stem(stem: str) -> str:
    parts = [p for p in re.split(r"[-_ ]+", stem) if p]
    return " ".join(p if p.isdigit() else p[:1].upper() + p[1:] for p in parts) or stem


def round_coords(obj, nd=6):
    if isinstance(obj, float):
        return round(obj, nd)
    if isinstance(obj, (list, tuple)):
        return [round_coords(o, nd) for o in obj]
    if isinstance(obj, dict):
        return {k: round_coords(v, nd) for k, v in obj.items()}
    return obj


def sha1_bytes(*parts: bytes) -> str:
    h = hashlib.sha1()
    for p in parts:
        h.update(p)
    return h.hexdigest()


def log(msg: str) -> None:
    print(msg, flush=True)


# ---------------------------------------------------------------------------
# Lataukset
# ---------------------------------------------------------------------------

def download(url: str, dest: Path, retries: int = 4) -> Path:
    import requests
    if dest.exists() and dest.stat().st_size > 0:
        return dest
    dest.parent.mkdir(parents=True, exist_ok=True)
    tmp = dest.with_suffix(dest.suffix + ".part")
    for attempt in range(1, retries + 1):
        try:
            log(f"  Ladataan {url}")
            with requests.get(url, stream=True, timeout=60, headers={"User-Agent": USER_AGENT}) as resp:
                resp.raise_for_status()
                total = 0
                with open(tmp, "wb") as fh:
                    for chunk in resp.iter_content(chunk_size=1 << 20):
                        fh.write(chunk)
                        total += len(chunk)
            tmp.replace(dest)
            log(f"  Valmis: {total / 1e6:.1f} Mt")
            return dest
        except Exception as exc:  # noqa: BLE001
            log(f"  Lataus epäonnistui ({attempt}/{retries}): {exc}")
            time.sleep(5 * attempt)
    raise RuntimeError(f"Lataus ei onnistunut: {url}")


class RasterSource:
    """Avaa MVMI-rasterin. Yrittää ensin lukea vain tarvittavan osan verkosta
    (HTTP range -pyynnöt), ja lataa koko tiedoston vain, jos se ei onnistu."""

    def __init__(self, cfg: dict, filename: str):
        self.cfg = cfg
        self.filename = filename
        self.src = None

    def open(self):
        import rasterio
        if self.src is not None:
            return self.src
        local = CACHE_DIR / "mvmi" / str(self.cfg["year"]) / self.filename
        if local.exists():
            self.src = rasterio.open(local)
            return self.src
        os.environ.setdefault("GDAL_DISABLE_READDIR_ON_OPEN", "EMPTY_DIR")
        os.environ.setdefault("CPL_VSIL_CURL_ALLOWED_EXTENSIONS", ".tif")
        os.environ.setdefault("GDAL_HTTP_MAX_RETRY", "5")
        os.environ.setdefault("GDAL_HTTP_RETRY_DELAY", "3")
        os.environ.setdefault("GDAL_HTTP_USERAGENT", USER_AGENT)
        if os.environ.get("MK_FULL_DOWNLOAD") != "1":
            for base in self.cfg["baseUrls"]:
                url = f"{base}/{self.filename}"
                try:
                    src = rasterio.open("/vsicurl/" + url)
                    bh, bw = src.block_shapes[0]
                    log(f"  {self.filename}: {src.width}x{src.height}, lohko {bw}x{bh}, {src.dtypes[0]}, {src.crs}")
                    if bh * bw * 2 > 64_000_000:
                        log("  Lohkot liian suuria osittaiseen lukuun, ladataan koko tiedosto.")
                        src.close()
                        break
                    self.src = src
                    return src
                except Exception as exc:  # noqa: BLE001
                    log(f"  Etäluku ei onnistunut ({url}): {exc}")
        last_exc = None
        for base in self.cfg["baseUrls"]:
            try:
                download(f"{base}/{self.filename}", local)
                self.src = rasterio.open(local)
                return self.src
            except Exception as exc:  # noqa: BLE001
                last_exc = exc
        raise RuntimeError(f"MVMI-tiedostoa {self.filename} ei saatu: {last_exc}")


def read_window(src, bounds, fill: int):
    """Lukee ikkunan (minx, miny, maxx, maxy) ETRS-TM35FIN-koordinaateissa ruudukkoon tasattuna."""
    from rasterio.windows import Window
    from affine import Affine
    t = src.transform
    if t.b != 0 or t.d != 0 or t.e >= 0:
        raise RuntimeError("Odottamaton rasterin suunta")
    minx, miny, maxx, maxy = bounds
    col0 = int(math.floor((minx - t.c) / t.a))
    col1 = int(math.ceil((maxx - t.c) / t.a))
    row0 = int(math.floor((t.f - maxy) / -t.e))
    row1 = int(math.ceil((t.f - miny) / -t.e))
    out = np.full((row1 - row0, col1 - col0), fill, dtype=np.int32)
    rr0, rr1 = max(row0, 0), min(row1, src.height)
    cc0, cc1 = max(col0, 0), min(col1, src.width)
    if rr1 > rr0 and cc1 > cc0:
        data = src.read(1, window=Window(cc0, rr0, cc1 - cc0, rr1 - rr0))
        out[rr0 - row0:rr1 - row0, cc0 - col0:cc1 - col0] = data
    transform = Affine(t.a, 0, t.c + col0 * t.a, 0, t.e, t.f + row0 * t.e)
    return out, transform


# ---------------------------------------------------------------------------
# Suojelualueet
# ---------------------------------------------------------------------------

NAME_COLS = ["Nimi", "NimiSuomi", "LsAlueNimi", "Nimi_fi", "Name", "NIMI"]
TYPE_COLS = ["TyyppiNimi", "Tyyppi", "LsAlueTyyp", "SuojTyyppi", "TyyppiNim", "Type", "TYYPPI"]


def clean_text(v) -> str:
    if v is None:
        return ""
    if isinstance(v, float) and math.isnan(v):
        return ""
    s = str(v).strip()
    return "" if s.lower() in ("none", "nan") else s


def pick_col(columns, candidates):
    low = {c.lower(): c for c in columns}
    for cand in candidates:
        if cand.lower() in low:
            return low[cand.lower()]
    return None


class ProtectedAreas:
    def __init__(self, cfg: dict):
        self.cfg = cfg
        self.files = None  # [(label, shp_path)]

    def _prepare(self):
        if self.files is not None:
            return
        self.files = []
        skip = [s.lower() for s in self.cfg.get("skipFilesContaining", [])]
        for src in self.cfg["sources"]:
            key = hashlib.sha1(src["url"].encode()).hexdigest()[:10]
            zpath = download(src["url"], CACHE_DIR / "protected" / f"{key}.zip")
            xdir = CACHE_DIR / "protected" / key
            if not xdir.exists():
                with zipfile.ZipFile(zpath) as zf:
                    zf.extractall(xdir)
            for shp in sorted(xdir.rglob("*.shp")):
                if any(s in shp.name.lower() for s in skip):
                    log(f"  Ohitetaan {shp.name}")
                    continue
                self.files.append((src["label"], shp))
                log(f"  Suojelualueaineisto: {shp.relative_to(CACHE_DIR)}")

    def for_area(self, area_3067):
        """Palauttaa GeoJSON-FeatureCollectionin (WGS84) alueelle ja sen reunalle."""
        import geopandas as gpd
        import pyogrio
        from pyproj import Transformer
        self._prepare()
        clip_geom = area_3067.buffer(self.cfg.get("bufferM", 500))
        skip_types = [s.lower() for s in self.cfg.get("skipTypesContaining", [])]
        feats = []
        for label, shp in self.files:
            info = pyogrio.read_info(shp)
            crs = info.get("crs") or "EPSG:3067"
            minx, miny, maxx, maxy = clip_geom.bounds
            if "3067" not in str(crs):
                tr = Transformer.from_crs("EPSG:3067", crs, always_xy=True)
                minx, miny, maxx, maxy = tr.transform_bounds(minx, miny, maxx, maxy)
            gdf = gpd.read_file(shp, bbox=(minx, miny, maxx, maxy))
            if gdf.empty:
                continue
            if gdf.crs is None:
                gdf = gdf.set_crs(3067)
            gdf = gdf.to_crs(3067)
            name_col = pick_col(gdf.columns, NAME_COLS)
            type_col = pick_col(gdf.columns, TYPE_COLS)
            log(f"    {shp.name}: {len(gdf)} kohdetta rajauksen lähellä "
                f"(nimi={name_col}, tyyppi={type_col}, sarakkeet={list(gdf.columns)[:12]})")
            gdf = gdf[gdf.geometry.notna()]
            gdf["geometry"] = gdf.geometry.make_valid()
            gdf = gdf[gdf.intersects(clip_geom)]
            if gdf.empty:
                continue
            gdf["geometry"] = gdf.geometry.intersection(clip_geom)
            gdf = gdf[~gdf.geometry.is_empty]
            gdf["geometry"] = gdf.geometry.simplify(self.cfg.get("simplifyM", 1.0))
            gdf = gdf.to_crs(4326)
            for _, row in gdf.iterrows():
                tyyppi = clean_text(row[type_col]) if type_col else ""
                if any(s in tyyppi.lower() for s in skip_types):
                    continue
                nimi = clean_text(row[name_col]) if name_col else ""
                geom = row.geometry
                if geom.geom_type not in ("Polygon", "MultiPolygon"):
                    polys = [g for g in getattr(geom, "geoms", []) if g.geom_type in ("Polygon", "MultiPolygon")]
                    if not polys:
                        continue
                    from shapely.ops import unary_union
                    geom = unary_union(polys)
                feats.append({
                    "type": "Feature",
                    "properties": {"nimi": nimi, "tyyppi": tyyppi, "lahde": label},
                    "geometry": round_coords(geom.__geo_interface__),
                })
        return {"type": "FeatureCollection", "features": feats}


# ---------------------------------------------------------------------------
# Alueen rakentaminen
# ---------------------------------------------------------------------------

def load_area_polygon(path: Path):
    from shapely.geometry import shape
    from shapely.ops import unary_union
    from shapely.validation import make_valid
    gj = json.loads(path.read_text(encoding="utf-8"))
    if gj.get("type") == "FeatureCollection":
        feats = gj.get("features", [])
    elif gj.get("type") == "Feature":
        feats = [gj]
    else:
        feats = [{"type": "Feature", "properties": {}, "geometry": gj}]
    geoms, holes, props = [], [], {}
    for f in feats:
        g = f.get("geometry")
        if not g or g.get("type") not in ("Polygon", "MultiPolygon"):
            continue
        p = f.get("properties") or {}
        # Monikulmio, jolla on ominaisuus "poista": true, leikataan alueesta pois
        # (esim. yksityinen palsta lupa-alueen sisällä).
        if str(p.get("poista", "")).strip().lower() in ("true", "1", "kyllä", "kylla", "yes"):
            holes.append(make_valid(shape(g)))
            continue
        geoms.append(make_valid(shape(g)))
        props = props or p
    if not geoms:
        raise ValueError("Tiedostossa ei ole aluetta (Polygon/MultiPolygon). Piirrä alue monikulmiona.")
    poly = unary_union(geoms)
    if holes:
        poly = poly.difference(unary_union(holes))
    if poly.is_empty:
        raise ValueError("Alue on tyhjä poistojen jälkeen.")
    return poly, props


def build_area(path: Path, area_id: str, cfg: dict, age_src: RasterSource, height_src: RasterSource,
               protected: ProtectedAreas) -> dict:
    import rasterio
    from rasterio.features import geometry_mask
    from rasterio.transform import from_origin
    from rasterio.warp import reproject, Resampling
    from pyproj import Transformer
    from shapely.geometry import mapping
    from shapely.ops import transform as shp_transform

    poly_wgs, props = load_area_polygon(path)
    name = (props.get("nimi") or props.get("name") or props.get("Nimi") or "").strip() or name_from_stem(path.stem)
    to3067 = Transformer.from_crs("EPSG:4326", "EPSG:3067", always_xy=True).transform
    poly = shp_transform(to3067, poly_wgs)
    area_ha = poly.area / 10_000
    log(f"  {name}: {area_ha:,.0f} ha".replace(",", " "))

    mv = cfg["mvmi"]
    nod = mv["noDataCodes"]
    pad = mv["pixelSizeM"] * 2
    minx, miny, maxx, maxy = poly.bounds
    bounds = (minx - pad, miny - pad, maxx + pad, maxy + pad)

    asrc = age_src.open()
    hsrc = height_src.open()
    age, t_a = read_window(asrc, bounds, fill=nod[-1])
    height, t_h = read_window(hsrc, bounds, fill=nod[-1])
    if t_a != t_h or age.shape != height.shape:
        raise RuntimeError("Iän ja pituuden rasterit eivät ole samassa ruudukossa")

    r, g = classify(age, height, nod)
    inside = geometry_mask([mapping(poly)], out_shape=r.shape, transform=t_a, invert=True, all_touched=False)
    r[~inside] = 0
    g[~inside] = 0
    valid = r > 0
    log(f"  Ruutuja alueella {int(inside.sum())}, joista metsätalousmaata {int(valid.sum())}")

    # Web Mercator -ruudukko, jonka ruutukoko vastaa maastossa ~16 m
    to3857 = Transformer.from_crs("EPSG:3067", "EPSG:3857", always_xy=True)
    sx0, sy0, sx1, sy1 = to3857.transform_bounds(*bounds, densify_pts=21)
    lat_c = merc_to_lonlat(0, (sy0 + sy1) / 2)[1]
    res = mv["pixelSizeM"] / math.cos(math.radians(lat_c))
    res = round(res, 3)
    x0 = math.floor(sx0 / res) * res
    y1 = math.ceil(sy1 / res) * res
    w = int(math.ceil((sx1 - x0) / res))
    h = int(math.ceil((y1 - sy0) / res))
    dst_t = from_origin(x0, y1, res, res)
    dst = np.zeros((2, h, w), dtype=np.uint8)
    reproject(
        source=np.stack([r, g]),
        destination=dst,
        src_transform=t_a,
        src_crs="EPSG:3067",
        dst_transform=dst_t,
        dst_crs="EPSG:3857",
        resampling=Resampling.nearest,
        src_nodata=0,
        dst_nodata=0,
    )
    cropped = crop_to_content(dst[0], dst[1], x0, y1, res)
    if cropped is None:
        raise RuntimeError("Alueelle ei löytynyt metsätietoa. Onko rajaus Suomen alueella?")
    rr, gg, cx0, cy1 = cropped

    out = OUT_DIR / area_id
    if out.exists():
        shutil.rmtree(out)
    out.mkdir(parents=True)
    write_forest_png(out / "forest.png", rr, gg)
    meta = forest_meta(rr, gg, cx0, cy1, res)

    boundary = {"type": "FeatureCollection", "features": [
        {"type": "Feature", "properties": {"nimi": name}, "geometry": round_coords(mapping(poly_wgs))}]}
    (out / "boundary.geojson").write_text(json.dumps(boundary, ensure_ascii=False, separators=(",", ":")), encoding="utf-8")

    try:
        prot = protected.for_area(poly)
    except Exception as exc:  # noqa: BLE001
        # Metsäkartta on käyttökelpoinen ilman suojelualueitakin; virhe näkyy lokissa.
        traceback.print_exc()
        log(f"::warning::Suojelualueita ei saatu alueelle {name}: {exc}")
        prot = {"type": "FeatureCollection", "features": []}
    (out / "protected.geojson").write_text(json.dumps(prot, ensure_ascii=False, separators=(",", ":")), encoding="utf-8")
    log(f"  Suojelualueita: {len(prot['features'])}")

    files = {k: (out / f).read_bytes() for k, f in
             (("forest", "forest.png"), ("boundary", "boundary.geojson"), ("protected", "protected.geojson"))}
    version = sha1_bytes(*files.values())[:12]
    size = sum(len(b) for b in files.values())
    lon_c, lat_c2 = poly_wgs.centroid.x, poly_wgs.centroid.y
    return {
        "id": area_id,
        "name": name,
        "areaHa": round(area_ha),
        "center": [round(lat_c2, 6), round(lon_c, 6)],
        "version": version,
        "bytes": size,
        "forest": dict(meta, file=f"data/{area_id}/forest.png?v={version}"),
        "boundary": f"data/{area_id}/boundary.geojson?v={version}",
        "protected": f"data/{area_id}/protected.geojson?v={version}",
        "protectedCount": len(prot["features"]),
        "built": dt.datetime.now(dt.timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
    }


# ---------------------------------------------------------------------------
# Pääohjelma
# ---------------------------------------------------------------------------

def main() -> int:
    ap = argparse.ArgumentParser(description="Rakentaa metsäkartat areas/-kansion rajauksista")
    ap.add_argument("--force", action="store_true", help="rakenna kaikki alueet uudelleen")
    ap.add_argument("--only", help="rakenna vain tämä alue (tiedostonimi ilman päätettä)")
    args = ap.parse_args()

    cfg = json.loads(CONFIG_PATH.read_text(encoding="utf-8"))
    cfg_bytes = CONFIG_PATH.read_bytes() + str(ENCODING_VERSION).encode()
    OUT_DIR.mkdir(parents=True, exist_ok=True)
    index_path = OUT_DIR / "areas.json"
    old = {}
    if index_path.exists():
        try:
            old = {a["id"]: a for a in json.loads(index_path.read_text(encoding="utf-8")).get("areas", [])}
        except Exception:  # noqa: BLE001
            old = {}

    sources = sorted(p for p in AREAS_DIR.glob("*.geojson") if not p.name.startswith(("_", ".")))
    sources += sorted(p for p in AREAS_DIR.glob("*.json") if not p.name.startswith(("_", ".")))
    if not sources:
        log("areas/-kansiossa ei ole aluerajauksia (.geojson).")

    age_src = RasterSource(cfg["mvmi"], cfg["mvmi"]["ageFile"])
    height_src = RasterSource(cfg["mvmi"], cfg["mvmi"]["heightFile"])
    protected = ProtectedAreas(cfg["protected"])

    result, failed, seen = [], [], set()
    for path in sources:
        area_id = slugify(path.stem)
        if area_id in seen:
            log(f"VAROITUS: tunnus {area_id} on jo käytössä, ohitetaan {path.name}")
            continue
        seen.add(area_id)
        src_hash = sha1_bytes(path.read_bytes(), cfg_bytes)[:12]
        prev = old.get(area_id)
        up_to_date = (prev and prev.get("srcHash") == src_hash and (OUT_DIR / area_id / "forest.png").exists())
        if (args.only and args.only not in (area_id, path.stem)) or (up_to_date and not args.force):
            if prev:
                result.append(prev)
                log(f"= {path.name}: ajan tasalla")
            continue
        log(f"> {path.name}")
        try:
            entry = build_area(path, area_id, cfg, age_src, height_src, protected)
            entry["srcHash"] = src_hash
            entry["source"] = f"areas/{path.name}"
            result.append(entry)
        except Exception as exc:  # noqa: BLE001
            traceback.print_exc()
            log(f"VIRHE {path.name}: {exc}")
            failed.append(path.name)
            if prev:
                result.append(prev)

    # Poista alueet, joiden lähdetiedosto on poistettu
    for d in OUT_DIR.iterdir():
        if d.is_dir() and d.name not in seen:
            log(f"- Poistetaan {d.name} (lähdetiedosto poistettu)")
            shutil.rmtree(d)

    result.sort(key=lambda a: a["name"].lower())
    index = {
        "generated": dt.datetime.now(dt.timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
        "encoding": ENCODING_VERSION,
        "mvmiYear": cfg["mvmi"]["year"],
        "attribution": [FOREST_ATTRIBUTION.format(year=cfg["mvmi"]["year"]), PROTECTED_ATTRIBUTION],
        "areas": result,
    }
    index_path.write_text(json.dumps(index, ensure_ascii=False, indent=1), encoding="utf-8")
    log(f"Valmis: {len(result)} aluetta, {len(failed)} epäonnistui.")
    if failed:
        log("Epäonnistuneet: " + ", ".join(failed))
        return 2
    return 0


if __name__ == "__main__":
    sys.exit(main())
