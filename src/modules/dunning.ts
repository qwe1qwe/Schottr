import { all, one, run, nowIso } from '../db/index.ts';
import { html, type SafeHtml } from '../lib/html.ts';
import { addDays, daysBetween, formatDate, isIsoDate, today } from '../lib/dates.ts';
import { formatAmount, formatMoney, parseDecimal } from '../lib/money.ts';
import { attachment, idParam, notFound, readForm, redirectWith, str, tenantOf, userOf } from '../lib/http.ts';
import { badge, csrfField, empty, page } from '../views/layout.ts';
import { sellerFromTenant, dueAmount, INVOICE_TYPES, type DocumentData } from '../einvoice/model.ts';
import { getLogo } from '../lib/logo.ts';
import { startLetter, sumBlock, LETTER_LEFT } from '../einvoice/pdf.ts';
import type { App, Ctx, Module, Tenant } from '../types.ts';

/**
 * Mahnwesen in drei Stufen:
 *   1 = Zahlungserinnerung, 2 = 1. Mahnung, 3 = 2. (letzte) Mahnung.
 * Mahngebühren sind pauschalierter Schadensersatz und daher nicht umsatzsteuerpflichtig.
 */
export const MAX_LEVEL = 3;

export function levelLabel(level: number): string {
  return ['', 'Zahlungserinnerung', '1. Mahnung', '2. Mahnung'][level] ?? `${level - 1}. Mahnung`;
}

export interface Dunning {
  id: number;
  tenant_id: number;
  invoice_id: number;
  level: number;
  issue_date: string;
  deadline: string;
  fee: number;
  text: string;
  created_at: string;
}

interface DunnableInvoice {
  id: number;
  number: string;
  issue_date: string;
  due_date: string;
  gross_total: number;
  snapshot: string;
  contact_id: number;
  contact_label: string;
  last_level: number | null;
  last_deadline: string | null;
  last_date: string | null;
}

/** Offene, überfällige Rechnungen inkl. letzter Mahnstufe */
async function overdueInvoices(tenantId: number): Promise<DunnableInvoice[]> {
  return all<DunnableInvoice>(
    `SELECT d.id, d.number, d.issue_date, d.due_date, d.gross_total - d.prepaid_total AS gross_total, d.snapshot, d.contact_id,
            COALESCE(NULLIF(c.company, ''), c.name) AS contact_label,
            x.level AS last_level, x.deadline AS last_deadline, x.issue_date AS last_date
     FROM documents d
     JOIN contacts c ON c.id = d.contact_id
     LEFT JOIN dunnings x ON x.invoice_id = d.id AND x.level = (SELECT MAX(level) FROM dunnings y WHERE y.invoice_id = d.id)
     WHERE d.tenant_id = ? AND d.kind = 'invoice' AND d.type_code <> '381' AND d.status = 'open' AND d.due_date < ?
     ORDER BY d.due_date`,
    tenantId, today(),
  );
}

/** Ist die nächste Mahnstufe fällig? (Fälligkeit bzw. Frist der letzten Mahnung + Kulanz abgelaufen) */
function nextDueDate(t: Tenant, inv: Pick<DunnableInvoice, 'due_date' | 'last_deadline'>): string {
  return addDays(inv.last_deadline ?? inv.due_date, t.dunning_interval_days + 1);
}

async function getDunnings(invoiceId: number): Promise<Dunning[]> {
  return all<Dunning>('SELECT * FROM dunnings WHERE invoice_id = ? ORDER BY level', invoiceId);
}

interface FinalInvoice {
  id: number;
  number: string;
  status: string;
  type_code: string;
  issue_date: string;
  due_date: string;
  gross_total: number;
  prepaid_total: number;
  snapshot: string;
}

async function getInvoice(tenantId: number, id: number) {
  return one<FinalInvoice>(
    "SELECT * FROM documents WHERE tenant_id = ? AND id = ? AND kind = 'invoice' AND finalized_at IS NOT NULL",
    tenantId, id,
  );
}

