import type { Context } from 'hono';
import { nowIso, run } from '../db/index.ts';
import { readStoredFile, saveFile, type FileArea } from './files.ts';
import { UserError } from './http.ts';

/**
 * Zuschnitt von Foto-Belegen (Quittung mit Tischplatte drumherum, schief fotografiert …).
 *
 * Belege sind aufbewahrungspflichtig und unveränderbar: Das hochgeladene Original wird nie
 * angefasst. Der Ausschnitt entsteht im Browser (Canvas) und wird als zusätzliche Datei neben
 * dem Original abgelegt (Spalten crop_*). Anzeige und Export verwenden den Ausschnitt, das
 * Original bleibt jederzeit abrufbar („?original=1“). Verwerfen setzt nur den Verweis zurück.
 */
export const MAX_CROP_FILE = 10 * 1024 * 1024;

/** Tabellen mit Belegdateien, die sich zuschneiden lassen */
export type CropTable = 'cash_entry_files' | 'purchase_invoices' | 'inbox_files';

export interface Croppable {
  file_name: string;
  file_path: string;
  file_mime: string;
  crop_path?: string | null;
  crop_mime?: string | null;
  crop_size?: number | null;
  crop_sha256?: string | null;
  cropped_at?: string | null;
}

export const isImage = (mime: string | null | undefined) => mime === 'image/jpeg' || mime === 'image/png';
export const canCrop = (f: Pick<Croppable, 'file_mime' | 'file_path'>) => !!f.file_path && isImage(f.file_mime);
export const hasCrop = (f: Croppable) => !!f.crop_path;

function imageMime(data: Uint8Array): 'image/jpeg' | 'image/png' | null {
  if (data[0] === 0xff && data[1] === 0xd8 && data[2] === 0xff) return 'image/jpeg';
  if (Buffer.from(data.subarray(0, 8)).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return 'image/png';
  return null;
}

/** Zugeschnittenes Bild aus dem Formular (Feld „image“) prüfen */
export async function cropFrom(c: Context): Promise<{ data: Uint8Array; mime: 'image/jpeg' | 'image/png' }> {
  const body = await c.req.parseBody();
  const f = body.image;
  if (!(f instanceof File) || !f.size) throw new UserError('Kein Ausschnitt übermittelt – bitte im Dialog „Übernehmen“ wählen.');
  if (f.size > MAX_CROP_FILE) throw new UserError('Der Ausschnitt ist größer als 10 MB.');
  const data = new Uint8Array(await f.arrayBuffer());
  const mime = imageMime(data);
  if (!mime) throw new UserError('Der Ausschnitt muss ein JPEG- oder PNG-Bild sein.');
  return { data, mime };
}

/** Name der Ausschnitt-Datei, z. B. „Quittung_zuschnitt.jpg“ */
export function cropName(fileName: string, mime: string): string {
  const base = (fileName || 'beleg').replace(/\.(pdf|jpe?g|png|heic|webp)$/i, '');
  return `${base}_zuschnitt${mime === 'image/png' ? '.png' : '.jpg'}`;
}

/** Ausschnitt speichern (neue Datei) und am Datensatz vermerken; ein früherer Ausschnitt bleibt als Datei liegen */
export async function saveCrop(table: CropTable, area: FileArea, tenantId: number, id: number, f: Croppable, crop: { data: Uint8Array; mime: string }) {
  if (!canCrop(f)) throw new UserError('Nur Fotos (JPEG/PNG) lassen sich zuschneiden.');
  const stored = await saveFile(area, tenantId, cropName(f.file_name, crop.mime), crop.data);
  await run(
    `UPDATE ${table} SET crop_path = ?, crop_mime = ?, crop_size = ?, crop_sha256 = ?, cropped_at = ? WHERE id = ?`,
    stored.path, crop.mime, stored.size, stored.sha256, nowIso(), id,
  );
}

/** Ausschnitt verwerfen – wieder das Original anzeigen */
export async function clearCrop(table: CropTable, id: number) {
  await run(`UPDATE ${table} SET crop_path = NULL, crop_mime = NULL, crop_size = NULL, crop_sha256 = NULL, cropped_at = NULL WHERE id = ?`, id);
}

/** Zum Anzeigen bzw. Exportieren: Ausschnitt, falls vorhanden (außer ausdrücklich das Original) */
export async function viewOf(area: FileArea, f: Croppable, original = false): Promise<{ data: Buffer; mime: string; name: string }> {
  if (!original && f.crop_path) {
    return { data: await readStoredFile(area, f.crop_path), mime: f.crop_mime || 'image/jpeg', name: cropName(f.file_name, f.crop_mime || 'image/jpeg') };
  }
  return { data: await readStoredFile(area, f.file_path), mime: f.file_mime, name: f.file_name };
}

/** Name der Datei, wie sie exportiert bzw. angezeigt wird */
export const viewName = (f: Croppable) => (f.crop_path ? cropName(f.file_name, f.crop_mime || 'image/jpeg') : f.file_name);

/** Den Ausschnitt eines Belegs an einen neuen Datensatz weitergeben (z. B. beim Zuordnen aus dem Belegeingang) */
export async function copyCrop(fromArea: FileArea, f: Croppable, table: CropTable, toArea: FileArea, tenantId: number, id: number) {
  if (!f.crop_path) return;
  const data = new Uint8Array(await readStoredFile(fromArea, f.crop_path));
  await saveCrop(table, toArea, tenantId, id, f, { data, mime: f.crop_mime || 'image/jpeg' });
}

/** POST …/crop: Ausschnitt speichern oder (reset=1) verwerfen */
export async function handleCrop(c: Context, table: CropTable, area: FileArea, tenantId: number, id: number, f: Croppable): Promise<'saved' | 'cleared'> {
  const body = await c.req.parseBody();
  if (body.reset === '1') {
    await clearCrop(table, id);
    return 'cleared';
  }
  await saveCrop(table, area, tenantId, id, f, await cropFrom(c));
  return 'saved';
}
