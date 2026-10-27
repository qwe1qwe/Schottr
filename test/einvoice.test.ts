import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { EInvoiceError, parseInvoiceXml, readEInvoice } from '../src/einvoice/parse.ts';
import { buildCii } from '../src/einvoice/cii.ts';
import { renderPdf } from '../src/einvoice/pdf.ts';
import { taxRow } from '../src/modules/purchases/repo.ts';
import { buildDocumentData } from '../src/einvoice/model.ts';
import { buildDatevCsv } from '../src/lib/datev.ts';
import { expenseAccounts } from '../src/lib/expenses.ts';

const fixture = (name: string) => fs.readFileSync(new URL(`./fixtures/${name}`, import.meta.url), 'utf8');

test('XRechnung UBL (KoSIT 03.01a): Beträge, Vorauszahlung, Lieferant', () => {
  const inv = parseInvoiceXml(fixture('03.01a-INVOICE_ubl.xml'));
  assert.equal(inv.syntax, 'UBL');
  assert.equal(inv.formatLabel, 'XRechnung (UBL)');
  assert.equal(inv.number, '123456789');
  assert.equal(inv.issueDate, '2019-02-28');
  assert.equal(inv.gross, 80486);
  assert.equal(inv.due, -22514);
  assert.deepEqual(inv.taxes.map((t) => [t.category, t.rate]), [['S', 1900], ['S', 700]]);
  assert.equal(inv.net + inv.tax, inv.gross);
  assert.equal(inv.seller.vatId, 'ATU123456789');
  assert.deepEqual(inv.warnings, []);
});

test('XRechnung CII und UBL derselben Rechnung ergeben dieselben Daten', () => {
  const ubl = parseInvoiceXml(fixture('01.21a-INVOICE_ubl.xml'));
  assert.equal(ubl.taxes[0].category, 'AE', 'Reverse Charge');
  const cii = parseInvoiceXml(fixture('02.01a-INVOICE_uncefact.xml'));
  assert.equal(cii.syntax, 'CII');
  assert.equal(cii.gross, 1282969);
  assert.ok(cii.lines.length > 0);
  assert.ok(cii.payment.iban.length > 10);
});

test('Eigene XRechnung und ZUGFeRD-PDF lassen sich wieder einlesen', async () => {
  const tenant = {
    name: 'Muster GmbH', contact_name: 'Max', street: 'Weg 1', zip: '12345', city: 'Ort', country: 'DE', email: 'a@b.de', phone: '1',
    website: '', vat_id: 'DE123456789', tax_number: '', register_court: '', register_number: '', managing_directors: '', bank_name: '',
    iban: 'DE02120300000000202051', bic: '',
  } as any;
  const contact = { company: 'Kunde AG', name: '', street: 'Str 2', address_extra: '', zip: '54321', city: 'X', country: 'DE', email: 'k@x.de', phone: '', vat_id: '', customer_number: 'K1', leitweg_id: '' } as any;
  const doc = {
    kind: 'invoice', type_code: '380', issue_date: '2026-10-01', due_date: '2026-10-15', valid_until: null, service_date: '2026-10-01', service_from: null, service_to: null,
    subject: 'Test', intro: '', outro: '', buyer_reference: '', order_reference: '', tax_mode: 'standard', exemption_reason: '', skonto_percent: 0, skonto_days: 0,
  } as any;
  const items = [
    { title: 'A', description: '', quantity: 2000, unit: 'C62', unit_price: 1050, vat_rate: 1900, article_number: '' },
    { title: 'B', description: '', quantity: 1000, unit: 'C62', unit_price: 999, vat_rate: 700, article_number: '' },
  ] as any;
  const data = buildDocumentData({ tenant, contact, doc, items, number: 'RE-1', draft: false });
  const xml = parseInvoiceXml(buildCii(data, 'xrechnung'));
  assert.equal(xml.gross, data.gross);
  assert.equal(xml.dueDate, '2026-10-15');
  const pdf = await renderPdf(data, { zugferdXml: buildCii(data, 'en16931') });
  const fromPdf = (await readEInvoice(pdf))!;
  assert.equal(fromPdf.formatLabel, 'ZUGFeRD (EN 16931)');
  assert.equal(fromPdf.number, 'RE-1');
  assert.deepEqual(fromPdf.taxes.map((t) => t.tax), data.taxes.map((t) => t.tax));
  // normale PDF ohne XML → keine E-Rechnung
  const plain = await renderPdf({ ...data, kind: 'quote' } as any, {});
  assert.equal(await readEInvoice(plain), null);
});

test('Ungültige XML wird abgelehnt (keine DTDs)', () => {
  assert.throws(() => parseInvoiceXml('<?xml version="1.0"?><!DOCTYPE x [<!ENTITY a "b">]><Invoice/>'), EInvoiceError);
  assert.throws(() => parseInvoiceXml('<foo/>'), /Keine E-Rechnung/);
  assert.throws(() => parseInvoiceXml('<Invoice xmlns="urn:oasis:names:specification:ubl:schema:xsd:Invoice-2"><ID>1</ID></Invoice>'), /Pflichtangaben/);
});

test('Steuerzeile aus Netto, Brutto oder USt', () => {
  assert.deepEqual(taxRow(1900, 10000, null, null), { category: 'S', rate: 1900, basis: 10000, tax: 1900 });
  assert.deepEqual(taxRow(1900, null, null, 11900), { category: 'S', rate: 1900, basis: 10000, tax: 1900 });
  assert.deepEqual(taxRow(700, null, null, 1000), { category: 'S', rate: 700, basis: 935, tax: 65 });
  assert.deepEqual(taxRow(1900, 10000, 1901, null), { category: 'S', rate: 1900, basis: 10000, tax: 1901 });
  assert.deepEqual(taxRow(0, null, null, 500), { category: 'E', rate: 0, basis: 500, tax: 0 });
  assert.equal(taxRow(1900, null, 5, null), null);
});

test('DATEV: Eingangsrechnungen mit Kreditor und BU-Schlüssel', () => {
  const t = {
    datev_consultant: '1', datev_client: '1', datev_skr: '04', datev_account_length: 4, datev_accounts: '', datev_debtor_mode: 'collective',
    datev_debtor_account: 10000, datev_creditor_mode: 'individual', datev_creditor_account: 70000, datev_expense_accounts: 'buero=6820', small_business: 0,
  } as any;
  assert.equal(expenseAccounts(t).buero, '6820');
  assert.equal(expenseAccounts(t).miete, '6310');
  const csv = buildDatevCsv(t, {
    purchases: [{
      id: 1, number: 'A-1', issueDate: '2026-10-05', isCredit: true, currency: 'EUR', category: 'buero', supplierName: 'Meier', supplierNumber: 'L00012',
      taxes: [{ category: 'S', rate: 1900, basis: 1000, tax: 190 }],
    }],
  }, '2026-10-01', '2026-10-31', 'Test').toString('latin1');
  const row = csv.trim().split('\r\n')[2].split(';');
  assert.deepEqual([row[0], row[1], row[6], row[7], row[8], row[9], row[10]], ['11,90', '"S"', '70012', '6820', '"9"', '0510', '"A-1"']);
});
