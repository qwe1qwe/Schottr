# Schottr

Schlanke Angebots- und Rechnungssoftware für deutsche Unternehmen.
Mit Login, Mandanten, Adressen, Angeboten und Rechnungen als **ZUGFeRD** (PDF/A-3 mit eingebetteter XML) und **XRechnung 3.0**.

- **Node.js ≥ 22.18** (empfohlen: 24 LTS). TypeScript läuft direkt über Nodes Type Stripping, es gibt keinen Build-Schritt.
- **MariaDB** (≥ 10.11, im Docker-Setup 11.4 LTS) über den Treiber `mysql2`
- **Wenige Abhängigkeiten**, alle kommerziell nutzbar: Hono (MIT), mysql2 (MIT), PDFKit (MIT), Zod (MIT), IBM Plex Sans (OFL)
- Serverseitig gerenderte Oberfläche ohne Frontend-Framework. Das kleine `public/app.js` dient nur dem Positionseditor.

## Schnellstart mit Docker (empfohlen)

```bash
cp .env.example .env      # Passwörter in .env setzen
docker compose up -d --build
```

Danach läuft Schottr auf http://localhost:3000. Compose startet zwei Container:

- `schottr-db` mit **MariaDB 11.4**. Die Daten liegen in `./data/mariadb`.
- `schottr` mit der App. Sie startet erst, wenn die Datenbank bereit ist, und legt die Tabellen beim ersten Start selbst an.

Beim ersten Aufruf führt `/register` durch die Ersteinrichtung (Benutzer + erster Mandant).
Danach ist die Registrierung geschlossen, außer `SCHOTTR_ALLOW_REGISTRATION=true` ist gesetzt.
Weitere Benutzer lädt der Inhaber unter **Einstellungen → Benutzer** ein oder legt ihnen dort direkt ein Konto an.

Hinter einem Reverse-Proxy (z. B. Nginx Proxy Manager) einfach auf Port 3000 weiterleiten.
Sendet der Proxy `X-Forwarded-Proto: https`, werden Cookies automatisch als `Secure` gesetzt.

### Fertiges Image vom Server aus nutzen (GitHub Container Registry)

Bei jedem Push auf `main` baut GitHub Actions (`.github/workflows/docker.yml`) erst die Tests und dann das Image für amd64 und arm64. Es landet in der Registry als:

- `ghcr.io/qwe1qwe/schottr:latest` – aktueller Stand von `main`
- `ghcr.io/qwe1qwe/schottr:1.0.0` – bei einem Git-Tag `v1.0.0`
- `ghcr.io/qwe1qwe/schottr:sha-abc1234` – jeder Build, zum Zurückrollen

Auf dem Server brauchst du keinen Quellcode, nur den Ordner `deploy/` (`compose.yml`, `.env.example`, `backup.sh`):

```bash
cp .env.example .env            # Passwörter setzen
docker compose pull && docker compose up -d
```

Aktualisieren geht genauso: `docker compose pull && docker compose up -d`. Datenbank-Migrationen laufen beim Start automatisch.

Ist das Paket privat (Standard bei privaten Repos), meldet sich der Server einmalig an. Dafür auf GitHub ein Token (classic) nur mit `read:packages` anlegen und dann `docker login ghcr.io -u qwe1qwe` ausführen. Alternativ das Paket unter *GitHub → Packages → schottr → Package settings* auf „Public“ stellen.

### Backup & Wiederherstellung

```bash
./scripts/backup.sh       # legt backup/schottr-JJJJ-MM-TT_HHMM.sql.gz an
```

Für eine tägliche Sicherung per cron: `0 2 * * *  cd /pfad/zu/schottr && ./scripts/backup.sh`

So stellst du eine Sicherung wieder her:

```bash
gunzip -c backup/DATEI.sql.gz | docker compose exec -T db sh -c 'mariadb -uroot -p"$MARIADB_ROOT_PASSWORD" schottr'
```

Für die gesetzliche Aufbewahrung (8 bzw. 10 Jahre) die Sicherungen zusätzlich außerhalb des Servers ablegen.

### Wartung

