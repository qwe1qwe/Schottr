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
import { buildCii } from '../src/einvoice/cii.ts';
import { renderPdf } from '../src/einvoice/pdf.ts';
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
  const base = { typeCode: '380' as const, dueDate: '2026-11-10', gross: t.gross, issueDate: '2026-10-27', ...extra };
  return {
    version: 1, kind: 'invoice', number, validUntil: null,
    serviceDate: '2026-10-20', serviceFrom: null, serviceTo: null,
    subject: 'Projekt Werkhalle', intro: 'vielen Dank für Ihren Auftrag. Wir berechnen Ihnen folgende Leistungen:',
    outro: 'Bei Fragen sind wir gerne für Sie da.', buyerReference: '', orderReference: 'PO-4711',
    precedingInvoice: null, taxMode: mode, exemptionReason: exemptionText(mode, 'Steuerfrei gemäß § 4 Nr. 21 UStG'),
    currency: 'EUR', seller, buyer, items: t.items, taxes: t.taxes, net: t.net, tax: t.tax,
    draft: false, ...base, paymentTerms: paymentTermsText(base),
  } as DocumentData;
}

const samples: Record<string, DocumentData> = {
  standard: make('RE-2026-0001', 'standard'),
  kleinunternehmer: make('RE-2026-0002', 'small_business', { seller: { ...seller, vatId: '' } } as any),
  reverse_charge: make('RE-2026-0003', 'reverse_charge'),
  steuerfrei: make('RE-2026-0004', 'exempt'),
  zeitraum: make('RE-2026-0005', 'standard', { serviceDate: null, serviceFrom: '2026-10-01', serviceTo: '2026-10-31', buyer: { ...buyer, leitwegId: '991-12345-67' } } as any),
  storno: make('RE-2026-0006', 'standard', { typeCode: '381', dueDate: null, precedingInvoice: { number: 'RE-2026-0001', issueDate: '2026-10-27' } } as any),
};

fs.mkdirSync('samples', { recursive: true });
for (const [name, data] of Object.entries(samples)) {
  fs.writeFileSync(`samples/${name}.xml`, buildCii(data, 'xrechnung'));
  fs.writeFileSync(`samples/${name}.pdf`, await renderPdf(data, { zugferdXml: buildCii(data, 'en16931') }));
}
const quote = { ...samples.standard, kind: 'quote' as const, number: 'AN-2026-0001', validUntil: '2026-11-26' };
fs.writeFileSync('samples/angebot.pdf', await renderPdf(quote));
fs.writeFileSync('samples/entwurf.pdf', await renderPdf({ ...samples.standard, draft: true }));
console.log('Beispiele in ./samples erzeugt:', fs.readdirSync('samples').join(', '));
