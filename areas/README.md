# Lupa-alueiden rajaukset

Jokainen lupa-alue on tässä kansiossa yksi GeoJSON-tiedosto. Kun lisäät tai muutat tiedoston, GitHub rakentaa kartan automaattisesti (noin 5–15 min), ja alue näkyy sovelluksessa.

## Uuden alueen lisääminen

1. Avaa alueen **PDF-kartta** eräluvat.fi:stä (alueen sivu → *Kartat ja esitteet*).
2. Avaa [geojson.io](https://geojson.io) (tietokone tai tabletti). Vaihda pohjakartta yläpalkin oikeasta reunasta kerroskuvakkeesta (Export-painikkeen ja i-kuvakkeen välissä), esim. satelliittikuvaksi.
3. Etsi alue ja piirrä raja **monikulmiotyökalulla** (Draw Polygon) PDF-kartan mukaan. Lopeta klikkaamalla ensimmäistä pistettä.
   - Jos alue on useammassa osassa, piirrä jokainen osa omaksi monikulmiokseen samaan tiedostoon.
   - Jos alueen sisällä on yksityinen palsta, piirrä se omaksi monikulmiokseen ja lisää sille ominaisuus `poista` arvolla `true`. Se leikataan alueesta pois.
4. (Valinnainen) Klikkaa monikulmiota ja lisää ominaisuus `nimi`, esim. `6671 Evo`. Muuten nimi tehdään tiedostonimestä.
5. Tallenna: **Save → GeoJSON**. Nimeä tiedosto alueen numerolla ja nimellä, esim. `6671-evo.geojson`.
6. GitHubissa: avaa tämä `areas`-kansio → **Add file → Upload files** → valitse tiedosto → **Commit changes**.
7. Seuraa etenemistä **Actions**-välilehdeltä. Kun ajo on vihreä, avaa sovellus ja tallenna alue offline-käyttöön.

## Muuta

- Alueen poistaminen: poista tiedosto, niin myös kartta poistuu.
- Rajojen tarkistus: Metsähallitus päivittää lupa-alueiden rajoja vuosittain. Tarkista rajat kauden alussa.
- `0000-testialue.geojson` on vain automaation testi. Poista se, kun omat alueet on lisätty.
- Käsin piirretty raja on suuntaa-antava. Virallinen raja on eräluvat.fi:n kartassa.
