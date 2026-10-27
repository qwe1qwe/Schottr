import { all, one, run, tx, nowIso } from '../../db/index.ts';
import { calculate, type ItemInput, type TaxMode, VAT_RATES } from '../../lib/calc.ts';
import { addDays, isIsoDate, today } from '../../lib/dates.ts';
import { UserError, list, str, type Form } from '../../lib/http.ts';
import { parseDecimal } from '../../lib/money.ts';
import { isUnit } from '../../lib/units.ts';
import { nextNumber } from '../../lib/numbering.ts';
import { writeProofLinks } from '../proofs.ts';
import { FINAL_TYPES, SELECTABLE_TYPES, type Prepayment } from '../../einvoice/model.ts';
import type { Tenant } from '../../types.ts';
import { getContact } from '../contacts.ts';

export type Kind = 'quote' | 'invoice';

export interface Doc {
  id: number;
  tenant_id: number;
  kind: Kind;
  type_code: string;
  number: string | null;
  status: string;
  contact_id: number;
  issue_date: string;
  valid_until: string | null;
  due_date: string | null;
  service_date: string | null;
  service_from: string | null;
  service_to: string | null;
  subject: string;
  intro: string;
  outro: string;
  buyer_reference: string;
  order_reference: string;
  tax_mode: TaxMode;
  exemption_reason: string;
  currency: string;
  net_total: number;
  tax_total: number;
  gross_total: number;
  prepaid_total: number;
  revision: number;
  skonto_percent: number;
  skonto_days: number;
  source_quote_id: number | null;
  corrects_id: number | null;
  snapshot: string | null;
  finalized_at: string | null;
  paid_at: string | null;
  created_at: string;
  updated_at: string;
}

export interface Item {
  id: number;
  document_id: number;
  position: number;
  title: string;
  description: string;
  quantity: number;
  unit: string;
  unit_price: number;
  vat_rate: number;
  article_number: string;
  line_total: number;
}

const DOC_COLUMNS =
  'id, tenant_id, kind, type_code, number, status, contact_id, issue_date, valid_until, due_date, service_date, service_from, service_to, subject, intro, outro, buyer_reference, order_reference, tax_mode, exemption_reason, currency, net_total, tax_total, gross_total, prepaid_total, revision, skonto_percent, skonto_days, source_quote_id, corrects_id, snapshot, finalized_at, paid_at, created_at, updated_at';

export async function getDoc(tenantId: number, kind: Kind, id: number): Promise<Doc | undefined> {
  return await one<Doc>(`SELECT ${DOC_COLUMNS} FROM documents WHERE tenant_id = ? AND kind = ? AND id = ?`, tenantId, kind, id);
}

export async function getDocById(tenantId: number, id: number): Promise<Doc | undefined> {
  return await one<Doc>(`SELECT ${DOC_COLUMNS} FROM documents WHERE tenant_id = ? AND id = ?`, tenantId, id);
}

export async function getItems(docId: number): Promise<Item[]> {
  return await all<Item>('SELECT * FROM document_items WHERE document_id = ? ORDER BY `position`', docId);
}

export function itemsToInput(items: Item[]): ItemInput[] {
  return items.map((i) => ({
    title: i.title, description: i.description, quantity: i.quantity, unit: i.unit, unitPrice: i.unit_price, vatRate: i.vat_rate,
    articleNumber: i.article_number || undefined,
  }));
}

export function defaultTaxMode(t: Tenant): TaxMode {
  return t.small_business ? 'small_business' : 'standard';
}

export interface DraftInput {
  contact_id: number;
  issue_date: string;
  valid_until: string | null;
  due_date: string | null;
  service_date: string | null;
  service_from: string | null;
  service_to: string | null;
  subject: string;
  intro: string;
  outro: string;
  buyer_reference: string;
  order_reference: string;
  tax_mode: TaxMode;
  exemption_reason: string;
  /** BT-3 – nur Rechnungen */
  type_code: string;
  skonto_percent: number;
  skonto_days: number;
  /** abzuziehende Teilrechnungen (nur 876/877) */
  prepayment_ids: number[];
  /** angehängte Nachweisdokumentationen (nur Rechnungen) */
  proof_ids: number[];
  items: ItemInput[];
}

