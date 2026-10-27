import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import fsSync from 'node:fs';
import path from 'node:path';
import { config } from '../config.ts';

/**
 * Dateiablage außerhalb der Datenbank:
 *   <data>/nachweise/<Mandant>/…           Nachweisdokumentationen
 *   <data>/verbindlichkeiten/<Mandant>/…   Eingangsrechnungen (PDF, XML, Scans)
 *
 * In der Datenbank steht nur der relative Pfad "<Mandant>/<Datei>" samt SHA-256.
 * Dateien werden nie überschrieben (neuer Name je Upload) und atomar geschrieben.
 */
export type FileArea = 'nachweise' | 'verbindlichkeiten';
export const FILE_AREAS: FileArea[] = ['nachweise', 'verbindlichkeiten'];

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
  await fs.writeFile(tmp, data, { flag: 'wx' });
  await fs.rename(tmp, abs);
  return { path: rel, sha256: sha256(data), size: data.length };
}

export async function readStoredFile(area: FileArea, rel: string): Promise<Buffer> {
  return fs.readFile(resolveIn(area, rel));
}

export async function removeStoredFile(area: FileArea, rel: string): Promise<void> {
  if (!rel) return;
  await fs.rm(resolveIn(area, rel), { force: true });
}

/* ---------- Prüfung beim Start ---------- */

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
        + `    volumes:\n      - ./data/nachweise:/app/data/nachweise\n      - ./data/verbindlichkeiten:/app/data/verbindlichkeiten\n`
        + `(Nur zum Ausprobieren lässt sich die Prüfung mit SCHOTTR_ALLOW_EPHEMERAL_FILES=true abschalten.)`,
      );
    }
  }
}
