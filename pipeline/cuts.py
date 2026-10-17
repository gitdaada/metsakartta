"""
Metsätiedon (MVMI) jälkeen tehdyt hakkuut.

Kaksi lähdettä, molemmat Suomen metsäkeskuksen avointa dataa (CC BY 4.0):

  1. Latvusmalli (CHM, 1 m): mitattu puuston korkeus. Jos MVMI näki ruudussa varttunutta
     metsää, mutta MVMI:tä uudempi latvusmalli näyttää sen matalana, ruutu on hakattu
     MVMI:n jälkeen. Tulos: yhtenäinen aukko, lahde = "latvusmalli".
  2. Metsänkäyttöilmoitukset: ilmoitetut uudistushakkuut, jotka ovat olleet voimassa
     MVMI:n jälkeen ja joiden kohdalla MVMI näki vielä metsää. Tulos: lahde = "ilmoitus".
     Ilmoitus ei tarkoita, että hakkuu on tehty; vahv = True, jos latvusmalli näyttää alueen matalana.

Puhtaat apufunktiot ovat testattavissa ilman paikkatietokirjastoja (tests/test_cuts.py).
"""
from __future__ import annotations

import datetime as dt
import math
import os
import re
import traceback

import numpy as np

# Metsäkeskuksen koodisto 1014 (hakkuutapa)
PRACTICE_NAMES = {
    1: "Ylispuiden poisto", 2: "Ensiharvennus", 3: "Harvennushakkuu", 4: "Kaistalehakkuu", 5: "Avohakkuu",
    6: "Verhopuuhakkuu", 7: "Suojuspuuhakkuu", 8: "Siemenpuuhakkuu", 9: "Erityishakkuu (maankäytön muutos)",
    11: "Erityishakkuu", 12: "Poimintaluonteinen kasvatushakkuu", 13: "Kasvatushakkuu", 14: "Muu hakkuu",
    17: "Pienaukkohakkuu", 19: "Uudistamishakkuu", 20: "Myrskytuhoalue, kasvatushakkuu", 21: "Myrskytuhoalue",
}
# Koodisto 1013 (hakkuun tarkoitus)
PURPOSE_NAMES = {1: "Kasvatushakkuu", 2: "Kasvatushakkuu, eri-ikäinen", 3: "Uudistushakkuu", 4: "Erityishakkuu",
                 5: "Maankäytön muutos", 6: "Metsätuhoalue"}
# Hakkuutavat, joissa metsää jää pystyyn (harvennukset, suojus- ja verhopuuhakkuu): ei näytetä.
LEAVES_TREES = {2, 3, 6, 7, 12, 13, 20}


# ---------------------------------------------------------------------------
# Puhtaat apufunktiot
# ---------------------------------------------------------------------------

def parse_date(v) -> str:
    """'2025-06-24T15:51:48+03:00' -> '2025-06-24'. Palauttaa '' jos ei tunnistettavissa."""
    m = re.match(r"(\d{4})-(\d{2})-(\d{2})", str(v or ""))
    return f"{m.group(1)}-{m.group(2)}-{m.group(3)}" if m else ""


def add_years(date: str, years: int) -> str:
    y, m, d = (int(x) for x in date.split("-"))
    try:
        return dt.date(y + years, m, d).isoformat()
    except ValueError:  # 29.2.
        return dt.date(y + years, m, 28).isoformat()


def _int(v):
    try:
        return int(v) if v is not None and str(v).strip() != "" else None
    except (TypeError, ValueError):
        return None


def declaration_kind(props: dict, practices, purposes) -> str | None:
    """Hakkuutavan nimi, jos ilmoitettu hakkuu avaa metsän (avohakkuu, siemenpuuhakkuu, tuhoalueen
    raivaus tms.), muuten None. Harvennukset ja hakkuut, joissa metsää jää pystyyn, ohitetaan."""
    pr = _int(props.get("CUTTINGREALIZATIONPRACTICE"))
    pu = _int(props.get("CUTTINGPURPOSE"))
    if pr in practices:
        return PRACTICE_NAMES.get(pr, "Uudistushakkuu")
    if pr in LEAVES_TREES:
        return None
    if pu in purposes:
        return PRACTICE_NAMES.get(pr) or PURPOSE_NAMES.get(pu, "Uudistushakkuu")
    return None


