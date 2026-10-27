import { XMLParser } from 'fast-xml-parser';
import { PDFDocument, PDFDict, PDFName, PDFRawStream, PDFRef, PDFString, PDFHexString, decodePDFRawStream } from 'pdf-lib';
import { parseDecimal } from '../lib/money.ts';
import { normalizeIban } from '../lib/validate.ts';

/**
 * Eingehende E-Rechnungen lesen (EN 16931):
 *  - UN/CEFACT CII – XRechnung (CII), ZUGFeRD 2.x / Factur-X (in der PDF eingebettet)
 *  - OASIS UBL 2.1 – XRechnung (UBL), Invoice und CreditNote
 *
 * Übernommen wird, was für die Erfassung als Verbindlichkeit nötig ist: Lieferant, Nummer,
 * Daten, Beträge je Steuersatz, Zahlungsangaben und die Positionen (nur zur Anzeige).
 * Eine vollständige Schematron-Prüfung (KoSIT) ersetzt das nicht – offensichtliche
 * Unstimmigkeiten (Summen, Pflichtangaben) werden aber als Hinweis ausgegeben.
 */

export interface IncomingParty {
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

export interface IncomingTax {
  /** EN 16931 Steuerkategorie (S, Z, E, AE, K, G, O, L, M) */
  category: string;
  /** Basispunkte (19 % = 1900) */
  rate: number;
  basis: number;
  tax: number;
  exemptionReason?: string;
}

export interface IncomingLine {
  id: string;
  name: string;
  quantity: number;
  unit: string;
  unitPrice: number | null;
  net: number;
  rate: number | null;
}

export interface IncomingInvoice {
  syntax: 'CII' | 'UBL';
  /** z. B. "XRechnung (UBL)" oder "ZUGFeRD (EN 16931)" */
  formatLabel: string;
  guideline: string;
  typeCode: string;
  isCredit: boolean;
  number: string;
  issueDate: string;
  dueDate: string | null;
  serviceDate: string | null;
  periodFrom: string | null;
  periodTo: string | null;
  currency: string;
  seller: IncomingParty;
  buyerName: string;
  buyerReference: string;
  orderReference: string;
  payment: { iban: string; bic: string; reference: string; terms: string };
  taxes: IncomingTax[];
  net: number;
  tax: number;
  gross: number;
  prepaid: number;
  due: number;
  lines: IncomingLine[];
  notes: string[];
  warnings: string[];
}

export class EInvoiceError extends Error {}

/* ---------------- Hilfen ---------------- */

type X = any;

const parser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: '@_',
  removeNSPrefix: true,
  parseTagValue: false,
  parseAttributeValue: false,
  trimValues: true,
  processEntities: true,
  htmlEntities: false,
});

const arr = <T = X>(v: T | T[] | undefined | null): T[] => (v === undefined || v === null ? [] : Array.isArray(v) ? v : [v]);

/** Text eines Elements (auch mit Attributen) */
function text(v: X): string {
  if (v === undefined || v === null) return '';
  if (Array.isArray(v)) return text(v[0]);
  if (typeof v === 'object') return text(v['#text']);
  return String(v).trim();
}

const attr = (v: X, name: string): string => (v && typeof v === 'object' && !Array.isArray(v) ? String(v[`@_${name}`] ?? '') : '');

function cents(v: X): number {
  const n = parseDecimal(text(v), 2);
  return n ?? 0;
}

function optCents(v: X): number | null {
  const s = text(v);
  return s === '' ? null : parseDecimal(s, 2);
}

/** Datum: CII Format 102 (JJJJMMTT) bzw. UBL JJJJ-MM-TT → ISO */
function date(v: X): string | null {
  const s = text(v).replace(/\s/g, '');
  let m = /^(\d{4})(\d{2})(\d{2})$/.exec(s);
  if (!m) m = /^(\d{4})-(\d{2})-(\d{2})/.exec(s);
  if (!m) return null;
  const iso = `${m[1]}-${m[2]}-${m[3]}`;
  return Number.isNaN(Date.parse(iso)) ? null : iso;
}

/** Steuersatz in Basispunkten */
function rate(v: X): number | null {
  const s = text(v);
  return s === '' ? null : parseDecimal(s, 2);
}

