import { html, raw, selected, type SafeHtml } from '../../lib/html.ts';
import { formatDate, today } from '../../lib/dates.ts';
import { formatAmount, formatMoney } from '../../lib/money.ts';
import { UNITS } from '../../lib/units.ts';
import { VAT_RATES, type TaxMode } from '../../lib/calc.ts';
import { badge, csrfField } from '../../views/layout.ts';
import { INVOICE_TYPES, SELECTABLE_TYPES } from '../../einvoice/model.ts';
import type { Ctx } from '../../types.ts';
import type { Contact } from '../contacts.ts';
import type { Article } from '../articles.ts';
import { proofPicker, type Proof } from '../proofs.ts';
import type { DraftInput, Kind } from './repo.ts';

export const KIND = {
  quote: { path: '/quotes', one: 'Angebot', many: 'Angebote' },
  invoice: { path: '/invoices', one: 'Rechnung', many: 'Rechnungen' },
} as const;

export const TAX_MODES: { value: TaxMode; label: string }[] = [
  { value: 'standard', label: 'Regelbesteuerung (19 % / 7 %)' },
  { value: 'small_business', label: 'Kleinunternehmer (§ 19 UStG)' },
  { value: 'reverse_charge', label: 'Reverse Charge (§ 13b UStG)' },
  { value: 'exempt', label: 'Steuerfrei (mit Begründung)' },
];

/** Status inkl. „überfällig“ für die Anzeige. */
export function displayStatus(d: { kind: string; status: string; due_date: string | null }): string {
  if (d.kind === 'invoice' && d.status === 'open' && d.due_date && d.due_date < today()) return 'overdue';
  return d.status;
}

const signed = (d: { type_code: string; gross_total: number }) => (d.type_code === '381' ? -d.gross_total : d.gross_total);

export function documentTable(rows: any[], kind: Kind, showContact = true): SafeHtml {
  const base = KIND[kind].path;
  return html`<div class="card flush"><table class="table">
    <thead><tr>
      <th>Nr.</th><th>Datum</th>${showContact ? html`<th>Kunde</th>` : ''}<th>Betreff</th>
      <th>Status</th><th class="right">Brutto</th>
    </tr></thead>
    <tbody>${rows.map(
      (d) => html`<tr class="rowlink" data-href="${base}/${d.id}">
        <td class="mono"><a href="${base}/${d.id}">${d.number ?? 'Entwurf'}</a>${d.type_code === '381' ? html` <span class="tag">Storno</span>` : ['875', '876', '877'].includes(d.type_code) ? html` <span class="tag info">${INVOICE_TYPES[d.type_code as '875']}</span>` : ''}</td>
        <td>${formatDate(d.issue_date)}</td>
        ${showContact ? html`<td>${d.contact_label ?? ''}</td>` : ''}
        <td class="truncate">${d.subject}</td>
        <td>${badge(displayStatus(d))}${d.dunning_level && d.status === 'open' ? html` <span class="tag warn">${['', 'Erinnert', '1. Mahnung', '2. Mahnung'][d.dunning_level] ?? 'gemahnt'}</span>` : ''}</td>
        <td class="right num">${formatMoney(signed(d))}</td>
      </tr>`,
    )}</tbody>
  </table></div>`;
}

function articleLabel(a: Article): string {
  return a.number ? `${a.number} – ${a.title}` : a.title;
}

function itemRow(it?: DraftInput['items'][number]): SafeHtml {
  const qty = it ? String(it.quantity / 1000).replace('.', ',') : '1';
  const price = it ? formatAmount(it.unitPrice).replace(/\./g, '') : '';
  return html`<tr class="item">
    <td class="drag" aria-hidden="true">⋮⋮</td>
    <td class="item-text">
      <input type="hidden" name="item_article[]" value="${it?.articleNumber ?? ''}">
      <span class="art-no" title="Klicken, um den Artikelbezug zu lösen" ${it?.articleNumber ? '' : raw('hidden')}>Art.-Nr. <span>${it?.articleNumber ?? ''}</span> ×</span>
      <input name="item_title[]" value="${it?.title ?? ''}" placeholder="Bezeichnung" maxlength="300" aria-label="Bezeichnung">
      <textarea name="item_description[]" rows="1" placeholder="Beschreibung (optional)" aria-label="Beschreibung">${it?.description ?? ''}</textarea>
    </td>
    <td data-label="Menge"><input name="item_quantity[]" value="${qty}" inputmode="decimal" class="num" aria-label="Menge"></td>
    <td data-label="Einheit"><select name="item_unit[]" aria-label="Einheit">${UNITS.map((u) => html`<option value="${u.code}"${selected(u.code, it?.unit ?? 'C62')}>${u.short}</option>`)}</select></td>
    <td data-label="Einzelpreis €"><input name="item_price[]" value="${price}" inputmode="decimal" class="num" placeholder="0,00" aria-label="Einzelpreis netto"></td>
    <td class="vat-col" data-label="USt."><select name="item_vat[]" aria-label="USt.">${VAT_RATES.map((r) => html`<option value="${r}"${selected(r, it?.vatRate ?? 1900)}>${r / 100} %</option>`)}</select></td>
    <td class="right num line-total" data-label="Gesamt €">–</td>
    <td class="remove-cell"><button type="button" class="icon remove" title="Position entfernen" aria-label="Position entfernen">×</button></td>
  </tr>`;
}

