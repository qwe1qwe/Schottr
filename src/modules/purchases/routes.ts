import { sphereLabel } from '../../lib/nonprofit.ts';
import { accountsOf, bookLinked, cashbookEnabled, entryCandidates, entryForPurchase, getAccount, linkEntryToPurchase, linkedEntry, shareEntryFileWithPurchase, unlink } from '../cashbook/repo.ts';
import { accountSelect, fileUploader } from '../cashbook/routes.ts';
import { filesFrom, MAX_ENTRY_FILE, mimeOf } from '../cashbook/files.ts';
import { assignToPurchase, inboxOf, openInbox, type InboxFile } from '../inbox/repo.ts';
import { cropControls } from '../../views/crop.ts';
import { attachPurchaseData, getPurchaseFile, purchaseFilesOf, setPurchaseFileArchived, viewPurchaseFile, type PurchaseFile } from './files.ts';
import { all, one, run, tx, nowIso } from '../../db/index.ts';
import { saveFile } from '../../lib/files.ts';
import { audit } from '../../lib/audit.ts';
import { formatDate, isIsoDate, monthEnd, monthLabel, paidPeriod, today } from '../../lib/dates.ts';
import { handleCrop, viewOf } from '../../lib/crop.ts';
import { categoryLabel, isExpenseCategory } from '../../lib/expenses.ts';
import { html, type SafeHtml } from '../../lib/html.ts';
import { attachment, idParam, notFound, readForm, redirectWith, str, tenantOf, userOf, UserError, type Form } from '../../lib/http.ts';
import { formatIban } from '../../lib/validate.ts';
import { formatAmount, formatMoney, parseDecimal } from '../../lib/money.ts';
import { csrfField, empty, page } from '../../views/layout.ts';
import { EInvoiceError, readEInvoice } from '../../einvoice/parse.ts';
import { contactLabel, getContact, supplierOptions } from '../contacts.ts';
import {
  archivePurchase, assertNotArchived, createFromEInvoice, createFromUpload, detectFile, emptyInput, findBySha, getPurchase, getTaxes, MAX_FILE_SIZE,
  adoptInternalRef, lastBySupplier, lastInternalRef, sameNumber, parsePurchaseForm, payable, purchaseToInput, restorePurchase, savePurchase, setPaid, sha256, SIGNED, taxRow, type EInvoiceInfo, type Purchase,
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
  { value: 'archived', label: 'Archiviert' },
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
  // interne Belegnummer der Rechnung auch an der Zahlung im Kassenbuch zeigen
  await bookLinked(t, 'purchase', id, { account_id: accountId, entry_date: paidAt, amount, text: existing?.text ?? '', receipt_ref: p.internal_ref || existing?.receipt_ref || '' }, userId);
}

function postButton(c: Ctx, action: string, label: string, cls = 'btn', confirm?: string): SafeHtml {
  return html`<form method="post" action="${action}" class="inline" ${confirm ? html`data-confirm="${confirm}"` : ''}>${csrfField(c)}<button class="${cls}">${label}</button></form>`;
}

