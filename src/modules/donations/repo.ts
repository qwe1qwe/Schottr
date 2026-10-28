import { all, one, run, tx, nowIso } from '../../db/index.ts';
import { isIsoDate, today } from '../../lib/dates.ts';
import { UserError, str, type Form } from '../../lib/http.ts';
import { parseDecimal } from '../../lib/money.ts';
import { nextNumber } from '../../lib/numbering.ts';
import { getLogo } from '../../lib/logo.ts';
import type { Tenant } from '../../types.ts';
import { getContact } from '../contacts.ts';
import { renderReceiptPdf } from './pdf.ts';
import {
  donorLines, receiptBase, receiptProblems, yearRange,
  type DonationKind, type GoodsOrigin, type ReceiptData, type ReceiptItem, type ReceiptKind,
} from './receipt.ts';

export interface Donation {
  id: number;
  tenant_id: number;
  contact_id: number;
  kind: DonationKind;
  donation_date: string;
  amount: number;
  waiver: number;
  description: string;
  goods_origin: GoodsOrigin;
  goods_documents: number;
  note: string;
  receipt_id: number | null;
  created_at: string;
  updated_at: string;
}

export interface Receipt {
  id: number;
  tenant_id: number;
  contact_id: number;
  number: string;
  kind: ReceiptKind;
  issue_date: string;
  period_from: string;
  period_to: string;
  total: number;
  status: 'issued' | 'cancelled';
  cancelled_at: string | null;
  cancel_reason: string;
  created_at: string;
}

export const RECEIPT_COLUMNS = 'id, tenant_id, contact_id, number, kind, issue_date, period_from, period_to, total, status, cancelled_at, cancel_reason, created_at';

export async function getDonation(tenantId: number, id: number) {
  return one<Donation>('SELECT * FROM donations WHERE tenant_id = ? AND id = ?', tenantId, id);
}

export async function getReceipt(tenantId: number, id: number) {
  return one<Receipt>(`SELECT ${RECEIPT_COLUMNS} FROM donation_receipts WHERE tenant_id = ? AND id = ?`, tenantId, id);
}

/** Kann diese Zuwendung bestätigt werden? (Mitgliedsbeiträge nur, wenn sie abziehbar sind) */
export const confirmable = (t: Pick<Tenant, 'npo_membership_deductible'>, d: Pick<Donation, 'kind'>) =>
  d.kind !== 'membership' || !!t.npo_membership_deductible;

export interface DonationInput {
  contact_id: number;
  kind: DonationKind;
  donation_date: string;
  amount: number;
  waiver: number;
  description: string;
  goods_origin: GoodsOrigin;
  goods_documents: number;
  note: string;
}

export async function parseDonation(form: Form, tenantId: number): Promise<DonationInput> {
  const errors: string[] = [];
  const kindRaw = str(form, 'kind');
  const kind: DonationKind = kindRaw === 'membership' || kindRaw === 'goods' ? kindRaw : 'money';
  const originRaw = str(form, 'goods_origin');
  const d: DonationInput = {
    contact_id: Number(str(form, 'contact_id')),
    kind,
    donation_date: str(form, 'donation_date'),
    amount: parseDecimal(str(form, 'amount'), 2) ?? -1,
    waiver: kind !== 'goods' && str(form, 'waiver') === '1' ? 1 : 0,
    description: kind === 'goods' ? str(form, 'description', 1000) : '',
    goods_origin: kind === 'goods' && (originRaw === 'business' || originRaw === 'private' || originRaw === 'unknown') ? originRaw : '',
    goods_documents: kind === 'goods' && str(form, 'goods_documents') === '1' ? 1 : 0,
    note: str(form, 'note', 300),
  };
  if (!await getContact(tenantId, d.contact_id)) errors.push('Bitte den Zuwendenden auswählen.');
  if (!isIsoDate(d.donation_date)) errors.push('Bitte ein gültiges Datum angeben.');
  else if (d.donation_date > today()) errors.push('Das Datum der Zuwendung liegt in der Zukunft.');
  if (d.amount <= 0 || d.amount > 1e12) errors.push(kind === 'goods' ? 'Bitte den Wert der Sachzuwendung angeben.' : 'Bitte einen Betrag größer 0 angeben.');
  if (kind === 'goods' && !d.description) errors.push('Bitte die Sachzuwendung genau bezeichnen (Alter, Zustand, Kaufpreis usw.).');
  if (kind === 'goods' && !d.goods_origin) errors.push('Bitte angeben, ob die Sachzuwendung aus dem Betriebs- oder Privatvermögen stammt.');
  if (errors.length) throw new UserError(errors.join(' '));
  return d;
}

