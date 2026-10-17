"""Hakkuutunnistuksen puhtaat apufunktiot: python3 tests/test_cuts.py"""
import math
import sys
from pathlib import Path

import numpy as np

sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "pipeline"))
import cuts  # noqa: E402

CFG = {"practices": [1, 4, 5, 8, 9, 17], "purposes": [5, 6], "skipStates": ["32", "33", "34"], "validYears": 3}


def test_dates():
    assert cuts.parse_date("2025-06-24T15:51:48+03:00") == "2025-06-24"
    assert cuts.parse_date(None) == ""
    assert cuts.add_years("2024-02-29", 3) == "2027-02-28"
    assert cuts.add_years("2022-11-03", 3) == "2025-11-03"
    print("dates ok")


def test_declarations():
    since = "2023-07-31"
    base = {"DECLARATIONSTATE": "40", "DECLARATIONARRIVALDATE": "2024-05-30T10:00:00+03:00"}
    ok, d, kind = cuts.declaration_relevant(dict(base, CUTTINGREALIZATIONPRACTICE=5, CUTTINGPURPOSE=3), CFG, since)
    assert ok and d == "2024-05-30" and kind == "Avohakkuu"
    # harvennus ei kelpaa, vaikka tarkoitus olisi tuhoalue
    assert not cuts.declaration_relevant(dict(base, CUTTINGREALIZATIONPRACTICE=3, CUTTINGPURPOSE=6), CFG, since)[0]
    # suojuspuu- ja verhopuuhakkuussa metsää jää pystyyn: ei kelpaa, vaikka tarkoitus on uudistushakkuu
    assert not cuts.declaration_relevant(dict(base, CUTTINGREALIZATIONPRACTICE=7, CUTTINGPURPOSE=3), CFG, since)[0]
    assert not cuts.declaration_relevant(dict(base, CUTTINGREALIZATIONPRACTICE=6, CUTTINGPURPOSE=3), CFG, since)[0]
    # siemenpuuhakkuu kelpaa
    assert cuts.declaration_relevant(dict(base, CUTTINGREALIZATIONPRACTICE=8, CUTTINGPURPOSE=3), CFG, since)[2] == "Siemenpuuhakkuu"
    # myrskytuhoalue (21) tuhoalueena kelpaa
    assert cuts.declaration_relevant(dict(base, CUTTINGREALIZATIONPRACTICE=21, CUTTINGPURPOSE=6), CFG, since)[0]
    # vanhentunut ennen MVMI:tä
    old = dict(base, CUTTINGREALIZATIONPRACTICE=5, DECLARATIONARRIVALDATE="2020-06-01T00:00:00")
    assert not cuts.declaration_relevant(old, CFG, since)[0]
    # voimassa MVMI:n jälkeen
    assert cuts.declaration_relevant(dict(old, DECLARATIONARRIVALDATE="2020-08-15"), CFG, since)[0]
    # hakkuu kielletty
    assert not cuts.declaration_relevant(dict(base, CUTTINGREALIZATIONPRACTICE=5, DECLARATIONSTATE="34"), CFG, since)[0]
    print("declarations ok")


def test_sheets():
    # Metsäkeskuksen latvusmallin tiedostojen todelliset rajat
    assert cuts.tm35_sheet_bounds("P4441B") == (452000, 7032000, 458000, 7038000)
    assert cuts.tm35_sheet_bounds("P4441D") == (458000, 7032000, 464000, 7038000)
    assert cuts.tm35_sheet_bounds("P4442A") == (452000, 7038000, 458000, 7044000)
    assert cuts.tm35_sheet_bounds("P4442D") == (458000, 7044000, 464000, 7050000)
    assert cuts.tm35_sheet_bounds("P4") == (308000, 6954000, 500000, 7050000)
    jahti = (453790, 7036983, 459609, 7045196)
    assert cuts.sheets_10k(jahti) == ["P4441B", "P4441D", "P4442A", "P4442B", "P4442C", "P4442D"], cuts.sheets_10k(jahti)
    try:
        cuts.tm35_sheet_bounds("O44")
        raise AssertionError("O ei ole käytössä")
    except ValueError:
        pass
    print("sheets ok")


def test_blocks():
    a = np.zeros((32, 32), dtype=np.float32)
    a[:16, :16] = 20
    a[16:, 16:] = np.nan
    a[16:, :16][:3, :3] = 15
    p = cuts.block_percentile(a, 16, 90, 0.6)
    assert p[0, 0] == 20 and p[0, 1] == 0 and math.isnan(p[1, 1]), p
    assert p[1, 0] == 0  # 9/256 korkeita ei nosta 90. prosenttipistettä
    h = np.array([[20.0, 20.0], [4.0, 20.0]])
    valid = np.array([[True, True], [True, False]])
    chm = np.array([[1.0, 15.0], [1.0, 1.0]], dtype=np.float32)
    m = cuts.new_cut_mask(h, valid, chm, {"minMvmiM": 8, "lowM": 3})
    assert m.tolist() == [[True, False], [False, False]]
    print("blocks ok")


if __name__ == "__main__":
    test_dates()
    test_declarations()
    test_sheets()
    test_blocks()
    print("KAIKKI OK")
