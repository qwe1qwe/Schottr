import { all, one } from '../db/index.ts';
import { cashbookEnabled, unassigned } from './cashbook/repo.ts';
import { readEntryFile } from './cashbook/files.ts';
import { accountReports, cashbookCsv, cashbookPdf, countsCsv, donationsCsv, sphereCsv, sphereSummary, summaryPdf } from './cashbook/report.ts';
import { audit } from '../lib/audit.ts';
import { buildDatevCsv, creditorAccount, revenueAccounts, type DatevInvoice, type DatevPurchase } from '../lib/datev.ts';
import { categoryLabel, expenseAccounts } from '../lib/expenses.ts';
import { readStoredFile } from '../lib/files.ts';
import { html as h } from '../lib/html.ts';
import { formatDate, isIsoDate, today } from '../lib/dates.ts';
import { html } from '../lib/html.ts';
import { attachment, tenantOf, userOf } from '../lib/http.ts';
import { orgDataLabel } from './settings.ts';
import { formatAmount, formatMoney } from '../lib/money.ts';
import { createZip } from '../lib/zip.ts';
import { inboxCount } from './inbox/repo.ts';
import { INVOICE_TYPES, dueAmount, type DocumentData } from '../einvoice/model.ts';
import { page } from '../views/layout.ts';
import type { App, Ctx, Module, Tenant } from '../types.ts';

/**
 * Export für Buchhaltung/Steuerberater:
 *  - DATEV-Buchungsstapel (EXTF 700) mit Ausgangs- und/oder Eingangsrechnungen
 *  - Rechnungsausgangsbuch und Rechnungseingangsbuch (CSV für Excel)
 *  - ZIP mit allen ZUGFeRD-PDFs, XRechnung-Dateien und den Belegen der Eingangsrechnungen
 * Grundlage sind festgeschriebene Rechnungen (eingefrorene Daten) und erfasste
 * Eingangsrechnungen (ohne noch nicht erfasste Belege).
 */

interface ExportRow {
  id: number;
  number: string;
  status: string;
  paid_at: string | null;
  snapshot: string;
}

function period(c: Ctx): { from: string; to: string; error?: string } {
  const d = today();
  const firstThisMonth = `${d.slice(0, 8)}01`;
  const prev = new Date(`${firstThisMonth}T12:00:00Z`);
  prev.setUTCDate(0); // letzter Tag des Vormonats
  const defTo = prev.toISOString().slice(0, 10);
  const defFrom = `${defTo.slice(0, 8)}01`;
  const from = c.req.query('from') ?? defFrom;
  const to = c.req.query('to') ?? defTo;
  if (!isIsoDate(from) || !isIsoDate(to) || to < from) return { from: defFrom, to: defTo, error: 'Bitte einen gültigen Zeitraum wählen.' };
  return { from, to };
}

async function invoicesIn(t: Tenant, from: string, to: string): Promise<ExportRow[]> {
  return all<ExportRow>(
    `SELECT id, number, status, paid_at, snapshot FROM documents
     WHERE tenant_id = ? AND kind = 'invoice' AND finalized_at IS NOT NULL AND issue_date BETWEEN ? AND ?
     ORDER BY issue_date, number`,
    t.id, from, to,
  );
}

interface PurchaseRow {
  id: number;
  number: string;
  issue_date: string;
  due_date: string | null;
  status: string;
  paid_at: string | null;
  is_credit: number;
  category: string;
  currency: string;
  description: string;
  net_total: number;
  tax_total: number;
  gross_total: number;
  prepaid_total: number;
  einvoice_format: string;
  file_name: string;
  file_path: string;
  supplier_name: string;
  supplier_number: string;
  supplier_vat: string;
  taxes: { category: string; rate: number; basis: number; tax: number }[];
}

