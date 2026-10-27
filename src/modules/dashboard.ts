import { all, one } from '../db/index.ts';
import { html, selected } from '../lib/html.ts';
import { barChart, meter, pieChart, type ChartPoint, type PieSlice } from '../views/chart.ts';
import { formatDate, MONTH_NAMES, today } from '../lib/dates.ts';
import { formatMoney } from '../lib/money.ts';
import { tenantOf } from '../lib/http.ts';
import { page } from '../views/layout.ts';
import { tenantProblems } from './settings.ts';
import { documentTable } from './documents/views.ts';
import { invitationsBox, pendingInvitations } from './invitations.ts';
import { userOf } from '../lib/http.ts';
import type { Module } from '../types.ts';

/**
 * Netto-Umsatz festgeschriebener Rechnungen. Stornos zählen negativ; bei Teilschluss- und
 * Schlussrechnungen werden die bereits als Teilrechnung erfassten Beträge abgezogen (sonst doppelt).
 */
const REVENUE = `COALESCE(SUM(CASE WHEN documents.type_code = '381' THEN -documents.net_total ELSE documents.net_total -
  (SELECT COALESCE(SUM(p.net_total), 0) FROM document_prepayments x JOIN documents p ON p.id = x.prepaid_id WHERE x.document_id = documents.id)
END), 0)`;

const MONTHS = MONTH_NAMES;

/** Grenzen der Kleinunternehmerregelung (§ 19 Abs. 1 UStG, gültig ab 2025), in Cent */
const KU_PREV_YEAR_LIMIT = 25_000_00;
const KU_CURRENT_YEAR_LIMIT = 100_000_00;

/** Netto-Umsatz eines Jahres aus festgeschriebenen Rechnungen */
async function yearRevenue(tenantId: number, year: string | number): Promise<{ n: number; s: number }> {
  const r = await one<{ n: number; s: number | string }>(
    `SELECT COUNT(*) n, ${REVENUE} s FROM documents
     WHERE tenant_id = ? AND kind = 'invoice' AND finalized_at IS NOT NULL AND substr(issue_date, 1, 4) = ?`,
    tenantId, String(year),
  );
  return { n: Number(r?.n ?? 0), s: Number(r?.s ?? 0) };
}

/** Die 24 Monate bis einschließlich des laufenden */
function last24Months(todayIso: string) {
  const [cy, cm] = todayIso.split('-').map(Number);
  const months: { key: string; y: number; m: number }[] = [];
  for (let i = 23; i >= 0; i--) {
    const idx = cy * 12 + (cm - 1) - i;
    const y = Math.floor(idx / 12);
    const m = idx % 12;
    months.push({ key: `${y}-${String(m + 1).padStart(2, '0')}`, y, m });
  }
  return months;
}
const MONTHS_SHORT = ['Jan', 'Feb', 'Mär', 'Apr', 'Mai', 'Jun', 'Jul', 'Aug', 'Sep', 'Okt', 'Nov', 'Dez'];

/** Jahre mit festgeschriebenen Rechnungen plus das laufende Jahr, neueste zuerst */
async function revenueYears(tenantId: number, current: string): Promise<string[]> {
  const rows = await all<{ y: string }>(
    "SELECT DISTINCT substr(issue_date, 1, 4) y FROM documents WHERE tenant_id = ? AND kind = 'invoice' AND finalized_at IS NOT NULL",
    tenantId,
  );
  return [...new Set([current, ...rows.map((r) => String(r.y))])].sort().reverse();
}

/** Rechnungsbeträge der letzten 24 Monate (inkl. laufendem Monat) */
async function monthlyChart(tenantId: number, todayIso: string) {
  const months = last24Months(todayIso);
  const rows = await all<{ ym: string; n: number; s: number | string }>(
    `SELECT substr(issue_date, 1, 7) ym, COUNT(*) n, ${REVENUE} s FROM documents
     WHERE tenant_id = ? AND kind = 'invoice' AND finalized_at IS NOT NULL AND issue_date >= ? AND issue_date <= ?
     GROUP BY ym`,
    tenantId, `${months[0].key}-01`, `${months[23].key}-31`,
  );
  const byMonth = new Map(rows.map((r) => [String(r.ym), r]));
  const points: ChartPoint[] = months.map((mo, i) => {
    const r = byMonth.get(mo.key);
    return {
      label: MONTHS_SHORT[mo.m],
      title: `${MONTHS[mo.m]} ${mo.y}`,
      value: Number(r?.s ?? 0),
      count: Number(r?.n ?? 0),
      current: i === months.length - 1,
      // Jahr am Anfang nur, wenn bis zum nächsten Januar genug Platz ist
      yearStart: mo.m === 0 || (i === 0 && mo.m <= 8) ? String(mo.y) : undefined,
      href: `/invoices?month=${mo.key}`,
    };
  });
  return barChart(points, {
    caption: 'Rechnungen der letzten 24 Monate',
    emptyText: 'In den letzten 24 Monaten wurden keine Rechnungen festgeschrieben.',
    hint: 'Klick auf eine Säule zeigt die Rechnungen des Monats – am Handy zweimal antippen.',
  });
}

