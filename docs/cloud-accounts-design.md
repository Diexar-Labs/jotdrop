# Ontwerp: JotDrop Cloud-accounts (e-mail + wachtwoord, end-to-end)

Status: GOEDGEKEURD door Eric op 22 oktober 2026 ("Ik ga akkoord met dit inlogontwerp, begin met de server."). De drie open punten volgen het voorstel. Server deel A en B gebouwd, review verwerkt (zie "Bouwstand").
Branch: `feat/cloud-development-preview`.

## Kort

- Je maakt een account met e-mail en wachtwoord, net als bij Google Keep.
- Je wachtwoord verlaat je apparaat nooit. Je apparaat maakt er twee sleutels van: een **inlogsleutel** (bewijst dat jij het bent) en een **ontgrendelsleutel** (opent je notities). De server krijgt alleen de inlogsleutel te zien, en bewaart daar alleen een hash van.
- De server kan je notities dus niet lezen, ook niet als hij gehackt wordt of als iemand de database steelt.
- Bij een nieuw apparaat vraagt JotDrop een extra code: per e-mail, of uit een authenticator-app als je die hebt ingesteld.
- Wachtwoord vergeten: (a) goedkeuren op je telefoon, (b) je herstelcode, (c) allebei kwijt: de cloud opnieuw beginnen. Je notities blijven bestaan, want ze staan als Markdown op je eigen apparaat.
- Vergelijkbaar met hoe Bitwarden en Proton wachtwoorden en versleuteling scheiden.

## Wat er nu al is (en blijft)

De huidige cloud (`cloud/server.mjs`, `cloud/shared/*.mjs`, web en Android) is al end-to-end:

- Elke vault heeft een willekeurige **vaultsleutel** (32 bytes). Alle bestanden worden op het apparaat versleuteld (AES-256-GCM); bestandsnamen worden HMAC-id's. De server ziet alleen versleutelde data.
- Elk apparaat heeft een eigen **apparaattoken**; de server bewaart alleen de SHA-256-hash. Apparaten zijn in te trekken.
- Een nieuw apparaat komt erbij via (1) een eenmalig **enrollment-token** (alleen voor de eerste vault), (2) een **koppelcode** van een ander apparaat, of (3) de **herstelcode** (vaultId + vaultsleutel + hersteltoken).
- Sync, geschiedenis, herstel van oude versies, quotum en hervatbare uploads werken al en veranderen niet.

**Kern van het ontwerp:** inloggen met e-mail en wachtwoord wordt een vierde manier om een apparaat toe te voegen. Daarna werkt alles zoals nu: het apparaat krijgt een apparaattoken en de vaultsleutel. De bestaande sync-API hoeft daardoor niet te veranderen.

## Sleutels

```
wachtwoord + salt ──Argon2id──► hoofdsleutel (32 bytes, alleen in het geheugen)
hoofdsleutel ──HKDF "jotdrop:auth:v1"──►   inlogsleutel     → naar de server
hoofdsleutel ──HKDF "jotdrop:unlock:v1"──► ontgrendelsleutel → blijft op het apparaat
ontgrendelsleutel ──AES-GCM──► ingepakte vaultsleutel → bewaard op de server
```

- **Argon2id** (RFC 9106): geheugen 64 MiB, 3 rondes, parallelisme 1. Duurt circa 0,5 tot 1 seconde op een telefoon. Parameters staan per account op de server, zodat ze later zwaarder kunnen.
- **Salt:** 16 willekeurige bytes per account, aangemaakt bij registratie.
- **Server:** bewaart `Argon2id(inlogsleutel, serversalt)` (Node 26 heeft `crypto.argon2` ingebouwd). Een gestolen database levert dus geen bruikbare inlogsleutel op, en geen wachtwoord zonder dubbel zwaar raden.
- **Ingepakte vaultsleutel:** AES-GCM met de ontgrendelsleutel, AAD `jotdrop:wrap:v1`, inhoud `{ "vaultKey": ... }`. Alleen wie het wachtwoord kent, pakt hem uit. (Geen account-id in de AAD: die bestaat nog niet als het apparaat inpakt, en de ontgrendelsleutel is al uniek per account door de eigen salt.)
- **Bibliotheken:** browser `hash-wasm` (Argon2id in WASM; de CSP staat `wasm-unsafe-eval` al toe), Android Bouncy Castle `Argon2BytesGenerator`, server `node:crypto`. Een testvector met vaste invoer moet op alle drie dezelfde uitkomst geven.

