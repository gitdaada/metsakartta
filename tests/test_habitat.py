"""Elinympäristömallin testit synteettisellä datalla: python3 tests/test_habitat.py"""
import json
import sys
from pathlib import Path

import numpy as np

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT / "pipeline"))
import habitat  # noqa: E402

CFG = json.loads((ROOT / "pipeline" / "config.json").read_text(encoding="utf-8"))["habitat"]


def stand(h, age, pine, spruce, birch, cc, ccb, site, soil, n=12):
    """n x n -kokoinen yhtenäinen kuvio."""
    f = lambda v: np.full((n, n), v, dtype=np.float32)  # noqa: E731
    return {"height": f(h), "age": f(age), "pine": f(pine), "spruce": f(spruce), "birch": f(birch), "otherbl": f(0),
            "volume": f(pine + spruce + birch), "canopy": f(cc), "canopyBl": f(ccb),
            "site": np.full((n, n), site, dtype=np.int32), "soil": np.full((n, n), soil, dtype=np.int32)}


def score(L, cut=None):
    valid = np.ones(L["height"].shape, dtype=bool)
    out = habitat.habitat_scores(L, valid, cut, CFG)
    return {k: int(v[6, 6]) for k, v in out.items()}


def test_species():
    old_pine = score(stand(20, 95, 180, 40, 10, 55, 5, 4, 1))
    young_birch = score(stand(4, 12, 10, 5, 30, 60, 50, 3, 1))
    spruce_mix = score(stand(16, 60, 10, 160, 50, 80, 25, 2, 1))
    open_bog = score(stand(0, 0, 0, 0, 0, 0, 0, 0, 4))
    print("vanha männikkö", old_pine, "| nuori koivikko", young_birch, "| kuusisekametsä", spruce_mix, "| avosuo", open_bog)
    assert old_pine["metso"] >= 191 and old_pine["pyy"] < 128, old_pine
    assert young_birch["teeri"] >= 191 and young_birch["metso"] == 0, young_birch
    assert spruce_mix["pyy"] >= 191 and spruce_mix["metso"] < 191, spruce_mix
    assert 128 <= open_bog["teeri"] < 191 and open_bog["metso"] == 0 and open_bog["pyy"] == 0, open_bog
    # Hakattu vanha männikkö: ei metson eikä pyyn, mutta teeren avointa aluetta
    cut = np.ones((12, 12), dtype=bool)
    hakattu = score(stand(20, 95, 180, 40, 10, 55, 5, 4, 1), cut)
    assert hakattu["metso"] == 0 and hakattu["pyy"] == 0 and hakattu["teeri"] >= 128, hakattu
    print("species ok")


def test_edge():
    # Vasen puoli avohakkuuta, oikea varttunutta metsää: reunan metsäruudut ovat teeren reunavyöhykettä
    L = stand(18, 70, 100, 60, 30, 60, 10, 3, 1, n=20)
    L["height"][:, :8] = 0
    for k in ("pine", "spruce", "birch", "volume", "canopy", "canopyBl"):
        L[k][:, :8] = 0
    valid = np.ones((20, 20), dtype=bool)
    out = habitat.habitat_scores(L, valid, None, CFG)["teeri"]
    assert out[10, 9] >= 128 and out[10, 18] < 64, (out[10, 9], out[10, 18])
    print("edge ok")


def test_box_mean():
    a = np.zeros((5, 5), dtype=np.float32)
    a[2, 2] = 9
    m = habitat.box_mean(a, 1)
    assert abs(m[2, 2] - 1.0) < 1e-6 and abs(m[0, 0]) < 1e-6 and abs(m[1, 1] - 1.0) < 1e-6
    print("box ok")


if __name__ == "__main__":
    test_box_mean()
    test_species()
    test_edge()
    print("KAIKKI OK")
