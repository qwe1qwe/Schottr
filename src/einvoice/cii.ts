import { bpToDecimal, centsToDecimal, milliToDecimal } from '../lib/money.ts';
import { toCiiDate } from '../lib/dates.ts';
import { dueAmount, skontoCode, type DocumentData, type Party } from './model.ts';

/**
 * UN/CEFACT Cross Industry Invoice (CII D16B) nach EN 16931.
 *
 * - profile "xrechnung": XRechnung 3.0 (CIUS für Deutschland) – eigenständige XML-Datei
 * - profile "en16931":   ZUGFeRD 2.x / Factur-X Profil EN 16931 (COMFORT) – wird ins PDF eingebettet
 *
 * Beide Varianten enthalten dieselben Daten; nur der Spezifikationsbezeichner (BT-24) unterscheidet sich.
 */
export type CiiProfile = 'xrechnung' | 'en16931';

export const GUIDELINES: Record<CiiProfile, string> = {
  xrechnung: 'urn:cen.eu:en16931:2017#compliant#urn:xeinkauf.de:kosit:xrechnung_3.0',
  en16931: 'urn:cen.eu:en16931:2017',
};

const esc = (v: string) =>
  v.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;')
    // in XML 1.0 unzulässige Steuerzeichen entfernen
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, '');

type Node = string | false | null | undefined | Node[];

function el(name: string, content: Node, attrs: Record<string, string> = {}): string {
  const inner = flatten(content);
  if (inner === '') return '';
  const a = Object.entries(attrs).map(([k, v]) => ` ${k}="${esc(v)}"`).join('');
  return `<${name}${a}>${inner}</${name}>`;
}

/** Textelement – leer bleibt weg. */
function txt(name: string, value: string | null | undefined, attrs: Record<string, string> = {}): string {
  if (value === null || value === undefined || value === '') return '';
  const a = Object.entries(attrs).map(([k, v]) => ` ${k}="${esc(v)}"`).join('');
  return `<${name}${a}>${esc(value)}</${name}>`;
}

function flatten(n: Node): string {
  if (!n) return '';
  if (Array.isArray(n)) return n.map(flatten).join('');
  return n;
}

const date102 = (iso: string) => el('udt:DateTimeString', esc(toCiiDate(iso)), { format: '102' });
const amount = (cents: number) => centsToDecimal(cents);

function address(p: Party): string {
  return el('ram:PostalTradeAddress', [
    txt('ram:PostcodeCode', p.zip),
    txt('ram:LineOne', p.street),
    txt('ram:LineTwo', p.addressExtra),
    txt('ram:CityName', p.city),
    txt('ram:CountryID', p.country),
  ]);
}

function taxRegistrations(p: Party): string {
  return [
    p.vatId ? el('ram:SpecifiedTaxRegistration', txt('ram:ID', p.vatId, { schemeID: 'VA' })) : '',
    p.taxNumber ? el('ram:SpecifiedTaxRegistration', txt('ram:ID', p.taxNumber, { schemeID: 'FC' })) : '',
  ].join('');
}

/** Rechnungsbegründende Unterlagen (BG-24) mit eingebetteter Datei (BT-125) */
export interface CiiAttachment {
  id: string;
  name: string;
  filename: string;
  data: Buffer;
}