/** Basispunkte bei fehlender Aufschlüsselung aus Netto und Steuer ableiten (bevorzugt 19 % / 7 %) */
function guessRate(net: number, tax: number): number {
  if (!net || !tax) return 0;
  for (const r of [1900, 700]) if (Math.abs(Math.round((net * r) / 10000) - tax) <= 1) return r;
  return Math.round((tax / net) * 10000);
}

function emptyParty(): IncomingParty {
  return { name: '', contactName: '', street: '', addressExtra: '', zip: '', city: '', country: '', email: '', phone: '', vatId: '', taxNumber: '' };
}

/* ---------------- Einstieg ---------------- */

export function looksLikeXml(data: Uint8Array): boolean {
  const head = Buffer.from(data.subarray(0, 300)).toString('utf8').replace(/^﻿/, '').trimStart();
  return head.startsWith('<');
}

export function isPdf(data: Uint8Array): boolean {
  return Buffer.from(data.subarray(0, 1024)).toString('latin1').includes('%PDF-');
}

/** XML-Text einer E-Rechnung lesen. Wirft EInvoiceError, wenn es keine (lesbare) Rechnung ist. */
export function parseInvoiceXml(xml: string): IncomingInvoice {
  const src = xml.replace(/^﻿/, '');
  // Keine DTDs/Entitäten (XXE, „billion laughs“) – in E-Rechnungen ohnehin nicht zulässig
  if (/<!DOCTYPE|<!ENTITY/i.test(src)) throw new EInvoiceError('Die XML-Datei enthält eine DTD – das ist in E-Rechnungen nicht zulässig.');
  let doc: X;
  try {
    doc = parser.parse(src);
  } catch {
    throw new EInvoiceError('Die XML-Datei ist nicht wohlgeformt.');
  }
  if (doc?.CrossIndustryInvoice) return fromCii(doc.CrossIndustryInvoice);
  if (doc?.Invoice) return fromUbl(doc.Invoice, false);
  if (doc?.CreditNote) return fromUbl(doc.CreditNote, true);
  throw new EInvoiceError('Keine E-Rechnung erkannt (weder CII noch UBL).');
}

function formatLabel(guideline: string, syntax: 'CII' | 'UBL', fromPdf: boolean): string {
  const g = guideline.toLowerCase();
  if (g.includes('xrechnung')) return `XRechnung (${syntax})`;
  const profile = g.includes('minimum') ? 'MINIMUM' : g.includes('basicwl') ? 'BASIC WL' : g.includes('basic') ? 'BASIC'
    : g.includes('extended') ? 'EXTENDED' : g.includes('xrechnung') ? 'XRechnung' : 'EN 16931';
  if (fromPdf || g.includes('factur-x') || g.includes('zugferd')) return `ZUGFeRD (${profile})`;
  return syntax === 'UBL' ? 'E-Rechnung (UBL)' : `E-Rechnung (CII, ${profile})`;
}

/* ---------------- CII ---------------- */

function ciiParty(p: X): IncomingParty {
  if (!p) return emptyParty();
  const a = p.PostalTradeAddress ?? {};
  const contact = arr(p.DefinedTradeContact)[0] ?? {};
  const regs = arr(p.SpecifiedTaxRegistration).map((r: X) => ({ id: text(r?.ID), scheme: attr(r?.ID, 'schemeID') }));
  return {
    name: text(p.Name) || text(p.SpecifiedLegalOrganization?.TradingBusinessName),
    contactName: text(contact.PersonName) || text(contact.DepartmentName),
    street: text(a.LineOne),
    addressExtra: [text(a.LineTwo), text(a.LineThree)].filter(Boolean).join(', '),
    zip: text(a.PostcodeCode),
    city: text(a.CityName),
    country: text(a.CountryID).toUpperCase(),
    email: text(contact.EmailURIUniversalCommunication?.URIID) || text(p.URIUniversalCommunication?.URIID),
    phone: text(contact.TelephoneUniversalCommunication?.CompleteNumber),
    vatId: regs.find((r) => r.scheme === 'VA')?.id ?? '',
    taxNumber: regs.find((r) => r.scheme === 'FC')?.id ?? '',
  };
}