/** Top-5-Kunden nach Netto-Umsatz der letzten 24 Monate, Rest als „Sonstige“ */
async function topCustomers(tenantId: number, todayIso: string) {
  const from = `${last24Months(todayIso)[0].key}-01`;
  const rows = await all<{ id: number; label: string; s: number | string }>(
    `SELECT c.id, COALESCE(NULLIF(c.company, ''), c.name) label, ${REVENUE} s
     FROM documents JOIN contacts c ON c.id = documents.contact_id
     WHERE documents.tenant_id = ? AND documents.kind = 'invoice' AND documents.finalized_at IS NOT NULL
       AND documents.issue_date >= ? AND documents.issue_date <= ?
     GROUP BY c.id, label ORDER BY s DESC`,
    tenantId, from, todayIso,
  );
  const positive = rows.map((r) => ({ ...r, s: Number(r.s) })).filter((r) => r.s > 0);
  const top = positive.slice(0, 5);
  const rest = positive.slice(5).reduce((a, r) => a + r.s, 0);
  const slices: PieSlice[] = top.map((r) => ({ label: r.label, value: r.s, href: `/contacts/${r.id}` }));
  if (rest > 0) slices.push({ label: `Sonstige (${positive.length - 5})`, value: rest, rest: true });
  return pieChart(slices, {
    caption: 'Top-Kunden',
    sub: `Netto-Umsatz seit ${formatDate(from)}`,
    emptyText: 'In den letzten 24 Monaten gibt es noch keinen Umsatz.',
    centerLabel: '24 Monate',
  });
}

/** Kleinunternehmergrenze nach § 19 UStG – nur wenn die Regelung aktiv ist */
async function smallBusinessLimits(tenantId: number, year: number) {
  const prev = await yearRevenue(tenantId, year - 1);
  const cur = await yearRevenue(tenantId, year);
  const prevOver = prev.s > KU_PREV_YEAR_LIMIT;
  const next = year + 1;
  // Zustand: unter 80 % der 25.000-€-Grenze ok, darüber Warnung, über 25.000 € Folgejahr betroffen, über 100.000 € sofort
  const state = cur.s > KU_CURRENT_YEAR_LIMIT ? 'danger' : cur.s > KU_PREV_YEAR_LIMIT ? 'over' : cur.s >= KU_PREV_YEAR_LIMIT * 0.8 ? 'warn' : 'ok';
  const status =
    state === 'danger'
      ? html`<strong>100.000 € überschritten:</strong> Ab dem Umsatz, mit dem die Grenze überschritten wurde, gilt die Regelbesteuerung.`
      : state === 'over'
        ? html`<strong>25.000 € überschritten:</strong> ${next} ist die Kleinunternehmerregelung nicht mehr möglich. Bis zur Höchstgrenze von 100.000 € bleibt ${year} noch ${formatMoney(KU_CURRENT_YEAR_LIMIT - cur.s)}.`
        : html`Noch <strong>${formatMoney(KU_PREV_YEAR_LIMIT - cur.s)}</strong> bis 25.000 € – bleibst du darunter, kannst du ${next} weiter Kleinunternehmer sein.`;
  return html`<section class="card ku">
    <h2>Kleinunternehmergrenze <span class="muted small">§ 19 UStG</span></h2>
    ${meter(cur.s, KU_CURRENT_YEAR_LIMIT, {
      label: `Umsatz ${year} bisher`,
      state,
      marks: [{ value: KU_PREV_YEAR_LIMIT, label: `25.000 € · Grenze für ${next}` }],
    })}
    <p class="small ku-status ku-${state}">${status}</p>
    <p class="small ${prevOver ? 'danger-text' : 'muted'}">Vorjahr ${year - 1}: ${formatMoney(prev.s)}
      ${prevOver ? ` – über ${formatMoney(KU_PREV_YEAR_LIMIT)}, die Kleinunternehmerregelung ist ${year} nicht anwendbar.` : ` – innerhalb der Grenze von ${formatMoney(KU_PREV_YEAR_LIMIT)}.`}</p>
    <p class="muted small">Berechnet aus den festgeschriebenen Rechnungen in Schottr. Maßgeblich ist dein gesamter Umsatz – Umsätze außerhalb von Schottr zählen mit.</p>
  </section>`;
}