type PrepaymentOption = { id: number; contact_id: number; number: string; type_code: string; issue_date: string; net_total: number; tax_total: number; gross_total: number };

export function documentForm(
  c: Ctx, kind: Kind, action: string, d: DraftInput, contacts: Contact[], articles: Article[] = [], prepayments: PrepaymentOption[] = [],
  proofs: Proof[] = [],
): SafeHtml {
  const periodMode = !!(d.service_from || d.service_to);
  return html`
  <form method="post" action="${action}" class="doc-form" data-doc-form>
    ${csrfField(c)}
    <section class="card">
      <div class="grid-3">
        <label class="span-2">Kunde
          <select name="contact_id" required>
            <option value="">– Kunde wählen –</option>
            ${contacts.map((ct) => html`<option value="${ct.id}" data-leitweg="${ct.leitweg_id}"${selected(ct.id, d.contact_id)}>${ct.company || ct.name}${ct.city ? ` (${ct.city})` : ''}</option>`)}
          </select>
          ${contacts.length ? '' : html`<small><a href="/contacts/new?kind=customer">Zuerst einen Kunden anlegen</a></small>`}
        </label>
        <label>${kind === 'quote' ? 'Angebotsdatum' : 'Rechnungsdatum'} <input type="date" name="issue_date" value="${d.issue_date}" required></label>
        <label class="span-2">Betreff <input name="subject" value="${d.subject}" maxlength="200" placeholder="z. B. Projekt oder Auftrag"></label>
        ${kind === 'quote'
          ? html`<label>Gültig bis <input type="date" name="valid_until" value="${d.valid_until ?? ''}"></label>`
          : html`<label>Fällig am (netto) <input type="date" name="due_date" value="${d.due_date ?? ''}"></label>`}
        ${kind === 'invoice'
          ? html`
            ${d.type_code === '381'
              ? html`<label>Rechnungsart <input value="Stornorechnung (381)" disabled></label>`
              : html`<label>Rechnungsart
                  <select name="type_code" data-type-code>${SELECTABLE_TYPES.map((tc) => html`<option value="${tc}"${selected(tc, d.type_code)}>${INVOICE_TYPES[tc]} (${tc})</option>`)}</select>
                </label>`}
            <label>Skonto % <input name="skonto_percent" class="num" inputmode="decimal" value="${d.skonto_percent ? formatAmount(d.skonto_percent).replace(/,00$/, '') : ''}" placeholder="z. B. 2"></label>
            <label>Skonto bei Zahlung binnen … Tagen <input name="skonto_days" type="number" min="0" max="365" value="${d.skonto_days || ''}" placeholder="z. B. 10"></label>`
          : ''}
      </div>
      ${kind === 'invoice'
        ? html`<div class="grid-3 service" data-service>
            <fieldset class="span-3 inline-radio">
              <legend>Leistung</legend>
              <label class="check"><input type="radio" name="service_mode" value="date"${periodMode ? '' : raw(' checked')}> Leistungsdatum</label>
              <label class="check"><input type="radio" name="service_mode" value="period"${periodMode ? raw(' checked') : ''}> Leistungszeitraum</label>
            </fieldset>
            <label data-mode="date">Leistungsdatum <input type="date" name="service_date" value="${d.service_date ?? ''}"></label>
            <label data-mode="period">von <input type="date" name="service_from" value="${d.service_from ?? ''}"></label>
            <label data-mode="period">bis <input type="date" name="service_to" value="${d.service_to ?? ''}"></label>
          </div>`
        : ''}
      <details class="more"${d.order_reference || d.buyer_reference || d.tax_mode !== 'standard' ? raw(' open') : ''}>
        <summary>Weitere Angaben</summary>
        <div class="grid-3">
          <label>Steuer
            <select name="tax_mode" data-tax-mode>${TAX_MODES.map((m) => html`<option value="${m.value}"${selected(m.value, d.tax_mode)}>${m.label}</option>`)}</select>
          </label>
          <label data-exempt>Grund der Steuerbefreiung <input name="exemption_reason" value="${d.exemption_reason}" maxlength="300" placeholder="z. B. Steuerfrei gemäß § 4 Nr. 21 UStG"></label>
          <label>Bestellnummer des Kunden <input name="order_reference" value="${d.order_reference}" maxlength="100"></label>
          ${kind === 'invoice'
            ? html`<label>Käuferreferenz / Leitweg-ID <input name="buyer_reference" value="${d.buyer_reference}" maxlength="100" data-buyer-ref>
                <small class="muted">Pflicht bei öffentlichen Auftraggebern</small></label>`
            : ''}
        </div>
      </details>
    </section>

    ${kind === 'invoice' && d.type_code !== '381'
      ? html`<section class="card" data-prepayments>
          <h2>Abzuziehende Teilrechnungen</h2>
          <p class="muted small">Bei Teilschluss- und Schlussrechnungen werden bereits gestellte Teilrechnungen mit ihren Steuerbeträgen ausgewiesen und abgezogen (§ 14 Abs. 5 UStG).</p>
          ${prepayments.length
            ? html`<ul class="plain prepayment-list">${prepayments.map((p) => html`<li data-contact="${p.contact_id}">
                <label class="check"><input type="checkbox" name="prepayment_ids[]" value="${p.id}"${d.prepayment_ids.includes(p.id) ? raw(' checked') : ''}>
                  <span><strong>${INVOICE_TYPES[p.type_code as keyof typeof INVOICE_TYPES]} ${p.number}</strong> vom ${formatDate(p.issue_date)}
                  <span class="muted">· netto ${formatMoney(p.net_total)} · USt. ${formatMoney(p.tax_total)} · brutto ${formatMoney(p.gross_total)}</span></span>
                </label></li>`)}</ul>
              <p class="muted small" data-prepayments-empty hidden>Für diesen Kunden gibt es keine offenen Teilrechnungen.</p>`
            : html`<p class="muted small">Es gibt noch keine festgeschriebenen Teilrechnungen, die abgezogen werden könnten.</p>`}
        </section>`
      : ''}

    <section class="card">
      <label>Einleitungstext <textarea name="intro" rows="2">${d.intro}</textarea></label>
    </section>

    <section class="card flush">
      <table class="table items" data-items>
        <thead><tr><th></th><th>Bezeichnung</th><th class="w-qty">Menge</th><th class="w-unit">Einheit</th><th class="w-price">Einzelpreis €</th><th class="vat-col w-vat">USt.</th><th class="right w-total">Gesamt €</th><th></th></tr></thead>
        <tbody>${d.items.length ? d.items.map((it) => itemRow(it)) : itemRow()}</tbody>
      </table>
      <template data-item-template>${itemRow()}</template>
      <div class="items-foot">
        <div class="add-items">
          <button type="button" class="btn ghost" data-add-item>+ Freie Position</button>
          ${articles.length
            ? html`<div class="article-picker">
                <input list="article-list" class="article-search" data-article-search placeholder="Artikel suchen (Nr. oder Bezeichnung) …" aria-label="Artikel suchen" autocomplete="off">
                <button type="button" class="btn" data-article-insert>Artikel einfügen</button>
                <small class="muted" data-article-msg hidden>Kein passender Artikel gefunden.</small>
              </div>
              <datalist id="article-list">${articles.map((a) => html`<option value="${articleLabel(a)}"></option>`)}</datalist>
              <script type="application/json" id="article-data">${raw(JSON.stringify(articles.map((a) => ({
                label: articleLabel(a), number: a.number, title: a.title, description: a.description, unit: a.unit,
                price: formatAmount(a.unit_price).replace(/\./g, ''), vat: a.vat_rate,
              }))).replace(/</g, '\\u003c'))}</script>`
            : html`<a class="small muted" href="/articles">Artikelstamm anlegen</a>`}
        </div>
        <dl class="totals" data-totals>
          <dt>Netto</dt><dd data-net>–</dd>
          <dt>USt.</dt><dd data-tax>–</dd>
          <dt class="strong">Gesamt</dt><dd class="strong" data-gross>–</dd>
        </dl>
      </div>
    </section>

    ${kind === 'invoice' && d.type_code !== '381' ? proofPicker(proofs, d.proof_ids) : ''}

    <section class="card">
      <label>Schlusstext <textarea name="outro" rows="2">${d.outro}</textarea></label>
    </section>

    <div class="form-actions sticky">
      <button class="btn primary">Speichern</button>
    </div>
  </form>`;
}