- **Direkt in die Datenbank schauen:** `docker compose exec db mariadb -uschottr -p schottr`
- **MariaDB aktualisieren:** Image-Tag in `compose.yml` anpassen und `docker compose up -d` ausführen. `MARIADB_AUTO_UPGRADE` passt die Systemtabellen dabei automatisch an. Vorher ein Backup machen.
- **Logs:** `docker compose logs -f schottr`

### Ohne Docker

Voraussetzung ist eine laufende MariaDB mit leerer Datenbank (`utf8mb4`) und eigenem Benutzer:

```sql
CREATE DATABASE schottr CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
CREATE USER 'schottr'@'localhost' IDENTIFIED BY 'geheim';
GRANT ALL ON schottr.* TO 'schottr'@'localhost';
```

```bash
npm install
DB_PASSWORD=geheim npm start
```

### Konfiguration (Umgebungsvariablen)

| Variable | Standard | Bedeutung |
|---|---|---|
| `PORT` | `3000` | HTTP-Port |
| `DB_HOST` / `DB_PORT` | `127.0.0.1` / `3306` | MariaDB-Server |
| `DB_NAME` / `DB_USER` / `DB_PASSWORD` | `schottr` / `schottr` / – | Zugangsdaten. Sonderzeichen im Passwort sind erlaubt. |
| `DATABASE_URL` | – | Alternativ alles in einem: `mysql://user:pass@host:3306/db` |
| `SCHOTTR_ALLOW_REGISTRATION` | `false` | Offene Registrierung (Ersteinrichtung ist immer möglich) |
| `SCHOTTR_SECURE_COOKIES` | `auto` | `auto`, `true` oder `false` |
| `SCHOTTR_SESSION_DAYS` | `14` | Gültigkeit der Anmeldung (gleitend) |
| `SCHOTTR_TRUST_PROXY` | `true` | `X-Forwarded-For` für die Login-Bremse auswerten |

## Funktionen

- **Mandanten**: Ein Benutzer kann mehreren Firmen angehören und zwischen ihnen umschalten. Alle Daten sind strikt je Mandant getrennt. Es gibt die Rollen Inhaber und Mitglied.
- **Administration** (übergreifend, nur für Administratoren, Link unten in der Seitenleiste): Der erste registrierte Benutzer ist automatisch Administrator. Es gibt fünf Bereiche:
  - **Übersicht:** Kennzahlen, Mandanten ohne aktiven Inhaber und die letzten Ereignisse.
  - **Mandanten:** anlegen, umbenennen, Benutzer direkt zuordnen, Rollen ändern, sperren/entsperren. Löschen ist nur ohne Belege möglich, wegen der Aufbewahrungspflicht.
  - **Benutzer:** anlegen, bearbeiten, Admin-Recht vergeben, Passwort zurücksetzen, Sitzungen beenden, sperren, löschen. Es bleibt immer mindestens ein Administrator.
  - **Protokoll:** Anmeldungen (auch fehlgeschlagene), Festschreiben, Storno, Benutzer- und Admin-Aktionen mit IP.
  - **System:** Registrierung öffnen/schließen (überschreibt `SCHOTTR_ALLOW_REGISTRATION`), Versionen und Datenbankgröße.
