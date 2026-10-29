import { all, one, run, tx, nowIso, fromDbTime } from '../../db/index.ts';
import { nextNumber } from '../../lib/numbering.ts';
import { html, nl2br, selected, type SafeHtml } from '../../lib/html.ts';
import { isSphere, sphereLabel, sphereSelect, SPHERES } from '../../lib/nonprofit.ts';
import { accountsOf, bookLinked, cashbookEnabled, getAccount, linkedEntry, unlink } from '../cashbook/repo.ts';
import { accountSelect } from '../cashbook/routes.ts';
import { addDays, formatDate, isIsoDate, monthEnd, monthLabel, paidPeriod, today } from '../../lib/dates.ts';
import { formatMoney, formatQuantity, formatRate, formatAmount, parseDecimal } from '../../lib/money.ts';
import { unitShort } from '../../lib/units.ts';
import { attachment, idParam, notFound, readForm, redirectWith, str, tenantOf, userOf, UserError } from '../../lib/http.ts';
import { badge, csrfField, empty, page } from '../../views/layout.ts';
import { buildCii, type CiiAttachment } from '../../einvoice/cii.ts';
import { renderPdf } from '../../einvoice/pdf.ts';
import { buildDocumentData, checkInvoice, xrechnungWarnings, dueAmount, INVOICE_TYPES, SELECTABLE_TYPES, FINAL_TYPES, type DocumentData } from '../../einvoice/model.ts';
import { articleOptions } from '../articles.ts';
import { dunningSection } from '../dunning.ts';
import { audit } from '../../lib/audit.ts';
import { reopenBlocker, versionsSection } from './correction.ts';
import { getLogo } from '../../lib/logo.ts';
import { appendPdfs } from '../../lib/pdfmerge.ts';
import { getProofFiles, getProofIds, proofOptions } from '../proofs.ts';
import { contactLabel, contactOptions, getContact } from '../contacts.ts';
import {
  createDraft, defaultTaxMode, deleteDraft, docToInput, duplicate, getDoc, getDocById, getItems, invoiceFromQuote,
  parseDraft, updateDraft, getPrepayments, getPrepaymentIds, eligiblePrepayments, type Doc, type DraftInput, type Kind,
} from './repo.ts';
import { KIND, TAX_MODES, displayStatus, documentForm, documentTable } from './views.ts';
import type { App, Ctx, Module, Tenant } from '../../types.ts';

const STATUS_FILTERS: Record<Kind, { value: string; label: string }[]> = {
  quote: [
    { value: '', label: 'Alle' }, { value: 'draft', label: 'Entwurf' }, { value: 'sent', label: 'Versendet' },
    { value: 'accepted', label: 'Angenommen' }, { value: 'rejected', label: 'Abgelehnt' }, { value: 'invoiced', label: 'Abgerechnet' },
  ],
  invoice: [
    { value: '', label: 'Alle' }, { value: 'draft', label: 'Entwurf' }, { value: 'open', label: 'Offen' },
    { value: 'overdue', label: 'Überfällig' }, { value: 'paid', label: 'Bezahlt' }, { value: 'cancelled', label: 'Storniert' }, { value: 'settled', label: 'Storno' },
  ],
};

async function newDraft(t: Tenant, kind: Kind, contactId: number): Promise<DraftInput> {
  const date = today();
  const contact = contactId ? await getContact(t.id, contactId) : undefined;
  return {
    contact_id: contact?.id ?? 0,
    issue_date: date,
    valid_until: kind === 'quote' ? addDays(date, t.quote_valid_days) : null,
    due_date: kind === 'invoice' ? addDays(date, t.payment_days) : null,
    service_date: kind === 'invoice' ? date : null,
    service_from: null,
    service_to: null,
    subject: '',
    intro: kind === 'quote' ? t.quote_intro : t.invoice_intro,
    outro: kind === 'quote' ? t.quote_outro : t.invoice_outro,
    buyer_reference: contact?.leitweg_id ?? '',
    order_reference: '',
    tax_mode: defaultTaxMode(t),
    exemption_reason: '',
    sphere: t.nonprofit ? t.default_sphere : '',
    type_code: '380',
    skonto_percent: kind === 'invoice' ? t.skonto_percent : 0,
    skonto_days: kind === 'invoice' ? t.skonto_days : 0,
    prepayment_ids: [],
    proof_ids: [],
    items: [],
  };
}

/** Belegdaten für Anzeige/PDF – bei festgeschriebenen Rechnungen aus dem eingefrorenen Snapshot. */
async function dataFor(t: Tenant, doc: Doc): Promise<DocumentData> {
  if (doc.snapshot) return JSON.parse(doc.snapshot) as DocumentData;
  const contact = await getContact(t.id, doc.contact_id) ?? notFound();
  const preceding = doc.corrects_id ? await getDocById(t.id, doc.corrects_id) : undefined;
  return buildDocumentData({
    tenant: t, contact, doc, items: await getItems(doc.id),
    number: doc.number ?? 'Entwurf',
    draft: doc.kind === 'invoice',
    precedingInvoice: preceding?.number ? { number: preceding.number, issueDate: preceding.issue_date } : null,
    prepayments: await getPrepayments(doc.id),
    proofs: doc.kind === 'invoice' ? (await getProofFiles(doc.id)).map((p) => ({ name: p.name, filename: p.filename })) : [],
  });
}

