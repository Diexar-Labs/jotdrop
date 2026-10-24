# Functiepariteit: website, Obsidian-plugin en Android-app

Besluit van Eric (24 oktober 2026): "zorg ervoor dat de functionaliteit overal hetzelfde is. Dus wat in de website kan, dat kan ook in de plugin, wat in de plugin kan, dat kan ook in de app, etc."

Stand gemeten op `ee57d58` (feature-branch), bijgewerkt met elke afgeronde functie. Ja = aanwezig, deels = gedeeltelijk, NEE = ontbreekt, n.v.t. = hoort niet bij dit platform. Bij elke afgeronde functie deze lijst bijwerken.

## Vastleggen

| Functie | Website | Plugin | Android |
|---|---|---|---|
| Nieuwe notitie | ja | ja | ja |
| Snelle notitie (los venster) | NEE | ja | NEE |
| Delen naar JotDrop (tekst, link, foto) | NEE | deels (webclipper via Chrome-extensie) | ja |
| Spraakmemo opnemen | ja (knop "Voice memo" in de werkbalk, 24 okt) | ja (microfoonknop bovenaan) | ja (microfoonknop) |
| Foto maken of kiezen als notitie | deels (uploaden; camera via "Text from photo") | ja (cameraknop > Add photo, 24 okt; camera via systeemkiezer op telefoon) | ja |
| Foto in notitie invoegen (editor) | NEE | NEE | ja |
| Tekst uit foto (OCR) (Eric 24 okt: liefst alle talen, ook Arabisch; lage prioriteit) | ja (knop "Text from photo", Tesseract nl/en lokaal, 24 okt; zin "Recognize English and Dutch…" weggehaald) | ja (cameraknop > Text from photo, Tesseract nl/en lokaal, taaldata eenmalig uit release `ocr-data-1`, 24 okt) | ja (ML Kit, Latijns schrift) |
| Spraak naar tekst (dicteren) | NEE | NEE | ja (6 talen) |
| Linkvoorbeeld (titel, plaatje) ophalen | NEE | ja | ja |

## Kaarten

