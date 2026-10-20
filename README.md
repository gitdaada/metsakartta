# Metsäkartta

Offline-toimiva karttasovellus metsästykseen: näyttää Metsähallituksen lupa-alueilla metsän iän värikoodattuna, luonnonsuojelualueet ja oman sijainnin.

## Toiminnot

- Metsän ikä värikoodattuna (puuton, nuori, vanha) ja taimikot vinoviivoin
- Luonnonsuojelualueet ja lupa-alueen raja
- Uudet hakkuuaukot latvusmallista ja hakkuuilmoitukset
- Kanalintujen elinympäristö: metso, teeri ja pyy
- Oma sijainti ja kulkusuunta
- Tuulen suunta ja hajuviuhka sijainnistasi
- Sade-ennuste 0–2 h sijaintisi ympäriltä
- Koiran hajuolosuhteet sääennusteesta
- Auringon nousu ja lasku sekä aikaa niihin
- Havaintojen ja saaliin kirjaus sekä saalisyhteenveto
- Kartan kääntö kahdella sormella ja kompassiseuranta
- Pisteen tiedot napauttamalla: ikä, pituus, suojelu, hakkuu, elinympäristö
- Maastokartta, ilmakuva tai OpenStreetMap pohjakarttana
- Offline-käyttö tallennetuilla alueilla
- Näyttö päällä -tila

Sama lista on sovelluksen asetuksissa kohdassa *Toiminnot*. Lisätoiminnot (elinympäristö, aurinko, hajuolosuhteet, havainnot, kompassiseuranta) kytketään päälle ja pois *Karttatasot*-valikosta.

| Väri | Merkitys |
| --- | --- |
| Punainen | Puuton (hakkuuaukko, avosuo) |
| Vihreä | Metsä alle 80 v, vihreämpi = nuorempi |
| Sininen | Vanha metsä, vähintään 80 v (raja muutettavissa sovelluksessa) |
| Vinoviivoitus | Taimikko (alle 7 m) |
| Keltainen katkoviiva | Luonnonsuojelualue |
| Musta viiva | Lupa-alueen raja |
| Violetti viuhka | Tuulen mukana kulkeva hajusi (oma sijainti → myötätuuleen) |
| Syaani → keltainen → oranssi | Sade-ennuste: heikko → kohtalainen → voimakas sade |
| Punainen alue yhtenäisellä reunalla | Uusi hakkuuaukko: tehty metsätiedon (2023) jälkeen, näkyy latvusmallissa |
| Punainen katkoviiva | Hakkuuilmoitus (avohakkuu tms.), jonka toteutuminen ei ole varmaa |
| Oranssi alue | Valitun kanalintulajin elinympäristö: vahva = hyvä, haalea = sopiva |
| Pallo, jossa kirjain | Oma merkintä: sininen = havainto, keltainen = seisonta, punainen = saalis |

Napauttamalla karttaa näet ruudun arvioidun iän ja pituuden, mahdollisen suojelualueen sekä etäisyyden omasta sijainnistasi.

**Tuuli:** sovellus hakee alueelle tuulen tuntiennusteen (n. 60 h) ja tallentaa sen puhelimeen, joten tuuliviuhka toimii myös ilman verkkoa. Tuulipainikkeesta näet ennusteen ja voit asettaa suunnan itse oman havainnon mukaan (savu, lumi, heinä). Viuhka on sitä leveämpi, mitä heikompi tuuli, koska heikon tuulen suunta on epävarma.

