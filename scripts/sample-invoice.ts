/**
 * Erzeugt Beispielrechnungen (XRechnung-XML + ZUGFeRD-PDF) in ./samples –
 * praktisch, um die Ausgabe mit dem KoSIT-Validator oder Mustang zu prüfen:
 *
 *   node scripts/sample-invoice.ts
 *   java -jar validator-standalone.jar -s xrechnung/scenarios.xml -r xrechnung samples/*.xml
 *   java -jar Mustang-CLI.jar --action validate --source samples/standard.pdf
 */
import fs from 'node:fs';
import { calculate, type ItemInput, type TaxMode } from '../src/lib/calc.ts';
import { roundDiv } from '../src/lib/money.ts';
import { buildCii } from '../src/einvoice/cii.ts';
import { renderPdf } from '../src/einvoice/pdf.ts';
import { appendPdfs } from '../src/lib/pdfmerge.ts';
import { exemptionText, paymentTermsText, type DocumentData } from '../src/einvoice/model.ts';

const seller = {
  name: 'Muster Werkstatt GmbH', contactName: 'Julia Muster', street: 'Hauptstraße 12', addressExtra: '',
  zip: '80331', city: 'München', country: 'DE', email: 'rechnung@muster-werkstatt.de', phone: '+49 89 1234567',
  vatId: 'DE123456789', taxNumber: '143/123/45678', website: 'www.muster-werkstatt.de', bankName: 'Musterbank',
  iban: 'DE02120300000000202051', bic: 'BYLADEM1001', registerCourt: 'Amtsgericht München',
  registerNumber: 'HRB 123456', managingDirectors: 'Julia Muster',
};
const buyer = {
  name: 'Beispiel AG', contactName: 'Max Beispiel', street: 'Industrieweg 5', addressExtra: 'Gebäude B',
  zip: '10115', city: 'Berlin', country: 'DE', email: 'einkauf@beispiel.de', phone: '', vatId: 'DE987654321',
  taxNumber: '', customerNumber: 'K00001', leitwegId: '',
};

const items: ItemInput[] = [
  { title: 'Beratung Konzeption', description: 'Workshop vor Ort inkl. Vorbereitung\nund Protokoll', quantity: 6500, unit: 'HUR', unitPrice: 9500, vatRate: 1900 },
  { title: 'Montagematerial', description: '', quantity: 3000, unit: 'C62', unitPrice: 1999, vatRate: 1900 },
  { title: 'Fachbuch „E-Rechnung in der Praxis“', description: '', quantity: 1000, unit: 'C62', unitPrice: 3990, vatRate: 700 },
  { title: 'Rabatt Stammkunde', description: '', quantity: -1000, unit: 'LS', unitPrice: 5000, vatRate: 1900 },
];

function make(number: string, mode: TaxMode, extra: Partial<DocumentData> = {}): DocumentData {
  const t = calculate(items, mode);
  const d = {
    version: 1, kind: 'invoice', number, typeCode: '380', validUntil: null, issueDate: '2026-10-27', dueDate: '2026-11-10',
    serviceDate: '2026-10-20', serviceFrom: null, serviceTo: null,
    subject: 'Projekt Werkhalle', intro: 'vielen Dank für Ihren Auftrag. Wir berechnen Ihnen folgende Leistungen:',
    outro: 'Bei Fragen sind wir gerne für Sie da.', buyerReference: '', orderReference: 'PO-4711',
    precedingInvoice: null, taxMode: mode, exemptionReason: exemptionText(mode, 'Steuerfrei gemäß § 4 Nr. 21 UStG'),
    currency: 'EUR', seller, buyer, items: t.items, taxes: t.taxes, net: t.net, tax: t.tax, gross: t.gross,
    prepayments: [], skonto: null, draft: false, paymentTerms: '',
    ...extra,
  } as DocumentData;
  d.prepaid = (d.prepayments ?? []).reduce((s, p) => s + p.gross, 0);
  d.due = d.gross - d.prepaid;
  if (d.skonto) d.skonto = { ...d.skonto, amount: roundDiv(d.due * d.skonto.percent, 10000) };
  d.paymentTerms = paymentTermsText({ ...d, due: d.due });
  return d;
}

