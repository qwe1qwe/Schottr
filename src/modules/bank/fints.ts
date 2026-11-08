import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { FinTSClient, FinTSConfig, type BankAccount, type BankingInformation, type ClientResponse, type Statement } from 'lib-fints';
import { nowIso } from '../../db/index.ts';
import { normalizeTransactions, isoDay, type RawTransaction } from '../../lib/banktx.ts';
import { today } from '../../lib/dates.ts';
import { normalizeIban } from '../../lib/validate.ts';
import type { Tenant } from '../../types.ts';
import type { CashAccount } from '../cashbook/repo.ts';
import { finTsProductId, importTransactions, initReconcileFrom, updateConnection, type BankConnection } from './repo.ts';

/**
 * Umsatzabruf per FinTS 3.0 (PIN/TAN) mit lib-fints.
 *
 * Ein Abruf ist ein kleiner Ablauf, der auf die Bank warten muss (TAN bzw. Freigabe in der App,
 * z. B. SecureGo plus). Er läuft als „Job“ im Arbeitsspeicher: Die FinTS-Sitzung (Dialog) muss
 * zwischen den Anfragen erhalten bleiben. Die PIN liegt nur dort und nur bis zum Ende des Jobs –
 * sie wird nie gespeichert. Jobs verfallen nach 10 Minuten.
 */

const pkg = JSON.parse(fs.readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), '../../../package.json'), 'utf8'));
/** Produktversion für die Bank: höchstens 5 Zeichen */
const PRODUCT_VERSION = String(pkg.version).slice(0, 5);
const TTL_MS = 10 * 60_000;

export type JobState =
  | { state: 'tan'; challenge: string; decoupled: boolean; photo?: { mime: string; data: string }; flicker: boolean; nextPollAt: number; pollEvery: number }
  | { state: 'choose_method'; methods: { id: number; name: string; decoupled: boolean }[] }
  | { state: 'choose_media'; media: string[] }
  | { state: 'done'; added: number; total: number; balance: number | null; until: string; notes: string[] }
  | { state: 'error'; message: string };

interface Job {
  id: string;
  tenantId: number;
  userId: number;
  accountId: number;
  connectionId: number;
  client: FinTSClient;
  phase: 'sync' | 'statements';
  syncs: number;
  from: string;
  tanRef?: string;
  busy: boolean;
  polls: number;
  status: JobState;
  expires: number;
  notes: string[];
}

const jobs = new Map<string, Job>();
setInterval(() => {
  const now = Date.now();
  for (const [id, j] of jobs) if (j.expires < now) forget(id);
}, 60_000).unref();

function forget(id: string) {
  const j = jobs.get(id);
  if (j) j.client.config.pin = undefined;
  jobs.delete(id);
}

export function getJob(id: string, tenantId: number, userId: number): Job | undefined {
  const j = jobs.get(id);
  return j && j.tenantId === tenantId && j.userId === userId && j.expires > Date.now() ? j : undefined;
}

export function cancelJob(j: Job) {
  forget(j.id);
}

/** Klartext der Bankmeldungen (Fehler zuerst); Warnungen 3xxx nur ergänzend */
function bankMessage(r: ClientResponse, fallback: string): string {
  const errors = r.bankAnswers.filter((a) => a.code >= 9000).map((a) => `${a.text} (${a.code})`);
  const warns = r.bankAnswers.filter((a) => a.code >= 3000 && a.code < 4000 && ![3060, 3920, 3076, 3956].includes(a.code)).map((a) => a.text);
  return [...new Set([...(errors.length ? errors : [fallback]), ...warns])].join(' · ');
}

function readInfo(conn: BankConnection): BankingInformation | null {
  if (!conn.banking_info) return null;
  try {
    return JSON.parse(conn.banking_info) as BankingInformation;
  } catch {
    return null;
  }
}

