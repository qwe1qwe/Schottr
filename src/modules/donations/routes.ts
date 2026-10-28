import { all, one, tx } from '../../db/index.ts';
import { accountsOf, assertOpen, bookLinked, cashbookEnabled, linkedEntry, unlink, type CashAccount } from '../cashbook/repo.ts';
import { accountSelect } from '../cashbook/routes.ts';
import { audit } from '../../lib/audit.ts';
import { formatDate, today } from '../../lib/dates.ts';
import { checked, html, selected, type SafeHtml } from '../../lib/html.ts';
import { attachment, idParam, notFound, readForm, redirectWith, str, tenantOf, userOf, UserError } from '../../lib/http.ts';
import { formatAmount, formatMoney } from '../../lib/money.ts';
import { csrfField, empty, page } from '../../views/layout.ts';
import type { App, Ctx, Module, Tenant } from '../../types.ts';
import { contactLabel, getContact, type Contact } from '../contacts.ts';
import {
  cancelReceipt, confirmable, createDonation, deleteDonation, getDonation, getReceipt, issueCollective, issueSingle,
  openMoneyDonations, parseDonation, RECEIPT_COLUMNS, updateDonation, type Donation, type DonationInput, type Receipt,
} from './repo.ts';
import { DONATION_KINDS, noticeValidUntil, receiptProblems, TEXT, type ReceiptData } from './receipt.ts';

/**
 * Spenden und Mitgliedsbeiträge (ideeller Bereich) erfassen und Zuwendungsbestätigungen
 * nach amtlichem Muster ausstellen – nur für gemeinnützige Mandanten.
 */
function npoTenant(c: Ctx): Tenant {
  const t = tenantOf(c);
  if (!t.nonprofit) throw new UserError('Spenden und Zuwendungsbestätigungen gibt es nur für gemeinnützige Mandanten (Einstellungen → Organisation).');
  return t;
}

const RECEIPT_KIND_LABEL = { single: 'Einzelbestätigung', collective: 'Sammelbestätigung', goods: 'Sachzuwendung' } as const;

function postButton(c: Ctx, action: string, label: string, cls = 'btn', confirm?: string): SafeHtml {
  return html`<form method="post" action="${action}" class="inline" ${confirm ? html`data-confirm="${confirm}"` : ''}>${csrfField(c)}<button class="${cls}">${label}</button></form>`;
}

function donationStatus(t: Tenant, d: Pick<Donation, 'receipt_id' | 'kind'> & { receipt_number?: string | null }): SafeHtml {
  if (d.receipt_id) return html`<a href="/donations/receipts/${d.receipt_id}" class="badge badge-paid">${d.receipt_number ?? 'Bestätigt'}</a>`;
  if (!confirmable(t, d)) return html`<span class="badge badge-draft" title="Mitgliedsbeiträge sind nicht abziehbar">ohne Bestätigung</span>`;
  return html`<span class="badge badge-todo">Unbestätigt</span>`;
}

export function donationTable(t: Tenant, rows: (Donation & { contact_label?: string; receipt_number?: string | null })[], showContact = true): SafeHtml {
  return html`<div class="card flush"><table class="table">
    <thead><tr><th>Datum</th>${showContact ? html`<th>Zuwendender</th>` : ''}<th>Art</th><th>Bestätigung</th><th class="right">Betrag</th></tr></thead>
    <tbody>${rows.map((d) => html`<tr class="rowlink" data-href="/donations/${d.id}">
      <td><a href="/donations/${d.id}">${formatDate(d.donation_date)}</a></td>
      ${showContact ? html`<td>${d.contact_label ?? ''}</td>` : ''}
      <td>${DONATION_KINDS[d.kind]}${d.waiver ? html` <span class="tag info">Aufwandsverzicht</span>` : ''}${d.note ? html`<div class="muted small truncate">${d.note}</div>` : ''}</td>
      <td>${donationStatus(t, d)}</td>
      <td class="right num">${formatMoney(d.amount)}</td>
    </tr>`)}</tbody></table></div>`;
}

