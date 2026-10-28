# Schottr

Schlanke Angebots- und Rechnungssoftware für deutsche Unternehmen.
Mit Login, Mandanten, Adressen, Angeboten und Rechnungen als **ZUGFeRD** (PDF/A-3 mit eingebetteter XML) und **XRechnung 3.0** – sowie Eingangsrechnungen: E-Rechnungen werden automatisch gelesen, PDFs und Scans mit Vorschau erfasst.

- **Node.js ≥ 22.18** (empfohlen: 24 LTS). TypeScript läuft direkt über Nodes Type Stripping, es gibt keinen Build-Schritt.
- **MariaDB** (≥ 10.11, im Docker-Setup 11.4 LTS) über den Treiber `mysql2`
- **Wenige Abhängigkeiten**, alle kommerziell nutzbar: Hono (MIT), mysql2 (MIT), PDFKit (MIT), pdf-lib (MIT), Zod (MIT), fast-xml-parser (MIT), IBM Plex Sans (OFL)
- Serverseitig gerenderte Oberfläche ohne Frontend-Framework. Das kleine `public/app.js` dient nur dem Positionseditor.

## Schnellstart mit Docker (empfohlen)

```bash
cp .env.example .env      # Passwörter in .env setzen
docker compose up -d --build
```

Danach läuft Schottr auf http://localhost:3000. Compose startet zwei Container:

- `schottr-db` mit **MariaDB 11.4**. Die Daten liegen in `./data/mariadb`.
- `schottr` mit der App. Sie startet erst, wenn die Datenbank bereit ist, und legt die Tabellen beim ersten Start selbst an.

Dateien (Nachweise, Eingangsrechnungen) liegen nicht in der Datenbank, sondern je Mandant unter `./data/nachweise/<Mandant-ID>/` und `./data/verbindlichkeiten/<Mandant-ID>/`. Beide Ordner sind in `compose.yml` als Volumes eingebunden. Fehlen die Volumes, startet der Container mit einem Hinweis nicht – sonst gingen hochgeladene Dateien beim nächsten Update verloren. Nachweise aus älteren Versionen werden beim ersten Start automatisch aus der Datenbank in die Dateiablage verschoben.

> **Update von 0.6:** In der `compose.yml` auf dem Server beim Dienst `schottr` die beiden Volumes ergänzen (siehe `deploy/compose.yml`), danach `docker compose pull && docker compose up -d`.

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
./scripts/backup.sh       # legt backup/schottr-JJJJ-MM-TT_HHMM.sql.gz und schottr-dateien-….tar.gz an
```

Für eine tägliche Sicherung per cron: `0 2 * * *  cd /pfad/zu/schottr && ./scripts/backup.sh`

So stellst du eine Sicherung wieder her:

```bash
gunzip -c backup/DATEI.sql.gz | docker compose exec -T db sh -c 'mariadb -uroot -p"$MARIADB_ROOT_PASSWORD" schottr'
tar -xzf backup/schottr-dateien-DATUM.tar.gz -C data
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
| `SCHOTTR_DATA_DIR` | `./data` (Docker: `/app/data`) | Dateiablage für Nachweise und Eingangsrechnungen |
| `SCHOTTR_ALLOW_EPHEMERAL_FILES` | `false` | Nur zum Testen: im Container ohne Volume starten |

## Funktionen

- **Übersicht**: Offene und überfällige Rechnungen, offene Verbindlichkeiten, offene Angebote und der Netto-Umsatz eines wählbaren Jahres (Stornos zählen negativ, abgezogene Teilrechnungen nicht doppelt). Ein Säulendiagramm zeigt die festgeschriebenen Rechnungen der letzten 24 Monate; Überfahren (am Handy: einmal Antippen) zeigt Betrag und Anzahl, ein Klick öffnet die Rechnungsliste gefiltert auf diesen Monat. Ein Ringdiagramm zeigt die fünf umsatzstärksten Kunden der letzten 24 Monate plus „Sonstige“ (Klick führt zur Adresse). Bei aktiver Kleinunternehmerregelung zeigt eine Kachel den Umsatz des laufenden Jahres als Balken bis zur Höchstgrenze von 100.000 € mit einer Marke bei 25.000 € (Grenze für das Folgejahr, § 19 UStG). Ab 20.000 € wird gewarnt, über 25.000 € wird der Teil jenseits der Marke abgesetzt eingefärbt; dazu kommt der Stand des Vorjahres.
  Ein zweites Diagramm stellt für das gewählte Jahr Umsatz und Ausgaben je Monat gegenüber, mit Ergebnislinie und Jahresergebnis (vor Steuern und sonstigen Abzügen; Kleinunternehmer: Ausgaben brutto). Eine umschaltbare Kachel zeigt die Top-Lieferanten nach Kosten oder die größten offenen Verbindlichkeiten.