function fromCii(root: X): IncomingInvoice {
  const guideline = text(arr(root.ExchangedDocumentContext?.GuidelineSpecifiedDocumentContextParameter)[0]?.ID);
  const ed = root.ExchangedDocument ?? {};
  const tx = root.SupplyChainTradeTransaction ?? {};
  const agreement = tx.ApplicableHeaderTradeAgreement ?? {};
  const delivery = tx.ApplicableHeaderTradeDelivery ?? {};
  const settlement = tx.ApplicableHeaderTradeSettlement ?? {};
  const currency = text(settlement.InvoiceCurrencyCode) || 'EUR';
  const sums = settlement.SpecifiedTradeSettlementHeaderMonetarySummation ?? {};
  // TaxTotalAmount kann zweimal vorkommen (Rechnungs- und Buchungswährung)
  const taxTotals = arr(sums.TaxTotalAmount);
  const taxTotal = taxTotals.find((t: X) => !attr(t, 'currencyID') || attr(t, 'currencyID') === currency) ?? taxTotals[0];

  const taxes: IncomingTax[] = arr(settlement.ApplicableTradeTax).map((t: X) => ({
    category: text(t.CategoryCode) || 'S',
    rate: rate(t.RateApplicablePercent) ?? 0,
    basis: cents(t.BasisAmount),
    tax: cents(t.CalculatedAmount),
    exemptionReason: text(t.ExemptionReason) || undefined,
  }));

  const means = arr(settlement.SpecifiedTradeSettlementPaymentMeans);
  const account = means.map((m: X) => m.PayeePartyCreditorFinancialAccount).find(Boolean) ?? {};
  const bank = means.map((m: X) => m.PayeeSpecifiedCreditorFinancialInstitution).find(Boolean) ?? {};
  const terms = arr(settlement.SpecifiedTradePaymentTerms);
  const period = settlement.BillingSpecifiedPeriod ?? {};

  const lines: IncomingLine[] = arr(tx.IncludedSupplyChainTradeLineItem).map((l: X, i: number) => {
    const qty = l.SpecifiedLineTradeDelivery?.BilledQuantity;
    const lineTax = arr(l.SpecifiedLineTradeSettlement?.ApplicableTradeTax)[0];
    return {
      id: text(l.AssociatedDocumentLineDocument?.LineID) || String(i + 1),
      name: text(l.SpecifiedTradeProduct?.Name),
      quantity: parseDecimal(text(qty), 3) ?? 0,
      unit: attr(qty, 'unitCode'),
      unitPrice: optCents(l.SpecifiedLineTradeAgreement?.NetPriceProductTradePrice?.ChargeAmount),
      net: cents(l.SpecifiedLineTradeSettlement?.SpecifiedTradeSettlementLineMonetarySummation?.LineTotalAmount),
      rate: rate(lineTax?.RateApplicablePercent),
    };
  });

  return finish({
    syntax: 'CII',
    formatLabel: '',
    guideline,
    typeCode: text(ed.TypeCode) || '380',
    isCredit: false,
    number: text(ed.ID),
    issueDate: date(ed.IssueDateTime?.DateTimeString) ?? '',
    dueDate: terms.map((t: X) => date(t.DueDateDateTime?.DateTimeString)).find(Boolean) ?? null,
    serviceDate: date(delivery.ActualDeliverySupplyChainEvent?.OccurrenceDateTime?.DateTimeString),
    periodFrom: date(period.StartDateTime?.DateTimeString),
    periodTo: date(period.EndDateTime?.DateTimeString),
    currency,
    seller: ciiParty(agreement.SellerTradeParty),
    buyerName: text(agreement.BuyerTradeParty?.Name),
    buyerReference: text(agreement.BuyerReference),
    orderReference: text(agreement.BuyerOrderReferencedDocument?.IssuerAssignedID),
    payment: {
      iban: normalizeIban(text(account.IBANID) || text(account.ProprietaryID)),
      bic: text(bank.BICID),
      reference: text(settlement.PaymentReference),
      terms: terms.map((t: X) => text(t.Description)).filter(Boolean).join(' '),
    },
    taxes,
    net: cents(sums.TaxBasisTotalAmount),
    tax: cents(taxTotal),
    gross: cents(sums.GrandTotalAmount),
    prepaid: cents(sums.TotalPrepaidAmount),
    due: optCents(sums.DuePayableAmount) ?? cents(sums.GrandTotalAmount),
    lineTotal: optCents(sums.LineTotalAmount),
    lines,
    notes: arr(ed.IncludedNote).map((n: X) => text(n.Content)).filter(Boolean),
    warnings: [],
  });
}