**Uudet hakkuut:** metsätieto kuvaa vuoden 2023 tilannetta, joten sen jälkeen hakattu metsä näkyisi vielä metsänä. Sovellus merkitsee nämä kohdat kahdesta Metsäkeskuksen avoimesta lähteestä:
- *Latvusmalli* on mitattu puuston korkeus (1 m ruuduissa). Jos metsätiedossa kohdassa oli vähintään 8 m metsää, mutta uudempi latvusmalli näyttää sen alle 3 m korkeana, kohta merkitään uudeksi hakkuuaukoksi. Harvennus ei näy aukkona, koska puustoa jää pystyyn.
- *Metsänkäyttöilmoitukset* ovat metsänomistajan ilmoituksia aiotuista hakkuista. Mukana ovat vain metsän avaavat hakkuut, kuten avohakkuu, siemenpuuhakkuu, ylispuiden poisto, pienaukkohakkuu ja tuhoalueen raivaus. Harvennukset sekä suojus- ja verhopuuhakkuut jätetään pois. Ilmoitus on voimassa kolme vuotta, eikä sen toteutumista tarvitse ilmoittaa. Jos latvusmalli näyttää alueen jo matalana, napautus kertoo sen.

Tiedot päivittyvät viikoittain maanantaiaamuisin. Tason saa piiloon *Karttatasot*-valikosta.

**Kartan kääntö:** kierrä karttaa kahdella sormella. Kääntö alkaa vasta pienen kierron jälkeen, joten nipistyszoomaus ei käännä karttaa vahingossa. Kompassipainikkeesta pohjoinen palaa ylös. Kun kompassiseuranta on päällä, sama painike kääntää kartan puhelimen kompassin mukaan katsomasuuntaasi. Käsin kääntäminen lopettaa seurannan.

**Kanalintujen elinympäristö:** suuntaa antava malli metsätiedosta (puulajien tilavuudet, ikä, pituus, latvuspeitto, kasvupaikka ja päätyyppi) sekä uusista hakkuista. Metso: varttunut tai vanha havupuuvaltainen, mieluiten mäntyvaltainen metsä kuivahkoilla ja tuoreilla kankailla sekä rämeillä. Teeri: taimikot, nuoret koivikot, aukot, avosuot ja metsän reunat niiden vieressä. Pyy: tiheä kuusivaltainen sekametsä, jossa on lehtipuuta, rehevillä kankailla ja korvissa. Malli ei ole tilastollisesti sovitettu, vaan se kokoaa tunnetut elinympäristövaatimukset kartaksi (`pipeline/habitat.py`).

**Aurinko:** auringon nousu- ja laskuaika sekä aika niihin lasketaan puhelimessa sijaintisi (ilman GPS:ää lupa-alueen keskipisteen) mukaan, myös ilman verkkoa.

**Koiran hajuolosuhteet:** suuntaa antava arvio (hyvä, kohtalainen, heikko) lupa-alueen sääennusteen lämpötilasta, ilmankosteudesta, tuulesta ja sateesta. Viileä ja kostea sää sekä kohtalainen tuuli kantavat hajua yleensä parhaiten; helle, kuivuus, kova tuuli, tyyni ja pakkanen heikentävät. Paneelissa näkyy seuraavien 12 tunnin arvio.

**Havainnot ja saalis:** merkitse lintuhavainto, koiran seisonta tai saalis (laji, määrä, sukupuoli, lisätieto) omasta sijainnista tai kartalta valitusta kohdasta. Merkinnät näkyvät kartalla, ja listasta saat kuluvan kauden saalisyhteenvedon saalisilmoitusta varten sekä CSV-tiedoston.

**Sade:** sovellus näyttää sadetutkaan perustuvan ennusteen seuraavalle noin kahdelle tunnille 15 km:n alueelta sijaintisi ympäriltä (ilman GPS:ää kartan keskeltä). Aikaliukusäätimellä ja toistopainikkeella näet, miten sade liikkuu. *Nyt* palauttaa nykyhetkeen. Palkin alaosassa kerrotaan, sataako kohdallasi tai milloin sade alkaa. Ennuste päivittyy viiden minuutin välein, kun sovellus on auki, ja se vaatii verkkoyhteyden. Tason saa piiloon palkin ×-painikkeesta tai *Karttatasot*-valikosta.

