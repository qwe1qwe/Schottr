import { sphereLabel } from '../../lib/nonprofit.ts';
import { accountsOf, bookLinked, cashbookEnabled, getAccount, linkedEntry, unlink } from '../cashbook/repo.ts';
import { accountSelect } from '../cashbook/routes.ts';
import { all, one, tx } from '../../db/index.ts';
import { audit } from '../../lib/audit.ts';
import { formatDate, isIsoDate, monthEnd, monthLabel, today } from '../../lib/dates.ts';
import { readStoredFile } from '../../lib/files.ts';
import { categoryLabel } from '../../lib/expenses.ts';
import { html, type SafeHtml } from '../../lib/html.ts';
import { attachment, idParam, notFound, readForm, redirectWith, str, tenantOf, userOf, UserError, type Form } from '../../lib/http.ts';
import { formatIban } from '../../lib/validate.ts';
import { formatAmount, formatMoney, parseDecimal } from '../../lib/money.ts';
import { csrfField, empty, page } from '../../views/layout.ts';
import { EInvoiceError, readEInvoice } from '../../einvoice/parse.ts';
import { contactLabel, getContact, supplierOptions } from '../contacts.ts';
import {
  createFromEInvoice, createFromUpload, deletePurchase, detectFile, emptyInput, findBySha, getPurchase, getTaxes, MAX_FILE_SIZE,
  parsePurchaseForm, payable, purchaseToInput, savePurchase, setPaid, sha256, SIGNED, type EInvoiceInfo, type Purchase,
} from './repo.ts';
import {
  einvoiceDetails, previewFrame, purchaseBadge, purchaseForm, purchaseStatus, purchaseTable, purchaseTitle, taxSummary, uploadCard,
} from './views.ts';
import type { App, Ctx, Module, Tenant } from '../../types.ts';

const FILTERS = [
  { value: '', label: 'Alle' },
  { value: 'draft', label: 'Zu erfassen' },
  { value: 'open', label: 'Offen' },
  { value: 'overdue', label: 'Überfällig' },
  { value: 'paid', label: 'Bezahlt' },
];

/** Mit Kassenbuch: bei „Bezahlt am“ muss ein Konto gewählt sein */
async function requiredAccount(t: Tenant, paidAt: string | null, form: Form): Promise<number> {
  if (!paidAt || !cashbookEnabled(t)) return 0;
  const accounts = await accountsOf(t.id);
  if (!accounts.length) return 0;
  const id = Number(str(form, 'paid_account_id')) || 0;
  if (!accounts.some((a) => a.id === id)) throw new UserError('Bitte das Konto wählen, von dem die Rechnung bezahlt wurde.');
  return id;
}

/** Zahlung im Kassenbuch buchen; ein bereits gebuchter (z. B. um Skonto geminderter) Betrag bleibt erhalten */
async function syncPayment(t: Tenant, id: number, paidAt: string | null, accountId: number, userId: number) {
  if (!paidAt || !accountId) return;
  const p = (await getPurchase(t.id, id))!;
  const existing = await linkedEntry('purchase', id);
  const amount = existing?.amount ?? (p.is_credit ? 1 : -1) * payable(p);
  await bookLinked(t, 'purchase', id, { account_id: accountId, entry_date: paidAt, amount, text: existing?.text ?? '' }, userId);
}

function postButton(c: Ctx, action: string, label: string, cls = 'btn', confirm?: string): SafeHtml {
  return html`<form method="post" action="${action}" class="inline" ${confirm ? html`data-confirm="${confirm}"` : ''}>${csrfField(c)}<button class="${cls}">${label}</button></form>`;
}

/** Hochgeladene Dateien aus dem Formular (ein oder mehrere Felder "files[]") */
async function uploadedFiles(c: Ctx): Promise<File[]> {
  const body = await c.req.parseBody({ all: true });
  const raw = body['files[]'] ?? body.files ?? body.file;
  return (Array.isArray(raw) ? raw : [raw]).filter((f): f is File => f instanceof File && f.size > 0);
}

export type ImportResult = { id?: number; name: string; kind: 'einvoice' | 'draft' | 'skipped'; message?: string; supplierCreated?: boolean };

