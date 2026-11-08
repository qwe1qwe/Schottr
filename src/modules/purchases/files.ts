import { all, one, run, nowIso } from '../../db/index.ts';
import { saveFile } from '../../lib/files.ts';
import { viewOf } from '../../lib/crop.ts';
import { UserError } from '../../lib/http.ts';
import { MAX_ENTRY_FILE, mimeOf } from '../cashbook/files.ts';
import type { Tenant } from '../../types.ts';

/**
 * Weitere Belege zu einer Eingangsrechnung (zweite Seite, Lieferschein, Quittung …) neben der
 * eigentlichen Rechnungsdatei. Ablage wie die Rechnungsdateien unter data/verbindlichkeiten/<Mandant>/.
 * Aufbewahrungspflichtig: nicht löschen, nicht austauschen – nur archivieren.
 */
const AREA = 'verbindlichkeiten' as const;

export interface PurchaseFile {
  id: number;
  tenant_id: number;
  purchase_id: number;
  file_name: string;
  file_path: string;
  file_mime: string;
  file_size: number;
  crop_path: string | null;
  crop_mime: string | null;
  cropped_at: string | null;
  archived_at: string | null;
  created_at: string;
}

/** Bereits geprüfte Datei (z. B. aus dem Belegeingang) an eine Eingangsrechnung hängen */
export async function attachPurchaseData(t: Tenant, purchaseId: number, p: { name: string; data: Uint8Array; mime: string }, userId: number): Promise<number> {
  const stored = await saveFile(AREA, t.id, `anlage_${p.name}`, p.data);
  const r = await run(
    `INSERT INTO purchase_files (tenant_id, purchase_id, file_name, file_path, file_mime, file_size, file_sha256, created_by, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    t.id, purchaseId, p.name, stored.path, p.mime, stored.size, stored.sha256, userId, nowIso(),
  );
  return Number(r.insertId);
}

/** Hochgeladene Dateien prüfen und anhängen; liefert die Anzahl */
export async function attachPurchaseFiles(t: Tenant, purchaseId: number, files: File[], userId: number): Promise<number> {
  const prepared: { name: string; data: Uint8Array; mime: string }[] = [];
  for (const f of files) {
    if (f.size > MAX_ENTRY_FILE) throw new UserError(`„${f.name}“ ist größer als 10 MB.`);
    const data = new Uint8Array(await f.arrayBuffer());
    const mime = mimeOf(data);
    if (!mime) throw new UserError(`„${f.name}“: bitte ein PDF oder ein Foto (JPEG/PNG) hochladen.`);
    const ext = mime === 'application/pdf' ? '.pdf' : mime === 'image/png' ? '.png' : '.jpg';
    const base = (f.name || 'beleg').replace(/\.(pdf|jpe?g|png|heic)$/i, '');
    prepared.push({ name: `${base}${ext}`.slice(-120), data, mime });
  }
  for (const p of prepared) await attachPurchaseData(t, purchaseId, p, userId);
  return prepared.length;
}

export const purchaseFilesOf = (purchaseId: number) =>
  all<PurchaseFile>('SELECT * FROM purchase_files WHERE purchase_id = ? ORDER BY id', purchaseId);

export const getPurchaseFile = (tenantId: number, id: number) =>
  one<PurchaseFile>('SELECT * FROM purchase_files WHERE tenant_id = ? AND id = ?', tenantId, id);

/** Anzahl aktiver weiterer Belege je Eingangsrechnung (Büroklammer) */
export async function purchaseFileCounts(ids: number[]): Promise<Map<number, number>> {
  if (!ids.length) return new Map();
  const rows = await all<{ purchase_id: number; n: number }>(
    `SELECT purchase_id, COUNT(*) n FROM purchase_files WHERE archived_at IS NULL AND purchase_id IN (${ids.map(() => '?').join(',')}) GROUP BY purchase_id`,
    ...ids,
  );
  return new Map(rows.map((r) => [r.purchase_id, Number(r.n)]));
}

export const viewPurchaseFile = (f: PurchaseFile, original = false) => viewOf(AREA, f, original);

export async function setPurchaseFileArchived(f: PurchaseFile, archived: boolean) {
  await run('UPDATE purchase_files SET archived_at = ? WHERE id = ?', archived ? nowIso() : null, f.id);
}
