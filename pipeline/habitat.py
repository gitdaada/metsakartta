"""
Metsäkanalintujen elinympäristömalli MVMI-aineistosta (16 m ruudut).

Suuntaa antava asiantuntijamalli, ei tilastollisesti sovitettu. Pisteet 0-1 lajeittain:

  Metso: varttunut tai vanha havupuuvaltainen metsä, mieluiten mäntyä; kuivahkot ja tuoreet
         kankaat sekä rämeet; kohtalainen latvuspeitto (ei liian tiheä eikä harva).
  Teeri: taimikot ja nuoret, koivua sisältävät metsät, hakkuuaukot ja avosuot sekä varttuneen
         metsän reunat avoimen alueen vieressä.
  Pyy:   tiheä kuusivaltainen sekametsä, jossa on lehtipuuta; rehevät kankaat ja korvet;
         keski-ikäinen tai varttunut.

Tulos 0-255 (0,5 = sopiva, 0,75 = hyvä). Metsätiedon jälkeen hakatut kohdat (latvusmalli)
eivät ole metson eivätkä pyyn elinympäristöä, mutta ne ovat teeren avointa aluetta.
"""
from __future__ import annotations

import numpy as np


def ramp(x, a, b):
    """0 kun x <= a, 1 kun x >= b, lineaarinen välillä."""
    return np.clip((np.asarray(x, dtype=np.float32) - a) / (b - a), 0.0, 1.0)


def lookup(codes, table: dict, default: float) -> np.ndarray:
    out = np.full(codes.shape, default, dtype=np.float32)
    for k, v in table.items():
        out[codes == int(k)] = v
    return out


def box_mean(a: np.ndarray, r: int) -> np.ndarray:
    """(2r+1) x (2r+1) -liukuva keskiarvo kumulatiivisilla summilla (reunoilla pienempi ikkuna)."""
    a = np.asarray(a, dtype=np.float64)
    H, W = a.shape
    c = np.zeros((H + 1, W + 1))
    c[1:, 1:] = a.cumsum(0).cumsum(1)
    y0 = np.clip(np.arange(H) - r, 0, H)
    y1 = np.clip(np.arange(H) + r + 1, 0, H)
    x0 = np.clip(np.arange(W) - r, 0, W)
    x1 = np.clip(np.arange(W) + r + 1, 0, W)
    s = c[y1][:, x1] - c[y0][:, x1] - c[y1][:, x0] + c[y0][:, x0]
    n = (y1 - y0)[:, None] * (x1 - x0)[None, :]
    return (s / n).astype(np.float32)


def habitat_scores(L: dict, valid: np.ndarray, new_cut: np.ndarray | None, cfg: dict) -> dict:
    """L: 'height' (m), 'age' (v), 'pine', 'spruce', 'birch', 'otherbl', 'volume' (m3/ha), 'canopy', 'canopyBl' (%),
    'site' (kasvupaikka), 'soil' (päätyyppi). Palauttaa {'metso','teeri','pyy'}: uint8 0-255."""
    f = {k: np.nan_to_num(np.asarray(v, dtype=np.float32), nan=0.0) for k, v in L.items()}
    H, A, V = f["height"], f["age"], f["volume"]
    bl = f["birch"] + f["otherbl"]
    vol = np.maximum(V, f["pine"] + f["spruce"] + bl)
    has = vol >= 5
    with np.errstate(invalid="ignore", divide="ignore"):
        sp = np.where(has, f["pine"] / vol, 0)
        ss = np.where(has, f["spruce"] / vol, 0)
        sb = np.where(has, bl / vol, 0)
    CC, CCb = f["canopy"], f["canopyBl"]
    site = np.asarray(L["site"]).astype(np.int32)
    soil = np.asarray(L["soil"]).astype(np.int32)
    cut = new_cut if new_cut is not None else np.zeros(H.shape, dtype=bool)

    open_ = valid & ((H < 1.0) | cut | (soil == int(cfg.get("openBogCode", 4))))
    young = valid & ~cut & (H >= 1.0) & (H < 8)

    # Metso
    mh, ma, mc, mp = cfg.get("metsoHeight", [13, 19]), cfg.get("metsoAge", [50, 90]), cfg.get("metsoConifer", [0.6, 0.85]), cfg.get("metsoPine", [0.3, 0.7])
    pw = float(cfg.get("metsoPineWeight", 0.55))
    f_age = np.maximum(ramp(H, *mh), ramp(A, *ma)) * (H >= float(cfg.get("metsoMinHeight", 10)))
    f_con = ramp(sp + ss, *mc) * ((1 - pw) + pw * ramp(sp, *mp))
    f_site = lookup(site, cfg["metsoSite"], 0.4) * lookup(soil, cfg["metsoSoil"], 0.8)
    f_cc = ramp(CC, 15, 30) * (1 - 0.4 * ramp(CC, 75, 90))
    metso = f_age * f_con * f_site * f_cc

    # Teeri
    birch_bonus = 0.7 + 0.3 * ramp(sb, 0.1, 0.4)
    young_s = ramp(H, 0.8, 2.0) * (1 - ramp(H, 8, 12)) * birch_bonus
    open_s = np.where(open_, np.where(soil == int(cfg.get("openBogCode", 4)), 0.6, 0.55), 0.0)
    near_open = box_mean((open_ | young).astype(np.float32), int(cfg.get("edgeCells", 4)))
    edge_s = np.where(valid & (H >= 8), (0.6 + 0.25 * ramp(sb, 0.1, 0.4)) * ramp(near_open, 0.05, 0.25), 0.0)
    teeri = np.maximum.reduce([young_s, open_s, edge_s])

    # Pyy
    f_sp = ramp(ss, 0.25, 0.55)
    f_bl = 0.45 + 0.55 * np.maximum(ramp(sb, 0.05, 0.2), ramp(CCb, 5, 15))
    f_den = ramp(CC, 40, 65)
    f_ps = lookup(site, cfg["pyySite"], 0.2) * lookup(soil, cfg["pyySoil"], 0.5)
    f_h = ramp(H, 5, 9) * (1 - 0.5 * ramp(H, 22, 28))
    pyy = f_sp * f_bl * f_den * f_ps * f_h

    out = {}
    for name, sc in (("metso", metso), ("teeri", teeri), ("pyy", pyy)):
        sc = np.where(valid, sc, 0).astype(np.float32)
        if name in ("metso", "pyy"):
            sc[cut] = 0
        # Kevyt tasoitus: yksittäiset ruudut eivät ole elinympäristöä, laikut ovat.
        sc = np.where(valid, box_mean(sc, 1), 0)
        out[name] = np.clip(np.rint(sc * 255), 0, 255).astype(np.uint8)
    return out


def area_stats(h: dict, valid: np.ndarray, cell_m: float) -> dict:
    """Sopivan ja hyvän elinympäristön pinta-ala (ha) lajeittain."""
    ha = cell_m * cell_m / 10_000
    return {k: [round(float(((v >= 128) & (v < 191) & valid).sum()) * ha), round(float(((v >= 191) & valid).sum()) * ha)]
            for k, v in h.items()}