/** Abruf starten – Antwort ist der erste Zwischenstand (oft schon „Freigabe in der App“) */
export async function startJob(t: Tenant, userId: number, account: CashAccount, conn: BankConnection, pin: string, from: string): Promise<Job> {
  const productId = await finTsProductId();
  if (!productId) throw new Error('Es ist keine FinTS-Produkt-ID hinterlegt (Administration → System).');
  const info = readInfo(conn);
  const config = info?.bpd
    ? FinTSConfig.fromBankingInformation(productId, PRODUCT_VERSION, info, conn.login, pin, conn.tan_method_id ?? undefined, conn.tan_media || undefined, conn.customer_id || undefined)
    : FinTSConfig.forFirstTimeUse(productId, PRODUCT_VERSION, conn.url, conn.blz, conn.login, pin, conn.customer_id || undefined);
  const job: Job = {
    id: crypto.randomBytes(16).toString('hex'),
    tenantId: t.id, userId, accountId: account.id, connectionId: conn.id,
    client: new FinTSClient(config),
    // Ohne Kontenliste oder TAN-Verfahren zuerst synchronisieren, sonst direkt die Umsätze holen
    phase: info?.upd?.bankAccounts?.length && conn.tan_method_id ? 'statements' : 'sync',
    syncs: 0, from, busy: false, polls: 0, notes: [],
    status: { state: 'error', message: 'Noch nicht gestartet.' },
    expires: Date.now() + TTL_MS,
  };
  jobs.set(job.id, job);
  await advance(job, account);
  return job;
}

/** TAN-Verfahren gewählt (bei mehreren) – merken und weiter */
export async function chooseMethod(job: Job, account: CashAccount, methodId: number) {
  const m = job.client.config.availableTanMethods.find((x) => x.id === methodId);
  if (!m) return;
  job.client.selectTanMethod(m.id);
  await updateConnection(job.connectionId, { tan_method_id: m.id, tan_media: '' });
  job.phase = 'sync';
  await advance(job, account);
}

export async function chooseMedia(job: Job, account: CashAccount, media: string) {
  job.client.selectTanMedia(media);
  await updateConnection(job.connectionId, { tan_media: media });
  await advance(job, account);
}

/** Eingegebene TAN senden bzw. (bei Freigabe in der App) nachfragen, ob schon bestätigt wurde */
export async function continueJob(job: Job, account: CashAccount, tan?: string) {
  if (job.status.state !== 'tan') return;
  if (job.status.decoupled && Date.now() < job.status.nextPollAt) return;
  await advance(job, account, tan);
}

async function saveInfo(job: Job) {
  await updateConnection(job.connectionId, { banking_info: JSON.stringify(job.client.config.bankingInformation) });
}

/** Wartet die Antwort auf eine Freigabe/TAN? Dann Zwischenstand setzen und true */
function needsTan(job: Job, r: ClientResponse): boolean {
  if (!r.requiresTan) return false;
  const method = job.client.config.selectedTanMethod;
  const decoupled = !!method?.isDecoupled;
  const wait = decoupled ? Math.max(2, method?.decoupled?.waitingSecondsBetweenStatusRequests ?? 2) : 0;
  const first = job.status.state !== 'tan' ? Math.max(wait, method?.decoupled?.waitingSecondsBeforeFirstStatusRequest ?? 0) : wait;
  job.tanRef = r.tanReference ?? job.tanRef;
  job.status = {
    state: 'tan',
    challenge: r.tanChallenge || (decoupled ? 'Bitte den Auftrag in Ihrer Banking-App freigeben.' : 'Bitte TAN eingeben.'),
    decoupled,
    photo: r.tanPhoto ? { mime: r.tanPhoto.mimeType, data: Buffer.from(r.tanPhoto.image).toString('base64') } : undefined,
    flicker: !decoupled && !r.tanPhoto && !!r.tanChallengeHhdUc,
    nextPollAt: Date.now() + first * 1000,
    pollEvery: wait || 3,
  };
  return true;
}

function fail(job: Job, message: string) {
  job.status = { state: 'error', message };
  job.client.config.pin = undefined;
}

/** Das Konto der Bank zum Kassenbuch-Konto: über die IBAN, sonst das einzige Girokonto */
function bankAccountFor(job: Job, account: CashAccount): BankAccount | string {
  const list = job.client.config.bankingInformation.upd?.bankAccounts ?? [];
  const iban = normalizeIban(account.iban);
  if (iban) {
    const hit = list.find((a) => a.iban && normalizeIban(a.iban) === iban);
    if (hit) return hit;
    return `Die IBAN ${account.iban} gehört nicht zu diesem Bankzugang. Vorhanden: ${list.map((a) => a.iban || a.accountNumber).filter(Boolean).join(', ') || 'keine Konten'}.`;
  }
  const giro = list.filter((a) => a.iban && a.accountType === 'CheckingAccount');
  if (giro.length === 1) return giro[0];
  return 'Bitte beim Konto im Kassenbuch die IBAN eintragen – der Bankzugang hat mehrere Konten.';
}

