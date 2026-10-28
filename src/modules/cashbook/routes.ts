import { all, one, run, nowIso } from '../../db/index.ts';
import { audit } from '../../lib/audit.ts';
import { addDays, formatDate, isIsoDate, today } from '../../lib/dates.ts';
import { checked, html, selected, type SafeHtml } from '../../lib/html.ts';
import { idParam, notFound, readForm, redirectWith, requireOwner, str, tenantOf, userOf, UserError, type Form } from '../../lib/http.ts';
import { formatAmount, formatMoney, parseDecimal } from '../../lib/money.ts';
import { isSphere, SPHERES, sphereLabel } from '../../lib/nonprofit.ts';
import { formatIban, isValidIban, normalizeIban } from '../../lib/validate.ts';
import { balanceChart } from '../../views/chart.ts';
import { csrfField, empty, page } from '../../views/layout.ts';
import type { App, Ctx, Module, Tenant } from '../../types.ts';
import {
  accountsOf, assertOpen, balanceAt, balances, bookLinked, cashbookEnabled, createManual, createTransfer, deleteCount, deleteEntry, DENOMINATIONS,
  entriesOf, entrySphere, getAccount, history, lastCount, saveCount, SOURCE_LABELS, unassigned, updateManual,
  type CashAccount, type CashCount, type CashEntry, type EntryInput, type EntryRow, type LinkSource,
} from './repo.ts';

function cbTenant(c: Ctx): Tenant {
  const t = tenantOf(c);
  if (!cashbookEnabled(t)) throw new UserError('Das Kassenbuch gibt es für Vereine (Einstellungen → Organisation → Art „Verein“).');
  return t;
}

const KIND_LABEL = { bank: 'Bankkonto', cash: 'Bargeldkasse' } as const;
const VAT_OPTIONS = [[0, 'ohne USt.'], [700, '7 %'], [1900, '19 %']] as const;

function postButton(c: Ctx, action: string, label: string, cls = 'btn', confirm?: string): SafeHtml {
  return html`<form method="post" action="${action}" class="inline" ${confirm ? html`data-confirm="${confirm}"` : ''}>${csrfField(c)}<button class="${cls}">${label}</button></form>`;
}

export function accountSelect(accounts: CashAccount[], value?: number | null, name = 'account_id', opts: { optional?: string } = {}): SafeHtml {
  return html`<select name="${name}" ${opts.optional ? '' : html`required`} aria-label="Konto">
    ${opts.optional ? html`<option value="">${opts.optional}</option>` : ''}
    ${accounts.map((a) => html`<option value="${a.id}"${selected(a.id, value ?? '')}>${a.name}</option>`)}
  </select>`;
}

const money = (v: number) => html`<span class="num ${v < 0 ? 'neg-amount' : ''}">${formatMoney(v)}</span>`;

/** Zeitraum: laufendes Jahr = rollierende 12 Monate im Diagramm, Tabelle ab 1.1.; frühere Jahre komplett */
function rangeOf(year: number) {
  const now = today();
  const current = Number(now.slice(0, 4));
  if (year >= current) {
    // 12 volle Monate bis Ende des laufenden Monats (die Monatsspalten der x-Achse passen dann)
    const [y, m] = now.split('-').map(Number);
    const startIdx = y * 12 + (m - 1) - 11;
    const chartFrom = `${Math.floor(startIdx / 12)}-${String((startIdx % 12) + 1).padStart(2, '0')}-01`;
    const chartTo = addDays(`${m === 12 ? y + 1 : y}-${String((m % 12) + 1).padStart(2, '0')}-01`, -1);
    return { year: current, from: `${current}-01-01`, to: now, chartFrom, chartTo };
  }
  return { year, from: `${year}-01-01`, to: `${year}-12-31`, chartFrom: `${year}-01-01`, chartTo: `${year}-12-31` };
}

function entryTable(t: Tenant, rows: EntryRow[], opening: number, showAccount: boolean): SafeHtml {
  return html`<div class="card flush"><table class="table cash-table">
    <thead><tr><th>Datum</th>${showAccount ? html`<th>Konto</th>` : ''}<th>Buchung</th>${t.nonprofit ? html`<th>Bereich</th>` : ''}
      <th class="right">Einnahme</th><th class="right">Ausgabe</th><th class="right">Saldo</th></tr></thead>
    <tbody>
      <tr class="muted"><td></td>${showAccount ? html`<td></td>` : ''}<td>Anfangsbestand</td>${t.nonprofit ? html`<td></td>` : ''}<td></td><td></td><td class="right">${money(opening)}</td></tr>
      ${rows.map((r) => {
        const href = r.document_id ? `/invoices/${r.document_id}` : r.purchase_id ? `/purchases/${r.purchase_id}` : r.donation_id ? `/donations/${r.donation_id}`
          : r.count_id ? `/cashbook/counts?account=${r.account_id}` : `/cashbook/entries/${r.id}/edit`;
        const sphere = entrySphere(r, t.default_sphere);
        return html`<tr class="rowlink" data-href="${href}">
          <td>${formatDate(r.entry_date)}</td>
          ${showAccount ? html`<td>${r.account_name}</td>` : ''}
          <td><a href="${href}">${r.ref_label ?? r.text}</a>
            <div class="muted small">${SOURCE_LABELS[r.source]}${r.ref_label && r.text && r.text !== r.ref_label ? ` · ${r.text}` : ''}${r.receipt_ref ? ` · Beleg ${r.receipt_ref}` : ''}${r.vat_rate ? ` · inkl. ${r.vat_rate / 100} % USt.` : ''}</div></td>
          ${t.nonprofit ? html`<td class="small">${sphere ? SPHERES.find((s) => s.value === sphere)?.short ?? '' : '–'}</td>` : ''}
          <td class="right num">${r.amount > 0 ? formatMoney(r.amount) : ''}</td>
          <td class="right num">${r.amount < 0 ? formatMoney(-r.amount) : ''}</td>
          <td class="right">${money(r.balance)}</td>
        </tr>`;
      })}
    </tbody></table></div>`;
}