/** Nachweise als BG-24-Anhänge für die XRechnung (eindeutige Dateinamen, BR-DE-22) */
function ciiAttachments(proofs: { id: number; name: string; filename: string; data: Buffer }[]): CiiAttachment[] {
  return proofs.map((p, i) => ({ id: `NW-${i + 1}`, name: p.name, filename: `${String(i + 1).padStart(2, '0')}_${p.filename}`, data: p.data }));
}

function fileBase(d: DocumentData): string {
  const prefix = d.kind === 'quote' ? 'Angebot' : d.typeCode === '381' ? 'Storno' : INVOICE_TYPES[d.typeCode] ?? 'Rechnung';
  return `${prefix}_${d.number}`.replace(/[^\w.\-äöüÄÖÜß]+/g, '_');
}

/**
 * Rechnung festschreiben: Nummer vergeben, Daten einfrieren, XRechnung + ZUGFeRD erzeugen.
 * Alles in einer Transaktion: Schlägt etwas fehl, wird auch der Nummernzähler
 * zurückgerollt – der Rechnungsnummernkreis bleibt lückenlos.
 */
async function finalize(t: Tenant, doc: Doc): Promise<void> {
  if (doc.kind !== 'invoice' || doc.finalized_at) throw new UserError('Diese Rechnung ist bereits festgeschrieben.');
  const contact = (await getContact(t.id, doc.contact_id)) ?? notFound();
  const items = await getItems(doc.id);
  const preceding = doc.corrects_id ? await getDocById(t.id, doc.corrects_id) : undefined;
  const precedingInvoice = preceding?.number ? { number: preceding.number, issueDate: preceding.issue_date } : null;
  const prepayments = await getPrepayments(doc.id);
  const logo = await getLogo(t.id);
  const proofFiles = await getProofFiles(doc.id);
  const proofs = proofFiles.map((p) => ({ name: p.name, filename: p.filename }));

  // erst prüfen, dann Nummer ziehen
  const problems = checkInvoice(buildDocumentData({ tenant: t, contact, doc, items, number: 'x', draft: false, precedingInvoice, prepayments }));
  if (problems.length) throw new UserError(problems.join(' '));

  await tx(async () => {
    // Beleg sperren – verhindert doppeltes Festschreiben bei Doppelklick
    const locked = await one('SELECT finalized_at FROM documents WHERE id = ? FOR UPDATE', doc.id);
    if (!locked || locked.finalized_at) throw new UserError('Diese Rechnung ist bereits festgeschrieben.');

    // Nachträglich geöffnete Rechnungen behalten ihre Nummer
    const number = doc.number ?? await nextNumber(t.id, 'invoice', t.invoice_number_format, doc.issue_date);
    const data = buildDocumentData({ tenant: t, contact, doc, items, number, draft: false, precedingInvoice, prepayments, proofs });
    const xrechnung = xrechnungWarnings(data).length ? null : buildCii(data, 'xrechnung', ciiAttachments(proofFiles));
    // Nachweise hinten an das ZUGFeRD-PDF anhängen
    const pdf = await appendPdfs(await renderPdf(data, { zugferdXml: buildCii(data, 'en16931'), logo }), proofFiles.map((p) => p.data));

    const now = nowIso();
    await run(
      `UPDATE documents SET number = ?, status = ?, snapshot = ?, xml = ?, pdf = ?, finalized_at = ?,
        net_total = ?, tax_total = ?, gross_total = ?, prepaid_total = ?, updated_at = ? WHERE id = ?`,
      number, doc.type_code === '381' ? 'settled' : doc.paid_at || (data.due ?? data.gross) <= 0 ? 'paid' : 'open', JSON.stringify(data), xrechnung, pdf, now,
      data.net, data.tax, data.gross, data.prepaid ?? 0, now, doc.id,
    );
    if (doc.corrects_id) {
      await run("UPDATE documents SET status = 'cancelled', updated_at = ? WHERE id = ? AND tenant_id = ?", now, doc.corrects_id, t.id);
    }
  });
}