- **Am Handy**: Die Navigation sitzt hinter einem Menü-Button und öffnet sich als Vollbild-Liste. Tabellen (Belege, Adressen, Administration, Protokoll …) werden in der schmalen Ansicht zu Karten mit beschrifteten Feldern, der Positionseditor zu untereinander stehenden Eingaben.
- **Mandanten**: Ein Benutzer kann mehreren Firmen angehören und zwischen ihnen umschalten. Alle Daten sind strikt je Mandant getrennt. Es gibt die Rollen Inhaber und Mitglied.
- **Administration** (übergreifend, nur für Administratoren, Link unten in der Seitenleiste): Der erste registrierte Benutzer ist automatisch Administrator. Es gibt fünf Bereiche:
  - **Übersicht:** Kennzahlen, Mandanten ohne aktiven Inhaber und die letzten Ereignisse.
  - **Mandanten:** anlegen, umbenennen, Benutzer direkt zuordnen, Rollen ändern, sperren/entsperren. Löschen ist nur ohne Belege möglich, wegen der Aufbewahrungspflicht.
  - **Benutzer:** anlegen, bearbeiten, Admin-Recht vergeben, Passwort zurücksetzen, Sitzungen beenden, sperren, löschen. Es bleibt immer mindestens ein Administrator.
  - **Protokoll:** Anmeldungen (auch fehlgeschlagene), Festschreiben, Storno, Benutzer- und Admin-Aktionen mit IP.
  - **System:** Registrierung öffnen/schließen (überschreibt `SCHOTTR_ALLOW_REGISTRATION`), Versionen und Datenbankgröße.
- **Einladungen** (portalintern, ohne E-Mail): Der Inhaber lädt eine E-Mail-Adresse ein. Wer mit genau dieser Adresse angemeldet ist, sieht die Einladung in der Übersicht und kann sie annehmen oder ablehnen. Offene Einladungen lassen sich zurückziehen. Für Personen ohne Konto kann der Inhaber direkt ein Konto mit Startpasswort anlegen.
- **Adressen**: Ein minimaler Datensatz mit Art (Kunde, Lieferant oder beides), Nummer aus eigenem Nummernkreis (Kunden `K…`, Lieferanten `L…`), USt-IdNr. und Leitweg-ID. Die Liste lässt sich nach Art filtern; bei Angeboten und Rechnungen stehen nur Kunden zur Auswahl, bei Eingangsrechnungen nur Lieferanten. Auf der Detailseite stehen alle Belege der Adresse.
- **Eingangsrechnungen** (Menüpunkt *Eingangsrechnungen*): Belege per Drag & Drop hochladen, auch mehrere auf einmal.
  - **E-Rechnungen** (XRechnung in CII oder UBL, ZUGFeRD/Factur-X-PDF mit eingebetteter XML) werden vollständig übernommen: Lieferant (per USt-IdNr., Steuernummer oder Name wiedererkannt, sonst neu angelegt), Nummer, Datum, Fälligkeit, Beträge je Steuersatz, Bankverbindung und Positionen. Unstimmigkeiten (Summen, fehlende Steuernummer, fremder Rechnungsempfänger, ZUGFeRD MINIMUM/BASIC WL) werden als Hinweis gezeigt. Diese Angaben sind danach gesperrt; Kostenart, Fälligkeit und Zahlung bleiben änderbar.
  - **PDFs und Scans** (JPG, PNG) landen als „zu erfassen“ und werden mit Vorschau daneben erfasst: Lieferant (oder neuen Namen eintippen), Nummer, Datum, Kostenart und je Steuersatz Netto oder Brutto – der Rest wird berechnet.
  - Ohne Beleg erfassen geht auch. Status offen, überfällig, bezahlt; Dubletten (gleiche Datei, gleiche Nummer beim Lieferanten) werden abgewiesen. Die Kostenart merkt sich Schottr je Lieferant.
