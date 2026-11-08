import { all, one, run, tx, nowIso } from '../../db/index.ts';
import { compact, dayDistance, mentions, type BankTx } from '../../lib/banktx.ts';
import { formatDate, isIsoDate, today } from '../../lib/dates.ts';
import { UserError } from '../../lib/http.ts';
import { getSetting } from '../../lib/audit.ts';
import { formatMoney } from '../../lib/money.ts';
import type { Tenant } from '../../types.ts';
import { bookLinked, createManual, getAccount, linkedEntry, liveSql, type CashAccount } from '../cashbook/repo.ts';
import { getPurchase, payable, setPaid } from '../purchases/repo.ts';

/**
 * Bankanbindung: Zugang je Bankkonto (FinTS), abgerufene Kontoumsätze und der Abgleich mit dem
 * Kassenbuch. Ein Kontoumsatz umfasst eine oder mehrere Buchungen (bank_tx_entries) – z. B. eine
 * Überweisung für zwei Rechnungen oder eine Auszahlung abzüglich Gebühr. Er ist erledigt, sobald die
 * Summe seiner (nicht stornierten) Buchungen seinem Betrag entspricht, oder wenn er ignoriert wird.
 *
 * Umgekehrt braucht auf einem Bankkonto ab dem Tag „Abgleich ab“ (cash_accounts.reconcile_from) jede
 * Buchung einen Kontoumsatz – außer sie ist als Ausnahme markiert (bank_exemptions), storniert, eine
 * Kassenzählung oder liegt in einem abgeschlossenen Zeitraum.
 */

export interface BankConnection {
  id: number;
  tenant_id: number;
  account_id: number;
  blz: string;
  url: string;
  login: string;
  customer_id: string;
  tan_method_id: number | null;
  tan_media: string;
  banking_info: string | null;
  bank_balance: number | null;
  bank_balance_date: string | null;
  fetched_until: string | null;
  last_fetch_at: string | null;
}

export interface BankTxRow extends BankTx {
  id: number;
  account_id: number;
  ignored_at: string | null;
  /** Summe der zugeordneten, nicht stornierten Buchungen */
  linked: number;
  /** noch zuzuordnen (Betrag − linked) */
  remaining: number;
  links: number;
}

/** Bei Banken der genossenschaftlichen FinanzGruppe (Volks- und Raiffeisenbanken, Rechenzentrum Atruvia) */
export const VR_FINTS_URL = 'https://fints1.atruvia.de/cgi-bin/hbciservlet';
export const FINTS_REGISTRATION_URL = 'https://www.fints.org/de/hersteller/produktregistrierung';

/** FinTS-Produkt-ID: aus der Administration, sonst aus SCHOTTR_FINTS_PRODUCT_ID */
export async function finTsProductId(): Promise<string> {
  return ((await getSetting('fints_product_id')) || process.env.SCHOTTR_FINTS_PRODUCT_ID || '').trim();
}

/* ---------------- Bankzugang ---------------- */

export async function connectionOf(tenantId: number, accountId: number) {
  const r = await one<BankConnection>('SELECT * FROM bank_connections WHERE tenant_id = ? AND account_id = ?', tenantId, accountId);
  return r ? { ...r, bank_balance: r.bank_balance === null ? null : Number(r.bank_balance) } : undefined;
}

export async function saveConnection(t: Tenant, accountId: number, v: { blz: string; url: string; login: string; customer_id: string }) {
  const now = nowIso();
  const existing = await connectionOf(t.id, accountId);
  if (existing) {
    // anderer Zugang → gespeicherte Bankparameter und TAN-Verfahren gelten nicht mehr
    const reset = existing.blz !== v.blz || existing.url !== v.url || existing.login !== v.login || existing.customer_id !== v.customer_id;
    await run(
      `UPDATE bank_connections SET blz = ?, url = ?, login = ?, customer_id = ?, updated_at = ?
       ${reset ? ", banking_info = NULL, tan_method_id = NULL, tan_media = ''" : ''} WHERE id = ?`,
      v.blz, v.url, v.login, v.customer_id, now, existing.id,
    );
  } else {
    await run(
      'INSERT INTO bank_connections (tenant_id, account_id, blz, url, login, customer_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
      t.id, accountId, v.blz, v.url, v.login, v.customer_id, now, now,
    );
  }
}

export async function updateConnection(id: number, fields: Partial<Pick<BankConnection, 'banking_info' | 'tan_method_id' | 'tan_media' | 'bank_balance' | 'bank_balance_date' | 'fetched_until' | 'last_fetch_at'>>) {
  const keys = Object.keys(fields) as (keyof typeof fields)[];
  if (!keys.length) return;
  await run(`UPDATE bank_connections SET ${keys.map((k) => `${k} = ?`).join(', ')}, updated_at = ? WHERE id = ?`, ...keys.map((k) => fields[k] ?? null), nowIso(), id);
}

/** „Abgleich ab“ setzen (leer = kein Abgleich für dieses Konto) */
export async function setReconcileFrom(t: Tenant, account: CashAccount, date: string | null) {
  if (date !== null && !isIsoDate(date)) throw new UserError('Bitte ein gültiges Datum angeben.');
  await run('UPDATE cash_accounts SET reconcile_from = ? WHERE tenant_id = ? AND id = ?', date, t.id, account.id);
}