function itemsTable(d: DocumentData): SafeHtml {
  const showVat = d.taxMode === 'standard';
  return html`<section class="card flush"><table class="table">
    <thead><tr><th>Pos.</th><th>Bezeichnung</th><th class="right">Menge</th><th class="right">Einzelpreis</th>${showVat ? html`<th class="right">USt.</th>` : ''}<th class="right">Gesamt</th></tr></thead>
    <tbody>${d.items.map(
      (it) => html`<tr>
        <td>${it.position}</td>
        <td class="stack-title">${it.articleNumber ? html`<span class="art-no static">Art.-Nr. ${it.articleNumber}</span><br>` : ''}<strong>${it.title}</strong>${it.description ? html`<div class="muted small">${nl2br(it.description)}</div>` : ''}</td>
        <td class="right num">${formatQuantity(it.quantity)} ${unitShort(it.unit)}</td>
        <td class="right num">${formatAmount(it.unitPrice)}</td>
        ${showVat ? html`<td class="right num">${formatRate(it.vatRate)}</td>` : ''}
        <td class="right num">${formatAmount(it.lineTotal)}</td>
      </tr>`,
    )}</tbody>
  </table>
  <dl class="totals static">
    <dt>Netto</dt><dd>${formatMoney(d.net)}</dd>
    ${d.taxes.filter((g) => g.category === 'S').map((g) => html`<dt>USt. ${formatRate(g.rate)}</dt><dd>${formatMoney(g.tax)}</dd>`)}
    <dt class="strong">Gesamt</dt><dd class="strong">${formatMoney(d.gross)}</dd>
    ${(d.prepayments ?? []).map((p) => html`<dt>abzgl. Teilrechnung ${p.number}</dt><dd>${formatMoney(-p.gross)}</dd>`)}
    ${d.prepayments?.length ? html`<dt class="strong">Noch zu zahlen</dt><dd class="strong">${formatMoney(dueAmount(d))}</dd>` : ''}
  </dl>
  ${d.exemptionReason ? html`<p class="small exemption">${d.exemptionReason}</p>` : ''}
  </section>`;
}

function postButton(c: Ctx, action: string, label: string, cls = 'btn', confirm?: string): SafeHtml {
  return html`<form method="post" action="${action}" class="inline" ${confirm ? html`data-confirm="${confirm}"` : ''}>${csrfField(c)}<button class="${cls}">${label}</button></form>`;
}