## Stromen

### Registreren

1. Apparaat: kiest salt, maakt vaultsleutel, hersteltoken en apparaattoken, leidt inlogsleutel en ontgrendelsleutel af, pakt de vaultsleutel in.
2. `POST /api/v1/accounts` met e-mail, salt, KDF-parameters, inlogsleutel, ingepakte vaultsleutel, hash van hersteltoken, apparaatnaam en hash van apparaattoken.
3. Server maakt een **onbevestigd** account en stuurt een code van 6 cijfers per e-mail (15 minuten geldig).
4. `POST /api/v1/accounts/verify` met de code: account en vault worden actief, het apparaat is gekoppeld.
5. Het apparaat toont de **herstelcode** (zoals nu) met de vraag die te bewaren.

Een onbevestigde registratie vervalt samen met de code na 15 minuten; opnieuw registreren stuurt een nieuwe code. Bestaat het e-mailadres al, dan krijgt de eigenaar een mail ("iemand probeerde zich te registreren") en ziet de aanvrager hetzelfde scherm als bij succes. Zo valt niet te achterhalen wie een account heeft.

### Inloggen op een nieuw apparaat

1. `POST /api/v1/auth/prelogin` met e-mail → salt en KDF-parameters. Voor onbekende adressen geeft de server een nep-salt die steeds hetzelfde is (`HMAC(servergeheim, e-mail)`), zodat niet te zien is of een adres bestaat.
2. Apparaat leidt de inlogsleutel af. `POST /api/v1/auth/login` met e-mail, inlogsleutel, apparaatnaam en hash van een nieuw apparaattoken.
3. Klopt het, dan vraagt de server de **tweede stap**: een e-mailcode, of de authenticator-code als die is ingesteld.
4. `POST /api/v1/auth/login/second-factor` met de code → de server koppelt het apparaat en geeft vaultId, deviceId en de ingepakte vaultsleutel terug.
5. Apparaat pakt de vaultsleutel uit met de ontgrendelsleutel. Vanaf hier is het een gewoon gekoppeld apparaat.

De browser vraagt "Deze browser onthouden?". Zo nee: alles alleen in het geheugen, weg bij sluiten. Zo ja: de gegevens in IndexedDB, versleuteld met een niet-exporteerbare WebCrypto-sleutel, met automatisch vergrendelen na inactiviteit.

### Wachtwoord wijzigen

Ingelogd apparaat met het huidige wachtwoord: nieuwe salt, nieuwe inlogsleutel, vaultsleutel opnieuw ingepakt. `POST /api/v1/account/password`. De vaultsleutel zelf blijft gelijk, dus er hoeft niets opnieuw versleuteld te worden. Optie: "Alle andere apparaten afmelden".

### Wachtwoord vergeten

**(a) Goedkeuren op je telefoon (de makkelijke route)**

1. Nieuw apparaat: "Wachtwoord vergeten", e-mailcode invoeren. Het maakt een tijdelijk sleutelpaar (ECDH P-256) en stuurt de publieke sleutel naar de server.
2. Je telefoon (al gekoppeld) toont: "Nieuw apparaat wil toegang: Chrome op Windows". Beide schermen tonen dezelfde **4 controlewoorden**, afgeleid van de publieke sleutel. Kloppen ze, dan tik je op Goedkeuren.
3. De telefoon versleutelt de vaultsleutel voor die publieke sleutel. Het nieuwe apparaat pakt hem uit, je kiest een nieuw wachtwoord, en de vaultsleutel wordt opnieuw ingepakt.

