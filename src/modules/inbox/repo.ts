import { all, one, run, tx, nowIso } from '../../db/index.ts';
import { readStoredFile, removeStoredFile, saveFile } from '../../lib/files.ts';
import { UserError } from '../../lib/http.ts';
import { appendPdfs, imagesToPdf } from '../../lib/pdfmerge.ts';
import { attachData, MAX_ENTRY_FILE, mimeOf } from '../cashbook/files.ts';
import type { Tenant } from '../../types.ts';

/**
 * Belegeingang: Belege (PDF oder Foto), die schon hochgeladen, aber noch keiner
 * Eingangsrechnung oder Kassenbuch-Buchung zugeordnet sind. Sie liegen unter
 * data/other/<Mandant>/ und werden beim Zuordnen in die Belegablage
 * (data/verbindlichkeiten/…) verschoben; der Eintrag hier verschwindet dann.
 */
const AREA = 'other' as const;

export interface InboxFile {
  id: number;
  tenant_id: number;
  file_name: string;
  file_path: string;
  file_mime: string;
  file_size: number;
  file_sha256: string;
  note: string;
  created_by: number | null;
  created_at: string;
}

export interface Prepared {
  name: string;
  data: Uint8Array;
  mime: string;
}

/** Aussagekräftiger Name statt „image.jpg“ vom Handy */
function baseName(name: string): string {
  const base = (name || '').replace(/\.(pdf|jpe?g|png|heic|webp)$/i, '').trim();
  if (!base || /^(image|photo|foto|img|dsc|pxl|capture|blob)[\s_-]*\d*$/i.test(base)) {
    const d = new Date();
    const p = (n: number) => String(n).padStart(2, '0');
    return `Beleg_${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}_${p(d.getHours())}${p(d.getMinutes())}`;
  }
  return base;
}

/**
 * Hochgeladene Dateien prüfen und zu einem Beleg zusammenfassen: eine Datei bleibt, wie sie ist;
 * mehrere (z. B. zwei Fotos einer langen Quittung) werden in der Reihenfolge zu einem PDF.
 */
export async function combine(files: File[]): Promise<Prepared> {
  if (!files.length) throw new UserError('Bitte ein Foto aufnehmen oder eine Datei auswählen.');
  if (files.length > 20) throw new UserError('Bitte höchstens 20 Seiten je Beleg.');
  const parts: Prepared[] = [];
  for (const f of files) {
    if (f.size > MAX_ENTRY_FILE) throw new UserError(`„${f.name}“ ist größer als 10 MB.`);
    const data = new Uint8Array(await f.arrayBuffer());
    const mime = mimeOf(data);
    if (!mime) throw new UserError(`„${f.name}“: bitte ein PDF oder ein Foto (JPEG/PNG) hochladen. HEIC-Fotos vom iPhone vorher als JPEG speichern – beim Fotografieren direkt im Browser passiert das automatisch.`);
    parts.push({ name: f.name, data, mime });
  }
  const base = baseName(parts[0].name);
  if (parts.length === 1) {
    const p = parts[0];
    return { name: `${base}${p.mime === 'application/pdf' ? '.pdf' : p.mime === 'image/png' ? '.png' : '.jpg'}`.slice(-120), data: p.data, mime: p.mime };
  }
  const pdfs: Uint8Array[] = [];
  let images: Prepared[] = [];
  const flush = async () => {
    if (images.length) pdfs.push(await imagesToPdf(images));
    images = [];
  };
  for (const p of parts) {
    if (p.mime === 'application/pdf') {
      await flush();
      pdfs.push(p.data);
    } else images.push(p);
  }
  await flush();
  let merged: Uint8Array;
  try {
    merged = pdfs.length === 1 ? pdfs[0] : new Uint8Array(await appendPdfs(Buffer.from(pdfs[0]), pdfs.slice(1)));
  } catch {
    throw new UserError('Die Dateien ließen sich nicht zu einem PDF zusammenfassen (beschädigtes oder geschütztes PDF?). Bitte einzeln hochladen.');
  }
  if (merged.length > 20 * 1024 * 1024) throw new UserError('Der zusammengefasste Beleg ist größer als 20 MB – bitte weniger oder kleinere Seiten.');
  return { name: `${base}.pdf`.slice(-120), data: merged, mime: 'application/pdf' };
}