/** Hinweis, wenn Angaben für Bestätigungen fehlen oder der Bescheid bald abläuft */
function settingsNotice(t: Tenant): SafeHtml {
  const problems = receiptProblems(t, today());
  if (problems.length) {
    return html`<div class="notice"><strong>Für Zuwendungsbestätigungen fehlt noch etwas:</strong>
      <ul>${problems.map((p) => html`<li>${p}</li>`)}</ul><a href="/settings#zuwendungen">Zu den Einstellungen</a></div>`;
  }
  const valid = noticeValidUntil(t);
  if (valid && valid < addMonths(today(), 6)) {
    return html`<div class="notice soft">Bestätigungen mit dem Bescheid vom ${formatDate(t.npo_notice_date)} werden nur bis ${formatDate(valid)} anerkannt (§ 63 Abs. 5 AO) – rechtzeitig einen neuen Bescheid beantragen.</div>`;
  }
  return html``;
}

function addMonths(iso: string, months: number): string {
  const d = new Date(`${iso}T12:00:00Z`);
  d.setUTCMonth(d.getUTCMonth() + months);
  return d.toISOString().slice(0, 10);
}

async function donorOptions(tenantId: number, includeId = 0): Promise<Contact[]> {
  return all<Contact>(
    `SELECT * FROM contacts WHERE tenant_id = ? AND (archived = 0 OR id = ?) ORDER BY COALESCE(NULLIF(company, ''), name)`,
    tenantId, includeId,
  );
}

function donationForm(c: Ctx, t: Tenant, action: string, d: Partial<DonationInput>, contacts: Contact[], cash: { accounts: CashAccount[]; selected?: number | null } = { accounts: [] }): SafeHtml {
  const kind = d.kind ?? 'money';
  return html`<form method="post" action="${action}" class="card stack" data-donation-form>
    ${csrfField(c)}
    <div class="grid-2">
      <label class="span-2">Zuwendender
        <select name="contact_id" required>
          <option value="">– Adresse wählen –</option>
          ${contacts.map((ct) => html`<option value="${ct.id}"${selected(ct.id, d.contact_id)}>${contactLabel(ct)}${ct.city ? ` (${ct.city})` : ''}</option>`)}
        </select>
        <small><a href="/contacts/new">Neue Adresse anlegen</a> – auf die Bestätigung kommen Name und Anschrift.</small>
      </label>
      <fieldset class="span-2 inline-radio">
        <legend>Art</legend>
        ${(['money', 'membership', 'goods'] as const).map((k) => html`<label class="check"><input type="radio" name="kind" value="${k}"${checked(kind === k)}> ${DONATION_KINDS[k]}</label>`)}
      </fieldset>
      <label>Datum der Zuwendung <input type="date" name="donation_date" value="${d.donation_date ?? today()}" max="${today()}" required></label>
      <label><span data-kind-show="money membership">Betrag (€)</span><span data-kind-show="goods">Wert der Sachzuwendung (€)</span>
        <input name="amount" class="num" inputmode="decimal" required value="${d.amount ? formatAmount(d.amount).replace(/\./g, '') : ''}" placeholder="0,00"></label>
      ${cash.accounts.length
        ? html`<label data-kind-show="money membership">Eingegangen auf
            ${accountSelect(cash.accounts, cash.selected, 'account_id', { optional: '– noch keinem Konto zuordnen –' })}
            <small class="muted">bucht den Eingang im Kassenbuch</small></label><span data-kind-show="money membership"></span>`
        : ''}
      <label class="check span-2" data-kind-show="money membership"><input type="checkbox" name="waiver" value="1"${checked(d.waiver)}>
        Verzicht auf Erstattung von Aufwendungen (Aufwandsspende) – nur bei einem vorher vereinbarten Erstattungsanspruch</label>
      <div class="span-2 stack" data-kind-show="goods">
        <label>Genaue Bezeichnung der Sachzuwendung
          <textarea name="description" rows="2" maxlength="1000" placeholder="mit Alter, Zustand, Kaufpreis usw.">${d.description ?? ''}</textarea></label>
        <fieldset class="stack bare-fieldset">
          <legend class="small muted">Herkunft</legend>
          <label class="check"><input type="radio" name="goods_origin" value="private"${checked(d.goods_origin === 'private')}> aus dem Privatvermögen</label>
          <label class="check"><input type="radio" name="goods_origin" value="business"${checked(d.goods_origin === 'business')}> aus dem Betriebsvermögen (Entnahmewert)</label>
          <label class="check"><input type="radio" name="goods_origin" value="unknown"${checked(d.goods_origin === 'unknown')}> keine Angabe trotz Aufforderung</label>
        </fieldset>
        <label class="check"><input type="checkbox" name="goods_documents" value="1"${checked(d.goods_documents)}> Unterlagen zur Wertermittlung (Rechnung, Gutachten) liegen vor</label>
      </div>
      <label class="span-2">Notiz (intern) <input name="note" maxlength="300" value="${d.note ?? ''}" placeholder="z. B. Verwendungszweck der Überweisung"></label>
    </div>
    ${!t.npo_membership_deductible
      ? html`<p class="muted small" data-kind-show="membership">Mitgliedsbeiträge sind bei diesem Verein nicht abziehbar (§ 10b Abs. 1 Satz 8 EStG) – sie werden erfasst, aber nicht bestätigt.</p>`
      : ''}
    <div class="form-actions"><button class="btn primary">Speichern</button></div>
  </form>`;
}