De controlewoorden voorkomen dat een kwaadwillende server zijn eigen sleutel ertussen schuift. Een verzoek is 10 minuten geldig.

**(b) Herstelcode**

De bestaande herstelcode bevat de vaultsleutel en het hersteltoken. Met de code plus een e-mailcode kies je een nieuw wachtwoord. Bestaat al (`/recover`), wordt uitgebreid met het opnieuw inpakken.

Herstelcode kwijt maar nog een verbonden apparaat: "Make a new recovery code" (web: Devices & recovery; Android: Account). Het apparaat maakt een nieuw hersteltoken en stuurt alleen de hash (`POST /recovery`, met apparaattoken); de oude code werkt daarna niet meer. Heeft de cloud een account, dan is ook het wachtwoord nodig (zodat een gestolen apparaattoken de code van de eigenaar niet kan vervangen) en krijgt het adres een melding `recovery-changed`. Toegevoegd 22 okt 2026.

**(c) Allebei kwijt**

Met alleen een e-mailcode: het cloudaccount opnieuw beginnen. De oude versleutelde cloudinhoud wordt na een bevestiging gewist (die kan niemand meer lezen), alle apparaten worden afgemeld. Je telefoon of pc met de Markdown-notities uploadt daarna alles opnieuw. JotDrop zegt dit duidelijk vóór de bevestiging.

### Authenticator-app (optioneel)

Instelbaar in de accountinstellingen (TOTP, RFC 6238, met QR-code). Het TOTP-geheim staat op de server versleuteld met een serversleutel uit de omgeving, niet in de database. Met een authenticator vervangt die de e-mailcode bij inloggen; voor wachtwoord vergeten blijft de e-mailcode nodig.

### Bestaande vaults (zoals Vault_1 op Erics telefoon)

Een al gekoppeld apparaat krijgt "Account aanmaken voor deze cloud": het pakt de bestaande vaultsleutel in met een nieuw wachtwoord en koppelt een e-mailadres aan de bestaande vault. Geen nieuwe upload nodig. Koppelcodes en herstelcodes blijven werken.

## Server: wijzigingen

Nieuwe tabellen. Ze komen er alleen bij (`CREATE TABLE IF NOT EXISTS`), dus de databaseversie blijft 1 en bestaande databases werken zonder migratie:

- `accounts(id, email UNIQUE, vaultId UNIQUE, kdf, authHash, wrappedVaultKey, failedLogins, lockedUntil, createdAt, passwordChangedAt)`
- `signups(id, email, vaultId?, kdf, authHash, wrappedVaultKey, recoveryHash?, deviceName?, deviceTokenHash?, codeHash, attempts, expiresAt)`: een registratie die op de e-mailcode wacht, met een eigen id zodat een tweede registratie voor hetzelfde adres de eerste niet kan overschrijven. Met `vaultId` = een bestaande vault die een account krijgt.
- `login_challenges(id, accountId, deviceName, deviceTokenHash, codeHash, attempts, expiresAt)`: tussen wachtwoord en e-mailcode.
- `secrets(name, value)`: de sleutel voor nep-salts.
- `code_failures(scope, count, lockedUntil)`: foute codes per account of adres (`signup:<e-mail>`, `login:<account>`, `reset:<account>`); na 10 fouten 24 uur geen codes meer voor dat doel.
- `resets(id, accountId, codeHash, attempts, expiresAt)`: een wachtwoord-vergeten-code.
- `device_approvals(id, accountId, publicKey, claimTokenHash, envelope, expiresAt)`: route (a).
- In `accounts` ook `totpSecret`, `totpPending` (beide versleuteld met een sleutel afgeleid van `JOTDROP_CLOUD_SERVER_KEY`) en `totpLastStep` (tegen hergebruik van een code).

