import { calculate, type CalculatedItem, type TaxGroup, type TaxMode } from '../lib/calc.ts';
import { addDays, formatDate } from '../lib/dates.ts';
import { formatMoney, formatRate, roundDiv } from '../lib/money.ts';
import type { Tenant } from '../types.ts';
import type { Contact } from '../modules/contacts.ts';
import type { Doc, Item } from '../modules/documents/repo.ts';

/**
 * Vollständige, in sich geschlossene Belegdaten. Beim Festschreiben einer Rechnung
 * wird genau dieses Objekt als JSON gespeichert – spätere Änderungen an Adresse oder
 * Firmendaten verändern die Rechnung dadurch nicht mehr (GoBD).
 */
export interface Party {
  name: string;
  contactName: string;
  street: string;
  addressExtra: string;
  zip: string;
  city: string;
  country: string;
  email: string;
  phone: string;
  vatId: string;
  taxNumber: string;
}

export interface Seller extends Party {
  website: string;
  bankName: string;
  iban: string;
  bic: string;
  registerCourt: string;
  registerNumber: string;
  managingDirectors: string;
}

export interface Buyer extends Party {
  customerNumber: string;
  leitwegId: string;
}

/**
 * Rechnungsarten (BT-3, UNTDID 1001) – alle von XRechnung (BR-DE-17) und ZUGFeRD zugelassen.
 * 875–877 sind die Bau-/Projektrechnungen nach VOB: Teilrechnung, Teilschlussrechnung, Schlussrechnung.
 */
export const INVOICE_TYPES = {
  '380': 'Rechnung',
  '875': 'Teilrechnung',
  '876': 'Teilschlussrechnung',
  '877': 'Schlussrechnung',
  '381': 'Stornorechnung',
} as const;
export type InvoiceTypeCode = keyof typeof INVOICE_TYPES;
/** Rechnungsarten, die man beim Anlegen wählen kann (Storno entsteht nur über „Stornieren“) */
export const SELECTABLE_TYPES: InvoiceTypeCode[] = ['380', '875', '876', '877'];
/** Rechnungsarten, die vorherige Teilrechnungen abziehen können */
export const FINAL_TYPES: InvoiceTypeCode[] = ['876', '877'];

export function isInvoiceType(v: string): v is InvoiceTypeCode {
  return v in INVOICE_TYPES;
}

export interface Prepayment {
  number: string;
  issueDate: string;
  net: number;
  tax: number;
  gross: number;
}

export interface Skonto {
  percent: number; // Basispunkte (2 % = 200)
  days: number;
  /** Zahlungsziel mit Skonto */
  date: string;
  /** Skontobetrag in Cent, bezogen auf den Zahlbetrag */
  amount: number;
}

export interface DocumentData {
  version: 1;
  kind: 'quote' | 'invoice';
  typeCode: InvoiceTypeCode;
  number: string;
  issueDate: string;
  validUntil: string | null;
  dueDate: string | null;
  serviceDate: string | null;
  serviceFrom: string | null;
  serviceTo: string | null;
  subject: string;
  intro: string;
  outro: string;
  buyerReference: string;
  orderReference: string;
  precedingInvoice: { number: string; issueDate: string } | null;
  taxMode: TaxMode;
  exemptionReason: string;
  currency: 'EUR';
  seller: Seller;
  buyer: Buyer;
  items: CalculatedItem[];
  taxes: TaxGroup[];
  net: number;
  tax: number;
  gross: number;
  /** abgezogene Teilrechnungen (nur 876/877) – fehlt in älteren Snapshots */
  prepayments?: Prepayment[];
  prepaid?: number;
  /** Zahlbetrag = gross − prepaid */
  due?: number;
  skonto?: Skonto | null;
  /** angehängte Nachweisdokumentationen (Bezeichnung + Dateiname) */
  proofs?: { name: string; filename: string }[];
  paymentTerms: string;
  draft: boolean;
}

export const dueAmount = (d: Pick<DocumentData, 'gross' | 'due'>) => d.due ?? d.gross;