/** Festgeschriebene Teil(schluss)rechnungen eines Kunden, die noch nicht in einer anderen Schlussrechnung abgezogen wurden */
export async function eligiblePrepayments(tenantId: number, excludeDocId = 0) {
  return all<{ id: number; contact_id: number; number: string; type_code: string; issue_date: string; net_total: number; tax_total: number; gross_total: number; contact_label: string }>(
    `SELECT d.id, d.contact_id, d.number, d.type_code, d.issue_date, d.net_total, d.tax_total, d.gross_total,
            COALESCE(NULLIF(c.company, ''), c.name) AS contact_label
     FROM documents d JOIN contacts c ON c.id = d.contact_id
     WHERE d.tenant_id = ? AND d.kind = 'invoice' AND d.finalized_at IS NOT NULL AND d.type_code IN ('875', '876')
       AND d.status <> 'cancelled' AND d.id <> ?
       AND NOT EXISTS (SELECT 1 FROM document_prepayments p JOIN documents f ON f.id = p.document_id
                       WHERE p.prepaid_id = d.id AND f.finalized_at IS NOT NULL AND f.status <> 'cancelled' AND f.id <> ?)
     ORDER BY d.issue_date, d.id`,
    tenantId, excludeDocId, excludeDocId,
  );
}

export async function getPrepayments(docId: number): Promise<Prepayment[]> {
  const rows = await all(
    `SELECT d.number, d.issue_date, d.net_total, d.tax_total, d.gross_total FROM document_prepayments p
     JOIN documents d ON d.id = p.prepaid_id WHERE p.document_id = ? ORDER BY d.issue_date, d.id`,
    docId,
  );
  return rows.map((r) => ({ number: r.number, issueDate: r.issue_date, net: r.net_total, tax: r.tax_total, gross: r.gross_total }));
}

export async function getPrepaymentIds(docId: number): Promise<number[]> {
  return (await all<{ prepaid_id: number }>('SELECT prepaid_id FROM document_prepayments WHERE document_id = ?', docId)).map((r) => r.prepaid_id);
}

const optDate = (v: string) => (v === '' ? null : v);