const partial = { number: 'RE-2026-0007', issueDate: '2026-09-15', net: 25000, tax: 4750, gross: 29750 };
const partial2 = { number: 'RE-2026-0008', issueDate: '2026-10-01', net: 10000, tax: 1900, gross: 11900 };

const samples: Record<string, DocumentData> = {
  standard: make('RE-2026-0001', 'standard'),
  kleinunternehmer: make('RE-2026-0002', 'small_business', { seller: { ...seller, vatId: '' } } as any),
  reverse_charge: make('RE-2026-0003', 'reverse_charge'),
  steuerfrei: make('RE-2026-0004', 'exempt'),
  zeitraum: make('RE-2026-0005', 'standard', { serviceDate: null, serviceFrom: '2026-10-01', serviceTo: '2026-10-31', buyer: { ...buyer, leitwegId: '991-12345-67' } } as any),
  storno: make('RE-2026-0006', 'standard', { typeCode: '381', dueDate: null, precedingInvoice: { number: 'RE-2026-0001', issueDate: '2026-10-27' } } as any),
  teilrechnung_875: make('RE-2026-0007', 'standard', { typeCode: '875', subject: '1. Abschlag Werkhalle' }),
  teilschluss_876: make('RE-2026-0009', 'standard', { typeCode: '876', prepayments: [partial] }),
  schluss_877: make('RE-2026-0010', 'standard', { typeCode: '877', prepayments: [partial, partial2], buyer: { ...buyer, leitwegId: '991-12345-67' } } as any),
  skonto: make('RE-2026-0011', 'standard', { skonto: { percent: 200, days: 10, date: '2026-11-06', amount: 0 } }),
  skonto_schluss: make('RE-2026-0012', 'standard', { typeCode: '877', prepayments: [partial2], skonto: { percent: 300, days: 7, date: '2026-11-03', amount: 0 } }),
};

fs.mkdirSync('samples', { recursive: true });
for (const [name, data] of Object.entries(samples)) {
  fs.writeFileSync(`samples/${name}.xml`, buildCii(data, 'xrechnung'));
  fs.writeFileSync(`samples/${name}.pdf`, await renderPdf(data, { zugferdXml: buildCii(data, 'en16931') }));
}
// Rechnung mit Nachweis: Seiten angehängt (PDF) + BG-24-Anhang (XRechnung)
{
  const proofPdf = await renderPdf({ ...samples.standard, kind: 'quote', number: 'Aufmaß', subject: 'Aufmaß Bauabschnitt 1' } as DocumentData);
  const d = { ...samples.standard, number: 'RE-2026-0013', proofs: [{ name: 'Aufmaß Bauabschnitt 1', filename: 'aufmass.pdf' }] };
  fs.writeFileSync('samples/mit_nachweis.xml', buildCii(d, 'xrechnung', [{ id: 'NW-1', name: 'Aufmaß Bauabschnitt 1', filename: '01_aufmass.pdf', data: proofPdf }]));
  fs.writeFileSync('samples/mit_nachweis.pdf', await appendPdfs(await renderPdf(d, { zugferdXml: buildCii(d, 'en16931') }), [proofPdf]));
}
const logo = { data: fs.readFileSync('test/logo.png'), mime: 'image/png' };
fs.writeFileSync('samples/mit_logo.pdf', await renderPdf(samples.schluss_877, { zugferdXml: buildCii(samples.schluss_877, 'en16931'), logo }));
const quote = { ...samples.standard, kind: 'quote' as const, number: 'AN-2026-0001', validUntil: '2026-11-26' };
fs.writeFileSync('samples/angebot.pdf', await renderPdf(quote));
fs.writeFileSync('samples/entwurf.pdf', await renderPdf({ ...samples.standard, draft: true }));
console.log('Beispiele in ./samples erzeugt:', fs.readdirSync('samples').join(', '));
