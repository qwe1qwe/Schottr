import { all, one } from '../../db/index.ts';
import { formatDate } from '../../lib/dates.ts';
import { formatAmount, formatMoney } from '../../lib/money.ts';
import { SPHERES, sphereLabel } from '../../lib/nonprofit.ts';
import { categoryLabel } from '../../lib/expenses.ts';
import { renderTablePdf, type TableSection } from '../../lib/tablepdf.ts';
import type { Tenant } from '../../types.ts';
import { DENOMINATIONS, SOURCE_LABELS, accountsOf, entriesOf, entrySphere, type CashAccount, type CashCount, type EntryRow } from './repo.ts';

/**
 * Auswertungen für das Steuerbüro: Kassenbuch je Konto (CSV und PDF), Zählprotokolle,
 * Zuwendungsliste und Einnahmen/Ausgaben nach Bereichen – Grundlage ist das Zuflussprinzip
 * (Buchungsdatum im Kassenbuch).
 */
const csvField = (v: string | number) => {
  const s = String(v);
  return /[";\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};
const num = (cents: number) => formatAmount(cents).replace(/\./g, '');
const csv = (head: string[], lines: (string | number)[][]) => '﻿' + [head, ...lines].map((l) => l.map(csvField).join(';')).join('\r\n') + '\r\n';

/** Enthaltene Umsatzsteuer einer Bruttobuchung */
const vatOf = (gross: number, rate: number) => (rate ? Math.round((gross * rate) / (10000 + rate)) : 0);

const entryLabel = (r: EntryRow) => r.ref_label ?? r.text;
const sphereText = (t: Tenant, r: EntryRow) => (t.nonprofit ? sphereLabel(entrySphere(r, t.default_sphere)) : '');

export interface AccountReport {
  account: CashAccount;
  opening: number;
  closing: number;
  rows: EntryRow[];
  income: number;
  expense: number;
  transfers: number;
}

export async function accountReports(t: Tenant, from: string, to: string): Promise<AccountReport[]> {
  const out: AccountReport[] = [];
  for (const a of await accountsOf(t.id, true)) {
    if (a.opening_date > to) continue;
    const { opening, rows, closing } = await entriesOf([a], from, to);
    const sum = (f: (r: EntryRow) => boolean) => rows.filter(f).reduce((s, r) => s + r.amount, 0);
    out.push({
      account: a, opening, closing, rows,
      income: sum((r) => r.amount > 0 && r.source !== 'transfer'),
      expense: -sum((r) => r.amount < 0 && r.source !== 'transfer') || 0,
      transfers: sum((r) => r.source === 'transfer'),
    });
  }
  return out;
}

export function cashbookCsv(t: Tenant, rep: AccountReport): string {
  const head = ['Datum', 'Konto', 'Art', 'Buchungstext', 'Beleg', 'Kostenart', 'Bereich', 'USt-Satz', 'darin USt', 'Einnahme', 'Ausgabe', 'Saldo'];
  const lines: (string | number)[][] = [['', rep.account.name, '', 'Anfangsbestand', '', '', '', '', '', '', '', num(rep.opening)]];
  for (const r of rep.rows) {
    lines.push([
      formatDate(r.entry_date), rep.account.name, r.recurring_id ? 'Dauerauftrag' : SOURCE_LABELS[r.source], entryLabel(r) + (r.ref_label && r.text ? ` – ${r.text}` : ''), r.receipt_ref,
      r.category || r.ref_category ? categoryLabel(r.category || r.ref_category!) : '', sphereText(t, r), r.vat_rate ? `${r.vat_rate / 100} %` : '', r.vat_rate ? num(vatOf(Math.abs(r.amount), r.vat_rate)) : '',
      r.amount > 0 ? num(r.amount) : '', r.amount < 0 ? num(-r.amount) : '', num(r.balance),
    ]);
  }
  lines.push(['', rep.account.name, '', 'Endbestand', '', '', '', '', '', num(rep.income), num(rep.expense), num(rep.closing)]);
  return csv(head, lines);
}

export function cashbookPdf(t: Tenant, rep: AccountReport, from: string, to: string): Promise<Buffer> {
  const sections: TableSection[] = [{
    columns: [
      { label: 'Datum', width: 11 }, { label: 'Buchungstext', width: 44 }, { label: 'Beleg', width: 10 },
      ...(t.nonprofit ? [{ label: 'Bereich', width: 15 }] : []),
      { label: 'Einnahme', width: 12, right: true }, { label: 'Ausgabe', width: 12, right: true }, { label: 'Saldo', width: 13, right: true },
    ],
    rows: [
      { cells: ['', 'Anfangsbestand', '', ...(t.nonprofit ? [''] : []), '', '', formatMoney(rep.opening)], muted: true },
      ...rep.rows.map((r) => ({
        cells: [
          formatDate(r.entry_date),
          `${entryLabel(r)}${r.ref_label && r.text ? ` – ${r.text}` : ''} (${r.recurring_id ? 'Dauerauftrag' : SOURCE_LABELS[r.source]}${r.category || r.ref_category ? `, ${categoryLabel(r.category || r.ref_category!)}` : ''}${r.vat_rate ? `, inkl. ${r.vat_rate / 100} % USt.` : ''})`,
          r.receipt_ref, ...(t.nonprofit ? [SPHERES.find((s) => s.value === entrySphere(r, t.default_sphere))?.short ?? ''] : []),
          r.amount > 0 ? formatMoney(r.amount) : '', r.amount < 0 ? formatMoney(-r.amount) : '', formatMoney(r.balance),
        ],
      })),
      { cells: ['', 'Summe / Endbestand', '', ...(t.nonprofit ? [''] : []), formatMoney(rep.income), formatMoney(rep.expense), formatMoney(rep.closing)], bold: true },
    ],
  }];
  return renderTablePdf({
    title: `Kassenbuch ${rep.account.name}`,
    subtitle: `${t.name} · ${rep.account.kind === 'cash' ? 'Bargeldkasse' : 'Bankkonto'} · ${formatDate(from)} – ${formatDate(to)}`,
    author: t.name, footer: `Kassenbuch ${rep.account.name} ${from.slice(0, 4)}`, sections, landscape: true,
  });
}

export async function countsCsv(t: Tenant, from: string, to: string): Promise<string | null> {
  const rows = await all<CashCount & { account_name: string }>(
    `SELECT k.*, a.name account_name FROM cash_counts k JOIN cash_accounts a ON a.id = k.account_id
     WHERE k.tenant_id = ? AND k.count_date BETWEEN ? AND ? ORDER BY a.name, k.count_date, k.id`,
    t.id, from, to,
  );
  if (!rows.length) return null;
  const head = ['Kasse', 'Datum', 'Buchbestand', 'Gezählt', 'Differenz', ...DENOMINATIONS.map((d) => (d >= 100 ? `${d / 100} €` : `${d} ct`)), 'Notiz'];
  return csv(head, rows.map((k) => {
    const den = JSON.parse(k.denominations) as Record<string, number>;
    return [k.account_name, formatDate(k.count_date), num(k.book_balance), num(k.counted), num(k.difference), ...DENOMINATIONS.map((d) => den[d] ?? ''), k.note];
  }));
}

export async function donationsCsv(t: Tenant, from: string, to: string): Promise<string | null> {
  const rows = await all<{
    donation_date: string; kind: string; amount: number; waiver: number; description: string; name: string; street: string; zip: string; city: string;
    number: string | null; issue_date: string | null;
  }>(
    `SELECT d.donation_date, d.kind, d.amount, d.waiver, d.description,
       TRIM(CONCAT(c.company, IF(c.company <> '' AND c.name <> '', ', ', ''), c.name)) name, c.street, c.zip, c.city, r.number, r.issue_date
     FROM donations d JOIN contacts c ON c.id = d.contact_id LEFT JOIN donation_receipts r ON r.id = d.receipt_id
     WHERE d.tenant_id = ? AND d.donation_date BETWEEN ? AND ? ORDER BY d.donation_date, d.id`,
    t.id, from, to,
  );
  if (!rows.length) return null;
  const kinds: Record<string, string> = { money: 'Geldzuwendung', membership: 'Mitgliedsbeitrag', goods: 'Sachzuwendung' };
  return csv(
    ['Datum', 'Zuwendender', 'Anschrift', 'Art', 'Betrag/Wert', 'Aufwandsverzicht', 'Bezeichnung (Sachzuwendung)', 'Bestätigung Nr.', 'Bestätigt am'],
    rows.map((r) => [
      formatDate(r.donation_date), r.name, [r.street, `${r.zip} ${r.city}`.trim()].filter(Boolean).join(', '), kinds[r.kind] ?? r.kind, num(r.amount),
      r.kind === 'goods' ? '' : r.waiver ? 'ja' : 'nein', r.description, r.number ?? '', r.issue_date ? formatDate(r.issue_date) : '',
    ]),
  );
}

export interface SphereSum { sphere: string; label: string; income: number; expense: number }

/** Einnahmen und Ausgaben je Bereich aus den Kassenbuchungen (Umbuchungen bleiben außen vor) */
export function sphereSummary(t: Tenant, reports: AccountReport[]): SphereSum[] {
  const keys = t.nonprofit ? [...SPHERES.map((s) => s.value as string)] : [''];
  const map = new Map(keys.map((k) => [k, { sphere: k, label: k ? sphereLabel(k) : 'Verein gesamt', income: 0, expense: 0 }]));
  for (const rep of reports) {
    for (const r of rep.rows) {
      if (r.source === 'transfer') continue;
      const key = t.nonprofit ? entrySphere(r, t.default_sphere) : '';
      const m = map.get(key) ?? map.get(keys[0])!;
      if (r.amount > 0) m.income += r.amount;
      else m.expense += -r.amount;
    }
  }
  return [...map.values()];
}

export function sphereCsv(sums: SphereSum[]): string {
  const total = sums.reduce((a, s) => ({ income: a.income + s.income, expense: a.expense + s.expense }), { income: 0, expense: 0 });
  return csv(['Bereich', 'Einnahmen', 'Ausgaben', 'Überschuss'], [
    ...sums.map((s) => [s.label, num(s.income), num(s.expense), num(s.income - s.expense)]),
    ['Gesamt', num(total.income), num(total.expense), num(total.income - total.expense)],
  ]);
}

/** Deckblatt mit Kontenständen, Bereichsübersicht, Spenden und Hinweisen */
export async function summaryPdf(t: Tenant, from: string, to: string, reports: AccountReport[], sums: SphereSum[], notes: string[]): Promise<Buffer> {
  const totalOpen = reports.reduce((a, r) => a + r.opening, 0);
  const totalClose = reports.reduce((a, r) => a + r.closing, 0);
  const don = await one<{ money: number; membership: number; goods: number; receipts: number }>(
    `SELECT COALESCE(SUM(IF(kind = 'money', amount, 0)), 0) money, COALESCE(SUM(IF(kind = 'membership', amount, 0)), 0) membership,
       COALESCE(SUM(IF(kind = 'goods', amount, 0)), 0) goods,
       (SELECT COUNT(*) FROM donation_receipts WHERE tenant_id = ? AND status = 'issued' AND issue_date BETWEEN ? AND ?) receipts
     FROM donations WHERE tenant_id = ? AND donation_date BETWEEN ? AND ?`,
    t.id, from, to, t.id, from, to,
  );
  const sumTotal = sums.reduce((a, s) => ({ income: a.income + s.income, expense: a.expense + s.expense }), { income: 0, expense: 0 });
  const sections: TableSection[] = [
    {
      heading: 'Konten',
      columns: [{ label: 'Konto', width: 30 }, { label: 'Anfangsbestand', width: 14, right: true }, { label: 'Einnahmen', width: 14, right: true },
        { label: 'Ausgaben', width: 14, right: true }, { label: 'Umbuchungen', width: 14, right: true }, { label: 'Endbestand', width: 14, right: true }],
      rows: [
        ...reports.map((r) => ({ cells: [`${r.account.name} (${r.account.kind === 'cash' ? 'Kasse' : 'Bank'})`, formatMoney(r.opening), formatMoney(r.income), formatMoney(r.expense), formatMoney(r.transfers), formatMoney(r.closing)] })),
        { cells: ['Gesamt', formatMoney(totalOpen), formatMoney(reports.reduce((a, r) => a + r.income, 0)), formatMoney(reports.reduce((a, r) => a + r.expense, 0)), '', formatMoney(totalClose)], bold: true },
      ],
    },
    {
      heading: t.nonprofit ? 'Einnahmen und Ausgaben nach Bereichen' : 'Einnahmen und Ausgaben',
      text: 'Aus dem Kassenbuch nach Zahlungsdatum (Zuflussprinzip), Beträge brutto. Umbuchungen zwischen den Konten sind nicht enthalten.',
      columns: [{ label: 'Bereich', width: 40 }, { label: 'Einnahmen', width: 20, right: true }, { label: 'Ausgaben', width: 20, right: true }, { label: 'Überschuss', width: 20, right: true }],
      rows: [
        ...sums.map((s) => ({ cells: [s.label, formatMoney(s.income), formatMoney(s.expense), formatMoney(s.income - s.expense)] })),
        { cells: ['Gesamt', formatMoney(sumTotal.income), formatMoney(sumTotal.expense), formatMoney(sumTotal.income - sumTotal.expense)], bold: true },
      ],
    },
  ];
  if (t.nonprofit && don && (don.money || don.membership || don.goods)) {
    sections.push({
      heading: 'Zuwendungen',
      columns: [{ label: 'Art', width: 60 }, { label: 'Betrag', width: 40, right: true }],
      rows: [
        { cells: ['Geldspenden', formatMoney(Number(don.money))] },
        { cells: ['Mitgliedsbeiträge', formatMoney(Number(don.membership))] },
        { cells: ['Sachspenden (Wert)', formatMoney(Number(don.goods))] },
        { cells: [`Ausgestellte Zuwendungsbestätigungen`, String(don.receipts)] },
      ],
    });
  }
  sections.push({
    heading: 'Inhalt des Pakets',
    columns: [{ label: 'Ordner / Datei', width: 35 }, { label: 'Inhalt', width: 65 }],
    rows: [
      ['01_Kassenbuch', 'Kassenbuch je Konto als PDF und CSV (Excel), mit laufendem Saldo'],
      ['02_Kassenzaehlungen.csv', 'Zählprotokolle der Bargeldkassen mit Stückelung und Differenz'],
      ['03_Ausgangsrechnungen', 'Rechnungen als ZUGFeRD-PDF und XRechnung, Rechnungsausgangsbuch (CSV)'],
      ['04_Eingangsrechnungen', 'Original-Belege, Rechnungseingangsbuch (CSV)'],
      ['05_Spenden', 'Zuwendungsliste (CSV) und Doppel der Zuwendungsbestätigungen'],
      ['06_Einnahmen_Ausgaben', 'Einnahmen und Ausgaben nach Bereichen (CSV)'],
    ].map((cells) => ({ cells })),
  });
  if (notes.length) sections.push({ heading: 'Hinweise', columns: [{ label: 'Hinweis', width: 100 }], rows: notes.map((n) => ({ cells: [n] })) });
  return renderTablePdf({
    title: `Jahresunterlagen ${t.name}`,
    subtitle: `Zeitraum ${formatDate(from)} – ${formatDate(to)} · erstellt mit Schottr am ${formatDate(new Date().toISOString().slice(0, 10))}`,
    author: t.name, footer: `Übersicht ${from.slice(0, 4)}`, sections,
  });
}

export { vatOf };