function receiptTable(rows: (Receipt & { contact_label: string })[]): SafeHtml {
  return html`<div class="card flush"><table class="table">
    <thead><tr><th>Nr.</th><th>Datum</th><th>Zuwendender</th><th>Art</th><th>Status</th><th class="right">Betrag</th></tr></thead>
    <tbody>${rows.map((r) => html`<tr class="rowlink" data-href="/donations/receipts/${r.id}">
      <td class="mono"><a href="/donations/receipts/${r.id}">${r.number}</a></td>
      <td>${formatDate(r.issue_date)}</td>
      <td>${r.contact_label}</td>
      <td>${RECEIPT_KIND_LABEL[r.kind]}</td>
      <td>${r.status === 'cancelled' ? html`<span class="badge badge-cancelled">Storniert</span>` : html`<span class="badge badge-settled">Ausgestellt</span>`}</td>
      <td class="right num">${formatMoney(r.total)}</td>
    </tr>`)}</tbody></table></div>`;
}

/** Konten fürs Formular (nur mit Kassenbuch) und das bisher gebuchte Konto */
async function cashOptions(t: Tenant, donationId?: number) {
  if (!cashbookEnabled(t)) return { accounts: [] };
  const entry = donationId ? await linkedEntry('donation', donationId) : undefined;
  return { accounts: await accountsOf(t.id), selected: entry?.account_id ?? null };
}

/** Geld- und Beitragseingänge im Kassenbuch buchen bzw. entfernen */
async function syncCash(t: Tenant, donationId: number, d: DonationInput, accountId: number, userId: number) {
  if (!cashbookEnabled(t)) return;
  if (accountId && d.kind !== 'goods') {
    await bookLinked(t, 'donation', donationId, { account_id: accountId, entry_date: d.donation_date, amount: d.amount, text: d.note }, userId);
  } else {
    await unlink(t, 'donation', donationId);
  }
}

const yearOf = (q: string | undefined, fallback: number) => (q && /^\d{4}$/.test(q) ? Number(q) : fallback);