/** Formular lesen und prüfen. Wirft UserError mit verständlicher Meldung. */
export async function parseDraft(form: Form, kind: Kind, tenantId: number): Promise<DraftInput> {
  const errors: string[] = [];
  const contactId = Number(str(form, 'contact_id'));
  if (!await getContact(tenantId, contactId)) errors.push('Bitte eine Adresse auswählen.');

  const d: DraftInput = {
    contact_id: contactId,
    issue_date: str(form, 'issue_date'),
    valid_until: kind === 'quote' ? optDate(str(form, 'valid_until')) : null,
    due_date: kind === 'invoice' ? optDate(str(form, 'due_date')) : null,
    service_date: null,
    service_from: null,
    service_to: null,
    subject: str(form, 'subject', 200),
    intro: str(form, 'intro', 4000),
    outro: str(form, 'outro', 4000),
    buyer_reference: str(form, 'buyer_reference', 100),
    order_reference: str(form, 'order_reference', 100),
    tax_mode: (['standard', 'small_business', 'reverse_charge', 'exempt'].includes(str(form, 'tax_mode'))
      ? str(form, 'tax_mode') : 'standard') as TaxMode,
    exemption_reason: str(form, 'exemption_reason', 300),
    type_code: '380',
    skonto_percent: 0,
    skonto_days: 0,
    prepayment_ids: [],
    proof_ids: [],
    items: [],
  };
  if (kind === 'invoice') {
    d.proof_ids = [...new Set(list(form, 'proof_ids').map(Number).filter((n) => Number.isInteger(n) && n > 0))];
    const type = str(form, 'type_code') || '380';
    if (!(SELECTABLE_TYPES as string[]).includes(type)) errors.push('Ungültige Rechnungsart.');
    else d.type_code = type;
    const percent = parseDecimal(str(form, 'skonto_percent') || '0', 2);
    const days = Number(str(form, 'skonto_days') || '0');
    if (percent === null || percent < 0 || percent > 2000) errors.push('Skonto: Prozentsatz zwischen 0 und 20 angeben.');
    else if (!Number.isInteger(days) || days < 0 || days > 365) errors.push('Skonto: ungültige Anzahl Tage.');
    else if ((percent > 0) !== (days > 0)) errors.push('Skonto: bitte Prozentsatz und Tage angeben (oder beides leer lassen).');
    else {
      d.skonto_percent = percent;
      d.skonto_days = days;
    }
    if ((FINAL_TYPES as string[]).includes(d.type_code)) {
      d.prepayment_ids = [...new Set(list(form, 'prepayment_ids').map(Number).filter((n) => Number.isInteger(n) && n > 0))];
    }
  }
  if (kind === 'invoice') {
    if (str(form, 'service_mode') === 'period') {
      d.service_from = optDate(str(form, 'service_from'));
      d.service_to = optDate(str(form, 'service_to'));
    } else {
      d.service_date = optDate(str(form, 'service_date'));
    }
  }

  for (const [key, label] of [
    ['issue_date', 'Datum'], ['valid_until', 'Gültig bis'], ['due_date', 'Fällig am'],
    ['service_date', 'Leistungsdatum'], ['service_from', 'Leistungszeitraum von'], ['service_to', 'Leistungszeitraum bis'],
  ] as const) {
    const v = d[key];
    if ((key === 'issue_date' || v !== null) && !isIsoDate(v)) errors.push(`${label}: ungültiges Datum.`);
  }
  if (d.service_from && d.service_to && d.service_to < d.service_from) errors.push('Der Leistungszeitraum endet vor seinem Beginn.');
  if (d.due_date && d.due_date < d.issue_date) errors.push('Das Fälligkeitsdatum liegt vor dem Rechnungsdatum.');

  const titles = list(form, 'item_title');
  const descriptions = list(form, 'item_description');
  const quantities = list(form, 'item_quantity');
  const units = list(form, 'item_unit');
  const prices = list(form, 'item_price');
  const rates = list(form, 'item_vat');
  const articleNumbers = list(form, 'item_article');
  titles.forEach((rawTitle, i) => {
    const title = rawTitle.trim().slice(0, 300);
    const description = (descriptions[i] ?? '').replace(/\r\n/g, '\n').trim().slice(0, 4000);
    const priceRaw = (prices[i] ?? '').trim();
    if (!title && !description && !priceRaw) return; // leere Zeile
    const quantity = parseDecimal(quantities[i] || '1', 3);
    const unitPrice = parseDecimal(priceRaw || '0', 2);
    const vatRate = Number(rates[i] ?? 1900);
    const unit = units[i] ?? 'C62';
    const n = i + 1;
    if (!title) errors.push(`Position ${n}: Bezeichnung fehlt.`);
    if (quantity === null || quantity === 0 || Math.abs(quantity) > 1e12) errors.push(`Position ${n}: ungültige Menge.`);
    if (unitPrice === null || Math.abs(unitPrice) > 1e12) errors.push(`Position ${n}: ungültiger Preis.`);
    if (!isUnit(unit)) errors.push(`Position ${n}: unbekannte Einheit.`);
    if (!(VAT_RATES as readonly number[]).includes(vatRate)) errors.push(`Position ${n}: ungültiger Steuersatz.`);
    const articleNumber = (articleNumbers[i] ?? '').trim().slice(0, 40) || undefined;
    d.items.push({ title, description, quantity: quantity ?? 0, unit, unitPrice: unitPrice ?? 0, vatRate, articleNumber });
  });
  if (d.items.length > 500) errors.push('Maximal 500 Positionen.');

  if (errors.length) throw new UserError(errors.join(' '));
  return d;
}