export const dashboardModule: Module = {
  name: 'dashboard',
  nav: { label: 'Übersicht', href: '/', order: 0 },
  register(app) {
    app.get('/', async (c) => {
      const t = tenantOf(c);
      const d = today();
      const year = d.slice(0, 4);
      const stat = async (sql: string, ...p: (string | number)[]) => (await one<{ n: number; s: number }>(sql, t.id, ...p)) ?? { n: 0, s: 0 };
      const open = await stat("SELECT COUNT(*) n, COALESCE(SUM(gross_total - prepaid_total), 0) s FROM documents WHERE tenant_id = ? AND kind = 'invoice' AND status = 'open'");
      const overdue = await stat("SELECT COUNT(*) n, COALESCE(SUM(gross_total - prepaid_total), 0) s FROM documents WHERE tenant_id = ? AND kind = 'invoice' AND status = 'open' AND due_date < ?", d);
      const quotes = await stat("SELECT COUNT(*) n, COALESCE(SUM(gross_total), 0) s FROM documents WHERE tenant_id = ? AND kind = 'quote' AND status IN ('draft', 'sent')");
      const years = await revenueYears(t.id, year);
      const reqYear = c.req.query('year') ?? '';
      const selYear = years.includes(reqYear) ? reqYear : year;
      const revenue = await stat(
        `SELECT COUNT(*) n, ${REVENUE} s FROM documents
         WHERE tenant_id = ? AND kind = 'invoice' AND finalized_at IS NOT NULL AND substr(issue_date, 1, 4) = ?`,
        selYear,
      );
      const chart = await monthlyChart(t.id, d);
      const customers = await topCustomers(t.id, d);
      const ku = t.small_business ? await smallBusinessLimits(t.id, Number(year)) : null;
      const drafts = await all(
        `SELECT d.*, COALESCE(NULLIF(c.company, ''), c.name) contact_label FROM documents d JOIN contacts c ON c.id = d.contact_id
         WHERE d.tenant_id = ? AND d.kind = 'invoice' AND d.status = 'draft' ORDER BY d.updated_at DESC LIMIT 10`, t.id,
      );
      const openList = await all(
        `SELECT d.*, COALESCE(NULLIF(c.company, ''), c.name) contact_label,
           (SELECT MAX(level) FROM dunnings x WHERE x.invoice_id = d.id) AS dunning_level
         FROM documents d JOIN contacts c ON c.id = d.contact_id
         WHERE d.tenant_id = ? AND d.kind = 'invoice' AND d.status = 'open' ORDER BY d.due_date LIMIT 10`, t.id,
      );
      const problems = tenantProblems(t);
      const invites = await pendingInvitations(userOf(c).email);
      return page(c, {
        title: 'Übersicht',
        actions: html`<a class="btn" href="/quotes/new">Neues Angebot</a><a class="btn primary" href="/invoices/new">Neue Rechnung</a>`,
        body: html`
        ${invitationsBox(c, invites)}
        ${problems.length
          ? html`<div class="notice">Deine Firmendaten sind noch unvollständig – es fehlen: ${problems.join(", ")}. <a href="/settings">Jetzt ergänzen</a></div>`
          : ''}
        <div class="stats">
          <a class="stat" href="/invoices?status=open"><span>Offene Rechnungen</span><strong>${formatMoney(open.s)}</strong><small>${open.n} Beleg(e)</small></a>
          <a class="stat ${overdue.n ? 'alert' : ''}" href="/dunning"><span>Überfällig</span><strong>${formatMoney(overdue.s)}</strong><small>${overdue.n} Beleg(e)</small></a>
          <a class="stat" href="/quotes?status=sent"><span>Offene Angebote</span><strong>${formatMoney(quotes.s)}</strong><small>${quotes.n} Beleg(e)</small></a>
          <div class="stat">
            <form method="get" action="/" class="stat-year">
              <label for="revenue-year">Umsatz</label>
              <select id="revenue-year" name="year" data-autosubmit>${years.map((y) => html`<option value="${y}"${selected(y, selYear)}>${y}</option>`)}</select>
              <span>(netto)</span>
              <noscript><button class="btn">OK</button></noscript>
            </form>
            <strong>${formatMoney(revenue.s)}</strong><small>${revenue.n} Rechnung(en)</small>
          </div>
        </div>
        ${chart}
        <div class="dash-grid${ku ? '' : ' single'}">${customers}${ku ?? ''}</div>
        ${drafts.length ? html`<h2 class="section-title">Rechnungsentwürfe</h2>${documentTable(drafts, 'invoice')}` : ''}
        <h2 class="section-title">Offene Rechnungen</h2>
        ${openList.length ? documentTable(openList, 'invoice') : html`<p class="muted">Keine offenen Rechnungen. 🎉</p>`}`,
      });
    });
  },
};
