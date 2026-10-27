import type { Tenant } from '../types.ts';
import type { DocumentData } from '../einvoice/model.ts';
import type { TaxGroup } from './calc.ts';
import { expenseAccounts } from './expenses.ts';

/**
 * DATEV-Buchungsstapel (Format „EXTF“, Version 700, Kategorie 21).
 *
 * Ausgangsrechnungen: je Rechnung und Steuersatz eine Buchung Debitor an Erlöskonto
 * (Automatikkonto, ohne BU-Schlüssel). Teil-/Schlussrechnungen buchen zusätzlich die
 * abgezogenen Teilrechnungen zurück, damit der Umsatz nicht doppelt erfasst wird.
 *
 * Eingangsrechnungen: je Rechnung und Steuersatz eine Buchung Kreditor (Haben) an
 * Aufwandskonto der Kostenart, Vorsteuer über den BU-Schlüssel (9 = 19 %, 8 = 7 %).
 * Kleinunternehmer buchen brutto ohne Vorsteuer. Gutschriften im Soll.
 */

type AccountKey = '19' | '7' | 'ku' | 'rc' | 'frei';

const DEFAULT_ACCOUNTS: Record<string, Record<AccountKey, string>> = {
  '03': { '19': '8400', '7': '8300', ku: '8195', rc: '8337', frei: '8100' },
  '04': { '19': '4400', '7': '4300', ku: '4185', rc: '4337', frei: '4100' },
};

export function revenueAccounts(t: Tenant): Record<AccountKey, string> {
  const accounts = { ...DEFAULT_ACCOUNTS[t.datev_skr === '04' ? '04' : '03'] };
  for (const part of t.datev_accounts.split(',')) {
    const [k, v] = part.split('=').map((x) => x.trim().toLowerCase());
    if (k && v && k in accounts && /^\d+$/.test(v)) accounts[k as AccountKey] = v;
  }
  return accounts;
}

function accountFor(group: TaxGroup, taxMode: DocumentData['taxMode'], accounts: Record<AccountKey, string>): string {
  if (group.category === 'AE') return accounts.rc;
  if (group.category === 'E') return taxMode === 'small_business' ? accounts.ku : accounts.frei;
  if (group.rate === 700) return accounts['7'];
  if (group.rate === 1900) return accounts['19'];
  return accounts.frei;
}

export function debtorAccount(t: Tenant, customerNumber: string): string {
  if (t.datev_debtor_mode === 'individual') {
    const digits = Number(customerNumber.replace(/\D/g, '') || '0');
    return String(t.datev_debtor_account + digits);
  }
  return String(t.datev_debtor_account);
}

const amount = (cents: number) => (Math.abs(cents) / 100).toFixed(2).replace('.', ',');
const text = (v: string, max: number) => `"${v.replace(/"/g, '""').replace(/[\r\n;]+/g, ' ').slice(0, max)}"`;
/** Belegfeld 1: nur bestimmte Zeichen zulässig, max. 36 */
const beleg = (v: string) => `"${v.replace(/[^A-Za-z0-9$&%*+\-/]/g, '').slice(0, 36)}"`;
const ddmm = (iso: string) => `${iso.slice(8, 10)}${iso.slice(5, 7)}`;
const ymd = (iso: string) => iso.replaceAll('-', '');

export function creditorAccount(t: Tenant, supplierNumber: string): string {
  if (t.datev_creditor_mode === 'individual') {
    const digits = Number(supplierNumber.replace(/\D/g, '') || '0');
    return String(t.datev_creditor_account + digits);
  }
  return String(t.datev_creditor_account);
}

/** BU-Schlüssel für die Vorsteuer (DATEV-Standard seit 2021: 9 = 19 %, 8 = 7 %) */
function inputTaxKey(category: string, rate: number): string {
  if (category !== 'S') return '';
  return rate === 1900 ? '9' : rate === 700 ? '8' : '';
}

/** Eingangsrechnung für den Export (Daten aus purchase_invoices + Steuerzeilen) */
export interface DatevPurchase {
  number: string;
  id: number;
  issueDate: string;
  isCredit: boolean;
  currency: string;
  category: string;
  supplierName: string;
  supplierNumber: string;
  taxes: { category: string; rate: number; basis: number; tax: number }[];
}

export interface DatevInvoice {
  data: DocumentData;
  /** Snapshots der abgezogenen Teilrechnungen (für die Rückbuchung je Steuersatz) */
  prepaidSnapshots: DocumentData[];
}

