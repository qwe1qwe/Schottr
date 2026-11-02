import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import fsSync from 'node:fs';
import path from 'node:path';
import { config } from '../config.ts';

/**
 * Dateiablage außerhalb der Datenbank:
 *   <data>/nachweise/<Mandant>/…           Nachweisdokumentationen
 *   <data>/verbindlichkeiten/<Mandant>/…   Eingangsrechnungen (PDF, XML, Scans) und Kassenbuch-Belege
 *   <data>/other/<Mandant>/…               Belegeingang: hochgeladen, aber noch nicht zugeordnet –
 *                                          beim Zuordnen wird die Datei in den passenden Bereich kopiert,
 *                                          das Original bleibt erhalten
 *
 * In der Datenbank steht nur der relative Pfad "<Mandant>/<Datei>" samt SHA-256.
 * Belege sind aufbewahrungspflichtig (§ 147 AO, GoBD): Dateien werden einmal atomar geschrieben,
 * danach schreibgeschützt und nie überschrieben, verschoben oder gelöscht. Einzige Ausnahme:
 * eine gerade geschriebene Datei, deren Datensatz gar nicht erst angelegt werden konnte
 * (discardUnreferenced) – sie war nie ein gespeicherter Beleg.
 */
export type FileArea = 'nachweise' | 'verbindlichkeiten' | 'other';
export const FILE_AREAS: FileArea[] = ['nachweise', 'verbindlichkeiten', 'other'];

export function areaRoot(area: FileArea): string {
  return path.resolve(config.dataDir, area);
}

/** Absoluter Pfad – wirft bei Versuchen, aus dem Bereich herauszukommen. */
function resolveIn(area: FileArea, rel: string): string {
  const root = areaRoot(area);
  const abs = path.resolve(root, rel);
  if (!abs.startsWith(root + path.sep)) throw new Error(`Ungültiger Dateipfad: ${rel}`);
  return abs;
}

export const sha256 = (data: Uint8Array) => crypto.createHash('sha256').update(data).digest('hex');

/** Dateiname ohne Pfad- und Steuerzeichen, Umlaute bleiben erhalten. */
export function safeFilename(name: string, fallback = 'datei'): string {
  const base = path.basename(name || '').replace(/[^\w.\-äöüÄÖÜß ]+/g, '_').replace(/\s+/g, ' ').trim();
  return (base || fallback).slice(-120);
}

export interface StoredFile {
  /** relativ zum Bereich: "<Mandant>/<Datei>" */
  path: string;
  sha256: string;
  size: number;
}

export async function saveFile(area: FileArea, tenantId: number, originalName: string, data: Uint8Array): Promise<StoredFile> {
  const stamp = new Date().toISOString().replace(/\D/g, '').slice(0, 14);
  const rel = `${tenantId}/${stamp}_${crypto.randomBytes(4).toString('hex')}_${safeFilename(originalName)}`;
  const abs = resolveIn(area, rel);
  await fs.mkdir(path.dirname(abs), { recursive: true });
  const tmp = `${abs}.part`;
  await fs.writeFile(tmp, data, { flag: 'wx', mode: 0o444 });
  // nie eine vorhandene Datei ersetzen
  if (fsSync.existsSync(abs)) {
    await fs.rm(tmp, { force: true });
    throw new Error(`Datei existiert bereits: ${rel}`);
  }
  await fs.rename(tmp, abs);
  await fs.chmod(abs, 0o444).catch(() => {});
  return { path: rel, sha256: sha256(data), size: data.length };
}

/** Datei in einen anderen Bereich kopieren (neu schreiben, Prüfsumme kontrollieren) – das Original bleibt */
export async function copyStoredFile(from: FileArea, rel: string, to: FileArea, tenantId: number, name: string): Promise<StoredFile> {
  const data = await readStoredFile(from, rel);
  const stored = await saveFile(to, tenantId, name, data);
  if (sha256(await readStoredFile(to, stored.path)) !== sha256(data)) {
    await discardUnreferenced(to, stored.path);
    throw new Error(`Kopieren von ${rel} fehlgeschlagen (Prüfsumme)`);
  }
  return stored;
}

