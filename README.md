# Metsäkartta

Offline-toimiva karttasovellus metsästykseen: näyttää Metsähallituksen lupa-alueilla metsän iän värikoodattuna, luonnonsuojelualueet ja oman sijainnin.

| Väri | Merkitys |
| --- | --- |
| Punainen | Puuton (hakkuuaukko, avosuo) |
| Vihreä | Metsä alle 80 v, vihreämpi = nuorempi |
| Sininen | Vanha metsä, vähintään 80 v (raja muutettavissa sovelluksessa) |
| Vinoviivoitus | Taimikko (alle 7 m) |
| Keltainen katkoviiva | Luonnonsuojelualue |
| Musta viiva | Lupa-alueen raja |

Napauttamalla karttaa näet ruudun arvioidun iän ja pituuden, mahdollisen suojelualueen sekä etäisyyden omasta sijainnistasi.

## Käyttöönotto

1. **GitHub Pages:** repon *Settings → Pages → Build and deployment*: Source **Deploy from a branch**, Branch **main**, kansio **/docs** → *Save*. Sovellus on hetken päästä osoitteessa `https://<käyttäjänimi>.github.io/<repo>/`.
2. **Puhelin:** avaa osoite ja lisää sovellus kotinäytölle (iPhone: Safari → Jaa → *Lisää Koti-valikkoon*; Android: Chrome → ⋮ → *Asenna sovellus*). Kotinäytöltä avattuna tallennetut kartat säilyvät.
3. **MML:n API-avain:** hae ilmainen avain [Maanmittauslaitokselta](https://www.maanmittauslaitos.fi/rajapinnat/api-avaimen-ohje) ja syötä se sovelluksen asetuksiin. Avain tallentuu vain puhelimeen.
4. **Alueet:** lisää lupa-alueiden rajaukset `areas/`-kansioon, ks. [areas/README.md](areas/README.md).
5. **Offline:** avaa sovelluksessa *Lupa-alue* → *Tallenna offline* kotona Wi-Fissä ennen jahtia.

## Miten tämä toimii

- `areas/*.geojson`: lupa-alueiden rajat (piirretään käsin).
- `pipeline/build.py`: ajetaan GitHub Actionsissa aina, kun `areas/` muuttuu. Lukee Luken MVMI-aineistosta vain alueen kohdan (puuston ikä ja keskipituus, 16 m ruudut), leikkaa Syken luonnonsuojelualueet ja kirjoittaa tulokset `docs/data/`-kansioon.
- `docs/`: itse sovellus (GitHub Pages). Leaflet-kartta, joka piirtää metsäkerroksen laitteella tallennetusta datasta. Service worker pitää sovelluksen ja tallennetut kartat käytettävissä ilman verkkoa.
- Rakentamisen voi käynnistää käsin: *Actions → Rakenna metsäkartat → Run workflow* (valinta "Rakenna kaikki alueet uudelleen", jos Luke julkaisee uuden aineistovuoden ja `pipeline/config.json` päivitetään).

## Tietolähteet ja lisenssit

- Metsätieto: Luonnonvarakeskus, monilähteinen valtakunnan metsien inventointi (MVMI) 2023, CC BY 4.0.
- Luonnonsuojelualueet: Syke / Metsähallitus, CC BY 4.0.
- Pohjakartta: Maanmittauslaitos, CC BY 4.0 (tai OpenStreetMap ilman API-avainta, vain verkossa).
- Kirjasto: Leaflet 1.9.4 (BSD-2).

MVMI on satelliittikuviin ja koealoihin perustuva arvio. Yksittäisen ruudun arvo voi poiketa todellisuudesta, mutta laajempien kuvioiden yleiskuva on luotettavampi. Aineisto kuvaa tilannetta vuonna 2023, joten sen jälkeiset hakkuut eivät näy. Ne erottuvat vaihtamalla pohjaksi ilmakuvan.

## Tietosuoja

- Sijaintia ei lähetetä minnekään. Se käsitellään vain puhelimen selaimessa.
- Sovelluksessa ei ole kirjautumista, analytiikkaa eikä palvelinta.
- Repo on julkinen. Siitä näkyvät sovelluksen koodi ja lupa-alueiden rajat.

## Kehitys

```
python3 tests/test_encoding.py                    # koodauksen yksikkötestit
python3 tests/make_fixture.py /tmp/site           # synteettinen testisivusto
python3 tests/e2e.py /tmp/site /tmp/shots         # selaintesti (Playwright)
```