| Functie | Website | Plugin | Android |
|---|---|---|---|
| Kaartenraster met Vastgezet/Overige | ja | ja | ja |
| 11 kleuren | ja | ja | ja |
| Vinklijst afvinken op de kaart | ja | ja | ja |
| Labels op de kaart | ja | ja (24 okt; stond eerder ten onrechte op ja, toonde alleen #tags; nu chip met labelpictogram) | ja (24 okt; chip met labelpictogram, vóór de #tags) |
| Tags (#hashtags) als chips | ja (24 okt; frontmatter + getypte #tags zoals Android, klik = filter) | ja | ja |
| Foto op de kaart | ja | ja | ja |
| Spraakmemo afspelen op de kaart | ja | ja | NEE (alleen in editor) |
| Linkchips (domeinnaam) | NEE | ja | ja |
| Geen Markdown-tekens op de kaart (Eric 24 okt): links tonen alleen hun naam, `[[notitie\|alias]]` de alias | ja (24 okt; link naar een bijlage die als speler/foto op de kaart staat verdwijnt) | ja (24 okt) | ja (24 okt) |
| Herinnering op de kaart (over 3 uur, te laat) | deels (alleen tekst) | ja | deels (alleen herhaling) |

## Acties op kaarten

| Functie | Website | Plugin | Android |
|---|---|---|---|
| Snel vastzetten vanaf de kaart | ja (24 okt) | ja | ja |
| Kleur kiezen vanaf de kaart | ja (24 okt) | ja | ja (lang drukken > kleur, 24 okt) |
| Labels geven vanaf de kaart | ja (24 okt) | ja | ja (lang drukken > Labels, zoals Keep op Android; Erics besluit 24 okt) |
| Archiveren vanaf de kaart | ja | ja | deels (via selectie of editor) |
| Naar prullenbak | ja | ja (24 okt; map `Trash` zoals Android, bijlagen blijven) | ja |
| Verplaatsen/kopiëren naar map (notitie gaat naar een gewone Obsidian-map) | n.v.t. (website ziet alleen JotDrop-notities, niet de rest van de vault; Erics besluit 24 okt) | ja | ja (24 okt; editor > Meer opties) |
| Meerdere kaarten selecteren | NEE | ja (archiveren, verwijderen) | ja (archiveren, verwijderen, labels, terugzetten) |
| Slepen om te ordenen | NEE (getal invullen) | ja | ja |
| Sorteeropties | 4 | 6 | 2 |
| Downloaden van een bestand | ja | n.v.t. | NEE |

## Editor

| Functie | Website | Plugin | Android |
|---|---|---|---|
| Apart titelveld | ja (24 okt; knop Markdown toont het hele bestand) | ja | ja |
| Vinklijst-knop/editor | ja (24 okt) | ja | ja |
| Kleur | ja (24 okt; kleurvlakjes met naam) | ja | ja |
| Tags invoeren als chips | ja (24 okt) | ja | ja |
| Labels kiezen uit lijst | ja (24 okt) | ja | ja |
| Link naar andere notitie invoegen | ja (24 okt) | ja | ja |
| Vorige/volgende notitie | ja (24 okt) | ja | ja |
| Foto groot bekijken (lightbox) | NEE | ja | ja |
| Herinnering met datum en tijd | ja | ja | ja |
| Herhalen: keuzescherm (dagelijks, weekdagen, elke N, n-de weekdag, eindigt) | ja (24 okt) | ja | ja |
| Markdown-spiekbriefje (Eric, 24 okt) | ja (knop Markdown help) | ja (knop in editor) | ja (editor > Meer opties) |
| Versiegeschiedenis van een notitie | ja | NEE | ja |

## Herinneringen, labels, zoeken

| Functie | Website | Plugin | Android |
|---|---|---|---|
| Melding op het moment zelf | NEE | deels (alleen als Obsidian open is) | ja (alarm, ook na herstart) |
| Overzicht Herinneringen | NEE | NEE | ja |
| Labels maken, hernoemen, verwijderen | ja (24 okt; linker balk > Edit labels, zoals plugin: nieuw label lokaal tot een notitie het heeft) | ja | ja |
| Filteren op label | ja (24 okt; labels in de linker balk met aantal, zoals Keep) | ja | ja |
| Filteren op tag | ja (24 okt; filterbalk: top 8 + "+N more", ✓ bij gekozen, elke gekozen tag telt) | ja | ja |
| Zoeken | ja | ja | ja |
| Archief bekijken | ja | ja (instelling) | ja |
| Prullenbak bekijken en terugzetten | ja | ja (24 okt; mapmenu > Trash, terugzetten of voorgoed verwijderen) | ja |
| Bijlagen bekijken (Files) | ja | n.v.t. (vault) | NEE |

## Importeren en exporteren

| Functie | Website | Plugin | Android |
|---|---|---|---|
| Google Keep importeren | ja | ja | NEE |
| Evernote importeren | ja | ja | NEE |
| Apple Notes / Markdown importeren | ja | ja | NEE |
| Alles exporteren (zip) | ja | n.v.t. (bestanden staan al in de vault) | NEE |

## Cloud

| Functie | Website | Plugin | Android |
|---|---|---|---|
| Inloggen met e-mail en wachtwoord | ja | NEE (alleen koppelcode) | ja |
| Wachtwoord wijzigen/vergeten | ja | NEE | ja |
| Authenticator-app (TOTP) | ja | NEE | NEE |
| Apparaten bekijken en intrekken | ja | NEE | ja |
| Koppelcode maken | ja | NEE | ja |
| Nieuw apparaat goedkeuren (4 woorden) | ja | NEE | ja |
| Automatisch synchroniseren | ja | NEE (alleen handmatige test) | ja |
| Conflict beoordelen | ja | NEE | ja |
| Tijdmachine | ja | NEE | ja |
| Herstelcode opnieuw maken | ja | NEE | ja |
| Plus bekijken | ja | NEE | deels (tekst) |
| Plus kopen | ja | NEE (bewust: alleen website) | NEE (bewust: alleen website) |
| "Manage or cancel your subscription at link.com." (Eric 24 okt: vindbaar maar verstopt, ingeklapt kopje "Subscription" onderaan de instellingen) | ja (onderaan Devices & recovery, alleen met abonnement) | NEE (komt mee met stap 4, cloud in plugin, op dezelfde verstopte manier) | ja (onderaan cloudscherm, altijd: app kent de abonnementsstatus niet) |

## Instellingen

| Functie | Website | Plugin | Android |
|---|---|---|---|
| Licht/donker kiezen | ja | n.v.t. (Obsidian-thema) | NEE (volgt systeem) |
| Taal van de app | Engels | Engels/Nederlands | 6 talen |
| Notitie- en bijlagemap kiezen | n.v.t. | ja | ja |
| Artikelplaatjes opslaan aan/uit | n.v.t. | ja | ja |
| Updates zoeken | n.v.t. | n.v.t. (Obsidian) | ja |

## Open besluiten voor Eric

1. **Linkvoorbeelden op de website.** Een browser mag andere websites niet zelf uitlezen. Het kan alleen via onze server, en dan ziet de server welke links in je notities staan.
2. **Dicteren op de website en in de plugin.** Chrome stuurt de spraak naar Google om er tekst van te maken. Het kan ook met een lokaal spraakmodel (privé, maar een download van tientallen MB).
3. **OCR in de plugin.** Kan met dezelfde lokale Tesseract als de website (nl/en, eenmalige download van de modellen).
4. **Meldingen op de website.** Alleen zolang het tabblad open is, tenzij we pushmeldingen via de server bouwen.
5. **Importeren in Android.** Keep/Evernote-bestanden staan meestal op de computer; is importeren via de website of plugin genoeg?
6. **Inloggen met Google (Eric, 24 okt).** Op alle drie de platforms. Google bewijst wie je bent en geeft een bevestigd e-mailadres, maar geeft geen geheim waarmee we je notities kunnen versleutelen. Voorstel: Google-login voor het account; de sleutel komt bij het eerste apparaat uit een herstelcode en op elk volgend apparaat via goedkeuring op een gekoppeld apparaat (de bestaande vier-woordenstap) of de herstelcode. Wachtwoord blijft als alternatief bestaan.