Routes deel A (gebouwd):

| Route | Wie | Wat |
| --- | --- | --- |
| `POST /api/v1/accounts` | iedereen | registreren, stuurt code; altijd `202` met `{signupId}` |
| `POST /api/v1/accounts/verify` | iedereen | `{signupId, code}` → `{vaultId, deviceId}` (of `{vaultId}` bij een bestaande vault) |
| `POST /api/v1/auth/prelogin` | iedereen | `{email}` → `{kdf}`; nep-salt voor onbekende adressen |
| `POST /api/v1/auth/login` | iedereen | `{email, authKey, deviceName, deviceTokenHash}` → `{challengeId, secondFactor: "email"}` |
| `POST /api/v1/auth/login/verify` | iedereen | `{challengeId, code}` → `{vaultId, deviceId, wrappedVaultKey}` |
| `GET /api/v1/account` | apparaat | `{email}` of `404` |
| `POST /api/v1/account` | apparaat | bestaande vault een account geven → `{signupId}` (daarna `/accounts/verify`) |
| `POST /api/v1/account/password` | apparaat | `{currentAuthKey, kdf, authKey, wrappedVaultKey, signOutOtherDevices}` |

Routes deel B (gebouwd):

| Route | Wie | Wat |
| --- | --- | --- |
| `POST /api/v1/account/totp` | apparaat | nieuw geheim → `{secret, uri}` (QR-code) |
| `POST /api/v1/account/totp/enable` | apparaat | `{code, currentAuthKey}` → aan (wachtwoord nodig) |
| `POST /api/v1/account/totp/disable` | apparaat | `{currentAuthKey}` → uit |
| `POST /api/v1/auth/reset/start` | iedereen | `{email}` → `{resetId}`, mailt een code; voor onbekende adressen hetzelfde antwoord zonder mail |
| `POST /api/v1/auth/reset/recover` | iedereen | route (b): `resetId, code, recoveryToken` + nieuwe gegevens → `{vaultId, deviceId}` |
| `POST /api/v1/auth/reset/approval` | iedereen | route (a) stap 1: `resetId, code, publicKey, claimTokenHash` → `{approvalId}` |
| `GET /api/v1/account/approvals` | apparaat | openstaande verzoeken met hun publieke sleutel (voor de 4 controlewoorden) |
| `POST` / `DELETE /api/v1/account/approvals/:id` | apparaat | goedkeuren met `{envelope}` (de vaultsleutel versleuteld voor het nieuwe apparaat) of weigeren |
| `POST /api/v1/auth/reset/approval/:id` | nieuw apparaat | `{claimToken}` → `{envelope}` of `null` (pollen) |
| `POST /api/v1/auth/reset/approval/:id/complete` | nieuw apparaat | `claimToken` + nieuwe gegevens → `{vaultId, deviceId}` |
| `POST /api/v1/auth/reset/restart` | iedereen | route (c): `resetId, code, confirm: "DELETE CLOUD DATA"` + nieuwe gegevens → nieuwe lege vault |

Alle bestaande routes blijven ongewijzigd. Met een authenticator geeft `/auth/login` `secondFactor: "totp"` en stuurt de server geen mail.

Codes: 6 cijfers, 15 minuten geldig, maximaal 5 pogingen per code, eenmalig, en maximaal 10 foute codes per account per 24 uur (blijvend, ook over herstarts en nieuwe codes heen). Een nieuwe reset maakt de vorige ongeldig. De server bewaart alleen een HMAC met een sleutel uit de omgeving, dus een gekopieerde database is niet genoeg om een code te kraken. De resetmail wordt verstuurd zonder erop te wachten, zodat de reactietijd niet verraadt of een adres bestaat. De serverhash van de inlogsleutel is Argon2id met 7 MiB en 5 rondes (OWASP-minimum), zodat inloggen de server niet overbelast.