export function buildDatevCsv(
  t: Tenant,
  data: { invoices?: DatevInvoice[]; purchases?: DatevPurchase[] },
  from: string, to: string, exportedBy: string,
): Buffer {
  const invoices = data.invoices ?? [];
  const purchases = data.purchases ?? [];
  const accounts = revenueAccounts(t);
  const expense = expenseAccounts(t);
  const now = new Date();
  const stamp = `${now.toISOString().replace(/\D/g, '').slice(0, 17)}`;
  const label = invoices.length && !purchases.length ? 'Ausgangsrechnungen' : purchases.length && !invoices.length ? 'Eingangsrechnungen' : 'Rechnungen';
  const header = [
    '"EXTF"', 700, 21, '"Buchungsstapel"', 13, stamp, '', '"SC"', text(exportedBy, 25), '""',
    t.datev_consultant || '', t.datev_client || '', `${from.slice(0, 4)}0101`, t.datev_account_length,
    ymd(from), ymd(to), text(`${label} ${from.slice(0, 7)}`, 30), '""', 1, 0, 0, '"EUR"',
    '', '""', '', '', `"${t.datev_skr}"`, '', '', '', '""',
  ].join(';');
  const columns = [
    'Umsatz (ohne Soll/Haben-Kz)', 'Soll/Haben-Kennzeichen', 'WKZ Umsatz', 'Kurs', 'Basis-Umsatz', 'WKZ Basis-Umsatz',
    'Konto', 'Gegenkonto (ohne BU-Schlüssel)', 'BU-Schlüssel', 'Belegdatum', 'Belegfeld 1', 'Belegfeld 2', 'Skonto', 'Buchungstext',
  ].join(';');

  const rows: string[] = [];
  const book = (cents: number, sh: 'S' | 'H', konto: string, gegenkonto: string, bu: string, date: string, belegnr: string, label: string, currency = 'EUR') => {
    if (!cents) return;
    rows.push([
      amount(cents), `"${sh}"`, `"${currency}"`, '', '', '', konto, gegenkonto, `"${bu}"`, ddmm(date), beleg(belegnr), '""', '', text(label, 60),
    ].join(';'));
  };

  for (const { data: d, prepaidSnapshots } of invoices) {
    const debtor = debtorAccount(t, d.buyer.customerNumber);
    const credit = d.typeCode === '381';
    for (const g of d.taxes) {
      book(g.basis + g.tax, credit ? 'H' : 'S', debtor, accountFor(g, d.taxMode, accounts), '', d.issueDate, d.number, d.buyer.name);
    }
    // abgezogene Teilrechnungen zurückbuchen
    for (const p of prepaidSnapshots) {
      for (const g of p.taxes) {
        book(g.basis + g.tax, 'H', debtor, accountFor(g, p.taxMode, accounts), '', d.issueDate, d.number, `Verrechnung ${p.number}`);
      }
    }
  }

  for (const p of purchases) {
    const creditor = creditorAccount(t, p.supplierNumber);
    const account = expense[p.category] ?? expense.sonstiges;
    for (const g of p.taxes) {
      // Kleinunternehmer: kein Vorsteuerabzug – Bruttobetrag ohne BU-Schlüssel
      const bu = t.small_business ? '' : inputTaxKey(g.category, g.rate);
      const note = g.category === 'AE' ? ' § 13b' : '';
      book(g.basis + g.tax, p.isCredit ? 'S' : 'H', creditor, account, bu, p.issueDate, p.number || `ER${p.id}`, `${p.supplierName}${note}`, p.currency);
    }
  }
  return toWindows1252([header, columns, ...rows].join('\r\n') + '\r\n');
}

/** DATEV erwartet ANSI (Windows-1252). */
const CP1252_EXTRA: Record<string, number> = {
  '€': 0x80, '‚': 0x82, 'ƒ': 0x83, '„': 0x84, '…': 0x85, '†': 0x86, '‡': 0x87, 'ˆ': 0x88, '‰': 0x89, 'Š': 0x8a, '‹': 0x8b,
  'Œ': 0x8c, 'Ž': 0x8e, '‘': 0x91, '’': 0x92, '“': 0x93, '”': 0x94, '•': 0x95, '–': 0x96, '—': 0x97, '˜': 0x98, '™': 0x99,
  'š': 0x9a, '›': 0x9b, 'œ': 0x9c, 'ž': 0x9e, 'Ÿ': 0x9f,
};

export function toWindows1252(s: string): Buffer {
  const out = Buffer.alloc(s.length);
  let i = 0;
  for (const ch of s) {
    const code = ch.codePointAt(0)!;
    out[i++] = CP1252_EXTRA[ch] ?? (code < 0x80 || (code >= 0xa0 && code <= 0xff) ? code : 0x3f);
  }
  return out.subarray(0, i);
}