/* ---------------- UBL ---------------- */

function ublParty(p: X): IncomingParty {
  if (!p) return emptyParty();
  const a = p.PostalAddress ?? {};
  const contact = p.Contact ?? {};
  const schemes = arr(p.PartyTaxScheme).map((s: X) => ({ id: text(s.CompanyID), scheme: text(s.TaxScheme?.ID).toUpperCase() }));
  return {
    // rechtlicher Name (BT-27) vor Handelsname (BT-28) – wie bei CII
    name: text(p.PartyLegalEntity?.RegistrationName) || text(arr(p.PartyName)[0]?.Name),
    contactName: text(contact.Name),
    street: text(a.StreetName),
    addressExtra: [text(a.AdditionalStreetName), text(a.AddressLine?.Line)].filter(Boolean).join(', '),
    zip: text(a.PostalZone),
    city: text(a.CityName),
    country: text(a.Country?.IdentificationCode).toUpperCase(),
    email: text(contact.ElectronicMail) || (attr(p.EndpointID, 'schemeID') === 'EM' ? text(p.EndpointID) : ''),
    phone: text(contact.Telephone),
    vatId: schemes.find((s) => s.scheme === 'VAT')?.id ?? '',
    taxNumber: schemes.find((s) => s.scheme !== 'VAT')?.id ?? '',
  };
}

function fromUbl(root: X, creditNote: boolean): IncomingInvoice {
  const currency = text(root.DocumentCurrencyCode) || 'EUR';
  const taxTotals = arr(root.TaxTotal);
  const mainTax = taxTotals.find((t: X) => arr(t.TaxSubtotal).length) ?? taxTotals.find((t: X) => attr(t.TaxAmount, 'currencyID') === currency) ?? taxTotals[0] ?? {};
  const taxes: IncomingTax[] = arr(mainTax.TaxSubtotal).map((s: X) => ({
    category: text(s.TaxCategory?.ID) || 'S',
    rate: rate(s.TaxCategory?.Percent) ?? 0,
    basis: cents(s.TaxableAmount),
    tax: cents(s.TaxAmount),
    exemptionReason: text(s.TaxCategory?.TaxExemptionReason) || undefined,
  }));
  const totals = root.LegalMonetaryTotal ?? {};
  const means = arr(root.PaymentMeans);
  const account = means.map((m: X) => m.PayeeFinancialAccount).find(Boolean) ?? {};
  const period = arr(root.InvoicePeriod)[0] ?? {};
  const lineKey = creditNote ? 'CreditNoteLine' : 'InvoiceLine';
  const lines: IncomingLine[] = arr(root[lineKey]).map((l: X, i: number) => {
    const qty = creditNote ? l.CreditedQuantity : l.InvoicedQuantity;
    return {
      id: text(l.ID) || String(i + 1),
      name: text(l.Item?.Name),
      quantity: parseDecimal(text(qty), 3) ?? 0,
      unit: attr(qty, 'unitCode'),
      unitPrice: optCents(l.Price?.PriceAmount),
      net: cents(l.LineExtensionAmount),
      rate: rate(l.Item?.ClassifiedTaxCategory?.Percent),
    };
  });
  const gross = cents(totals.TaxInclusiveAmount);
  return finish({
    syntax: 'UBL',
    formatLabel: '',
    guideline: text(root.CustomizationID),
    typeCode: text(creditNote ? root.CreditNoteTypeCode : root.InvoiceTypeCode) || (creditNote ? '381' : '380'),
    isCredit: creditNote,
    number: text(root.ID),
    issueDate: date(root.IssueDate) ?? '',
    dueDate: date(root.DueDate) ?? means.map((m: X) => date(m.PaymentDueDate)).find(Boolean) ?? null,
    serviceDate: date(arr(root.Delivery)[0]?.ActualDeliveryDate),
    periodFrom: date(period.StartDate),
    periodTo: date(period.EndDate),
    currency,
    seller: ublParty(root.AccountingSupplierParty?.Party),
    buyerName: text(arr(root.AccountingCustomerParty?.Party?.PartyName)[0]?.Name) || text(root.AccountingCustomerParty?.Party?.PartyLegalEntity?.RegistrationName),
    buyerReference: text(root.BuyerReference),
    orderReference: text(root.OrderReference?.ID),
    payment: {
      iban: normalizeIban(text(account.ID)),
      bic: text(account.FinancialInstitutionBranch?.ID),
      reference: means.map((m: X) => text(m.PaymentID)).find(Boolean) ?? '',
      terms: arr(root.PaymentTerms).map((t: X) => text(t.Note)).filter(Boolean).join(' '),
    },
    taxes,
    net: cents(totals.TaxExclusiveAmount),
    tax: cents(mainTax.TaxAmount),
    gross,
    prepaid: cents(totals.PrepaidAmount),
    due: optCents(totals.PayableAmount) ?? gross,
    lineTotal: optCents(totals.LineExtensionAmount),
    lines,
    notes: arr(root.Note).map(text).filter(Boolean),
    warnings: [],
  });
}