- **Enrollment-token:** vervalt voor productie (open registratie). Blijft alleen als testoptie zodat de bestaande tests blijven werken.
- **E-mail:** een kleine `mailer`-functie. Staging schrijft codes naar een logbestand; productie gebruikt een e-maildienst (stap 5, vraagt één keer Erics hulp voor een account).
- **Misbruik:** limiet per IP én per e-mailadres op registreren, inloggen en codes; codes maximaal 5 pogingen; na 10 foute wachtwoorden 15 minuten wachten voor dat account. Quotum per vault blijft 100 MiB.
- **Foutmeldingen** zeggen nooit of een e-mailadres bestaat. Eén bewuste uitzondering: na 10 foute wachtwoorden zegt de server "Too many attempts" (`429`), want anders blijft iemand met het goede wachtwoord denken dat het fout is.
- **Let op voor productie:** de limieten per IP gebruiken nu het IP van de verbinding. Achter de reverse proxy is dat altijd de proxy zelf, en dan gelden ze voor iedereen samen. Vóór productie (stap 5) moet de server het echte IP uit de header van de vertrouwde proxy lezen.

## Bouwstand

- **Deel A (22 okt 2026):** registreren, bevestigen, inloggen met e-mailcode, wachtwoord wijzigen, account voor een bestaande vault, vergrendeling na 10 foute wachtwoorden, enrollment alleen nog met een ingesteld token. Tests: `cloud/accounts.test.mjs` (8), volledige `npm run check:cloud` 71/71.
- **Deel B (22 okt 2026):** authenticator-app (RFC 6238, geheim versleuteld, geen hergebruik van een code), de drie wachtwoord-vergeten-routes. Tests: `cloud/accounts.test.mjs` nu 14, volledige `npm run check:cloud` 77/77.
- **Onafhankelijke review (22 okt 2026):** geen ernstige fouten (geen omzeiling, geen toegang tussen accounts, server ziet nooit de vaultsleutel). Verwerkt: (1) blijvende teller op foute codes per account; (2) resetmail zonder wachten; (3) eigen id per registratie; (4) authenticator aanzetten vraagt het wachtwoord; (5) codes als HMAC met serversleutel. Bekende beperking (6): nep-instellingen voor onbekende adressen volgen `DEFAULT_KDF`; worden de standaardinstellingen later zwaarder, dan moet die waarde mee, en een echte salt verandert na een wachtwoordwijziging terwijl een nep-salt gelijk blijft. Ook bekend: mail naar willekeurige adressen is per adres beperkt tot 3 per minuut; strengere limieten horen bij productie. Tests nu 18, volledige suite 81/81.
- **Clientbasis en webversie (22 okt 2026):** `cloud/shared/account.mjs` (Argon2id via `hash-wasm` 4.12.0, HKDF via WebCrypto, inpakken, alle stromen, ECDH P-256 voor goedkeuren, 4 controlewoorden uit de BIP39-lijst in `cloud/shared/words.mjs`, 2048 woorden = 44 bits). De client weigert KDF-instellingen van de server buiten 64 MiB-1 GiB / 3-10 rondes, zodat een kwaadwillende server ze niet kan verzwakken. Wachtwoorden worden NFC-genormaliseerd. Kruistest: dezelfde sleutels als Node `argon2Sync` + `hkdfSync`. Webversie: inloggen, registreren, code, wachtwoord vergeten (drie routes, wachtscherm met woorden), en in "Devices & recovery" account koppelen, wachtwoord wijzigen, authenticator, verzoeken goedkeuren. "Remember this browser" bewaart de verbinding versleuteld met het wachtwoord; zonder vinkje wordt niets bewaard. De importmap staat via een CSP-hash toe die de server bij het starten uitrekent. Tests: `cloud/shared/account.test.mjs` (10), volledige suite 91/91, de vier bestaande Python-browserproeven PASS, en handmatig in de browser (Playwright): registreren, vergrendelen/ontgrendelen, inloggen met e-mailcode, goedkeuren in beide richtingen (zelfde woorden op beide schermen), authenticator aanzetten.
- **Android (22 okt 2026; 9 e2e-proeven PASS op emulator Android 10 en 15):** `CloudAccountCrypto.kt` (Argon2id via Bouncy Castle `bcprov-jdk18on` 1.78.1, HKDF, KDF-grenzen als in de webclient plus een geheugencheck tegen de Java-heap, 4 controlewoorden, ECDH P-256 met controle dat het punt op de curve ligt), `CloudAccount.kt` (alle stromen), `CloudAccountUi.kt` (inloggen, registreren, code, wachtwoord vergeten met de drie routes, account toevoegen aan een gekoppelde cloud, wachtwoord wijzigen, verzoeken goedkeuren). De herstelcode staat versleuteld (Keystore) tot de gebruiker "Done" tikt. Kruistest `npm run check:cloud-account-android` (16 vectoren: Argon2id/HKDF incl. NFC, inpakken, woorden, ECDH). Emulatorproef (Android 10, lokale server achter TLS): alle stromen in beide richtingen met de webclient. Onafhankelijke review verwerkt. Nog te doen: proef op Android 15 en op een echte telefoon.
- **Nog niet gebouwd (volgende stappen):** authenticator instellen op Android (inloggen met een authenticator-code werkt wel), een QR-code voor de authenticator (nu alleen de sleutel om over te typen), een echte e-maildienst, en het echte IP achter de proxy.
- **Omgeving:** `JOTDROP_CLOUD_SERVER_KEY` (32 willekeurige bytes, base64url) is nodig voor accounts: codes en authenticatorgeheimen hangen ervan af. Buiten de database bewaren en niet wisselen. Zonder deze sleutel start de CLI met een tijdelijke sleutel (alleen voor ontwikkelen). Zonder enrollment-token is `/vaults` dicht.