/**
 * Eine Datei als Eingangsrechnung übernehmen: E-Rechnungen (XRechnung/ZUGFeRD) vollständig,
 * PDFs und Fotos als Entwurf zum Erfassen. Fehler (zu groß, falsches Format, doppelt) kommen
 * als „skipped“ mit Begründung zurück. Auch vom Belegeingang genutzt.
 */
export async function importPurchaseFile(c: Ctx, t: Tenant, userId: number, file: { name: string; data: Uint8Array }): Promise<ImportResult> {
  const name = file.name || 'beleg';
  if (file.data.length > MAX_FILE_SIZE) return { name, kind: 'skipped', message: 'größer als 10 MB' };
  const data = Buffer.from(file.data);
  const kind = detectFile(data);
  if (!kind) return { name, kind: 'skipped', message: 'nur PDF, XML, JPG oder PNG' };
  const dup = await findBySha(t.id, sha256(data));
  if (dup) return { id: dup.id, name, kind: 'skipped', message: 'bereits hochgeladen' };
  try {
    const inv = kind === 'pdf' || kind === 'xml' ? await readEInvoice(data) : null;
    if (inv) {
      const r = await createFromEInvoice(t, userId, { name, data, kind }, inv);
      await audit(c, 'purchase.import', `${inv.formatLabel} ${inv.number} (${inv.seller.name})`);
      return { id: r.id, name, kind: 'einvoice', supplierCreated: r.supplierCreated };
    }
    if (kind === 'xml') return { name, kind: 'skipped', message: 'XML ist keine E-Rechnung' };
    return { id: await createFromUpload(t, userId, { name, data, kind }), name, kind: 'draft' };
  } catch (err) {
    if (err instanceof EInvoiceError || err instanceof UserError) return { name, kind: 'skipped', message: err.message };
    throw err;
  }
}

/** Weiterleitung nach dem Übernehmen einer einzelnen Datei */
export function importRedirect(c: Ctx, r: ImportResult, fallback = '/purchases') {
  if (r.kind === 'einvoice') return redirectWith(c, `/purchases/${r.id}`, 'ok', `E-Rechnung übernommen${r.supplierCreated ? ' – der Lieferant wurde neu angelegt' : ''}. Bitte noch die Kostenart prüfen.`);
  if (r.kind === 'draft') return redirectWith(c, `/purchases/${r.id}/edit`, 'ok', 'Beleg hochgeladen. Bitte jetzt die Angaben erfassen.');
  if (r.id) return redirectWith(c, `/purchases/${r.id}`, 'error', `${r.name}: ${r.message}.`);
  return redirectWith(c, fallback, 'error', `${r.name}: ${r.message}.`);
}

