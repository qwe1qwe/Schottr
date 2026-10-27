import { all, one, run, tx, nowIso, fromDbTime } from '../../db/index.ts';
import { nextNumber } from '../../lib/numbering.ts';
import { html, nl2br, type SafeHtml } from '../../lib/html.ts';
import { addDays, formatDate, today } from '../../lib/dates.ts';
import { formatMoney, formatQuantity, formatRate, formatAmount } from '../../lib/money.ts';
import { unitShort } from '../../lib/units.ts';
import { attachment, idParam, notFound, readForm, redirectWith, str, tenantOf, userOf, UserError } from '../../lib/http.ts';
import { badge, csrfField, empty, page } from '../../views/layout.ts';
import { buildCii } from '../../einvoice/cii.ts';
import { renderPdf } from '../../einvoice/pdf.ts';
import { buildDocumentData, checkInvoice, xrechnungWarnings, type DocumentData } from '../../einvoice/model.ts';
import { articleOptions } from '../articles.ts';
import { dunningSection } from '../dunning.ts';
import { audit } from '../../lib/audit.ts';
import { contactLabel, contactOptions, getContact } from '../contacts.ts';
import {
  createDraft, defaultTaxMode, deleteDraft, docToInput, duplicate, getDoc, getDocById, getItems, invoiceFromQuote,
  parseDraft, updateDraft, type Doc, type DraftInput, type Kind,
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
  });
}