function parseEntry(form: Form, t: Tenant): EntryInput {
  const amount = parseDecimal(str(form, 'amount'), 2);
  if (amount === null || amount <= 0 || amount > 1e12) throw new UserError('Bitte einen Betrag größer 0 angeben.');
  const text = str(form, 'text', 300);
  if (!text) throw new UserError('Bitte einen Buchungstext angeben (z. B. „Getränkeverkauf Sommerfest“).');
  const sphere = str(form, 'sphere');
  const vat = Number(str(form, 'vat_rate') || 0);
  return {
    account_id: Number(str(form, 'account_id')),
    entry_date: str(form, 'entry_date'),
    amount: str(form, 'direction') === 'out' ? -amount : amount,
    text,
    receipt_ref: str(form, 'receipt_ref', 100),
    sphere: t.nonprofit && isSphere(sphere) ? sphere : '',
    vat_rate: t.small_business ? 0 : [0, 700, 1900].includes(vat) ? vat : 0,
  };
}

function sphereField(t: Tenant, value: string, name = 'sphere'): SafeHtml {
  if (!t.nonprofit) return html``;
  return html`<label>Bereich (Gemeinnützigkeit)
    <select name="${name}">${SPHERES.map((s) => html`<option value="${s.value}" title="${s.hint}"${selected(s.value, value || t.default_sphere)}>${s.label}</option>`)}</select></label>`;
}

function vatField(t: Tenant, value: number): SafeHtml {
  if (t.small_business) return html``;
  return html`<label>Enthaltene Umsatzsteuer
    <select name="vat_rate">${VAT_OPTIONS.map(([v, l]) => html`<option value="${v}"${selected(v, value)}>${l}</option>`)}</select>
    <small class="muted">z. B. 19 % bei Getränkeverkauf im wirtschaftlichen Geschäftsbetrieb</small></label>`;
}

function entryForm(c: Ctx, t: Tenant, accounts: CashAccount[], action: string, e: Partial<CashEntry>): SafeHtml {
  const out = (e.amount ?? 0) < 0;
  return html`<form method="post" action="${action}" class="card stack">
    ${csrfField(c)}
    <fieldset class="inline-radio"><legend>Art</legend>
      <label class="check"><input type="radio" name="direction" value="in"${checked(!out)}> Einnahme</label>
      <label class="check"><input type="radio" name="direction" value="out"${checked(out)}> Ausgabe</label>
    </fieldset>
    <div class="grid-2">
      <label>Konto ${accountSelect(accounts, e.account_id)}</label>
      <label>Datum <input type="date" name="entry_date" value="${e.entry_date ?? today()}" required></label>
      <label>Betrag (€) <input name="amount" class="num" inputmode="decimal" required value="${e.amount ? formatAmount(Math.abs(e.amount)).replace(/\./g, '') : ''}" placeholder="0,00"></label>
      <label>Beleg-Nr. (optional) <input name="receipt_ref" maxlength="100" value="${e.receipt_ref ?? ''}" placeholder="z. B. Quittung 12"></label>
      <label class="span-2">Buchungstext <input name="text" maxlength="300" required value="${e.text ?? ''}" placeholder="z. B. Getränkeverkauf Sommerfest, Porto, Kontoführungsgebühr"></label>
      ${sphereField(t, e.sphere ?? '')}
      ${vatField(t, e.vat_rate ?? 0)}
    </div>
    <p class="muted small">Rechnungen, Eingangsrechnungen und Spenden bitte nicht hier, sondern beim Beleg als bezahlt markieren bzw. unten unter „Noch nicht zugeordnet“ – dann ist der Beleg verknüpft.</p>
    <div class="form-actions"><button class="btn primary">Speichern</button></div>
  </form>`;
}

async function needAccounts(c: Ctx, t: Tenant): Promise<CashAccount[]> {
  const accounts = await accountsOf(t.id);
  if (!accounts.length) throw new UserError('Bitte zuerst ein Konto anlegen (Kassenbuch → Konten).');
  return accounts;
}

