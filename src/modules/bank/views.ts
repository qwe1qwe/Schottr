import { all } from '../../db/index.ts';
import { formatDate } from '../../lib/dates.ts';
import { html, type SafeHtml } from '../../lib/html.ts';
import { formatAmount, formatMoney } from '../../lib/money.ts';
import { csrfField } from '../../views/layout.ts';
import type { Ctx, Tenant } from '../../types.ts';
import { cashbookEnabled, linkedEntry } from '../cashbook/repo.ts';
import { entryBankStatus, openTxOf, rankTx, txOption } from './repo.ts';

/**
 * Abgleich mit dem Kontoumsatz – als Karte an Buchung, Rechnung und Eingangsrechnung.
 * Zeigt den zugeordneten Umsatz (mit weiteren Buchungen desselben Umsatzes), sonst die Auswahl
 * offener Umsätze und die Möglichkeit, die Buchung als Ausnahme ohne Kontoumsatz zu markieren.
 */

const money = (v: number) => html`<span class="num ${v < 0 ? 'neg-amount' : ''}">${formatMoney(v)}</span>`;

function hidden(fields: Record<string, string | number>): SafeHtml {
  return html`${Object.entries(fields).map(([k, v]) => html`<input type="hidden" name="${k}" value="${v}">`)}`;
}

/** Karte für eine Buchung (auch die Zahlung einer Rechnung) – leer bei Bargeldkassen */
export async function entryBankCard(c: Ctx, t: Tenant, entry: { id: number; account_id: number; entry_date: string; amount: number; source: string }, back: string): Promise<SafeHtml> {
  if (!cashbookEnabled(t)) return html``;
  const st = await entryBankStatus(t, entry);
  if (!st) return html``;
  const locked = !!t.cashbook_locked_until && entry.entry_date <= t.cashbook_locked_until;
  if (st.tx) {
    const x = st.tx;
    return html`<section class="card bank-card">
      <h2>Kontoumsatz</h2>
      <p><a href="/cashbook/bank/tx/${x.id}">${formatDate(x.booking_date)} · ${x.remote_name || x.booking_text || 'Umsatz'}</a> · ${money(x.amount)}
        <span class="muted small">${x.purpose}</span></p>
      ${st.siblings.length ? html`<p class="muted small">Zusammen mit: ${st.siblings.map((s, i) => html`${i ? ', ' : ''}<a href="${s.href}">${s.label}</a> (${formatMoney(s.amount)})`)}</p>` : ''}
      ${x.remaining ? html`<p class="small danger-text">Vom Umsatz sind noch ${formatMoney(x.remaining)} nicht zugeordnet.</p>` : ''}
      <form method="post" action="/cashbook/bank/tx/${x.id}/unlink" class="inline" data-confirm="Zuordnung lösen? Die Buchung bleibt im Kassenbuch stehen.">
        ${csrfField(c)}${hidden({ entry_id: entry.id, back })}<button class="btn small ghost">Zuordnung lösen</button></form>
    </section>`;
  }
  if (st.exemption) {
    return html`<section class="card bank-card">
      <h2>Kontoumsatz</h2>
      <p class="muted">Ausnahme – ohne Kontoumsatz${st.exemption.reason ? html`: ${st.exemption.reason}` : ''}.</p>
      <form method="post" action="/cashbook/bank/entries/${entry.id}/exempt" class="inline">${csrfField(c)}${hidden({ remove: 1, back })}
        <button class="btn small ghost">Ausnahme aufheben</button></form>
    </section>`;
  }
  if (Number(entry.amount) === 0 || locked) return html``;
  const list = rankTx(await openTxOf(t.id, [entry.account_id]), Number(entry.amount), entry.entry_date).slice(0, 80);
  if (!list.length && !st.required) return html``;
  return html`<section class="card bank-card">
    <h2>Kontoumsatz</h2>
    ${st.required ? html`<p class="small danger-text">Diese Buchung auf „${st.account.name}“ hat noch keinen Kontoumsatz.</p>` : ''}
    ${list.length
      ? html`<form method="post" action="/cashbook/bank/entries/${entry.id}/link" class="inline-form">${csrfField(c)}${hidden({ back })}
          <select name="tx_id" aria-label="Kontoumsatz">${list.map((x) => html`<option value="${x.id}">${txOption(x)}${x.remaining === Number(entry.amount) ? ' · ✓ Betrag passt' : ''}</option>`)}</select>
          <button class="btn small">Zuordnen</button></form>
        <p class="muted small">Ein Umsatz kann mehrere Buchungen umfassen – was danach fehlt, bleibt am Umsatz als Rest offen.</p>`
      : html`<p class="muted small">Kein offener Kontoumsatz auf diesem Konto. <a href="/cashbook/bank/${entry.account_id}">Umsätze abrufen</a></p>`}
    <form method="post" action="/cashbook/bank/entries/${entry.id}/exempt" class="inline-form">${csrfField(c)}${hidden({ back })}
      <input name="reason" maxlength="200" placeholder="Grund, z. B. vor Umstellung, Verrechnung" aria-label="Grund der Ausnahme">
      <button class="btn small ghost">Ohne Kontoumsatz (Ausnahme)</button></form>
  </section>`;
}

/**
 * Rechnung bzw. Eingangsrechnung: mit Zahlung auf einem Bankkonto → Karte der Zahlung;
 * ohne Zahlung → „Mit Kontoumsatz bezahlen“ (passende offene Umsätze aller Bankkonten).
 */
export async function payWithBankCard(c: Ctx, t: Tenant, kind: 'invoice' | 'purchase', id: number, due: number, credit: boolean, date: string | null, back: string): Promise<SafeHtml> {
  if (!cashbookEnabled(t)) return html``;
  const payment = await linkedEntry(kind, id);
  if (payment) return entryBankCard(c, t, payment, back);
  const banks = (await all<{ id: number }>("SELECT id FROM cash_accounts WHERE tenant_id = ? AND kind = 'bank' AND archived = 0", t.id)).map((a) => a.id);
  const signed = kind === 'invoice' || credit ? due : -due;
  const list = rankTx(await openTxOf(t.id, banks), signed, date ?? '').slice(0, 80);
  if (!list.length) return html``;
  return html`<section class="card bank-card">
    <h2>Mit Kontoumsatz bezahlen</h2>
    <form method="post" action="/cashbook/bank/pay" class="inline-form">${csrfField(c)}${hidden({ kind, id, back })}
      <select name="tx_id" aria-label="Kontoumsatz">${list.map((x) => html`<option value="${x.id}">${txOption(x)}${x.remaining === signed ? ' · ✓ Betrag passt' : ''}</option>`)}</select>
      <label>Betrag (€) <input name="amount" class="num amount-input" inputmode="decimal" value="${formatAmount(due).replace(/\./g, '')}" aria-label="Betrag"></label>
      <button class="btn small">Als bezahlt buchen</button></form>
    <p class="muted small">Bucht die Zahlung mit dem Tag des Umsatzes. Ein Umsatz kann mehrere Rechnungen bezahlen; bei Skonto bzw. Teilzahlung den tatsächlichen Betrag eintragen.</p>
  </section>`;
}