/* ---------------- Abschluss: Plausibilität ---------------- */

function finish(inv: IncomingInvoice & { lineTotal: number | null }, fromPdf = false): IncomingInvoice {
  const { lineTotal, ...out } = inv;
  const w = out.warnings;
  out.formatLabel = formatLabel(out.guideline, out.syntax, fromPdf);
  if (out.typeCode === '381' || out.typeCode === '261' || out.typeCode === '396') out.isCredit = true;

  // Rechnungen mit negativem Gesamtbetrag wie Gutschriften behandeln (Beträge positiv speichern)
  if (!out.isCredit && out.gross < 0) {
    out.isCredit = true;
    for (const k of ['net', 'tax', 'gross', 'prepaid', 'due'] as const) out[k] = -out[k];
    out.taxes = out.taxes.map((t) => ({ ...t, basis: -t.basis, tax: -t.tax }));
  }

  if (!out.taxes.length && (out.net || out.tax)) {
    out.taxes = [{ category: out.tax ? 'S' : 'E', rate: guessRate(out.net, out.tax), basis: out.net, tax: out.tax }];
    w.push('Die E-Rechnung enthält keine Aufschlüsselung nach Steuersätzen – der Steuersatz wurde aus den Summen abgeleitet.');
  }

  const missing: string[] = [];
  if (!out.number) missing.push('Rechnungsnummer');
  if (!out.issueDate) missing.push('Rechnungsdatum');
  if (!out.seller.name) missing.push('Name des Lieferanten');
  if (missing.length) throw new EInvoiceError(`In der E-Rechnung fehlen Pflichtangaben: ${missing.join(', ')}.`);

  const sumBasis = out.taxes.reduce((s, t) => s + t.basis, 0);
  const sumTax = out.taxes.reduce((s, t) => s + t.tax, 0);
  if (out.currency !== 'EUR') w.push(`Die Rechnung lautet auf ${out.currency}. Beträge werden unverändert übernommen – bitte für Auswertungen und Export prüfen.`);
  if (Math.abs(sumBasis - out.net) > 1) w.push('Die Summe der Nettobeträge je Steuersatz weicht vom Gesamtnetto ab.');
  if (Math.abs(sumTax - out.tax) > 1) w.push('Die Summe der Steuerbeträge je Steuersatz weicht von der Gesamtsteuer ab.');
  if (Math.abs(out.net + out.tax - out.gross) > 1) w.push('Netto plus Umsatzsteuer ergibt nicht den Bruttobetrag.');
  if (lineTotal !== null && out.lines.length && Math.abs(out.lines.reduce((s, l) => s + l.net, 0) - lineTotal) > 1) {
    w.push('Die Summe der Positionen weicht von der Positionssumme der Rechnung ab.');
  }
  for (const t of out.taxes) {
    if (t.category === 'S' && Math.abs(Math.round((t.basis * t.rate) / 10000) - t.tax) > 1) {
      w.push(`Steuerbetrag zu ${t.rate / 100} % passt nicht zur Bemessungsgrundlage.`);
    }
  }
  if (!out.seller.vatId && !out.seller.taxNumber) w.push('Weder USt-IdNr. noch Steuernummer des Lieferanten angegeben (§ 14 Abs. 4 Nr. 2 UStG) – ohne sie ist der Vorsteuerabzug gefährdet.');
  if (/MINIMUM|BASIC WL/.test(out.formatLabel)) w.push('Das ZUGFeRD-Profil MINIMUM bzw. BASIC WL gilt in Deutschland nicht als E-Rechnung – maßgeblich ist die PDF.');
  return out;
}

