import crypto from 'node:crypto';
import { all, one, run, tx, nowIso } from '../../db/index.ts';
import { addDays, formatDate, isIsoDate, today } from '../../lib/dates.ts';
import { UserError } from '../../lib/http.ts';
import type { Tenant } from '../../types.ts';

/**
 * Kassenbuch für Vereine: Bankkonten und Bargeldkassen mit Buchungen.
 * Jede Buchung hat einen Betrag mit Vorzeichen (+ Einnahme, − Ausgabe) und gehört zu genau
 * einem Konto. Rechnungen, Eingangsrechnungen und Spenden werden beim Bezahlen bzw. Erfassen
 * einem Konto zugeordnet; dazu kommen freie Buchungen, Umbuchungen zwischen Konten und die
 * Differenz einer Kassenzählung (z. B. Getränkeverkauf ohne Einzelbelege).
 */
export type AccountKind = 'bank' | 'cash';
export type EntrySource = 'manual' | 'invoice' | 'purchase' | 'donation' | 'transfer' | 'count';

export interface CashAccount {
  id: number;
  tenant_id: number;
  name: string;
  kind: AccountKind;
  iban: string;
  opening_date: string;
  opening_balance: number;
  archived: number;
}

export interface CashEntry {
  id: number;
  tenant_id: number;
  account_id: number;
  entry_date: string;
  amount: number;
  source: EntrySource;
  document_id: number | null;
  purchase_id: number | null;
  donation_id: number | null;
  count_id: number | null;
  transfer_group: string | null;
  text: string;
  receipt_ref: string;
  sphere: string;
  vat_rate: number;
}

export interface CashCount {
  id: number;
  account_id: number;
  count_date: string;
  counted: number;
  denominations: string;
  book_balance: number;
  difference: number;
  note: string;
  created_at: string;
}

export const SOURCE_LABELS: Record<EntrySource, string> = {
  manual: 'Buchung',
  invoice: 'Rechnung',
  purchase: 'Eingangsrechnung',
  donation: 'Spende/Beitrag',
  transfer: 'Umbuchung',
  count: 'Kassenzählung',
};

/** Stückelung für die Geldzählung (Cent) */
export const DENOMINATIONS = [50000, 20000, 10000, 5000, 2000, 1000, 500, 200, 100, 50, 20, 10, 5, 2, 1];

/** Kassenbuch gibt es für Vereine (gemeinnützig oder nicht) */
export const cashbookEnabled = (t: Pick<Tenant, 'org_type'>) => t.org_type === 'association';

export async function accountsOf(tenantId: number, includeArchived = false): Promise<CashAccount[]> {
  return all<CashAccount>(
    `SELECT * FROM cash_accounts WHERE tenant_id = ? ${includeArchived ? '' : 'AND archived = 0'} ORDER BY kind, name, id`,
    tenantId,
  );
}

export async function getAccount(tenantId: number, id: number) {
  return one<CashAccount>('SELECT * FROM cash_accounts WHERE tenant_id = ? AND id = ?', tenantId, id);
}

/** Kontostand am Ende eines Tages (inkl. aller Buchungen bis einschließlich `date`) */
export async function balanceAt(a: CashAccount, date = today()): Promise<number> {
  if (date < a.opening_date) return 0;
  const r = await one<{ s: number | string }>(
    'SELECT COALESCE(SUM(amount), 0) s FROM cash_entries WHERE account_id = ? AND entry_date <= ?', a.id, date,
  );
  return a.opening_balance + Number(r?.s ?? 0);
}

/** Aktuelle Stände aller Konten */
export async function balances(tenantId: number): Promise<(CashAccount & { balance: number })[]> {
  const accounts = await accountsOf(tenantId);
  const sums = await all<{ account_id: number; s: number | string }>(
    'SELECT account_id, COALESCE(SUM(amount), 0) s FROM cash_entries WHERE tenant_id = ? AND entry_date <= ? GROUP BY account_id',
    tenantId, today(),
  );
  const by = new Map(sums.map((r) => [r.account_id, Number(r.s)]));
  return accounts.map((a) => ({ ...a, balance: a.opening_balance + (by.get(a.id) ?? 0) }));
}

