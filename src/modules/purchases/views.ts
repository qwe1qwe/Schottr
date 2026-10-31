import { sphereSelect } from '../../lib/nonprofit.ts';
import { html, raw, selected, checked, type SafeHtml } from '../../lib/html.ts';
import { formatDate, today } from '../../lib/dates.ts';
import { formatAmount, formatMoney, formatQuantity, formatRate } from '../../lib/money.ts';
import { EXPENSE_CATEGORIES, categoriesFor, categoryLabel } from '../../lib/expenses.ts';
import { tenantOf } from '../../lib/http.ts';
import { unitShort } from '../../lib/units.ts';
import { csrfField } from '../../views/layout.ts';
import type { Ctx } from '../../types.ts';
import type { Contact } from '../contacts.ts';
import { dueOf, payable, type EInvoiceInfo, type Purchase, type PurchaseInput, type PurchaseTax } from './repo.ts';

export const PURCHASE_STATUS: Record<string, string> = {
  draft: 'Zu erfassen',
  open: 'Offen',
  overdue: 'Überfällig',
  paid: 'Bezahlt',
};

export function purchaseStatus(p: Pick<Purchase, 'status' | 'due_date' | 'issue_date'>): string {
  if (p.status === 'open') {
    const due = dueOf(p);
    if (due && due < today()) return 'overdue';
  }
  return p.status;
}

export function purchaseBadge(status: string): SafeHtml {
  const cls = status === 'draft' ? 'todo' : status;
  return html`<span class="badge badge-${cls}">${PURCHASE_STATUS[status] ?? status}</span>`;
}

const signed = (p: { is_credit: number; gross_total: number }) => (p.is_credit ? -p.gross_total : p.gross_total);

export function purchaseTitle(p: Pick<Purchase, 'number' | 'status' | 'file_name'>): string {
  if (p.number) return p.number;
  if (p.status === 'draft') return p.file_name || 'Beleg';
  return 'ohne Nr.';
}

export function purchaseTable(rows: any[], showSupplier = true): SafeHtml {
  return html`<div class="card flush"><table class="table">
    <thead><tr>
      <th>Rechnungsnr.</th><th>Datum</th>${showSupplier ? html`<th>Lieferant</th>` : ''}<th>Beschreibung</th><th>Kostenart</th>
      <th>Status</th><th>Fällig</th><th class="right">Brutto</th>
    </tr></thead>
    <tbody>${rows.map((p) => {
      const st = purchaseStatus(p);
      return html`<tr class="rowlink" data-href="/purchases/${p.id}">
        <td><a href="/purchases/${p.id}" class="${p.number ? 'mono' : ''}">${purchaseTitle(p)}</a>
          ${p.is_credit ? html` <span class="tag">Gutschrift</span>` : ''}${p.einvoice_format ? html` <span class="tag info" title="${p.einvoice_format}">E-Rechnung</span>` : ''}</td>
        <td>${formatDate(p.issue_date)}</td>
        ${showSupplier ? html`<td>${p.contact_label ?? html`<span class="muted">–</span>`}</td>` : ''}
        <td class="truncate desc-col" title="${p.description}">${p.description || html`<span class="muted">–</span>`}</td>
        <td>${p.status === 'draft' ? '' : categoryLabel(p.category)}</td>
        <td>${purchaseBadge(st)}</td>
        <td>${p.status === 'open' ? formatDate(dueOf(p)) : ''}</td>
        <td class="right num">${p.status === 'draft' ? '' : formatMoney(signed(p))}</td>
      </tr>`;
    })}</tbody>
  </table></div>`;
}

/** Upload-Feld für Belege (mehrere Dateien) */
export function uploadCard(c: Ctx): SafeHtml {
  return html`<section class="card upload-card">
    <form method="post" action="/purchases/upload" enctype="multipart/form-data" class="upload-drop" data-upload>
      ${csrfField(c)}
      <label class="drop-zone">
        <input type="file" name="files[]" multiple required accept=".pdf,.xml,.png,.jpg,.jpeg,application/pdf,application/xml,text/xml,image/png,image/jpeg" data-upload-input>
        <strong>Belege hier ablegen oder auswählen</strong>
        <span class="muted small">E-Rechnungen (XRechnung, ZUGFeRD) werden automatisch übernommen – PDFs und Scans (JPG, PNG) erfasst du danach mit Vorschau. Max. 10 MB je Datei.</span>
        <span class="drop-files small" data-upload-files hidden></span>
      </label>
      <div class="form-actions"><button class="btn primary">Hochladen</button> <a class="btn ghost" href="/purchases/new">Ohne Beleg erfassen</a></div>
    </form>
    <form method="post" action="/capture" enctype="multipart/form-data" class="photo-capture" data-photo-submit>
      ${csrfField(c)}<input type="hidden" name="target" value="purchase">
      <label class="btn">📷 Foto aufnehmen<input type="file" name="files[]" accept="image/*" capture="environment" class="sr-only"></label>
      <span class="muted small">Beleg mit dem Handy fotografieren – mehrseitige Belege über <a href="/capture?target=purchase">Beleg erfassen</a>.</span>
    </form>
  </section>`;
}