def declaration_relevant(props: dict, cfg: dict, since: str):
    """Onko ilmoitettu hakkuu voinut tapahtua MVMI:n jälkeen?
    Palauttaa (kelpaa, saapumispäivä 'YYYY-MM-DD', hakkuutapa)."""
    kind = declaration_kind(props, set(cfg["practices"]), set(cfg["purposes"]))
    if not kind:
        return False, "", None
    if str(props.get("DECLARATIONSTATE") or "") in {str(s) for s in cfg.get("skipStates", [])}:
        return False, "", kind
    d = parse_date(props.get("DECLARATIONARRIVALDATE") or props.get("STANDARRIVALDATE"))
    if not d:
        return False, "", kind
    # Ilmoitus on voimassa kolme vuotta: sen on täytynyt olla voimassa MVMI:n jälkeen.
    if add_years(d, int(cfg.get("validYears", 3))) < since:
        return False, d, kind
    return True, d, kind


def tm35_sheet_bounds(name: str):
    """ETRS-TM35FIN-karttalehden rajat (minx, miny, maxx, maxy).
    Esim. 'P4' (1:200 000, 192 x 96 km), 'P44', 'P444', 'P4442' (1:25 000, 24 x 12 km),
    'P4442B' (1:10 000, 6 x 6 km; A-H sarakkeittain alhaalta ylös: A,B | C,D | E,F | G,H)."""
    rows = "KLMNPQRSTUVWX"
    m = re.fullmatch(r"([K-X])(\d)(\d?)(\d?)(\d?)([A-H]?)", name.upper())
    if not m or m.group(1) not in rows or (m.group(6) and not m.group(5)):
        raise ValueError(f"Tuntematon karttalehti {name}")
    row = rows.index(m.group(1))
    col = int(m.group(2))
    minx = -76000.0 + (col - 2) * 192000
    miny = 6570000.0 + row * 96000
    w, h = 192000.0, 96000.0
    for digit in (m.group(3), m.group(4), m.group(5)):
        if not digit:
            break
        q = int(digit)  # 1 = vasen ala, 2 = vasen ylä, 3 = oikea ala, 4 = oikea ylä
        if q < 1 or q > 4:
            raise ValueError(f"Tuntematon karttalehti {name}")
        w, h = w / 2, h / 2
        if q in (3, 4):
            minx += w
        if q in (2, 4):
            miny += h
    if m.group(6):
        k = "ABCDEFGH".index(m.group(6))
        w, h = w / 4, h / 2
        minx += (k // 2) * w
        miny += (k % 2) * h
    return (minx, miny, minx + w, miny + h)


def sheets_10k(bounds):
    """1:10 000 -karttalehdet (6 x 6 km), jotka leikkaavat rajat (minx, miny, maxx, maxy)."""
    minx, miny, maxx, maxy = bounds

    def hit(b):
        return b[2] > minx and b[0] < maxx and b[3] > miny and b[1] < maxy

    out = []
    for r in "KLMNPQRSTUVWX":
        for c in range(2, 7):
            names = [f"{r}{c}"]
            for _ in range(3):
                names = [n + str(q) for n in names if hit(tm35_sheet_bounds(n)) for q in (1, 2, 3, 4)]
            names = [n for n in names if hit(tm35_sheet_bounds(n))]
            out += [n + L for n in names for L in "ABCDEFGH" if hit(tm35_sheet_bounds(n + L))]
    return sorted(out)


def block_percentile(a: np.ndarray, k: int, q: float, min_valid: float = 0.6) -> np.ndarray:
    """Jakaa (H*k, W*k)-taulukon k x k -lohkoihin ja palauttaa lohkojen q-prosenttipisteen.
    NaN = ei tietoa; jos lohkossa on alle min_valid osuus tietoa, tulos on NaN."""
    H, W = a.shape[0] // k, a.shape[1] // k
    b = a[: H * k, : W * k].reshape(H, k, W, k).transpose(0, 2, 1, 3).reshape(H, W, k * k)
    ok = (~np.isnan(b)).mean(axis=2) >= min_valid
    out = np.full((H, W), np.nan, dtype=np.float32)
    if ok.any():
        import warnings
        with warnings.catch_warnings():
            warnings.simplefilter("ignore", category=RuntimeWarning)
            out[ok] = np.nanpercentile(b[ok], q, axis=1)
    return out


def new_cut_mask(mvmi_height_m: np.ndarray, valid: np.ndarray, chm_p90: np.ndarray, cfg: dict) -> np.ndarray:
    """Ruudut, joissa MVMI näki varttunutta metsää mutta latvusmalli on matala."""
    with np.errstate(invalid="ignore"):
        return valid & (mvmi_height_m >= float(cfg.get("minMvmiM", 8))) & (chm_p90 < float(cfg.get("lowM", 3)))


def round_ha(area_m2: float) -> float:
    return round(area_m2 / 10_000, 1)


# ---------------------------------------------------------------------------
# Latvusmalli
# ---------------------------------------------------------------------------

def read_canopy(transform, shape, cfg: dict, min_year: int, log):
    """Lukee MVMI:tä uudemmat latvusmallit 16 m ruudukkoon.
    Palauttaa (p90 [m], vuosi) -taulukot; NaN / 0 = ei MVMI:tä uudempaa latvusmallia."""
    import rasterio
    from rasterio.windows import Window

    os.environ["CPL_VSIL_CURL_ALLOWED_EXTENSIONS"] = ".tif,.tiff,.jp2"
    os.environ.setdefault("GDAL_DISABLE_READDIR_ON_OPEN", "EMPTY_DIR")
    H, W = shape
    cell = transform.a
    x0, y1 = transform.c, transform.f
    bounds = (x0, y1 - H * cell, x0 + W * cell, y1)
    k = int(round(cell))  # latvusmalli on 1 m ruuduissa
    p90 = np.full(shape, np.nan, dtype=np.float32)
    years = np.zeros(shape, dtype=np.int16)
    this_year = dt.date.today().year
    used = []
    for sheet in sheets_10k(bounds):
        sb = tm35_sheet_bounds(sheet)
        # Lehden alueen solut MVMI-ruudukossa
        c0 = max(0, int(math.floor((sb[0] - x0) / cell)))
        c1 = min(W, int(math.ceil((sb[2] - x0) / cell)))
        r0 = max(0, int(math.floor((y1 - sb[3]) / cell)))
        r1 = min(H, int(math.ceil((y1 - sb[1]) / cell)))
        if c1 <= c0 or r1 <= r0:
            continue
        for year in range(this_year, min_year, -1):
            url = cfg["urlTemplate"].format(sheet=sheet, year=year)
            try:
                src = rasterio.open("/vsicurl/" + url)
            except Exception:  # noqa: BLE001  (tiedostoa ei ole tältä vuodelta)
                continue
            with src:
                t = src.transform
                # Ikkuna latvusmallissa: solujen r0..r1, c0..c1 alue 1 m pikseleinä
                wx0 = x0 + c0 * cell
                wy1 = y1 - r0 * cell
                col = int(round((wx0 - t.c) / t.a))
                row = int(round((t.f - wy1) / -t.e))
                win = Window(col, row, (c1 - c0) * k, (r1 - r0) * k)
                data = src.read(1, window=win, boundless=True, fill_value=src.nodata if src.nodata is not None else -9999)
                data = data.astype(np.float32)
                if src.nodata is not None:
                    data[data == src.nodata] = np.nan
                data[data < -1] = np.nan
            block = block_percentile(data, k, 90, float(cfg.get("minValid", 0.6)))
            sub_p = p90[r0:r1, c0:c1]
            sub_y = years[r0:r1, c0:c1]
            fill = np.isnan(sub_p) & ~np.isnan(block)
            sub_p[fill] = block[fill]
            sub_y[fill] = year
            used.append(f"{sheet}/{year}")
            if not np.isnan(sub_p).any():
                break
    log(f"  Latvusmallit: {', '.join(used) if used else 'ei MVMI:tä uudempia'}")
    return p90, years


# ---------------------------------------------------------------------------
# Metsänkäyttöilmoitukset
# ---------------------------------------------------------------------------

def fetch_declarations(bounds, cfg: dict, log) -> list[dict]:
    import requests
    feats, start, page = [], 0, int(cfg.get("pageSize", 5000))
    while True:
        params = {
            "service": "WFS", "version": "2.0.0", "request": "GetFeature", "typeNames": cfg["typeName"],
            "bbox": "{},{},{},{},urn:ogc:def:crs:EPSG::3067".format(*bounds), "srsName": "urn:ogc:def:crs:EPSG::3067",
            "outputFormat": "application/json", "count": page, "startIndex": start,
        }
        r = requests.get(cfg["wfs"], params=params, timeout=180, headers={"User-Agent": "metsakartta-build/1.0"})
        r.raise_for_status()
        got = r.json().get("features", [])
        feats += got
        if len(got) < page:
            break
        start += page
    log(f"  Metsänkäyttöilmoituksia rajauksen lähellä: {len(feats)}")
    return feats


# ---------------------------------------------------------------------------
# Kokoaminen
# ---------------------------------------------------------------------------

def compute_cuts(poly, hgt_dm: np.ndarray, valid: np.ndarray, transform, cfg: dict, mvmi_year: int, log):
    """Palauttaa (GeoJSON FeatureCollection WGS84:ssä, yhteenveto)."""
    import shapely
    from pyproj import Transformer
    from rasterio.features import rasterize, shapes, sieve
    from shapely.geometry import mapping, shape
    from shapely.ops import unary_union

    since = f"{mvmi_year}-07-31"
    cell = transform.a
    min_cells = max(1, int(round(float(cfg.get("minAreaHa", 0.3)) * 10_000 / (cell * cell))))
    to_wgs = Transformer.from_crs("EPSG:3067", "EPSG:4326", always_xy=True).transform

    def wgs(geom):
        g = shapely.transform(geom, lambda c: np.column_stack(to_wgs(c[:, 0], c[:, 1])))
        return round_geom(mapping(g))

    hgt_m = hgt_dm.astype(np.float32) / 10.0
    features, info = [], {"latvusmalli": 0, "ilmoitus": 0, "chmYears": []}

    # 1) Latvusmalli
    low = np.zeros(hgt_dm.shape, dtype=bool)
    years = np.zeros(hgt_dm.shape, dtype=np.int16)
    try:
        p90, years = read_canopy(transform, hgt_dm.shape, cfg["chm"], mvmi_year, log)
        low = new_cut_mask(hgt_m, valid, p90, cfg["chm"])
        info["chmYears"] = sorted({int(y) for y in np.unique(years[valid]) if y > 0})
        clean = sieve(low.astype(np.uint8), size=min_cells, connectivity=8).astype(bool) & valid
        polys = [shape(g) for g, v in shapes(clean.astype(np.uint8), mask=clean, transform=transform, connectivity=8) if v == 1]
        smooth = float(cfg["chm"].get("smoothM", 6))
        for g in polys:
            g = g.buffer(smooth, join_style="round").buffer(-smooth, join_style="round").simplify(2.0)
            g = polygonal(g.intersection(poly))
            if g.is_empty or g.area < min_cells * cell * cell * 0.8:
                continue
            m = rasterize([(g, 1)], out_shape=hgt_dm.shape, transform=transform, fill=0, dtype="uint8").astype(bool)
            ys = years[m & (years > 0)]
            year = int(np.bincount(ys).argmax()) if ys.size else None
            features.append({"type": "Feature", "properties": {"lahde": "latvusmalli", "vuosi": year, "ha": round_ha(g.area)},
                             "geometry": wgs(g)})
        info["latvusmalli"] = len(features)
        log(f"  Latvusmallin mukaan uusia hakkuuaukkoja: {len(features)}, yht. {sum(f['properties']['ha'] for f in features):.1f} ha")
    except Exception as exc:  # noqa: BLE001
        traceback.print_exc()
        log(f"::warning::Latvusmallia ei saatu: {exc}")
        info["chmError"] = str(exc)[:200]

    # 2) Metsänkäyttöilmoitukset
    dcfg = cfg["declarations"]
    try:
        b = poly.bounds
        raw = fetch_declarations((b[0] - 200, b[1] - 200, b[2] + 200, b[3] + 200), dcfg, log)
        cand = []
        for f in raw:
            ok, d, kind = declaration_relevant(f.get("properties") or {}, dcfg, since)
            if not ok or not f.get("geometry"):
                continue
            g = shape(f["geometry"])
            if not g.is_valid:
                g = g.buffer(0)
            g = polygonal(g.intersection(poly))
            if g.is_empty or g.area < 500:
                continue
            m = rasterize([(g, 1)], out_shape=hgt_dm.shape, transform=transform, fill=0, dtype="uint8").astype(bool) & valid
            if m.sum() == 0:
                continue
            # MVMI näki vielä metsää -> hakkuu voi olla MVMI:n jälkeen
            if (hgt_m[m] >= float(dcfg.get("minForestM", 5))).mean() < float(dcfg.get("minForestFrac", 0.5)):
                continue
            conf = float(low[m].mean()) if low.any() else 0.0
            ys = years[m & (years > 0)]
            chm_year = int(np.bincount(ys).argmax()) if ys.size else None
            vahv = chm_year is not None and conf >= float(dcfg.get("confirmFrac", 0.4))
            # Jos latvusmalli ei näytä hakkuuta, ilmoitus on kiinnostava vain, jos se oli voimassa latvusmallin jälkeen.
            if not vahv and chm_year is not None and add_years(d, int(dcfg.get("validYears", 3))) < f"{chm_year}-07-01":
                continue
            cand.append((d, kind, g, vahv, chm_year))
        # Sama alue voi olla ilmoitettu useasti: pidetään uusin.
        cand.sort(key=lambda c: c[0], reverse=True)
        kept, union = [], None
        for d, kind, g, vahv, chm_year in cand:
            if union is not None and g.intersection(union).area >= 0.8 * g.area:
                continue
            union = g if union is None else unary_union([union, g])
            kept.append((d, kind, g, vahv, chm_year))
        for d, kind, g, vahv, chm_year in sorted(kept, key=lambda c: c[0]):
            props = {"lahde": "ilmoitus", "pvm": d, "tapa": kind, "ha": round_ha(g.area), "vahv": bool(vahv)}
            if vahv:
                props["vahvVuosi"] = chm_year
            features.append({"type": "Feature", "properties": props, "geometry": wgs(g.simplify(2.0))})
        info["ilmoitus"] = len(kept)
        log(f"  Hakkuuilmoituksia MVMI:n jälkeen: {len(kept)}, joista latvusmallin vahvistamia {sum(1 for k in kept if k[3])}")
    except Exception as exc:  # noqa: BLE001
        traceback.print_exc()
        log(f"::warning::Metsänkäyttöilmoituksia ei saatu: {exc}")
        info["declError"] = str(exc)[:200]

    return {"type": "FeatureCollection", "features": features}, info


def polygonal(g):
    """Palauttaa geometrian monikulmio-osat (leikkaus voi tuottaa myös viivoja ja pisteitä)."""
    from shapely.geometry import MultiPolygon
    if g.is_empty:
        return g
    if g.geom_type in ("Polygon", "MultiPolygon"):
        return g
    parts = []
    for p in getattr(g, "geoms", []):
        if p.geom_type == "Polygon":
            parts.append(p)
        elif p.geom_type == "MultiPolygon":
            parts.extend(p.geoms)
    return MultiPolygon(parts) if parts else g.__class__()


def round_geom(obj, nd=6):
    if isinstance(obj, float):
        return round(obj, nd)
    if isinstance(obj, (list, tuple)):
        return [round_geom(o, nd) for o in obj]
    if isinstance(obj, dict):
        return {k: round_geom(v, nd) for k, v in obj.items()}
    return obj