/** Abzuziehende Teilrechnungen speichern; liefert die Summe (brutto). */
async function writePrepayments(t: Tenant, docId: number, input: DraftInput): Promise<number> {
  await run('DELETE FROM document_prepayments WHERE document_id = ?', docId);
  if (!input.prepayment_ids.length) return 0;
  const eligible = await eligiblePrepayments(t.id, docId);
  let total = 0;
  for (const id of input.prepayment_ids) {
    const p = eligible.find((e) => e.id === id);
    if (!p) throw new UserError('Eine ausgewählte Teilrechnung kann nicht abgezogen werden (bereits verwendet oder storniert).');
    if (p.contact_id !== input.contact_id) throw new UserError(`Teilrechnung ${p.number} gehört zu einem anderen Kunden.`);
    await run('INSERT INTO document_prepayments (document_id, prepaid_id) VALUES (?, ?)', docId, id);
    total += p.gross_total;
  }
  return total;
}

async function writeItems(docId: number, input: DraftInput) {
  const totals = calculate(input.items, input.tax_mode);
  await run('DELETE FROM document_items WHERE document_id = ?', docId);
  for (const it of totals.items) {
    await run(
      `INSERT INTO document_items (document_id, \`position\`, article_number, title, description, quantity, unit, unit_price, vat_rate, line_total)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      docId, it.position, it.articleNumber ?? '', it.title, it.description, it.quantity, it.unit, it.unitPrice,
      // Originalsatz behalten, damit beim Wechsel der Steuerart nichts verloren geht
      input.items[it.position - 1].vatRate, it.lineTotal,
    );
  }
  return totals;
}

export async function createDraft(t: Tenant, kind: Kind, input: DraftInput, userId: number, extra: Partial<Doc> = {}): Promise<number> {
  return await tx(async () => {
    const now = nowIso();
    const number = kind === 'quote' ? await nextNumber(t.id, 'quote', t.quote_number_format, input.issue_date) : null;
    const res = await run(
      `INSERT INTO documents (tenant_id, kind, type_code, number, status, contact_id, issue_date, valid_until, due_date,
        service_date, service_from, service_to, subject, intro, outro, buyer_reference, order_reference, tax_mode,
        exemption_reason, skonto_percent, skonto_days, source_quote_id, corrects_id, created_by, created_at, updated_at)
       VALUES (?, ?, ?, ?, 'draft', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      t.id, kind, extra.type_code ?? (kind === 'invoice' ? input.type_code : '380'), number, input.contact_id, input.issue_date, input.valid_until, input.due_date,
      input.service_date, input.service_from, input.service_to, input.subject, input.intro, input.outro,
      input.buyer_reference, input.order_reference, input.tax_mode, input.exemption_reason,
      input.skonto_percent, input.skonto_days, extra.source_quote_id ?? null, extra.corrects_id ?? null, userId, now, now,
    );
    const id = Number(res.insertId);
    const totals = await writeItems(id, input);
    const prepaid = await writePrepayments(t, id, input);
    await writeProofLinks(t.id, id, input.proof_ids);
    await run('UPDATE documents SET net_total = ?, tax_total = ?, gross_total = ?, prepaid_total = ? WHERE id = ?', totals.net, totals.tax, totals.gross, prepaid, id);
    return id;
  });
}

export async function updateDraft(t: Tenant, doc: Doc, input: DraftInput) {
  if (doc.finalized_at) throw new UserError('Festgeschriebene Rechnungen können nicht mehr geändert werden.');
  // Stornorechnungen behalten ihre Art
  const typeCode = doc.kind === 'invoice' && doc.type_code !== '381' ? input.type_code : doc.type_code;
  if (typeCode === '381') input.prepayment_ids = [];
  await tx(async () => {
    const totals = await writeItems(doc.id, input);
    const prepaid = await writePrepayments(t, doc.id, input);
    await writeProofLinks(t.id, doc.id, typeCode === '381' ? [] : input.proof_ids);
    await run(
      `UPDATE documents SET contact_id = ?, issue_date = ?, valid_until = ?, due_date = ?, service_date = ?, service_from = ?,
        service_to = ?, subject = ?, intro = ?, outro = ?, buyer_reference = ?, order_reference = ?, tax_mode = ?,
        exemption_reason = ?, type_code = ?, skonto_percent = ?, skonto_days = ?, net_total = ?, tax_total = ?, gross_total = ?,
        prepaid_total = ?, updated_at = ? WHERE id = ?`,
      input.contact_id, input.issue_date, input.valid_until, input.due_date, input.service_date, input.service_from,
      input.service_to, input.subject, input.intro, input.outro, input.buyer_reference, input.order_reference,
      input.tax_mode, input.exemption_reason, typeCode, input.skonto_percent, input.skonto_days,
      totals.net, totals.tax, totals.gross, prepaid, nowIso(), doc.id,
    );
  });
}

