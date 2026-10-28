import { isSphere } from '../../lib/nonprofit.ts';
import { all, one, run, tx, nowIso } from '../../db/index.ts';
import { addDays, isIsoDate, today } from '../../lib/dates.ts';
import { UserError, list, str, type Form } from '../../lib/http.ts';
import { parseDecimal, roundDiv } from '../../lib/money.ts';
import { isValidEmail, isValidVatId, normalizeVatId, isCountryCode } from '../../lib/validate.ts';
import { DEFAULT_CATEGORY, isExpenseCategory } from '../../lib/expenses.ts';
import { removeStoredFile, saveFile, sha256 } from '../../lib/files.ts';
import type { IncomingInvoice, IncomingParty } from '../../einvoice/parse.ts';
import { getContact, insertContact, isSupplier, type Contact } from '../contacts.ts';
import type { Tenant } from '../../types.ts';

/**
 * Eingangsrechnungen (Verbindlichkeiten).
 * Status: draft = Beleg hochgeladen, Angaben fehlen noch · open = zu zahlen · paid = bezahlt.
 * Beträge positiv in Cent; Gutschriften (is_credit) zählen in Auswertungen negativ.
 */
export type PurchaseStatus = 'draft' | 'open' | 'paid';

export interface Purchase {
  id: number;
  tenant_id: number;
  contact_id: number | null;
  status: PurchaseStatus;
  is_credit: number;
  number: string;
  issue_date: string | null;
  due_date: string | null;
  service_date: string | null;
  description: string;
  category: string;
  /** Tätigkeitsbereich (gemeinnützige Vereine), leer = Vorgabe */
  sphere: string;
  currency: string;
  net_total: number;
  tax_total: number;
  gross_total: number;
  prepaid_total: number;
  paid_at: string | null;
  iban: string;
  payment_reference: string;
  einvoice_format: string;
  einvoice_data: string | null;
  file_name: string;
  file_path: string;
  file_mime: string;
  file_size: number;
  file_sha256: string;
  created_at: string;
  updated_at: string;
}

export interface PurchaseTax {
  category: string;
  rate: number;
  basis: number;
  tax: number;
}

/** Was aus der E-Rechnung zusätzlich gespeichert wird (nur zur Anzeige) */
export interface EInvoiceInfo {
  syntax: string;
  guideline: string;
  typeCode: string;
  buyerName: string;
  buyerReference: string;
  orderReference: string;
  periodFrom: string | null;
  periodTo: string | null;
  seller: IncomingParty;
  paymentTerms: string;
  bic: string;
  lines: IncomingInvoice['lines'];
  notes: string[];
  warnings: string[];
  taxes: (PurchaseTax & { exemptionReason?: string })[];
}

/** Zu zahlender Betrag (bei Teilzahlungen laut E-Rechnung bereits gemindert) */
export const payable = (p: Pick<Purchase, 'gross_total' | 'prepaid_total'>) => p.gross_total - p.prepaid_total;
/** Fälligkeit; ohne Angabe sofort fällig */
export const dueOf = (p: Pick<Purchase, 'due_date' | 'issue_date'>) => p.due_date ?? p.issue_date;

export const SIGNED = (col: string) => `CASE WHEN p.is_credit = 1 THEN -p.${col} ELSE p.${col} END`;

export async function getPurchase(tenantId: number, id: number): Promise<Purchase | undefined> {
  return one<Purchase>('SELECT * FROM purchase_invoices WHERE tenant_id = ? AND id = ?', tenantId, id);
}

export async function getTaxes(purchaseId: number): Promise<PurchaseTax[]> {
  return all<PurchaseTax>('SELECT category, rate, basis, tax FROM purchase_invoice_taxes WHERE purchase_id = ? ORDER BY `position`', purchaseId);
}

async function writeTaxes(purchaseId: number, taxes: PurchaseTax[]) {
  await run('DELETE FROM purchase_invoice_taxes WHERE purchase_id = ?', purchaseId);
  let pos = 0;
  for (const t of taxes) {
    await run(
      'INSERT INTO purchase_invoice_taxes (purchase_id, `position`, category, rate, basis, tax) VALUES (?, ?, ?, ?, ?, ?)',
      purchaseId, pos++, t.category.slice(0, 2), t.rate, t.basis, t.tax,
    );
  }
}

/* ---------------- Dateien ---------------- */