- **Artikelstamm** (optional): Artikel mit Nummer, Text, Einheit, Preis und Steuersatz. Im Positionseditor lassen sie sich suchen und einfügen; freie Positionen bleiben jederzeit möglich. Die Werte werden kopiert, spätere Artikeländerungen verändern bestehende Belege also nicht. Die Artikelnummer erscheint im PDF und in der E-Rechnung (BT-155).
- **Angebote**: Positionen mit Menge, Einheit (UN/ECE Rec. 20) sowie 19 % oder 7 %. Der Status ist Entwurf, Versendet, Angenommen, Abgelehnt oder Abgerechnet. Dazu kommen ein PDF und eine Duplizieren-Funktion.
- **Rechnungen**: Sie entstehen frei oder mit einem Klick aus einem Angebot.
  - **Entwurf**: frei änderbar, Vorschau-PDF mit Wasserzeichen.
  - **Festschreiben**: vergibt die fortlaufende Rechnungsnummer und friert alle Daten ein (Snapshot). Dabei werden das ZUGFeRD-PDF und die XRechnung-XML einmalig erzeugt und gespeichert.
  - **Nachträglich bearbeiten** (Ausnahmefall): Nach einer Warnung musst du einen Änderungsgrund angeben und einen zufälligen 6-stelligen Code abtippen. Der Code lässt sich weder markieren noch einfügen. Die bisherige Fassung (PDF, XRechnung, Daten) wird dann unveränderlich als Version archiviert und ins Protokoll geschrieben. Die Rechnung wird wieder zum Entwurf mit derselben Nummer und muss danach erneut festgeschrieben werden. Frühere Fassungen bleiben an der Rechnung abrufbar. Nicht möglich bei Storno- und stornierten Rechnungen sowie bei Teilrechnungen, die bereits abgezogen wurden.
  - **Bezahlt / offen**, **Überfällig** (automatisch), **Stornieren** (erzeugt eine Stornorechnung, Typ 381, mit Bezug auf das Original).
- **Mahnwesen**: Die Seite *Mahnwesen* listet überfällige Rechnungen und schlägt die nächste Stufe vor, sobald Fälligkeit bzw. Mahnfrist plus Kulanz abgelaufen sind. Es gibt drei Stufen: Zahlungserinnerung, 1. Mahnung und 2. (letzte) Mahnung. Gebühren, Frist und Kulanz stellst du in den Einstellungen ein und kannst sie je Mahnung anpassen. Das Mahn-PDF zeigt Rechnungsbetrag, Gebühren und offenen Gesamtbetrag. Mahngebühren werden ohne Umsatzsteuer ausgewiesen.
- **Rechnungsarten (BT-3)**: Rechnung (380), Teilrechnung (875), Teilschlussrechnung (876), Schlussrechnung (877) sowie die Stornorechnung (381), die über „Stornieren“ entsteht. Teilschluss- und Schlussrechnungen ziehen festgeschriebene Teilrechnungen desselben Kunden ab. Netto, Steuer und Brutto jeder abgezogenen Teilrechnung werden ausgewiesen (§ 14 Abs. 5 UStG), im XML als `TotalPrepaidAmount`, Rechnungsbezug (BG-3) und Hinweis. Jede Teilrechnung kann nur einmal abgezogen werden.
- **Skonto**: Prozent und Tage je Rechnung, mit Vorgabe in den Einstellungen. Im PDF steht ein Klartext mit Betrag und Frist, in der E-Rechnung das von XRechnung geforderte Format `#SKONTO#TAGE=10#PROZENT=2.00#` (BR-DE-18).
- **Nachweise** (Menüpunkt *Nachweise*): Nachweisdokumentationen wie Aufmaß, Stundenzettel oder Abnahmeprotokoll zentral als PDF hochladen, benennen, umbenennen und archivieren. Beim Schreiben einer Rechnung wählst du aus, welche angehängt werden:
  - **im PDF:** Die Seiten werden hinten an das ZUGFeRD-PDF angehängt, die Rechnung nennt sie unter „Anlagen“.
  - **in der XRechnung:** Sie gehen als rechnungsbegründende Unterlagen (BG-24, Typ 916) mit eingebetteter PDF mit.
  - **Hinweis:** PDFs mit nicht eingebetteten Schriften werden beim Hochladen als „nicht PDF/A“ markiert; mit ihnen ist das Rechnungs-PDF nicht mehr streng PDF/A-3. Verwendete Nachweise lassen sich nur archivieren, nicht löschen.
