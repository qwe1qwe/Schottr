import { all } from '../db/index.ts';
import { audit } from '../lib/audit.ts';
import { buildDatevCsv, revenueAccounts, type DatevInvoice } from '../lib/datev.ts';
import { formatDate, isIsoDate, today } from '../lib/dates.ts';
import { html } from '../lib/html.ts';
import { attachment, tenantOf, userOf } from '../lib/http.ts';
import { formatAmount, formatMoney } from '../lib/money.ts';
import { createZip } from '../lib/zip.ts';
import { INVOICE_TYPES, dueAmount, type DocumentData } from '../einvoice/model.ts';
import { page } from '../views/layout.ts';
import type { App, Ctx, Module, Tenant } from '../types.ts';

/**
 * Export für Buchhaltung/Steuerberater:
 *  - DATEV-Buchungsstapel (EXTF 700)
 *  - Rechnungsausgangsbuch (CSV für Excel)
 *  - ZIP mit allen ZUGFeRD-PDFs und XRechnung-Dateien des Zeitraums
 * Grundlage sind ausschließlich festgeschriebene Rechnungen (eingefrorene Daten).
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

function register(app: App) {
  app.get('/export', async (c) => {
    const t = tenantOf(c);
    const { from, to, error } = period(c);
    const rows = await invoicesIn(t, from, to);
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
    const datevReady = !!(t.datev_consultant && t.datev_client);
    const sameYear = from.slice(0, 4) === to.slice(0, 4);
    const acc = revenueAccounts(t);
    const q = `from=${from}&to=${to}`;
    return page(c, {
      title: 'Export',
      body: html`
      ${error ? html`<div class="flash flash-error">${error}</div>` : ''}
      <form method="get" class="card toolbar export-period">
        <label>Von <input type="date" name="from" value="${from}" required></label>
        <label>Bis <input type="date" name="to" value="${to}" required></label>
        <button class="btn">Zeitraum übernehmen</button>
      </form>
      <p class="muted">${rows.length} festgeschriebene Rechnung(en) im Zeitraum ${formatDate(from)} – ${formatDate(to)}
        · netto ${formatMoney(sums.net)} · brutto ${formatMoney(sums.gross)}</p>
      <div class="export-grid">
        <section class="card">
          <h2>DATEV-Buchungsstapel</h2>
          <p class="muted small">CSV im DATEV-Format (EXTF 700) zum Import beim Steuerberater bzw. in DATEV Unternehmen online.
            ${t.datev_debtor_mode === 'individual' ? `Debitor je Kunde ab ${t.datev_debtor_account}` : `Sammeldebitor ${t.datev_debtor_account}`} ·
            SKR${t.datev_skr} · Erlöse 19 % ${acc['19']}, 7 % ${acc['7']}.</p>
          ${!datevReady ? html`<div class="notice">Bitte zuerst Berater- und Mandantennummer unter <a href="/settings">Einstellungen → DATEV-Export</a> eintragen.</div>` : ''}
          ${!sameYear ? html`<div class="notice">Ein DATEV-Stapel darf nur ein Wirtschaftsjahr umfassen – bitte den Zeitraum auf ein Jahr begrenzen.</div>` : ''}
          ${datevReady && sameYear && rows.length ? html`<a class="btn primary" href="/export/datev?${q}">DATEV-CSV herunterladen</a>` : ''}
        </section>
        <section class="card">
          <h2>Rechnungsausgangsbuch</h2>
          <p class="muted small">Alle Rechnungen des Zeitraums mit Beträgen je Steuersatz – zum Öffnen in Excel.</p>
          ${rows.length ? html`<a class="btn" href="/export/journal?${q}">CSV herunterladen</a>` : ''}
        </section>
        <section class="card">
          <h2>Belege als ZIP</h2>
          <p class="muted small">Alle ZUGFeRD-PDFs und XRechnung-Dateien des Zeitraums plus Rechnungsausgangsbuch – z. B. für den Steuerberater oder die Archivierung.</p>
          ${rows.length ? html`<a class="btn" href="/export/zip?${q}">ZIP herunterladen</a>` : ''}
        </section>
      </div>
      <p class="muted small">Exportiert werden nur festgeschriebene Rechnungen (inkl. Stornorechnungen), maßgeblich ist das Rechnungsdatum.</p>`,
    });
  });

  app.get('/export/datev', async (c) => {
    const t = tenantOf(c);
    const { from, to, error } = period(c);
    if (error || from.slice(0, 4) !== to.slice(0, 4)) return c.redirect(`/export?from=${from}&to=${to}`);
    const rows = await invoicesIn(t, from, to);
    const invoices: DatevInvoice[] = [];
    for (const r of rows) {
      const prepaid = await all<{ snapshot: string }>(
        `SELECT d.snapshot FROM document_prepayments p JOIN documents d ON d.id = p.prepaid_id WHERE p.document_id = ? ORDER BY d.issue_date`,
        r.id,
      );
      invoices.push({ data: JSON.parse(r.snapshot), prepaidSnapshots: prepaid.map((p) => JSON.parse(p.snapshot)) });
    }
    const csv = buildDatevCsv(t, invoices, from, to, userOf(c).name || userOf(c).email);
    await audit(c, 'export.datev', `${from} – ${to}, ${rows.length} Rechnungen`);
    return c.body(new Uint8Array(csv), 200, {
      'Content-Type': 'text/csv; charset=windows-1252',
      'Content-Disposition': attachment(`EXTF_Buchungsstapel_${from}_${to}.csv`),
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

  app.get('/export/zip', async (c) => {
    const t = tenantOf(c);
    const { from, to } = period(c);
    const rows = await invoicesIn(t, from, to);
    const files: { name: string; data: Buffer | string }[] = [{ name: `Rechnungsausgangsbuch_${from}_${to}.csv`, data: journalCsv(rows) }];
    for (const r of rows) {
      const blobs = await all<{ pdf: Buffer | null; xml: string | null }>('SELECT pdf, xml FROM documents WHERE id = ?', r.id);
      const d = JSON.parse(r.snapshot) as DocumentData;
      const base = safeName(`${d.number}_${INVOICE_TYPES[d.typeCode] ?? 'Rechnung'}`);
      if (blobs[0]?.pdf) files.push({ name: `${base}.pdf`, data: Buffer.from(blobs[0].pdf) });
      if (blobs[0]?.xml) files.push({ name: `${base}_XRechnung.xml`, data: blobs[0].xml });
    }
    await audit(c, 'export.zip', `${from} – ${to}, ${rows.length} Rechnungen`);
    return c.body(new Uint8Array(createZip(files)), 200, {
      'Content-Type': 'application/zip',
      'Content-Disposition': attachment(`Belege_${safeName(t.name)}_${from}_${to}.zip`),
      'Cache-Control': 'private, no-store',
    });
  });
}

export const exportModule: Module = {
  name: 'export',
  nav: { label: 'Export', href: '/export', order: 40 },
  register,
};