export function sellerFromTenant(t: Tenant): Seller {
  return {
    name: t.name,
    contactName: t.contact_name,
    street: t.street,
    addressExtra: '',
    zip: t.zip,
    city: t.city,
    country: t.country || 'DE',
    email: t.email,
    phone: t.phone,
    vatId: t.vat_id,
    taxNumber: t.tax_number,
    website: t.website,
    bankName: t.bank_name,
    iban: t.iban,
    bic: t.bic,
    registerCourt: t.register_court,
    registerNumber: t.register_number,
    managingDirectors: t.managing_directors,
  };
}

export function buyerFromContact(c: Contact): Buyer {
  return {
    name: c.company || c.name,
    contactName: c.company ? c.name : '',
    street: c.street,
    addressExtra: c.address_extra,
    zip: c.zip,
    city: c.city,
    country: c.country || 'DE',
    email: c.email,
    phone: c.phone,
    vatId: c.vat_id,
    taxNumber: '',
    customerNumber: c.customer_number,
    leitwegId: c.leitweg_id,
  };
}

/** Pflichthinweis zur Steuerbefreiung (wird auf PDF und im XML ausgegeben). */
export function exemptionText(mode: TaxMode, custom: string): string {
  switch (mode) {
    case 'small_business':
      return 'Gemäß § 19 UStG wird keine Umsatzsteuer berechnet (Kleinunternehmerregelung).';
    case 'reverse_charge':
      return 'Steuerschuldnerschaft des Leistungsempfängers (§ 13b UStG).';
    case 'exempt':
      return custom || 'Steuerfreie Leistung.';
    default:
      return '';
  }
}

export function paymentTermsText(d: { typeCode: string; dueDate: string | null; due: number; issueDate: string; skonto?: Skonto | null }): string {
  if (d.typeCode === '381') return 'Der Betrag wird Ihnen erstattet bzw. verrechnet.';
  if (d.due <= 0) return 'Der Rechnungsbetrag ist durch die abgezogenen Teilrechnungen bereits ausgeglichen.';
  const net = !d.dueDate || d.dueDate === d.issueDate ? 'sofort ohne Abzug' : `bis zum ${formatDate(d.dueDate)} ohne Abzug`;
  if (d.skonto) {
    return `Bei Zahlung bis zum ${formatDate(d.skonto.date)} gewähren wir ${formatRate(d.skonto.percent)} Skonto (${formatMoney(d.skonto.amount)}), `
      + `Sie überweisen dann ${formatMoney(d.due - d.skonto.amount)}. Andernfalls ist der Betrag von ${formatMoney(d.due)} ${net} zahlbar.`;
  }
  if (net.startsWith('sofort')) return `Zahlbar ${net}.`;
  return `Bitte überweisen Sie den Betrag von ${formatMoney(d.due)} ${net}.`;
}

/** Skonto als strukturierte Angabe für XRechnung (BR-DE-18): #SKONTO#TAGE=10#PROZENT=2.00# */
export function skontoCode(s: Skonto): string {
  return `#SKONTO#TAGE=${s.days}#PROZENT=${bpToDecimal2(s.percent)}#`;
}

function bpToDecimal2(bp: number): string {
  return `${Math.floor(bp / 100)}.${String(bp % 100).padStart(2, '0')}`;
}