export async function addInbox(t: Tenant, userId: number, p: Prepared, note = ''): Promise<number> {
  const stored = await saveFile(AREA, t.id, p.name, p.data);
  try {
    const r = await run(
      `INSERT INTO inbox_files (tenant_id, file_name, file_path, file_mime, file_size, file_sha256, note, created_by, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      t.id, p.name, stored.path, p.mime, stored.size, stored.sha256, note.slice(0, 300), userId, nowIso(),
    );
    return Number(r.insertId);
  } catch (err) {
    await removeStoredFile(AREA, stored.path);
    throw err;
  }
}

export const inboxOf = (tenantId: number) =>
  all<InboxFile>('SELECT * FROM inbox_files WHERE tenant_id = ? ORDER BY created_at DESC, id DESC', tenantId);

export async function inboxCount(tenantId: number): Promise<number> {
  return Number((await one<{ n: number }>('SELECT COUNT(*) n FROM inbox_files WHERE tenant_id = ?', tenantId))?.n ?? 0);
}

export const getInbox = (tenantId: number, id: number) =>
  one<InboxFile>('SELECT * FROM inbox_files WHERE tenant_id = ? AND id = ?', tenantId, id);

export const readInbox = (f: Pick<InboxFile, 'file_path'>) => readStoredFile(AREA, f.file_path);

/** Eintrag entfernen; die Datei erst danach (nach erfolgreicher Transaktion) löschen */
export async function dropInbox(f: InboxFile): Promise<void> {
  await run('DELETE FROM inbox_files WHERE id = ?', f.id);
}

export const removeInboxFile = (f: Pick<InboxFile, 'file_path'>) => removeStoredFile(AREA, f.file_path);

/**
 * Beleg aus dem Belegeingang an eine Kassenbuch-Buchung hängen (innerhalb einer Transaktion
 * aufrufen). Liefert den Eintrag zurück – dessen Datei nach dem Commit mit removeInboxFile löschen.
 */
/* ---------------- Zu vorhandener Buchung / Eingangsrechnung ---------------- */

/** Ziel „vorhanden“: Eingangsrechnung ohne Datei (p:<id>) oder Kassenbuch-Buchung (e:<id>) */
export interface AttachTargets {
  purchases: { id: number; number: string; issue_date: string | null; supplier: string | null; gross_total: number; is_credit: number }[];
  entries: { id: number; entry_date: string; text: string; amount: number; account: string; files: number }[];
}

/**
 * Mögliche Ziele für einen Beleg: erfasste Eingangsrechnungen ohne Datei (z. B. manuell
 * eingetragen, Quittung kommt nach) und Kassenbuch-Buchungen, an denen Belege hängen können
 * (freie Buchungen, Umbuchungen, Zählungen – bei verknüpften ist die Rechnung bzw. Spende der Beleg).
 */
export async function attachTargets(t: Tenant, withEntries: boolean): Promise<AttachTargets> {
  const purchases = await all<AttachTargets['purchases'][number]>(
    `SELECT p.id, p.number, p.issue_date, p.gross_total, p.is_credit, COALESCE(NULLIF(c.company, ''), c.name) supplier
     FROM purchase_invoices p LEFT JOIN contacts c ON c.id = p.contact_id
     WHERE p.tenant_id = ? AND p.status <> 'draft' AND (p.file_path IS NULL OR p.file_path = '')
     ORDER BY COALESCE(p.issue_date, DATE(p.created_at)) DESC, p.id DESC LIMIT 100`, t.id,
  );
  const entries = withEntries
    ? await all<AttachTargets['entries'][number]>(
      `SELECT e.id, e.entry_date, e.text, e.amount, a.name account,
              (SELECT COUNT(*) FROM cash_entry_files f WHERE f.entry_id = e.id) files
       FROM cash_entries e JOIN cash_accounts a ON a.id = e.account_id
       WHERE e.tenant_id = ? AND e.source IN ('manual', 'transfer', 'count')
       ORDER BY e.entry_date DESC, e.id DESC LIMIT 150`, t.id,
    )
    : [];
  return { purchases, entries: entries.map((e) => ({ ...e, files: Number(e.files) })) };
}

/**
 * Beleg aus dem Belegeingang einem vorhandenen Ziel zuordnen: als Datei einer Eingangsrechnung
 * (nur, wenn sie noch keine hat) oder als weiterer Beleg einer Buchung. Liefert eine Beschreibung
 * fürs Protokoll; die Datei im Eingang wird danach entfernt.
 */
export async function assignInbox(t: Tenant, inboxId: number, target: string, userId: number, cashbook: boolean): Promise<{ label: string; href: string }> {
  const m = /^([pe]):(\d+)$/.exec(target);
  if (!m) throw new UserError('Bitte die Buchung bzw. Eingangsrechnung auswählen.');
  const id = Number(m[2]);
  const f = await getInbox(t.id, inboxId);
  if (!f) throw new UserError('Der Beleg ist nicht mehr im Belegeingang (schon zugeordnet oder gelöscht?).');
  const data = new Uint8Array(await readInbox(f));
  let result: { label: string; href: string };
  if (m[1] === 'p') {
    const p = await one<{ id: number; number: string; status: string; file_path: string | null }>(
      'SELECT id, number, status, file_path FROM purchase_invoices WHERE tenant_id = ? AND id = ?', t.id, id,
    );
    if (!p || p.status === 'draft') throw new UserError('Eingangsrechnung nicht gefunden.');
    if (p.file_path) throw new UserError('Die Eingangsrechnung hat schon eine Datei.');
    const stored = await saveFile('verbindlichkeiten', t.id, f.file_name, data);
    try {
      await tx(async () => {
        await run(
          `UPDATE purchase_invoices SET file_name = ?, file_path = ?, file_mime = ?, file_size = ?, file_sha256 = ?, updated_at = ?
           WHERE id = ? AND (file_path IS NULL OR file_path = '')`,
          f.file_name, stored.path, f.file_mime, stored.size, stored.sha256, nowIso(), p.id,
        );
        await dropInbox(f);
      });
    } catch (err) {
      await removeStoredFile('verbindlichkeiten', stored.path);
      throw err;
    }
    result = { label: `Eingangsrechnung ${p.number || `ID ${p.id}`}`, href: `/purchases/${p.id}` };
  } else {
    if (!cashbook) throw new UserError('Das Kassenbuch gibt es nur für Vereine.');
    const e = await one<{ id: number; source: string; text: string; entry_date: string }>(
      'SELECT id, source, text, entry_date FROM cash_entries WHERE tenant_id = ? AND id = ?', t.id, id,
    );
    if (!e) throw new UserError('Buchung nicht gefunden.');
    if (!['manual', 'transfer', 'count'].includes(e.source)) throw new UserError('Diese Buchung gehört zu einer Rechnung bzw. Spende – der Beleg ist dort hinterlegt.');
    await tx(async () => {
      await attachData(t, e.id, { name: f.file_name, data, mime: f.file_mime }, userId);
      await dropInbox(f);
    });
    result = { label: `Buchung „${e.text}“ vom ${e.entry_date.split('-').reverse().join('.')}`, href: `/cashbook/entries/${e.id}/edit` };
  }
  await removeInboxFile(f);
  return result;
}

export async function assignToEntry(t: Tenant, inboxId: number, entryId: number, userId: number): Promise<InboxFile> {
  const f = await getInbox(t.id, inboxId);
  if (!f) throw new UserError('Der Beleg ist nicht mehr im Belegeingang (schon zugeordnet oder gelöscht?).');
  await attachData(t, entryId, { name: f.file_name, data: new Uint8Array(await readInbox(f)), mime: f.file_mime }, userId);
  await dropInbox(f);
  return f;
}
