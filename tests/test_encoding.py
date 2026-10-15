"""Testaa luokittelun ja PNG-koodauksen ilman paikkatietokirjastoja: python3 tests/test_encoding.py"""
import sys
import tempfile
from pathlib import Path

import numpy as np
from PIL import Image

sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "pipeline"))
import build  # noqa: E402

ND = [32766, 32767]


def test_classify():
    age = np.array([[0, 0, 5, 80, 120, 32767, 32766, 300, 3]], dtype=np.int16)
    hgt = np.array([[0, 12, 8, 220, 260, 32767, 100, 310, 0]], dtype=np.int16)
    r, g = build.classify(age, hgt, ND)
    # puuton vain kun molemmat 0
    assert r[0, 0] == 1 and g[0, 0] == 0
    # ikä 0 mutta pituutta -> metsää (taimikko), ei puuton
    assert r[0, 1] == 2 and g[0, 1] == 6
    assert r[0, 2] == 7 and g[0, 2] == 4
    assert r[0, 3] == 82 and g[0, 3] == 110
    assert r[0, 4] == 122
    # ei-metsätalousmaa ja puuttuva tieto
    assert r[0, 5] == 0 and r[0, 6] == 0
    # ikä katkaistaan 253 vuoteen
    assert r[0, 7] == 255
    # ikää mutta ei pituutta (pieni taimikko) -> metsää, pituus 0
    assert r[0, 8] == 5 and g[0, 8] == 0
    print("classify ok")


def test_png_roundtrip():
    rng = np.random.default_rng(1)
    r = rng.integers(0, 256, size=(37, 53), dtype=np.uint8)
    g = rng.integers(0, 256, size=(37, 53), dtype=np.uint8)
    with tempfile.TemporaryDirectory() as td:
        p = Path(td) / "f.png"
        build.write_forest_png(p, r, g)
        im = Image.open(p)
        assert im.mode == "RGB", im.mode
        assert "gamma" not in im.info and "icc_profile" not in im.info and "srgb" not in im.info, im.info
        a = np.asarray(im)
        assert (a[..., 0] == r).all() and (a[..., 1] == g).all() and (a[..., 2] == 0).all()
    meta = build.forest_meta(r, g, 2779000.0, 8660000.0, 33.2)
    assert meta["width"] == 53 and meta["height"] == 37
    assert meta["checksum"]["sumR"] == int(r.sum())
    (s, w), (n, e) = meta["bounds"]
    assert s < n and w < e and 60 < s < 62, meta["bounds"]
    print("png ok")


def test_crop():
    r = np.zeros((10, 10), np.uint8)
    g = np.zeros((10, 10), np.uint8)
    r[3:5, 6:9] = 9
    out = build.crop_to_content(r, g, 100.0, 1000.0, 10.0)
    rr, gg, x0, y1 = out
    assert rr.shape == (2, 3) and x0 == 160.0 and y1 == 970.0
    assert build.crop_to_content(np.zeros((3, 3), np.uint8), g[:3, :3], 0, 0, 1) is None
    print("crop ok")


def test_names():
    assert build.slugify("6671 Evo") == "6671-evo"
    assert build.slugify("Kitsi-Piilo, Ylä") == "kitsi-piilo-yla"
    assert build.name_from_stem("7638-elimo-kitsi-piilo") == "7638 Elimo Kitsi Piilo"
    print("names ok")


if __name__ == "__main__":
    test_classify()
    test_png_roundtrip()
    test_crop()
    test_names()
    print("KAIKKI OK")