export function buildDocumentData(opts: {
  tenant: Tenant;
  contact: Contact;
  doc: Doc;
  items: Item[];
  number: string;
  draft: boolean;
  precedingInvoice?: { number: string; issueDate: string } | null;
  prepayments?: Prepayment[];
  proofs?: { name: string; filename: string }[];
}): DocumentData {
  const { tenant, contact, doc, items } = opts;
  const totals = calculate(
    items.map((i) => ({ title: i.title, description: i.description, quantity: i.quantity, unit: i.unit, unitPrice: i.unit_price, vatRate: i.vat_rate, articleNumber: i.article_number || undefined })),
    doc.tax_mode,
  );
  const buyer = buyerFromContact(contact);
  const typeCode: InvoiceTypeCode = isInvoiceType(doc.type_code) ? doc.type_code : '380';
  const prepayments = FINAL_TYPES.includes(typeCode) ? (opts.prepayments ?? []) : [];
  const prepaid = prepayments.reduce((s, p) => s + p.gross, 0);
  const due = totals.gross - prepaid;
  const skonto: Skonto | null = doc.kind === 'invoice' && typeCode !== '381' && doc.skonto_percent > 0 && doc.skonto_days > 0 && due > 0
    ? {
        percent: doc.skonto_percent,
        days: doc.skonto_days,
        date: addDays(doc.issue_date, doc.skonto_days),
        amount: roundDiv(due * doc.skonto_percent, 10000),
      }
    : null;
  const base = { typeCode, dueDate: doc.due_date, gross: totals.gross, due, issueDate: doc.issue_date, skonto };
  return {
    version: 1,
    kind: doc.kind,
    ...base,
    number: opts.number,
    validUntil: doc.valid_until,
    serviceDate: doc.service_date,
    serviceFrom: doc.service_from,
    serviceTo: doc.service_to,
    subject: doc.subject,
    intro: doc.intro,
    outro: doc.outro,
    buyerReference: doc.buyer_reference || buyer.leitwegId,
    orderReference: doc.order_reference,
    precedingInvoice: opts.precedingInvoice ?? null,
    taxMode: doc.tax_mode,
    exemptionReason: exemptionText(doc.tax_mode, doc.exemption_reason),
    currency: 'EUR',
    seller: sellerFromTenant(tenant),
    buyer,
    items: totals.items,
    taxes: totals.taxes,
    net: totals.net,
    tax: totals.tax,
    gross: totals.gross,
    prepayments,
    prepaid,
    skonto,
    proofs: opts.proofs ?? [],
    paymentTerms: paymentTermsText(base),
    draft: opts.draft,
  };
}

/**
 * Prüfung vor dem Festschreiben: deutsche Pflichtangaben (§ 14 Abs. 4 UStG)
 * und die Pflichtfelder von EN 16931 / XRechnung.
 */
export function checkInvoice(d: DocumentData): string[] {
  const p: string[] = [];
  const s = d.seller;
  const b = d.buyer;
  if (!d.items.length) p.push('Die Rechnung hat keine Positionen.');
  if (!s.name || !s.street || !s.zip || !s.city) p.push('Firmenanschrift unvollständig (Einstellungen).');
  if (!s.taxNumber && !s.vatId) p.push('Steuernummer fehlt (Einstellungen). Alternativ genügt die USt-IdNr.');
  if (!s.contactName || !s.phone || !s.email) p.push('Ansprechpartner, Telefon und E-Mail der Firma sind für XRechnung Pflicht (Einstellungen).');
  if (!s.iban) p.push('IBAN fehlt (Einstellungen).');
  if (!b.name || !b.street || !b.zip || !b.city) p.push('Anschrift des Kunden unvollständig.');
  if (!d.serviceDate && !(d.serviceFrom && d.serviceTo)) p.push('Leistungsdatum oder Leistungszeitraum fehlt (§ 14 Abs. 4 Nr. 6 UStG).');
  if (d.taxMode === 'reverse_charge' && !b.vatId) p.push('Für § 13b UStG wird die USt-IdNr. des Kunden benötigt.');
  if (d.taxMode === 'reverse_charge' && !s.vatId) p.push('Für § 13b UStG wird die eigene USt-IdNr. benötigt.');
  if (d.taxMode === 'exempt' && !d.exemptionReason) p.push('Bitte den Grund der Steuerbefreiung angeben.');
  if (d.gross < 0) p.push('Der Rechnungsbetrag darf nicht negativ sein – bitte eine Stornorechnung verwenden.');
  if (d.due !== undefined && d.due < 0) p.push('Die abgezogenen Teilrechnungen übersteigen den Rechnungsbetrag.');
  if (d.skonto && d.dueDate && d.skonto.date > d.dueDate) p.push('Die Skontofrist endet nach dem Fälligkeitsdatum.');
  return p;
}

/** Hinweise, die nur die XRechnung betreffen (z. B. für öffentliche Auftraggeber). */
export function xrechnungWarnings(d: DocumentData): string[] {
  const w: string[] = [];
  if (!d.buyer.email) w.push('Für XRechnung 3.0 ist eine E-Mail-Adresse des Kunden vorgeschrieben (elektronische Adresse).');
  return w;
}
