import { calculate, type CalculatedItem, type TaxGroup, type TaxMode } from '../lib/calc.ts';
import { formatDate } from '../lib/dates.ts';
import { formatMoney } from '../lib/money.ts';
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

export interface DocumentData {
  version: 1;
  kind: 'quote' | 'invoice';
  typeCode: '380' | '381';
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
  paymentTerms: string;
  draft: boolean;
}

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

export function paymentTermsText(d: Pick<DocumentData, 'typeCode' | 'dueDate' | 'gross' | 'issueDate'>): string {
  if (d.typeCode === '381') return 'Der Betrag wird Ihnen erstattet bzw. verrechnet.';
  if (!d.dueDate) return 'Zahlbar sofort ohne Abzug.';
  if (d.dueDate === d.issueDate) return 'Zahlbar sofort ohne Abzug.';
  return `Bitte überweisen Sie den Betrag von ${formatMoney(d.gross)} bis zum ${formatDate(d.dueDate)} ohne Abzug.`;
}

export function buildDocumentData(opts: {
  tenant: Tenant;
  contact: Contact;
  doc: Doc;
  items: Item[];
  number: string;
  draft: boolean;
  precedingInvoice?: { number: string; issueDate: string } | null;
}): DocumentData {
  const { tenant, contact, doc, items } = opts;
  const totals = calculate(
    items.map((i) => ({ title: i.title, description: i.description, quantity: i.quantity, unit: i.unit, unitPrice: i.unit_price, vatRate: i.vat_rate, articleNumber: i.article_number || undefined })),
    doc.tax_mode,
  );
  const buyer = buyerFromContact(contact);
  const base = {
    typeCode: (doc.type_code === '381' ? '381' : '380') as '380' | '381',
    dueDate: doc.due_date,
    gross: totals.gross,
    issueDate: doc.issue_date,
  };
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
  return p;
}

/** Hinweise, die nur die XRechnung betreffen (z. B. für öffentliche Auftraggeber). */
export function xrechnungWarnings(d: DocumentData): string[] {
  const w: string[] = [];
  if (!d.buyer.email) w.push('Für XRechnung 3.0 ist eine E-Mail-Adresse des Kunden vorgeschrieben (elektronische Adresse).');
  return w;
}