export async function readStoredFile(area: FileArea, rel: string): Promise<Buffer> {
  return fs.readFile(resolveIn(area, rel));
}

/**
 * Nur für eine gerade mit saveFile geschriebene Datei, deren Datensatz nicht angelegt werden
 * konnte (Fehler/Rollback). Gespeicherte Belege werden nie gelöscht – dafür sorgen auch die
 * Datenbank-Trigger, die das Löschen der Datensätze verhindern.
 */
export async function discardUnreferenced(area: FileArea, rel: string): Promise<void> {
  if (!rel) return;
  await fs.rm(resolveIn(area, rel), { force: true });
}

/* ---------- Prüfung beim Start ---------- */

/**
 * Beim Start: alle gespeicherten Belege schreibgeschützt setzen (auch solche aus älteren
 * Versionen, die noch beschreibbar abgelegt wurden). Liefert die Anzahl geänderter Dateien.
 */
export async function protectStoredFiles(): Promise<number> {
  let n = 0;
  const walk = async (dir: string) => {
    let entries: fsSync.Dirent[];
    try {
      entries = await fs.readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      const abs = path.join(dir, e.name);
      if (e.isDirectory()) await walk(abs);
      else if (e.isFile() && !e.name.endsWith('.part') && !e.name.startsWith('.schreibtest')) {
        const st = await fs.stat(abs);
        if (st.mode & 0o222) {
          await fs.chmod(abs, 0o444).catch(() => {});
          n++;
        }
      }
    }
  };
  for (const area of FILE_AREAS) await walk(areaRoot(area));
  return n;
}


/** Liegt das Verzeichnis (oder ein übergeordnetes, außer "/") auf einem eigenen Mount (Docker-Volume)? */
function isOnMount(dir: string): boolean {
  let mounts: string[];
  try {
    mounts = fsSync.readFileSync('/proc/self/mountinfo', 'utf8').split('\n').map((l) => l.split(' ')[4]).filter(Boolean)
      // Leerzeichen u. Ä. sind in mountinfo oktal kodiert
      .map((m) => m.replace(/\\(\d{3})/g, (_, o: string) => String.fromCharCode(parseInt(o, 8))));
  } catch {
    return true; // kein Linux-/proc – nicht prüfbar
  }
  const set = new Set(mounts);
  for (let d = dir; d !== path.dirname(d); d = path.dirname(d)) if (set.has(d)) return true;
  return false;
}

/**
 * Ordner anlegen und Schreibrechte prüfen. Im Docker-Container muss die Ablage als Volume
 * eingebunden sein – sonst wären alle hochgeladenen Dateien beim nächsten Update weg.
 */
export async function checkStorage(): Promise<void> {
  for (const area of FILE_AREAS) {
    const dir = areaRoot(area);
    try {
      await fs.mkdir(dir, { recursive: true });
      const probe = path.join(dir, `.schreibtest-${process.pid}`);
      await fs.writeFile(probe, 'ok');
      await fs.rm(probe, { force: true });
    } catch (err) {
      throw new Error(`Dateiablage ${dir} ist nicht beschreibbar (${(err as Error).message}).`);
    }
    if (config.inDocker && !config.allowEphemeralFiles && !isOnMount(dir)) {
      throw new Error(
        `Die Dateiablage ${dir} ist kein Volume. Hochgeladene Dateien gingen beim nächsten Update verloren.\n`
        + `Bitte in compose.yml beim Dienst "schottr" ergänzen:\n`
        + `    volumes:\n      - ./data/nachweise:/app/data/nachweise\n      - ./data/verbindlichkeiten:/app/data/verbindlichkeiten\n      - ./data/other:/app/data/other\n`
        + `(Nur zum Ausprobieren lässt sich die Prüfung mit SCHOTTR_ALLOW_EPHEMERAL_FILES=true abschalten.)`,
      );
    }
  }
}