export type FileKind = 'pdf' | 'xml' | 'png' | 'jpeg';
export const MAX_FILE_SIZE = 10 * 1024 * 1024;

export const MIME: Record<FileKind, string> = { pdf: 'application/pdf', xml: 'application/xml', png: 'image/png', jpeg: 'image/jpeg' };

/** Dateiart anhand des Inhalts (nicht der Endung) */
export function detectFile(data: Uint8Array): FileKind | null {
  const b = Buffer.from(data.subarray(0, 1024));
  if (b.toString('latin1').includes('%PDF-')) return 'pdf';
  if (b.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return 'png';
  if (b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return 'jpeg';
  if (b.toString('utf8').replace(/^﻿/, '').trimStart().startsWith('<')) return 'xml';
  return null;
}

export async function findBySha(tenantId: number, hash: string) {
  return one<{ id: number }>('SELECT id FROM purchase_invoices WHERE tenant_id = ? AND file_sha256 = ? LIMIT 1', tenantId, hash);
}

/* ---------------- Lieferanten ---------------- */

const digits = (s: string) => s.replace(/[^0-9A-Z]/gi, '').toUpperCase();

/**
 * Lieferanten zur E-Rechnung finden (USt-IdNr., Steuernummer, Name) oder neu anlegen.
 * Eine bisher reine Kundenadresse wird dabei zu „Kunde & Lieferant“.
 */
export async function findOrCreateSupplier(t: Tenant, seller: IncomingParty): Promise<{ contact: Contact; created: boolean }> {
  const candidates = await all<Contact>('SELECT * FROM contacts WHERE tenant_id = ? ORDER BY archived, id', t.id);
  const vat = digits(seller.vatId);
  const name = seller.name.trim().toLowerCase();
  const match =
    (vat && candidates.find((c) => digits(c.vat_id) === vat))
    || (seller.taxNumber && candidates.find((c) => c.notes.includes(seller.taxNumber)))
    || candidates.find((c) => (c.company || c.name).trim().toLowerCase() === name && (!seller.zip || !c.zip || c.zip === seller.zip));
  if (match) {
    if (!isSupplier(match)) await run("UPDATE contacts SET kind = 'both', updated_at = ? WHERE id = ?", nowIso(), match.id);
    return { contact: (await getContact(t.id, match.id))!, created: false };
  }
  const vatId = normalizeVatId(seller.vatId);
  const notes = [
    seller.taxNumber ? `Steuernummer: ${seller.taxNumber}` : '',
    vatId && !isValidVatId(vatId) ? `USt-IdNr. laut E-Rechnung: ${seller.vatId}` : '',
    'Aus E-Rechnung angelegt.',
  ].filter(Boolean).join('\n');
  const id = await insertContact(t, 'supplier', {
    company: seller.name,
    name: seller.contactName,
    street: seller.street,
    address_extra: seller.addressExtra,
    zip: seller.zip.slice(0, 10),
    city: seller.city,
    country: isCountryCode(seller.country) ? seller.country : 'DE',
    email: isValidEmail(seller.email) ? seller.email : '',
    phone: seller.phone.slice(0, 50),
    vat_id: isValidVatId(vatId) ? vatId : '',
    notes,
  });
  return { contact: (await getContact(t.id, id))!, created: true };
}

/* ---------------- Anlegen ---------------- */

interface UploadedFile {
  name: string;
  data: Buffer;
  kind: FileKind;
}

async function insertPurchase(t: Tenant, userId: number, values: Record<string, string | number | null>): Promise<number> {
  const now = nowIso();
  const keys = Object.keys(values);
  const res = await run(
    `INSERT INTO purchase_invoices (tenant_id, ${keys.join(', ')}, created_by, created_at, updated_at)
     VALUES (?, ${keys.map(() => '?').join(', ')}, ?, ?, ?)`,
    t.id, ...keys.map((k) => values[k]), userId, now, now,
  );
  return res.insertId;
}

function fileColumns(file: UploadedFile, stored: { path: string; sha256: string; size: number }) {
  return { file_name: file.name.slice(0, 200), file_path: stored.path, file_mime: MIME[file.kind], file_size: stored.size, file_sha256: stored.sha256 };
}

/** Beleg ohne E-Rechnungsdaten: Datei ablegen, Angaben werden danach im Formular erfasst. */
export async function createFromUpload(t: Tenant, userId: number, file: UploadedFile): Promise<number> {
  const stored = await saveFile('verbindlichkeiten', t.id, file.name, file.data);
  try {
    return await insertPurchase(t, userId, { status: 'draft', category: DEFAULT_CATEGORY, ...fileColumns(file, stored) });
  } catch (err) {
    await removeStoredFile('verbindlichkeiten', stored.path);
    throw err;
  }
}

/** E-Rechnung übernehmen: Lieferant finden/anlegen, alle Angaben aus der XML. */
export async function createFromEInvoice(t: Tenant, userId: number, file: UploadedFile, inv: IncomingInvoice): Promise<{ id: number; supplierCreated: boolean }> {
  const stored = await saveFile('verbindlichkeiten', t.id, file.name, file.data);
  try {
    return await tx(async () => {
      const { contact, created } = await findOrCreateSupplier(t, inv.seller);
      const dup = await one<{ id: number }>(
        "SELECT id FROM purchase_invoices WHERE tenant_id = ? AND contact_id = ? AND number = ? AND number <> '' LIMIT 1",
        t.id, contact.id, inv.number,
      );
      if (dup) throw new UserError(`Die Rechnung ${inv.number} von ${contact.company || contact.name} ist bereits erfasst.`);
      const warnings = [...inv.warnings];
      if (inv.buyerName && !sameCompany(inv.buyerName, t.name)) warnings.push(`Rechnungsempfänger laut E-Rechnung ist „${inv.buyerName}“.`);
      const info: EInvoiceInfo = {
        syntax: inv.syntax, guideline: inv.guideline, typeCode: inv.typeCode, buyerName: inv.buyerName, buyerReference: inv.buyerReference,
        orderReference: inv.orderReference, periodFrom: inv.periodFrom, periodTo: inv.periodTo, seller: inv.seller,
        paymentTerms: inv.payment.terms, bic: inv.payment.bic, lines: inv.lines.slice(0, 1000), notes: inv.notes, warnings, taxes: inv.taxes,
      };
      const description = (inv.notes.find((n) => n.length <= 120) ?? inv.lines[0]?.name ?? '').slice(0, 300);
      const id = await insertPurchase(t, userId, {
        contact_id: contact.id,
        status: inv.due > 0 ? 'open' : 'paid',
        is_credit: inv.isCredit ? 1 : 0,
        number: inv.number.slice(0, 100),
        issue_date: inv.issueDate,
        due_date: inv.dueDate,
        service_date: inv.serviceDate ?? inv.periodTo,
        description,
        category: isExpenseCategory(contact.expense_category) ? contact.expense_category : DEFAULT_CATEGORY,
        currency: inv.currency.slice(0, 3),
        net_total: inv.net,
        tax_total: inv.tax,
        gross_total: inv.gross,
        prepaid_total: inv.gross - inv.due,
        iban: inv.payment.iban.slice(0, 40),
        payment_reference: (inv.payment.reference || inv.number).slice(0, 140),
        einvoice_format: inv.formatLabel.slice(0, 30),
        einvoice_data: JSON.stringify(info),
        ...fileColumns(file, stored),
      });
      await writeTaxes(id, inv.taxes.map((x) => ({ category: x.category, rate: x.rate, basis: x.basis, tax: x.tax })));
      return { id, supplierCreated: created };
    });
  } catch (err) {
    await removeStoredFile('verbindlichkeiten', stored.path);
    throw err;
  }
}

function sameCompany(a: string, b: string): boolean {
  const norm = (s: string) => s.toLowerCase().replace(/\b(gmbh|ug|ag|kg|e\.?\s?k\.?|ohg|gbr|mbh|co)\b|[^a-z0-9äöüß]/g, '');
  const x = norm(a);
  const y = norm(b);
  return !x || !y || x.includes(y) || y.includes(x);
}

/* ---------------- Formular ---------------- */

export interface PurchaseInput {
  contact_id: number | null;
  new_supplier: string;
  number: string;
  issue_date: string | null;
  due_date: string | null;
  description: string;
  category: string;
  sphere: string;
  is_credit: boolean;
  paid_at: string | null;
  taxes: PurchaseTax[];
}

const RATES = [1900, 700, 0];

/** Steuerzeile aus Netto/USt/Brutto: was fehlt, wird aus Satz und den übrigen Angaben berechnet. */
export function taxRow(rate: number, net: number | null, tax: number | null, gross: number | null): PurchaseTax | null {
  if (net === null && gross === null) return null;
  if (net !== null && tax !== null) return { category: rate ? 'S' : 'E', rate, basis: net, tax };
  if (net !== null) return { category: rate ? 'S' : 'E', rate, basis: net, tax: gross !== null ? gross - net : roundDiv(net * rate, 10000) };
  const g = gross!;
  const t = tax !== null ? tax : g - roundDiv(g * 10000, 10000 + rate);
  return { category: rate ? 'S' : 'E', rate, basis: g - t, tax: t };
}

/** Formular lesen. Für E-Rechnungen sind Lieferant, Nummer, Datum und Beträge fest (aus der XML). */
export function parsePurchaseForm(form: Form, locked: boolean): PurchaseInput {
  const errors: string[] = [];
  const optDate = (key: string, label: string) => {
    const v = str(form, key);
    if (!v) return null;
    if (!isIsoDate(v)) errors.push(`${label}: ungültiges Datum.`);
    return v;
  };
  const category = str(form, 'category');
  const input: PurchaseInput = {
    contact_id: Number(str(form, 'contact_id')) || null,
    new_supplier: str(form, 'new_supplier', 200),
    number: str(form, 'number', 100),
    issue_date: optDate('issue_date', 'Rechnungsdatum'),
    due_date: optDate('due_date', 'Fällig am'),
    description: str(form, 'description', 300),
    category: isExpenseCategory(category) ? category : DEFAULT_CATEGORY,
    sphere: isSphere(str(form, 'sphere')) ? str(form, 'sphere') : '',
    is_credit: str(form, 'is_credit') === '1',
    paid_at: optDate('paid_at', 'Bezahlt am'),
    taxes: [],
  };
  if (!locked) {
    if (!input.contact_id && !input.new_supplier) errors.push('Bitte einen Lieferanten wählen oder neu eintragen.');
    if (!input.issue_date) errors.push('Bitte das Rechnungsdatum angeben.');
    const rates = list(form, 'tax_rate');
    const nets = list(form, 'tax_net');
    const taxes = list(form, 'tax_tax');
    const grosses = list(form, 'tax_gross');
    rates.forEach((r, i) => {
      const rate = Number(r);
      const val = (v: string | undefined) => (v && v.trim() ? parseDecimal(v, 2) : null);
      const raw = [nets[i], taxes[i], grosses[i]];
      const [n, t, g] = raw.map(val);
      if (raw.some((v, j) => v && v.trim() && [n, t, g][j] === null)) {
        errors.push(`Betragszeile ${i + 1}: ungültiger Betrag.`);
        return;
      }
      if (!RATES.includes(rate)) {
        errors.push(`Betragszeile ${i + 1}: ungültiger Steuersatz.`);
        return;
      }
      const row = taxRow(rate, n, t, g);
      if (row && (row.basis || row.tax)) input.taxes.push(row);
    });
    if (!input.taxes.length) errors.push('Bitte mindestens einen Betrag erfassen.');
    if (input.taxes.some((x) => x.basis < 0 || x.tax < 0)) errors.push('Beträge bitte positiv erfassen – für Gutschriften „Gutschrift“ ankreuzen.');
  }
  if (input.issue_date && input.due_date && input.due_date < input.issue_date) errors.push('Das Fälligkeitsdatum liegt vor dem Rechnungsdatum.');
  if (errors.length) throw new UserError(errors.join(' '));
  return input;
}

/** Lieferant aus dem Formular: gewählt oder als neue, minimale Adresse anlegen */
async function resolveSupplier(t: Tenant, input: PurchaseInput): Promise<number> {
  if (input.contact_id) {
    const c = await getContact(t.id, input.contact_id);
    if (!c) throw new UserError('Bitte einen Lieferanten wählen.');
    if (!isSupplier(c)) await run("UPDATE contacts SET kind = 'both', updated_at = ? WHERE id = ?", nowIso(), c.id);
    return c.id;
  }
  const existing = await one<{ id: number; kind: string }>(
    "SELECT id, kind FROM contacts WHERE tenant_id = ? AND LOWER(COALESCE(NULLIF(company, ''), name)) = LOWER(?) ORDER BY archived, id LIMIT 1",
    t.id, input.new_supplier,
  );
  if (existing) {
    if (existing.kind === 'customer') await run("UPDATE contacts SET kind = 'both', updated_at = ? WHERE id = ?", nowIso(), existing.id);
    return existing.id;
  }
  return insertContact(t, 'supplier', { company: input.new_supplier });
}

/** Neu anlegen (ohne Datei) oder einen Beleg speichern. Liefert die ID. */
export async function savePurchase(t: Tenant, userId: number, existing: Purchase | null, input: PurchaseInput): Promise<number> {
  const locked = !!existing?.einvoice_format;
  return tx(async () => {
    const status = input.paid_at ? 'paid' : existing && existing.status !== 'draft' && locked && payable(existing) <= 0 ? 'paid' : 'open';
    const common = {
      description: input.description,
      category: input.category,
      sphere: input.sphere,
      due_date: input.due_date,
      paid_at: input.paid_at,
      status,
    };
    let id: number;
    let contactId: number;
    if (locked && existing) {
      id = existing.id;
      contactId = existing.contact_id!;
      await run(
        `UPDATE purchase_invoices SET ${Object.keys(common).map((k) => `${k} = ?`).join(', ')}, updated_at = ? WHERE id = ?`,
        ...Object.values(common), nowIso(), id,
      );
    } else {
      contactId = await resolveSupplier(t, input);
      if (input.number) {
        const dup = await one<{ id: number }>(
          'SELECT id FROM purchase_invoices WHERE tenant_id = ? AND contact_id = ? AND number = ? AND id <> ? LIMIT 1',
          t.id, contactId, input.number, existing?.id ?? 0,
        );
        if (dup) throw new UserError(`Die Rechnungsnummer ${input.number} ist für diesen Lieferanten bereits erfasst.`);
      }
      const net = input.taxes.reduce((s, x) => s + x.basis, 0);
      const tax = input.taxes.reduce((s, x) => s + x.tax, 0);
      const values = {
        ...common,
        contact_id: contactId,
        number: input.number,
        issue_date: input.issue_date,
        is_credit: input.is_credit ? 1 : 0,
        net_total: net,
        tax_total: tax,
        gross_total: net + tax,
      };
      if (existing) {
        id = existing.id;
        await run(
          `UPDATE purchase_invoices SET ${Object.keys(values).map((k) => `${k} = ?`).join(', ')}, updated_at = ? WHERE id = ? AND tenant_id = ?`,
          ...Object.values(values), nowIso(), id, t.id,
        );
      } else {
        id = await insertPurchase(t, userId, values);
      }
      await writeTaxes(id, input.taxes);
    }
    // Kostenart als Vorschlag für die nächste Rechnung dieses Lieferanten merken
    await run('UPDATE contacts SET expense_category = ? WHERE id = ?', input.category, contactId);
    return id;
  });
}

export async function setPaid(p: Purchase, paidAt: string | null) {
  await run(
    'UPDATE purchase_invoices SET status = ?, paid_at = ?, updated_at = ? WHERE id = ?',
    paidAt ? 'paid' : 'open', paidAt, nowIso(), p.id,
  );
}

export async function deletePurchase(p: Purchase) {
  await run('DELETE FROM purchase_invoices WHERE id = ?', p.id);
  if (p.file_path) await removeStoredFile('verbindlichkeiten', p.file_path);
}

/** Vorgaben für eine neue, manuelle Erfassung */
export function emptyInput(contact?: Contact): PurchaseInput {
  return {
    contact_id: contact?.id ?? null,
    new_supplier: '',
    number: '',
    issue_date: today(),
    due_date: null,
    description: '',
    category: contact && isExpenseCategory(contact.expense_category) ? contact.expense_category : DEFAULT_CATEGORY,
    sphere: '',
    is_credit: false,
    paid_at: null,
    taxes: [],
  };
}

export function purchaseToInput(p: Purchase, taxes: PurchaseTax[]): PurchaseInput {
  return {
    contact_id: p.contact_id,
    new_supplier: '',
    number: p.number,
    issue_date: p.issue_date ?? (p.status === 'draft' ? today() : null),
    due_date: p.due_date,
    description: p.description,
    category: p.category,
    sphere: p.sphere,
    is_credit: !!p.is_credit,
    paid_at: p.paid_at,
    taxes,
  };
}

export { sha256, addDays };
