import { all, one, run, nowIso } from '../../db/index.ts';
import { readStoredFile, saveFile } from '../../lib/files.ts';
import { UserError } from '../../lib/http.ts';
import type { Tenant } from '../../types.ts';

/**
 * Belege zu Kassenbuch-Buchungen: PDFs oder Fotos (z. B. eine Quittung, mit dem Handy
 * fotografiert). Die Dateien liegen in der Belegablage neben den Eingangsrechnungen
 * (data/verbindlichkeiten/<Mandant>/…, Name beginnt mit „kasse_“) – so braucht es kein
 * zusätzliches Docker-Volume. In der Datenbank stehen Verweis, Typ und Prüfsumme.
 * Belege sind aufbewahrungspflichtig: Sie lassen sich nicht löschen oder austauschen, nur
 * archivieren (z. B. versehentlich angehängtes Foto) – auch die Datenbank verhindert das Löschen.
 */
export const MAX_ENTRY_FILE = 10 * 1024 * 1024;
const AREA = 'verbindlichkeiten' as const;

export interface EntryFile {
  id: number;
  entry_id: number;
  file_name: string;
  file_path: string;
  file_mime: string;
  file_size: number;
  created_at: string;
  archived_at: string | null;
}

/** Dateityp anhand des Inhalts – nur PDF, JPEG und PNG */
export function mimeOf(data: Uint8Array): string | null {
  const b = Buffer.from(data.subarray(0, 1024));
  if (b.toString('latin1').includes('%PDF-')) return 'application/pdf';
  if (b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return 'image/jpeg';
  if (b.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return 'image/png';
  return null;
}

/** Hochgeladene Dateien aus einem Formular (Feld „files[]“, auch mehrfach) */
export function filesFrom(body: Record<string, unknown>): File[] {
  const raw = body['files[]'] ?? body.files;
  return (Array.isArray(raw) ? raw : [raw]).filter((f): f is File => f instanceof File && f.size > 0);
}

/** Dateien prüfen und an eine Buchung hängen; liefert die Anzahl */
export async function attachFiles(t: Tenant, entryId: number, files: File[], userId: number): Promise<number> {
  const prepared: { name: string; data: Uint8Array; mime: string }[] = [];
  for (const f of files) {
    if (f.size > MAX_ENTRY_FILE) throw new UserError(`„${f.name}“ ist größer als 10 MB.`);
    const data = new Uint8Array(await f.arrayBuffer());
    const mime = mimeOf(data);
    if (!mime) throw new UserError(`„${f.name}“: bitte ein PDF oder ein Foto (JPEG/PNG) hochladen. HEIC-Fotos vom iPhone vorher als JPEG speichern – beim Fotografieren direkt im Browser passiert das automatisch.`);
    const ext = mime === 'application/pdf' ? '.pdf' : mime === 'image/png' ? '.png' : '.jpg';
    const base = (f.name || 'beleg').replace(/\.(pdf|jpe?g|png|heic)$/i, '');
    prepared.push({ name: `${base}${ext}`.slice(-120), data, mime });
  }
  for (const p of prepared) await attachData(t, entryId, p, userId);
  return prepared.length;
}

/** Eine bereits geprüfte Datei (z. B. aus dem Belegeingang) an eine Buchung hängen */
export async function attachData(t: Tenant, entryId: number, p: { name: string; data: Uint8Array; mime: string }, userId: number) {
  const stored = await saveFile(AREA, t.id, `kasse_${p.name}`, p.data);
  await run(
    `INSERT INTO cash_entry_files (tenant_id, entry_id, file_name, file_path, file_mime, file_size, file_sha256, created_by, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    t.id, entryId, p.name, stored.path, p.mime, stored.size, stored.sha256, userId, nowIso(),
  );
}

export async function filesOf(entryId: number): Promise<EntryFile[]> {
  return all<EntryFile>('SELECT * FROM cash_entry_files WHERE entry_id = ? ORDER BY id', entryId);
}

/** Anzahl Belege je Buchung (für die Büroklammer in der Liste) */
export async function fileCounts(entryIds: number[]): Promise<Map<number, number>> {
  if (!entryIds.length) return new Map();
  const rows = await all<{ entry_id: number; n: number }>(
    `SELECT entry_id, COUNT(*) n FROM cash_entry_files WHERE archived_at IS NULL AND entry_id IN (${entryIds.map(() => '?').join(',')}) GROUP BY entry_id`,
    ...entryIds,
  );
  return new Map(rows.map((r) => [r.entry_id, Number(r.n)]));
}

export async function getFile(tenantId: number, id: number) {
  return one<EntryFile & { tenant_id: number }>('SELECT * FROM cash_entry_files WHERE tenant_id = ? AND id = ?', tenantId, id);
}

export const readEntryFile = (f: Pick<EntryFile, 'file_path'>) => readStoredFile(AREA, f.file_path);

/** Beleg archivieren bzw. wiederherstellen – die Datei bleibt unverändert gespeichert */
export async function setFileArchived(f: EntryFile, archived: boolean) {
  await run('UPDATE cash_entry_files SET archived_at = ? WHERE id = ?', archived ? nowIso() : null, f.id);
}

/** Hängen an Buchungen (auch archivierte) Belege? Dann lassen sich die Buchungen nicht löschen. */
export async function hasFiles(entryIds: number[]): Promise<boolean> {
  if (!entryIds.length) return false;
  return !!await one(`SELECT 1 FROM cash_entry_files WHERE entry_id IN (${entryIds.map(() => '?').join(',')}) LIMIT 1`, ...entryIds);
}