function canDun(inv: { status: string; type_code: string }, dunnings: Dunning[]): boolean {
  return inv.status === 'open' && inv.type_code !== '381' && dunnings.length < MAX_LEVEL;
}

function feeFor(t: Tenant, level: number): number {
  return [0, t.dunning_fee_1, t.dunning_fee_2, t.dunning_fee_3][level] ?? t.dunning_fee_3;
}

function defaultText(level: number, inv: { number: string; issue_date: string; due_date: string }, previous: Dunning[]): string {
  const ref = `unsere Rechnung ${inv.number} vom ${formatDate(inv.issue_date)}`;
  if (level === 1) {
    return `sicher ist es im Alltag untergegangen: Für ${ref} konnten wir bis heute keinen Zahlungseingang feststellen. Die Rechnung war am ${formatDate(inv.due_date)} fällig.\n\nWir bitten Sie, den offenen Betrag bis zur unten genannten Frist zu überweisen.`;
  }
  const last = previous[previous.length - 1];
  const since = last ? ` vom ${formatDate(last.issue_date)}` : '';
  if (level === 2) {
    return `leider ist ${ref} trotz unserer ${levelLabel(last?.level ?? 1)}${since} weiterhin offen.\n\nBitte überweisen Sie den offenen Betrag einschließlich der Mahngebühren bis zur unten genannten Frist.`;
  }
  return `trotz unserer bisherigen Schreiben ist ${ref} noch immer nicht beglichen.\n\nWir fordern Sie hiermit letztmalig auf, den offenen Gesamtbetrag bis zur unten genannten Frist zu zahlen. Nach Ablauf der Frist werden wir die Forderung ohne weitere Ankündigung gerichtlich geltend machen bzw. an ein Inkassounternehmen übergeben.`;
}

/** Mahnschreiben als PDF */
export async function renderDunningPdf(t: Tenant, dunning: Dunning, invoice: { snapshot: string }, previous: Dunning[]): Promise<Buffer> {
  const inv = JSON.parse(invoice.snapshot) as DocumentData;
  const seller = sellerFromTenant(t);
  const fees = previous.filter((p) => p.level < dunning.level);
  const open = dueAmount(inv);
  const total = open + fees.reduce((s, p) => s + p.fee, 0) + dunning.fee;
  const title = levelLabel(dunning.level);

  const info: [string, string][] = [
    ['Datum', formatDate(dunning.issue_date)],
    ['Rechnungsnr.', inv.number],
    ['Rechnungsdatum', formatDate(inv.issueDate)],
  ];
  if (inv.buyer.customerNumber) info.push(['Kundennr.', inv.buyer.customerNumber]);
  if (seller.contactName) info.push(['Ansprechpartner', seller.contactName]);

  const letter = startLetter({
    logo: await getLogo(t.id),
    seller,
    recipient: inv.buyer,
    info,
    title,
    subtitle: `zur Rechnung ${inv.number} vom ${formatDate(inv.issueDate)}`,
    issueDate: dunning.issue_date,
  });
  const { doc } = letter;
  let y = letter.paragraphs(letter.y, [{ text: 'Sehr geehrte Damen und Herren,' }, { text: dunning.text }]);

  const rows: [string, string, boolean][] = [
    [`${INVOICE_TYPES[inv.typeCode] ?? 'Rechnung'} ${inv.number}, fällig seit ${formatDate(inv.dueDate ?? inv.issueDate)}`, formatMoney(open), false],
  ];
  for (const p of fees) if (p.fee) rows.push([`Mahngebühr ${levelLabel(p.level)} vom ${formatDate(p.issue_date)}`, formatMoney(p.fee), false]);
  if (dunning.fee) rows.push([`Mahngebühr ${title}`, formatMoney(dunning.fee), false]);
  rows.push(['Offener Betrag', formatMoney(total), true]);
  doc.font('R');
  y = sumBlock(letter, y + 4, rows, LETTER_LEFT);

  const paras: { text: string; font?: string; color?: string }[] = [
    { text: `Bitte überweisen Sie ${formatMoney(total)} bis spätestens ${formatDate(dunning.deadline)}.`, font: 'B' },
  ];
  if (fees.length || dunning.fee) paras.push({ text: 'Mahngebühren sind nicht umsatzsteuerpflichtig.', color: '#6b6a66' });
  paras.push({ text: 'Sollten Sie die Zahlung zwischenzeitlich veranlasst haben, betrachten Sie dieses Schreiben bitte als gegenstandslos.' });
  paras.push({ text: `Mit freundlichen Grüßen\n${seller.contactName || seller.name}` });
  letter.paragraphs(y + 14, paras);
  return letter.finish();
}