/* ---------------- Formular ---------------- */

function taxRowHtml(t?: PurchaseTax): SafeHtml {
  const v = (n: number | undefined) => (n === undefined ? '' : formatAmount(n).replace(/\./g, ''));
  return html`<tr class="tax-row">
    <td data-label="USt.-Satz"><select name="tax_rate[]" aria-label="Steuersatz">${[1900, 700, 0].map((r) => html`<option value="${r}"${selected(r, t?.rate ?? 1900)}>${r / 100} %</option>`)}</select></td>
    <td data-label="Netto €"><input name="tax_net[]" value="${v(t?.basis)}" inputmode="decimal" class="num" placeholder="0,00" aria-label="Netto"></td>
    <td data-label="USt. €"><input name="tax_tax[]" value="${v(t?.tax)}" inputmode="decimal" class="num" placeholder="0,00" aria-label="Umsatzsteuer"></td>
    <td data-label="Brutto €"><input name="tax_gross[]" value="${t ? v(t.basis + t.tax) : ''}" inputmode="decimal" class="num" placeholder="0,00" aria-label="Brutto"></td>
    <td class="remove-cell"><button type="button" class="icon remove" title="Zeile entfernen" aria-label="Zeile entfernen">×</button></td>
  </tr>`;
}

/** Kostenarten: bei Vereinen zuerst die Vereins-Kostenarten, dann die allgemeinen (als Gruppen) */
export function categoryOptions(c: Ctx, current: string, empty?: string): SafeHtml {
  const list = categoriesFor(tenantOf(c));
  const option = (x: { key: string; label: string }) => html`<option value="${x.key}"${selected(x.key, current)}>${x.label}</option>`;
  const missing = EXPENSE_CATEGORIES.find((x) => x.key === current && !list.some((y) => y.key === current));
  const assoc = list.filter((x) => x.association);
  const none = empty ? html`<option value=""${selected('', current)}>${empty}</option>` : '';
  if (!assoc.length) return html`${none}${list.map(option)}${missing ? option(missing) : ''}`;
  return html`${none}<optgroup label="Verein">${assoc.map(option)}</optgroup>
    <optgroup label="Allgemein">${list.filter((x) => !x.association).map(option)}${missing ? option(missing) : ''}</optgroup>`;
}

