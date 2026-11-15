import { all, one, run } from '../../db/index.ts';
import { audit } from '../../lib/audit.ts';
import { formatDate, isIsoDate, today } from '../../lib/dates.ts';
import { html, selected, type SafeHtml } from '../../lib/html.ts';
import { idParam, list, notFound, readForm, redirectWith, requireOwner, str, tenantOf, userOf, UserError, type Form } from '../../lib/http.ts';
import { formatAmount, formatMoney, parseDecimal } from '../../lib/money.ts';
import { formatIban, normalizeIban } from '../../lib/validate.ts';
import { csrfField, empty, page } from '../../views/layout.ts';
import type { App, Ctx, Module, Tenant } from '../../types.ts';
import { accountsOf, balanceAt, cashbookEnabled, getAccount, type CashAccount } from '../cashbook/repo.ts';
import { cancelJob, chooseMedia, chooseMethod, continueJob, getJob, startJob } from './fints.ts';
import {
  assignItems, bookRest, candidatesFor, clearExempt, connectionOf, defaultFrom, entryText, exemptionsOf, FINTS_REGISTRATION_URL, finTsProductId, getTx, linksOf,
  openCounts, saveConnection, setExempt, setIgnored, setReconcileFrom, suggestions, transactionsOf, unlinkTx, unmatchedCounts, unmatchedEntries, VR_FINTS_URL,
  type AssignItem, type BankTxRow, type ItemKind, type Suggestion, type TxLink,
} from './repo.ts';

/**
 * Kontoumsätze per FinTS abrufen und mit dem Kassenbuch abgleichen (Bankkonten der Vereine).
 * Ablauf: Zugang einrichten (BLZ, FinTS-URL, Anmeldename) → „Umsätze abrufen“ mit PIN →
 * ggf. Freigabe in der Banking-App → Umsätze erscheinen mit Vorschlägen zur Zuordnung.
 * Ein Umsatz kann mehrere Buchungen bzw. Rechnungen umfassen; umgekehrt braucht jede Buchung auf
 * dem Bankkonto ab „Abgleich ab“ einen Umsatz (oder ist als Ausnahme markiert).
 */

function bankTenant(c: Ctx): Tenant {
  const t = tenantOf(c);
  if (!cashbookEnabled(t)) throw new UserError('Die Bankanbindung gehört zum Kassenbuch (für Vereine).');
  return t;
}

async function bankAccount(c: Ctx, t: Tenant, id = idParam(c)): Promise<CashAccount> {
  const a = await getAccount(t.id, id);
  if (!a || a.kind !== 'bank') notFound();
  return a;
}

const money = (v: number) => html`<span class="num ${v < 0 ? 'neg-amount' : ''}">${formatMoney(v)}</span>`;

function postButton(c: Ctx, action: string, label: string, cls = 'btn small', fields: Record<string, string | number> = {}, confirm?: string): SafeHtml {
  return html`<form method="post" action="${action}" class="inline" ${confirm ? html`data-confirm="${confirm}"` : ''}>${csrfField(c)}
    ${Object.entries(fields).map(([k, v]) => html`<input type="hidden" name="${k}" value="${v}">`)}<button class="${cls}">${label}</button></form>`;
}

/** BLZ aus einer deutschen IBAN (Stellen 5–12) */
const blzOf = (iban: string) => (/^DE\d{20}$/.test(normalizeIban(iban)) ? normalizeIban(iban).slice(4, 12) : '');

/** Rücksprung nur innerhalb von Schottr */
function backOf(form: Form, fallback: string): string {
  const b = str(form, 'back', 300);
  return /^\/(cashbook|invoices|purchases|donations)\b[\w/?=&%.-]*$/.test(b) ? b : fallback;
}

function txCell(x: BankTxRow): SafeHtml {
  return html`<strong>${x.remote_name || x.booking_text || 'Umsatz'}</strong>
    <div class="muted small">${x.purpose}${x.remote_iban ? html` · <span class="mono">${formatIban(x.remote_iban)}</span>` : ''}${x.booking_text && x.remote_name ? ` · ${x.booking_text}` : ''}</div>`;
}

function linkList(links: TxLink[] | undefined, x: BankTxRow): SafeHtml {
  const live = (links ?? []).filter((l) => !l.voided);
  if (!live.length) return html``;
  return html`<ul class="plain bank-links small">${live.map((l) => html`<li><a href="${l.href}">${l.label}</a> <span class="num">${formatMoney(l.amount)}</span></li>`)}
    ${x.remaining ? html`<li class="danger-text">Rest ${formatMoney(x.remaining)}</li>` : ''}</ul>`;
}

/** Vorschlag als Formular: Posten mit Betrag (ohne Vorzeichen) */
function suggestionForm(c: Ctx, x: BankTxRow, s: Suggestion, back: string): SafeHtml {
  const many = s.items.length > 1;
  return html`<div class="bank-suggestion ${s.sure ? 'sure' : ''}">
    <span>${s.items.map((i, n) => html`${n ? html`<br>` : ''}<a href="${i.href}">${i.label}</a>${many ? html` <span class="num small">${formatMoney(i.signed)}</span>` : ''}`)}
      <span class="muted small"> · ${s.hint}</span></span>
    <form method="post" action="/cashbook/bank/tx/${x.id}/assign" class="inline">${csrfField(c)}<input type="hidden" name="back" value="${back}">
      ${s.items.map((i) => html`<input type="hidden" name="item" value="${i.kind}:${i.id}:${Math.abs(i.signed)}">`)}
      <button class="${s.sure ? 'btn small primary' : 'btn small'}">${s.items.some((i) => i.kind !== 'entry') ? 'Als bezahlt buchen' : 'Zuordnen'}</button></form>
  </div>`;
}