async function purchasesIn(t: Tenant, from: string, to: string): Promise<PurchaseRow[]> {
  const rows = await all<Omit<PurchaseRow, 'taxes'>>(
    `SELECT p.id, p.number, p.issue_date, p.due_date, p.status, p.paid_at, p.is_credit, p.category, p.currency, p.description,
            p.net_total, p.tax_total, p.gross_total, p.prepaid_total, p.einvoice_format, p.file_name, p.file_path,
            COALESCE(NULLIF(c.company, ''), c.name, '') AS supplier_name, COALESCE(c.customer_number, '') AS supplier_number,
            COALESCE(c.vat_id, '') AS supplier_vat
     FROM purchase_invoices p LEFT JOIN contacts c ON c.id = p.contact_id
     WHERE p.tenant_id = ? AND p.status <> 'draft' AND p.issue_date BETWEEN ? AND ?
     ORDER BY p.issue_date, p.id`,
    t.id, from, to,
  );
  const taxes = rows.length
    ? await all<{ purchase_id: number; category: string; rate: number; basis: number; tax: number }>(
        `SELECT purchase_id, category, rate, basis, tax FROM purchase_invoice_taxes WHERE purchase_id IN (${rows.map(() => '?').join(',')}) ORDER BY \`position\``,
        ...rows.map((r) => r.id),
      )
    : [];
  return rows.map((r) => ({ ...r, taxes: taxes.filter((x) => x.purchase_id === r.id) }));
}