## Deel C: inloggen met Google en GitHub (24 okt 2026)

Eric koos "Google + goedkeuren" en voegde GitHub toe. Google of GitHub bewijst alleen **wie** je bent. De vaultsleutel komt nooit bij hen of bij de server: een nieuw apparaat krijgt hem via de vier woorden op een gekoppeld apparaat, of via de herstelcode. Een wachtwoord is optioneel.

**Stroom**

1. Het apparaat maakt een geheim `verifier` en houdt dat bij zich. Het opent `GET /api/v1/auth/oauth/<google|github>/start?client=<web|obsidian>&challenge=<sha256(verifier)>`.
2. De server bewaart een eenmalige `state` (10 minuten) en stuurt de browser naar Google of GitHub. De client-geheimen van die apps staan alleen op de server.
3. Terug op `/callback` wisselt de server de code in, en vraagt het **bevestigde** e-mailadres op (Google: `email_verified`; GitHub: het primaire, bevestigde adres uit `/user/emails`). Zonder bevestigd adres: geen ticket, wel een duidelijke melding.
4. De server maakt een eenmalig **ticket** (10 minuten; alleen de hash staat in de database) en stuurt de browser terug: web naar `/#oauth=<ticket>`, Obsidian naar `obsidian://jotdrop-cloud?oauth=<ticket>`. Het ticket werkt alleen samen met de `verifier` van stap 1. Een onderschepte terugsprong-link is daarom niets waard.
5. `POST /auth/oauth/ticket` met ticket en verifier zegt wie er inlogde en of dat adres al een account heeft (`account`, `password`).
6. Daarna één van drie:
   - **Nieuw adres:** `POST /auth/oauth/signup`: nieuwe vault, account zonder wachtwoord (`kdf`, `authHash` en `wrappedVaultKey` leeg), gekoppelde identiteit, eerste apparaat; het apparaat toont de herstelcode.
   - **Bestaand account, sleutel via goedkeuren:** `POST /auth/oauth/approval` maakt een goedkeuringsverzoek zoals bij "wachtwoord vergeten" (route a). Het pollen gaat via de bestaande routes; `.../complete` mag nu zonder nieuwe wachtwoordvelden (dan blijft het wachtwoord zoals het is).
   - **Bestaand account, sleutel via herstelcode:** `POST /auth/oauth/recover`.