const COLS = ['contact_id', 'kind', 'donation_date', 'amount', 'waiver', 'description', 'goods_origin', 'goods_documents', 'note'] as const;

export async function createDonation(t: Tenant, d: DonationInput, userId: number): Promise<number> {
  const now = nowIso();
  const res = await run(
    `INSERT INTO donations (tenant_id, ${COLS.join(', ')}, created_by, created_at, updated_at) VALUES (?, ${COLS.map(() => '?').join(', ')}, ?, ?, ?)`,
    t.id, ...COLS.map((k) => d[k]), userId, now, now,
  );
  return Number(res.insertId);
}

export async function updateDonation(existing: Donation, d: DonationInput) {
  if (existing.receipt_id) throw new UserError('Diese Zuwendung ist bereits bestätigt. Erst die Bestätigung stornieren, dann ändern.');
  await run(`UPDATE donations SET ${COLS.map((k) => `${k} = ?`).join(', ')}, updated_at = ? WHERE id = ?`, ...COLS.map((k) => d[k]), nowIso(), existing.id);
}

export async function deleteDonation(existing: Donation) {
  if (existing.receipt_id) throw new UserError('Bestätigte Zuwendungen können nicht gelöscht werden. Erst die Bestätigung stornieren.');
  await run('DELETE FROM donations WHERE id = ?', existing.id);
}

/**
 * Bestätigung ausstellen: Nummer vergeben, PDF erzeugen, Doppel speichern, Zuwendungen sperren –
 * alles in einer Transaktion (scheitert das PDF, ist auch die Nummer wieder frei).
 */
