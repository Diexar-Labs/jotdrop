# Ontwerp: grote bestanden in versleutelde stukken (JotDrop Cloud v2-objecten)

Status: GOEDGEKEURD, 26 oktober 2026. Principe goedgekeurd door Eric ("Oké, dan moeten we dat fixen."); fase B = "Vervangen met controle" (Erics keuze 26 okt); maximum per bestand gekozen: **gratis 25 MB, Plus 200 MB**. Gratis opslag blijft 250 MB.
Branch: `feat/cloud-development-preview`.

## Kort

- Een bestand gaat in stukken van maximaal 4 MiB. Je apparaat versleutelt elk stuk apart; de server bewaart alleen versleutelde stukken en kan ze niet lezen of aan elkaar plakken.
- Bij elk bestand hoort een klein versleuteld lijstje (manifest): pad, grootte, vingerafdruk en welke stukken erbij horen.
- Gevolgen:
  - geen technische grens van 4 MiB meer, alleen het maximum van je abonnement (25 MB / 200 MB);
  - opslag telt de echte grootte, niet meer ~1,8 keer (geen dubbele base64);
  - een nieuw apparaat leest eerst alleen de lijstjes en haalt daarna alleen op wat het mist (eerste sync van minuten naar seconden);
  - een afgebroken upload of download gaat verder bij het stuk waar hij was;
  - geheugen per bestand blijft begrensd tot een paar stukken.
- Bestaande bestanden blijven leesbaar. Omzetten naar het nieuwe formaat is fase B (zie "Open keuze").

## Formaat

**Stuk (chunk).** Platte tekst: maximaal 4 MiB (4.194.304 bytes) van het bestand. Versleuteld met AES-GCM-256 met de vault-sleutel:
- IV = eerste 12 bytes van HMAC-SHA256(vaultKey, `jotdrop:chunk-iv:v1:{objectId}:{index}:{sha256(platte tekst van het stuk)}`). Deterministisch: hetzelfde stuk op dezelfde plek geeft dezelfde ciphertext, zodat een herstart na een onderbreking precies dezelfde stukken maakt en de al geüploade stukken worden hergebruikt. Hergebruik van (sleutel, IV) gebeurt alleen bij identieke platte tekst, dus veilig (SIV-achtig). Lek: de server ziet dat twee stukken op dezelfde plek van hetzelfde bestand gelijk zijn; dat ziet hij aan de grootte nu ook al grotendeels.
- AAD = `jotdrop:chunk:v1:{vaultId}:{objectId}:{index}`: een stuk kan niet naar een ander bestand of een andere plek worden verwisseld.
- Opgeslagen als ruwe bytes `iv || ciphertext+tag` (lengte = platte tekst + 28). Naam = hex sha256 van die bytes; de server controleert dat.

**Manifest.** De bestaande envelop (`{v:1, iv, ciphertext}`, AAD `jotdrop:object:v1:{vaultId}:{objectId}`) met als inhoud:
- v1 (bestaand): `{ path, content, modifiedAt }`.
- v2 (nieuw): `{ v: 2, path, modifiedAt, size, hash, chunks: [{ name, size }] }`, met `hash` = hex sha256 van het hele bestand en `size` de echte grootte. Kleine bestanden (tot 64 KiB) houden `content` inline in het manifest (geen extra verzoek per notitie) en hebben `chunks: []`.
- Lezers accepteren beide; schrijvers maken vanaf nu altijd v2.

## Server

