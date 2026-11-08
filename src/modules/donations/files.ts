import { all, one, run, nowIso } from '../../db/index.ts';
import { saveFile } from '../../lib/files.ts';
import { UserError } from '../../lib/http.ts';
import { viewOf } from '../../lib/crop.ts';
import type { Tenant } from '../../types.ts';
import { MAX_ENTRY_FILE, mimeOf } from '../cashbook/files.ts';
import { carryCrop, markAssigned, openInbox, readInbox, type InboxFile } from '../inbox/repo.ts';

/**
 * Belege zu Zuwendungen: Kontoauszug, Überweisungsbeleg, Spendenschreiben, Foto einer Barspende …
 * Die Dateien liegen in der Belegablage neben den Eingangsrechnungen (data/verbindlichkeiten/<Mandant>/,
 * Name beginnt mit „spende_“) – kein zusätzliches Docker-Volume nötig. Belege sind aufbewahrungspflichtig:
 * nicht löschen oder austauschen, nur archivieren (die Datenbank verhindert das Löschen ebenfalls).
 */
const AREA = 'verbindlichkeiten' as const;

export interface DonationFile {
  id: number;
  tenant_id: number;
  donation_id: number;
  file_name: string;
  file_path: string;
  file_mime: string;
  file_size: number;
  created_at: string;
  archived_at: string | null;
  crop_path: string | null;
  crop_mime: string | null;
  cropped_at: string | null;
}

/** Eine geprüfte Datei an eine Zuwendung hängen */
export async function attachDonationData(t: Tenant, donationId: number, p: { name: string; data: Uint8Array; mime: string }, userId: number): Promise<number> {
  const stored = await saveFile(AREA, t.id, `spende_${p.name}`, p.data);
  const r = await run(
    `INSERT INTO donation_files (tenant_id, donation_id, file_name, file_path, file_mime, file_size, file_sha256, created_by, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    t.id, donationId, p.name, stored.path, p.mime, stored.size, stored.sha256, userId, nowIso(),
  );
  return Number(r.insertId);
}

/** Hochgeladene Dateien prüfen und an eine Zuwendung hängen; liefert die Anzahl */
export async function attachDonationFiles(t: Tenant, donationId: number, files: File[], userId: number): Promise<number> {
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
  for (const p of prepared) await attachDonationData(t, donationId, p, userId);
  return prepared.length;
}

/** Beleg aus dem Belegeingang an eine Zuwendung hängen (innerhalb einer Transaktion aufrufen) */
export async function assignInboxToDonation(t: Tenant, inboxId: number, donationId: number, userId: number): Promise<InboxFile> {
  const f = await openInbox(t.id, inboxId);
  const fileId = await attachDonationData(t, donationId, { name: f.file_name, data: new Uint8Array(await readInbox(f)), mime: f.file_mime }, userId);
  await carryCrop(f, 'donation_files', t.id, fileId);
  await markAssigned(f, `Zuwendung ID ${donationId}`);
  return f;
}

export const donationFilesOf = (donationId: number) =>
  all<DonationFile>('SELECT * FROM donation_files WHERE donation_id = ? ORDER BY id', donationId);

export const getDonationFile = (tenantId: number, id: number) =>
  one<DonationFile>('SELECT * FROM donation_files WHERE tenant_id = ? AND id = ?', tenantId, id);

/** Anzahl aktiver Belege je Zuwendung (Büroklammer in Listen) */
export async function donationFileCounts(ids: number[]): Promise<Map<number, number>> {
  if (!ids.length) return new Map();
  const rows = await all<{ donation_id: number; n: number }>(
    `SELECT donation_id, COUNT(*) n FROM donation_files WHERE archived_at IS NULL AND donation_id IN (${ids.map(() => '?').join(',')}) GROUP BY donation_id`,
    ...ids,
  );
  return new Map(rows.map((r) => [r.donation_id, Number(r.n)]));
}

/** Hängen (auch archivierte) Belege an der Zuwendung? Dann lässt sie sich nicht mehr löschen. */
export async function donationHasFiles(donationId: number): Promise<boolean> {
  return !!await one('SELECT 1 FROM donation_files WHERE donation_id = ? LIMIT 1', donationId);
}

/** Anzeige/Export: zugeschnittener Ausschnitt, falls vorhanden – sonst das Original */
export const viewDonationFile = (f: DonationFile, original = false) => viewOf(AREA, f, original);

/** Archivieren bzw. wiederherstellen – die Datei bleibt unverändert gespeichert */
export async function setDonationFileArchived(f: DonationFile, archived: boolean) {
  await run('UPDATE donation_files SET archived_at = ? WHERE id = ?', archived ? nowIso() : null, f.id);
}