async function issue(t: Tenant, contactId: number, kind: ReceiptKind, donations: Donation[], userId: number, issueDate = today()): Promise<number> {
  const problems = receiptProblems(t, issueDate);
  if (problems.length) throw new UserError(`Zuwendungsbestätigung nicht möglich: ${problems.join(' ')} (Einstellungen → Zuwendungsbestätigungen)`);
  const contact = await getContact(t.id, contactId);
  if (!contact) throw new UserError('Der Zuwendende wurde nicht gefunden.');
  if (!contact.street || !contact.city) throw new UserError(`Für ${contact.company || contact.name} fehlt die Anschrift – sie gehört auf die Bestätigung.`);
  const dates = donations.map((d) => d.donation_date).sort();
  const total = donations.reduce((a, d) => a + d.amount, 0);
  const logo = await getLogo(t.id);
  return tx(async () => {
    const number = await nextNumber(t.id, 'donation_receipt', t.donation_receipt_number_format || 'ZB-{YYYY}-{NNNN}', issueDate);
    const first = donations[0];
    const data: ReceiptData = {
      version: 1,
      kind,
      number,
      issueDate,
      ...receiptBase(t),
      donor: donorLines(contact),
      total,
      ...(kind === 'collective'
        ? {
            periodFrom: dates[0].slice(0, 4) === dates.at(-1)!.slice(0, 4) ? yearRange(Number(dates[0].slice(0, 4))).from : dates[0],
            periodTo: dates[0].slice(0, 4) === dates.at(-1)!.slice(0, 4) ? yearRange(Number(dates[0].slice(0, 4))).to : dates.at(-1),
            items: donations
              .map((d): ReceiptItem => ({ date: d.donation_date, kind: d.kind === 'membership' ? 'membership' : 'money', waiver: !!d.waiver, amount: d.amount }))
              .sort((a, b) => a.date.localeCompare(b.date)),
          }
        : { date: first.donation_date, waiver: !!first.waiver }),
      ...(kind === 'goods' ? { goods: { description: first.description, origin: first.goods_origin, documents: !!first.goods_documents } } : {}),
    };
    const pdf = await renderReceiptPdf(data, logo);
    const res = await run(
      `INSERT INTO donation_receipts (tenant_id, contact_id, number, kind, issue_date, period_from, period_to, total, snapshot, pdf, created_by, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      t.id, contactId, number, kind, issueDate, (data.periodFrom ?? data.date)!, (data.periodTo ?? data.date)!, total, JSON.stringify(data), pdf, userId, nowIso(),
    );
    const receiptId = Number(res.insertId);
    for (const d of donations) {
      const r = await run('UPDATE donations SET receipt_id = ?, updated_at = ? WHERE id = ? AND receipt_id IS NULL', receiptId, nowIso(), d.id);
      if (!r.affectedRows) throw new UserError('Eine der Zuwendungen wurde inzwischen schon bestätigt.');
    }
    return receiptId;
  });
}

/** Einzelbestätigung (Geld/Mitgliedsbeitrag) bzw. Bestätigung über eine Sachzuwendung */
export async function issueSingle(t: Tenant, d: Donation, userId: number): Promise<number> {
  if (d.receipt_id) throw new UserError('Für diese Zuwendung gibt es bereits eine Bestätigung.');
  if (!confirmable(t, d)) throw new UserError('Mitgliedsbeiträge sind bei diesem Verein steuerlich nicht abziehbar (§ 10b Abs. 1 Satz 8 EStG) und werden nicht bestätigt.');
  return issue(t, d.contact_id, d.kind === 'goods' ? 'goods' : 'single', [d], userId);
}

/** Offene (unbestätigte) Geldzuwendungen und Beiträge eines Jahres, je Zuwendendem */
export async function openMoneyDonations(t: Tenant, year: number, contactId?: number): Promise<Donation[]> {
  const { from, to } = yearRange(year);
  return all<Donation>(
    `SELECT * FROM donations WHERE tenant_id = ? AND receipt_id IS NULL AND kind IN ('money', ${t.npo_membership_deductible ? "'membership'" : "'money'"})
       AND donation_date BETWEEN ? AND ? ${contactId ? 'AND contact_id = ?' : ''} ORDER BY contact_id, donation_date, id`,
    t.id, from, to, ...(contactId ? [contactId] : []),
  );
}

/**
 * Jahresabschluss: je Zuwendendem eine Sammelbestätigung über alle noch unbestätigten
 * Geldzuwendungen (und abziehbaren Mitgliedsbeiträge) des Jahres – bei nur einer Zuwendung
 * eine Einzelbestätigung. Liefert die Zahl der Bestätigungen und übersprungene Zuwendende.
 */
export async function issueCollective(t: Tenant, year: number, userId: number, contactId?: number) {
  const open = await openMoneyDonations(t, year, contactId);
  const byContact = new Map<number, Donation[]>();
  for (const d of open) byContact.set(d.contact_id, [...(byContact.get(d.contact_id) ?? []), d]);
  const issued: number[] = [];
  const skipped: string[] = [];
  for (const [cid, list] of byContact) {
    try {
      issued.push(await issue(t, cid, list.length > 1 ? 'collective' : 'single', list, userId));
    } catch (err) {
      if (!(err instanceof UserError)) throw err;
      // fehlende Vereinsangaben betreffen alle – dann sofort abbrechen
      if (err.message.startsWith('Zuwendungsbestätigung nicht möglich')) throw err;
      skipped.push(err.message);
    }
  }
  return { issued, skipped };
}

/** Stornieren: Doppel bleibt erhalten, die Zuwendungen werden wieder frei */
export async function cancelReceipt(r: Receipt, reason: string) {
  if (r.status === 'cancelled') throw new UserError('Die Bestätigung ist bereits storniert.');
  await tx(async () => {
    await run('UPDATE donations SET receipt_id = NULL, updated_at = ? WHERE receipt_id = ?', nowIso(), r.id);
    await run("UPDATE donation_receipts SET status = 'cancelled', cancelled_at = ?, cancel_reason = ? WHERE id = ?", nowIso(), reason, r.id);
  });
}

/** Summen der Zuwendungen eines Jahres (für die Übersicht), in Cent */
export async function donationTotals(tenantId: number, year: number | string) {
  const rows = await all<{ kind: DonationKind; n: number; s: number | string }>(
    `SELECT kind, COUNT(*) n, COALESCE(SUM(amount), 0) s FROM donations WHERE tenant_id = ? AND substr(donation_date, 1, 4) = ? GROUP BY kind`,
    tenantId, String(year),
  );
  const out = { money: { n: 0, s: 0 }, membership: { n: 0, s: 0 }, goods: { n: 0, s: 0 } };
  for (const r of rows) out[r.kind] = { n: Number(r.n), s: Number(r.s) };
  return out;
}