- **Einladungen** (portalintern, ohne E-Mail): Der Inhaber lädt eine E-Mail-Adresse ein. Wer mit genau dieser Adresse angemeldet ist, sieht die Einladung in der Übersicht und kann sie annehmen oder ablehnen. Offene Einladungen lassen sich zurückziehen. Für Personen ohne Konto kann der Inhaber direkt ein Konto mit Startpasswort anlegen.
- **Adressen**: Ein minimaler Datensatz mit Kundennummer aus einem eigenen Nummernkreis, USt-IdNr. und Leitweg-ID. Auf der Detailseite stehen alle Angebote und Rechnungen der Adresse.
- **Artikelstamm** (optional): Artikel mit Nummer, Text, Einheit, Preis und Steuersatz. Im Positionseditor lassen sie sich suchen und einfügen; freie Positionen bleiben jederzeit möglich. Die Werte werden kopiert, spätere Artikeländerungen verändern bestehende Belege also nicht. Die Artikelnummer erscheint im PDF und in der E-Rechnung (BT-155).
- **Angebote**: Positionen mit Menge, Einheit (UN/ECE Rec. 20) sowie 19 % oder 7 %. Der Status ist Entwurf, Versendet, Angenommen, Abgelehnt oder Abgerechnet. Dazu kommen ein PDF und eine Duplizieren-Funktion.
- **Rechnungen**: Sie entstehen frei oder mit einem Klick aus einem Angebot.
  - **Entwurf**: frei änderbar, Vorschau-PDF mit Wasserzeichen.
  - **Festschreiben**: vergibt die fortlaufende Rechnungsnummer und friert alle Daten ein (Snapshot). Dabei werden das ZUGFeRD-PDF und die XRechnung-XML einmalig erzeugt und gespeichert.
  - **Bezahlt / offen**, **Überfällig** (automatisch), **Stornieren** (erzeugt eine Stornorechnung, Typ 381, mit Bezug auf das Original).
- **Mahnwesen**: Die Seite *Mahnwesen* listet überfällige Rechnungen und schlägt die nächste Stufe vor, sobald Fälligkeit bzw. Mahnfrist plus Kulanz abgelaufen sind. Es gibt drei Stufen: Zahlungserinnerung, 1. Mahnung und 2. (letzte) Mahnung. Gebühren, Frist und Kulanz stellst du in den Einstellungen ein und kannst sie je Mahnung anpassen. Das Mahn-PDF zeigt Rechnungsbetrag, Gebühren und offenen Gesamtbetrag. Mahngebühren werden ohne Umsatzsteuer ausgewiesen.
- **Rechnungsarten (BT-3)**: Rechnung (380), Teilrechnung (875), Teilschlussrechnung (876), Schlussrechnung (877) sowie die Stornorechnung (381), die über „Stornieren“ entsteht. Teilschluss- und Schlussrechnungen ziehen festgeschriebene Teilrechnungen desselben Kunden ab. Netto, Steuer und Brutto jeder abgezogenen Teilrechnung werden ausgewiesen (§ 14 Abs. 5 UStG), im XML als `TotalPrepaidAmount`, Rechnungsbezug (BG-3) und Hinweis. Jede Teilrechnung kann nur einmal abgezogen werden.
- **Skonto**: Prozent und Tage je Rechnung, mit Vorgabe in den Einstellungen. Im PDF steht ein Klartext mit Betrag und Frist, in der E-Rechnung das von XRechnung geforderte Format `#SKONTO#TAGE=10#PROZENT=2.00#` (BR-DE-18).
- **Logo**: PNG (auch transparent) oder JPEG unter Einstellungen hochladen. Es erscheint oben rechts auf Angeboten, Rechnungen und Mahnungen; die PDFs bleiben PDF/A-3-konform.
- **Export** (Menüpunkt *Export*, Zeitraum frei wählbar):
  - **DATEV-Buchungsstapel** (EXTF 700): je Rechnung und Steuersatz eine Buchung Debitor an Erlöskonto, Sammeldebitor oder Debitor je Kunde, SKR03/04. Erlöskonten lassen sich in den Einstellungen anpassen. Schlussrechnungen buchen die abgezogenen Teilrechnungen zurück, damit kein Umsatz doppelt erscheint.
  - **Rechnungsausgangsbuch** als CSV für Excel (Netto/USt je Steuersatz, Zahlbetrag, Status).
  - **ZIP** mit allen ZUGFeRD-PDFs und XRechnung-Dateien des Zeitraums plus Rechnungsausgangsbuch.
- **Steuerarten**: Regelbesteuerung, Kleinunternehmer (§ 19 UStG), Reverse Charge (§ 13b UStG) und steuerfrei mit Begründung. Die gesetzlich nötigen Hinweistexte kommen automatisch auf PDF und XML.

## Deutsche Vorgaben