/** Abschnitt „Mahnungen“ auf der Rechnungsseite */
export async function dunningSection(c: Ctx, t: Tenant, inv: { id: number; status: string; type_code: string; due_date: string | null; finalized_at: string | null }): Promise<SafeHtml> {
  if (!inv.finalized_at || inv.type_code === '381') return html``;
  const list = await getDunnings(inv.id);
  const overdue = inv.status === 'open' && !!inv.due_date && inv.due_date < today();
  if (!list.length && !overdue) return html``;
  const next = list.length + 1;
  return html`<section>
    <h2 class="section-title">Mahnungen ${list.length ? html`<span class="count">${list.length}</span>` : ''}</h2>
    ${list.length
      ? html`<div class="card flush"><table class="table">
          <thead><tr><th>Stufe</th><th>Datum</th><th>Frist</th><th class="right">Gebühr</th><th></th></tr></thead>
          <tbody>${list.map((d, i) => html`<tr>
            <td>${levelLabel(d.level)}</td><td>${formatDate(d.issue_date)}</td><td>${formatDate(d.deadline)}</td>
            <td class="right num">${formatMoney(d.fee)}</td>
            <td class="right"><a href="/dunnings/${d.id}/pdf" target="_blank">PDF</a>
              ${i === list.length - 1
                ? html` · <form method="post" action="/dunnings/${d.id}/delete" class="inline" data-confirm="${levelLabel(d.level)} löschen?">${csrfField(c)}<button class="link danger">Löschen</button></form>`
                : ''}</td></tr>`)}
          </tbody></table></div>`
      : ''}
    ${canDun(inv, list) && overdue
      ? html`<a class="btn" href="/invoices/${inv.id}/dunning/new">${levelLabel(next)} erstellen</a>`
      : ''}
  </section>`;
}