/** Posten aus dem Formular: „item“ = Art:ID:Betrag (Vorschläge) bzw. „pick“ = Art:ID mit Betragsfeld amount_Art_ID */
function itemsFrom(form: Form): AssignItem[] {
  const kinds: ItemKind[] = ['entry', 'invoice', 'purchase'];
  const out: AssignItem[] = [];
  const amountOf = (raw: string, label: string) => {
    if (!raw) return null;
    const v = parseDecimal(raw, 2);
    if (v === null || v <= 0) throw new UserError(`Ungültiger Betrag bei ${label}.`);
    return v;
  };
  for (const v of list(form, 'item')) {
    const [k, id, cents] = v.split(':');
    if (kinds.includes(k as ItemKind) && Number(id) > 0) out.push({ kind: k as ItemKind, id: Number(id), amount: k === 'entry' ? null : Number(cents) || null });
  }
  for (const v of list(form, 'pick')) {
    const [k, id] = v.split(':');
    if (!kinds.includes(k as ItemKind) || !(Number(id) > 0)) continue;
    out.push({ kind: k as ItemKind, id: Number(id), amount: k === 'entry' ? null : amountOf(str(form, `amount_${k}_${id}`), k === 'invoice' ? 'der Rechnung' : 'der Eingangsrechnung') });
  }
  return out;
}