| Vorgabe | Umsetzung |
|---|---|
| § 14 Abs. 4 UStG – Pflichtangaben | Vor dem Festschreiben wird geprüft: Anschriften, Steuernummer/USt-IdNr., Leistungsdatum oder -zeitraum, Steuer je Satz, Befreiungshinweis |
| Fortlaufende, einmalige Rechnungsnummer | Die Nummer wird erst beim Festschreiben vergeben, Entwürfe verbrauchen keine. Nummer, Daten und PDF entstehen in einer Transaktion; schlägt etwas fehl, wird auch die Nummer zurückgegeben. Der Nummernkreis ist pro Jahr oder Monat konfigurierbar. |
| GoBD – Unveränderbarkeit | MariaDB-Trigger verhindern Änderungen und Löschungen an festgeschriebenen Rechnungen und ihren Positionen. Korrekturen laufen nur über eine Stornorechnung. |
| E-Rechnung (Wachstumschancengesetz, EN 16931) | ZUGFeRD 2.x, Profil EN 16931 (PDF/A-3b), sowie XRechnung 3.0 (CII) |
| DIN 5008 | Anschriftfeld, Info-Block, Falz- und Lochmarken im PDF |
| Pflichtangaben Geschäftsbrief (GmbH) | Geschäftsführer, Registergericht und -nummer in der Fußzeile |

**Geprüft** wurde mit dem offiziellen KoSIT-Validator (XRechnung 3.0.2, Konfiguration 2026-08-31) und mit Mustang 2.26 (veraPDF für PDF/A-3b und ZUGFeRD-Schematron).
Mit `npm run sample` entstehen Beispielrechnungen für alle Steuerarten in `./samples`:

```bash
npm run sample
java -jar validator-1.6.3-standalone.jar -s xrechnung/scenarios.xml -r xrechnung samples/*.xml
java -jar Mustang-CLI-2.26.0.jar --action validate --source samples/standard.pdf
```

> Hinweis: Schottr ersetzt keine Steuerberatung.

## Aufbau & Erweiterung

```
src/
  server.ts            Einstieg
  app.ts               Middleware: Sitzung, CSRF, Mandant, Fehler
  db/                  MariaDB-Zugriff + Migrationen (inkl. GoBD-Trigger)
  lib/                 Geld/Steuer-Rechnung, Nummernkreise, Auth, Validierung, HTML
  einvoice/            Belegdaten (Snapshot), CII-XML (XRechnung/ZUGFeRD), PDF
  modules/             Funktionsmodule: auth, dashboard, contacts, documents, settings
  views/layout.ts      Seitenrahmen
public/                CSS, JS, Favicon
```

So kommt ein **neues Modul** dazu (z. B. Artikelstamm, Mahnwesen, Zeiterfassung):

1. `src/modules/<name>.ts` anlegen und ein `Module`-Objekt exportieren: `{ name, nav?, register(app) }`.
2. In `src/modules/index.ts` eintragen.
3. Eigene Tabellen als neue Migration in `src/db/migrations.ts` anhängen.

Mandant und Benutzer liegen in jeder Route über `tenantOf(c)` und `userOf(c)` bereit. Jede Abfrage filtert nach `tenant_id`.

## Entwicklung

```bash
npm run dev        # mit automatischem Neustart
npm test           # Unit-Tests (node:test)

# Ablauftests gegen eine eigene, leere Test-Datenbank – ACHTUNG: deren Tabellen werden gelöscht
TEST_DATABASE_URL=mysql://schottr:schottr@127.0.0.1:3306/schottr_test npm test
npm run typecheck  # tsc --noEmit
```

## Lizenzen der Abhängigkeiten

Alle Laufzeitabhängigkeiten stehen unter MIT, Apache-2.0 oder 0BSD (siehe `npm ls`). MariaDB selbst (GPL-2.0) läuft als eigener Server und wird nur über das Netzwerk angesprochen; für den kommerziellen Einsatz ist das unproblematisch.
Die Schrift IBM Plex Sans steht unter der SIL Open Font License 1.1 (`assets/fonts/OFL-IBM-Plex.txt`). Einbetten in PDFs und kommerzielle Nutzung sind erlaubt.