export function docToInput(doc: Doc, items: Item[]): DraftInput {
  return {
    contact_id: doc.contact_id,
    issue_date: doc.issue_date,
    valid_until: doc.valid_until,
    due_date: doc.due_date,
    service_date: doc.service_date,
    service_from: doc.service_from,
    service_to: doc.service_to,
    subject: doc.subject,
    intro: doc.intro,
    outro: doc.outro,
    buyer_reference: doc.buyer_reference,
    order_reference: doc.order_reference,
    tax_mode: doc.tax_mode,
    exemption_reason: doc.exemption_reason,
    type_code: doc.type_code,
    skonto_percent: doc.skonto_percent,
    skonto_days: doc.skonto_days,
    prepayment_ids: [],
    proof_ids: [],
    items: itemsToInput(items),
  };
}

/** Rechnungsentwurf aus einem Angebot ableiten. */
export async function invoiceFromQuote(t: Tenant, quote: Doc, userId: number): Promise<number> {
  const items = await getItems(quote.id);
  const contact = await getContact(t.id, quote.contact_id);
  const date = today();
  const input: DraftInput = {
    ...docToInput(quote, items),
    issue_date: date,
    valid_until: null,
    due_date: addDays(date, t.payment_days),
    service_date: date,
    service_from: null,
    service_to: null,
    intro: t.invoice_intro,
    outro: t.invoice_outro,
    skonto_percent: t.skonto_percent,
    skonto_days: t.skonto_days,
    buyer_reference: contact?.leitweg_id ?? '',
    order_reference: quote.order_reference,
  };
  return await tx(async () => {
    const id = await createDraft(t, 'invoice', input, userId, { source_quote_id: quote.id });
    await run("UPDATE documents SET status = 'invoiced', updated_at = ? WHERE id = ?", nowIso(), quote.id);
    return id;
  });
}

export async function duplicate(t: Tenant, doc: Doc, userId: number): Promise<number> {
  // Stornorechnungen entstehen nur über „Stornieren“ mit Bezug auf die Originalrechnung
  if (doc.type_code === '381') throw new UserError('Stornorechnungen können nicht dupliziert werden.');
  const date = today();
  const input: DraftInput = {
    ...docToInput(doc, await getItems(doc.id)),
    issue_date: date,
    valid_until: doc.kind === 'quote' ? addDays(date, t.quote_valid_days) : null,
    due_date: doc.kind === 'invoice' ? addDays(date, t.payment_days) : null,
    service_date: doc.kind === 'invoice' ? date : null,
    service_from: null,
    service_to: null,
  };
  return await createDraft(t, doc.kind, input, userId);
}

export async function deleteDraft(doc: Doc) {
  if (doc.finalized_at) throw new UserError('Festgeschriebene Rechnungen können nicht gelöscht werden (GoBD). Bitte stornieren.');
  if (doc.revision > 0) throw new UserError('Diese Rechnung war bereits festgeschrieben und wird gerade nachträglich bearbeitet – bitte erneut festschreiben statt löschen.');
  await tx(async () => {
    await run('UPDATE documents SET source_quote_id = NULL WHERE source_quote_id = ? AND finalized_at IS NULL', doc.id);
    await run('DELETE FROM documents WHERE id = ?', doc.id);
  });
}