function fileBase(d: DocumentData): string {
  const prefix = d.kind === 'quote' ? 'Angebot' : d.typeCode === '381' ? 'Storno' : 'Rechnung';
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

  // erst prüfen, dann Nummer ziehen
  const problems = checkInvoice(buildDocumentData({ tenant: t, contact, doc, items, number: 'x', draft: false, precedingInvoice }));
  if (problems.length) throw new UserError(problems.join(' '));

  await tx(async () => {
    // Beleg sperren – verhindert doppeltes Festschreiben bei Doppelklick
    const locked = await one('SELECT finalized_at FROM documents WHERE id = ? FOR UPDATE', doc.id);
    if (!locked || locked.finalized_at) throw new UserError('Diese Rechnung ist bereits festgeschrieben.');

    const number = await nextNumber(t.id, 'invoice', t.invoice_number_format, doc.issue_date);
    const data = buildDocumentData({ tenant: t, contact, doc, items, number, draft: false, precedingInvoice });
    const xrechnung = xrechnungWarnings(data).length ? null : buildCii(data, 'xrechnung');
    const pdf = await renderPdf(data, { zugferdXml: buildCii(data, 'en16931') });

    const now = nowIso();
    await run(
      `UPDATE documents SET number = ?, status = ?, snapshot = ?, xml = ?, pdf = ?, finalized_at = ?,
        net_total = ?, tax_total = ?, gross_total = ?, updated_at = ? WHERE id = ?`,
      number, doc.type_code === '381' ? 'settled' : 'open', JSON.stringify(data), xrechnung, pdf, now,
      data.net, data.tax, data.gross, now, doc.id,
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
        <td>${it.articleNumber ? html`<span class="art-no static">Art.-Nr. ${it.articleNumber}</span><br>` : ''}<strong>${it.title}</strong>${it.description ? html`<div class="muted small">${nl2br(it.description)}</div>` : ''}</td>
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
    return page(c, {
      title: k.many,
      actions: html`<a class="btn primary" href="${base}/new">${kind === 'quote' ? 'Neues Angebot' : 'Neue Rechnung'}</a>`,
      body: html`
      <form class="toolbar" method="get">
        <div class="tabs">${STATUS_FILTERS[kind].map(
          (f) => html`<a href="${base}${f.value ? `?status=${f.value}` : ''}" class="${status === f.value ? 'active' : ''}">${f.label}</a>`,
        )}</div>
        ${status ? html`<input type="hidden" name="status" value="${status}">` : ''}
        <input type="search" name="q" value="${q}" placeholder="Suchen …" aria-label="Suchen">
      </form>
      ${rows.length
        ? html`${documentTable(rows, kind)}<p class="muted small right">${rows.length} Beleg(e) · Summe ${formatMoney(sum)}</p>`
        : empty(`Keine ${k.many} gefunden.`, html`<a class="btn primary" href="${base}/new">${kind === 'quote' ? 'Angebot schreiben' : 'Rechnung schreiben'}</a>`)}`,
    });
  });

  app.get(`${base}/new`, async (c) => {
    const t = tenantOf(c);
    const draft = await newDraft(t, kind, Number(c.req.query('contact') ?? 0));
    return page(c, {
      title: kind === 'quote' ? 'Neues Angebot' : 'Neue Rechnung',
      back: { href: base, label: k.many },
      body: documentForm(c, kind, base, draft, await contactOptions(t.id), await articleOptions(t.id)),
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
        ${postButton(c, `${base}/${doc.id}/finalize`, 'Festschreiben', 'btn primary',
          'Rechnung festschreiben? Danach ist sie unveränderbar und erhält eine fortlaufende Rechnungsnummer.')}`;
    } else {
      actions = html`
        <a class="btn" href="${base}/${doc.id}/pdf" target="_blank">ZUGFeRD-PDF (Industrie)</a>
        ${hasXml ? html`<a class="btn" href="${base}/${doc.id}/xrechnung.xml">XRechnung (Öffentlicher Sektor)</a>` : ''}
        ${doc.type_code !== '381' && doc.status !== 'cancelled'
          ? postButton(c, `${base}/${doc.id}/paid`, doc.status === 'paid' ? 'Als offen markieren' : 'Als bezahlt markieren', doc.status === 'paid' ? 'btn ghost' : 'btn primary')
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
    if (doc.paid_at) meta.push(['Bezahlt am', formatDate(doc.paid_at)]);
    if (data.orderReference) meta.push(['Bestellnummer', data.orderReference]);
    if (data.buyerReference) meta.push(['Käuferreferenz', data.buyerReference]);
    meta.push(['Steuer', TAX_MODES.find((m) => m.value === doc.tax_mode)?.label ?? doc.tax_mode]);
    if (doc.finalized_at) meta.push(['Festgeschrieben', fromDbTime(doc.finalized_at).toLocaleString('de-DE', { timeZone: 'Europe/Berlin' })]);

    const titleText = kind === 'quote'
      ? `Angebot ${doc.number}`
      : doc.number ? `${doc.type_code === '381' ? 'Stornorechnung' : 'Rechnung'} ${doc.number}` : 'Rechnungsentwurf';

    return page(c, {
      title: titleText,
      back: { href: base, label: k.many },
      actions,
      body: html`
      <div class="status-line">${badge(status)}${doc.type_code === '381' ? html` <span class="tag">Storno</span>` : ''}
        ${doc.subject ? html`<span class="subject">${doc.subject}</span>` : ''}</div>
      ${problems.length
        ? html`<div class="notice"><strong>Vor dem Festschreiben noch erledigen:</strong><ul>${problems.map((p) => html`<li>${p}</li>`)}</ul>
            ${problems.some((p) => p.includes('Einstellungen')) ? html`<a href="/settings">Zu den Einstellungen</a>` : ''}</div>`
        : ''}
      ${xrWarnings.length ? html`<div class="notice soft">${xrWarnings.join(' ')} Ohne sie wird nur die ZUGFeRD-Rechnung (Industrie) erzeugt, keine XRechnung (Öffentlicher Sektor).</div>` : ''}
      <section class="card">
        <dl class="dl cols">${meta.map(([l, v]) => html`<dt>${l}</dt><dd>${v}</dd>`)}</dl>
      </section>
      ${data.intro ? html`<p class="prose">${nl2br(data.intro)}</p>` : ''}
      ${data.items.length ? itemsTable(data) : html`<p class="muted">Noch keine Positionen.</p>`}
      ${data.outro ? html`<p class="prose">${nl2br(data.outro)}</p>` : ''}
      ${dunnings}
      ${related.length
        ? html`<section><h2 class="section-title">Verknüpfte Belege</h2>
            <ul class="plain">${related.map((r) => html`<li><a href="${KIND[r.kind as Kind].path}/${r.id}">${r.kind === 'quote' ? 'Angebot' : r.type_code === '381' ? 'Stornorechnung' : 'Rechnung'} ${r.number ?? '(Entwurf)'}</a>
              · ${formatDate(r.issue_date)} · ${formatMoney(r.gross_total)} ${badge(displayStatus(r as any))}</li>`)}</ul></section>`
        : ''}
      <div class="danger-zone">
        ${postButton(c, `${base}/${doc.id}/duplicate`, 'Duplizieren', 'btn ghost')}
        ${kind === 'quote'
          ? html`${['sent', 'accepted', 'rejected'].filter((s) => s !== doc.status).map((s) =>
              postButton(c, `${base}/${doc.id}/status?to=${s}`, { sent: 'Als versendet markieren', accepted: 'Angenommen', rejected: 'Abgelehnt' }[s]!, 'btn ghost'))}`
          : ''}
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
      body: documentForm(c, kind, `${base}/${doc.id}`, docToInput(doc, await getItems(doc.id)), await contactOptions(t.id, doc.contact_id), await articleOptions(t.id)),
    });
  });

  app.post(`${base}/:id`, async (c) => {
    const t = tenantOf(c);
    const doc = await getDoc(t.id, kind, idParam(c)) ?? notFound();
    try {
      await updateDraft(doc, await parseDraft(await readForm(c), kind, t.id));
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
    pdf ??= await renderPdf(data);
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
      await audit(c, 'invoice.finalize', `${fin?.number} · ${formatMoney(fin?.gross_total ?? 0)}`);
      return redirectWith(c, `${base}/${doc.id}`, 'ok', 'Rechnung festgeschrieben. ZUGFeRD-PDF und XRechnung stehen zum Download bereit.');
    });

    app.post(`${base}/:id/paid`, async (c) => {
      const t = tenantOf(c);
      const doc = await getDoc(t.id, kind, idParam(c)) ?? notFound();
      if (!doc.finalized_at || doc.status === 'cancelled') notFound();
      const paid = doc.status !== 'paid';
      await run('UPDATE documents SET status = ?, paid_at = ?, updated_at = ? WHERE id = ?', paid ? 'paid' : 'open', paid ? today() : null, nowIso(), doc.id);
      return redirectWith(c, `${base}/${doc.id}`, 'ok', paid ? 'Als bezahlt markiert.' : 'Wieder als offen markiert.');
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