/** Kachel für die Übersicht: Stände aller Konten und Verlauf der letzten 12 Monate */
export async function cashbookCard(t: Tenant): Promise<SafeHtml | null> {
  if (!cashbookEnabled(t)) return null;
  const list = await balances(t.id);
  if (!list.length) return null;
  const total = list.reduce((a, x) => a + x.balance, 0);
  const r = rangeOf(Number(today().slice(0, 4)));
  const points = await history(list, r.chartFrom, r.chartTo);
  return html`<section class="card cash-card">
    <div class="cash-balances">
      ${list.map((a) => html`<a class="cash-balance" href="/cashbook?account=${a.id}"><span>${a.name}</span>${money(a.balance)}</a>`)}
      ${list.length > 1 ? html`<a class="cash-balance total" href="/cashbook"><span>Gesamt</span>${money(total)}</a>` : ''}
    </div>
    ${balanceChart(points, {
      caption: 'Kontostände',
      summary: `Heute ${formatMoney(total)} – Maus über den Verlauf zeigt den Stand je Tag`,
      emptyText: 'Noch keine Buchungen.',
      bare: true,
    })}
  </section>`;
}

function register(app: App) {
  /* ---------------- Übersicht ---------------- */
  app.get('/cashbook', async (c) => {
    const t = cbTenant(c);
    const list = await balances(t.id);
    if (!list.length) return c.redirect('/cashbook/accounts');
    const accParam = Number(c.req.query('account') ?? 0);
    const selectedAcc = list.find((a) => a.id === accParam);
    const shown = selectedAcc ? [selectedAcc] : list;
    const r = rangeOf(Number(c.req.query('year') ?? today().slice(0, 4)) || Number(today().slice(0, 4)));
    const { opening, rows, closing } = await entriesOf(shown, r.from, r.to);
    const points = await history(shown, r.chartFrom, r.chartTo);
    const open = await unassigned(t);
    const allAccounts = await accountsOf(t.id);
    const years = (await all<{ y: string }>('SELECT DISTINCT substr(entry_date, 1, 4) y FROM cash_entries WHERE tenant_id = ?', t.id)).map((x) => Number(x.y));
    const yearList = [...new Set([Number(today().slice(0, 4)), r.year, ...years])].sort((a, b) => b - a);
    const total = list.reduce((a, x) => a + x.balance, 0);
    const minus = points.find((p) => p.balance < 0 && selectedAcc?.kind === 'cash');
    const q = (acc?: number, year = r.year) => `/cashbook?${new URLSearchParams({ ...(acc ? { account: String(acc) } : {}), year: String(year) })}`;
    const income = rows.filter((x) => x.amount > 0 && x.source !== 'transfer').reduce((a, x) => a + x.amount, 0);
    const spend = rows.filter((x) => x.amount < 0 && x.source !== 'transfer').reduce((a, x) => a - x.amount, 0);
    return page(c, {
      title: 'Kassenbuch',
      actions: html`
        <a class="btn" href="/cashbook/accounts">Konten</a>
        ${list.some((a) => a.kind === 'cash') ? html`<a class="btn" href="/cashbook/count${selectedAcc?.kind === 'cash' ? `?account=${selectedAcc.id}` : ''}">Kasse zählen</a>` : ''}
        ${list.length > 1 ? html`<a class="btn" href="/cashbook/transfer">Umbuchung</a>` : ''}
        <a class="btn primary" href="/cashbook/new${selectedAcc ? `?account=${selectedAcc.id}` : ''}">Buchung erfassen</a>`,
      body: html`
      ${t.cashbook_locked_until ? html`<p class="muted small">Abgeschlossen bis ${formatDate(t.cashbook_locked_until)}.</p>` : ''}
      <div class="cash-balances tabs-like">
        ${list.length > 1 ? html`<a class="cash-balance total ${selectedAcc ? '' : 'active'}" href="${q(undefined)}"><span>Alle Konten</span>${money(total)}</a>` : ''}
        ${list.map((a) => html`<a class="cash-balance ${selectedAcc?.id === a.id || list.length === 1 ? 'active' : ''}" href="${q(a.id)}">
          <span>${a.name} <small class="muted">${KIND_LABEL[a.kind]}</small></span>${money(a.balance)}</a>`)}
      </div>
      ${minus ? html`<div class="notice">Die Kasse steht am ${formatDate(minus.date)} im Minus (${formatMoney(minus.balance)}) – eine Bargeldkasse kann nicht negativ sein. Fehlt eine Einnahme oder eine Zählung?</div>` : ''}
      ${balanceChart(points, {
        caption: html`Verlauf ${selectedAcc ? selectedAcc.name : list.length > 1 ? 'aller Konten' : list[0].name}`,
        summary: `${r.year === Number(today().slice(0, 4)) ? 'Letzte 12 Monate' : r.year} – Maus über den Verlauf zeigt den Stand je Tag`,
        emptyText: 'Noch keine Buchungen.',
      })}
      ${open.length
        ? html`<section class="card">
            <h2>Noch nicht zugeordnet <span class="count">${open.length}</span></h2>
            <p class="muted small">Bezahlte Rechnungen, Eingangsrechnungen und erfasste Spenden ohne Buchung. Konto wählen und übernehmen.</p>
            <ul class="plain assign-list">${open.slice(0, 50).map((u) => html`<li>
              <span><a href="${u.href}">${u.label}</a><span class="muted small"> · ${formatDate(u.date)}</span></span>
              <strong class="num">${formatMoney(u.amount)}</strong>
              <form method="post" action="/cashbook/assign" class="inline-form">
                ${csrfField(c)}<input type="hidden" name="source" value="${u.source}"><input type="hidden" name="id" value="${u.id}">
                <input type="hidden" name="entry_date" value="${u.date}"><input type="hidden" name="amount" value="${formatAmount(u.amount).replace(/\./g, '')}">
                ${accountSelect(allAccounts, selectedAcc?.id)}
                <button class="btn small">Übernehmen</button>
              </form></li>`)}</ul>
          </section>`
        : ''}
      <form class="toolbar" method="get">
        ${selectedAcc ? html`<input type="hidden" name="account" value="${selectedAcc.id}">` : ''}
        <select name="year" class="year-select" data-autosubmit aria-label="Jahr">${yearList.map((y) => html`<option value="${y}"${selected(y, r.year)}>${y}</option>`)}</select>
        <span class="muted small">Einnahmen ${formatMoney(income)} · Ausgaben ${formatMoney(spend)} · Endbestand ${formatMoney(closing)}</span>
        <noscript><button class="btn">OK</button></noscript>
      </form>
      ${rows.length ? entryTable(t, rows, opening, !selectedAcc && list.length > 1) : empty(`Keine Buchungen in ${r.year}.`)}`,
    });
  });

  /* ---------------- Konten ---------------- */
  app.get('/cashbook/accounts', async (c) => {
    const t = cbTenant(c);
    const list = await accountsOf(t.id, true);
    const owner = c.get('role') === 'owner';
    return page(c, {
      title: 'Konten',
      back: { href: '/cashbook', label: 'Kassenbuch' },
      body: html`
      ${list.length
        ? html`<div class="card flush"><table class="table">
            <thead><tr><th>Name</th><th>Art</th><th>IBAN</th><th>Eröffnet</th><th class="right">Anfangsbestand</th><th></th></tr></thead>
            <tbody>${list.map((a) => html`<tr class="${a.archived ? 'muted' : ''}">
              <td><a href="/cashbook/accounts/${a.id}">${a.name}</a>${a.archived ? html` <span class="tag">archiviert</span>` : ''}</td>
              <td>${KIND_LABEL[a.kind]}</td><td class="mono small">${a.iban ? formatIban(a.iban) : ''}</td>
              <td>${formatDate(a.opening_date)}</td><td class="right num">${formatMoney(a.opening_balance)}</td>
              <td class="right"><a href="/cashbook?account=${a.id}">Buchungen</a></td></tr>`)}</tbody></table></div>`
        : html`<div class="notice soft">Lege zuerst die Konten des Vereins an – z. B. das Girokonto und die Barkasse(n). Der Anfangsbestand ist der Stand am Eröffnungstag (z. B. 01.01. laut Kontoauszug bzw. Kassenzählung).</div>`}
      <div class="detail-grid">
        <section class="card">
          <h2>Neues Konto</h2>
          ${accountForm(c, '/cashbook/accounts', {})}
        </section>
        ${owner
          ? html`<section class="card">
              <h2>Kassenbuch abschließen</h2>
              <p class="muted small">Nach dem Abschluss (z. B. zum Jahresende, wenn alles ans Steuerbüro ging) lassen sich Buchungen und Zählungen bis zu diesem Tag nicht mehr ändern.
                ${t.cashbook_locked_until ? html`Derzeit abgeschlossen bis <strong>${formatDate(t.cashbook_locked_until)}</strong>.` : ''}</p>
              <form method="post" action="/cashbook/lock" class="inline-form" data-confirm="Kassenbuch bis zu diesem Tag abschließen? Das lässt sich nicht rückgängig machen.">
                ${csrfField(c)}
                <input type="date" name="date" value="${`${Number(today().slice(0, 4)) - 1}-12-31`}" required aria-label="Abschließen bis">
                <button class="btn">Abschließen</button>
              </form>
            </section>`
          : ''}
      </div>`,
    });
  });

  function accountForm(c: Ctx, action: string, a: Partial<CashAccount>): SafeHtml {
    return html`<form method="post" action="${action}" class="stack">
      ${csrfField(c)}
      <label>Name <input name="name" maxlength="100" required value="${a.name ?? ''}" placeholder="z. B. Girokonto Sparkasse, Barkasse Vereinsheim"></label>
      <label>Art <select name="kind">${(['bank', 'cash'] as const).map((k) => html`<option value="${k}"${selected(k, a.kind ?? 'bank')}>${KIND_LABEL[k]}</option>`)}</select></label>
      <label>IBAN (optional) <input name="iban" maxlength="40" value="${a.iban ? formatIban(a.iban) : ''}"></label>
      <div class="grid-2">
        <label>Eröffnet am <input type="date" name="opening_date" required value="${a.opening_date ?? `${today().slice(0, 4)}-01-01`}"></label>
        <label>Anfangsbestand (€) <input name="opening_balance" class="num" inputmode="decimal" value="${a.opening_balance !== undefined ? formatAmount(a.opening_balance).replace(/\./g, '') : '0,00'}"></label>
      </div>
      <button class="btn primary">Speichern</button>
    </form>`;
  }

  function parseAccount(form: Form) {
    const name = str(form, 'name', 100);
    const kind = str(form, 'kind') === 'cash' ? 'cash' : 'bank';
    const iban = normalizeIban(str(form, 'iban', 40));
    const opening_date = str(form, 'opening_date');
    const opening_balance = parseDecimal(str(form, 'opening_balance') || '0', 2);
    const errors: string[] = [];
    if (!name) errors.push('Bitte einen Namen angeben.');
    if (iban && !isValidIban(iban)) errors.push('Die IBAN ist ungültig.');
    if (!isIsoDate(opening_date)) errors.push('Bitte ein gültiges Eröffnungsdatum angeben.');
    if (opening_balance === null) errors.push('Ungültiger Anfangsbestand.');
    if (errors.length) throw new UserError(errors.join(' '));
    return { name, kind, iban, opening_date, opening_balance: opening_balance! };
  }

  app.post('/cashbook/accounts', async (c) => {
    const t = cbTenant(c);
    const a = parseAccount(await readForm(c));
    assertOpen(t, a.opening_date);
    const res = await run(
      'INSERT INTO cash_accounts (tenant_id, name, kind, iban, opening_date, opening_balance, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
      t.id, a.name, a.kind, a.iban, a.opening_date, a.opening_balance, nowIso(),
    );
    await audit(c, 'cashbook.account.create', a.name);
    return redirectWith(c, `/cashbook?account=${res.insertId}`, 'ok', `Konto „${a.name}“ angelegt.`);
  });

  app.get('/cashbook/accounts/:id', async (c) => {
    const t = cbTenant(c);
    const a = await getAccount(t.id, idParam(c)) ?? notFound();
    const used = await one('SELECT 1 FROM cash_entries WHERE account_id = ? UNION ALL SELECT 1 FROM cash_counts WHERE account_id = ? LIMIT 1', a.id, a.id);
    return page(c, {
      title: a.name,
      back: { href: '/cashbook/accounts', label: 'Konten' },
      body: html`<section class="card narrow">${accountForm(c, `/cashbook/accounts/${a.id}`, a)}</section>
      <div class="danger-zone">
        ${postButton(c, `/cashbook/accounts/${a.id}/archive`, a.archived ? 'Aus Archiv holen' : 'Archivieren', 'btn ghost')}
        ${used ? '' : postButton(c, `/cashbook/accounts/${a.id}/delete`, 'Löschen', 'btn danger', 'Konto löschen?')}
      </div>`,
    });
  });

  app.post('/cashbook/accounts/:id', async (c) => {
    const t = cbTenant(c);
    const a = await getAccount(t.id, idParam(c)) ?? notFound();
    const v = parseAccount(await readForm(c));
    if (v.opening_date !== a.opening_date || v.opening_balance !== a.opening_balance) assertOpen(t, a.opening_date, v.opening_date);
    const first = await one<{ d: string | null }>('SELECT MIN(entry_date) d FROM cash_entries WHERE account_id = ?', a.id);
    if (first?.d && v.opening_date > String(first.d)) throw new UserError(`Es gibt Buchungen ab ${formatDate(String(first.d))} – das Eröffnungsdatum muss davor liegen.`);
    await run('UPDATE cash_accounts SET name = ?, kind = ?, iban = ?, opening_date = ?, opening_balance = ? WHERE id = ?', v.name, v.kind, v.iban, v.opening_date, v.opening_balance, a.id);
    await audit(c, 'cashbook.account.update', `${v.name}: Anfangsbestand ${formatMoney(v.opening_balance)} am ${formatDate(v.opening_date)}`);
    return redirectWith(c, '/cashbook/accounts', 'ok', 'Konto gespeichert.');
  });

  app.post('/cashbook/accounts/:id/archive', async (c) => {
    const t = cbTenant(c);
    const a = await getAccount(t.id, idParam(c)) ?? notFound();
    await run('UPDATE cash_accounts SET archived = ? WHERE id = ?', a.archived ? 0 : 1, a.id);
    return redirectWith(c, '/cashbook/accounts', 'ok', a.archived ? 'Konto wiederhergestellt.' : 'Konto archiviert.');
  });

  app.post('/cashbook/accounts/:id/delete', async (c) => {
    const t = cbTenant(c);
    const a = await getAccount(t.id, idParam(c)) ?? notFound();
    if (await one('SELECT 1 FROM cash_entries WHERE account_id = ? UNION ALL SELECT 1 FROM cash_counts WHERE account_id = ? LIMIT 1', a.id, a.id)) {
      throw new UserError('Konten mit Buchungen lassen sich nur archivieren.');
    }
    await run('DELETE FROM cash_accounts WHERE id = ?', a.id);
    return redirectWith(c, '/cashbook/accounts', 'ok', 'Konto gelöscht.');
  });

  app.post('/cashbook/lock', async (c) => {
    requireOwner(c);
    const t = cbTenant(c);
    const date = str(await readForm(c), 'date');
    if (!isIsoDate(date) || date > today()) throw new UserError('Bitte ein gültiges Datum (nicht in der Zukunft) angeben.');
    if (t.cashbook_locked_until && date <= t.cashbook_locked_until) throw new UserError(`Bereits abgeschlossen bis ${formatDate(t.cashbook_locked_until)}.`);
    await run('UPDATE tenants SET cashbook_locked_until = ? WHERE id = ?', date, t.id);
    await audit(c, 'cashbook.lock', formatDate(date));
    return redirectWith(c, '/cashbook/accounts', 'ok', `Kassenbuch bis ${formatDate(date)} abgeschlossen.`);
  });

  /* ---------------- Freie Buchungen ---------------- */
  app.get('/cashbook/new', async (c) => {
    const t = cbTenant(c);
    const accounts = await needAccounts(c, t);
    return page(c, {
      title: 'Buchung erfassen',
      back: { href: '/cashbook', label: 'Kassenbuch' },
      body: entryForm(c, t, accounts, '/cashbook/entries', { account_id: Number(c.req.query('account') ?? 0) || accounts[0].id }),
    });
  });

  app.post('/cashbook/entries', async (c) => {
    const t = cbTenant(c);
    const e = parseEntry(await readForm(c), t);
    await createManual(t, e, userOf(c).id);
    return redirectWith(c, `/cashbook?account=${e.account_id}&year=${e.entry_date.slice(0, 4)}`, 'ok', 'Buchung gespeichert.');
  });

  app.get('/cashbook/entries/:id/edit', async (c) => {
    const t = cbTenant(c);
    const e = await one<CashEntry>('SELECT * FROM cash_entries WHERE tenant_id = ? AND id = ?', t.id, idParam(c)) ?? notFound();
    const accounts = await accountsOf(t.id, true);
    const locked = !!t.cashbook_locked_until && e.entry_date <= t.cashbook_locked_until;
    return page(c, {
      title: e.source === 'transfer' ? 'Umbuchung' : 'Buchung bearbeiten',
      back: { href: `/cashbook?account=${e.account_id}&year=${e.entry_date.slice(0, 4)}`, label: 'Kassenbuch' },
      body: html`
      ${locked ? html`<div class="notice">Abgeschlossen – diese Buchung lässt sich nicht mehr ändern.</div>` : ''}
      ${e.source === 'manual' && !locked
        ? entryForm(c, t, accounts, `/cashbook/entries/${e.id}`, e)
        : html`<section class="card"><dl class="dl">
            <dt>Datum</dt><dd>${formatDate(e.entry_date)}</dd><dt>Text</dt><dd>${e.text}</dd><dt>Betrag</dt><dd>${money(e.amount)}</dd>
            ${e.sphere ? html`<dt>Bereich</dt><dd>${sphereLabel(e.sphere)}</dd>` : ''}</dl></section>`}
      ${!locked && (e.source === 'manual' || e.source === 'transfer')
        ? html`<div class="danger-zone">${postButton(c, `/cashbook/entries/${e.id}/delete`, e.source === 'transfer' ? 'Umbuchung löschen' : 'Buchung löschen', 'btn danger', 'Wirklich löschen?')}</div>`
        : ''}`,
    });
  });

  app.post('/cashbook/entries/:id', async (c) => {
    const t = cbTenant(c);
    const e = await one<CashEntry>('SELECT * FROM cash_entries WHERE tenant_id = ? AND id = ?', t.id, idParam(c)) ?? notFound();
    const input = parseEntry(await readForm(c), t);
    await updateManual(t, e, input);
    await audit(c, 'cashbook.entry.update', `${formatDate(e.entry_date)} ${formatMoney(e.amount)} → ${formatDate(input.entry_date)} ${formatMoney(input.amount)}: ${input.text}`);
    return redirectWith(c, `/cashbook?account=${input.account_id}&year=${input.entry_date.slice(0, 4)}`, 'ok', 'Buchung gespeichert.');
  });

  app.post('/cashbook/entries/:id/delete', async (c) => {
    const t = cbTenant(c);
    const e = await one<CashEntry>('SELECT * FROM cash_entries WHERE tenant_id = ? AND id = ?', t.id, idParam(c)) ?? notFound();
    await deleteEntry(t, e);
    await audit(c, 'cashbook.entry.delete', `${formatDate(e.entry_date)} ${formatMoney(e.amount)}: ${e.text}`);
    return redirectWith(c, `/cashbook?account=${e.account_id}&year=${e.entry_date.slice(0, 4)}`, 'ok', 'Buchung gelöscht.');
  });

  /* ---------------- Zuordnen ---------------- */
  app.post('/cashbook/assign', async (c) => {
    const t = cbTenant(c);
    const form = await readForm(c);
    const source = str(form, 'source') as LinkSource;
    const id = Number(str(form, 'id'));
    const amount = parseDecimal(str(form, 'amount'), 2);
    if (!['invoice', 'purchase', 'donation'].includes(source) || !id || amount === null) throw new UserError('Ungültige Zuordnung.');
    const table = { invoice: 'documents', purchase: 'purchase_invoices', donation: 'donations' }[source];
    if (!await one(`SELECT 1 FROM ${table} WHERE id = ? AND tenant_id = ?`, id, t.id)) notFound();
    await bookLinked(t, source, id, { account_id: Number(str(form, 'account_id')), entry_date: str(form, 'entry_date'), amount, text: '' }, userOf(c).id);
    return redirectWith(c, `/cashbook?account=${str(form, 'account_id')}`, 'ok', 'Zugeordnet.');
  });

  /* ---------------- Umbuchung ---------------- */
  app.get('/cashbook/transfer', async (c) => {
    const t = cbTenant(c);
    const accounts = await needAccounts(c, t);
    return page(c, {
      title: 'Umbuchung',
      back: { href: '/cashbook', label: 'Kassenbuch' },
      body: html`<form method="post" action="/cashbook/transfer" class="card stack narrow">
        ${csrfField(c)}
        <p class="muted small">Geld wechselt das Konto, z. B. Bareinzahlung aus der Kasse aufs Girokonto oder Abhebung für das Wechselgeld. Keine Einnahme, keine Ausgabe.</p>
        <div class="grid-2">
          <label>Von ${accountSelect(accounts, accounts.find((a) => a.kind === 'cash')?.id, 'from_id')}</label>
          <label>Nach ${accountSelect(accounts, accounts.find((a) => a.kind === 'bank')?.id, 'to_id')}</label>
          <label>Datum <input type="date" name="entry_date" value="${today()}" required></label>
          <label>Betrag (€) <input name="amount" class="num" inputmode="decimal" required placeholder="0,00"></label>
          <label class="span-2">Text (optional) <input name="text" maxlength="300" placeholder="z. B. Bareinzahlung Sommerfest"></label>
        </div>
        <button class="btn primary">Umbuchen</button>
      </form>`,
    });
  });

  app.post('/cashbook/transfer', async (c) => {
    const t = cbTenant(c);
    const form = await readForm(c);
    const amount = parseDecimal(str(form, 'amount'), 2);
    await createTransfer(t, Number(str(form, 'from_id')), Number(str(form, 'to_id')), str(form, 'entry_date'), amount ?? 0, str(form, 'text', 300), userOf(c).id);
    return redirectWith(c, '/cashbook', 'ok', 'Umbuchung gespeichert.');
  });

  /* ---------------- Kassenzählung ---------------- */
  app.get('/cashbook/count', async (c) => {
    const t = cbTenant(c);
    const cash = (await accountsOf(t.id)).filter((a) => a.kind === 'cash');
    if (!cash.length) throw new UserError('Lege zuerst eine Bargeldkasse an (Kassenbuch → Konten).');
    const acc = cash.find((a) => a.id === Number(c.req.query('account') ?? 0)) ?? cash[0];
    const last = await lastCount(acc.id);
    const book = await balanceAt(acc, today());
    return page(c, {
      title: 'Kasse zählen',
      back: { href: `/cashbook?account=${acc.id}`, label: 'Kassenbuch' },
      actions: html`<a class="btn" href="/cashbook/counts?account=${acc.id}">Zählprotokolle</a>`,
      body: html`<form method="post" action="/cashbook/count" class="card stack" data-count-form>
        ${csrfField(c)}
        <div class="grid-2">
          <label>Kasse ${accountSelect(cash, acc.id)}</label>
          <label>Datum der Zählung <input type="date" name="count_date" value="${today()}" max="${today()}" required></label>
        </div>
        <p class="muted small">Buchbestand heute: <strong>${formatMoney(book)}</strong>${last ? html` · letzte Zählung ${formatDate(last.count_date)}: ${formatMoney(last.counted)}` : ''}.
          Die Differenz zwischen gezähltem Bestand und Buchbestand am Zähltag wird gebucht – z. B. als Einnahmen aus dem Getränkeverkauf, für die es keine Einzelbelege gibt.</p>
        <fieldset class="inline-radio">
          <legend>Erfassen als</legend>
          <label class="check"><input type="radio" name="count_mode" value="total" checked> Gesamtsumme</label>
          <label class="check"><input type="radio" name="count_mode" value="denominations"> nach Stückelung (Scheine und Münzen)</label>
        </fieldset>
        <label data-show-if="count_mode=total">Gezählter Bestand (€)
          <input name="counted_total" class="num" inputmode="decimal" placeholder="0,00" aria-describedby="count-hint">
          <small class="muted" id="count-hint">Gesamter Kasseninhalt am Zähltag – nicht nur die Einnahmen seit der letzten Zählung.</small></label>
        <table class="table count-table" data-show-if="count_mode=denominations">
          <thead><tr><th>Stückelung</th><th class="w-qty">Anzahl</th><th class="right">Summe</th></tr></thead>
          <tbody>${DENOMINATIONS.map((d) => html`<tr>
            <td>${d >= 500 ? `${d / 100} €-Schein` : d >= 100 ? `${d / 100} €-Münze` : `${d} Cent`}</td>
            <td><input name="d_${d}" type="number" min="0" step="1" inputmode="numeric" class="num" data-denom="${d}" aria-label="Anzahl ${formatMoney(d)}"></td>
            <td class="right num" data-denom-sum>–</td></tr>`)}</tbody>
          <tfoot><tr><th>Gezählt</th><th></th><th class="right num" data-count-total>0,00 €</th></tr></tfoot>
        </table>
        <div class="grid-2">
          <label class="span-2">Buchungstext für die Differenz <input name="text" maxlength="300" placeholder="z. B. Getränkeverkauf Vereinsheim Oktober"></label>
          ${sphereField(t, 'business')}
          ${vatField(t, t.small_business ? 0 : 1900)}
          <label class="span-2">Notiz (optional) <input name="note" maxlength="300" placeholder="z. B. gezählt von Kai Kasse und Vera Vorstand"></label>
        </div>
        <div class="form-actions"><button class="btn primary">Zählung speichern</button></div>
      </form>`,
    });
  });

  app.post('/cashbook/count', async (c) => {
    const t = cbTenant(c);
    const form = await readForm(c);
    const a = await getAccount(t.id, Number(str(form, 'account_id'))) ?? notFound();
    const denominations: Record<string, number> = {};
    let counted: number | undefined;
    if (str(form, 'count_mode') === 'denominations') {
      for (const d of DENOMINATIONS) {
        const n = Number(str(form, `d_${d}`) || 0);
        if (!Number.isInteger(n) || n < 0 || n > 1e6) throw new UserError('Bitte bei der Stückelung nur ganze Zahlen eintragen.');
        if (n) denominations[d] = n;
      }
      if (!Object.keys(denominations).length) throw new UserError('Bitte die Anzahl der Scheine und Münzen eintragen – oder „Gesamtsumme“ wählen.');
    } else {
      const v = parseDecimal(str(form, 'counted_total'), 2);
      if (v === null || v < 0 || v > 1e12) throw new UserError('Bitte den gezählten Gesamtbestand in Euro angeben (0 ist erlaubt).');
      counted = v;
    }
    const sphere = str(form, 'sphere');
    const vat = Number(str(form, 'vat_rate') || 0);
    const { difference } = await saveCount(t, a, {
      date: str(form, 'count_date'), denominations, counted, note: str(form, 'note', 300), text: str(form, 'text', 300),
      sphere: t.nonprofit && isSphere(sphere) ? sphere : '', vat_rate: t.small_business ? 0 : [0, 700, 1900].includes(vat) ? vat : 0,
    }, userOf(c).id);
    await audit(c, 'cashbook.count', `${a.name}: Differenz ${formatMoney(difference)}`);
    return redirectWith(c, `/cashbook?account=${a.id}`, 'ok',
      difference === 0 ? 'Zählung gespeichert – Kasse stimmt mit dem Buchbestand überein.'
        : `Zählung gespeichert. Differenz ${formatMoney(difference)} wurde als ${difference > 0 ? 'Einnahme' : 'Ausgabe'} gebucht.`);
  });

  app.get('/cashbook/counts', async (c) => {
    const t = cbTenant(c);
    const cash = (await accountsOf(t.id, true)).filter((a) => a.kind === 'cash');
    const acc = cash.find((a) => a.id === Number(c.req.query('account') ?? 0)) ?? cash[0];
    if (!acc) throw new UserError('Es gibt noch keine Bargeldkasse.');
    const counts = await all<CashCount>('SELECT * FROM cash_counts WHERE account_id = ? ORDER BY count_date DESC, id DESC', acc.id);
    const lastId = counts[0]?.id;
    return page(c, {
      title: `Zählprotokolle ${acc.name}`,
      back: { href: `/cashbook?account=${acc.id}`, label: 'Kassenbuch' },
      actions: html`<a class="btn primary" href="/cashbook/count?account=${acc.id}">Kasse zählen</a>`,
      body: counts.length
        ? html`<div class="card flush"><table class="table">
            <thead><tr><th>Datum</th><th>Stückelung</th><th class="right">Buchbestand</th><th class="right">Gezählt</th><th class="right">Differenz</th><th></th></tr></thead>
            <tbody>${counts.map((k) => {
              const den = JSON.parse(k.denominations) as Record<string, number>;
              return html`<tr>
                <td>${formatDate(k.count_date)}${k.note ? html`<div class="muted small">${k.note}</div>` : ''}</td>
                <td class="small">${Object.entries(den).sort((a, b) => Number(b[0]) - Number(a[0])).map(([d, n]) => `${n} × ${formatMoney(Number(d))}`).join(', ') || html`<span class="muted">nur Gesamtsumme</span>`}</td>
                <td class="right num">${formatMoney(k.book_balance)}</td>
                <td class="right num">${formatMoney(k.counted)}</td>
                <td class="right">${money(k.difference)}</td>
                <td class="right">${k.id === lastId && !(t.cashbook_locked_until && k.count_date <= t.cashbook_locked_until)
                  ? postButton(c, `/cashbook/counts/${k.id}/delete`, 'Löschen', 'link danger', 'Zählung samt Differenzbuchung löschen?') : ''}</td>
              </tr>`;
            })}</tbody></table></div>`
        : empty('Noch keine Zählungen.'),
    });
  });

  app.post('/cashbook/counts/:id/delete', async (c) => {
    const t = cbTenant(c);
    const k = await one<CashCount & { tenant_id: number }>('SELECT * FROM cash_counts WHERE tenant_id = ? AND id = ?', t.id, idParam(c)) ?? notFound();
    const a = (await getAccount(t.id, k.account_id))!;
    await deleteCount(t, a, k);
    await audit(c, 'cashbook.count.delete', `${a.name} ${formatDate(k.count_date)}`);
    return redirectWith(c, `/cashbook/counts?account=${a.id}`, 'ok', 'Zählung gelöscht.');
  });
}

export const cashbookModule: Module = {
  name: 'cashbook',
  nav: { label: 'Kassenbuch', href: '/cashbook', order: 34, visible: (t) => cashbookEnabled(t) },
  register,
};