/**
 * Tagesverlauf der Kontostände von `from` bis `to` (einschließlich). Ein Konto zählt erst ab
 * seinem Eröffnungsdatum. Liefert für jeden Tag den Stand am Tagesende.
 */
export async function history(accounts: CashAccount[], from: string, to: string): Promise<{ date: string; balance: number; delta: number; n: number }[]> {
  if (!accounts.length) return [];
  const ids = accounts.map((a) => a.id);
  const before = await all<{ account_id: number; s: number | string }>(
    `SELECT account_id, COALESCE(SUM(amount), 0) s FROM cash_entries WHERE account_id IN (${ids.map(() => '?').join(',')}) AND entry_date < ? GROUP BY account_id`,
    ...ids, from,
  );
  const daily = await all<{ d: string; s: number | string; n: number }>(
    `SELECT entry_date d, SUM(amount) s, COUNT(*) n FROM cash_entries WHERE account_id IN (${ids.map(() => '?').join(',')}) AND entry_date BETWEEN ? AND ? GROUP BY entry_date`,
    ...ids, from, to,
  );
  const byDay = new Map(daily.map((r) => [String(r.d), { s: Number(r.s), n: Number(r.n) }]));
  const beforeSum = before.reduce((a, r) => a + Number(r.s), 0);
  // Anfangsbestände: Konten, die vor `from` eröffnet wurden, sofort; spätere am Eröffnungstag
  let balance = beforeSum + accounts.filter((a) => a.opening_date < from).reduce((a, x) => a + x.opening_balance, 0);
  const openings = new Map<string, number>();
  for (const a of accounts) if (a.opening_date >= from) openings.set(a.opening_date, (openings.get(a.opening_date) ?? 0) + a.opening_balance);
  const out: { date: string; balance: number; delta: number; n: number }[] = [];
  for (let d = from; d <= to; d = addDays(d, 1)) {
    const day = byDay.get(d);
    const delta = (day?.s ?? 0) + (openings.get(d) ?? 0);
    balance += delta;
    out.push({ date: d, balance, delta, n: day?.n ?? 0 });
  }
  return out;
}

/* ---------------- Sperre (Abschluss) ---------------- */

export function assertOpen(t: Pick<Tenant, 'cashbook_locked_until'>, ...dates: (string | null | undefined)[]) {
  const lock = t.cashbook_locked_until;
  if (!lock) return;
  for (const d of dates) {
    if (d && d <= lock) throw new UserError(`Das Kassenbuch ist bis ${formatDate(lock)} abgeschlossen – Buchungen bis zu diesem Tag lassen sich nicht mehr ändern.`);
  }
}

/* ---------------- Buchungen ---------------- */

export interface EntryInput {
  account_id: number;
  entry_date: string;
  amount: number;
  text: string;
  receipt_ref?: string;
  sphere?: string;
  vat_rate?: number;
}

async function checkAccount(t: Tenant, accountId: number, date: string): Promise<CashAccount> {
  const a = await getAccount(t.id, accountId);
  if (!a) throw new UserError('Bitte ein Konto auswählen.');
  if (!isIsoDate(date)) throw new UserError('Bitte ein gültiges Datum angeben.');
  if (date < a.opening_date) throw new UserError(`Das Konto „${a.name}“ beginnt am ${formatDate(a.opening_date)} – die Buchung liegt davor.`);
  assertOpen(t, date);
  return a;
}

const LINK_COLUMN = { invoice: 'document_id', purchase: 'purchase_id', donation: 'donation_id' } as const;
export type LinkSource = keyof typeof LINK_COLUMN;