**Koppelen**

- Tabel `identities(provider, subject, accountId)`: de vaste id bij Google of GitHub, niet het e-mailadres.
- Een inlog bij een nieuwe aanbieder met hetzelfde bevestigde adres als een bestaand account koppelt aan dat account. Dat gebeurt pas bij goedkeuren of de herstelcode, en de eigenaar krijgt een mail `provider-linked`. Dat geeft niet meer macht dan een e-mailcode bij "wachtwoord vergeten" nu al geeft: de sleutel komt alleen van een eigen apparaat of de herstelcode.
- Een account met een wachtwoord blijft met het wachtwoord inloggen. Een account zonder wachtwoord kan er een krijgen via "Forgot password" (e-mailcode, dan goedkeuren of de herstelcode).

**Zonder wachtwoord**

- Wachtwoord-inloggen komt nooit bij een account zonder wachtwoord uit (`prelogin` geeft een nep-salt, `login` weigert).
- Wachtwoord wijzigen, de authenticator-app en een nieuwe herstelcode vragen het huidige wachtwoord. Zonder wachtwoord antwoordt de server `409` met `code: "no-password"`, en de website legt uit hoe je er een toevoegt.
- Web: "Stay signed in" staat standaard aan. "Lock workspace" is er alleen met een wachtwoord, want zonder wachtwoord kan niets een vergrendelde browser weer openen; "Log out" blijft.

**Server-instellingen:** `JOTDROP_CLOUD_GOOGLE_CLIENT_ID`/`_SECRET` en `JOTDROP_CLOUD_GITHUB_CLIENT_ID`/`_SECRET`. Zonder instellingen biedt de server de knoppen niet aan (`GET /auth/providers`). De callback-URL bij Google en GitHub is `<publieke origin>/api/v1/auth/oauth/<google|github>/callback`.

**Tests:** `cloud/oauth.test.mjs` (nep-Google/GitHub via de `fetcher` van de server: nieuw account, goedkeuren, GitHub koppelen met herstelcode, account met wachtwoord, zonder wachtwoord plus "Forgot password", onbevestigd adres, gestolen/verlopen tickets, hergebruikte state, geannuleerd) en `npm run check:cloud-oauth` (website in een echte browser).

**Bouwstand:** server, gedeelde client (`cloud/shared/account.mjs`) en website gebouwd; OAuth-apps geregistreerd en op staging (24 okt). Plugin: knoppen in het inlogvenster, de `verifier` wacht in de IndexedDB van deze vault, de browser springt terug naar `obsidian://jotdrop-cloud?oauth=<ticket>` (handler in `CloudController.register`); daarna nieuw account, goedkeuren of herstelcode zoals op de website. Een terugsprong in een andere vault vindt geen `verifier` en vraagt opnieuw te beginnen. Zonder wachtwoord verbergt de plugin "Change password" en "Make a new recovery code" en legt uit hoe je een wachtwoord toevoegt. Test: `cloud/plugin.test.mjs`. Android (25 okt): knoppen op het inlog- en registratiescherm (alleen als de server ze aanbiedt), de `verifier` wacht versleuteld in `CloudPreviewStore` (overleeft procesdood), de browser springt terug naar `jotdrop-cloud://oauth?oauth=<ticket>` (`CloudActivity`, `singleTask`, server `client=android`); daarna nieuw account (met nieuwsvinkje), goedkeuren met de vier woorden of herstelcode. Zonder wachtwoord verbergt de app "Change password" en "Make a new recovery code" en legt uit hoe je een wachtwoord toevoegt. Proef op emulator Android 10 met nep-Google/GitHub: nieuw account, GitHub koppelen met herstelcode, goedkeuren met apparatenkeuze, sleutel klopt (notitie van een tweede apparaat leesbaar), losse terugsprong-link en afgebroken aanmelding geven een melding, procesdood tijdens de browser.