function register(app: App) {
  app.get('/donations', async (c) => {
    const t = npoTenant(c);
    const current = Number(today().slice(0, 4));
    const year = yearOf(c.req.query('year'), current);
    const status = c.req.query('status') ?? '';
    const years = (await all<{ y: string }>(
      'SELECT DISTINCT substr(donation_date, 1, 4) y FROM donations WHERE tenant_id = ? ORDER BY y DESC', t.id,
    )).map((r) => Number(r.y));
    const yearList = [...new Set([current, year, ...years])].sort((a, b) => b - a);
    let where = 'd.tenant_id = ? AND substr(d.donation_date, 1, 4) = ?';
    if (status === 'open') where += ' AND d.receipt_id IS NULL';
    if (status === 'confirmed') where += ' AND d.receipt_id IS NOT NULL';
    const rows = await all<Donation & { contact_label: string; receipt_number: string | null }>(
      `SELECT d.*, COALESCE(NULLIF(c.company, ''), c.name) contact_label, r.number receipt_number
       FROM donations d JOIN contacts c ON c.id = d.contact_id LEFT JOIN donation_receipts r ON r.id = d.receipt_id
       WHERE ${where} ORDER BY d.donation_date DESC, d.id DESC LIMIT 1000`,
      t.id, String(year),
    );
    const sum = (k?: string) => rows.filter((r) => !k || r.kind === k).reduce((a, r) => a + r.amount, 0);
    const open = await openMoneyDonations(t, year);
    const openDonors = new Set(open.map((d) => d.contact_id)).size;
    const link = (st: string) => `/donations?year=${year}${st ? `&status=${st}` : ''}`;
    return page(c, {
      title: 'Spenden',
      actions: html`<a class="btn" href="/donations/receipts">Bestätigungen</a><a class="btn primary" href="/donations/new">Zuwendung erfassen</a>`,
      body: html`
      ${settingsNotice(t)}
      <form class="toolbar" method="get">
        <div class="tabs">${[['', 'Alle'], ['open', 'Unbestätigt'], ['confirmed', 'Bestätigt']].map(([v, l]) =>
          html`<a href="${link(v)}" class="${status === v ? 'active' : ''}">${l}</a>`)}</div>
        <select name="year" class="year-select" data-autosubmit aria-label="Jahr">${yearList.map((y) => html`<option value="${y}"${selected(y, year)}>${y}</option>`)}</select>
        ${status ? html`<input type="hidden" name="status" value="${status}">` : ''}
        <noscript><button class="btn">OK</button></noscript>
      </form>
      <div class="stats">
        <div class="stat"><span>Geldspenden ${year}</span><strong>${formatMoney(sum('money'))}</strong><small>${rows.filter((r) => r.kind === 'money').length} Zuwendung(en)</small></div>
        <div class="stat"><span>Mitgliedsbeiträge ${year}</span><strong>${formatMoney(sum('membership'))}</strong><small>${rows.filter((r) => r.kind === 'membership').length} Zahlung(en)</small></div>
        <div class="stat"><span>Sachspenden ${year}</span><strong>${formatMoney(sum('goods'))}</strong><small>${rows.filter((r) => r.kind === 'goods').length} Zuwendung(en)</small></div>
      </div>
      ${open.length
        ? html`<section class="card row-card">
            <div><strong>${open.length} unbestätigte Zuwendung(en) von ${openDonors} Zuwendenden in ${year}.</strong>
              <p class="muted small">Erstellt je Zuwendendem eine Sammelbestätigung über das Jahr (bei nur einer Zuwendung eine Einzelbestätigung). Sachspenden werden einzeln bestätigt.</p></div>
            ${postButton(c, `/donations/receipts/collective?year=${year}`, `Bestätigungen für ${year} erstellen`, 'btn primary',
              `Für ${openDonors} Zuwendende Bestätigungen über ${year} ausstellen? Sie erhalten fortlaufende Nummern und werden als Doppel archiviert.`)}
          </section>`
        : ''}
      ${rows.length ? donationTable(t, rows) : empty(`Keine Zuwendungen in ${year}.`, html`<a class="btn primary" href="/donations/new">Zuwendung erfassen</a>`)}
      <p class="muted small">Bis 300 € genügt dem Zuwendenden als Nachweis auch der Kontoauszug zusammen mit einem vereinfachten Beleg (§ 50 Abs. 4 EStDV).</p>`,
    });
  });

  app.get('/donations/new', async (c) => {
    const t = npoTenant(c);
    const contactId = Number(c.req.query('contact') ?? 0);
    return page(c, {
      title: 'Zuwendung erfassen',
      back: { href: '/donations', label: 'Spenden' },
      body: donationForm(c, t, '/donations', { contact_id: contactId || undefined }, await donorOptions(t.id), await cashOptions(t)),
    });
  });

  app.post('/donations', async (c) => {
    const t = npoTenant(c);
    const form = await readForm(c);
    const input = await parseDonation(form, t.id);
    const accountId = Number(str(form, 'account_id')) || 0;
    if (accountId) assertOpen(t, input.donation_date);
    const id = await tx(async () => {
      const newId = await createDonation(t, input, userOf(c).id);
      await syncCash(t, newId, input, accountId, userOf(c).id);
      return newId;
    });
    return redirectWith(c, `/donations/${id}`, 'ok', 'Zuwendung gespeichert.');
  });

  app.get('/donations/receipts', async (c) => {
    const t = npoTenant(c);
    const current = Number(today().slice(0, 4));
    const year = yearOf(c.req.query('year'), current);
    const rows = await all<Receipt & { contact_label: string }>(
      `SELECT ${RECEIPT_COLUMNS.split(', ').map((x) => `r.${x}`).join(', ')}, COALESCE(NULLIF(c.company, ''), c.name) contact_label
       FROM donation_receipts r JOIN contacts c ON c.id = r.contact_id
       WHERE r.tenant_id = ? AND substr(r.issue_date, 1, 4) = ? ORDER BY r.issue_date DESC, r.id DESC`,
      t.id, String(year),
    );
    const years = (await all<{ y: string }>('SELECT DISTINCT substr(issue_date, 1, 4) y FROM donation_receipts WHERE tenant_id = ?', t.id)).map((r) => Number(r.y));
    return page(c, {
      title: 'Zuwendungsbestätigungen',
      back: { href: '/donations', label: 'Spenden' },
      body: html`
      <form class="toolbar" method="get">
        <select name="year" class="year-select" data-autosubmit aria-label="Jahr">${[...new Set([current, year, ...years])].sort((a, b) => b - a)
          .map((y) => html`<option value="${y}"${selected(y, year)}>${y}</option>`)}</select>
        <noscript><button class="btn">OK</button></noscript>
      </form>
      ${rows.length ? receiptTable(rows) : empty(`${year} wurden keine Bestätigungen ausgestellt.`)}
      <p class="muted small">Ausgestellte Bestätigungen bleiben als Doppel erhalten (§ 50 Abs. 7 EStDV) und lassen sich nicht ändern – nur stornieren und neu ausstellen.</p>`,
    });
  });

  app.post('/donations/receipts/collective', async (c) => {
    const t = npoTenant(c);
    const year = yearOf(c.req.query('year'), Number(today().slice(0, 4)));
    const contactId = Number(c.req.query('contact') ?? 0) || undefined;
    const { issued, skipped } = await issueCollective(t, year, userOf(c).id, contactId);
    if (issued.length) await audit(c, 'donation.receipts', `${issued.length} Bestätigung(en) für ${year}`);
    const msg = `${issued.length} Bestätigung(en) für ${year} erstellt.${skipped.length ? ` Übersprungen: ${skipped.join(' ')}` : ''}`;
    return redirectWith(c, contactId ? `/contacts/${contactId}` : `/donations/receipts?year=${today().slice(0, 4)}`, skipped.length && !issued.length ? 'error' : 'ok', msg);
  });

  app.get('/donations/receipts/:id', async (c) => {
    const t = npoTenant(c);
    const r = await getReceipt(t.id, idParam(c)) ?? notFound();
    const contact = await getContact(t.id, r.contact_id);
    const snap = JSON.parse((await one<{ snapshot: string }>('SELECT snapshot FROM donation_receipts WHERE id = ?', r.id))!.snapshot) as ReceiptData;
    const donations = await all<Donation>('SELECT * FROM donations WHERE receipt_id = ? ORDER BY donation_date', r.id);
    return page(c, {
      title: `${TEXT.titles[r.kind]} ${r.number}`,
      back: { href: '/donations/receipts', label: 'Bestätigungen' },
      actions: html`<a class="btn primary" href="/donations/receipts/${r.id}/pdf" target="_blank">PDF</a>`,
      body: html`
      ${r.status === 'cancelled'
        ? html`<div class="notice danger-notice">Storniert am ${formatDate(r.cancelled_at?.slice(0, 10))}${r.cancel_reason ? ` – ${r.cancel_reason}` : ''}. Das Doppel bleibt archiviert.</div>`
        : ''}
      <section class="card"><dl class="dl cols">
        <dt>Zuwendender</dt><dd>${contact ? html`<a href="/contacts/${contact.id}">${contactLabel(contact)}</a>` : snap.donor[0]}</dd>
        <dt>Ausgestellt am</dt><dd>${formatDate(r.issue_date)}</dd>
        <dt>Art</dt><dd>${RECEIPT_KIND_LABEL[r.kind]}</dd>
        <dt>${r.kind === 'collective' ? 'Zeitraum' : 'Tag der Zuwendung'}</dt><dd>${r.kind === 'collective' ? `${formatDate(r.period_from)} – ${formatDate(r.period_to)}` : formatDate(r.period_from)}</dd>
        <dt>Betrag</dt><dd><strong>${formatMoney(r.total)}</strong></dd>
      </dl></section>
      ${r.status === 'issued' && donations.length ? html`<h2 class="section-title">Enthaltene Zuwendungen</h2>${donationTable(t, donations, false)}` : ''}
      ${r.status === 'issued'
        ? html`<div class="danger-zone">
            <form method="post" action="/donations/receipts/${r.id}/cancel" class="inline-form" data-confirm="Bestätigung ${r.number} stornieren? Die Zuwendungen werden wieder frei; dem Zuwendenden solltest du mitteilen, dass die alte Bestätigung ungültig ist.">
              ${csrfField(c)}
              <input name="reason" maxlength="300" placeholder="Grund (z. B. falscher Betrag)" aria-label="Grund der Stornierung">
              <button class="btn danger">Stornieren</button>
            </form></div>`
        : ''}`,
    });
  });

  app.get('/donations/receipts/:id/pdf', async (c) => {
    const t = npoTenant(c);
    const r = await one<{ number: string; pdf: Buffer }>('SELECT number, pdf FROM donation_receipts WHERE tenant_id = ? AND id = ?', t.id, idParam(c)) ?? notFound();
    return c.body(new Uint8Array(r.pdf), 200, { 'Content-Type': 'application/pdf', 'Content-Disposition': attachment(`Zuwendungsbestaetigung_${r.number}.pdf`, true) });
  });

  app.post('/donations/receipts/:id/cancel', async (c) => {
    const t = npoTenant(c);
    const r = await getReceipt(t.id, idParam(c)) ?? notFound();
    const reason = str(await readForm(c), 'reason', 300);
    await cancelReceipt(r, reason);
    await audit(c, 'donation.receipt.cancel', `${r.number}${reason ? `: ${reason}` : ''}`);
    return redirectWith(c, `/donations/receipts/${r.id}`, 'ok', `Bestätigung ${r.number} storniert. Die Zuwendungen können neu bestätigt werden.`);
  });

  app.get('/donations/:id', async (c) => {
    const t = npoTenant(c);
    const d = await getDonation(t.id, idParam(c)) ?? notFound();
    const contact = await getContact(t.id, d.contact_id);
    const receipt = d.receipt_id ? await getReceipt(t.id, d.receipt_id) : undefined;
    const year = Number(d.donation_date.slice(0, 4));
    const canConfirm = !d.receipt_id && confirmable(t, d);
    const payment = cashbookEnabled(t) ? await linkedEntry('donation', d.id) : undefined;
    return page(c, {
      title: `${DONATION_KINDS[d.kind]} vom ${formatDate(d.donation_date)}`,
      back: { href: `/donations?year=${year}`, label: 'Spenden' },
      actions: html`
        ${canConfirm ? postButton(c, `/donations/${d.id}/receipt`, d.kind === 'goods' ? 'Bestätigung erstellen' : 'Einzelbestätigung erstellen', 'btn primary',
          'Zuwendungsbestätigung ausstellen? Sie erhält eine fortlaufende Nummer und wird als Doppel archiviert.') : ''}
        ${!d.receipt_id ? html`<a class="btn" href="/donations/${d.id}/edit">Bearbeiten</a>` : ''}`,
      body: html`
      ${canConfirm ? settingsNotice(t) : ''}
      <section class="card"><dl class="dl cols">
        <dt>Zuwendender</dt><dd>${contact ? html`<a href="/contacts/${contact.id}">${contactLabel(contact)}</a>` : ''}</dd>
        <dt>Datum</dt><dd>${formatDate(d.donation_date)}</dd>
        <dt>Art</dt><dd>${DONATION_KINDS[d.kind]}</dd>
        <dt>${d.kind === 'goods' ? 'Wert' : 'Betrag'}</dt><dd><strong>${formatMoney(d.amount)}</strong></dd>
        ${d.kind !== 'goods' ? html`<dt>Aufwandsverzicht</dt><dd>${d.waiver ? 'ja' : 'nein'}</dd>` : ''}
        ${d.kind === 'goods' ? html`<dt>Bezeichnung</dt><dd>${d.description}</dd>
          <dt>Herkunft</dt><dd>${{ business: 'Betriebsvermögen', private: 'Privatvermögen', unknown: 'keine Angabe', '': '' }[d.goods_origin]}${d.goods_documents ? ' · Unterlagen zur Wertermittlung liegen vor' : ''}</dd>` : ''}
        ${d.note ? html`<dt>Notiz</dt><dd>${d.note}</dd>` : ''}
        ${payment ? html`<dt>Eingang</dt><dd><a href="/cashbook?account=${payment.account_id}">im Kassenbuch gebucht</a> am ${formatDate(payment.entry_date)}</dd>` : ''}
        <dt>Bestätigung</dt><dd>${receipt
          ? html`<a href="/donations/receipts/${receipt.id}">${RECEIPT_KIND_LABEL[receipt.kind]} ${receipt.number}</a> vom ${formatDate(receipt.issue_date)}`
          : donationStatus(t, d)}</dd>
      </dl></section>
      ${canConfirm && d.kind !== 'goods'
        ? html`<p class="muted small">Weitere Zuwendungen desselben Zuwendenden lassen sich am Jahresende gesammelt bestätigen – siehe <a href="/donations?year=${year}">Spenden ${year}</a>.</p>`
        : ''}
      ${!d.receipt_id
        ? html`<div class="danger-zone">${postButton(c, `/donations/${d.id}/delete`, 'Löschen', 'btn danger', 'Zuwendung löschen?')}</div>`
        : ''}`,
    });
  });

  app.get('/donations/:id/edit', async (c) => {
    const t = npoTenant(c);
    const d = await getDonation(t.id, idParam(c)) ?? notFound();
    if (d.receipt_id) return redirectWith(c, `/donations/${d.id}`, 'error', 'Bestätigte Zuwendungen lassen sich nicht ändern – erst die Bestätigung stornieren.');
    return page(c, {
      title: 'Zuwendung bearbeiten',
      back: { href: `/donations/${d.id}`, label: 'Zuwendung' },
      body: donationForm(c, t, `/donations/${d.id}`, d, await donorOptions(t.id, d.contact_id), await cashOptions(t, d.id)),
    });
  });

  app.post('/donations/:id', async (c) => {
    const t = npoTenant(c);
    const d = await getDonation(t.id, idParam(c)) ?? notFound();
    const form = await readForm(c);
    const input = await parseDonation(form, t.id);
    await tx(async () => {
      await updateDonation(d, input);
      await syncCash(t, d.id, input, Number(str(form, 'account_id')) || 0, userOf(c).id);
    });
    return redirectWith(c, `/donations/${d.id}`, 'ok', 'Zuwendung gespeichert.');
  });

  app.post('/donations/:id/delete', async (c) => {
    const t = npoTenant(c);
    const d = await getDonation(t.id, idParam(c)) ?? notFound();
    if (d.receipt_id) throw new UserError('Bestätigte Zuwendungen können nicht gelöscht werden. Erst die Bestätigung stornieren.');
    await unlink(t, 'donation', d.id);
    await deleteDonation(d);
    return redirectWith(c, `/donations?year=${d.donation_date.slice(0, 4)}`, 'ok', 'Zuwendung gelöscht.');
  });

  app.post('/donations/:id/receipt', async (c) => {
    const t = npoTenant(c);
    const d = await getDonation(t.id, idParam(c)) ?? notFound();
    const id = await issueSingle(t, d, userOf(c).id);
    const r = (await getReceipt(t.id, id))!;
    await audit(c, 'donation.receipt', r.number);
    return redirectWith(c, `/donations/receipts/${id}`, 'ok', `Zuwendungsbestätigung ${r.number} erstellt.`);
  });
}

export const donationsModule: Module = {
  name: 'donations',
  nav: { label: 'Spenden', href: '/donations', order: 33, visible: (t) => !!t.nonprofit },
  register,
};