## Käyttöönotto

1. **GitHub Pages:** repon *Settings → Pages → Build and deployment*: Source **Deploy from a branch**, Branch **main**, kansio **/docs** → *Save*. Sovellus on hetken päästä osoitteessa `https://<käyttäjänimi>.github.io/<repo>/`.
2. **Puhelin:** avaa osoite ja lisää sovellus kotinäytölle (iPhone: Safari → Jaa → *Lisää Koti-valikkoon*; Android: Chrome → ⋮ → *Asenna sovellus*). Kotinäytöltä avattuna tallennetut kartat säilyvät.
3. **MML:n API-avain:** hae ilmainen avain [Maanmittauslaitokselta](https://www.maanmittauslaitos.fi/rajapinnat/api-avaimen-ohje) ja syötä se sovelluksen asetuksiin. Avain tallentuu vain puhelimeen.
4. **Alueet:** lisää lupa-alueiden rajaukset `areas/`-kansioon, ks. [areas/README.md](areas/README.md).
5. **Offline:** avaa sovelluksessa *Lupa-alue* → *Tallenna offline* kotona Wi-Fissä ennen jahtia.

## Miten tämä toimii

- `areas/*.geojson`: lupa-alueiden rajat (piirretään käsin).
- `pipeline/build.py`: ajetaan GitHub Actionsissa aina, kun `areas/` muuttuu, sekä viikoittain. Lukee Luken MVMI-aineistosta vain alueen kohdan (puuston ikä ja keskipituus, 16 m ruudut), leikkaa Syken luonnonsuojelualueet ja kirjoittaa tulokset `docs/data/`-kansioon.
- `pipeline/habitat.py`: metson, teeren ja pyyn elinympäristömalli MVMI:n lisätasoista.
- `pipeline/cuts.py`: metsätiedon jälkeiset hakkuut Metsäkeskuksen latvusmallista ja metsänkäyttöilmoituksista. Viikkoajo päivittää vain nämä, jos uutta tietoa on tullut. GitHub keskeyttää ajastetut ajot, jos repossa ei ole tapahtunut mitään 60 päivään. Ne saa takaisin päälle *Actions*-välilehdeltä.
- `docs/`: itse sovellus (GitHub Pages). Leaflet-kartta, joka piirtää metsäkerroksen laitteella tallennetusta datasta. Service worker pitää sovelluksen ja tallennetut kartat käytettävissä ilman verkkoa.
- Rakentamisen voi käynnistää käsin: *Actions → Rakenna metsäkartat → Run workflow* (valinta "Rakenna kaikki alueet uudelleen", jos Luke julkaisee uuden aineistovuoden ja `pipeline/config.json` päivitetään).

## Tietolähteet ja lisenssit

- Metsätieto ja elinympäristömallin lähtötiedot: Luonnonvarakeskus, monilähteinen valtakunnan metsien inventointi (MVMI) 2023, CC BY 4.0.
- Luonnonsuojelualueet: Syke / Metsähallitus, CC BY 4.0.
- Tuuli-, lämpötila- ja kosteusennuste: Ilmatieteen laitos, avoin data (CC BY 4.0). Varalla Open-Meteo (CC BY 4.0, ilmainen vain ei-kaupalliseen käyttöön).
- Sade-ennuste: MET Norway, Nowcast 2.0 (CC BY 4.0). Ennuste perustuu sadetutkahavaintoihin.
- Uudet hakkuut: Suomen metsäkeskus, latvusmalli ja metsänkäyttöilmoitukset (CC BY 4.0).
- Pohjakartta: Maanmittauslaitos, CC BY 4.0 (tai OpenStreetMap ilman API-avainta, vain verkossa).
- Kirjasto: Leaflet 1.9.4 (BSD 2-Clause). Kartan kääntö on sovelluksen omaa koodia (`docs/rotate.js`).

MVMI on satelliittikuviin ja koealoihin perustuva arvio. Yksittäisen ruudun arvo voi poiketa todellisuudesta, mutta laajempien kuvioiden yleiskuva on luotettavampi. Aineisto kuvaa tilannetta vuonna 2023, joten sen jälkeiset hakkuut eivät näy. Ne erottuvat vaihtamalla pohjaksi ilmakuvan.

## Lisenssi

Sovellus ja sen lähdekoodi ovat julkisesti nähtävillä, mutta niitä ei saa käyttää kaupallisesti ilman tekijän lupaa.

- Sovelluksen koodi on lisensoitu [PolyForm Noncommercial 1.0.0](https://polyformproject.org/licenses/noncommercial/1.0.0) -lisenssillä ([LICENSE](LICENSE)). Sovellusta saa käyttää, muokata ja jakaa ei-kaupallisiin tarkoituksiin, esimerkiksi omaan käyttöön, harrastuksiin, opiskeluun ja tutkimukseen.
- Kaupallinen käyttö edellyttää tekijän (GitHub-käyttäjä [gitdaada](https://github.com/gitdaada)) etukäteen antamaa kirjallista lupaa. Kaupallista käyttöä on esimerkiksi:
  - sovelluksen tai siitä muokatun version julkaiseminen sovelluskaupassa (esim. App Store tai Google Play) tai muuten maksullisena, mainosrahoitteisena tai tilauspohjaisena
  - sovelluksen tai sen osien käyttäminen osana kaupallista tuotetta tai palvelua
  - sovelluksen myyminen tai lisensoiminen eteenpäin.
- Luvasta, sen ehdoista ja mahdollisesta rojaltijaosta sovitaan tapauskohtaisesti erikseen kirjallisesti.
- Kopioissa ja muokatuissa versioissa on säilytettävä LICENSE-tiedosto ja sen alussa oleva `Required Notice` -rivi.
- Poikkeus: `docs/vendor/leaflet/` on Leaflet-kirjasto, jota koskee sen oma BSD 2-Clause -lisenssi ([docs/vendor/leaflet/LICENSE](docs/vendor/leaflet/LICENSE)).

Karttadata (`docs/data/`) on johdettu avoimista aineistoista. Alkuperäisten aineistojen lisenssit (CC BY 4.0) on lueteltu kohdassa *Tietolähteet ja lisenssit*.

## Tietosuoja

- GPS-sijainti käsitellään puhelimen selaimessa. Tarkkaa sijaintia ei lähetetä minnekään.
- Tuuliennuste haetaan lupa-alueen keskipisteeseen (pyöristettynä), ei käyttäjän sijaintiin.
- Sade-ennustetta varten MET Norwaylle lähetetään 25 pisteen ruudukko enintään 7,5 km:n päästä sijainnista. Ruudukon keskipiste on pyöristetty noin 1 km:n tarkkuuteen. Haku tehdään vain, kun sovellus on auki ja näkyvissä ja sadetaso on päällä, ei koskaan taustalla. Sadetason pois kytkeminen lopettaa haut kokonaan.
- Havainnot ja saalismerkinnät tallentuvat vain puhelimeen. Ne eivät lähde minnekään.
- Kompassiseuranta käyttää puhelimen asentoantureita vain puhelimessa.
- Sovelluksessa ei ole kirjautumista, analytiikkaa eikä palvelinta.
- Repo on julkinen. Siitä näkyvät sovelluksen koodi ja lupa-alueiden rajat.

## Kehitys

```
python3 tests/test_encoding.py                    # koodauksen yksikkötestit
python3 tests/test_cuts.py                        # hakkuutunnistuksen yksikkötestit
python3 tests/test_habitat.py                     # elinympäristömallin yksikkötestit
python3 tests/make_fixture.py /tmp/site           # synteettinen testisivusto
python3 tests/e2e.py /tmp/site /tmp/shots         # selaintesti (Playwright)
```