- **Logo**: PNG (auch transparent) oder JPEG unter Einstellungen hochladen. Es erscheint oben rechts auf Angeboten, Rechnungen und Mahnungen; die PDFs bleiben PDF/A-3-konform.
- **Export** (Menüpunkt *Export*, Zeitraum frei wählbar):
  - **DATEV-Buchungsstapel** (EXTF 700), wahlweise mit Ausgangs- und/oder Eingangsrechnungen:
    - Ausgang: je Rechnung und Steuersatz Debitor an Erlöskonto, Sammeldebitor oder Debitor je Kunde, SKR03/04. Schlussrechnungen buchen die abgezogenen Teilrechnungen zurück.
    - Eingang: je Rechnung und Steuersatz Kreditor an Aufwandskonto der Kostenart, Vorsteuer über BU-Schlüssel 9 (19 %) bzw. 8 (7 %); Sammelkreditor oder Kreditor je Lieferant. Kleinunternehmer buchen brutto ohne Vorsteuer. Erlös- und Aufwandskonten lassen sich in den Einstellungen anpassen – am besten mit der Kanzlei abstimmen.
  - **Rechnungsausgangsbuch** und **Rechnungseingangsbuch** als CSV für Excel (Netto/USt je Steuersatz, Konten, Status).
  - **ZIP** mit `Ausgangsrechnungen/` (ZUGFeRD-PDFs, XRechnungen), `Eingangsrechnungen/` (Original-Belege) und beiden Büchern.
- **Vereine und Gemeinnützigkeit**: Unter *Einstellungen → Organisation* (oder schon beim Anlegen des Mandanten) wählst du als Art „Verein (e. V. oder nicht eingetragen)“. Nur dann erscheint das Häkchen „Gemeinnützig – steuerbegünstigt nach §§ 51 ff. AO“ – ein eigener Status wie die Kleinunternehmerregelung, der sich jederzeit an- und abschalten lässt, ohne dass sich die Art ändert. Wechselt die Art auf „Unternehmen“, entfällt die Gemeinnützigkeit. Für Vereine heißen die Felder passend (Name des Vereins, Vorstand nach § 26 BGB, Vereinsregister); auf PDF und E-Rechnung steht „Vorstand“ statt „Geschäftsführer“.
  - Gemeinnützige Mandanten ordnen jedes Angebot und jede Rechnung einem Bereich zu: wirtschaftlicher Geschäftsbetrieb, Zweckbetrieb, sportliche Veranstaltungen (§ 67a AO), Vermögensverwaltung oder ideeller Bereich. Die Vorgabe stellst du in den Einstellungen ein. Die Zuordnung ist intern, steht nicht auf dem Beleg und lässt sich auch nach dem Festschreiben noch ändern (protokolliert).
  - Eine Kachel in der Übersicht zeigt für das laufende Jahr die Einnahmen (brutto, wie es die Abgabenordnung verlangt) gegen die Grenzen: 50.000 € für alle wirtschaftlichen Geschäftsbetriebe zusammen (§ 64 Abs. 3 AO), 50.000 € für sportliche Veranstaltungen als Zweckbetrieb (§ 67a AO; darüber zählen sie zum wirtschaftlichen Geschäftsbetrieb) und 100.000 € Gesamteinnahmen für die zeitnahe Mittelverwendung (§ 55 Abs. 1 Nr. 5 AO). Das sind die Werte seit 2026 (Steueränderungsgesetz 2025); für frühere Jahre gelten 45.000 €. Ab 80 % wird gewarnt. Dazu kommen die Aufteilung nach Bereichen (Klick öffnet die gefilterte Rechnungsliste) und der Vorjahreswert.
  - Ist der Verein zusätzlich Kleinunternehmer, zählt der ideelle Bereich nicht zur Kleinunternehmergrenze.