function register(app: App) {
  app.get('/purchases', async (c) => {
    const t = tenantOf(c);
    const status = c.req.query('status') ?? '';
    const q = (c.req.query('q') ?? '').trim().slice(0, 100);
    const monthParam = c.req.query('month') ?? '';
    const month = monthLabel(monthParam) ? monthParam : '';
    let where = 'p.tenant_id = ?';
    const params: (string | number)[] = [t.id];
    if (status === 'overdue') {
      where += " AND p.status = 'open' AND COALESCE(p.due_date, p.issue_date) < ?";
      params.push(today());
    } else if (['draft', 'open', 'paid'].includes(status)) {
      where += ' AND p.status = ?';
      params.push(status);
    }
    if (month) {
      where += " AND p.status <> 'draft' AND p.issue_date >= ? AND p.issue_date <= ?";
      params.push(`${month}-01`, monthEnd(month));
    }
    if (q) {
      where += ' AND (p.number LIKE ? OR p.description LIKE ? OR p.file_name LIKE ? OR c.company LIKE ? OR c.name LIKE ?)';
      params.push(...Array(5).fill(`%${q}%`));
    }
    const rows = await all(
      `SELECT p.*, COALESCE(NULLIF(c.company, ''), c.name) AS contact_label
       FROM purchase_invoices p LEFT JOIN contacts c ON c.id = p.contact_id
       WHERE ${where} ORDER BY (p.status = 'draft') DESC, p.issue_date DESC, p.id DESC LIMIT 500`,
      ...params,
    );
    const drafts = (await one<{ n: number }>("SELECT COUNT(*) n FROM purchase_invoices WHERE tenant_id = ? AND status = 'draft'", t.id))?.n ?? 0;
    const counted = rows.filter((r) => r.status !== 'draft');
    const sum = counted.reduce((s, p) => s + (p.is_credit ? -p.gross_total : p.gross_total), 0);
    const netSum = counted.reduce((s, p) => s + (p.is_credit ? -p.net_total : p.net_total), 0);
    const link = (st: string) => {
      const qs = new URLSearchParams();
      if (st) qs.set('status', st);
      if (month) qs.set('month', month);
      return `/purchases${qs.size ? `?${qs}` : ''}`;
    };
    return page(c, {
      title: 'Eingangsrechnungen',
      body: html`
      ${uploadCard(c)}
      ${drafts && status !== 'draft' ? html`<div class="notice soft"><a href="/purchases?status=draft">${drafts} Beleg(e)</a> warten noch auf die Erfassung.</div>` : ''}
      <form class="toolbar" method="get">
        <div class="tabs">${FILTERS.map((f) => html`<a href="${link(f.value)}" class="${status === f.value ? 'active' : ''}">${f.label}</a>`)}</div>
        ${status ? html`<input type="hidden" name="status" value="${status}">` : ''}
        ${month ? html`<input type="hidden" name="month" value="${month}">
          <a class="filter-chip" href="/purchases${status ? `?status=${status}` : ''}" title="Monatsfilter entfernen">${monthLabel(month)} <span aria-hidden="true">×</span><span class="sr-only">Filter entfernen</span></a>` : ''}
        <input type="search" name="q" value="${q}" placeholder="Suchen …" aria-label="Suchen">
      </form>
      ${rows.length
        ? html`${purchaseTable(rows)}<p class="muted small right">${rows.length} Beleg(e)${counted.length ? ` · netto ${formatMoney(netSum)} · brutto ${formatMoney(sum)}` : ''}</p>`
        : empty(status || q || month ? 'Keine Eingangsrechnungen gefunden.' : 'Noch keine Eingangsrechnungen – lade oben deinen ersten Beleg hoch.')}`,
    });
  });

  /* ---------- Hochladen ---------- */

  app.post('/purchases/upload', async (c) => {
    const t = tenantOf(c);
    const user = userOf(c);
    const files = await uploadedFiles(c);
    if (!files.length) return redirectWith(c, '/purchases', 'error', 'Bitte mindestens eine Datei auswählen.');
    if (files.length > 20) return redirectWith(c, '/purchases', 'error', 'Bitte höchstens 20 Dateien auf einmal hochladen.');
    const results: ImportResult[] = [];
    for (const f of files) {
      if (f.size > MAX_FILE_SIZE) {
        results.push({ name: f.name || 'beleg', kind: 'skipped', message: 'größer als 10 MB' });
        continue;
      }
      results.push(await importPurchaseFile(c, t, user.id, { name: f.name, data: new Uint8Array(await f.arrayBuffer()) }));
    }

    const done = results.filter((r) => r.kind !== 'skipped');
    const skipped = results.filter((r) => r.kind === 'skipped');
    const skippedText = skipped.length ? ` Nicht übernommen: ${skipped.map((s) => `${s.name} (${s.message})`).join('; ')}.` : '';
    if (done.length === 1 && !skipped.length) return importRedirect(c, done[0]);
    if (!done.length) return redirectWith(c, '/purchases', 'error', `Keine Datei übernommen.${skippedText}`);
    const e = done.filter((r) => r.kind === 'einvoice').length;
    const d = done.length - e;
    return redirectWith(c, d ? '/purchases?status=draft' : '/purchases', skipped.length ? 'error' : 'ok',
      `${done.length} Beleg(e) hochgeladen: ${e} E-Rechnung(en) übernommen, ${d} zum Erfassen.${skippedText}`);
  });

  /* ---------- Manuell erfassen ---------- */

  app.get('/purchases/new', async (c) => {
    const t = tenantOf(c);
    const contact = c.req.query('contact') ? await getContact(t.id, Number(c.req.query('contact'))) : undefined;
    return page(c, {
      title: 'Eingangsrechnung erfassen',
      back: { href: '/purchases', label: 'Eingangsrechnungen' },
      body: purchaseForm(c, '/purchases', emptyInput(contact), await supplierOptions(t.id, contact?.id), {
        smallBusiness: !!t.small_business, defaultSphere: t.nonprofit ? t.default_sphere : null,
        accounts: cashbookEnabled(t) ? await accountsOf(t.id) : [],
      }),
    });
  });

  app.post('/purchases', async (c) => {
    const t = tenantOf(c);
    try {
      const form = await readForm(c);
      const input = parsePurchaseForm(form, false);
      const accountId = await requiredAccount(t, input.paid_at, form);
      const id = await tx(async () => {
        const newId = await savePurchase(t, userOf(c).id, null, input);
        await syncPayment(t, newId, input.paid_at, accountId, userOf(c).id);
        return newId;
      });
      return redirectWith(c, `/purchases/${id}`, 'ok', 'Eingangsrechnung gespeichert.');
    } catch (err) {
      if (err instanceof UserError) return redirectWith(c, '/purchases/new', 'error', err.message);
      throw err;
    }
  });

  /* ---------- Anzeigen, bearbeiten ---------- */

  app.get('/purchases/:id', async (c) => {
    const t = tenantOf(c);
    const p = (await getPurchase(t.id, idParam(c))) ?? notFound();
    if (p.status === 'draft') return c.redirect(`/purchases/${p.id}/edit`);
    const contact = p.contact_id ? await getContact(t.id, p.contact_id) : undefined;
    const taxes = await getTaxes(p.id);
    const info = p.einvoice_data ? (JSON.parse(p.einvoice_data) as EInvoiceInfo) : null;
    const st = purchaseStatus(p);
    const meta: [string, SafeHtml | string][] = [
      ['Lieferant', contact ? html`<a href="/contacts/${contact.id}">${contactLabel(contact)}</a>` : '–'],
      ['Rechnungsnummer', p.number || '–'],
      ['Rechnungsdatum', formatDate(p.issue_date)],
    ];
    if (info?.periodFrom && info.periodTo) meta.push(['Leistungszeitraum', `${formatDate(info.periodFrom)} – ${formatDate(info.periodTo)}`]);
    else if (p.service_date) meta.push(['Leistungsdatum', formatDate(p.service_date)]);
    meta.push(['Fällig am', p.due_date ? formatDate(p.due_date) : 'sofort']);
    if (p.paid_at) meta.push(['Bezahlt am', formatDate(p.paid_at)]);
    meta.push(['Kostenart', categoryLabel(p.category)]);
    if (t.nonprofit) meta.push(['Bereich', sphereLabel(p.sphere || t.default_sphere)]);
    const payment = await linkedEntry('purchase', p.id);
    const cashAccounts = cashbookEnabled(t) ? await accountsOf(t.id) : [];
    if (payment) meta.push(['Zahlung', html`${formatMoney(-payment.amount)} von <a href="/cashbook?account=${payment.account_id}">${(await getAccount(t.id, payment.account_id))?.name ?? 'Konto'}</a>`]);
    if (p.description) meta.push(['Beschreibung', p.description]);
    if (p.iban) meta.push(['Bankverbindung', `${formatIban(p.iban)}${info?.bic ? ` · ${info.bic}` : ''}`]);
    if (p.payment_reference && p.status === 'open') meta.push(['Verwendungszweck', p.payment_reference]);
    if (info?.orderReference) meta.push(['Bestellnummer', info.orderReference]);
    if (info?.buyerReference) meta.push(['Käuferreferenz', info.buyerReference]);
    meta.push(['Format', p.einvoice_format || (p.file_path ? `Beleg (${p.file_mime === 'application/pdf' ? 'PDF' : 'Bild'})` : 'ohne Beleg')]);

    const title = `${p.is_credit ? 'Gutschrift' : 'Eingangsrechnung'} ${p.number || ''}`.trim();
    return page(c, {
      title,
      back: { href: '/purchases', label: 'Eingangsrechnungen' },
      actions: html`
        ${p.file_path ? html`<a class="btn" href="/purchases/${p.id}/file">Datei herunterladen</a>` : ''}
        <a class="btn" href="/purchases/${p.id}/edit">Bearbeiten</a>
        ${p.status === 'paid'
          ? postButton(c, `/purchases/${p.id}/open`, 'Als offen markieren', 'btn ghost', payment ? 'Wieder als offen markieren? Die Buchung im Kassenbuch wird entfernt.' : undefined)
          : html`<form method="post" action="/purchases/${p.id}/paid" class="inline paid-form">${csrfField(c)}
              <input type="date" name="paid_at" value="${today()}" aria-label="Bezahlt am" required>
              ${cashAccounts.length ? html`${accountSelect(cashAccounts, cashAccounts.find((a) => a.kind === 'bank')?.id)}
                <input name="amount" class="num amount-input" inputmode="decimal" aria-label="Betrag" value="${formatAmount(payable(p)).replace(/\./g, '')}">` : ''}
              <button class="btn primary">${cashAccounts.length ? 'Als bezahlt buchen' : 'Als bezahlt markieren'}</button></form>`}`,
      body: html`
      <div class="status-line">${purchaseBadge(st)}${p.is_credit ? html` <span class="tag">Gutschrift</span>` : ''}
        ${p.status === 'open' ? html`<span class="subject">zu zahlen: ${formatMoney(payable(p))}</span>` : ''}</div>
      <div class="purchase-layout${p.file_path && p.file_mime !== 'application/xml' ? '' : ' no-preview'}">
        <div>
          <section class="card"><dl class="dl cols">${meta.map(([l, v]) => html`<dt>${l}</dt><dd>${v}</dd>`)}</dl></section>
          ${taxSummary(taxes, p)}
          ${info ? einvoiceDetails(info) : ''}
        </div>
        ${p.file_path && p.file_mime !== 'application/xml' ? html`<aside>${previewFrame(p)}</aside>` : ''}
      </div>
      <div class="danger-zone">
        ${postButton(c, `/purchases/${p.id}/delete`, 'Löschen', 'btn danger', 'Eingangsrechnung samt Datei endgültig löschen? Belege sind aufbewahrungspflichtig – nur löschen, wenn sie versehentlich erfasst wurde.')}
      </div>`,
    });
  });

  app.get('/purchases/:id/edit', async (c) => {
    const t = tenantOf(c);
    const p = (await getPurchase(t.id, idParam(c))) ?? notFound();
    const taxes = await getTaxes(p.id);
    const locked = p.einvoice_format ? p : undefined;
    const draft = p.status === 'draft';
    return page(c, {
      title: draft ? 'Beleg erfassen' : 'Eingangsrechnung bearbeiten',
      back: draft ? { href: '/purchases', label: 'Eingangsrechnungen' } : { href: `/purchases/${p.id}`, label: purchaseTitle(p) },
      body: html`
      ${purchaseForm(c, `/purchases/${p.id}`, purchaseToInput(p, taxes), await supplierOptions(t.id, p.contact_id), {
        locked, taxes, preview: p.file_path && p.file_mime !== 'application/xml' ? previewFrame(p) : undefined, smallBusiness: !!t.small_business,
        defaultSphere: t.nonprofit ? t.default_sphere : null,
        accounts: cashbookEnabled(t) ? await accountsOf(t.id) : [], paidAccountId: (await linkedEntry('purchase', p.id))?.account_id ?? null,
      })}
      ${draft
        ? html`<div class="danger-zone">${postButton(c, `/purchases/${p.id}/delete`, 'Beleg verwerfen', 'btn danger', 'Hochgeladenen Beleg verwerfen?')}</div>`
        : ''}`,
    });
  });

  app.post('/purchases/:id', async (c) => {
    const t = tenantOf(c);
    const p = (await getPurchase(t.id, idParam(c))) ?? notFound();
    try {
      const form = await readForm(c);
      const input = parsePurchaseForm(form, !!p.einvoice_format);
      const accountId = await requiredAccount(t, input.paid_at, form);
      // Kassenbuch: Zahlung entfernen, buchen bzw. Datum/Konto nachziehen
      if (!input.paid_at) await unlink(t, 'purchase', p.id);
      await tx(async () => {
        await savePurchase(t, userOf(c).id, p, input);
        await syncPayment(t, p.id, input.paid_at, accountId, userOf(c).id);
      });
      if (p.status !== 'draft') await audit(c, 'purchase.update', `${purchaseTitle(p)} (ID ${p.id})`);
      return redirectWith(c, `/purchases/${p.id}`, 'ok', 'Eingangsrechnung gespeichert.');
    } catch (err) {
      if (err instanceof UserError) return redirectWith(c, `/purchases/${p.id}/edit`, 'error', err.message);
      throw err;
    }
  });

  app.post('/purchases/:id/paid', async (c) => {
    const t = tenantOf(c);
    const p = (await getPurchase(t.id, idParam(c))) ?? notFound();
    if (p.status === 'draft') return redirectWith(c, `/purchases/${p.id}/edit`, 'error', 'Bitte zuerst die Angaben erfassen.');
    const form = await readForm(c);
    const date = str(form, 'paid_at') || today();
    if (!isIsoDate(date)) return redirectWith(c, `/purchases/${p.id}`, 'error', 'Ungültiges Datum.');
    const accountId = Number(str(form, 'account_id')) || 0;
    await tx(async () => {
      await setPaid(p, date);
      if (accountId) {
        const amount = parseDecimal(str(form, 'amount'), 2);
        if (amount === null || amount <= 0) throw new UserError('Bitte den gezahlten Betrag angeben.');
        await bookLinked(t, 'purchase', p.id, { account_id: accountId, entry_date: date, amount: p.is_credit ? amount : -amount, text: '' }, userOf(c).id);
      }
    });
    return redirectWith(c, `/purchases/${p.id}`, 'ok', accountId ? 'Als bezahlt gebucht.' : 'Als bezahlt markiert.');
  });

  app.post('/purchases/:id/open', async (c) => {
    const t = tenantOf(c);
    const p = (await getPurchase(t.id, idParam(c))) ?? notFound();
    await unlink(t, 'purchase', p.id);
    await setPaid(p, null);
    return redirectWith(c, `/purchases/${p.id}`, 'ok', 'Wieder als offen markiert.');
  });

  app.post('/purchases/:id/delete', async (c) => {
    const t = tenantOf(c);
    const p = (await getPurchase(t.id, idParam(c))) ?? notFound();
    await unlink(t, 'purchase', p.id);
    await deletePurchase(p);
    await audit(c, 'purchase.delete', `${purchaseTitle(p)} (${p.file_name || 'ohne Datei'}, ${formatMoney(p.gross_total)})`);
    return redirectWith(c, '/purchases', 'ok', p.status === 'draft' ? 'Beleg verworfen.' : 'Eingangsrechnung gelöscht.');
  });

  /** Datei – ?inline=1 zur Vorschau (nur PDF und Bilder, XML immer als Download) */
  app.get('/purchases/:id/file', async (c) => {
    const t = tenantOf(c);
    const p = (await getPurchase(t.id, idParam(c))) ?? notFound();
    if (!p.file_path) notFound();
    const inline = c.req.query('inline') === '1' && p.file_mime !== 'application/xml';
    return c.body(new Uint8Array(await readStoredFile('verbindlichkeiten', p.file_path)), 200, {
      'Content-Type': p.file_mime || 'application/octet-stream',
      'Content-Disposition': attachment(p.file_name || `beleg-${p.id}`, inline),
      'Cache-Control': 'private, no-store',
      'X-Content-Type-Options': 'nosniff',
    });
  });
}

/** Summe offener Verbindlichkeiten (für die Übersicht) */
export async function openLiabilities(tenantId: number) {
  const r = await one<{ n: number; s: number | string; overdue_n: number; overdue_s: number | string }>(
    `SELECT COUNT(*) n, COALESCE(SUM(${SIGNED('gross_total')} - ${SIGNED('prepaid_total')}), 0) s,
       COALESCE(SUM(COALESCE(p.due_date, p.issue_date) < ?), 0) overdue_n,
       COALESCE(SUM(CASE WHEN COALESCE(p.due_date, p.issue_date) < ? THEN ${SIGNED('gross_total')} - ${SIGNED('prepaid_total')} ELSE 0 END), 0) overdue_s
     FROM purchase_invoices p WHERE p.tenant_id = ? AND p.status = 'open'`,
    today(), today(), tenantId,
  );
  return { n: Number(r?.n ?? 0), s: Number(r?.s ?? 0), overdueN: Number(r?.overdue_n ?? 0), overdueS: Number(r?.overdue_s ?? 0) };
}

export const purchasesModule: Module = {
  name: 'purchases',
  nav: { label: 'Eingangsrechnungen', href: '/purchases', order: 31 },
  register,
};

export type { Purchase };