export function buildCii(d: DocumentData, profile: CiiProfile, attachments: CiiAttachment[] = []): string {
  const s = d.seller;
  const b = d.buyer;
  const isCredit = d.typeCode === '381';

  const notes: Node[] = [
    d.subject ? el('ram:IncludedNote', txt('ram:Content', d.subject)) : '',
    // Pflichtangaben des Verkäufers (BT-22, Code REG)
    el('ram:IncludedNote', [
      txt('ram:Content', [
        s.name,
        s.managingDirectors ? `Geschäftsführer: ${s.managingDirectors}` : '',
        s.registerCourt || s.registerNumber ? `${s.registerCourt} ${s.registerNumber}`.trim() : '',
      ].filter(Boolean).join(', ')),
      txt('ram:SubjectCode', 'REG'),
    ]),
    d.exemptionReason ? el('ram:IncludedNote', [txt('ram:Content', d.exemptionReason), txt('ram:SubjectCode', 'TXD')]) : '',
    d.prepayments?.length
      ? el('ram:IncludedNote', txt('ram:Content', `Abgezogene Teilrechnungen: ${d.prepayments
          .map((p) => `${p.number} vom ${p.issueDate.split('-').reverse().join('.')} (netto ${centsToDecimal(p.net)}, USt ${centsToDecimal(p.tax)}, brutto ${centsToDecimal(p.gross)} EUR)`)
          .join('; ')}. Summe ${centsToDecimal(d.prepaid ?? 0)} EUR.`))
      : '',
  ];

  const lines = d.items.map((it) =>
    el('ram:IncludedSupplyChainTradeLineItem', [
      el('ram:AssociatedDocumentLineDocument', txt('ram:LineID', String(it.position))),
      el('ram:SpecifiedTradeProduct', [txt('ram:SellerAssignedID', it.articleNumber), txt('ram:Name', it.title), txt('ram:Description', it.description)]),
      el('ram:SpecifiedLineTradeAgreement',
        el('ram:NetPriceProductTradePrice', txt('ram:ChargeAmount', amount(it.unitPrice)))),
      el('ram:SpecifiedLineTradeDelivery', txt('ram:BilledQuantity', milliToDecimal(it.quantity), { unitCode: it.unit })),
      el('ram:SpecifiedLineTradeSettlement', [
        el('ram:ApplicableTradeTax', [
          txt('ram:TypeCode', 'VAT'),
          txt('ram:CategoryCode', d.taxes[0]?.category ?? 'S'),
          txt('ram:RateApplicablePercent', bpToDecimal(it.vatRate)),
        ]),
        el('ram:SpecifiedTradeSettlementLineMonetarySummation', txt('ram:LineTotalAmount', amount(it.lineTotal))),
      ]),
    ]),
  );

  const seller = el('ram:SellerTradeParty', [
    // BR-CO-26: ohne USt-IdNr. braucht es eine Verkäuferkennung – dann die Steuernummer (BT-29)
    !s.vatId ? txt('ram:ID', s.taxNumber || s.name) : '',
    txt('ram:Name', s.name),
    s.registerNumber
      ? el('ram:SpecifiedLegalOrganization', [txt('ram:ID', s.registerNumber), txt('ram:TradingBusinessName', s.name)])
      : '',
    el('ram:DefinedTradeContact', [
      txt('ram:PersonName', s.contactName),
      el('ram:TelephoneUniversalCommunication', txt('ram:CompleteNumber', s.phone)),
      el('ram:EmailURIUniversalCommunication', txt('ram:URIID', s.email)),
    ]),
    address(s),
    s.email ? el('ram:URIUniversalCommunication', txt('ram:URIID', s.email, { schemeID: 'EM' })) : '',
    taxRegistrations(s),
  ]);

  const buyer = el('ram:BuyerTradeParty', [
    txt('ram:ID', b.customerNumber),
    txt('ram:Name', b.name),
    b.contactName ? el('ram:DefinedTradeContact', txt('ram:PersonName', b.contactName)) : '',
    address(b),
    b.email ? el('ram:URIUniversalCommunication', txt('ram:URIID', b.email, { schemeID: 'EM' })) : '',
    b.vatId ? el('ram:SpecifiedTaxRegistration', txt('ram:ID', b.vatId, { schemeID: 'VA' })) : '',
  ]);

  const taxes = d.taxes.map((t) =>
    el('ram:ApplicableTradeTax', [
      txt('ram:CalculatedAmount', amount(t.tax)),
      txt('ram:TypeCode', 'VAT'),
      t.category !== 'S' ? txt('ram:ExemptionReason', d.exemptionReason) : '',
      txt('ram:BasisAmount', amount(t.basis)),
      txt('ram:CategoryCode', t.category),
      t.category === 'AE' ? txt('ram:ExemptionReasonCode', 'VATEX-EU-AE') : '',
      txt('ram:RateApplicablePercent', bpToDecimal(t.rate)),
    ]),
  );

  const period = d.serviceFrom && d.serviceTo
    ? el('ram:BillingSpecifiedPeriod', [
        el('ram:StartDateTime', date102(d.serviceFrom)),
        el('ram:EndDateTime', date102(d.serviceTo)),
      ])
    : '';

  const xml = el('rsm:CrossIndustryInvoice', [
    el('rsm:ExchangedDocumentContext', [
      el('ram:BusinessProcessSpecifiedDocumentContextParameter', txt('ram:ID', 'urn:fdc:peppol.eu:2017:poacc:billing:01:1.0')),
      el('ram:GuidelineSpecifiedDocumentContextParameter', txt('ram:ID', GUIDELINES[profile])),
    ]),
    el('rsm:ExchangedDocument', [
      txt('ram:ID', d.number),
      txt('ram:TypeCode', d.typeCode),
      el('ram:IssueDateTime', date102(d.issueDate)),
      notes,
    ]),
    el('rsm:SupplyChainTradeTransaction', [
      lines,
      el('ram:ApplicableHeaderTradeAgreement', [
        txt('ram:BuyerReference', d.buyerReference || b.customerNumber || 'n/a'),
        seller,
        buyer,
        d.orderReference ? el('ram:BuyerOrderReferencedDocument', txt('ram:IssuerAssignedID', d.orderReference)) : '',
        attachments.map((a) =>
          el('ram:AdditionalReferencedDocument', [
            txt('ram:IssuerAssignedID', a.id),
            txt('ram:TypeCode', '916'), // rechnungsbegründende Unterlage
            txt('ram:Name', a.name),
            `<ram:AttachmentBinaryObject mimeCode="application/pdf" filename="${esc(a.filename)}">${a.data.toString('base64')}</ram:AttachmentBinaryObject>`,
          ])),
      ]),
      el('ram:ApplicableHeaderTradeDelivery',
        d.serviceDate
          ? el('ram:ActualDeliverySupplyChainEvent', el('ram:OccurrenceDateTime', date102(d.serviceDate)))
          : '<!-- Leistungszeitraum siehe BillingSpecifiedPeriod -->'),
      el('ram:ApplicableHeaderTradeSettlement', [
        txt('ram:PaymentReference', d.number),
        txt('ram:InvoiceCurrencyCode', d.currency),
        el('ram:SpecifiedTradeSettlementPaymentMeans', [
          txt('ram:TypeCode', '58'), // SEPA-Überweisung
          el('ram:PayeePartyCreditorFinancialAccount', [txt('ram:IBANID', s.iban), txt('ram:AccountName', s.name)]),
          s.bic ? el('ram:PayeeSpecifiedCreditorFinancialInstitution', txt('ram:BICID', s.bic)) : '',
        ]),
        taxes,
        period,
        el('ram:SpecifiedTradePaymentTerms', [
          // Skonto strukturiert nach XRechnung BR-DE-18 (#SKONTO#TAGE=…#PROZENT=…#), danach Freitext
          txt('ram:Description', d.skonto ? `${skontoCode(d.skonto)}\n${d.paymentTerms}` : d.paymentTerms),
          d.dueDate && !isCredit ? el('ram:DueDateDateTime', date102(d.dueDate)) : '',
        ]),
        el('ram:SpecifiedTradeSettlementHeaderMonetarySummation', [
          txt('ram:LineTotalAmount', amount(d.net)),
          txt('ram:TaxBasisTotalAmount', amount(d.net)),
          txt('ram:TaxTotalAmount', amount(d.tax), { currencyID: d.currency }),
          txt('ram:GrandTotalAmount', amount(d.gross)),
          d.prepaid ? txt('ram:TotalPrepaidAmount', amount(d.prepaid)) : '',
          txt('ram:DuePayableAmount', amount(dueAmount(d))),
        ]),
        // BG-3: Bezug auf die vorausgegangene Rechnung. CII erlaubt nur EINEN Bezug – bei mehreren
        // abgezogenen Teilrechnungen die letzte; alle stehen zusätzlich im Hinweis (BT-22).
        ((ref) => ref
          ? el('ram:InvoiceReferencedDocument', [
              txt('ram:IssuerAssignedID', ref.number),
              el('ram:FormattedIssueDateTime', el('qdt:DateTimeString', esc(toCiiDate(ref.issueDate)), { format: '102' })),
            ])
          : '')(d.precedingInvoice ?? d.prepayments?.at(-1) ?? null),
      ]),
    ]),
  ], {
    'xmlns:rsm': 'urn:un:unece:uncefact:data:standard:CrossIndustryInvoice:100',
    'xmlns:qdt': 'urn:un:unece:uncefact:data:standard:QualifiedDataType:100',
    'xmlns:ram': 'urn:un:unece:uncefact:data:standard:ReusableAggregateBusinessInformationEntity:100',
    'xmlns:udt': 'urn:un:unece:uncefact:data:standard:UnqualifiedDataType:100',
  });

  return `<?xml version="1.0" encoding="UTF-8"?>\n${xml}\n`;
}