/* ---------------- ZUGFeRD: XML aus der PDF holen ---------------- */

const PREFERRED = ['factur-x.xml', 'zugferd-invoice.xml', 'xrechnung.xml', 'zugferd.xml'];

function pdfText(v: unknown): string {
  return v instanceof PDFString || v instanceof PDFHexString ? v.decodeText() : '';
}

/** Eingebettete Rechnungs-XML einer PDF (ZUGFeRD/Factur-X) oder null */
export async function extractXmlFromPdf(data: Uint8Array): Promise<{ xml: string; filename: string } | null> {
  let doc: PDFDocument;
  try {
    doc = await PDFDocument.load(data, { updateMetadata: false, ignoreEncryption: true, throwOnInvalidObject: false });
  } catch {
    return null;
  }
  const ctx = doc.context;
  const found: { filename: string; xml: string }[] = [];
  for (const [, obj] of ctx.enumerateIndirectObjects()) {
    if (!(obj instanceof PDFDict) || obj.get(PDFName.of('Type')) !== PDFName.of('Filespec')) continue;
    const filename = pdfText(obj.get(PDFName.of('UF'))) || pdfText(obj.get(PDFName.of('F')));
    const ef = obj.lookup(PDFName.of('EF'));
    if (!(ef instanceof PDFDict)) continue;
    const ref = ef.get(PDFName.of('F')) ?? ef.get(PDFName.of('UF'));
    const stream = ref instanceof PDFRef ? ctx.lookup(ref) : ref;
    if (!(stream instanceof PDFRawStream)) continue;
    try {
      const xml = Buffer.from(decodePDFRawStream(stream).decode()).toString('utf8');
      if (/CrossIndustryInvoice|urn:oasis:names:specification:ubl:schema:xsd:(Invoice|CreditNote)-2/.test(xml.slice(0, 5000))) found.push({ filename, xml });
    } catch {
      /* nicht lesbarer Anhang */
    }
  }
  found.sort((a, b) => {
    const rank = (f: string) => {
      const i = PREFERRED.indexOf(f.toLowerCase());
      return i === -1 ? PREFERRED.length : i;
    };
    return rank(a.filename) - rank(b.filename);
  });
  return found[0] ?? null;
}

/**
 * Hochgeladene Datei als E-Rechnung lesen: XML direkt, PDF über die eingebettete XML.
 * Liefert null, wenn die Datei keine E-Rechnung enthält (z. B. normale PDF oder Scan).
 * Wirft EInvoiceError, wenn eine E-Rechnung erkannt wurde, aber unbrauchbar ist.
 */
export async function readEInvoice(data: Uint8Array): Promise<IncomingInvoice | null> {
  if (isPdf(data)) {
    const embedded = await extractXmlFromPdf(data);
    if (!embedded) return null;
    const inv = parseInvoiceXml(embedded.xml);
    return finishPdf(inv);
  }
  if (looksLikeXml(data)) return parseInvoiceXml(Buffer.from(data).toString('utf8'));
  return null;
}

function finishPdf(inv: IncomingInvoice): IncomingInvoice {
  inv.formatLabel = formatLabel(inv.guideline, inv.syntax, true);
  if (/MINIMUM|BASIC WL/.test(inv.formatLabel) && !inv.warnings.some((w) => w.includes('MINIMUM'))) {
    inv.warnings.push('Das ZUGFeRD-Profil MINIMUM bzw. BASIC WL gilt in Deutschland nicht als E-Rechnung – maßgeblich ist die PDF.');
  }
  return inv;
}