export async function linkedEntry(source: LinkSource, refId: number) {
  return one<CashEntry>(`SELECT * FROM cash_entries WHERE ${LINK_COLUMN[source]} = ?`, refId);
}

/** Zahlung einer Rechnung/Eingangsrechnung bzw. Eingang einer Spende auf einem Konto buchen (ersetzt eine vorhandene) */
export async function bookLinked(t: Tenant, source: LinkSource, refId: number, e: EntryInput, userId: number | null): Promise<void> {
  await checkAccount(t, e.account_id, e.entry_date);
  const existing = await linkedEntry(source, refId);
  if (existing) assertOpen(t, existing.entry_date);
  const now = nowIso();
  await tx(async () => {
    if (existing) {
      await run(
        'UPDATE cash_entries SET account_id = ?, entry_date = ?, amount = ?, text = ?, receipt_ref = ?, updated_at = ? WHERE id = ?',
        e.account_id, e.entry_date, e.amount, e.text, e.receipt_ref ?? '', now, existing.id,
      );
    } else {
      await run(
        `INSERT INTO cash_entries (tenant_id, account_id, entry_date, amount, source, ${LINK_COLUMN[source]}, text, receipt_ref, created_by, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        t.id, e.account_id, e.entry_date, e.amount, source, refId, e.text, e.receipt_ref ?? '', userId, now, now,
      );
    }
  });
}

/** Verknüpfte Buchung entfernen (z. B. Rechnung wieder „offen“) */
export async function unlink(t: Tenant, source: LinkSource, refId: number): Promise<void> {
  const existing = await linkedEntry(source, refId);
  if (!existing) return;
  assertOpen(t, existing.entry_date);
  await run('DELETE FROM cash_entries WHERE id = ?', existing.id);
}

export async function createManual(t: Tenant, e: EntryInput, userId: number): Promise<number> {
  await checkAccount(t, e.account_id, e.entry_date);
  const now = nowIso();
  const res = await run(
    `INSERT INTO cash_entries (tenant_id, account_id, entry_date, amount, source, text, receipt_ref, sphere, vat_rate, created_by, created_at, updated_at)
     VALUES (?, ?, ?, ?, 'manual', ?, ?, ?, ?, ?, ?, ?)`,
    t.id, e.account_id, e.entry_date, e.amount, e.text, e.receipt_ref ?? '', e.sphere ?? '', e.vat_rate ?? 0, userId, now, now,
  );
  return Number(res.insertId);
}

export async function updateManual(t: Tenant, entry: CashEntry, e: EntryInput): Promise<void> {
  if (entry.source !== 'manual') throw new UserError('Diese Buchung gehört zu einem Beleg und wird dort geändert.');
  assertOpen(t, entry.entry_date);
  await checkAccount(t, e.account_id, e.entry_date);
  await run(
    'UPDATE cash_entries SET account_id = ?, entry_date = ?, amount = ?, text = ?, receipt_ref = ?, sphere = ?, vat_rate = ?, updated_at = ? WHERE id = ?',
    e.account_id, e.entry_date, e.amount, e.text, e.receipt_ref ?? '', e.sphere ?? '', e.vat_rate ?? 0, nowIso(), entry.id,
  );
}

/** Freie Buchung oder Umbuchung (beide Seiten) löschen */
export async function deleteEntry(t: Tenant, entry: CashEntry): Promise<void> {
  if (entry.source !== 'manual' && entry.source !== 'transfer') {
    throw new UserError(entry.source === 'count' ? 'Buchungen aus einer Kassenzählung werden mit der Zählung gelöscht.' : 'Diese Buchung gehört zu einem Beleg – dort die Zahlung zurücknehmen.');
  }
  assertOpen(t, entry.entry_date);
  if (entry.source === 'transfer' && entry.transfer_group) await run('DELETE FROM cash_entries WHERE transfer_group = ? AND tenant_id = ?', entry.transfer_group, t.id);
  else await run('DELETE FROM cash_entries WHERE id = ?', entry.id);
}

/** Umbuchung zwischen zwei Konten (z. B. Bareinzahlung der Kasse auf die Bank) */
export async function createTransfer(t: Tenant, fromId: number, toId: number, date: string, amount: number, text: string, userId: number) {
  if (fromId === toId) throw new UserError('Bitte zwei verschiedene Konten wählen.');
  if (amount <= 0) throw new UserError('Bitte einen Betrag größer 0 angeben.');
  const from = await checkAccount(t, fromId, date);
  const to = await checkAccount(t, toId, date);
  const group = crypto.randomBytes(8).toString('hex');
  const now = nowIso();
  const label = text || `Umbuchung ${from.name} → ${to.name}`;
  await tx(async () => {
    for (const [acc, amt] of [[from.id, -amount], [to.id, amount]] as const) {
      await run(
        `INSERT INTO cash_entries (tenant_id, account_id, entry_date, amount, source, transfer_group, text, created_by, created_at, updated_at)
         VALUES (?, ?, ?, ?, 'transfer', ?, ?, ?, ?, ?)`,
        t.id, acc, date, amt, group, label, userId, now, now,
      );
    }
  });
}

/* ---------------- Kassenzählung ---------------- */

export async function lastCount(accountId: number) {
  return one<CashCount>('SELECT * FROM cash_counts WHERE account_id = ? ORDER BY count_date DESC, id DESC LIMIT 1', accountId);
}

/**
 * Geldzählung speichern: Buchbestand am Zähltag ermitteln; die Differenz zum gezählten Bestand
 * wird als Buchung erfasst – positiv z. B. als Einnahmen ohne Einzelbeleg (Getränkeverkauf),
 * negativ als Fehlbetrag bzw. Ausgaben ohne Beleg.
 */
export async function saveCount(
  t: Tenant, a: CashAccount, input: { date: string; denominations: Record<string, number>; counted?: number; note: string; text: string; sphere: string; vat_rate: number },
  userId: number,
): Promise<{ id: number; difference: number }> {
  if (a.kind !== 'cash') throw new UserError('Geldzählungen gibt es nur für Bargeldkassen.');
  await checkAccount(t, a.id, input.date);
  if (input.date > today()) throw new UserError('Die Zählung liegt in der Zukunft.');
  const last = await lastCount(a.id);
  if (last && input.date < last.count_date) throw new UserError(`Es gibt schon eine spätere Zählung (${formatDate(last.count_date)}).`);
  // gezählter Bestand: aus der Stückelung oder – wenn nur die Summe bekannt ist – direkt angegeben
  const fromDenominations = DENOMINATIONS.reduce((s, d) => s + d * (input.denominations[d] ?? 0), 0);
  const counted = Object.keys(input.denominations).length ? fromDenominations : input.counted ?? 0;
  if (counted < 0) throw new UserError('Der gezählte Bestand kann nicht negativ sein.');
  const book = await balanceAt(a, input.date);
  const difference = counted - book;
  const now = nowIso();
  return tx(async () => {
    const res = await run(
      `INSERT INTO cash_counts (tenant_id, account_id, count_date, counted, denominations, book_balance, difference, note, created_by, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      t.id, a.id, input.date, counted, JSON.stringify(input.denominations), book, difference, input.note, userId, now,
    );
    const id = Number(res.insertId);
    if (difference !== 0) {
      await run(
        `INSERT INTO cash_entries (tenant_id, account_id, entry_date, amount, source, count_id, text, sphere, vat_rate, created_by, created_at, updated_at)
         VALUES (?, ?, ?, ?, 'count', ?, ?, ?, ?, ?, ?, ?)`,
        t.id, a.id, input.date, difference, id,
        input.text || (difference > 0 ? 'Einnahmen ohne Einzelbeleg lt. Kassenzählung' : 'Kassenfehlbetrag lt. Kassenzählung'),
        input.sphere, input.vat_rate, userId, now, now,
      );
    }
    return { id, difference };
  });
}

/** Nur die letzte Zählung einer Kasse lässt sich löschen (samt Differenzbuchung) */
export async function deleteCount(t: Tenant, a: CashAccount, count: CashCount) {
  const last = await lastCount(a.id);
  if (!last || last.id !== count.id) throw new UserError('Nur die letzte Zählung einer Kasse lässt sich löschen.');
  assertOpen(t, count.count_date);
  await tx(async () => {
    await run('DELETE FROM cash_entries WHERE count_id = ?', count.id);
    await run('DELETE FROM cash_counts WHERE id = ?', count.id);
  });
}

/* ---------------- Noch nicht zugeordnet ---------------- */

export interface Unassigned {
  source: LinkSource;
  id: number;
  date: string;
  label: string;
  amount: number;
  href: string;
}

/**
 * Bezahlte Rechnungen/Eingangsrechnungen und Geldspenden ohne Buchung – ab dem frühesten
 * Eröffnungsdatum der Konten (ältere Vorgänge betreffen das Kassenbuch nicht).
 */
export async function unassigned(t: Tenant): Promise<Unassigned[]> {
  const first = await one<{ d: string | null }>('SELECT MIN(opening_date) d FROM cash_accounts WHERE tenant_id = ?', t.id);
  if (!first?.d) return [];
  const since = String(first.d);
  const inv = await all<{ id: number; number: string; paid_at: string; due: number; label: string }>(
    `SELECT d.id, d.number, d.paid_at, d.gross_total - d.prepaid_total due, COALESCE(NULLIF(c.company, ''), c.name) label
     FROM documents d JOIN contacts c ON c.id = d.contact_id
     WHERE d.tenant_id = ? AND d.kind = 'invoice' AND d.status = 'paid' AND d.paid_at >= ?
       AND NOT EXISTS (SELECT 1 FROM cash_entries e WHERE e.document_id = d.id)
     ORDER BY d.paid_at`,
    t.id, since,
  );
  const pur = await all<{ id: number; number: string; paid_at: string; due: number; is_credit: number; label: string | null }>(
    `SELECT p.id, p.number, p.paid_at, p.gross_total - p.prepaid_total due, p.is_credit, COALESCE(NULLIF(c.company, ''), c.name) label
     FROM purchase_invoices p LEFT JOIN contacts c ON c.id = p.contact_id
     WHERE p.tenant_id = ? AND p.status = 'paid' AND p.paid_at >= ?
       AND NOT EXISTS (SELECT 1 FROM cash_entries e WHERE e.purchase_id = p.id)
     ORDER BY p.paid_at`,
    t.id, since,
  );
  const don = await all<{ id: number; donation_date: string; amount: number; kind: string; label: string }>(
    `SELECT d.id, d.donation_date, d.amount, d.kind, COALESCE(NULLIF(c.company, ''), c.name) label
     FROM donations d JOIN contacts c ON c.id = d.contact_id
     WHERE d.tenant_id = ? AND d.kind IN ('money', 'membership') AND d.donation_date >= ?
       AND NOT EXISTS (SELECT 1 FROM cash_entries e WHERE e.donation_id = d.id)
     ORDER BY d.donation_date`,
    t.id, since,
  );
  return [
    ...inv.map((r) => ({ source: 'invoice' as const, id: r.id, date: String(r.paid_at), label: `Rechnung ${r.number} · ${r.label}`, amount: Number(r.due), href: `/invoices/${r.id}` })),
    ...pur.map((r) => ({
      source: 'purchase' as const, id: r.id, date: String(r.paid_at), label: `Eingangsrechnung${r.number ? ` ${r.number}` : ''} · ${r.label ?? 'ohne Lieferant'}`,
      amount: (r.is_credit ? 1 : -1) * Number(r.due), href: `/purchases/${r.id}`,
    })),
    ...don.map((r) => ({
      source: 'donation' as const, id: r.id, date: String(r.donation_date), label: `${r.kind === 'membership' ? 'Mitgliedsbeitrag' : 'Spende'} · ${r.label}`,
      amount: Number(r.amount), href: `/donations/${r.id}`,
    })),
  ].sort((a, b) => a.date.localeCompare(b.date));
}

/* ---------------- Buchungsliste mit laufendem Saldo ---------------- */

export interface EntryRow extends CashEntry {
  balance: number;
  account_name: string;
  ref_label: string | null;
  ref_sphere: string | null;
}

/**
 * Buchungen eines oder mehrerer Konten im Zeitraum mit laufendem Saldo (chronologisch).
 * `ref_label` und `ref_sphere` kommen aus dem verknüpften Beleg.
 */
export async function entriesOf(accounts: CashAccount[], from: string, to: string): Promise<{ opening: number; rows: EntryRow[]; closing: number }> {
  if (!accounts.length) return { opening: 0, rows: [], closing: 0 };
  let opening = 0;
  // Anfangsbestand: Stand am Vortag; wird ein Konto erst im Zeitraum eröffnet, zählt sein Eröffnungsbestand
  for (const a of accounts) opening += a.opening_date < from ? await balanceAt(a, addDays(from, -1)) : a.opening_date <= to ? Number(a.opening_balance) : 0;
  const ids = accounts.map((a) => a.id);
  const rows = await all<EntryRow>(
    `SELECT e.*, a.name account_name,
       CASE e.source
         WHEN 'invoice' THEN (SELECT CONCAT('Rechnung ', d.number, ' · ', COALESCE(NULLIF(c.company, ''), c.name)) FROM documents d JOIN contacts c ON c.id = d.contact_id WHERE d.id = e.document_id)
         WHEN 'purchase' THEN (SELECT CONCAT('Eingangsrechnung', IF(p.number <> '', CONCAT(' ', p.number), ''), ' · ', COALESCE(NULLIF(c.company, ''), c.name, 'ohne Lieferant')) FROM purchase_invoices p LEFT JOIN contacts c ON c.id = p.contact_id WHERE p.id = e.purchase_id)
         WHEN 'donation' THEN (SELECT CONCAT(IF(x.kind = 'membership', 'Mitgliedsbeitrag', 'Spende'), ' · ', COALESCE(NULLIF(c.company, ''), c.name)) FROM donations x JOIN contacts c ON c.id = x.contact_id WHERE x.id = e.donation_id)
         ELSE NULL END ref_label,
       CASE e.source
         WHEN 'invoice' THEN (SELECT NULLIF(d.sphere, '') FROM documents d WHERE d.id = e.document_id)
         WHEN 'purchase' THEN (SELECT NULLIF(p.sphere, '') FROM purchase_invoices p WHERE p.id = e.purchase_id)
         WHEN 'donation' THEN 'ideell'
         ELSE NULL END ref_sphere
     FROM cash_entries e JOIN cash_accounts a ON a.id = e.account_id
     WHERE e.account_id IN (${ids.map(() => '?').join(',')}) AND e.entry_date BETWEEN ? AND ? ORDER BY e.entry_date, e.id`,
    ...ids, from, to,
  );
  let bal = opening;
  for (const r of rows) {
    r.amount = Number(r.amount);
    bal += r.amount;
    r.balance = bal;
  }
  return { opening, rows, closing: bal };
}

/** Bereich einer Buchung (für Auswertungen); Umbuchungen sind neutral */
export function entrySphere(e: Pick<EntryRow, 'source' | 'sphere' | 'ref_sphere'>, defaultSphere: string): string {
  if (e.source === 'transfer') return '';
  if (e.source === 'donation') return 'ideell';
  return e.ref_sphere || e.sphere || defaultSphere;
}