/** Ablauf weiterführen, bis die Bank auf eine Eingabe wartet oder alles fertig ist */
async function advance(job: Job, account: CashAccount, tan?: string): Promise<void> {
  if (job.busy) return;
  job.busy = true;
  job.expires = Date.now() + TTL_MS;
  try {
    const c = job.client;
    for (let guard = 0; guard < 6; guard++) {
      if (job.phase === 'sync') {
        const r = job.tanRef ? await c.synchronizeWithTan(job.tanRef, tan) : await c.synchronize();
        tan = undefined;
        if (needsTan(job, r)) return;
        job.tanRef = undefined;
        if (!r.success) return fail(job, bankMessage(r, 'Die Bank hat die Anmeldung abgelehnt.'));
        job.syncs++;
        await saveInfo(job);
        // TAN-Verfahren festlegen (gemerktes, einziges oder einziges mit App-Freigabe)
        if (!c.config.selectedTanMethod) {
          const methods = c.config.availableTanMethods;
          if (!methods.length) return fail(job, 'Die Bank bietet für diesen Zugang kein TAN-Verfahren an.');
          const decoupled = methods.filter((m) => m.isDecoupled);
          const pick = methods.length === 1 ? methods[0] : decoupled.length === 1 ? decoupled[0] : null;
          if (!pick) {
            job.status = { state: 'choose_method', methods: methods.map((m) => ({ id: m.id, name: m.name, decoupled: m.isDecoupled })) };
            return;
          }
          c.selectTanMethod(pick.id);
          await updateConnection(job.connectionId, { tan_method_id: pick.id, tan_media: '' });
          if (job.syncs < 3) continue; // erneut synchronisieren – jetzt mit Verfahren (liefert die Konten)
        }
        const m = c.config.selectedTanMethod!;
        if (m.tanMediaRequirement === 2 && !c.config.tanMediaName && m.activeTanMedia.length) {
          if (m.activeTanMedia.length > 1) {
            job.status = { state: 'choose_media', media: m.activeTanMedia };
            return;
          }
          c.selectTanMedia(m.activeTanMedia[0]);
          await updateConnection(job.connectionId, { tan_media: m.activeTanMedia[0] });
        }
        if (!c.config.bankingInformation.upd?.bankAccounts?.length && job.syncs < 3) continue;
        job.phase = 'statements';
      }

      // Umsätze
      const target = bankAccountFor(job, account);
      if (typeof target === 'string') return fail(job, target);
      if (!c.canGetAccountStatements(target)) return fail(job, 'Die Bank erlaubt für dieses Konto keinen Umsatzabruf per FinTS.');
      const r = job.tanRef
        ? await c.getAccountStatementsWithTan(job.tanRef, tan)
        : await c.getAccountStatements(target, new Date(`${job.from}T12:00:00`), new Date(`${today()}T12:00:00`));
      tan = undefined;
      if (needsTan(job, r)) return;
      job.tanRef = undefined;
      if (r.bankingInformationUpdated) await saveInfo(job);
      if (!r.success) return fail(job, bankMessage(r, 'Die Bank hat den Umsatzabruf abgelehnt.'));
      await finish(job, account, r.statements ?? []);
      return;
    }
    fail(job, 'Die Anmeldung bei der Bank ist nicht abgeschlossen worden. Bitte erneut versuchen.');
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    fail(job, `Fehler bei der Verbindung zur Bank: ${msg}`);
  } finally {
    job.busy = false;
  }
}

async function finish(job: Job, account: CashAccount, statements: Statement[]) {
  const raw: RawTransaction[] = statements.flatMap((s) => s.transactions as unknown as RawTransaction[]);
  const list = normalizeTransactions(raw);
  const t = { id: job.tenantId } as Tenant;
  const { added, total } = await importTransactions(t, account, list);
  // Schlusssaldo des jüngsten Auszugs als Kontostand laut Bank
  const last = [...statements].filter((s) => s.closingBalance?.date).sort((a, b) => a.closingBalance.date.getTime() - b.closingBalance.date.getTime()).pop();
  const balance = last ? Math.round(last.closingBalance.value * 100) : null;
  const until = today();
  await updateConnection(job.connectionId, {
    fetched_until: until, last_fetch_at: nowIso(),
    ...(last ? { bank_balance: balance, bank_balance_date: isoDay(last.closingBalance.date) } : {}),
  });
  await initReconcileFrom(account.id, job.from);
  if (list.length > total) job.notes.push(`${list.length - total} Umsätze vor Eröffnung des Kontos im Kassenbuch wurden übergangen.`);
  job.status = { state: 'done', added, total, balance, until, notes: job.notes };
  job.client.config.pin = undefined;
}