function register(app: App, kind: Kind) {
  const k = KIND[kind];
  const base = k.path;

  app.get(base, async (c) => {
    const t = tenantOf(c);
    const status = c.req.query('status') ?? '';
    const q = (c.req.query('q') ?? '').trim().slice(0, 100);
    const like = `%${q}%`;
    let where = 'd.tenant_id = ? AND d.kind = ?';
    const params: (string | number)[] = [t.id, kind];
    if (status === 'overdue') {
      where += " AND d.status = 'open' AND d.due_date < ?";
      params.push(today());
    } else if (status) {
      where += ' AND d.status = ?';
      params.push(status);
    }
    // Monatsfilter (aus dem Diagramm der Übersicht): festgeschriebene Rechnungen eines Monats
    const monthParam = kind === 'invoice' ? (c.req.query('month') ?? '') : '';
    const month = monthLabel(monthParam) ? monthParam : '';
    if (month) {
      where += ' AND d.finalized_at IS NOT NULL AND d.issue_date >= ? AND d.issue_date <= ?';
      params.push(`${month}-01`, monthEnd(month));
    }
    // Zahlungszeitraum (aus Umsatz-Kachel und Diagramm der Übersicht): in Jahr/Monat bezahlte Rechnungen
    const paidParam = kind === 'invoice' ? (c.req.query('paid') ?? '') : '';
    const paid = paidPeriod(paidParam) ? paidParam : '';
    if (paid) {
      const pp = paidPeriod(paid)!;
      where += ' AND d.paid_at >= ? AND d.paid_at <= ?';
      params.push(pp.from, pp.to);
    }
    // Jahr und Tätigkeitsbereich (aus der Gemeinnützigkeits-Kachel der Übersicht)
    const yearParam = kind === 'invoice' && !month ? (c.req.query('year') ?? '') : '';
    const year = /^\d{4}$/.test(yearParam) ? yearParam : '';
    if (year) {
      where += ' AND d.finalized_at IS NOT NULL AND substr(d.issue_date, 1, 4) = ?';
      params.push(year);
    }
    const sphereParam = kind === 'invoice' && t.nonprofit ? (c.req.query('sphere') ?? '') : '';
    const sphere = isSphere(sphereParam) ? sphereParam : '';
    if (sphere) {
      // ohne eigene Zuordnung gilt die Vorgabe des Mandanten
      where += " AND COALESCE(NULLIF(d.sphere, ''), ?) = ?";
      params.push(t.default_sphere, sphere);
    }
    if (q) {
      where += ' AND (d.number LIKE ? OR d.subject LIKE ? OR c.company LIKE ? OR c.name LIKE ?)';
      params.push(like, like, like, like);
    }
    const rows = await all(
      `SELECT d.*, COALESCE(NULLIF(c.company, ''), c.name) AS contact_label,
         (SELECT MAX(level) FROM dunnings x WHERE x.invoice_id = d.id) AS dunning_level
       FROM documents d JOIN contacts c ON c.id = d.contact_id
       WHERE ${where} ORDER BY (d.number IS NULL) DESC, d.issue_date DESC, d.id DESC LIMIT 500`,
      ...params,
    );
    const sum = rows.reduce((s, d) => s + (d.type_code === '381' ? -d.gross_total : d.gross_total), 0);
    const netSum = rows.reduce((s, d) => s + (d.type_code === '381' ? -d.net_total : d.net_total), 0);
    const link = (st: string) => {
      const qs = new URLSearchParams();
      if (st) qs.set('status', st);
      if (month) qs.set('month', month);
      if (year) qs.set('year', year);
      if (sphere) qs.set('sphere', sphere);
      if (paid) qs.set('paid', paid);
      return `${base}${qs.size ? `?${qs}` : ''}`;
    };
    /** Link ohne einen der Filter (für die Filter-Chips) */
    const without = (key: 'month' | 'year' | 'sphere' | 'paid') => {
      const qs = new URLSearchParams();
      if (status) qs.set('status', status);
      if (paid && key !== 'paid') qs.set('paid', paid);
      if (month && key !== 'month') qs.set('month', month);
      if (year && key !== 'year') qs.set('year', year);
      if (sphere && key !== 'sphere') qs.set('sphere', sphere);
      return `${base}${qs.size ? `?${qs}` : ''}`;
    };
    const chip = (key: 'month' | 'year' | 'sphere' | 'paid', label: string) =>
      html`<a class="filter-chip" href="${without(key)}" title="Filter entfernen">${label} <span aria-hidden="true">×</span><span class="sr-only">Filter entfernen</span></a>`;
    return page(c, {
      title: k.many,
      actions: html`<a class="btn primary" href="${base}/new">${kind === 'quote' ? 'Neues Angebot' : 'Neue Rechnung'}</a>`,
      body: html`
      <form class="toolbar" method="get">
        <div class="tabs">${STATUS_FILTERS[kind].map(
          (f) => html`<a href="${link(f.value)}" class="${status === f.value ? 'active' : ''}">${f.label}</a>`,
        )}</div>
        ${status ? html`<input type="hidden" name="status" value="${status}">` : ''}
        ${month ? html`<input type="hidden" name="month" value="${month}">${chip('month', monthLabel(month) ?? month)}` : ''}
        ${year ? html`<input type="hidden" name="year" value="${year}">${chip('year', year)}` : ''}
        ${paid ? html`<input type="hidden" name="paid" value="${paid}">${chip('paid', paidPeriod(paid)!.label)}` : ''}
        ${sphere ? html`<input type="hidden" name="sphere" value="${sphere}">${chip('sphere', sphereLabel(sphere))}` : ''}
        <input type="search" name="q" value="${q}" placeholder="Suchen …" aria-label="Suchen">
      </form>
      ${rows.length
        ? html`${documentTable(rows, kind)}<p class="muted small right">${rows.length} Beleg(e) · ${month || year || sphere || paid ? `netto ${formatMoney(netSum)} · brutto ` : 'Summe '}${formatMoney(sum)}</p>`
        : empty(`Keine ${k.many} gefunden.`, html`<a class="btn primary" href="${base}/new">${kind === 'quote' ? 'Angebot schreiben' : 'Rechnung schreiben'}</a>`)}`,
    });
  });

  app.get(`${base}/new`, async (c) => {
    const t = tenantOf(c);
    const draft = await newDraft(t, kind, Number(c.req.query('contact') ?? 0));
    return page(c, {
      title: kind === 'quote' ? 'Neues Angebot' : 'Neue Rechnung',
      back: { href: base, label: k.many },
      body: documentForm(
        c, kind, base, draft, await contactOptions(t.id), await articleOptions(t.id),
        kind === 'invoice' ? await eligiblePrepayments(t.id) : [], kind === 'invoice' ? await proofOptions(t.id) : [],
      ),
    });
  });

  app.post(base, async (c) => {
    const t = tenantOf(c);
    try {
      const input = await parseDraft(await readForm(c), kind, t.id);
      const id = await createDraft(t, kind, input, userOf(c).id);
      return redirectWith(c, `${base}/${id}`, 'ok', `${k.one} gespeichert.`);
    } catch (err) {
      if (err instanceof UserError) return redirectWith(c, `${base}/new`, 'error', err.message);
      throw err;
    }
  });

  app.get(`${base}/:id`, async (c) => {
    const t = tenantOf(c);
    const doc = await getDoc(t.id, kind, idParam(c)) ?? notFound();
    const data = await dataFor(t, doc);
    const contact = await getContact(t.id, doc.contact_id);
    const status = displayStatus(doc);
    const isDraftInvoice = kind === 'invoice' && !doc.finalized_at;
    const problems = isDraftInvoice ? checkInvoice(data) : [];
    const xrWarnings = isDraftInvoice ? xrechnungWarnings(data) : [];
    const related = await all(
      `SELECT id, kind, number, type_code, status, issue_date, gross_total, due_date FROM documents
       WHERE tenant_id = ? AND (source_quote_id = ? OR corrects_id = ? OR id = ? OR id = ?) AND id != ?
       ORDER BY id`,
      t.id, doc.id, doc.id, doc.source_quote_id ?? 0, doc.corrects_id ?? 0, doc.id,
    );
    const hasXml = !!await one('SELECT 1 FROM documents WHERE id = ? AND xml IS NOT NULL', doc.id);
    const dunnings = kind === 'invoice' ? await dunningSection(c, t, doc) : '';
    const versions = kind === 'invoice' ? await versionsSection(doc.id) : '';
    const canReopen = kind === 'invoice' && !!doc.finalized_at && !(await reopenBlocker(doc as any));
    // Kassenbuch (Vereine): Zahlungseingang einem Konto zuordnen
    const cashAccounts = kind === 'invoice' && doc.finalized_at && doc.type_code !== '381' && cashbookEnabled(t) ? await accountsOf(t.id) : [];
    const payment = kind === 'invoice' && doc.finalized_at ? await linkedEntry('invoice', doc.id) : undefined;
    const paymentAccount = payment ? await getAccount(t.id, payment.account_id) : undefined;

    let actions: SafeHtml;
    if (kind === 'quote') {
      actions = html`
        <a class="btn" href="${base}/${doc.id}/pdf" target="_blank">PDF</a>
        <a class="btn" href="${base}/${doc.id}/edit">Bearbeiten</a>
        ${postButton(c, `${base}/${doc.id}/invoice`, 'In Rechnung umwandeln', 'btn primary')}`;
    } else if (isDraftInvoice) {
      actions = html`
        <a class="btn" href="${base}/${doc.id}/pdf" target="_blank">Vorschau</a>
        <a class="btn" href="${base}/${doc.id}/edit">Bearbeiten</a>
        ${doc.revision
          ? postButton(c, `${base}/${doc.id}/finalize`, 'Erneut festschreiben', 'btn primary',
              `Rechnung ${doc.number} als Version ${doc.revision + 1} erneut festschreiben?`)
          : postButton(c, `${base}/${doc.id}/finalize`, 'Festschreiben', 'btn primary',
              'Rechnung festschreiben? Danach ist sie unveränderbar und erhält eine fortlaufende Rechnungsnummer.')}`;
    } else {
      actions = html`
        <a class="btn" href="${base}/${doc.id}/pdf" target="_blank">ZUGFeRD-PDF (Industrie)</a>
        ${hasXml ? html`<a class="btn" href="${base}/${doc.id}/xrechnung.xml">XRechnung (Öffentlicher Sektor)</a>` : ''}
        ${doc.type_code !== '381' && doc.status !== 'cancelled'
          ? (doc.status !== 'paid' && cashAccounts.length
              ? ''
              : postButton(c, `${base}/${doc.id}/paid`, doc.status === 'paid' ? 'Als offen markieren' : 'Als bezahlt markieren', doc.status === 'paid' ? 'btn ghost' : 'btn primary',
                  payment ? 'Wieder als offen markieren? Die Buchung im Kassenbuch wird entfernt.' : undefined))
          : ''}`;
    }

    const meta: [string, SafeHtml | string][] = [
      ['Kunde', contact ? html`<a href="/contacts/${contact.id}">${contactLabel(contact)}</a>` : data.buyer.name],
      ['Datum', formatDate(doc.issue_date)],
    ];
    if (kind === 'quote' && doc.valid_until) meta.push(['Gültig bis', formatDate(doc.valid_until)]);
    if (data.serviceDate) meta.push(['Leistungsdatum', formatDate(data.serviceDate)]);
    if (data.serviceFrom && data.serviceTo) meta.push(['Leistungszeitraum', `${formatDate(data.serviceFrom)} – ${formatDate(data.serviceTo)}`]);
    if (kind === 'invoice' && doc.due_date && doc.type_code !== '381') meta.push(['Fällig am', formatDate(doc.due_date)]);
    if (data.skonto) meta.push(['Skonto', `${formatRate(data.skonto.percent)} bis ${formatDate(data.skonto.date)} (${formatMoney(data.skonto.amount)})`]);
    if (doc.paid_at) meta.push(['Bezahlt am', formatDate(doc.paid_at)]);
    if (payment) meta.push(['Zahlungseingang', html`${formatMoney(payment.amount)} auf <a href="/cashbook?account=${payment.account_id}">${paymentAccount?.name ?? 'Konto'}</a>`]);
    if (data.orderReference) meta.push(['Bestellnummer', data.orderReference]);
    if (data.buyerReference) meta.push(['Käuferreferenz', data.buyerReference]);
    meta.push(['Steuer', TAX_MODES.find((m) => m.value === doc.tax_mode)?.label ?? doc.tax_mode]);
    if (t.nonprofit) {
      const label = sphereLabel(doc.sphere || t.default_sphere);
      // festgeschriebene Rechnungen: Bereich bleibt änderbar (interne Zuordnung, nicht Teil des Belegs)
      meta.push(['Bereich', doc.finalized_at
        ? html`<form method="post" action="${base}/${doc.id}/sphere" class="inline sphere-form">${csrfField(c)}
            ${sphereSelect({ value: doc.sphere || t.default_sphere, compact: true, ariaLabel: 'Bereich (Gemeinnützigkeit)' })}
            <button class="btn small">Ändern</button></form>`
        : label]);
    }
    if (doc.finalized_at) meta.push(['Festgeschrieben', fromDbTime(doc.finalized_at).toLocaleString('de-DE', { timeZone: 'Europe/Berlin' })]);

    const titleText = kind === 'quote'
      ? `Angebot ${doc.number}`
      : `${INVOICE_TYPES[doc.type_code as keyof typeof INVOICE_TYPES] ?? 'Rechnung'} ${doc.number ?? '(Entwurf)'}`;

    return page(c, {
      title: titleText,
      back: { href: base, label: k.many },
      actions,
      body: html`
      <div class="status-line">${badge(status)}${doc.type_code === '381' ? html` <span class="tag">Storno</span>` : ''}
        ${doc.subject ? html`<span class="subject">${doc.subject}</span>` : ''}</div>
      ${isDraftInvoice && doc.revision
        ? html`<div class="notice danger-notice">Diese Rechnung wird <strong>nachträglich bearbeitet</strong>. Die bisherige Fassung ist als Version ${doc.revision} archiviert.
            Nach dem Bearbeiten bitte <strong>erneut festschreiben</strong> – bis dahin gilt sie als Entwurf.</div>`
        : ''}
      ${problems.length
        ? html`<div class="notice"><strong>Vor dem Festschreiben noch erledigen:</strong><ul>${problems.map((p) => html`<li>${p}</li>`)}</ul>
            ${problems.some((p) => p.includes('Einstellungen')) ? html`<a href="/settings">Zu den Einstellungen</a>` : ''}</div>`
        : ''}
      ${xrWarnings.length ? html`<div class="notice soft">${xrWarnings.join(' ')} Ohne sie wird nur die ZUGFeRD-Rechnung (Industrie) erzeugt, keine XRechnung (Öffentlicher Sektor).</div>` : ''}
      <section class="card">
        <dl class="dl cols">${meta.map(([l, v]) => html`<dt>${l}</dt><dd>${v}</dd>`)}</dl>
      </section>
      ${cashAccounts.length && doc.status === 'open'
        ? html`<section class="card">
            <h2>Zahlungseingang</h2>
            <form method="post" action="${base}/${doc.id}/paid" class="inline-form">
              ${csrfField(c)}
              <label>Bezahlt am <input type="date" name="paid_at" value="${today()}" max="${today()}" required></label>
              <label>Konto ${accountSelect(cashAccounts, cashAccounts.find((a) => a.kind === 'bank')?.id)}</label>
              <label>Betrag (€) <input name="amount" class="num" inputmode="decimal" value="${formatAmount(dueAmount(data)).replace(/\./g, '')}" required>
                </label>
              <button class="btn primary">Als bezahlt buchen</button>
            </form>
            <p class="muted small">Weicht der Betrag ab (z. B. Skonto), den tatsächlich eingegangenen Betrag eintragen.</p>
          </section>`
        : ''}
      ${data.intro ? html`<p class="prose">${nl2br(data.intro)}</p>` : ''}
      ${data.items.length ? itemsTable(data) : html`<p class="muted">Noch keine Positionen.</p>`}
      ${data.outro ? html`<p class="prose">${nl2br(data.outro)}</p>` : ''}
      ${data.proofs?.length
        ? html`<section><h2 class="section-title">Angehängte Nachweise <span class="count">${data.proofs.length}</span></h2>
            <ul class="plain">${data.proofs.map((p) => html`<li>${p.name} <span class="muted small">· ${p.filename}</span></li>`)}</ul></section>`
        : ''}
      ${versions}
      ${dunnings}
      ${related.length
        ? html`<section><h2 class="section-title">Verknüpfte Belege</h2>
            <ul class="plain">${related.map((r) => html`<li><a href="${KIND[r.kind as Kind].path}/${r.id}">${r.kind === 'quote' ? 'Angebot' : r.type_code === '381' ? 'Stornorechnung' : 'Rechnung'} ${r.number ?? '(Entwurf)'}</a>
              · ${formatDate(r.issue_date)} · ${formatMoney(r.gross_total)} ${badge(displayStatus(r as any))}</li>`)}</ul></section>`
        : ''}
      <div class="danger-zone">
        ${doc.type_code !== '381' ? postButton(c, `${base}/${doc.id}/duplicate`, 'Duplizieren', 'btn ghost') : ''}
        ${kind === 'quote'
          ? html`${['sent', 'accepted', 'rejected'].filter((s) => s !== doc.status).map((s) =>
              postButton(c, `${base}/${doc.id}/status?to=${s}`, { sent: 'Als versendet markieren', accepted: 'Angenommen', rejected: 'Abgelehnt' }[s]!, 'btn ghost'))}`
          : ''}
        ${canReopen ? html`<a class="btn danger" href="${base}/${doc.id}/correct">Nachträglich bearbeiten</a>` : ''}
        ${kind === 'invoice' && doc.finalized_at && doc.type_code !== '381' && doc.status !== 'cancelled'
          ? postButton(c, `${base}/${doc.id}/cancel`, 'Stornieren', 'btn danger',
              'Stornorechnung erzeugen? Die Rechnung wird damit storniert. Das lässt sich nicht rückgängig machen.')
          : ''}
        ${!doc.finalized_at ? postButton(c, `${base}/${doc.id}/delete`, 'Löschen', 'btn danger', `${k.one} wirklich löschen?`) : ''}
      </div>`,
    });
  });

  app.get(`${base}/:id/edit`, async (c) => {
    const t = tenantOf(c);
    const doc = await getDoc(t.id, kind, idParam(c)) ?? notFound();
    if (doc.finalized_at) return redirectWith(c, `${base}/${doc.id}`, 'error', 'Festgeschriebene Rechnungen können nicht geändert werden.');
    return page(c, {
      title: kind === 'quote' ? `Angebot ${doc.number} bearbeiten` : 'Rechnungsentwurf bearbeiten',
      back: { href: `${base}/${doc.id}`, label: 'Zurück' },
      body: documentForm(
        c, kind, `${base}/${doc.id}`,
        { ...docToInput(doc, await getItems(doc.id)), prepayment_ids: await getPrepaymentIds(doc.id), proof_ids: await getProofIds(doc.id) },
        await contactOptions(t.id, doc.contact_id), await articleOptions(t.id),
        kind === 'invoice' ? await eligiblePrepayments(t.id, doc.id) : [],
        kind === 'invoice' ? await proofOptions(t.id, await getProofIds(doc.id)) : [],
      ),
    });
  });

  app.post(`${base}/:id`, async (c) => {
    const t = tenantOf(c);
    const doc = await getDoc(t.id, kind, idParam(c)) ?? notFound();
    try {
      await updateDraft(t, doc, await parseDraft(await readForm(c), kind, t.id));
      return redirectWith(c, `${base}/${doc.id}`, 'ok', 'Gespeichert.');
    } catch (err) {
      if (err instanceof UserError) return redirectWith(c, `${base}/${doc.id}/edit`, 'error', err.message);
      throw err;
    }
  });

  app.post(`${base}/:id/delete`, async (c) => {
    const t = tenantOf(c);
    const doc = await getDoc(t.id, kind, idParam(c)) ?? notFound();
    await deleteDraft(doc);
    return redirectWith(c, base, 'ok', `${k.one} gelöscht.`);
  });

  app.post(`${base}/:id/duplicate`, async (c) => {
    const t = tenantOf(c);
    const doc = await getDoc(t.id, kind, idParam(c)) ?? notFound();
    const id = await duplicate(t, doc, userOf(c).id);
    return redirectWith(c, `${base}/${id}/edit`, 'ok', 'Kopie angelegt.');
  });

  app.get(`${base}/:id/pdf`, async (c) => {
    const t = tenantOf(c);
    const doc = await getDoc(t.id, kind, idParam(c)) ?? notFound();
    const data = await dataFor(t, doc);
    let pdf: Uint8Array | null = null;
    if (doc.finalized_at) {
      const row = await one<{ pdf: Uint8Array }>('SELECT pdf FROM documents WHERE id = ?', doc.id);
      pdf = row?.pdf ?? null;
    }
    if (!pdf) {
      pdf = await renderPdf(data, { logo: await getLogo(t.id) });
      if (kind === 'invoice') pdf = await appendPdfs(Buffer.from(pdf), (await getProofFiles(doc.id)).map((p) => p.data));
    }
    return c.body(Buffer.from(pdf), 200, {
      'Content-Type': 'application/pdf',
      'Content-Disposition': attachment(`${fileBase(data)}.pdf`, true),
      'Cache-Control': 'private, no-store',
    });
  });

  if (kind === 'quote') {
    app.post(`${base}/:id/status`, async (c) => {
      const t = tenantOf(c);
      const doc = await getDoc(t.id, kind, idParam(c)) ?? notFound();
      const to = c.req.query('to') ?? '';
      if (!['draft', 'sent', 'accepted', 'rejected'].includes(to)) notFound();
      await run('UPDATE documents SET status = ?, updated_at = ? WHERE id = ?', to, nowIso(), doc.id);
      return redirectWith(c, `${base}/${doc.id}`, 'ok', 'Status geändert.');
    });

    app.post(`${base}/:id/invoice`, async (c) => {
      const t = tenantOf(c);
      const doc = await getDoc(t.id, kind, idParam(c)) ?? notFound();
      const id = await invoiceFromQuote(t, doc, userOf(c).id);
      return redirectWith(c, `/invoices/${id}`, 'ok', 'Rechnungsentwurf aus dem Angebot erstellt. Bitte prüfen und festschreiben.');
    });
  }

  if (kind === 'invoice') {
    app.post(`${base}/:id/finalize`, async (c) => {
      const t = tenantOf(c);
      const doc = await getDoc(t.id, kind, idParam(c)) ?? notFound();
      try {
        await finalize(t, doc);
      } catch (err) {
        if (err instanceof UserError) return redirectWith(c, `${base}/${doc.id}`, 'error', err.message);
        throw err;
      }
      const fin = await getDoc(t.id, kind, doc.id);
      await audit(c, doc.revision ? 'invoice.refinalize' : 'invoice.finalize', `${fin?.number}${doc.revision ? ` (Version ${doc.revision + 1})` : ''} · ${formatMoney(fin?.gross_total ?? 0)}`);
      return redirectWith(c, `${base}/${doc.id}`, 'ok', 'Rechnung festgeschrieben. ZUGFeRD-PDF und XRechnung stehen zum Download bereit.');
    });

    app.post(`${base}/:id/sphere`, async (c) => {
      const t = tenantOf(c);
      const doc = await getDoc(t.id, kind, idParam(c)) ?? notFound();
      const sphere = str(await readForm(c), 'sphere');
      if (!t.nonprofit || !isSphere(sphere)) return redirectWith(c, `${base}/${doc.id}`, 'error', 'Ungültiger Bereich.');
      await run('UPDATE documents SET sphere = ?, updated_at = ? WHERE id = ?', sphere, nowIso(), doc.id);
      await audit(c, 'document.sphere', `${doc.number ?? doc.id}: ${sphereLabel(sphere)}`);
      return redirectWith(c, `${base}/${doc.id}`, 'ok', `Bereich auf „${sphereLabel(sphere)}“ gesetzt.`);
    });

    app.post(`${base}/:id/paid`, async (c) => {
      const t = tenantOf(c);
      const doc = await getDoc(t.id, kind, idParam(c)) ?? notFound();
      if (!doc.finalized_at || doc.status === 'cancelled') notFound();
      const paid = doc.status !== 'paid';
      const form = await readForm(c);
      const date = str(form, 'paid_at') || today();
      if (!isIsoDate(date)) throw new UserError('Ungültiges Datum.');
      const accountId = Number(str(form, 'account_id')) || 0;
      if (!paid) await unlink(t, 'invoice', doc.id);
      await tx(async () => {
        await run('UPDATE documents SET status = ?, paid_at = ?, updated_at = ? WHERE id = ?', paid ? 'paid' : 'open', paid ? date : null, nowIso(), doc.id);
        if (paid && accountId) {
          const amount = parseDecimal(str(form, 'amount'), 2);
          if (amount === null || amount <= 0) throw new UserError('Bitte den eingegangenen Betrag angeben.');
          await bookLinked(t, 'invoice', doc.id, { account_id: accountId, entry_date: date, amount, text: '' }, userOf(c).id);
        }
      });
      return redirectWith(c, `${base}/${doc.id}`, 'ok', paid ? (accountId ? 'Als bezahlt gebucht.' : 'Als bezahlt markiert.') : 'Wieder als offen markiert.');
    });

    app.post(`${base}/:id/cancel`, async (c) => {
      const t = tenantOf(c);
      const doc = await getDoc(t.id, kind, idParam(c)) ?? notFound();
      if (!doc.finalized_at || doc.type_code === '381' || doc.status === 'cancelled') {
        return redirectWith(c, `${base}/${doc.id}`, 'error', 'Diese Rechnung kann nicht storniert werden.');
      }
      const original = JSON.parse(doc.snapshot!) as DocumentData;
      const date = today();
      const input: DraftInput = {
        ...docToInput(doc, await getItems(doc.id)),
        issue_date: date,
        due_date: null,
        intro: `hiermit stornieren wir die Rechnung ${doc.number} vom ${formatDate(doc.issue_date)} vollständig.`,
        outro: '',
        service_date: original.serviceDate,
        service_from: original.serviceFrom,
        service_to: original.serviceTo,
        skonto_percent: 0,
        skonto_days: 0,
        prepayment_ids: [],
        proof_ids: [],
      };
      const id = await createDraft(t, 'invoice', input, userOf(c).id, { type_code: '381', corrects_id: doc.id });
      try {
        await finalize(t, (await getDoc(t.id, 'invoice', id))!);
      } catch (err) {
        if (err instanceof UserError) {
          return redirectWith(c, `${base}/${id}`, 'error', `Storno angelegt, aber noch nicht festgeschrieben: ${err.message}`);
        }
        throw err;
      }
      await audit(c, 'invoice.cancel', `${doc.number}`);
      return redirectWith(c, `${base}/${id}`, 'ok', `Rechnung ${doc.number} wurde storniert.`);
    });

    app.get(`${base}/:id/xrechnung.xml`, async (c) => {
      const t = tenantOf(c);
      const doc = await getDoc(t.id, kind, idParam(c)) ?? notFound();
      const row = await one<{ xml: Uint8Array | string | null }>('SELECT xml FROM documents WHERE id = ?', doc.id);
      if (!row?.xml) notFound();
      const data = await dataFor(t, doc);
      return c.body(typeof row.xml === 'string' ? row.xml : Buffer.from(row.xml), 200, {
        'Content-Type': 'application/xml; charset=utf-8',
        'Content-Disposition': attachment(`${fileBase(data)}_XRechnung.xml`),
        'Cache-Control': 'private, no-store',
      });
    });
  }
}

export const quotesModule: Module = {
  name: 'quotes',
  nav: { label: 'Angebote', href: '/quotes', order: 20 },
  register: (app) => register(app, 'quote'),
};

export const invoicesModule: Module = {
  name: 'invoices',
  nav: { label: 'Rechnungen', href: '/invoices', order: 30 },
  register: (app) => register(app, 'invoice'),
};

export { finalize };