function register(app: App) {
  /* ---------------- Übersicht der Bankkonten ---------------- */
  app.get('/cashbook/bank', async (c) => {
    const t = bankTenant(c);
    const banks = (await accountsOf(t.id)).filter((a) => a.kind === 'bank');
    if (banks.length === 1) return c.redirect(`/cashbook/bank/${banks[0].id}`);
    const counts = await openCounts(t.id);
    const missing = await unmatchedCounts(t.id);
    const conns = new Set((await all<{ account_id: number }>('SELECT account_id FROM bank_connections WHERE tenant_id = ?', t.id)).map((r) => Number(r.account_id)));
    return page(c, {
      title: 'Kontoumsätze',
      back: { href: '/cashbook', label: 'Kassenbuch' },
      body: banks.length
        ? html`<div class="card flush"><table class="table">
            <thead><tr><th>Konto</th><th>IBAN</th><th>Bankzugang</th><th class="right">Offene Umsätze</th><th class="right">Buchungen ohne Umsatz</th></tr></thead>
            <tbody>${banks.map((a) => html`<tr class="rowlink" data-href="/cashbook/bank/${a.id}">
              <td><a href="/cashbook/bank/${a.id}">${a.name}</a></td><td class="mono small">${a.iban ? formatIban(a.iban) : ''}</td>
              <td>${conns.has(a.id) ? 'eingerichtet' : html`<span class="muted">noch nicht</span>`}</td>
              <td class="right">${counts.get(a.id) ?? 0}</td><td class="right">${missing.get(a.id) ?? 0}</td></tr>`)}</tbody></table></div>`
        : empty('Es gibt noch kein Bankkonto im Kassenbuch.', html`<a class="btn" href="/cashbook/accounts">Konten</a>`),
    });
  });

  /* ---------------- Konto: Abruf und Abgleich ---------------- */
  app.get('/cashbook/bank/:id', async (c) => {
    const t = bankTenant(c);
    const a = await bankAccount(c, t);
    const conn = await connectionOf(t.id, a.id);
    const productId = await finTsProductId();
    const owner = c.get('role') === 'owner';
    const open = await transactionsOf(a, 'open');
    const sugg = await suggestions(t, a, open);
    const done = await transactionsOf(a, 'done', 50);
    const ignored = await transactionsOf(a, 'ignored', 100);
    const links = await linksOf([...open, ...done].map((x) => x.id));
    const missing = await unmatchedEntries(t.id, a.id);
    const exemptions = await exemptionsOf(a.id);
    const book = await balanceAt(a);
    const sure = [...sugg.values()].filter((s) => s.sure).length;
    const back = `/cashbook/bank/${a.id}`;
    // zu Buchungen ohne Umsatz: offener Umsatz mit genau diesem Rest (nächstes Datum)
    const txFor = new Map<number, BankTxRow>();
    const taken = new Set<number>([...sugg.values()].flatMap((s) => s.items.filter((i) => i.kind === 'entry').map((i) => i.id)));
    for (const m of missing) {
      if (taken.has(m.id)) continue;
      const hit = open.filter((x) => x.remaining === m.amount && ![...txFor.values()].includes(x) && !sugg.get(x.id))
        .sort((p, q) => Math.abs(Date.parse(p.booking_date) - Date.parse(m.entry_date)) - Math.abs(Date.parse(q.booking_date) - Date.parse(m.entry_date)))[0];
      if (hit && Math.abs(Date.parse(hit.booking_date) - Date.parse(m.entry_date)) <= 14 * 86_400_000) txFor.set(m.id, hit);
    }

    const setupHint = owner
      ? html`<a class="btn primary" href="/cashbook/bank/${a.id}/setup">Bankzugang einrichten</a>`
      : html`<p class="muted small">Den Bankzugang richtet ein Inhaber des Mandanten ein.</p>`;

    return page(c, {
      title: `Kontoumsätze · ${a.name}`,
      back: { href: `/cashbook?account=${a.id}`, label: 'Kassenbuch' },
      actions: conn && owner ? html`<a class="btn" href="/cashbook/bank/${a.id}/setup">Bankzugang</a>` : undefined,
      body: html`
      ${!productId ? html`<div class="notice">Für den Abruf per FinTS braucht Schottr eine <strong>FinTS-Produkt-ID</strong> der Deutschen Kreditwirtschaft.
          Die Registrierung ist kostenlos: <a href="${FINTS_REGISTRATION_URL}" target="_blank" rel="noopener">fints.org → Produktregistrierung</a>.
          Ein Administrator trägt die ID danach unter <em>Administration → System</em> ein (oder per <code>SCHOTTR_FINTS_PRODUCT_ID</code>).</div>` : ''}
      <div class="detail-grid">
        <section class="card">
          <h2>Umsätze abrufen</h2>
          ${conn
            ? html`<p class="muted small">BLZ ${conn.blz} · Anmeldename ${conn.login}${conn.last_fetch_at ? html` · zuletzt abgerufen bis ${formatDate(conn.fetched_until)}` : ''}</p>
              <form method="post" action="/cashbook/bank/${a.id}/fetch" class="stack">
                ${csrfField(c)}
                <div class="grid-2">
                  <label>PIN <input type="password" name="pin" required autocomplete="off" maxlength="64"></label>
                  <label>Umsätze ab <input type="date" name="from" value="${defaultFrom(conn, a)}" min="${a.opening_date}" max="${today()}" required></label>
                </div>
                <small class="muted">Die PIN wird nicht gespeichert. Danach ggf. den Abruf in der Banking-App (z. B. SecureGo plus) freigeben.</small>
                <button class="btn primary"${productId ? '' : ' disabled'}>Umsätze abrufen</button>
              </form>`
            : html`<p>Für dieses Konto ist noch kein Bankzugang eingerichtet.</p>${setupHint}`}
        </section>
        <section class="card">
          <h2>Abgleich</h2>
          <dl class="dl">
            <dt>Laut Kassenbuch (heute)</dt><dd>${money(book)}</dd>
            ${conn?.bank_balance !== null && conn?.bank_balance !== undefined
              ? html`<dt>Laut Bank (${formatDate(conn.bank_balance_date)})</dt><dd>${money(conn.bank_balance)}</dd>
                ${conn.bank_balance_date === today() && conn.bank_balance !== book ? html`<dt>Differenz</dt><dd>${money(book - conn.bank_balance)}</dd>` : ''}`
              : html`<dt>Laut Bank</dt><dd class="muted">noch nicht abgerufen</dd>`}
            <dt>Abgleich ab</dt><dd>${a.reconcile_from ? formatDate(a.reconcile_from) : html`<span class="muted">aus</span>`}</dd>
          </dl>
          ${owner ? html`<form method="post" action="/cashbook/bank/${a.id}/reconcile" class="inline-form">${csrfField(c)}
              <input type="date" name="from" value="${a.reconcile_from ?? ''}" min="${a.opening_date}" aria-label="Abgleich ab">
              <button class="btn small">Speichern</button></form>
            <p class="muted small">Ab diesem Tag braucht jede Buchung auf dem Konto einen Kontoumsatz (leer = kein Abgleich). Wird beim ersten Abruf auf dessen Startdatum gesetzt.</p>` : ''}
          ${conn?.bank_balance_date === today() && conn.bank_balance !== book && !open.length && !missing.length
            ? html`<p class="small danger-text">Alles ist abgeglichen, die Stände weichen trotzdem ab – fehlen Umsätze vor dem Abgleich oder stimmt der Anfangsbestand nicht?</p>` : ''}
        </section>
      </div>

      <section class="card flush-mobile">
        <h2>Offene Umsätze <span class="count">${open.length}</span></h2>
        ${open.length
          ? html`${sure > 1 ? html`<div class="toolbar">${postButton(c, `/cashbook/bank/${a.id}/apply-sure`, `Alle ${sure} sicheren Vorschläge übernehmen`, 'btn small primary')}
              <span class="muted small">Sicher = Betrag und Nummer bzw. Datum passen.</span></div>` : ''}
            <table class="table stack-mobile bank-table">
              <thead><tr><th>Datum</th><th>Umsatz</th><th class="right">Betrag</th><th>Zuordnung</th></tr></thead>
              <tbody>${open.map((x) => {
                const s = sugg.get(x.id);
                return html`<tr>
                <td data-label="Datum" class="nowrap">${formatDate(x.booking_date)}</td>
                <td data-label="">${txCell(x)}${linkList(links.get(x.id), x)}</td>
                <td data-label="Betrag" class="right">${money(x.amount)}</td>
                <td data-label="">${s ? suggestionForm(c, x, s, back) : ''}
                  <div class="bank-actions">
                    <a class="btn small${s ? ' ghost' : ''}" href="/cashbook/bank/tx/${x.id}">Zuordnen …</a>
                    ${postButton(c, `/cashbook/bank/tx/${x.id}/book`, x.links ? 'Rest als Buchung' : 'Als Buchung übernehmen', 'btn small ghost', { back })}
                    ${t.nonprofit && x.remaining > 0 ? html`<a class="btn small ghost" href="/donations/from-bank/${x.id}">Als Zuwendung übernehmen</a>` : ''}
                    ${x.links ? '' : postButton(c, `/cashbook/bank/tx/${x.id}/ignore`, 'Ignorieren', 'btn small ghost', { back })}
                  </div></td></tr>`;
              })}</tbody>
            </table>`
          : html`<p class="muted">${conn ? 'Alle abgerufenen Umsätze sind zugeordnet.' : 'Noch keine Umsätze abgerufen.'}</p>`}
      </section>

      ${a.reconcile_from ? html`<section class="card flush-mobile">
        <h2>Buchungen ohne Kontoumsatz <span class="count">${missing.length}</span></h2>
        <p class="muted small">Buchungen auf diesem Konto ab ${formatDate(a.reconcile_from)}, die noch keinem Umsatz zugeordnet sind – Zahlungen von Rechnungen und Eingangsrechnungen, Spenden, Umbuchungen, freie Buchungen.
          Gibt es bewusst keinen Umsatz, als Ausnahme markieren.</p>
        ${missing.length
          ? html`<table class="table stack-mobile bank-table">
              <thead><tr><th>Datum</th><th>Buchung</th><th class="right">Betrag</th><th></th></tr></thead>
              <tbody>${missing.map((m) => {
                const x = txFor.get(m.id);
                return html`<tr>
                <td data-label="Datum" class="nowrap">${formatDate(m.entry_date)}</td>
                <td data-label=""><a href="${m.href}">${m.label}</a></td>
                <td data-label="Betrag" class="right">${money(m.amount)}</td>
                <td data-label="">
                  ${x ? html`<div class="bank-suggestion"><span><a href="/cashbook/bank/tx/${x.id}">${formatDate(x.booking_date)} · ${x.remote_name || 'Umsatz'}</a><span class="muted small"> · Betrag passt</span></span>
                    ${postButton(c, `/cashbook/bank/tx/${x.id}/assign`, 'Zuordnen', 'btn small', { item: `entry:${m.id}:0`, back })}</div>` : ''}
                  <form method="post" action="/cashbook/bank/entries/${m.id}/exempt" class="inline-form">${csrfField(c)}<input type="hidden" name="back" value="${back}">
                    <input name="reason" maxlength="200" placeholder="Grund (optional)" aria-label="Grund der Ausnahme" class="ref-input">
                    <button class="btn small ghost">Ausnahme</button></form></td></tr>`;
              })}</tbody></table>`
          : html`<p class="muted">Alle Buchungen haben einen Kontoumsatz.</p>`}
      </section>` : ''}

      ${done.length ? html`<details class="more"><summary>Zugeordnet (letzte ${done.length})</summary>
        <div class="card flush"><table class="table stack-mobile">
          <thead><tr><th>Datum</th><th>Umsatz</th><th class="right">Betrag</th><th></th></tr></thead>
          <tbody>${done.map((x) => html`<tr>
            <td data-label="Datum" class="nowrap">${formatDate(x.booking_date)}</td><td data-label="">${txCell(x)}${linkList(links.get(x.id), x)}</td>
            <td data-label="Betrag" class="right">${money(x.amount)}</td>
            <td data-label="" class="right nowrap"><a class="btn small ghost" href="/cashbook/bank/tx/${x.id}">Details</a></td></tr>`)}</tbody>
        </table></div></details>` : ''}
      ${exemptions.length ? html`<details class="more"><summary>Ausnahmen ohne Kontoumsatz (${exemptions.length})</summary>
        <div class="card flush"><table class="table stack-mobile">
          <tbody>${exemptions.map((x) => html`<tr>
            <td data-label="Datum" class="nowrap">${formatDate(x.entry_date)}</td><td data-label=""><a href="${x.href}">${x.label}</a>
              ${x.reason ? html`<div class="muted small">${x.reason}</div>` : ''}</td>
            <td data-label="Betrag" class="right">${money(x.amount)}</td>
            <td data-label="" class="right">${postButton(c, `/cashbook/bank/entries/${x.entry_id}/exempt`, 'Aufheben', 'btn small ghost', { remove: 1, back })}</td></tr>`)}</tbody>
        </table></div></details>` : ''}
      ${ignored.length ? html`<details class="more"><summary>Ignorierte Umsätze (${ignored.length})</summary>
        <div class="card flush"><table class="table stack-mobile">
          <tbody>${ignored.map((x) => html`<tr>
            <td data-label="Datum" class="nowrap">${formatDate(x.booking_date)}</td><td data-label="">${txCell(x)}</td>
            <td data-label="Betrag" class="right">${money(x.amount)}</td>
            <td data-label="" class="right">${postButton(c, `/cashbook/bank/tx/${x.id}/restore`, 'Wieder offen', 'btn small ghost', { back })}</td></tr>`)}</tbody>
        </table></div></details>` : ''}`,
    });
  });

  app.post('/cashbook/bank/:id/reconcile', async (c) => {
    requireOwner(c);
    const t = bankTenant(c);
    const a = await bankAccount(c, t);
    const from = str(await readForm(c), 'from');
    if (from && from < a.opening_date) throw new UserError(`Das Konto beginnt am ${formatDate(a.opening_date)}.`);
    await setReconcileFrom(t, a, from || null);
    await audit(c, 'bank.reconcile', `${a.name}: Abgleich ${from ? `ab ${formatDate(from)}` : 'aus'}`);
    return redirectWith(c, `/cashbook/bank/${a.id}`, 'ok', from ? `Abgleich ab ${formatDate(from)}.` : 'Abgleich für dieses Konto ausgeschaltet.');
  });

  /* ---------------- Bankzugang ---------------- */
  app.get('/cashbook/bank/:id/setup', async (c) => {
    requireOwner(c);
    const t = bankTenant(c);
    const a = await bankAccount(c, t);
    const conn = await connectionOf(t.id, a.id);
    return page(c, {
      title: `Bankzugang · ${a.name}`,
      back: { href: `/cashbook/bank/${a.id}`, label: 'Kontoumsätze' },
      body: html`<section class="card narrow">
        <form method="post" action="/cashbook/bank/${a.id}/setup" class="stack">
          ${csrfField(c)}
          <label>Bankleitzahl <input name="blz" required inputmode="numeric" pattern="\\d{8}" maxlength="8" value="${conn?.blz ?? blzOf(a.iban)}"></label>
          <label>FinTS-Adresse (URL) <input name="url" type="url" required maxlength="300" value="${conn?.url ?? VR_FINTS_URL}">
            <small class="muted">Vorbelegt für Volks- und Raiffeisenbanken. Andere Banken nennen die Adresse unter „FinTS/HBCI“ bzw. „PIN/TAN-Zugang für Finanzsoftware“.</small></label>
          <label>Anmeldename <input name="login" required maxlength="100" autocomplete="off" value="${conn?.login ?? ''}">
            <small class="muted">Wie im Online-Banking – bei VR-Banken der VR-NetKey oder Alias.</small></label>
          <label>Kunden-ID (optional) <input name="customer_id" maxlength="100" autocomplete="off" value="${conn?.customer_id ?? ''}">
            <small class="muted">Nur wenn die Bank eine vom Anmeldenamen abweichende Kunden-ID vorgibt.</small></label>
          ${a.iban ? html`<p class="muted small">Abgerufen wird das Konto mit der IBAN ${formatIban(a.iban)}.</p>`
            : html`<p class="small danger-text">Beim Konto ist keine IBAN eingetragen – bei mehreren Konten im Bankzugang lässt sich das richtige sonst nicht finden.</p>`}
          <button class="btn primary">Speichern</button>
        </form>
      </section>
      ${conn ? html`<div class="danger-zone">${postButton(c, `/cashbook/bank/${a.id}/disconnect`, 'Bankzugang entfernen', 'btn danger', {},
        'Bankzugang entfernen? Abgerufene Umsätze und Zuordnungen bleiben erhalten.')}</div>` : ''}`,
    });
  });

  app.post('/cashbook/bank/:id/setup', async (c) => {
    requireOwner(c);
    const t = bankTenant(c);
    const a = await bankAccount(c, t);
    const form = await readForm(c);
    const blz = str(form, 'blz', 8).replace(/\s/g, '');
    const url = str(form, 'url', 300);
    const login = str(form, 'login', 100);
    const customer_id = str(form, 'customer_id', 100);
    const errors: string[] = [];
    if (!/^\d{8}$/.test(blz)) errors.push('Die Bankleitzahl hat 8 Ziffern.');
    if (!/^https:\/\/[^\s]+$/.test(url)) errors.push('Die FinTS-Adresse muss mit https:// beginnen.');
    if (!login) errors.push('Bitte den Anmeldenamen angeben.');
    if (errors.length) throw new UserError(errors.join(' '));
    await saveConnection(t, a.id, { blz, url, login, customer_id });
    await audit(c, 'bank.setup', `${a.name}: BLZ ${blz}`);
    return redirectWith(c, `/cashbook/bank/${a.id}`, 'ok', 'Bankzugang gespeichert.');
  });

  app.post('/cashbook/bank/:id/disconnect', async (c) => {
    requireOwner(c);
    const t = bankTenant(c);
    const a = await bankAccount(c, t);
    await run('DELETE FROM bank_connections WHERE tenant_id = ? AND account_id = ?', t.id, a.id);
    await audit(c, 'bank.disconnect', a.name);
    return redirectWith(c, `/cashbook/bank/${a.id}`, 'ok', 'Bankzugang entfernt.');
  });

  /* ---------------- Abruf ---------------- */
  app.post('/cashbook/bank/:id/fetch', async (c) => {
    const t = bankTenant(c);
    const a = await bankAccount(c, t);
    const conn = await connectionOf(t.id, a.id) ?? notFound();
    const form = await readForm(c);
    const pin = typeof form.pin === 'string' ? form.pin : '';
    const from = str(form, 'from');
    if (!pin) throw new UserError('Bitte die PIN eingeben.');
    if (!isIsoDate(from) || from > today()) throw new UserError('Bitte ein gültiges Startdatum angeben.');
    let job;
    try {
      job = await startJob(t, userOf(c).id, a, conn, pin, from < a.opening_date ? a.opening_date : from);
    } catch (err) {
      throw new UserError(err instanceof Error ? err.message : String(err));
    }
    return c.redirect(`/cashbook/bank/job/${job.id}`);
  });

  app.get('/cashbook/bank/job/:job', async (c) => {
    const t = bankTenant(c);
    const job = getJob(c.req.param('job'), t.id, userOf(c).id);
    if (!job) return redirectWith(c, '/cashbook/bank', 'error', 'Der Abruf ist abgelaufen oder wurde beendet. Bitte erneut starten.');
    const a = await bankAccount(c, t, job.accountId);
    if (job.status.state === 'tan' && job.status.decoupled) {
      job.polls++;
      await continueJob(job, a);
    }
    const s = job.status;
    const back = `/cashbook/bank/${a.id}`;
    if (s.state === 'done') {
      cancelJob(job);
      await audit(c, 'bank.fetch', `${a.name}: ${s.added} neue von ${s.total} Umsätzen`);
      return redirectWith(c, back, 'ok', `${s.added ? `${s.added} neue Umsätze abgerufen` : 'Keine neuen Umsätze'}${s.total ? ` (${s.total} insgesamt im Zeitraum)` : ''}.${s.notes.length ? ` ${s.notes.join(' ')}` : ''}`);
    }
    if (s.state === 'error') {
      cancelJob(job);
      await audit(c, 'bank.fetch.failed', `${a.name}: ${s.message}`);
      return redirectWith(c, back, 'error', s.message);
    }
    const action = `/cashbook/bank/job/${job.id}`;
    const cancel = html`<form method="post" action="${action}" class="inline">${csrfField(c)}<input type="hidden" name="action" value="cancel"><button class="btn ghost">Abbrechen</button></form>`;
    let body: SafeHtml;
    if (s.state === 'tan') {
      body = html`<section class="card narrow">
        <p>${s.challenge}</p>
        ${s.photo ? html`<p><img src="data:${s.photo.mime};base64,${s.photo.data}" alt="photoTAN-Grafik" class="tan-photo"></p>` : ''}
        ${s.flicker ? html`<p class="notice small">Die Flicker-Grafik (chipTAN optisch) kann Schottr nicht anzeigen. Bitte die Daten manuell in den TAN-Generator eingeben oder in der Bank ein App-Verfahren (z. B. SecureGo plus) wählen.</p>` : ''}
        ${s.decoupled
          ? html`<p class="muted small" data-refresh="${s.pollEvery}">Warte auf die Freigabe … Die Seite aktualisiert sich selbst.</p>
              <div class="toolbar"><a class="btn" href="${action}">Status prüfen</a>${cancel}</div>`
          : html`<form method="post" action="${action}" class="stack">${csrfField(c)}<input type="hidden" name="action" value="tan">
              <label>TAN <input name="tan" required autocomplete="one-time-code" inputmode="numeric" maxlength="20" autofocus></label>
              <div class="toolbar"><button class="btn primary">Senden</button></div></form>${cancel}`}
      </section>`;
    } else if (s.state === 'choose_method') {
      body = html`<section class="card narrow">
        <p>Die Bank bietet mehrere TAN-Verfahren an. Welches nutzt der Verein? Die Wahl wird für künftige Abrufe gemerkt.</p>
        <form method="post" action="${action}" class="stack">${csrfField(c)}<input type="hidden" name="action" value="method">
          ${s.methods.map((m, i) => html`<label class="check"><input type="radio" name="method" value="${m.id}"${i === 0 ? ' checked' : ''}> ${m.name}${m.decoupled ? html` <span class="muted small">(Freigabe in der App)</span>` : ''}</label>`)}
          <div class="toolbar"><button class="btn primary">Weiter</button></div></form>${cancel}
      </section>`;
    } else {
      body = html`<section class="card narrow">
        <p>Welches Gerät bzw. welche App soll die Freigabe erhalten?</p>
        <form method="post" action="${action}" class="stack">${csrfField(c)}<input type="hidden" name="action" value="media">
          <select name="media">${s.media.map((m) => html`<option value="${m}"${selected(m, s.media[0])}>${m}</option>`)}</select>
          <div class="toolbar"><button class="btn primary">Weiter</button></div></form>${cancel}
      </section>`;
    }
    return page(c, { title: `Umsätze abrufen · ${a.name}`, back: { href: back, label: 'Kontoumsätze' }, body });
  });

  app.post('/cashbook/bank/job/:job', async (c) => {
    const t = bankTenant(c);
    const job = getJob(c.req.param('job'), t.id, userOf(c).id);
    if (!job) return redirectWith(c, '/cashbook/bank', 'error', 'Der Abruf ist abgelaufen oder wurde beendet. Bitte erneut starten.');
    const a = await bankAccount(c, t, job.accountId);
    const form = await readForm(c);
    const action = str(form, 'action');
    if (action === 'cancel') {
      cancelJob(job);
      return redirectWith(c, `/cashbook/bank/${a.id}`, 'ok', 'Abruf abgebrochen.');
    }
    if (action === 'tan' && job.status.state === 'tan' && !job.status.decoupled) {
      const tan = str(form, 'tan', 20).replace(/\s/g, '');
      if (!tan) throw new UserError('Bitte die TAN eingeben.');
      await continueJob(job, a, tan);
    } else if (action === 'method' && job.status.state === 'choose_method') {
      await chooseMethod(job, a, Number(str(form, 'method')));
    } else if (action === 'media' && job.status.state === 'choose_media' && job.status.media.includes(str(form, 'media', 100))) {
      await chooseMedia(job, a, str(form, 'media', 100));
    }
    return c.redirect(`/cashbook/bank/job/${job.id}`);
  });

  /* ---------------- Ein Umsatz: Zuordnen (auch mehrere) ---------------- */
  async function txOf(c: Ctx, t: Tenant, id = idParam(c)): Promise<BankTxRow> {
    return await getTx(t.id, id) ?? notFound();
  }

  app.get('/cashbook/bank/tx/:id', async (c) => {
    const t = bankTenant(c);
    const x = await txOf(c, t);
    const a = await bankAccount(c, t, x.account_id);
    const links = (await linksOf([x.id])).get(x.id) ?? [];
    const cand = x.remaining && !x.ignored_at ? await candidatesFor(t, x) : null;
    const back = `/cashbook/bank/tx/${x.id}`;
    const amt = (cents: number) => formatAmount(cents).replace(/\./g, '');
    const row = (kind: ItemKind, id: number, label: SafeHtml | string, sub: string, signed: number, editable: boolean, hint = false) => html`<tr${hint ? html` class="hl"` : ''}>
      <td><input type="checkbox" name="pick" value="${kind}:${id}" data-sign="${signed < 0 ? -1 : 1}" aria-label="Auswählen"></td>
      <td>${label}<div class="muted small">${sub}</div></td>
      <td class="right">${editable
        ? html`<input name="amount_${kind}_${id}" class="num amount-input" inputmode="decimal" value="${amt(Math.abs(signed))}" aria-label="Betrag">`
        : html`<input type="hidden" name="amount_${kind}_${id}" value="${amt(Math.abs(signed))}">${money(signed)}`}</td></tr>`;
    const purchasesFit = cand ? cand.purchases.filter((p) => (p.is_credit ? 1 : -1) * Math.sign(x.remaining) > 0) : [];
    const hay = `${x.purpose} ${x.remote_name}`.toUpperCase().replace(/[^A-Z0-9]/g, '');
    const hit = (n: string) => n.replace(/[^A-Za-z0-9]/g, '').length >= 4 && hay.includes(n.toUpperCase().replace(/[^A-Z0-9]/g, ''));
    return page(c, {
      title: `Kontoumsatz ${formatDate(x.booking_date)}`,
      back: { href: `/cashbook/bank/${a.id}`, label: `Kontoumsätze · ${a.name}` },
      body: html`
      <section class="card">
        <dl class="dl cols">
          <dt>Buchungstag</dt><dd>${formatDate(x.booking_date)}${x.value_date && x.value_date !== x.booking_date ? html` <span class="muted small">(Wertstellung ${formatDate(x.value_date)})</span>` : ''}</dd>
          <dt>Betrag</dt><dd>${money(x.amount)}</dd>
          <dt>${x.amount < 0 ? 'Empfänger' : 'Auftraggeber'}</dt><dd>${x.remote_name || '–'}${x.remote_iban ? html` <span class="mono small">${formatIban(x.remote_iban)}</span>` : ''}</dd>
          <dt>Verwendungszweck</dt><dd>${x.purpose || '–'}</dd>
          ${x.booking_text ? html`<dt>Buchungstext</dt><dd>${x.booking_text}</dd>` : ''}
          ${x.mandate_ref ? html`<dt>Mandat</dt><dd>${x.mandate_ref}</dd>` : ''}
          ${x.e2e_ref ? html`<dt>Referenz</dt><dd>${x.e2e_ref}</dd>` : ''}
        </dl>
      </section>
      <section class="card">
        <h2>Zugeordnet <span class="count">${links.filter((l) => !l.voided).length}</span></h2>
        ${links.length
          ? html`<table class="table"><tbody>${links.map((l) => html`<tr class="${l.voided ? 'voided' : ''}">
              <td class="nowrap">${formatDate(l.entry_date)}</td><td><a href="${l.href}">${l.label}</a>${l.voided ? html` <span class="tag">storniert</span>` : ''}</td>
              <td class="right">${money(l.amount)}</td>
              <td class="right">${postButton(c, `/cashbook/bank/tx/${x.id}/unlink`, 'Lösen', 'btn small ghost', { entry_id: l.entry_id, back }, 'Zuordnung lösen? Die Buchung bleibt im Kassenbuch stehen.')}</td></tr>`)}
              <tr><td></td><td><strong>${x.remaining ? 'Rest' : 'Vollständig zugeordnet'}</strong></td><td class="right">${x.remaining ? money(x.remaining) : ''}</td><td></td></tr>
            </tbody></table>`
          : html`<p class="muted">Noch nichts zugeordnet.</p>`}
      </section>
      ${x.ignored_at
        ? html`<div class="notice soft">Ignoriert. ${postButton(c, `/cashbook/bank/tx/${x.id}/restore`, 'Wieder offen', 'btn small', { back })}</div>`
        : cand ? html`
      <section class="card">
        <h2>Zuordnen</h2>
        <p class="muted small">Eine oder mehrere Buchungen bzw. Rechnungen wählen – z. B. eine Überweisung für zwei Rechnungen oder eine Auszahlung abzüglich Gebühr.
          Rechnungen und Eingangsrechnungen werden zum ${formatDate(x.booking_date)} als bezahlt gebucht; bei Skonto bzw. Teilzahlung den Betrag anpassen.</p>
        <form method="post" action="/cashbook/bank/tx/${x.id}/assign" class="stack" data-assign-form data-remaining="${x.remaining}">
          ${csrfField(c)}<input type="hidden" name="back" value="${back}">
          ${cand.entries.length ? html`<h3 class="small">Buchungen ohne Kontoumsatz auf „${a.name}“</h3>
            <table class="table bank-pick"><tbody>${cand.entries.map((e) => row('entry', e.id, html`<a href="${e.href}">${e.label}</a>`, formatDate(e.entry_date), e.amount, false, e.amount === x.remaining))}</tbody></table>` : ''}
          ${cand.invoices.length && x.remaining > 0 ? html`<h3 class="small">Rechnungen</h3>
            <table class="table bank-pick"><tbody>${cand.invoices.map((d) => row('invoice', d.id, html`<a href="/invoices/${d.id}">Rechnung ${d.number}</a>`,
              [d.label, d.status === 'paid' ? 'schon als bezahlt markiert' : `offen ${formatMoney(d.due)}`].filter(Boolean).join(' · '), d.due, true, hit(d.number)))}</tbody></table>` : ''}
          ${purchasesFit.length ? html`<h3 class="small">Eingangsrechnungen</h3>
            <table class="table bank-pick"><tbody>${purchasesFit.map((p) => row('purchase', p.id,
              html`<a href="/purchases/${p.id}">${p.label ?? 'ohne Lieferant'} · ${p.number || p.internal_ref || 'ohne Nr.'}</a>`,
              [p.is_credit ? 'Gutschrift' : '', p.status === 'paid' ? 'schon als bezahlt markiert' : `offen ${formatMoney(p.due)}`].filter(Boolean).join(' · '),
              (p.is_credit ? 1 : -1) * p.due, true, hit(p.number) || hit(p.internal_ref)))}</tbody></table>` : ''}
          <p class="small">Ausgewählt: <strong data-assign-sum>0,00 €</strong> von ${formatMoney(x.remaining)}</p>
          <div class="toolbar"><button class="btn primary">Zuordnen</button></div>
        </form>
      </section>
      <section class="card">
        <h2>${links.some((l) => !l.voided) ? 'Rest als Buchung' : 'Als Buchung übernehmen'}</h2>
        <form method="post" action="/cashbook/bank/tx/${x.id}/book" class="inline-form">${csrfField(c)}<input type="hidden" name="back" value="${back}">
          <input name="text" maxlength="300" value="${entryText(x)}" aria-label="Buchungstext">
          <button class="btn">${formatMoney(x.remaining)} buchen</button></form>
        <p class="muted small">z. B. Kontoführung, Gebühren, Beiträge ohne Rechnung – Kostenart, Bereich und Beleg lassen sich danach in der Buchung ergänzen.</p>
        ${t.nonprofit && x.remaining > 0 ? html`<div class="toolbar"><a class="btn" href="/donations/from-bank/${x.id}">Als Zuwendung übernehmen</a>
          <span class="muted small">Spende bzw. Mitgliedsbeitrag mit Zuwendendem, ggf. für die Bestätigung.</span></div>` : ''}
        ${x.links ? '' : html`<div class="toolbar">${postButton(c, `/cashbook/bank/tx/${x.id}/ignore`, 'Umsatz ignorieren', 'btn ghost', { back: `/cashbook/bank/${a.id}` })}</div>`}
      </section>` : ''}`,
    });
  });

  app.post('/cashbook/bank/tx/:id/assign', async (c) => {
    const t = bankTenant(c);
    const x = await txOf(c, t);
    const form = await readForm(c);
    const labels = await assignItems(t, x, itemsFrom(form), userOf(c).id);
    const after = (await getTx(t.id, x.id))!;
    await audit(c, 'bank.assign', `${formatDate(x.booking_date)} ${formatMoney(x.amount)}: ${labels.join(', ')}`);
    return redirectWith(c, backOf(form, `/cashbook/bank/${x.account_id}`), 'ok',
      `Zugeordnet: ${labels.join(', ')}.${after.remaining ? ` Rest ${formatMoney(after.remaining)} noch offen.` : ''}`);
  });

  app.post('/cashbook/bank/tx/:id/book', async (c) => {
    const t = bankTenant(c);
    const x = await txOf(c, t);
    const form = await readForm(c);
    const text = str(form, 'text', 300);
    await bookRest(t, x, userOf(c).id, text);
    return redirectWith(c, backOf(form, `/cashbook/bank/${x.account_id}`), 'ok',
      `Gebucht: ${(text || entryText(x)).slice(0, 80)}. Kostenart, Bereich und Beleg lassen sich in der Buchung ergänzen.`);
  });

  app.post('/cashbook/bank/tx/:id/ignore', async (c) => {
    const t = bankTenant(c);
    const x = await txOf(c, t);
    await setIgnored(x, true, userOf(c).id);
    return redirectWith(c, backOf(await readForm(c), `/cashbook/bank/${x.account_id}`), 'ok', 'Umsatz ignoriert.');
  });

  app.post('/cashbook/bank/tx/:id/restore', async (c) => {
    const t = bankTenant(c);
    const x = await txOf(c, t);
    await setIgnored(x, false, userOf(c).id);
    return redirectWith(c, backOf(await readForm(c), `/cashbook/bank/${x.account_id}`), 'ok', 'Umsatz ist wieder offen.');
  });

  app.post('/cashbook/bank/tx/:id/unlink', async (c) => {
    const t = bankTenant(c);
    const x = await txOf(c, t);
    const form = await readForm(c);
    await unlinkTx(x, Number(str(form, 'entry_id')) || undefined);
    await audit(c, 'bank.unlink', `${formatDate(x.booking_date)} ${formatMoney(x.amount)}`);
    return redirectWith(c, backOf(form, `/cashbook/bank/${x.account_id}`), 'ok', 'Zuordnung gelöst – die Buchung bleibt im Kassenbuch stehen.');
  });

  /** Alle sicheren Vorschläge auf einmal übernehmen */
  app.post('/cashbook/bank/:id/apply-sure', async (c) => {
    const t = bankTenant(c);
    const a = await bankAccount(c, t);
    const open = await transactionsOf(a, 'open');
    const sugg = await suggestions(t, a, open);
    let n = 0;
    const failed: string[] = [];
    for (const x of open) {
      const s = sugg.get(x.id);
      if (!s?.sure) continue;
      try {
        await assignItems(t, (await getTx(t.id, x.id))!, s.items.map((i) => ({ kind: i.kind, id: i.id, amount: i.kind === 'entry' ? null : Math.abs(i.signed) })), userOf(c).id);
        n++;
      } catch (err) {
        failed.push(`${formatDate(x.booking_date)} ${formatMoney(x.amount)}: ${err instanceof Error ? err.message : err}`);
      }
    }
    await audit(c, 'bank.assign', `${a.name}: ${n} Vorschläge übernommen`);
    return redirectWith(c, `/cashbook/bank/${a.id}`, failed.length ? 'error' : 'ok',
      `${n} Umsätze zugeordnet.${failed.length ? ` Nicht übernommen: ${failed.join(' · ')}` : ''}`);
  });

  /* ---------------- Von der Buchung bzw. Rechnung aus ---------------- */
  app.post('/cashbook/bank/entries/:id/link', async (c) => {
    const t = bankTenant(c);
    const form = await readForm(c);
    const x = await txOf(c, t, Number(str(form, 'tx_id')));
    const labels = await assignItems(t, x, [{ kind: 'entry', id: idParam(c) }], userOf(c).id);
    await audit(c, 'bank.assign', `${formatDate(x.booking_date)} ${formatMoney(x.amount)}: ${labels.join(', ')}`);
    const after = (await getTx(t.id, x.id))!;
    return redirectWith(c, backOf(form, `/cashbook/entries/${idParam(c)}/edit`), 'ok',
      `Dem Kontoumsatz vom ${formatDate(x.booking_date)} zugeordnet.${after.remaining ? ` Am Umsatz sind noch ${formatMoney(after.remaining)} offen.` : ''}`);
  });

  app.post('/cashbook/bank/entries/:id/exempt', async (c) => {
    const t = bankTenant(c);
    const form = await readForm(c);
    const id = idParam(c);
    if (str(form, 'remove')) {
      await clearExempt(t, id);
      await audit(c, 'bank.exempt', `Buchung ${id}: Ausnahme aufgehoben`);
      return redirectWith(c, backOf(form, `/cashbook/entries/${id}/edit`), 'ok', 'Ausnahme aufgehoben – die Buchung braucht wieder einen Kontoumsatz.');
    }
    const reason = str(form, 'reason', 200) || 'ohne Kontoumsatz';
    const e = await setExempt(t, id, reason, userOf(c).id);
    await audit(c, 'bank.exempt', `${formatDate(e.entry_date)} ${formatMoney(e.amount)}: ${reason}`);
    return redirectWith(c, backOf(form, `/cashbook/entries/${id}/edit`), 'ok', 'Als Ausnahme ohne Kontoumsatz markiert.');
  });

  /** Rechnung bzw. Eingangsrechnung mit einem Kontoumsatz bezahlen */
  app.post('/cashbook/bank/pay', async (c) => {
    const t = bankTenant(c);
    const form = await readForm(c);
    const kind = str(form, 'kind') === 'invoice' ? 'invoice' : 'purchase';
    const id = Number(str(form, 'id'));
    const x = await txOf(c, t, Number(str(form, 'tx_id')));
    const raw = str(form, 'amount');
    const amount = raw ? parseDecimal(raw, 2) : null;
    if (raw && (amount === null || amount <= 0)) throw new UserError('Bitte einen gültigen Betrag angeben.');
    const labels = await assignItems(t, x, [{ kind, id, amount }], userOf(c).id);
    await audit(c, 'bank.assign', `${formatDate(x.booking_date)} ${formatMoney(x.amount)}: ${labels.join(', ')}`);
    const after = (await getTx(t.id, x.id))!;
    return redirectWith(c, backOf(form, kind === 'invoice' ? `/invoices/${id}` : `/purchases/${id}`), 'ok',
      `Als bezahlt gebucht (Kontoumsatz vom ${formatDate(x.booking_date)}).${after.remaining ? ` Am Umsatz sind noch ${formatMoney(after.remaining)} offen.` : ''}`);
  });
}

export const bankModule: Module = { name: 'bank', register };