## Nieuws per e-mail (Brevo, 24 okt 2026)

Erics besluit: een vinkje "Email me news about JotDrop." (25 okt op Erics verzoek ingekort; was "...JotDrop Cloud. A few emails, sent with Brevo; ..."), standaard uit, bij elke aanmelding (e-mail, Google/GitHub, account voor een bestaande cloud; website, plugin en Android). Alleen wie het aanvinkt, komt op de lijst; dat past bij de AVG en de Spaanse LSSI (toestemming vooraf, afmelden in elke mail via Brevo).

- Het vinkje reist mee met de aanmelding (`newsletter: true`). Bij e-mail wacht het in `signups` tot het adres bevestigd is.
- Zodra het account bestaat, schrijft de server `newsletter(accountId, consentedAt, addedAt)` als bewijs van toestemming en zet daarna het adres via de Brevo-API (`POST /v3/contacts`, `listIds`, `updateEnabled`) op de lijst. Lukt dat niet, dan gaat de aanmelding gewoon door; `addedAt` blijft leeg en de log noemt het adres niet.
- Server-instellingen: `JOTDROP_CLOUD_BREVO_API_KEY` en `JOTDROP_CLOUD_BREVO_LIST_ID`. Zonder sleutel wordt het vinkje wel bewaard, maar niemand doorgestuurd.
- Afmelden en de campagne zelf regelt Brevo. Privacybeleid voor de cloud (25 okt): `/privacy` op de cloudwebsite (`cloud/web/privacy.html`), gelinkt onder het inlogscherm; noemt Brevo, Amazon SES, Stripe, Google, GitHub en Cloudflare.
- Tests: `cloud/newsletter.test.mjs`.

## Wat dit ontwerp bewust NIET beschermt

- **Een zwak wachtwoord.** Wie de database steelt, kan wachtwoorden proberen te raden (traag door Argon2id). Daarom minimaal 12 tekens en een waarschuwing bij veelgebruikte wachtwoorden.
- **Een gehackte webserver die andere JavaScript serveert.** Dat geldt voor elke webversie met end-to-end-versleuteling, ook bij Proton en Bitwarden. De Android-app en de Obsidian-plugin hebben dit risico niet, want hun code komt niet van de server. Later te verkleinen met een browserextensie of controleerbare builds.
- **Metadata.** De server ziet e-mailadres, aantal en grootte van bestanden, tijdstippen en apparaatnamen. Niet de inhoud of de bestandsnamen.

## Later

- Passkeys (WebAuthn met de PRF-uitbreiding kan de vaultsleutel ook inpakken, dan kan inloggen zonder wachtwoord).
- Betalen en grotere quota.

## Testplan (bij het bouwen)

1. Argon2id-testvector gelijk in browser, Node en Android.
2. Servertests per route: registreren, bevestigen, inloggen met e-mailcode en met TOTP, wachtwoord wijzigen, de drie vergeten-routes, limieten, geen verschil in antwoord tussen bestaand en onbekend e-mailadres.
3. Migratietest: een database van versie 1 met bestaande vaults blijft werken en kan een account krijgen.
4. Bestaande tests (`server.test.mjs`, `transfer.test.mjs`, `client.test.mjs`) blijven groen.
5. Browserproef op staging: registreren en inloggen in de webversie, en de kaarten zien.

## Open punten voor Eric

1. **Tweede stap standaard per e-mail** bij elk nieuw apparaat, authenticator-app optioneel. (Voorstel: ja.)
2. **Minimale wachtwoordlengte 12 tekens.** (Voorstel: ja; zelfde regel als de huidige ontgrendelzin.)
3. **Route (c)** wist de oude versleutelde cloudinhoud pas na een duidelijke bevestiging. (Voorstel: ja.)