export function purchaseForm(
  c: Ctx, action: string, d: PurchaseInput, suppliers: Contact[],
  opts: {
    locked?: Purchase; taxes?: PurchaseTax[]; preview?: SafeHtml; smallBusiness?: boolean; defaultSphere?: string | null;
    /** Kassenbuch: Konten zur Auswahl, wenn „Bezahlt am“ gesetzt ist */
    accounts?: { id: number; name: string; kind: string }[]; paidAccountId?: number | null;
  } = {},
): SafeHtml {
  const locked = opts.locked;
  const fields = html`
    <section class="card">
      ${locked
        ? html`<p class="muted small">Lieferant, Rechnungsnummer, Datum und Beträge stammen aus der E-Rechnung (${locked.einvoice_format}) und lassen sich nicht ändern.</p>`
        : html`<div class="grid-2">
            <label class="span-2">Lieferant
              <select name="contact_id" data-supplier>
                <option value="">– neuer Lieferant –</option>
                ${suppliers.map((s) => html`<option value="${s.id}" data-category="${s.expense_category}"${selected(s.id, d.contact_id)}>${s.company || s.name}${s.city ? ` (${s.city})` : ''}</option>`)}
              </select>
            </label>
            <label class="span-2" data-new-supplier>Name des neuen Lieferanten
              <input name="new_supplier" value="${d.new_supplier}" maxlength="200" placeholder="z. B. Bürobedarf Meier GmbH">
              <small class="muted">Wird als Lieferant angelegt; Anschrift usw. kannst du später unter Adressen ergänzen.</small>
            </label>
            <label>Rechnungsnummer <input name="number" value="${d.number}" maxlength="100"></label>
            <label>Rechnungsdatum <input type="date" name="issue_date" value="${d.issue_date ?? ''}" required></label>
          </div>`}
      <div class="grid-2 ${locked ? '' : 'spaced-top'}">
        <label>Kostenart
          <select name="category" data-category>${categoryOptions(c, d.category)}</select>
        </label>
        ${opts.defaultSphere
          ? html`<div class="span-2">${sphereSelect({ value: d.sphere || opts.defaultSphere })}</div>`
          : ''}
        <label>Fällig am <input type="date" name="due_date" value="${d.due_date ?? ''}">
          <small class="muted">leer = sofort fällig</small></label>
        <label class="span-2">Beschreibung <input name="description" value="${d.description}" maxlength="300" placeholder="optional, z. B. Druckerpapier, Hosting Oktober"></label>
        <label>Bezahlt am <input type="date" name="paid_at" value="${d.paid_at ?? ''}" data-paid-at>
          <small class="muted">leer = noch offen</small></label>
        ${opts.accounts?.length
          ? html`<label data-paid-account>Bezahlt von Konto
              <select name="paid_account_id">
                <option value="">– Konto wählen –</option>
                ${opts.accounts.map((a) => html`<option value="${a.id}"${selected(a.id, opts.paidAccountId ?? '')}>${a.name}</option>`)}
              </select>
              <small class="muted">Pflicht, sobald „Bezahlt am“ gesetzt ist – die Zahlung wird im Kassenbuch gebucht.</small></label>`
          : ''}
        ${locked ? '' : html`<label class="check"><input type="checkbox" name="is_credit" value="1"${checked(d.is_credit)}> Gutschrift / Rechnungskorrektur zu meinen Gunsten</label>`}
      </div>
    </section>

    ${locked
      ? taxSummary(opts.taxes ?? [], locked)
      : html`<section class="card flush">
          <table class="table tax-rows" data-tax-rows>
            <thead><tr><th>USt.-Satz</th><th>Netto €</th><th>USt. €</th><th>Brutto €</th><th></th></tr></thead>
            <tbody>${d.taxes.length ? d.taxes.map((t) => taxRowHtml(t)) : taxRowHtml()}</tbody>
          </table>
          <template data-tax-template>${taxRowHtml()}</template>
          <div class="items-foot">
            <div class="add-items"><button type="button" class="btn ghost" data-add-tax>+ Weiterer Steuersatz</button>
              <small class="muted">Netto oder Brutto genügt – der Rest wird berechnet.${opts.smallBusiness ? ' Als Kleinunternehmer zählt für dich der Bruttobetrag (kein Vorsteuerabzug).' : ''}</small></div>
            <dl class="totals">
              <dt>Netto</dt><dd data-sum-net>–</dd>
              <dt>USt.</dt><dd data-sum-tax>–</dd>
              <dt class="strong">Brutto</dt><dd class="strong" data-sum-gross>–</dd>
            </dl>
          </div>
        </section>`}
    <div class="form-actions sticky"><button class="btn primary">Speichern</button></div>`;

  return html`<form method="post" action="${action}" class="purchase-form${opts.preview ? ' with-preview' : ''}" data-purchase-form
    data-count-check data-count-accounts="paid_account_id" data-count-date="paid_at">
    ${csrfField(c)}
    <div class="purchase-fields">${fields}</div>
    ${opts.preview ? html`<aside class="purchase-preview">${opts.preview}</aside>` : ''}
  </form>`;
}

/* ---------------- Anzeige ---------------- */