const csvField = (v: string | number) => {
  const s = String(v);
  return /[";\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};
const num = (cents: number) => formatAmount(cents).replace(/\./g, '');

function journalCsv(rows: ExportRow[]): string {
  const head = [
    'Rechnungsnr.', 'Art', 'Rechnungsdatum', 'Leistungsdatum', 'Kundennr.', 'Kunde', 'USt-IdNr. Kunde',
    'Netto 19 %', 'USt 19 %', 'Netto 7 %', 'USt 7 %', 'Netto ohne USt', 'Netto gesamt', 'USt gesamt', 'Brutto',
    'Abgezogene Teilrechnungen', 'Zahlbetrag', 'Fällig am', 'Status', 'Bezahlt am',
  ];
  const statusLabel: Record<string, string> = { open: 'offen', paid: 'bezahlt', cancelled: 'storniert', settled: 'Storno' };
  const lines = rows.map((r) => {
    const d = JSON.parse(r.snapshot) as DocumentData;
    const sign = d.typeCode === '381' ? -1 : 1;
    const g = (rate: number) => d.taxes.find((x) => x.category === 'S' && x.rate === rate);
    const other = d.taxes.filter((x) => x.category !== 'S').reduce((s, x) => s + x.basis, 0);
    return [
      d.number, INVOICE_TYPES[d.typeCode] ?? d.typeCode, formatDate(d.issueDate),
      d.serviceDate ? formatDate(d.serviceDate) : d.serviceFrom ? `${formatDate(d.serviceFrom)} – ${formatDate(d.serviceTo)}` : '',
      d.buyer.customerNumber, d.buyer.name, d.buyer.vatId,
      num(sign * (g(1900)?.basis ?? 0)), num(sign * (g(1900)?.tax ?? 0)), num(sign * (g(700)?.basis ?? 0)), num(sign * (g(700)?.tax ?? 0)),
      num(sign * other), num(sign * d.net), num(sign * d.tax), num(sign * d.gross),
      (d.prepayments ?? []).map((p) => p.number).join(', '), num(sign * dueAmount(d)),
      d.dueDate ? formatDate(d.dueDate) : '', statusLabel[r.status] ?? r.status, r.paid_at ? formatDate(r.paid_at) : '',
    ].map(csvField).join(';');
  });
  // BOM, damit Excel UTF-8 erkennt
  return '﻿' + [head.join(';'), ...lines].join('\r\n') + '\r\n';
}

const safeName = (s: string) => s.replace(/[^\w.\-]+/g, '_');

/** Rechnungseingangsbuch: alle erfassten Eingangsrechnungen mit Vorsteuer je Satz */
function purchaseJournalCsv(t: Tenant, rows: PurchaseRow[]): string {
  const accounts = expenseAccounts(t);
  const head = [
    'Rechnungsdatum', 'Lieferant', 'Lieferantennr.', 'USt-IdNr. Lieferant', 'Rechnungsnr.', 'Art', 'Kostenart', 'Aufwandskonto', 'Kreditor',
    'Netto 19 %', 'Vorsteuer 19 %', 'Netto 7 %', 'Vorsteuer 7 %', 'Netto ohne USt', 'Netto gesamt', 'USt gesamt', 'Brutto', 'Währung',
    'Fällig am', 'Status', 'Bezahlt am', 'Beschreibung', 'Format', 'Datei',
  ];
  const statusLabel: Record<string, string> = { open: 'offen', paid: 'bezahlt' };
  const lines = rows.map((r) => {
    const sign = r.is_credit ? -1 : 1;
    const g = (rate: number) => r.taxes.filter((x) => x.category === 'S' && x.rate === rate);
    const sum = (list: typeof r.taxes, k: 'basis' | 'tax') => list.reduce((a, x) => a + x[k], 0);
    const other = r.taxes.filter((x) => !(x.category === 'S' && (x.rate === 1900 || x.rate === 700)));
    return [
      formatDate(r.issue_date), r.supplier_name, r.supplier_number, r.supplier_vat, r.number, r.is_credit ? 'Gutschrift' : 'Rechnung',
      categoryLabel(r.category), accounts[r.category] ?? '', creditorAccount(t, r.supplier_number),
      num(sign * sum(g(1900), 'basis')), num(sign * sum(g(1900), 'tax')), num(sign * sum(g(700), 'basis')), num(sign * sum(g(700), 'tax')),
      num(sign * sum(other, 'basis')), num(sign * r.net_total), num(sign * r.tax_total), num(sign * r.gross_total), r.currency,
      r.due_date ? formatDate(r.due_date) : '', statusLabel[r.status] ?? r.status, r.paid_at ? formatDate(r.paid_at) : '',
      r.description, r.einvoice_format || (r.file_name ? 'Beleg' : 'ohne Beleg'), r.file_name ? zipPurchaseName(r) : '',
    ].map(csvField).join(';');
  });
  return '﻿' + [head.join(';'), ...lines].join('\r\n') + '\r\n';
}

/** Dateiname im ZIP: Datum_Lieferant_Nummer.ext */
function zipPurchaseName(r: Pick<PurchaseRow, 'issue_date' | 'supplier_name' | 'number' | 'id' | 'file_name'>): string {
  const ext = (/\.(pdf|xml|png|jpe?g)$/i.exec(r.file_name)?.[0] ?? '').toLowerCase();
  return `Eingangsrechnungen/${safeName(`${r.issue_date}_${r.supplier_name}_${r.number || `ER${r.id}`}`).slice(0, 120)}${ext}`;
}

/** Welche Rechnungen in den DATEV-Stapel? Ohne Angabe beide. */
function datevSelection(c: Ctx): { out: boolean; in: boolean } {
  const out = c.req.query('out');
  const inn = c.req.query('in');
  if (out === undefined && inn === undefined) return { out: true, in: true };
  return { out: out === '1', in: inn === '1' };
}

function register(app: App) {
  app.get('/export', async (c) => {
    const t = tenantOf(c);
    const { from, to, error } = period(c);
    const rows = await invoicesIn(t, from, to);
    const purchases = await purchasesIn(t, from, to);
    const sums = rows.reduce(
      (acc, r) => {
        const d = JSON.parse(r.snapshot) as DocumentData;
        const sign = d.typeCode === '381' ? -1 : 1;
        acc.net += sign * d.net;
        acc.gross += sign * d.gross;
        return acc;
      },
      { net: 0, gross: 0 },
    );
    const pSums = purchases.reduce(
      (acc, r) => ({ net: acc.net + (r.is_credit ? -1 : 1) * r.net_total, gross: acc.gross + (r.is_credit ? -1 : 1) * r.gross_total }),
      { net: 0, gross: 0 },
    );
    const drafts = (await all<{ n: number }>("SELECT COUNT(*) n FROM purchase_invoices WHERE tenant_id = ? AND status = 'draft'", t.id))[0]?.n ?? 0;
    const datevReady = !!(t.datev_consultant && t.datev_client);
    const sameYear = from.slice(0, 4) === to.slice(0, 4);
    const acc = revenueAccounts(t);
    const q = `from=${from}&to=${to}`;
    const any = rows.length + purchases.length > 0;
    return page(c, {
      title: 'Export',
      body: html`
      ${error ? html`<div class="flash flash-error">${error}</div>` : ''}
      <form method="get" class="card toolbar export-period">
        <label>Von <input type="date" name="from" value="${from}" required></label>
        <label>Bis <input type="date" name="to" value="${to}" required></label>
        <button class="btn">Zeitraum übernehmen</button>
      </form>
      <p class="muted">Zeitraum ${formatDate(from)} – ${formatDate(to)}:
        ${rows.length} Ausgangsrechnung(en) · netto ${formatMoney(sums.net)} · brutto ${formatMoney(sums.gross)}<br>
        ${purchases.length} Eingangsrechnung(en) · netto ${formatMoney(pSums.net)} · brutto ${formatMoney(pSums.gross)}</p>
      ${drafts ? html`<div class="notice"><a href="/purchases?status=draft">${drafts} hochgeladene(r) Beleg(e)</a> sind noch nicht erfasst und fehlen daher im Export.</div>` : ''}
      ${cashbookEnabled(t)
        ? html`<section class="card package-card">
            <h2>Jahrespaket fürs Steuerbüro</h2>
            <p class="muted small">Alles für die Steuererklärung des Vereins in einer ZIP-Datei: Übersicht (PDF) mit Kontenständen${t.nonprofit ? ', Einnahmen und Ausgaben nach Bereichen und Spenden' : ' sowie Einnahmen und Ausgaben'},
              Kassenbuch je Konto (PDF und Excel), Kassenzählungen, Ausgangs- und Eingangsrechnungen samt Belegen${t.nonprofit ? ', Zuwendungsliste und Zuwendungsbestätigungen' : ''}.</p>
            <form method="get" action="/export/package" class="inline-form">
              <select name="year" class="year-select" aria-label="Jahr">${[0, 1, 2, 3].map((i) => {
                const y = Number(today().slice(0, 4)) - i;
                return html`<option value="${y}"${i === 1 ? h` selected` : ''}>${y}</option>`;
              })}</select>
              <button class="btn primary">Paket herunterladen</button>
            </form>
          </section>`
        : ''}
      <div class="export-grid">
        <section class="card">
          <h2>DATEV-Buchungsstapel</h2>
          <p class="muted small">CSV im DATEV-Format (EXTF 700) zum Import beim Steuerberater bzw. in DATEV Unternehmen online.
            Ausgangsrechnungen: ${t.datev_debtor_mode === 'individual' ? `Debitor je Kunde ab ${t.datev_debtor_account}` : `Sammeldebitor ${t.datev_debtor_account}`},
            SKR${t.datev_skr}, Erlöse 19 % ${acc['19']}, 7 % ${acc['7']}.
            Eingangsrechnungen: ${t.datev_creditor_mode === 'individual' ? `Kreditor je Lieferant ab ${t.datev_creditor_account}` : `Sammelkreditor ${t.datev_creditor_account}`},
            Aufwandskonto je Kostenart, ${t.small_business ? 'brutto ohne Vorsteuer (Kleinunternehmer)' : 'Vorsteuer per BU-Schlüssel 9/8'}.</p>
          ${!datevReady ? html`<div class="notice">Bitte zuerst Berater- und Mandantennummer unter <a href="/settings">${orgDataLabel(tenantOf(c))} → DATEV-Export</a> eintragen.</div>` : ''}
          ${!sameYear ? html`<div class="notice">Ein DATEV-Stapel darf nur ein Wirtschaftsjahr umfassen – bitte den Zeitraum auf ein Jahr begrenzen.</div>` : ''}
          ${datevReady && sameYear && any
            ? html`<form method="get" action="/export/datev" class="stack">
                <input type="hidden" name="from" value="${from}"><input type="hidden" name="to" value="${to}">
                <div class="export-options">
                  <label class="check"><input type="checkbox" name="out" value="1"${rows.length ? h` checked` : h` disabled`}> Ausgangsrechnungen (${rows.length})</label>
                  <label class="check"><input type="checkbox" name="in" value="1"${purchases.length ? h` checked` : h` disabled`}> Eingangsrechnungen (${purchases.length})</label>
                </div>
                <button class="btn primary">DATEV-CSV herunterladen</button>
              </form>`
            : ''}
        </section>
        <section class="card">
          <h2>Rechnungsausgangsbuch</h2>
          <p class="muted small">Alle Rechnungen des Zeitraums mit Beträgen je Steuersatz – zum Öffnen in Excel.</p>
          ${rows.length ? html`<a class="btn" href="/export/journal?${q}">CSV herunterladen</a>` : html`<p class="muted small">Keine Rechnungen im Zeitraum.</p>`}
        </section>
        <section class="card">
          <h2>Rechnungseingangsbuch</h2>
          <p class="muted small">Alle Eingangsrechnungen mit Vorsteuer je Steuersatz, Kostenart, Aufwands- und Kreditorenkonto – zum Öffnen in Excel.</p>
          ${purchases.length ? html`<a class="btn" href="/export/purchases?${q}">CSV herunterladen</a>` : html`<p class="muted small">Keine Eingangsrechnungen im Zeitraum.</p>`}
        </section>
        <section class="card">
          <h2>Belege als ZIP</h2>
          <p class="muted small">Alle ZUGFeRD-PDFs und XRechnungen der Ausgangsrechnungen sowie die Original-Belege der Eingangsrechnungen, dazu beide Bücher als CSV – für den Steuerberater oder die Archivierung.</p>
          ${any ? html`<a class="btn" href="/export/zip?${q}">ZIP herunterladen</a>` : ''}
        </section>
      </div>
      <p class="muted small">Ausgangsrechnungen: nur festgeschriebene (inkl. Stornorechnungen). Eingangsrechnungen: alle erfassten (offen und bezahlt). Maßgeblich ist jeweils das Rechnungsdatum.</p>`,
    });
  });

  app.get('/export/datev', async (c) => {
    const t = tenantOf(c);
    const { from, to, error } = period(c);
    if (error || from.slice(0, 4) !== to.slice(0, 4)) return c.redirect(`/export?from=${from}&to=${to}`);
    const sel = datevSelection(c);
    if (!sel.out && !sel.in) return c.redirect(`/export?from=${from}&to=${to}`);
    const rows = sel.out ? await invoicesIn(t, from, to) : [];
    const invoices: DatevInvoice[] = [];
    for (const r of rows) {
      const prepaid = await all<{ snapshot: string }>(
        `SELECT d.snapshot FROM document_prepayments p JOIN documents d ON d.id = p.prepaid_id WHERE p.document_id = ? ORDER BY d.issue_date`,
        r.id,
      );
      invoices.push({ data: JSON.parse(r.snapshot), prepaidSnapshots: prepaid.map((p) => JSON.parse(p.snapshot)) });
    }
    const purchases: DatevPurchase[] = (sel.in ? await purchasesIn(t, from, to) : []).map((p) => ({
      id: p.id, number: p.number, issueDate: p.issue_date, isCredit: !!p.is_credit, currency: p.currency, category: p.category,
      supplierName: p.supplier_name, supplierNumber: p.supplier_number, taxes: p.taxes,
    }));
    const csv = buildDatevCsv(t, { invoices, purchases }, from, to, userOf(c).name || userOf(c).email);
    await audit(c, 'export.datev', `${from} – ${to}, ${invoices.length} Ausgangs-, ${purchases.length} Eingangsrechnungen`);
    const kind = sel.out && sel.in ? '' : sel.out ? '_Ausgang' : '_Eingang';
    return c.body(new Uint8Array(csv), 200, {
      'Content-Type': 'text/csv; charset=windows-1252',
      'Content-Disposition': attachment(`EXTF_Buchungsstapel${kind}_${from}_${to}.csv`),
      'Cache-Control': 'private, no-store',
    });
  });

  app.get('/export/journal', async (c) => {
    const t = tenantOf(c);
    const { from, to } = period(c);
    const rows = await invoicesIn(t, from, to);
    await audit(c, 'export.journal', `${from} – ${to}, ${rows.length} Rechnungen`);
    return c.body(journalCsv(rows), 200, {
      'Content-Type': 'text/csv; charset=utf-8',
      'Content-Disposition': attachment(`Rechnungsausgangsbuch_${from}_${to}.csv`),
      'Cache-Control': 'private, no-store',
    });
  });

  app.get('/export/purchases', async (c) => {
    const t = tenantOf(c);
    const { from, to } = period(c);
    const rows = await purchasesIn(t, from, to);
    await audit(c, 'export.purchases', `${from} – ${to}, ${rows.length} Eingangsrechnungen`);
    return c.body(purchaseJournalCsv(t, rows), 200, {
      'Content-Type': 'text/csv; charset=utf-8',
      'Content-Disposition': attachment(`Rechnungseingangsbuch_${from}_${to}.csv`),
      'Cache-Control': 'private, no-store',
    });
  });

  app.get('/export/package', async (c) => {
    const t = tenantOf(c);
    if (!cashbookEnabled(t)) return c.redirect('/export');
    const year = /^\d{4}$/.test(c.req.query('year') ?? '') ? c.req.query('year')! : String(Number(today().slice(0, 4)) - 1);
    const from = `${year}-01-01`;
    const to = `${year}-12-31`;
    const files: { name: string; data: Buffer | string }[] = [];

    // Kassenbuch je Konto
    const reports = await accountReports(t, from, to);
    // Belege zu den Buchungen (Fotos, PDFs) unter 01_Kassenbuch/Belege/<Konto>/
    const entryFiles = await all<{ id: number; entry_id: number; file_name: string; file_path: string; entry_date: string; account_name: string }>(
      `SELECT f.id, f.entry_id, f.file_name, f.file_path, e.entry_date, a.name account_name
       FROM cash_entry_files f JOIN cash_entries e ON e.id = f.entry_id JOIN cash_accounts a ON a.id = e.account_id
       WHERE f.tenant_id = ? AND e.entry_date BETWEEN ? AND ? ORDER BY e.entry_date, f.id`,
      t.id, from, to,
    );
    const fileNames = new Map<number, string[]>();
    for (const f of entryFiles) {
      const name = `01_Kassenbuch/Belege/${safeName(f.account_name)}/${f.entry_date}_B${f.entry_id}_${safeName(f.file_name)}`;
      fileNames.set(f.entry_id, [...(fileNames.get(f.entry_id) ?? []), name.split('/').pop()!]);
      files.push({ name, data: await readEntryFile(f) });
    }
    for (const rep of reports) {
      const base = `01_Kassenbuch/${safeName(rep.account.name)}_${year}`;
      files.push({ name: `${base}.pdf`, data: await cashbookPdf(t, rep, from, to) });
      files.push({ name: `${base}.csv`, data: cashbookCsv(t, rep, fileNames) });
    }
    const counts = await countsCsv(t, from, to);
    if (counts) files.push({ name: `02_Kassenzaehlungen_${year}.csv`, data: counts });

    // Rechnungen und Belege
    const rows = await invoicesIn(t, from, to);
    if (rows.length) files.push({ name: `03_Ausgangsrechnungen/Rechnungsausgangsbuch_${year}.csv`, data: journalCsv(rows) });
    for (const r of rows) {
      const blobs = await all<{ pdf: Buffer | null; xml: string | null }>('SELECT pdf, xml FROM documents WHERE id = ?', r.id);
      const d = JSON.parse(r.snapshot) as DocumentData;
      const base = `03_Ausgangsrechnungen/${safeName(`${d.number}_${INVOICE_TYPES[d.typeCode] ?? 'Rechnung'}`)}`;
      if (blobs[0]?.pdf) files.push({ name: `${base}.pdf`, data: Buffer.from(blobs[0].pdf) });
      if (blobs[0]?.xml) files.push({ name: `${base}_XRechnung.xml`, data: blobs[0].xml });
    }
    const purchases = await purchasesIn(t, from, to);
    if (purchases.length) files.push({ name: `04_Eingangsrechnungen/Rechnungseingangsbuch_${year}.csv`, data: purchaseJournalCsv(t, purchases) });
    const used = new Set<string>();
    for (const p of purchases) {
      if (!p.file_path) continue;
      let name = zipPurchaseName(p).replace(/^Eingangsrechnungen\//, '04_Eingangsrechnungen/');
      if (used.has(name)) name = name.replace(/(\.\w+)?$/, `_${p.id}$1`);
      used.add(name);
      files.push({ name, data: await readStoredFile('verbindlichkeiten', p.file_path) });
    }

    // Spenden
    const donations = await donationsCsv(t, from, to);
    if (donations) files.push({ name: `05_Spenden/Zuwendungsliste_${year}.csv`, data: donations });
    const receipts = await all<{ number: string; pdf: Buffer; status: string }>(
      'SELECT number, pdf, status FROM donation_receipts WHERE tenant_id = ? AND issue_date BETWEEN ? AND ? ORDER BY number', t.id, from, to,
    );
    for (const r of receipts) {
      files.push({ name: `05_Spenden/Zuwendungsbestaetigungen/${safeName(r.number)}${r.status === 'cancelled' ? '_STORNIERT' : ''}.pdf`, data: Buffer.from(r.pdf) });
    }

    // Auswertung und Deckblatt
    const sums = sphereSummary(t, reports);
    files.push({ name: `06_Einnahmen_Ausgaben_${year}.csv`, data: sphereCsv(sums) });
    const notes: string[] = [];
    const open = (await unassigned(t)).filter((u) => u.date >= from && u.date <= to);
    if (open.length) notes.push(`${open.length} bezahlte Rechnung(en)/Spende(n) aus ${year} sind noch keinem Konto zugeordnet und fehlen im Kassenbuch.`);
    const openInv = await one<{ n: number; s: number }>(
      "SELECT COUNT(*) n, COALESCE(SUM(gross_total - prepaid_total), 0) s FROM documents WHERE tenant_id = ? AND kind = 'invoice' AND status = 'open' AND issue_date <= ?", t.id, to,
    );
    if (openInv?.n) notes.push(`${openInv.n} Ausgangsrechnung(en) bis ${formatDate(to)} sind noch offen (${formatMoney(Number(openInv.s))}).`);
    const drafts = await one<{ n: number }>("SELECT COUNT(*) n FROM purchase_invoices WHERE tenant_id = ? AND status = 'draft'", t.id);
    if (drafts?.n) notes.push(`${drafts.n} hochgeladene(r) Beleg(e) sind noch nicht erfasst und fehlen.`);
    const inboxN = await inboxCount(t.id);
    if (inboxN) notes.push(`${inboxN} Beleg(e) im Belegeingang sind noch keiner Eingangsrechnung oder Buchung zugeordnet und fehlen.`);
    if (!t.cashbook_locked_until || t.cashbook_locked_until < to) notes.push(`Das Kassenbuch ist für ${year} noch nicht abgeschlossen – Änderungen sind noch möglich.`);
    for (const r of reports) {
      // Stand am Tagesende (innerhalb eines Tages ist die Reihenfolge der Buchungen zufällig)
      const endOfDay = new Map(r.rows.map((x) => [x.entry_date, x.balance]));
      if (r.account.kind === 'cash' && [...endOfDay.values()].some((b) => b < 0)) notes.push(`Die Kasse „${r.account.name}“ war zeitweise im Minus – bitte prüfen.`);
    }
    files.unshift({ name: `00_Uebersicht_${year}.pdf`, data: await summaryPdf(t, from, to, reports, sums, notes) });

    await audit(c, 'export.package', `${year}: ${files.length} Dateien`);
    return c.body(new Uint8Array(createZip(files)), 200, {
      'Content-Type': 'application/zip',
      'Content-Disposition': attachment(`Steuerbuero_${safeName(t.name)}_${year}.zip`),
      'Cache-Control': 'private, no-store',
    });
  });

  app.get('/export/zip', async (c) => {
    const t = tenantOf(c);
    const { from, to } = period(c);
    const rows = await invoicesIn(t, from, to);
    const purchases = await purchasesIn(t, from, to);
    const files: { name: string; data: Buffer | string }[] = [];
    if (rows.length) files.push({ name: `Rechnungsausgangsbuch_${from}_${to}.csv`, data: journalCsv(rows) });
    if (purchases.length) files.push({ name: `Rechnungseingangsbuch_${from}_${to}.csv`, data: purchaseJournalCsv(t, purchases) });
    for (const r of rows) {
      const blobs = await all<{ pdf: Buffer | null; xml: string | null }>('SELECT pdf, xml FROM documents WHERE id = ?', r.id);
      const d = JSON.parse(r.snapshot) as DocumentData;
      const base = `Ausgangsrechnungen/${safeName(`${d.number}_${INVOICE_TYPES[d.typeCode] ?? 'Rechnung'}`)}`;
      if (blobs[0]?.pdf) files.push({ name: `${base}.pdf`, data: Buffer.from(blobs[0].pdf) });
      if (blobs[0]?.xml) files.push({ name: `${base}_XRechnung.xml`, data: blobs[0].xml });
    }
    const used = new Set<string>();
    for (const p of purchases) {
      if (!p.file_path) continue;
      let name = zipPurchaseName(p);
      if (used.has(name)) name = name.replace(/(\.\w+)?$/, `_${p.id}$1`);
      used.add(name);
      files.push({ name, data: await readStoredFile('verbindlichkeiten', p.file_path) });
    }
    await audit(c, 'export.zip', `${from} – ${to}, ${rows.length} Ausgangs-, ${purchases.length} Eingangsrechnungen`);
    return c.body(new Uint8Array(createZip(files)), 200, {
      'Content-Type': 'application/zip',
      'Content-Disposition': attachment(`Belege_${safeName(t.name)}_${from}_${to}.zip`),
      'Cache-Control': 'private, no-store',
    });
  });
}

export const exportModule: Module = {
  name: 'export',
  nav: { label: 'Export', href: '/export', order: 40, group: 'finance', icon: 'export' },
  register,
};