/** Nach dem ersten Abruf: Abgleich ab dem Startdatum, sofern noch nichts eingestellt ist */
export async function initReconcileFrom(accountId: number, from: string) {
  await run("UPDATE cash_accounts SET reconcile_from = ? WHERE id = ? AND kind = 'bank' AND reconcile_from IS NULL", from, accountId);
}

/** Umsätze speichern; bereits bekannte (gleicher Fingerabdruck) werden übersprungen */
export async function importTransactions(t: Pick<Tenant, 'id'>, account: CashAccount, list: BankTx[]): Promise<{ added: number; total: number }> {
  let added = 0;
  const now = nowIso();
  // Umsätze vor Eröffnung des Kontos im Kassenbuch gehören in den Anfangsbestand
  const relevant = list.filter((x) => x.booking_date >= account.opening_date);
  await tx(async () => {
    for (const x of relevant) {
      const res = await run(
        `INSERT IGNORE INTO bank_transactions (tenant_id, account_id, fingerprint, booking_date, value_date, amount, remote_name, remote_iban, purpose, booking_text, e2e_ref, mandate_ref, bank_ref, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        t.id, account.id, x.fingerprint, x.booking_date, x.value_date, x.amount, x.remote_name, x.remote_iban, x.purpose, x.booking_text, x.e2e_ref, x.mandate_ref, x.bank_ref, now,
      );
      added += res.affectedRows;
    }
  });
  return { added, total: relevant.length };
}

/* ---------------- Umsätze lesen ---------------- */

/** Summe und Anzahl der nicht stornierten Buchungen eines Umsatzes (Alias des Umsatzes: b) */
const LINKED = `COALESCE((SELECT SUM(le.amount) FROM bank_tx_entries l JOIN cash_entries le ON le.id = l.entry_id WHERE l.tx_id = b.id AND ${liveSql('le')}), 0)`;
const LINKS = `(SELECT COUNT(*) FROM bank_tx_entries l JOIN cash_entries le ON le.id = l.entry_id WHERE l.tx_id = b.id AND ${liveSql('le')})`;

function txRow(r: BankTxRow): BankTxRow {
  const amount = Number(r.amount);
  const linked = Number(r.linked);
  return { ...r, amount, linked, remaining: amount - linked, links: Number(r.links) };
}

export type TxFilter = 'open' | 'done' | 'ignored';
const FILTER: Record<TxFilter, string> = {
  open: 'b.ignored_at IS NULL HAVING linked <> b.amount',
  done: 'b.ignored_at IS NULL HAVING linked = b.amount',
  ignored: 'b.ignored_at IS NOT NULL',
};

export async function transactionsOf(account: CashAccount, filter: TxFilter, limit = 300): Promise<BankTxRow[]> {
  const rows = await all<BankTxRow>(
    `SELECT b.*, ${LINKED} linked, ${LINKS} links FROM bank_transactions b WHERE b.account_id = ? AND ${FILTER[filter]}
     ORDER BY b.booking_date ${filter === 'open' ? 'ASC' : 'DESC'}, b.id LIMIT ${limit}`, account.id,
  );
  return rows.map(txRow);
}

export async function getTx(tenantId: number, id: number) {
  const r = await one<BankTxRow>(`SELECT b.*, ${LINKED} linked, ${LINKS} links FROM bank_transactions b WHERE b.tenant_id = ? AND b.id = ?`, tenantId, id);
  return r ? txRow(r) : undefined;
}

/** Offene Umsätze je Konto */
export async function openCounts(tenantId: number): Promise<Map<number, number>> {
  const rows = await all<{ account_id: number; n: number }>(
    `SELECT account_id, COUNT(*) n FROM (SELECT b.account_id, b.amount, ${LINKED} linked FROM bank_transactions b WHERE b.tenant_id = ? AND b.ignored_at IS NULL) x
     WHERE linked <> amount GROUP BY account_id`, tenantId,
  );
  return new Map(rows.map((r) => [Number(r.account_id), Number(r.n)]));
}

/** Offene Umsätze (Rest ≠ 0) – für die Auswahl an einer Buchung bzw. Rechnung */
export async function openTxOf(tenantId: number, accountIds: number[]): Promise<BankTxRow[]> {
  if (!accountIds.length) return [];
  const rows = await all<BankTxRow>(
    `SELECT b.*, ${LINKED} linked, ${LINKS} links FROM bank_transactions b
     WHERE b.tenant_id = ? AND b.account_id IN (${accountIds.map(() => '?').join(', ')}) AND b.ignored_at IS NULL HAVING linked <> b.amount
     ORDER BY b.booking_date DESC, b.id LIMIT 500`, tenantId, ...accountIds,
  );
  return rows.map(txRow);
}

export interface TxLink {
  tx_id: number;
  entry_id: number;
  entry_date: string;
  amount: number;
  label: string;
  href: string;
  voided: boolean;
}

/** Buchungen zu Umsätzen, mit Bezeichnung (Rechnung, Eingangsrechnung, Zuwendung oder Buchungstext) */
export async function linksOf(txIds: number[]): Promise<Map<number, TxLink[]>> {
  const out = new Map<number, TxLink[]>();
  if (!txIds.length) return out;
  const rows = await all<{ tx_id: number; id: number; entry_date: string; amount: number; source: string; document_id: number | null; purchase_id: number | null;
    donation_id: number | null; text: string; doc: string | null; pur: string | null; party: string | null; live: number }>(
    `SELECT l.tx_id, e.id, e.entry_date, e.amount, e.source, e.document_id, e.purchase_id, e.donation_id, e.text, d.number doc,
       COALESCE(NULLIF(p.number, ''), NULLIF(p.internal_ref, '')) pur, COALESCE(NULLIF(c.company, ''), c.name) party, (${liveSql('e')}) live
     FROM bank_tx_entries l JOIN cash_entries e ON e.id = l.entry_id
     LEFT JOIN documents d ON d.id = e.document_id LEFT JOIN purchase_invoices p ON p.id = e.purchase_id
     LEFT JOIN donations dn ON dn.id = e.donation_id
     LEFT JOIN contacts c ON c.id = COALESCE(d.contact_id, p.contact_id, dn.contact_id, e.contact_id)
     WHERE l.tx_id IN (${txIds.map(() => '?').join(', ')}) ORDER BY e.entry_date, e.id`, ...txIds,
  );
  for (const r of rows) {
    const label = r.document_id ? `Rechnung ${r.doc ?? ''}` : r.purchase_id ? `Eingangsrechnung ${r.pur ?? ''}` : r.donation_id ? 'Zuwendung' : r.text || 'Buchung';
    const href = r.document_id ? `/invoices/${r.document_id}` : r.purchase_id ? `/purchases/${r.purchase_id}` : r.donation_id ? `/donations/${r.donation_id}` : `/cashbook/entries/${r.id}/edit`;
    const list = out.get(Number(r.tx_id)) ?? [];
    list.push({ tx_id: Number(r.tx_id), entry_id: r.id, entry_date: String(r.entry_date), amount: Number(r.amount),
      label: `${label.trim()}${r.party && !r.text.includes(r.party) ? ` · ${r.party}` : ''}`, href, voided: !Number(r.live) });
    out.set(Number(r.tx_id), list);
  }
  return out;
}

/* ---------------- Buchungen ohne Kontoumsatz ---------------- */

export interface Unmatched {
  id: number;
  account_id: number;
  account_name: string;
  entry_date: string;
  amount: number;
  label: string;
  href: string;
}

/** Bedingung „braucht einen Kontoumsatz“ für eine Buchung e mit Konto a */
const NEEDS_TX = `a.kind = 'bank' AND a.reconcile_from IS NOT NULL AND e.entry_date >= a.reconcile_from
  AND e.entry_date > COALESCE(t.cashbook_locked_until, '0000-01-01') AND e.source <> 'count' AND ${liveSql('e')}
  AND NOT EXISTS (SELECT 1 FROM bank_tx_entries l WHERE l.entry_id = e.id)
  AND NOT EXISTS (SELECT 1 FROM bank_exemptions x WHERE x.entry_id = e.id)`;

const ENTRY_LABEL = `CASE WHEN e.document_id IS NOT NULL THEN CONCAT('Rechnung ', COALESCE(d.number, ''))
  WHEN e.purchase_id IS NOT NULL THEN CONCAT('Eingangsrechnung ', COALESCE(NULLIF(p.number, ''), p.internal_ref, ''))
  WHEN e.donation_id IS NOT NULL THEN 'Zuwendung' ELSE e.text END`;

export async function unmatchedEntries(tenantId: number, accountId?: number, limit = 500): Promise<Unmatched[]> {
  const rows = await all<Unmatched & { source: string; document_id: number | null; purchase_id: number | null; donation_id: number | null; party: string | null }>(
    `SELECT e.id, e.account_id, a.name account_name, e.entry_date, e.amount, e.source, e.document_id, e.purchase_id, e.donation_id, ${ENTRY_LABEL} label,
       COALESCE(NULLIF(c.company, ''), c.name) party
     FROM cash_entries e JOIN cash_accounts a ON a.id = e.account_id JOIN tenants t ON t.id = e.tenant_id
     LEFT JOIN documents d ON d.id = e.document_id LEFT JOIN purchase_invoices p ON p.id = e.purchase_id
     LEFT JOIN donations dn ON dn.id = e.donation_id
     LEFT JOIN contacts c ON c.id = COALESCE(d.contact_id, p.contact_id, dn.contact_id, e.contact_id)
     WHERE e.tenant_id = ? ${accountId ? 'AND e.account_id = ?' : ''} AND ${NEEDS_TX}
     ORDER BY e.entry_date, e.id LIMIT ${limit}`, tenantId, ...(accountId ? [accountId] : []),
  );
  return rows.map((r) => ({
    id: r.id, account_id: r.account_id, account_name: r.account_name, entry_date: String(r.entry_date), amount: Number(r.amount),
    label: `${String(r.label || 'Buchung').trim()}${r.party && !String(r.label).includes(r.party) ? ` · ${r.party}` : ''}`,
    href: r.document_id ? `/invoices/${r.document_id}` : r.purchase_id ? `/purchases/${r.purchase_id}` : r.donation_id ? `/donations/${r.donation_id}` : `/cashbook/entries/${r.id}/edit`,
  }));
}

export async function unmatchedCounts(tenantId: number): Promise<Map<number, number>> {
  const rows = await all<{ account_id: number; n: number }>(
    `SELECT e.account_id, COUNT(*) n FROM cash_entries e JOIN cash_accounts a ON a.id = e.account_id JOIN tenants t ON t.id = e.tenant_id
     WHERE e.tenant_id = ? AND ${NEEDS_TX} GROUP BY e.account_id`, tenantId,
  );
  return new Map(rows.map((r) => [Number(r.account_id), Number(r.n)]));
}

export interface Exemption { entry_id: number; reason: string; created_at: string; entry_date: string; amount: number; label: string; href: string }

export async function exemptionsOf(accountId: number): Promise<Exemption[]> {
  const rows = await all<Exemption & { document_id: number | null; purchase_id: number | null; donation_id: number | null }>(
    `SELECT x.entry_id, x.reason, x.created_at, e.entry_date, e.amount, e.document_id, e.purchase_id, e.donation_id, ${ENTRY_LABEL} label
     FROM bank_exemptions x JOIN cash_entries e ON e.id = x.entry_id
     LEFT JOIN documents d ON d.id = e.document_id LEFT JOIN purchase_invoices p ON p.id = e.purchase_id
     WHERE e.account_id = ? ORDER BY e.entry_date DESC LIMIT 300`, accountId,
  );
  return rows.map((r) => ({ ...r, entry_date: String(r.entry_date), amount: Number(r.amount),
    href: r.document_id ? `/invoices/${r.document_id}` : r.purchase_id ? `/purchases/${r.purchase_id}` : r.donation_id ? `/donations/${r.donation_id}` : `/cashbook/entries/${r.entry_id}/edit` }));
}

export interface EntryBankStatus {
  account: CashAccount;
  tx?: BankTxRow;
  /** weitere Buchungen desselben Umsatzes */
  siblings: TxLink[];
  exemption?: { reason: string; created_at: string };
  /** braucht (noch) einen Kontoumsatz */
  required: boolean;
}

/** Abgleich-Stand einer Buchung – undefined bei Bargeldkassen */
export async function entryBankStatus(t: Tenant, entry: { id: number; account_id: number; entry_date: string; source: string }): Promise<EntryBankStatus | undefined> {
  const account = await getAccount(t.id, entry.account_id);
  if (!account || account.kind !== 'bank') return undefined;
  const link = await one<{ tx_id: number }>('SELECT tx_id FROM bank_tx_entries WHERE entry_id = ?', entry.id);
  const tx = link ? await getTx(t.id, link.tx_id) : undefined;
  const siblings = tx ? ((await linksOf([tx.id])).get(tx.id) ?? []).filter((l) => l.entry_id !== entry.id) : [];
  const exemption = await one<{ reason: string; created_at: string }>('SELECT reason, created_at FROM bank_exemptions WHERE entry_id = ?', entry.id);
  const required = !!(await one(
    `SELECT 1 FROM cash_entries e JOIN cash_accounts a ON a.id = e.account_id JOIN tenants t ON t.id = e.tenant_id WHERE e.id = ? AND ${NEEDS_TX}`, entry.id,
  ));
  return { account, tx, siblings, exemption, required };
}

async function bankEntry(t: Tenant, entryId: number) {
  const e = await one<{ id: number; account_id: number; amount: number; source: string; entry_date: string }>(
    `SELECT e.id, e.account_id, e.amount, e.source, e.entry_date FROM cash_entries e JOIN cash_accounts a ON a.id = e.account_id
     WHERE e.tenant_id = ? AND e.id = ? AND a.kind = 'bank'`, t.id, entryId,
  );
  if (!e) throw new UserError('Die Buchung gibt es auf keinem Bankkonto.');
  return { ...e, amount: Number(e.amount), entry_date: String(e.entry_date) };
}

export async function setExempt(t: Tenant, entryId: number, reason: string, userId: number) {
  const e = await bankEntry(t, entryId);
  if (await one('SELECT 1 FROM bank_tx_entries WHERE entry_id = ?', e.id)) throw new UserError('Die Buchung ist einem Kontoumsatz zugeordnet – zuerst die Zuordnung lösen.');
  await run(
    'INSERT INTO bank_exemptions (entry_id, tenant_id, reason, created_by, created_at) VALUES (?, ?, ?, ?, ?) ON DUPLICATE KEY UPDATE reason = VALUES(reason)',
    e.id, t.id, reason.slice(0, 200), userId, nowIso(),
  );
  return e;
}

export async function clearExempt(t: Tenant, entryId: number) {
  await run('DELETE FROM bank_exemptions WHERE tenant_id = ? AND entry_id = ?', t.id, entryId);
}

/* ---------------- Zuordnen ---------------- */

export type ItemKind = 'entry' | 'invoice' | 'purchase';
export interface AssignItem {
  kind: ItemKind;
  id: number;
  /** Betrag in Cent ohne Vorzeichen (Rechnung/Eingangsrechnung); fehlt → offener Betrag, höchstens der Rest */
  amount?: number | null;
}

const sign = (n: number) => (n > 0 ? 1 : n < 0 ? -1 : 0);

/**
 * Buchungen bzw. Rechnungen einem Umsatz zuordnen – eine oder mehrere auf einmal.
 * Vorhandene Buchungen werden nur verknüpft; Rechnungen und Eingangsrechnungen werden mit dem Tag der
 * Gutschrift bzw. Lastschrift als bezahlt gebucht. Die Summe darf über den Betrag des Umsatzes nicht
 * hinausgehen; was fehlt, bleibt als Rest offen. Gibt die Bezeichnungen der zugeordneten Posten zurück.
 */
export async function assignItems(t: Tenant, x: BankTxRow, items: AssignItem[], userId: number): Promise<string[]> {
  if (x.ignored_at) throw new UserError('Der Umsatz ist ignoriert – zuerst wieder öffnen.');
  if (!items.length) throw new UserError('Bitte mindestens eine Buchung oder Rechnung auswählen.');
  const s = sign(x.amount) || 1;
  let rest = x.remaining;
  const seen = new Set<string>();
  type Plan = { kind: ItemKind; id: number; signed: number; label: string; run: () => Promise<number> };
  const plan: Plan[] = [];

  for (const it of items) {
    const key = `${it.kind}:${it.id}`;
    if (seen.has(key)) continue;
    seen.add(key);
    if (it.kind === 'entry') {
      const e = await one<{ id: number; amount: number; source: string; text: string }>(
        `SELECT e.id, e.amount, e.source, e.text FROM cash_entries e WHERE e.tenant_id = ? AND e.account_id = ? AND e.id = ? AND ${liveSql('e')}`, t.id, x.account_id, it.id,
      );
      if (!e || e.source === 'count') throw new UserError('Die Buchung gibt es auf diesem Konto nicht (mehr) oder sie ist storniert.');
      if (await one('SELECT 1 FROM bank_tx_entries WHERE entry_id = ?', e.id)) throw new UserError(`Die Buchung „${e.text || e.id}“ ist schon einem Kontoumsatz zugeordnet.`);
      const signed = Number(e.amount);
      plan.push({ kind: 'entry', id: e.id, signed, label: e.text || 'Buchung', run: async () => e.id });
      rest -= signed;
    } else if (it.kind === 'invoice') {
      const d = await one<{ id: number; status: string; number: string; due: number }>(
        `SELECT id, status, number, gross_total - prepaid_total due FROM documents
         WHERE tenant_id = ? AND id = ? AND kind = 'invoice' AND finalized_at IS NOT NULL AND type_code <> '381'`, t.id, it.id,
      );
      if (!d || !['open', 'paid'].includes(d.status)) throw new UserError('Die Rechnung ist nicht offen.');
      if (await linkedEntry('invoice', d.id)) throw new UserError(`Die Zahlung zu Rechnung ${d.number} ist schon gebucht.`);
      const amount = it.amount ?? Math.min(Number(d.due), Math.max(rest, 0));
      if (!(amount > 0)) throw new UserError(`Für Rechnung ${d.number} ist kein Betrag mehr übrig – eine Rechnung passt nur zu einer Gutschrift.`);
      plan.push({
        kind: 'invoice', id: d.id, signed: amount, label: `Rechnung ${d.number}`,
        run: async () => {
          if (d.status === 'open') await run("UPDATE documents SET status = 'paid', paid_at = ?, updated_at = ? WHERE id = ?", x.booking_date, nowIso(), d.id);
          await bookLinked(t, 'invoice', d.id, { account_id: x.account_id, entry_date: x.booking_date, amount, text: '' }, userId);
          return (await linkedEntry('invoice', d.id))!.id;
        },
      });
      rest -= amount;
    } else {
      const p = await getPurchase(t.id, it.id);
      if (!p || !['open', 'paid'].includes(p.status)) throw new UserError('Die Eingangsrechnung ist nicht offen.');
      const label = `Eingangsrechnung ${p.number || p.internal_ref || ''}`.trim();
      if (await linkedEntry('purchase', p.id)) throw new UserError(`Die Zahlung zu ${label} ist schon gebucht.`);
      const ps = p.is_credit ? 1 : -1;
      const amount = it.amount ?? Math.min(payable(p), Math.max(rest * ps, 0));
      if (!(amount > 0)) throw new UserError(`Für ${label} ist kein Betrag mehr übrig – ${p.is_credit ? 'eine Gutschrift passt nur zu einer Einnahme' : 'eine Eingangsrechnung passt nur zu einer Ausgabe'}.`);
      const signed = ps * amount;
      plan.push({
        kind: 'purchase', id: p.id, signed, label,
        run: async () => {
          if (p.status === 'open') await setPaid(p, x.booking_date);
          await bookLinked(t, 'purchase', p.id, { account_id: x.account_id, entry_date: x.booking_date, amount: signed, text: '', receipt_ref: p.internal_ref }, userId);
          return (await linkedEntry('purchase', p.id))!.id;
        },
      });
      rest -= signed;
    }
  }
  // nicht über den Umsatz hinaus (bei gemischten Vorzeichen zählt die Summe)
  if (rest * s < 0) {
    throw new UserError(`Die Auswahl ergibt ${formatMoney(x.remaining - rest)} – zuzuordnen sind ${formatMoney(x.remaining)}. Bitte Beträge anpassen.`);
  }
  await tx(async () => {
    for (const p of plan) {
      const entryId = await p.run();
      await run('INSERT INTO bank_tx_entries (tx_id, entry_id, created_by, created_at) VALUES (?, ?, ?, ?)', x.id, entryId, userId, nowIso());
      await run('DELETE FROM bank_exemptions WHERE entry_id = ?', entryId);
    }
  });
  return plan.map((p) => p.label);
}

/** Buchungstext aus Auftraggeber/Empfänger und Verwendungszweck */
export const entryText = (x: Pick<BankTxRow, 'remote_name' | 'purpose' | 'booking_text'>) =>
  [x.remote_name, x.purpose || x.booking_text].filter(Boolean).join(': ').slice(0, 300) || 'Kontoumsatz';

/** Rest (bzw. ganzen Umsatz) als freie Buchung übernehmen */
export async function bookRest(t: Tenant, x: BankTxRow, userId: number, text?: string): Promise<number> {
  if (x.ignored_at) throw new UserError('Der Umsatz ist ignoriert – zuerst wieder öffnen.');
  if (!x.remaining) throw new UserError('Der Umsatz ist schon vollständig zugeordnet.');
  return tx(async () => {
    const id = await createManual(t, { account_id: x.account_id, entry_date: x.booking_date, amount: x.remaining, text: (text || entryText(x)).slice(0, 300) }, userId);
    await run('INSERT INTO bank_tx_entries (tx_id, entry_id, created_by, created_at) VALUES (?, ?, ?, ?)', x.id, id, userId, nowIso());
    return id;
  });
}

export async function setIgnored(x: BankTxRow, ignored: boolean, userId: number) {
  if (ignored && x.links) throw new UserError('Dem Umsatz sind Buchungen zugeordnet – zuerst die Zuordnung lösen.');
  await run('UPDATE bank_transactions SET ignored_at = ?, done_by = ? WHERE id = ?', ignored ? nowIso() : null, userId, x.id);
}

/** Zuordnung lösen (eine Buchung oder alle) – die Buchungen im Kassenbuch bleiben unverändert stehen */
export async function unlinkTx(x: BankTxRow, entryId?: number) {
  if (entryId) await run('DELETE FROM bank_tx_entries WHERE tx_id = ? AND entry_id = ?', x.id, entryId);
  else await run('DELETE FROM bank_tx_entries WHERE tx_id = ?', x.id);
}

/** Startdatum für den nächsten Abruf: ab dem letzten Abruf (3 Tage Überlappung), sonst 90 Tage zurück */
export function defaultFrom(conn: Pick<BankConnection, 'fetched_until'> | undefined, account: CashAccount): string {
  const base = conn?.fetched_until
    ? new Date(Date.parse(`${conn.fetched_until}T12:00:00Z`) - 3 * 86_400_000)
    : new Date(Date.now() - 90 * 86_400_000);
  const iso = base.toISOString().slice(0, 10);
  const from = iso < account.opening_date ? account.opening_date : iso;
  return from > today() ? today() : from;
}

/* ---------------- Vorschläge ---------------- */

export interface SuggItem { kind: ItemKind; id: number; signed: number; label: string; href: string }
export interface Suggestion {
  items: SuggItem[];
  /** eindeutig: Betrag und Nummer bzw. Datum passen */
  sure: boolean;
  hint: string;
}

interface EntryCand { id: number; entry_date: string; amount: number; label: string; href: string }
interface DocCand { id: number; number: string; due: number; label: string | null; status: string }
interface PurchaseCand { id: number; number: string; internal_ref: string; iban: string; due: number; is_credit: number; label: string | null; status: string }

/** Kombinationen aus 2–3 Buchungen, deren Summe genau dem Betrag entspricht (kleinste Datumsabstände zuerst) */
function combos(list: EntryCand[], target: number): EntryCand[] | null {
  const n = Math.min(list.length, 12);
  for (let i = 0; i < n; i++) for (let j = i + 1; j < n; j++) {
    if (list[i].amount + list[j].amount === target) return [list[i], list[j]];
  }
  for (let i = 0; i < n; i++) for (let j = i + 1; j < n; j++) for (let k = j + 1; k < n; k++) {
    if (list[i].amount + list[j].amount + list[k].amount === target) return [list[i], list[j], list[k]];
  }
  return null;
}

/**
 * Für jeden offenen Umsatz (Rest ≠ 0) den besten Vorschlag – in dieser Reihenfolge:
 * 1. eine schon erfasste Buchung mit genau dem Rest (höchstens 7 Tage Abstand) – vermeidet Doppelte,
 * 2. Rechnungen bzw. Eingangsrechnungen, deren Nummern im Verwendungszweck stehen (auch mehrere),
 * 3. Eingangsrechnung mit der IBAN des Empfängers und passendem Betrag,
 * 4. zwei oder drei erfasste Buchungen, die zusammen den Rest ergeben,
 * 5. einzige offene Rechnung bzw. Eingangsrechnung mit genau diesem Betrag.
 * Jede Buchung bzw. Rechnung wird höchstens einem Umsatz vorgeschlagen.
 */
export async function suggestions(t: Tenant, account: CashAccount, open: BankTxRow[]): Promise<Map<number, Suggestion>> {
  const out = new Map<number, Suggestion>();
  const todo = open.filter((x) => x.remaining !== 0);
  if (!todo.length) return out;
  const dates = todo.map((x) => x.booking_date).sort();
  const entries = (await all<EntryCand & { source: string; document_id: number | null; purchase_id: number | null; donation_id: number | null }>(
    `SELECT e.id, e.entry_date, e.amount, e.source, e.document_id, e.purchase_id, e.donation_id, ${ENTRY_LABEL} label
     FROM cash_entries e LEFT JOIN documents d ON d.id = e.document_id LEFT JOIN purchase_invoices p ON p.id = e.purchase_id
     WHERE e.account_id = ? AND e.source <> 'count' AND ${liveSql('e')}
       AND e.entry_date BETWEEN DATE_SUB(?, INTERVAL 7 DAY) AND DATE_ADD(?, INTERVAL 7 DAY)
       AND NOT EXISTS (SELECT 1 FROM bank_tx_entries l WHERE l.entry_id = e.id)
       AND NOT EXISTS (SELECT 1 FROM bank_exemptions x WHERE x.entry_id = e.id)`,
    account.id, dates[0], dates[dates.length - 1],
  )).map((e) => ({
    id: e.id, entry_date: String(e.entry_date), amount: Number(e.amount), label: String(e.label || 'Buchung'),
    href: e.document_id ? `/invoices/${e.document_id}` : e.purchase_id ? `/purchases/${e.purchase_id}` : e.donation_id ? `/donations/${e.donation_id}` : `/cashbook/entries/${e.id}/edit`,
  }));
  const invoices = (await all<DocCand>(
    `SELECT d.id, d.number, d.status, d.gross_total - d.prepaid_total due, COALESCE(NULLIF(c.company, ''), c.name) label
     FROM documents d LEFT JOIN contacts c ON c.id = d.contact_id
     WHERE d.tenant_id = ? AND d.kind = 'invoice' AND d.finalized_at IS NOT NULL AND d.type_code <> '381' AND d.status IN ('open', 'paid')
       AND NOT EXISTS (SELECT 1 FROM cash_entries e WHERE e.document_id = d.id)`, t.id,
  )).map((d) => ({ ...d, due: Number(d.due) }));
  const purchases = (await all<PurchaseCand>(
    `SELECT p.id, p.number, p.internal_ref, p.iban, p.is_credit, p.status, p.gross_total - p.prepaid_total due, COALESCE(NULLIF(c.company, ''), c.name) label
     FROM purchase_invoices p LEFT JOIN contacts c ON c.id = p.contact_id
     WHERE p.tenant_id = ? AND p.status IN ('open', 'paid')
       AND NOT EXISTS (SELECT 1 FROM cash_entries e WHERE e.purchase_id = p.id)`, t.id,
  )).map((p) => ({ ...p, due: Number(p.due) }));

  const used = new Set<string>();
  const free = (kind: ItemKind, id: number) => !used.has(`${kind}:${id}`);
  const take = (txId: number, s: Suggestion) => {
    for (const i of s.items) used.add(`${i.kind}:${i.id}`);
    out.set(txId, s);
  };
  const paidNote = (st: string) => (st === 'paid' ? ' · schon als bezahlt markiert' : '');
  const inv = (d: DocCand, amount: number): SuggItem => ({ kind: 'invoice', id: d.id, signed: amount, label: `Rechnung ${d.number}${d.label ? ` · ${d.label}` : ''}${paidNote(d.status)}`, href: `/invoices/${d.id}` });
  const pur = (p: PurchaseCand, amount: number): SuggItem => ({
    kind: 'purchase', id: p.id, signed: (p.is_credit ? 1 : -1) * amount,
    label: `Eingangsrechnung${p.number ? ` ${p.number}` : ''}${p.label ? ` · ${p.label}` : ''}${paidNote(p.status)}`, href: `/purchases/${p.id}`,
  });
  const ent = (e: EntryCand): SuggItem => ({ kind: 'entry', id: e.id, signed: e.amount, label: e.label, href: e.href });
  const fits = (p: PurchaseCand, amount: number) => (p.is_credit ? amount > 0 : amount < 0);
  const near = (x: BankTxRow) => entries.filter((e) => free('entry', e.id) && dayDistance(e.entry_date, x.booking_date) <= 7)
    .sort((a, b) => dayDistance(a.entry_date, x.booking_date) - dayDistance(b.entry_date, x.booking_date));

  // 1. eine vorhandene Buchung
  for (const x of todo) {
    const best = near(x).find((e) => e.amount === x.remaining);
    if (best) {
      const d = dayDistance(best.entry_date, x.booking_date);
      take(x.id, { items: [ent(best)], sure: d <= 3, hint: d === 0 ? 'schon gebucht, gleicher Tag' : `schon gebucht, ${d} Tag${d === 1 ? '' : 'e'} Abstand` });
    }
  }
  // 2. Nummern im Verwendungszweck
  for (const x of todo) {
    if (out.has(x.id)) continue;
    const hay = `${x.purpose} ${x.remote_name}`;
    const di = x.remaining > 0 ? invoices.filter((d) => free('invoice', d.id) && mentions(hay, d.number)) : [];
    const pi = purchases.filter((p) => free('purchase', p.id) && fits(p, x.remaining) && (mentions(hay, p.number) || mentions(hay, p.internal_ref)));
    if (!di.length && !pi.length) continue;
    const signedTotal = di.reduce((s, d) => s + d.due, 0) + pi.reduce((s, p) => s + (p.is_credit ? 1 : -1) * p.due, 0);
    if (signedTotal === x.remaining) {
      const n = di.length + pi.length;
      take(x.id, { items: [...di.map((d) => inv(d, d.due)), ...pi.map((p) => pur(p, p.due))], sure: true,
        hint: n === 1 ? 'Nummer und Betrag passen' : `${n} Nummern im Verwendungszweck, die Summe passt` });
    } else if (di.length + pi.length === 1) {
      // eine Rechnung mit abweichendem Betrag (z. B. Skonto, Teilzahlung): Rest bzw. offener Betrag
      if (di.length) take(x.id, { items: [inv(di[0], Math.min(di[0].due, x.remaining))], sure: false, hint: `Nummer passt, offen ${formatMoney(di[0].due)}` });
      else take(x.id, { items: [pur(pi[0], Math.min(pi[0].due, Math.abs(x.remaining)))], sure: false, hint: `Nummer passt, offen ${formatMoney(pi[0].due)}` });
    }
  }
  // 3. IBAN des Lieferanten
  for (const x of todo) {
    if (out.has(x.id) || !x.remote_iban) continue;
    const p = purchases.find((p) => free('purchase', p.id) && fits(p, x.remaining) && p.iban && compact(p.iban) === x.remote_iban && p.due === Math.abs(x.remaining));
    if (p) take(x.id, { items: [pur(p, p.due)], sure: true, hint: 'IBAN und Betrag passen' });
  }
  // 4. mehrere vorhandene Buchungen ergeben zusammen den Rest
  for (const x of todo) {
    if (out.has(x.id)) continue;
    const c = combos(near(x), x.remaining);
    if (c) take(x.id, { items: c.map(ent), sure: false, hint: `${c.length} Buchungen ergeben zusammen den Betrag` });
  }
  // 5. eindeutiger Betrag
  for (const x of todo) {
    if (out.has(x.id)) continue;
    const di = x.remaining > 0 ? invoices.filter((d) => free('invoice', d.id) && d.due === x.remaining) : [];
    const pi = purchases.filter((p) => free('purchase', p.id) && fits(p, x.remaining) && p.due === Math.abs(x.remaining));
    if (di.length + pi.length === 1) {
      take(x.id, { items: di.length ? [inv(di[0], di[0].due)] : [pur(pi[0], pi[0].due)], sure: false, hint: 'nur der Betrag passt' });
    }
  }
  return out;
}

/** Kandidaten für die Auswahl auf der Seite eines Umsatzes */
export async function candidatesFor(t: Tenant, x: BankTxRow) {
  const entries = (await unmatchedEntries(t.id, x.account_id, 1000))
    .sort((a, b) => Number(b.amount === x.remaining) - Number(a.amount === x.remaining) || dayDistance(a.entry_date, x.booking_date) - dayDistance(b.entry_date, x.booking_date))
    .slice(0, 60);
  const invoices = (await all<DocCand>(
    `SELECT d.id, d.number, d.status, d.gross_total - d.prepaid_total due, COALESCE(NULLIF(c.company, ''), c.name) label
     FROM documents d LEFT JOIN contacts c ON c.id = d.contact_id
     WHERE d.tenant_id = ? AND d.kind = 'invoice' AND d.finalized_at IS NOT NULL AND d.type_code <> '381' AND d.status IN ('open', 'paid')
       AND NOT EXISTS (SELECT 1 FROM cash_entries e WHERE e.document_id = d.id) ORDER BY d.issue_date DESC LIMIT 200`, t.id,
  )).map((d) => ({ ...d, due: Number(d.due) }));
  const purchases = (await all<PurchaseCand>(
    `SELECT p.id, p.number, p.internal_ref, p.iban, p.is_credit, p.status, p.gross_total - p.prepaid_total due, COALESCE(NULLIF(c.company, ''), c.name) label
     FROM purchase_invoices p LEFT JOIN contacts c ON c.id = p.contact_id
     WHERE p.tenant_id = ? AND p.status IN ('open', 'paid')
       AND NOT EXISTS (SELECT 1 FROM cash_entries e WHERE e.purchase_id = p.id) ORDER BY COALESCE(p.issue_date, p.created_at) DESC LIMIT 200`, t.id,
  )).map((p) => ({ ...p, due: Number(p.due) }));
  const hay = `${x.purpose} ${x.remote_name}`;
  const rank = <T extends { due: number }>(list: T[], hit: (v: T) => boolean) =>
    [...list].sort((a, b) => Number(hit(b)) - Number(hit(a)) || Number(b.due === Math.abs(x.remaining)) - Number(a.due === Math.abs(x.remaining)));
  return {
    entries,
    invoices: rank(invoices, (d) => mentions(hay, d.number)),
    purchases: rank(purchases, (p) => mentions(hay, p.number) || mentions(hay, p.internal_ref) || (!!p.iban && compact(p.iban) === x.remote_iban)),
  };
}

/** Offene Umsätze, die zu einer Buchung bzw. Zahlung passen könnten (gleiches Vorzeichen; passender Rest, nahes Datum zuerst) */
export function rankTx(list: BankTxRow[], amount: number, date: string): BankTxRow[] {
  return list.filter((x) => sign(x.remaining) === sign(amount) || sign(amount) === 0)
    .sort((a, b) => Number(b.remaining === amount) - Number(a.remaining === amount) || dayDistance(a.booking_date, date) - dayDistance(b.booking_date, date));
}

export const txOption = (x: BankTxRow) =>
  [formatDate(x.booking_date), x.remote_name || x.booking_text || 'Umsatz', x.purpose.slice(0, 60), formatMoney(x.amount),
    x.remaining !== x.amount ? `Rest ${formatMoney(x.remaining)}` : ''].filter(Boolean).join(' · ');