- **Spenden und Zuwendungsbestätigungen** (Menüpunkt *Spenden*, nur bei gemeinnützigen Mandanten): Geldspenden, Mitgliedsbeiträge und Sachspenden mit Datum, Betrag bzw. Wert und Zuwendendem (eine beliebige Adresse) erfassen, bei Bedarf als Aufwandsspende (Verzicht auf Erstattung von Aufwendungen).
  - Zuwendungsbestätigungen nach amtlichem Muster (§ 50 Abs. 1 EStDV, BMF-Schreiben vom 7.11.2013) als PDF: Einzelbestätigung über eine Geldzuwendung oder einen Mitgliedsbeitrag, Bestätigung über eine Sachzuwendung (mit Bezeichnung, Herkunft aus Betriebs- oder Privatvermögen und Wertermittlung) sowie die Sammelbestätigung mit Anlage. Der Betrag steht in Ziffern und in Buchstaben, dazu die Hinweise zur Haftung und zur Gültigkeit des Bescheids.
  - Am Jahresende erzeugt ein Klick je Zuwendendem eine Sammelbestätigung über alle noch unbestätigten Geldzuwendungen des Jahres (bei nur einer Zuwendung eine Einzelbestätigung).
  - Die nötigen Angaben (begünstigte Zwecke, Finanzamt, Datum und Art des Bescheids – Freistellungsbescheid oder Feststellung nach § 60a AO –, letzter Veranlagungszeitraum, Unterzeichner, Nummernkreis `ZB-{YYYY}-{NNNN}`) stehen unter *Einstellungen → Zuwendungsbestätigungen*. Ist der Bescheid älter als 5 Jahre (bzw. 3 Jahre bei § 60a AO, § 63 Abs. 5 AO), stellt Schottr keine Bestätigung aus und warnt ein halbes Jahr vorher.
  - Sind Mitgliedsbeiträge nicht abziehbar (z. B. Sportvereine, § 10b Abs. 1 Satz 8 EStG), werden Beiträge nur erfasst, aber nicht bestätigt, und auf den Bestätigungen steht der entsprechende Satz aus dem Muster.
  - Ausgestellte Bestätigungen bekommen eine fortlaufende Nummer und bleiben als Doppel (§ 50 Abs. 7 EStDV) unveränderlich in der Datenbank – auch per Datenbank-Trigger. Bestätigte Zuwendungen sind gesperrt. Eine fehlerhafte Bestätigung wird storniert (mit Grund); danach lassen sich die Zuwendungen korrigieren und neu bestätigen.
  - Spenden und Beiträge zählen in der Gemeinnützigkeits-Kachel zu den Einnahmen für die zeitnahe Mittelverwendung.
- **Kassenbuch** (Menüpunkt *Kassenbuch*, für Vereine): Bankkonten und Bargeldkassen mit Eröffnungsdatum und Anfangsbestand.
  - Jede Zahlung wird einem Konto zugeordnet: Rechnungen beim Markieren als bezahlt (mit tatsächlichem Betrag, z. B. nach Skonto), Eingangsrechnungen ebenso, Spenden und Beiträge schon beim Erfassen („Eingegangen auf“). Was bezahlt, aber noch keinem Konto zugeordnet ist, sammelt die Liste „Noch nicht zugeordnet“ – ein Klick übernimmt es. Wird eine Rechnung wieder auf „offen“ gesetzt, verschwindet die Buchung.
  - Dazu kommen freie Buchungen (Einnahme/Ausgabe mit Text, Beleg-Nr., Bereich und enthaltener Umsatzsteuer) und Umbuchungen zwischen Konten (z. B. Bareinzahlung).
  - **Kassenzählung**: Bestand nach Stückelung zählen; die Differenz zum Buchbestand am Zähltag wird gebucht – z. B. als Getränkeverkauf ohne Einzelbelege (mit Bereich und USt.-Satz) oder als Fehlbetrag. Die Zählprotokolle bleiben erhalten, nur die letzte Zählung lässt sich löschen.
  - Aktuelle Kontostände stehen in der Übersicht und im Kassenbuch, dazu der Verlauf als Diagramm: Überfahren mit der Maus (am Handy: Antippen) zeigt für jeden Tag den Stand und die Bewegungen. Die Buchungsliste zeigt je Konto (oder alle zusammen) Einnahmen, Ausgaben und den laufenden Saldo. Steht eine Bargeldkasse im Minus, wird gewarnt.
  - **Abschluss**: Der Inhaber schließt das Kassenbuch bis zu einem Datum ab (z. B. 31.12.); danach sind Buchungen und Zählungen bis dahin gesperrt – auch per Datenbank-Trigger.
  - Eingangsrechnungen bekommen bei gemeinnützigen Vereinen ebenfalls einen Bereich, damit Einnahmen und Ausgaben je Bereich auswertbar sind.
  - Vereine haben bei Eingangsrechnungen zusätzliche Kostenarten (oben in der Auswahl): Sport-/Übungsbetrieb (Geräte, Ausrüstung, Noten), Trainer und Übungsleiter, Hallen- und Platzmiete, Wettkampf und Spielbetrieb, Verbandsbeiträge/GEMA, Getränke und Speisen zum Verkauf, Veranstaltungen, Vereinsheim, Jugendarbeit sowie Ehrungen und Geschenke – jeweils mit Aufwandskonto für SKR03/04.