/** Weitere Belege (zweite Seite, Lieferschein …): Liste, Zuschneiden, Archivieren, Hochladen */
function extraFiles(c: Ctx, p: Purchase, files: PurchaseFile[], inbox: InboxFile[]): SafeHtml {
  const archived = p.status === 'archived';
  const item = (f: PurchaseFile) => html`<li class="${f.archived_at ? 'archived' : ''}">
    <a href="/purchases/files/${f.id}?inline=1" target="_blank" rel="noopener" class="entry-file">
      ${f.file_mime.startsWith('image/') ? html`<img src="/purchases/files/${f.id}?inline=1${f.cropped_at ? `&v=${encodeURIComponent(f.cropped_at)}` : ''}" alt="Beleg ${f.file_name}" loading="lazy">` : html`<span class="pdf-badge">PDF</span>`}
      <span>${f.file_name}<span class="muted small"> · ${Math.max(1, Math.round(f.file_size / 1024))} KB${f.crop_path ? ' · zugeschnitten' : ''}${f.archived_at ? ' · archiviert' : ''}</span></span>
    </a>
    ${archived ? '' : html`<span class="entry-file-actions">
      ${f.archived_at ? '' : cropControls(c, f, `/purchases/files/${f.id}/crop`, `/purchases/files/${f.id}`, { small: true })}
      ${postButton(c, `/purchases/files/${f.id}/archive`, f.archived_at ? 'Wiederherstellen' : 'Archivieren', f.archived_at ? 'link' : 'link danger',
        f.archived_at ? undefined : `Beleg „${f.file_name}“ archivieren? Er bleibt unverändert aufbewahrt, wird aber nicht mehr angezeigt und nicht exportiert.`)}
    </span>`}
  </li>`;
  const active = files.filter((f) => !f.archived_at);
  const old = files.filter((f) => f.archived_at);
  if (archived && !active.length) return html``;
  return html`<section class="card">
    <h2>${p.file_path ? 'Weitere Belege' : 'Belege'} <span class="count">${active.length}</span></h2>
    ${active.length ? html`<ul class="plain entry-file-list">${active.map(item)}</ul>` : html`<p class="muted small">${p.file_path ? 'z. B. zweite Seite, Lieferschein oder Zahlungsbeleg.' : 'Noch kein Beleg – der erste wird zur Rechnungsdatei.'}</p>`}
    ${old.length ? html`<details class="archived-files"><summary class="muted small">${old.length} archivierte(r) Beleg(e) anzeigen</summary>
      <ul class="plain entry-file-list">${old.map(item)}</ul></details>` : ''}
    ${archived ? '' : html`<form method="post" action="/purchases/${p.id}/files" enctype="multipart/form-data" class="stack">
      ${csrfField(c)}${fileUploader(p.file_path ? 'Beleg anhängen (PDF oder Foto)' : 'Rechnungsdatei hochladen (PDF oder Foto)', inbox)}
      <div><button class="btn">Hochladen</button></div></form>`}
  </section>`;
}

/** Archivieren (statt Löschen) mit optionalem Grund */
function archiveForm(c: Ctx, p: Purchase): SafeHtml {
  return html`<div class="danger-zone">
    <form method="post" action="/purchases/${p.id}/archive" class="inline-form"
      data-confirm="${p.status === 'draft' ? 'Beleg archivieren?' : 'Eingangsrechnung archivieren?'} Sie bleibt unverändert aufbewahrt, zählt aber in keiner Auswertung mehr – wiederherstellen ist jederzeit möglich.">
      ${csrfField(c)}
      <input name="reason" maxlength="300" placeholder="Grund (optional), z. B. versehentlich doppelt erfasst" aria-label="Grund">
      <button class="btn danger">Archivieren</button>
    </form>
    <p class="muted small">Belege sind aufbewahrungspflichtig und lassen sich nicht löschen.</p>
  </div>`;
}

/** Hochgeladene Dateien aus dem Formular (ein oder mehrere Felder "files[]") */
async function uploadedFiles(c: Ctx): Promise<File[]> {
  const body = await c.req.parseBody({ all: true });
  const raw = body['files[]'] ?? body.files ?? body.file;
  return (Array.isArray(raw) ? raw : [raw]).filter((f): f is File => f instanceof File && f.size > 0);
}

export type ImportResult = { id?: number; name: string; kind: 'einvoice' | 'draft' | 'skipped'; message?: string; supplierCreated?: boolean; refTaken?: string; numberHint?: string };

/** Interne Belegnummer (z. B. beim Erfassen oder aus dem Belegeingang) an die neue Eingangsrechnung geben */
export async function applyInternalRef(t: Tenant, r: ImportResult, ref: string): Promise<ImportResult> {
  if (!ref || r.kind === 'skipped' || !r.id) return r;
  if (!await adoptInternalRef(t.id, r.id, ref)) r.refTaken = ref;
  return r;
}

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
      return { id: r.id, name, kind: 'einvoice', supplierCreated: r.supplierCreated, numberHint: await numberHint(t, r.id) };
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
  const taken = (r.refTaken ? ` Die interne Belegnummer ${r.refTaken} ist schon vergeben und wurde nicht übernommen.` : '') + (r.numberHint ?? '');
  if (r.kind === 'einvoice') return redirectWith(c, `/purchases/${r.id}`, taken ? 'error' : 'ok', `E-Rechnung übernommen${r.supplierCreated ? ' – der Lieferant wurde neu angelegt' : ''}. Bitte noch die Kostenart prüfen.${taken}`);
  if (r.kind === 'draft') return redirectWith(c, `/purchases/${r.id}/edit`, taken ? 'error' : 'ok', `Beleg hochgeladen. Bitte jetzt die Angaben erfassen.${taken}`);
  if (r.id) return redirectWith(c, `/purchases/${r.id}`, 'error', `${r.name}: ${r.message}.`);
  return redirectWith(c, fallback, 'error', `${r.name}: ${r.message}.`);
}