function register(app: App) {
  app.get('/dunning', async (c) => {
    const t = tenantOf(c);
    const d = today();
    const invoices = await overdueInvoices(t.id);
    const ready = invoices.filter((i) => (i.last_level ?? 0) < MAX_LEVEL && nextDueDate(t, i) <= d);
    const waiting = invoices.filter((i) => !ready.includes(i));
    const recent = await all(
      `SELECT x.*, d.number, COALESCE(NULLIF(c.company, ''), c.name) AS contact_label, d.status
       FROM dunnings x JOIN documents d ON d.id = x.invoice_id JOIN contacts c ON c.id = d.contact_id
       WHERE x.tenant_id = ? ORDER BY x.issue_date DESC, x.id DESC LIMIT 50`,
      t.id,
    );

    const row = (i: DunnableInvoice, action: boolean) => {
      const days = daysBetween(i.due_date, d);
      const next = (i.last_level ?? 0) + 1;
      return html`<tr class="rowlink" data-href="/invoices/${i.id}">
        <td class="mono"><a href="/invoices/${i.id}">${i.number}</a></td>
        <td>${i.contact_label}</td>
        <td>${formatDate(i.due_date)} <span class="muted small">(${days} Tage)</span></td>
        <td>${i.last_level ? html`${levelLabel(i.last_level)} <span class="muted small">Frist ${formatDate(i.last_deadline)}</span>` : html`<span class="muted">–</span>`}</td>
        <td class="right num">${formatMoney(i.gross_total)}</td>
        <td class="right">${action
          ? html`<a class="btn primary" href="/invoices/${i.id}/dunning/new">${levelLabel(next)}</a>`
          : (i.last_level ?? 0) >= MAX_LEVEL
            ? html`<span class="muted small">alle Stufen ausgeschöpft</span>`
            : html`<span class="muted small">ab ${formatDate(nextDueDate(t, i))}</span>`}</td>
      </tr>`;
    };
    const head = html`<thead><tr><th>Rechnung</th><th>Kunde</th><th>Fällig seit</th><th>Letzte Stufe</th><th class="right">Betrag</th><th></th></tr></thead>`;

    return page(c, {
      title: 'Mahnwesen',
      actions: html`<a class="btn ghost" href="/settings">Gebühren & Fristen</a>`,
      body: html`
      <h2 class="section-title">Jetzt mahnen <span class="count">${ready.length}</span></h2>
      ${ready.length
        ? html`<div class="card flush"><table class="table">${head}<tbody>${ready.map((i) => row(i, true))}</tbody></table></div>`
        : empty('Keine Rechnung muss gerade gemahnt werden.')}
      ${waiting.length
        ? html`<h2 class="section-title">Überfällig – Frist bzw. Kulanz läuft <span class="count">${waiting.length}</span></h2>
          <div class="card flush"><table class="table">${head}<tbody>${waiting.map((i) => row(i, false))}</tbody></table></div>`
        : ''}
      ${recent.length
        ? html`<h2 class="section-title">Versendete Mahnungen</h2>
          <div class="card flush"><table class="table">
            <thead><tr><th>Datum</th><th>Stufe</th><th>Rechnung</th><th>Kunde</th><th>Frist</th><th>Status</th><th></th></tr></thead>
            <tbody>${recent.map((r) => html`<tr>
              <td>${formatDate(r.issue_date)}</td><td>${levelLabel(r.level)}</td>
              <td class="mono"><a href="/invoices/${r.invoice_id}">${r.number}</a></td><td>${r.contact_label}</td>
              <td>${formatDate(r.deadline)}</td><td>${badge(r.status)}</td>
              <td class="right"><a href="/dunnings/${r.id}/pdf" target="_blank">PDF</a></td></tr>`)}
            </tbody></table></div>`
        : ''}`,
    });
  });

  app.get('/invoices/:id/dunning/new', async (c) => {
    const t = tenantOf(c);
    const inv = (await getInvoice(t.id, idParam(c))) ?? notFound();
    const list = await getDunnings(inv.id);
    if (!canDun(inv, list)) return redirectWith(c, `/invoices/${inv.id}`, 'error', 'Für diese Rechnung kann keine weitere Mahnung erstellt werden.');
    const level = list.length + 1;
    const date = today();
    const previousFees = list.reduce((s, d) => s + d.fee, 0);
    return page(c, {
      title: `${levelLabel(level)} zu ${inv.number}`,
      back: { href: `/invoices/${inv.id}`, label: `Rechnung ${inv.number}` },
      body: html`
      <form method="post" action="/invoices/${inv.id}/dunning" class="card stack">
        ${csrfField(c)}
        <div class="grid-3">
          <label>Datum <input type="date" name="issue_date" value="${date}" required></label>
          <label>Zahlungsfrist bis <input type="date" name="deadline" value="${addDays(date, t.dunning_deadline_days)}" required></label>
          <label>Mahngebühr (€) <input name="fee" class="num" inputmode="decimal" value="${formatAmount(feeFor(t, level)).replace(/\./g, '')}"></label>
          <label class="span-3">Text <textarea name="text" rows="7">${defaultText(level, inv, list)}</textarea>
            <small class="muted">Anrede, Aufstellung der Beträge, Bankverbindung und Grußformel werden automatisch ergänzt.</small></label>
        </div>
        <p class="muted small">Offener Rechnungsbetrag ${formatMoney(inv.gross_total - inv.prepaid_total)}${previousFees ? ` · bisherige Mahngebühren ${formatMoney(previousFees)}` : ''}</p>
        <div class="form-actions"><button class="btn primary">${levelLabel(level)} erstellen</button></div>
      </form>`,
    });
  });

  app.post('/invoices/:id/dunning', async (c) => {
    const t = tenantOf(c);
    const inv = (await getInvoice(t.id, idParam(c))) ?? notFound();
    const list = await getDunnings(inv.id);
    if (!canDun(inv, list)) return redirectWith(c, `/invoices/${inv.id}`, 'error', 'Für diese Rechnung kann keine weitere Mahnung erstellt werden.');
    const form = await readForm(c);
    const issueDate = str(form, 'issue_date');
    const deadline = str(form, 'deadline');
    const fee = parseDecimal(str(form, 'fee') || '0', 2);
    const text = str(form, 'text', 4000);
    const back = `/invoices/${inv.id}/dunning/new`;
    if (!isIsoDate(issueDate) || !isIsoDate(deadline)) return redirectWith(c, back, 'error', 'Bitte gültige Daten angeben.');
    if (deadline <= issueDate) return redirectWith(c, back, 'error', 'Die Frist muss nach dem Mahndatum liegen.');
    if (fee === null || fee < 0 || fee > 100_000) return redirectWith(c, back, 'error', 'Ungültige Mahngebühr.');
    if (!text) return redirectWith(c, back, 'error', 'Bitte einen Text angeben.');
    const level = list.length + 1;
    await run(
      'INSERT INTO dunnings (tenant_id, invoice_id, level, issue_date, deadline, fee, text, created_by, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
      t.id, inv.id, level, issueDate, deadline, fee, text, userOf(c).id, nowIso(),
    );
    return redirectWith(c, `/invoices/${inv.id}`, 'ok', `${levelLabel(level)} erstellt – das PDF findest du unten unter „Mahnungen“.`);
  });

  app.get('/dunnings/:id/pdf', async (c) => {
    const t = tenantOf(c);
    const d = (await one<Dunning>('SELECT * FROM dunnings WHERE id = ? AND tenant_id = ?', idParam(c), t.id)) ?? notFound();
    const inv = (await getInvoice(t.id, d.invoice_id)) ?? notFound();
    const pdf = await renderDunningPdf(t, d, inv, await getDunnings(inv.id));
    const name = `${levelLabel(d.level).replace(/\.\s*/g, '_').replace(/\s+/g, '_')}_${inv.number}.pdf`;
    return c.body(new Uint8Array(pdf), 200, {
      'Content-Type': 'application/pdf',
      'Content-Disposition': attachment(name, true),
      'Cache-Control': 'private, no-store',
    });
  });

  app.post('/dunnings/:id/delete', async (c) => {
    const t = tenantOf(c);
    const d = (await one<Dunning>('SELECT * FROM dunnings WHERE id = ? AND tenant_id = ?', idParam(c), t.id)) ?? notFound();
    const max = await one<{ m: number }>('SELECT MAX(level) AS m FROM dunnings WHERE invoice_id = ?', d.invoice_id);
    if (max?.m !== d.level) return redirectWith(c, `/invoices/${d.invoice_id}`, 'error', 'Nur die letzte Mahnstufe kann gelöscht werden.');
    await run('DELETE FROM dunnings WHERE id = ?', d.id);
    return redirectWith(c, `/invoices/${d.invoice_id}`, 'ok', `${levelLabel(d.level)} gelöscht.`);
  });
}

export const dunningModule: Module = {
  name: 'dunning',
  nav: { label: 'Mahnwesen', href: '/dunning', order: 35 },
  register,
};