- Nieuwe tabellen: `chunks(vaultId, name, size, data BLOB, createdAt)` (sleutel vaultId+name) en `envelope_chunks(vaultId, id, envelopeHash, name)`.
- `POST /chunks/missing {names}` geeft de namen die nog ontbreken. `PUT /chunks/{name}` (binair, maximaal 4 MiB + 28) slaat een stuk op na hash- en quotacontrole. `GET /chunks/{name}` geeft het stuk binair terug.
- Vastleggen: de bestaande `PUT /objects/{id}` krijgt `chunks: [name, ...]`. De server controleert dat alle stukken er zijn, dat de som binnen het maximum van het abonnement valt (gratis 25 MB, Plus 200 MB) en legt de koppeling vast in `envelope_chunks`. Het manifest zelf gaat via het bestaande pad (klein).
- `changes.size` en `revisions.size` = manifest + stukken (echte grootte), zodat sorteren en quota kloppen.
- Opslag = manifesten + stukken (elk stuk één keer, ook als meerdere versies het delen) + gereserveerde uploads. Stukken zonder koppeling worden na 24 uur opgeruimd. Bij ruimte maken (`fits`) en definitief wissen gaan ook stukken weg die door geen enkele envelop meer gebruikt worden.
- Tijdmachine en herstellen werken ongewijzigd: een herstelde versie gebruikt dezelfde envelop en dus dezelfde stukken.

## Clients

- **Gedeelde JS-client** (`cloud/shared/client.mjs`, plugin + website): `prepareWrite` maakt manifest + stukken; `commitWrite` vraagt welke stukken ontbreken, uploadt die één voor één (voortgang per stuk) en legt dan het manifest vast. `readManifest(id)` haalt alleen het manifest; `read(id)` haalt ook de stukken, ontsleutelt, controleert de vingerafdruk en geeft de bytes.
- **Sync** (`cloud/shared/sync.mjs`, Kotlin `CloudSyncEngine`): `remoteFiles` gebruikt de vingerafdruk uit het manifest en haalt de inhoud alleen op als die lokaal ontbreekt of verschilt.
- **Android** (`CloudClient.kt`, `CloudCrypto`): zelfde formaat, met pariteitsproeven tegen de JS-versie (zoals nu voor AES-GCM en hashes).
- **Website**: leest en schrijft v2; bijlagen pas ophalen bij openen is een vervolgstap.
- Oude clients kunnen v2-objecten niet lezen. Daarom: eerst de server, dan alle clients tegelijk naar staging; Erics telefoon krijgt een nieuwe testbuild voordat er v2-objecten in zijn cloud komen.

## Fases

- **A1** server + gedeelde JS-client + crypto, met proeven (groot bestand 100+ MB, onderbreken per stuk, quota = echte grootte, maximum per abonnement, tijdmachine over stukken, opruimen).
- **A2** `sync.mjs` manifest-eerst + plugin + website.
- **A3** Android-pariteit + emulator; daarna staging, telefoon, plugin op laptop.
- **B** bestaande v1-objecten omzetten (open keuze hieronder).
- **C** (later) één verzoek voor veel manifesten tegelijk, zodat de eerste sync nog sneller wordt.

## Open keuze (fase B): hoe bestaande bestanden omzetten

Erics teller moet van ~225 MB naar ~125 MB. Twee manieren:
1. **Als nieuwe versie**: het apparaat uploadt elk bestand opnieuw in v2 als nieuwe versie; niets wordt overschreven. Nadeel: de oude versies blijven meetellen zolang ze in de geschiedenis staan. Gratis: na 30 dagen mag de server ze opruimen als er ruimte nodig is. **Plus bewaart alle geschiedenis, dus bij Eric zakt de teller dan niet** (eerder ~350 MB: oud + nieuw). Een gratis gebruiker die bijna vol zit, kan halverwege op "vol" stuiten.
2. **Op dezelfde plek vervangen, met controle en vangnet** (aanbevolen): per versie maakt het apparaat de v2-vorm, uploadt die, haalt hem terug van de server, ontsleutelt en vergelijkt de vingerafdruk met de oude inhoud. Pas als die gelijk is, vraagt het de server de oude envelop in te wisselen (zelfde versienummer, geschiedenis blijft compleet). De server bewaart de oude envelop nog 7 dagen apart (telt niet mee) zodat een fout terug te draaien is, en wist hem daarna. De teller zakt meteen. Risico: de server kan de gelijkheid zelf niet controleren (alles is versleuteld); dat vangt de terugleescontrole + de 7 dagen op.