/** Hinweis nach dem Speichern, wenn dieselbe Rechnungsnummer bei einem anderen Lieferanten vorkommt */
async function numberHint(t: Tenant, id: number): Promise<string> {
  const p = await getPurchase(t.id, id);
  if (!p?.number) return '';
  const other = (await sameNumber(t.id, p.number, p.contact_id, p.id)).filter((m) => !m.same_supplier);
  if (!other.length) return '';
  return ` Hinweis: Die Rechnungsnummer ${p.number} gibt es auch bei ${other.map((m) => m.supplier || 'einer Rechnung ohne Lieferant').join(', ')} – bitte prüfen, ob es kein Doppel ist.`;
}

function register(app: App) {
  /** Prüfung beim Eintippen: gibt es die Rechnungsnummer schon? (vor /purchases/:id registriert) */
  app.get('/purchases/number-check', async (c) => {
    const t = tenantOf(c);
    const matches = await sameNumber(t.id, (c.req.query('number') ?? '').slice(0, 100), Number(c.req.query('contact') ?? 0) || null, Number(c.req.query('id') ?? 0) || 0);
    return c.json({ matches: matches.map((m) => ({ id: m.id, supplier: m.supplier ?? '', date: m.issue_date ? formatDate(m.issue_date) : '', sameSupplier: !!m.same_supplier })) });
  });

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
    } else if (['draft', 'open', 'paid', 'archived'].includes(status)) {
      where += ' AND p.status = ?';
      params.push(status);
    } else {
      where += " AND p.status <> 'archived'";
    }
    if (month) {
      where += " AND p.status NOT IN ('draft', 'archived') AND p.issue_date >= ? AND p.issue_date <= ?";
      params.push(`${month}-01`, monthEnd(month));
    }
    // Zahlungszeitraum (aus der Übersicht): in Jahr/Monat bezahlte Eingangsrechnungen
    const paidParam = c.req.query('paid') ?? '';
    const paid = paidPeriod(paidParam) ? paidParam : '';
    if (paid) {
      const pp = paidPeriod(paid)!;
      where += " AND p.status = 'paid' AND p.paid_at >= ? AND p.paid_at <= ?";
      params.push(pp.from, pp.to);
    }
    if (q) {
      where += ' AND (p.number LIKE ? OR p.internal_ref LIKE ? OR p.description LIKE ? OR p.file_name LIKE ? OR c.company LIKE ? OR c.name LIKE ?)';
      params.push(...Array(6).fill(`%${q}%`));
    }
    const rows = await all(
      `SELECT p.*, COALESCE(NULLIF(c.company, ''), c.name) AS contact_label,
              (SELECT COUNT(*) FROM purchase_files f WHERE f.purchase_id = p.id AND f.archived_at IS NULL) AS extra_files
       FROM purchase_invoices p LEFT JOIN contacts c ON c.id = p.contact_id
       WHERE ${where} ORDER BY (p.status = 'draft') DESC, p.issue_date DESC, p.id DESC LIMIT 500`,
      ...params,
    );
    const drafts = (await one<{ n: number }>("SELECT COUNT(*) n FROM purchase_invoices WHERE tenant_id = ? AND status = 'draft'", t.id))?.n ?? 0;
    const counted = rows.filter((r) => r.status !== 'draft' && r.status !== 'archived');
    const sum = counted.reduce((s, p) => s + (p.is_credit ? -p.gross_total : p.gross_total), 0);
    const netSum = counted.reduce((s, p) => s + (p.is_credit ? -p.net_total : p.net_total), 0);
    const link = (st: string) => {
      const qs = new URLSearchParams();
      if (st) qs.set('status', st);
      if (month) qs.set('month', month);
      if (paid) qs.set('paid', paid);
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
        ${paid ? html`<input type="hidden" name="paid" value="${paid}">
          <a class="filter-chip" href="/purchases${status ? `?status=${status}` : ''}" title="Filter entfernen">${paidPeriod(paid)!.label} <span aria-hidden="true">×</span><span class="sr-only">Filter entfernen</span></a>` : ''}
        <input type="search" name="q" value="${q}" placeholder="Suchen …" aria-label="Suchen">
      </form>
      ${rows.length
        ? html`${purchaseTable(rows)}<p class="muted small right">${rows.length} Beleg(e)${counted.length ? ` · netto ${formatMoney(netSum)} · brutto ${formatMoney(sum)}` : ''}</p>`
        : empty(status || q || month || paid ? 'Keine Eingangsrechnungen gefunden.' : 'Noch keine Eingangsrechnungen – lade oben deinen ersten Beleg hoch.')}`,
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
    // aus einer freien Buchung anlegen: Datum, Betrag, Text, Kostenart, Bereich, Adresse und Zahlung übernehmen
    const entryId = cashbookEnabled(t) ? Number(c.req.query('entry') ?? 0) : 0;
    const entry = entryId ? await entryForPurchase(t, entryId) : null;
    const contactId = Number(c.req.query('contact') ?? 0) || entry?.contact_id || 0;
    const contact = contactId ? await getContact(t.id, contactId) : undefined;
    const input = emptyInput(contact);
    const last = await lastBySupplier(t.id);
    if (contact && last.get(contact.id)) {
      input.category = last.get(contact.id)!.category;
      input.sphere = last.get(contact.id)!.sphere;
    }
    if (entry) {
      const gross = Math.abs(entry.amount);
      const rate = t.small_business ? 0 : entry.vat_rate;
      Object.assign(input, {
        issue_date: entry.entry_date, paid_at: entry.entry_date, description: entry.text, is_credit: entry.amount > 0,
        internal_ref: entry.receipt_ref.slice(0, 50),
        category: isExpenseCategory(entry.category) ? entry.category : input.category, sphere: entry.sphere,
        taxes: [taxRow(rate, null, null, gross)!],
      });
    }
    return page(c, {
      title: 'Eingangsrechnung erfassen',
      back: entry ? { href: `/cashbook/entries/${entry.id}/edit`, label: 'Buchung' } : { href: '/purchases', label: 'Eingangsrechnungen' },
      body: purchaseForm(c, '/purchases', input, await supplierOptions(t.id, contact?.id), {
        smallBusiness: !!t.small_business, defaultSphere: t.nonprofit ? t.default_sphere : null, lastRef: await lastInternalRef(t.id), lastBySupplier: last,
        accounts: cashbookEnabled(t) ? await accountsOf(t.id) : [], paidAccountId: entry?.account_id ?? null,
        extra: entry ? html`<input type="hidden" name="from_entry" value="${entry.id}">
          <div class="notice soft">Aus der Buchung vom ${formatDate(entry.entry_date)} „${entry.text}“ (${formatMoney(entry.amount)}): Die Buchung wird zur Zahlung
            dieser Rechnung – es entsteht keine zweite Buchung, die Rechnung gilt ab dem Buchungstag als bezahlt.
            Bitte noch Lieferant und Rechnungsnummer ergänzen.
            ${entry.file_count ? html`<label class="check"><input type="checkbox" name="take_file" value="1" checked> Beleg der Buchung auch als Rechnungsdatei verwenden</label>` : ''}</div>` : undefined,
      }),
    });
  });

  app.post('/purchases', async (c) => {
    const t = tenantOf(c);
    let fromEntry = 0;
    try {
      const form = await readForm(c);
      fromEntry = cashbookEnabled(t) ? Number(str(form, 'from_entry')) || 0 : 0;
      const input = parsePurchaseForm(form, false);
      if (fromEntry) {
        // die Buchung ist die Zahlung – kein eigenes Konto nötig, keine zweite Buchung
        const entry = await entryForPurchase(t, fromEntry);
        input.paid_at = entry.entry_date;
        if (input.is_credit !== entry.amount > 0) throw new UserError(entry.amount > 0 ? 'Zu einer Einnahme passt nur eine Gutschrift.' : 'Zu einer Ausgabe passt keine Gutschrift.');
      }
      const accountId = fromEntry ? 0 : await requiredAccount(t, input.paid_at, form);
      const id = await tx(async () => {
        const newId = await savePurchase(t, userOf(c).id, null, input);
        if (fromEntry) {
          await linkEntryToPurchase(t, fromEntry, newId);
          if (str(form, 'take_file')) await shareEntryFileWithPurchase(fromEntry, newId);
        } else {
          await syncPayment(t, newId, input.paid_at, accountId, userOf(c).id);
        }
        return newId;
      });
      if (fromEntry) await audit(c, 'cashbook.entry.link', `Eingangsrechnung (ID ${id}) aus Buchung ID ${fromEntry} angelegt`);
      const hint = await numberHint(t, id);
      return redirectWith(c, `/purchases/${id}`, hint ? 'error' : 'ok', `${fromEntry ? 'Eingangsrechnung angelegt und mit der Buchung verbunden.' : 'Eingangsrechnung gespeichert.'}${hint}`);
    } catch (err) {
      if (err instanceof UserError) return redirectWith(c, fromEntry ? `/purchases/new?entry=${fromEntry}` : '/purchases/new', 'error', err.message);
      throw err;
    }
  });

  /* ---------- Anzeigen, bearbeiten ---------- */

  app.get('/purchases/:id', async (c) => {
    const t = tenantOf(c);
    const p = (await getPurchase(t.id, idParam(c))) ?? notFound();
    if (p.status === 'draft') return c.redirect(`/purchases/${p.id}/edit`);
    const archived = p.status === 'archived';
    const contact = p.contact_id ? await getContact(t.id, p.contact_id) : undefined;
    const taxes = await getTaxes(p.id);
    const info = p.einvoice_data ? (JSON.parse(p.einvoice_data) as EInvoiceInfo) : null;
    const st = purchaseStatus(p);
    const meta: [string, SafeHtml | string][] = [
      ...(p.internal_ref ? [['Interne Belegnr.', html`<span class="mono">${p.internal_ref}</span>`] as [string, SafeHtml]] : []),
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
    // schon frei im Kassenbuch gebucht? → verbinden statt doppelt buchen
    const candidates = cashAccounts.length && !payment && !archived ? await entryCandidates(t, p) : [];
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
        ${archived ? postButton(c, `/purchases/${p.id}/restore`, 'Wiederherstellen', 'btn primary') : html`<a class="btn" href="/purchases/${p.id}/edit">Bearbeiten</a>`}
        ${archived ? '' : p.status === 'paid'
          ? postButton(c, `/purchases/${p.id}/open`, 'Als offen markieren', 'btn ghost', payment ? 'Wieder als offen markieren? Die Zahlung bleibt im Kassenbuch stehen und wird storniert.' : undefined)
          : html`<form method="post" action="/purchases/${p.id}/paid" class="inline paid-form" data-count-check data-count-date="paid_at">${csrfField(c)}
              <input type="date" name="paid_at" value="${today()}" aria-label="Bezahlt am" required>
              ${cashAccounts.length ? html`${accountSelect(cashAccounts, cashAccounts.find((a) => a.kind === 'bank')?.id)}
                <input name="amount" class="num amount-input" inputmode="decimal" aria-label="Betrag" value="${formatAmount(payable(p)).replace(/\./g, '')}">` : ''}
              <button class="btn primary">${cashAccounts.length ? 'Als bezahlt buchen' : 'Als bezahlt markieren'}</button></form>`}`,
      body: html`
      ${archived ? html`<div class="notice soft">Archiviert am ${formatDate(String(p.archived_at).slice(0, 10))}${p.archive_reason ? html` – ${p.archive_reason}` : ''}.
        Der Beleg bleibt unverändert aufbewahrt, zählt aber in keiner Auswertung.</div>` : ''}
      <div class="status-line">${purchaseBadge(st)}${p.is_credit ? html` <span class="tag">Gutschrift</span>` : ''}
        ${p.status === 'open' ? html`<span class="subject">zu zahlen: ${formatMoney(payable(p))}</span>` : ''}</div>
      <div class="purchase-layout${p.file_path && p.file_mime !== 'application/xml' ? '' : ' no-preview'}">
        <div>
          <section class="card"><dl class="dl cols">${meta.map(([l, v]) => html`<dt>${l}</dt><dd>${v}</dd>`)}</dl></section>
          ${taxSummary(taxes, p)}
          ${extraFiles(c, p, await purchaseFilesOf(p.id), archived ? [] : await inboxOf(t.id))}
          ${candidates.length ? html`<section class="card">
            <h2>Schon im Kassenbuch gebucht?</h2>
            <p class="muted small">Wurde die Ausgabe bereits als freie Buchung erfasst (z. B. bar bezahlt, Rechnung kam später), hier verbinden statt nochmals
              „Als bezahlt buchen“ – sonst steht sie doppelt im Kassenbuch. Betrag, Datum und Konto der Buchung bleiben; die Rechnung gilt ab dem Buchungstag als bezahlt.</p>
            <form method="post" action="/purchases/${p.id}/link-entry" class="inline-form"
              data-confirm="Eingangsrechnung mit der gewählten Buchung verbinden?">
              ${csrfField(c)}
              <select name="entry_id" required aria-label="Buchung">
                ${candidates.map((e) => html`<option value="${e.id}">${[formatDate(e.entry_date), e.account, e.text, formatMoney(e.amount),
                  Math.abs(e.amount) === payable(p) ? '✓ Betrag passt' : ''].filter(Boolean).join(' · ')}</option>`)}
              </select>
              <button class="btn">Verbinden</button>
            </form>
          </section>` : ''}
          ${info ? einvoiceDetails(info) : ''}
        </div>
        ${p.file_path && p.file_mime !== 'application/xml' ? html`<aside>${previewFrame(p, c)}</aside>` : ''}
      </div>
      ${archived ? '' : archiveForm(c, p)}`,
    });
  });

  app.get('/purchases/:id/edit', async (c) => {
    const t = tenantOf(c);
    const p = (await getPurchase(t.id, idParam(c))) ?? notFound();
    if (p.status === 'archived') return c.redirect(`/purchases/${p.id}`);
    const taxes = await getTaxes(p.id);
    const locked = p.einvoice_format ? p : undefined;
    const draft = p.status === 'draft';
    return page(c, {
      title: draft ? 'Beleg erfassen' : 'Eingangsrechnung bearbeiten',
      back: draft ? { href: '/purchases', label: 'Eingangsrechnungen' } : { href: `/purchases/${p.id}`, label: purchaseTitle(p) },
      body: html`
      ${purchaseForm(c, `/purchases/${p.id}`, purchaseToInput(p, taxes), await supplierOptions(t.id, p.contact_id), {
        locked, taxes, preview: p.file_path && p.file_mime !== 'application/xml' ? previewFrame(p, c) : undefined, smallBusiness: !!t.small_business,
        defaultSphere: t.nonprofit ? t.default_sphere : null, lastRef: await lastInternalRef(t.id), lastBySupplier: await lastBySupplier(t.id), purchaseId: p.id,
        accounts: cashbookEnabled(t) ? await accountsOf(t.id) : [], paidAccountId: (await linkedEntry('purchase', p.id))?.account_id ?? null,
      })}
      ${draft
        ? archiveForm(c, p)
        : ''}`,
    });
  });

  app.post('/purchases/:id', async (c) => {
    const t = tenantOf(c);
    const p = (await getPurchase(t.id, idParam(c))) ?? notFound();
    assertNotArchived(p);
    try {
      const form = await readForm(c);
      const input = parsePurchaseForm(form, !!p.einvoice_format);
      const accountId = await requiredAccount(t, input.paid_at, form);
      // Kassenbuch: Zahlung entfernen, buchen bzw. Datum/Konto nachziehen
      if (!input.paid_at) await unlink(t, 'purchase', p.id, userOf(c).id);
      await tx(async () => {
        await savePurchase(t, userOf(c).id, p, input);
        await syncPayment(t, p.id, input.paid_at, accountId, userOf(c).id);
      });
      if (p.status !== 'draft') await audit(c, 'purchase.update', `${purchaseTitle(p)} (ID ${p.id})`);
      // Hinweis nur, wenn die Nummer gerade erst eingetragen bzw. geändert wurde
      const hint = input.number && input.number !== p.number && !p.einvoice_format ? await numberHint(t, p.id) : '';
      return redirectWith(c, `/purchases/${p.id}`, hint ? 'error' : 'ok', `Eingangsrechnung gespeichert.${hint}`);
    } catch (err) {
      if (err instanceof UserError) return redirectWith(c, `/purchases/${p.id}/edit`, 'error', err.message);
      throw err;
    }
  });

  app.post('/purchases/:id/paid', async (c) => {
    const t = tenantOf(c);
    const p = (await getPurchase(t.id, idParam(c))) ?? notFound();
    assertNotArchived(p);
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
        await bookLinked(t, 'purchase', p.id, { account_id: accountId, entry_date: date, amount: p.is_credit ? amount : -amount, text: '', receipt_ref: p.internal_ref }, userOf(c).id);
      }
    });
    return redirectWith(c, `/purchases/${p.id}`, 'ok', accountId ? 'Als bezahlt gebucht.' : 'Als bezahlt markiert.');
  });

  /** Bereits frei gebuchte Zahlung nachträglich mit der Eingangsrechnung verbinden */
  app.post('/purchases/:id/link-entry', async (c) => {
    const t = tenantOf(c);
    const p = (await getPurchase(t.id, idParam(c))) ?? notFound();
    assertNotArchived(p);
    if (!cashbookEnabled(t)) notFound();
    const form = await readForm(c);
    const { entry } = await linkEntryToPurchase(t, Number(str(form, 'entry_id')), p.id);
    await audit(c, 'cashbook.entry.link', `${formatDate(entry.entry_date)} ${formatMoney(entry.amount)} „${entry.text}“ → Eingangsrechnung ${purchaseTitle(p)} (ID ${p.id})`);
    return redirectWith(c, `/purchases/${p.id}`, 'ok', `Mit der Buchung vom ${formatDate(entry.entry_date)} verbunden – als bezahlt markiert.`);
  });

  app.post('/purchases/:id/open', async (c) => {
    const t = tenantOf(c);
    const p = (await getPurchase(t.id, idParam(c))) ?? notFound();
    assertNotArchived(p);
    await unlink(t, 'purchase', p.id, userOf(c).id);
    await setPaid(p, null);
    return redirectWith(c, `/purchases/${p.id}`, 'ok', 'Wieder als offen markiert.');
  });

  /** Archivieren statt Löschen – Belege sind aufbewahrungspflichtig */
  app.post('/purchases/:id/archive', async (c) => {
    const t = tenantOf(c);
    const p = (await getPurchase(t.id, idParam(c))) ?? notFound();
    const reason = str(await readForm(c), 'reason', 300);
    await archivePurchase(p, reason);
    await audit(c, 'purchase.archive', `${purchaseTitle(p)} (ID ${p.id}, ${p.file_name || 'ohne Datei'}, ${formatMoney(p.gross_total)})${reason ? `: ${reason}` : ''}`);
    return redirectWith(c, '/purchases?status=archived', 'ok', `${p.status === 'draft' ? 'Beleg' : 'Eingangsrechnung'} archiviert – er bleibt unverändert aufbewahrt.`);
  });

  app.post('/purchases/:id/restore', async (c) => {
    const t = tenantOf(c);
    const p = (await getPurchase(t.id, idParam(c))) ?? notFound();
    await restorePurchase(p);
    await audit(c, 'purchase.restore', `${purchaseTitle(p)} (ID ${p.id})`);
    return redirectWith(c, p.archived_from === 'draft' ? `/purchases/${p.id}/edit` : `/purchases/${p.id}`, 'ok', 'Wiederhergestellt.');
  });

  /** Foto-Beleg zuschneiden – das Original bleibt unverändert erhalten */
  app.post('/purchases/:id/crop', async (c) => {
    const t = tenantOf(c);
    const p = (await getPurchase(t.id, idParam(c))) ?? notFound();
    if (p.status === 'archived') throw new UserError('Der Beleg ist archiviert – zum Zuschneiden zuerst wiederherstellen.');
    const r = await handleCrop(c, 'purchase_invoices', 'verbindlichkeiten', t.id, p.id, p);
    await audit(c, r === 'saved' ? 'purchase.crop' : 'purchase.uncrop', `${purchaseTitle(p)} (ID ${p.id}): ${p.file_name}`);
    return redirectWith(c, p.status === 'draft' ? `/purchases/${p.id}/edit` : `/purchases/${p.id}`, 'ok',
      r === 'saved' ? 'Beleg zugeschnitten – das Original bleibt unverändert erhalten.' : 'Zuschnitt verworfen – es gilt wieder das Original.');
  });

  /** Weitere Belege hochladen bzw. aus dem Belegeingang übernehmen. Ohne Rechnungsdatei wird der erste zur Rechnungsdatei. */
  app.post('/purchases/:id/files', async (c) => {
    const t = tenantOf(c);
    const p = (await getPurchase(t.id, idParam(c))) ?? notFound();
    assertNotArchived(p);
    const form = await readForm(c);
    const files = filesFrom(await c.req.parseBody({ all: true }));
    const inboxId = Number(str(form, 'inbox_id')) || 0;
    if (!files.length && !inboxId) return redirectWith(c, `/purchases/${p.id}`, 'error', 'Bitte ein PDF oder Foto auswählen.');
    const prepared: { name: string; data: Uint8Array; mime: string }[] = [];
    for (const f of files) {
      if (f.size > MAX_ENTRY_FILE) return redirectWith(c, `/purchases/${p.id}`, 'error', `„${f.name}“ ist größer als 10 MB.`);
      const data = new Uint8Array(await f.arrayBuffer());
      const mime = mimeOf(data);
      if (!mime) return redirectWith(c, `/purchases/${p.id}`, 'error', `„${f.name}“: bitte ein PDF oder ein Foto (JPEG/PNG) hochladen.`);
      const ext = mime === 'application/pdf' ? '.pdf' : mime === 'image/png' ? '.png' : '.jpg';
      prepared.push({ name: `${(f.name || 'beleg').replace(/\.(pdf|jpe?g|png|heic)$/i, '')}${ext}`.slice(-120), data, mime });
    }
    let n = 0;
    // aus dem Belegeingang (setzt ggf. die Rechnungsdatei)
    if (inboxId) {
      await assignToPurchase(t, await openInbox(t.id, inboxId), p.id, userOf(c).id);
      n++;
    }
    for (const f of prepared) {
      const fresh = (await getPurchase(t.id, p.id))!;
      if (!fresh.file_path) {
        const stored = await saveFile('verbindlichkeiten', t.id, f.name, f.data);
        await run(
          `UPDATE purchase_invoices SET file_name = ?, file_path = ?, file_mime = ?, file_size = ?, file_sha256 = ?, updated_at = ? WHERE id = ? AND file_path = ''`,
          f.name, stored.path, f.mime, stored.size, stored.sha256, nowIso(), p.id,
        );
      } else {
        await attachPurchaseData(t, p.id, f, userOf(c).id);
      }
      n++;
    }
    await audit(c, 'purchase.file.add', `${purchaseTitle(p)} (ID ${p.id}): ${n} Beleg(e)`);
    return redirectWith(c, `/purchases/${p.id}`, 'ok', `${n} Beleg(e) angehängt.`);
  });

  app.get('/purchases/files/:id', async (c) => {
    const t = tenantOf(c);
    const f = (await getPurchaseFile(t.id, idParam(c))) ?? notFound();
    const v = await viewPurchaseFile(f, c.req.query('original') === '1');
    return c.body(new Uint8Array(v.data), 200, {
      'Content-Type': v.mime,
      'Content-Disposition': attachment(v.name, c.req.query('inline') === '1'),
      'Cache-Control': 'private, no-store',
      'X-Content-Type-Options': 'nosniff',
    });
  });

  app.post('/purchases/files/:id/crop', async (c) => {
    const t = tenantOf(c);
    const f = (await getPurchaseFile(t.id, idParam(c))) ?? notFound();
    if (f.archived_at) return redirectWith(c, `/purchases/${f.purchase_id}`, 'error', 'Der Beleg ist archiviert – zum Zuschneiden zuerst wiederherstellen.');
    const r = await handleCrop(c, 'purchase_files', 'verbindlichkeiten', t.id, f.id, f);
    await audit(c, r === 'saved' ? 'purchase.file.crop' : 'purchase.file.uncrop', `ID ${f.purchase_id}: ${f.file_name}`);
    return redirectWith(c, `/purchases/${f.purchase_id}`, 'ok', r === 'saved' ? 'Beleg zugeschnitten – das Original bleibt unverändert erhalten.' : 'Zuschnitt verworfen – es gilt wieder das Original.');
  });

  /** Archivieren bzw. wiederherstellen – gelöscht wird nie (Aufbewahrungspflicht) */
  app.post('/purchases/files/:id/archive', async (c) => {
    const t = tenantOf(c);
    const f = (await getPurchaseFile(t.id, idParam(c))) ?? notFound();
    const p = (await getPurchase(t.id, f.purchase_id))!;
    assertNotArchived(p);
    await setPurchaseFileArchived(f, !f.archived_at);
    await audit(c, f.archived_at ? 'purchase.file.restore' : 'purchase.file.archive', `${purchaseTitle(p)} (ID ${p.id}): ${f.file_name}`);
    return redirectWith(c, `/purchases/${p.id}`, 'ok', f.archived_at ? 'Beleg wiederhergestellt.' : 'Beleg archiviert – er bleibt unverändert aufbewahrt.');
  });

  app.get('/purchases/:id/file', async (c) => {
    const t = tenantOf(c);
    const p = (await getPurchase(t.id, idParam(c))) ?? notFound();
    if (!p.file_path) notFound();
    const inline = c.req.query('inline') === '1' && p.file_mime !== 'application/xml';
    // Zugeschnittene Fotos: Ausschnitt anzeigen; ?original=1 liefert das unveränderte Original
    const v = await viewOf('verbindlichkeiten', p, c.req.query('original') === '1');
    return c.body(new Uint8Array(v.data), 200, {
      'Content-Type': v.mime || 'application/octet-stream',
      'Content-Disposition': attachment(v.name || `beleg-${p.id}`, inline),
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
  nav: { label: 'Eingangsrechnungen', href: '/purchases', order: 10, group: 'purchase', icon: 'purchases' },
  register,
};

export type { Purchase };