- **Jahrespaket fürs Steuerbüro** (*Export*, für Vereine): eine ZIP-Datei je Jahr mit Übersicht als PDF (Kontenstände, Einnahmen und Ausgaben nach Bereichen nach Zahlungsdatum, Zuwendungen, Hinweise auf Lücken wie nicht zugeordnete Zahlungen oder offene Rechnungen), Kassenbuch je Konto als PDF und CSV, Kassenzählungen, Ausgangsrechnungen (PDF, XRechnung, Rechnungsausgangsbuch), Eingangsrechnungen (Belege, Rechnungseingangsbuch), Zuwendungsliste und Doppel der Zuwendungsbestätigungen sowie Einnahmen/Ausgaben nach Bereichen als CSV.
- **Steuerarten**: Regelbesteuerung, Kleinunternehmer (§ 19 UStG), Reverse Charge (§ 13b UStG) und steuerfrei mit Begründung. Die gesetzlich nötigen Hinweistexte kommen automatisch auf PDF und XML.

## Deutsche Vorgaben

| Vorgabe | Umsetzung |
|---|---|
| § 14 Abs. 4 UStG – Pflichtangaben | Vor dem Festschreiben wird geprüft: Anschriften, Steuernummer/USt-IdNr., Leistungsdatum oder -zeitraum, Steuer je Satz, Befreiungshinweis |
| Fortlaufende, einmalige Rechnungsnummer | Die Nummer wird erst beim Festschreiben vergeben, Entwürfe verbrauchen keine. Nummer, Daten und PDF entstehen in einer Transaktion; schlägt etwas fehl, wird auch die Nummer zurückgegeben. Der Nummernkreis ist pro Jahr oder Monat konfigurierbar. |
| GoBD – Unveränderbarkeit | Nachträgliche Bearbeitung nur mit Pflicht-Grund, archivierter Vorfassung und Protokolleintrag. Ansonsten verhindern MariaDB-Trigger Änderungen und Löschungen an festgeschriebenen Rechnungen und ihren Positionen. Korrekturen laufen nur über eine Stornorechnung. |
| E-Rechnung (Wachstumschancengesetz, EN 16931) | ZUGFeRD 2.x, Profil EN 16931 (PDF/A-3b), sowie XRechnung 3.0 (CII) |
| DIN 5008 | Anschriftfeld, Info-Block, Falz- und Lochmarken im PDF |
| Pflichtangaben Geschäftsbrief (GmbH) | Geschäftsführer, Registergericht und -nummer in der Fußzeile |

Der Import von E-Rechnungen wurde mit allen Fällen der offiziellen [KoSIT-Testsuite](https://github.com/itplr-kosit/xrechnung-testsuite) (CII und UBL) geprüft.

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
  einvoice/            Belegdaten (Snapshot), CII-XML (XRechnung/ZUGFeRD), PDF, Import (parse.ts)
  modules/             Funktionsmodule: auth, dashboard, contacts, documents, purchases, settings …
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