/** Vorschau des Belegs: PDF/Bild eingebettet, XML als aufbereitete Übersicht auf der Detailseite */
export function previewFrame(p: Purchase): SafeHtml {
  if (!p.file_path) return html``;
  const src = `/purchases/${p.id}/file?inline=1`;
  if (p.file_mime === 'application/pdf') {
    return html`<div class="card flush preview-card">
      <iframe src="${src}" title="Beleg ${p.file_name}" class="preview-frame"></iframe>
      <p class="preview-foot small"><a href="${src}" target="_blank" rel="noopener">${p.file_name} in neuem Tab öffnen</a></p>
    </div>`;
  }
  if (p.file_mime.startsWith('image/')) {
    return html`<div class="card flush preview-card">
      <a href="${src}" target="_blank" rel="noopener"><img src="${src}" alt="Beleg ${p.file_name}" class="preview-img"></a>
    </div>`;
  }
  return html`<div class="card preview-card"><p class="muted small">XML-Datei: <a href="/purchases/${p.id}/file">${p.file_name}</a> – die Inhalte stehen in der Übersicht.</p></div>`;
}

export function taxSummary(taxes: PurchaseTax[], p: Pick<Purchase, 'net_total' | 'tax_total' | 'gross_total' | 'prepaid_total' | 'currency' | 'is_credit'>): SafeHtml {
  const cur = (n: number) => (p.currency === 'EUR' ? formatMoney(n) : `${formatAmount(n)} ${p.currency}`);
  const catLabel: Record<string, string> = { S: '', Z: 'Nullsatz', E: 'steuerfrei', AE: '§ 13b – Steuerschuld beim Empfänger', K: 'innergem. Lieferung', G: 'Ausfuhr', O: 'nicht steuerbar' };
  return html`<section class="card flush">
    <table class="table">
      <thead><tr><th>Steuersatz</th><th class="right">Netto</th><th class="right">USt.</th><th class="right">Brutto</th></tr></thead>
      <tbody>${taxes.map((t) => html`<tr>
        <td>${formatRate(t.rate)}${catLabel[t.category] ? html` <span class="muted small">${catLabel[t.category]}</span>` : ''}</td>
        <td class="right num">${cur(t.basis)}</td><td class="right num">${cur(t.tax)}</td><td class="right num">${cur(t.basis + t.tax)}</td>
      </tr>`)}</tbody>
    </table>
    <dl class="totals static">
      <dt>Netto</dt><dd>${cur(p.net_total)}</dd>
      <dt>USt.</dt><dd>${cur(p.tax_total)}</dd>
      <dt class="${p.prepaid_total ? '' : 'strong'}">${p.is_credit ? 'Gutschrift' : 'Brutto'}</dt><dd class="${p.prepaid_total ? '' : 'strong'}">${cur(p.gross_total)}</dd>
      ${p.prepaid_total ? html`<dt>Bereits gezahlt</dt><dd>−${cur(p.prepaid_total)}</dd><dt class="strong">Zahlbetrag</dt><dd class="strong">${cur(payable(p))}</dd>` : ''}
    </dl>
  </section>`;
}

/** Aufbereitung der E-Rechnung: Hinweise, Positionen, Bemerkungen */
export function einvoiceDetails(info: EInvoiceInfo): SafeHtml {
  return html`
    ${info.warnings.length
      ? html`<div class="notice"><strong>Hinweise zur E-Rechnung</strong><ul class="tight">${info.warnings.map((w) => html`<li>${w}</li>`)}</ul></div>`
      : ''}
    ${info.lines.length
      ? html`<h2 class="section-title">Positionen laut E-Rechnung <span class="count">${info.lines.length}</span></h2>
        <section class="card flush"><table class="table">
          <thead><tr><th>Pos.</th><th>Bezeichnung</th><th class="right">Menge</th><th class="right">Einzelpreis</th><th class="right">USt.</th><th class="right">Netto</th></tr></thead>
          <tbody>${info.lines.map((l) => html`<tr>
            <td class="mono">${l.id}</td><td>${l.name}</td>
            <td class="right num">${formatQuantity(l.quantity)} ${unitShort(l.unit) || l.unit}</td>
            <td class="right num">${l.unitPrice === null ? '' : formatAmount(l.unitPrice)}</td>
            <td class="right num">${l.rate === null ? '' : formatRate(l.rate)}</td>
            <td class="right num">${formatAmount(l.net)}</td></tr>`)}</tbody>
        </table></section>`
      : ''}
    ${info.notes.length || info.paymentTerms
      ? html`<section class="card"><h2>Bemerkungen</h2>
          ${info.notes.map((n) => html`<p class="notes-block">${n}</p>`)}
          ${info.paymentTerms ? html`<p class="notes-block"><strong>Zahlungsbedingungen:</strong> ${info.paymentTerms}</p>` : ''}
        </section>`
      : ''}`;
}

export { raw };
