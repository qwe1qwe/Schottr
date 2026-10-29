import { all, one } from '../db/index.ts';
import { html, raw, selected } from '../lib/html.ts';
import { barChart, compareChart, meter, pieChart, type ChartPoint, type ComparePoint, type PieSlice } from '../views/chart.ts';
import { formatDate, MONTH_NAMES, today } from '../lib/dates.ts';
import { formatMoney } from '../lib/money.ts';
import { tenantOf } from '../lib/http.ts';
import { getCookie, setCookie } from 'hono/cookie';
import type { Ctx } from '../types.ts';
import { page } from '../views/layout.ts';
import { tenantProblems } from './settings.ts';
import { documentTable } from './documents/views.ts';
import { invitationsBox, pendingInvitations } from './invitations.ts';
import { userOf } from '../lib/http.ts';
import { openLiabilities } from './purchases/routes.ts';
import { purchaseBadge, purchaseStatus } from './purchases/views.ts';
import { dueOf, payable, type Purchase } from './purchases/repo.ts';
import { isSphere, nonprofitLimits, NONPROFIT_ALLOWANCE, SPHERES, type Sphere } from '../lib/nonprofit.ts';
import { donationTotals } from './donations/repo.ts';
import { cashbookDash, pendingCard } from './cashbook/routes.ts';
import { cashbookEnabled, pendingDues } from './cashbook/repo.ts';
import { inboxCount } from './inbox/repo.ts';
import { SOURCE_LABELS } from './cashbook/repo.ts';
import { fileCounts } from './cashbook/files.ts';
import { categoryLabel } from '../lib/expenses.ts';
import { sphereLabel } from '../lib/nonprofit.ts';
import { notFound } from '../lib/http.ts';
import type { SafeHtml } from '../lib/html.ts';
import type { Module, Tenant } from '../types.ts';

/**
 * Netto-Umsatz festgeschriebener Rechnungen. Stornos zählen negativ; bei Teilschluss- und
 * Schlussrechnungen werden die bereits als Teilrechnung erfassten Beträge abgezogen (sonst doppelt).
 */
const revenueSql = (col: 'net_total' | 'gross_total') => `COALESCE(SUM(CASE WHEN documents.type_code = '381' THEN -documents.${col} ELSE documents.${col} -
  (SELECT COALESCE(SUM(p.${col}), 0) FROM document_prepayments x JOIN documents p ON p.id = x.prepaid_id WHERE x.document_id = documents.id)
END), 0)`;

/** Beträge in der Übersicht netto oder brutto – im Verein interessiert meist nur brutto (Grenzen der AO, Kasse) */
type Basis = 'net' | 'gross';
const docCol = (b: Basis) => (b === 'gross' ? 'gross_total' : 'net_total');
const basisWord = (b: Basis) => (b === 'gross' ? 'brutto' : 'netto');

/**
 * Gewählte Basis: ?basis=net|gross setzt sie (je Mandant als Cookie gemerkt), sonst das Cookie,
 * sonst die Vorgabe – brutto für Vereine, netto für Unternehmen.
 */
function dashBasis(c: Ctx, t: Tenant): Basis {
  const name = `schottr_basis_${t.id}`;
  const q = c.req.query('basis');
  if (q === 'net' || q === 'gross') {
    setCookie(c, name, q, { path: '/', maxAge: 60 * 60 * 24 * 365, sameSite: 'Lax', httpOnly: true });
    return q;
  }
  const v = getCookie(c, name);
  if (v === 'net' || v === 'gross') return v;
  return t.org_type === 'association' ? 'gross' : 'net';
}

const MONTHS = MONTH_NAMES;

/**
 * Ausgaben aus erfassten Eingangsrechnungen (Gutschriften negativ). Mit Vorsteuerabzug zählt
 * der Nettobetrag, als Kleinunternehmer der Bruttobetrag – die Vorsteuer bekommt man dann nicht erstattet.
 */
const COST = (t: Pick<Tenant, 'small_business'>, basis: Basis = 'net') => {
  const col = t.small_business || basis === 'gross' ? 'gross_total' : 'net_total';
  return `COALESCE(SUM(CASE WHEN p.is_credit = 1 THEN -p.${col} ELSE p.${col} END), 0)`;
};

/** Grenzen der Kleinunternehmerregelung (§ 19 Abs. 1 UStG, gültig ab 2025), in Cent */
const KU_PREV_YEAR_LIMIT = 25_000_00;
const KU_CURRENT_YEAR_LIMIT = 100_000_00;

/**
 * Zahlungseingänge aus Rechnungen (Zuflussprinzip, wie in der Einnahmenüberschussrechnung und
 * bei den Grenzen nach § 19 UStG – „nach vereinnahmten Entgelten“ – und der Abgabenordnung):
 * eine bezahlte Rechnung zählt im Jahr der Zahlung (bei Teilschluss- und Schlussrechnungen ohne
 * die schon als Teilrechnung bezahlten Beträge), ein Storno einer bezahlten Rechnung als Erstattung
 * zum Stornodatum. Unbezahlte Rechnungen zählen noch nicht. Spalten: dt (Datum), sp (Bereich), s.
 */
const paidDocsSql = (col: 'net_total' | 'gross_total') => `
  SELECT d.paid_at dt, COALESCE(NULLIF(d.sphere, ''), ?) sp,
    d.${col} - (SELECT COALESCE(SUM(p.${col}), 0) FROM document_prepayments x JOIN documents p ON p.id = x.prepaid_id WHERE x.document_id = d.id) s
  FROM documents d
  WHERE d.tenant_id = ? AND d.kind = 'invoice' AND d.finalized_at IS NOT NULL AND d.type_code <> '381' AND d.paid_at IS NOT NULL
  UNION ALL
  SELECT d.issue_date dt, COALESCE(NULLIF(o.sphere, ''), ?) sp, -d.${col} s
  FROM documents d JOIN documents o ON o.id = d.corrects_id
  WHERE d.tenant_id = ? AND d.kind = 'invoice' AND d.finalized_at IS NOT NULL AND d.type_code = '381' AND o.paid_at IS NOT NULL`;
const paidDocsParams = (t: Tenant) => [t.default_sphere || 'business', t.id, t.default_sphere || 'business', t.id];

/** Nettobetrag einer Kassenbuch-Buchung (enthaltene USt. abgezogen) */
const CASH_NET = 'amount - IF(vat_rate > 0, ROUND(amount * vat_rate / (10000 + vat_rate)), 0)';
/** Einnahmen ohne Rechnung: freie Einnahme-Buchungen und Kassenzählungen (deren Differenz ist der geschätzte Barumsatz) */
const CASH_INCOME = "(source = 'count' OR (source = 'manual' AND amount > 0))";
/** Ausgaben ohne Eingangsrechnung: freie Ausgabe-Buchungen, z. B. Porto, Kontogebühren, Miete per Dauerauftrag */
const CASH_EXPENSE = "source = 'manual' AND amount < 0";

/**
 * Netto-Umsatz eines Jahres nach Zahlungseingang: bezahlte Rechnungen plus Bareinnahmen ohne
 * Rechnung aus dem Kassenbuch. Bei gemeinnützigen Mandanten bleibt der ideelle Bereich außen vor –
 * er ist nicht unternehmerisch.
 */
async function yearRevenue(t: Tenant, year: string | number, basis: Basis = 'net'): Promise<{ n: number; s: number; cashN: number; cash: number }> {
  const noIdeell = t.nonprofit ? "AND sp <> 'ideell'" : '';
  const docs = await one<{ n: number; s: number | string }>(
    `SELECT COALESCE(SUM(s >= 0), 0) n, COALESCE(SUM(s), 0) s FROM (${paidDocsSql(docCol(basis))}) x WHERE substr(dt, 1, 4) = ? ${noIdeell}`,
    ...paidDocsParams(t), String(year),
  );
  const cash = await one<{ n: number; s: number | string }>(
    `SELECT COUNT(*) n, COALESCE(SUM(${basis === 'gross' ? 'amount' : CASH_NET}), 0) s FROM cash_entries
     WHERE tenant_id = ? AND substr(entry_date, 1, 4) = ? AND ${CASH_INCOME} ${t.nonprofit ? "AND COALESCE(NULLIF(sphere, ''), ?) <> 'ideell'" : ''}`,
    t.id, String(year), ...(t.nonprofit ? [t.default_sphere || 'business'] : []),
  );
  const cashS = Number(cash?.s ?? 0);
  return { n: Number(docs?.n ?? 0), s: Number(docs?.s ?? 0) + cashS, cashN: Number(cash?.n ?? 0), cash: cashS };
}

/**
 * Ausgaben eines Jahres nach Zahlung: bezahlte Eingangsrechnungen (mit Vorsteuerabzug netto, als
 * Kleinunternehmer brutto) plus Ausgaben ohne Eingangsrechnung aus dem Kassenbuch. Je Monat (mm).
 */
async function yearCosts(t: Tenant, year: string, basis: Basis = 'net'): Promise<Map<string, number>> {
  const rows = await all<{ m: string; s: number | string }>(
    `SELECT m, SUM(s) s FROM (
       SELECT substr(p.paid_at, 6, 2) m, ${COST(t, basis)} s FROM purchase_invoices p
       WHERE p.tenant_id = ? AND p.status = 'paid' AND p.paid_at IS NOT NULL AND substr(p.paid_at, 1, 4) = ? GROUP BY m
       UNION ALL
       SELECT substr(entry_date, 6, 2) m, -SUM(${t.small_business || basis === 'gross' ? 'amount' : CASH_NET}) s FROM cash_entries
       WHERE tenant_id = ? AND substr(entry_date, 1, 4) = ? AND ${CASH_EXPENSE} GROUP BY m
     ) x GROUP BY m`,
    t.id, year, t.id, year,
  );
  return new Map(rows.map((r) => [String(r.m), Number(r.s)]));
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

/** Jahre mit Rechnungen, Zahlungen oder Kassenbuchungen plus das laufende Jahr, neueste zuerst */
async function revenueYears(tenantId: number, current: string): Promise<string[]> {
  const rows = await all<{ y: string }>(
    `SELECT DISTINCT substr(issue_date, 1, 4) y FROM documents WHERE tenant_id = ? AND kind = 'invoice' AND finalized_at IS NOT NULL
     UNION SELECT DISTINCT substr(paid_at, 1, 4) y FROM documents WHERE tenant_id = ? AND kind = 'invoice' AND paid_at IS NOT NULL
     UNION SELECT DISTINCT substr(issue_date, 1, 4) y FROM purchase_invoices WHERE tenant_id = ? AND status <> 'draft' AND issue_date IS NOT NULL
     UNION SELECT DISTINCT substr(paid_at, 1, 4) y FROM purchase_invoices WHERE tenant_id = ? AND status = 'paid' AND paid_at IS NOT NULL
     UNION SELECT DISTINCT substr(entry_date, 1, 4) y FROM cash_entries WHERE tenant_id = ?`,
    tenantId, tenantId, tenantId, tenantId, tenantId,
  );
  return [...new Set([current, ...rows.map((r) => String(r.y))])].sort().reverse();
}

/** Rechnungsbeträge der letzten 24 Monate (inkl. laufendem Monat) */
async function monthlyChart(tenantId: number, todayIso: string, basis: Basis) {
  const months = last24Months(todayIso);
  const rows = await all<{ ym: string; n: number; s: number | string }>(
    `SELECT substr(issue_date, 1, 7) ym, COUNT(*) n, ${revenueSql(docCol(basis))} s FROM documents
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
    caption: `Rechnungen der letzten 24 Monate (${basisWord(basis)})`,
    emptyText: 'In den letzten 24 Monaten wurden keine Rechnungen festgeschrieben.',
    hint: 'Klick auf eine Säule zeigt die Rechnungen des Monats – am Handy zweimal antippen.',
  });
}

/** Top-5-Kunden nach Umsatz (netto oder brutto) der letzten 24 Monate, Rest als „Sonstige“ */
async function topCustomers(tenantId: number, todayIso: string, basis: Basis) {
  const from = `${last24Months(todayIso)[0].key}-01`;
  const rows = await all<{ id: number; label: string; s: number | string }>(
    `SELECT c.id, COALESCE(NULLIF(c.company, ''), c.name) label, ${revenueSql(docCol(basis))} s
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
    sub: `Umsatz ${basisWord(basis)} seit ${formatDate(from)}`,
    emptyText: 'In den letzten 24 Monaten gibt es noch keinen Umsatz.',
    centerLabel: '24 Monate',
  });
}

/** Umsatz und Ausgaben je Monat eines Jahres mit Ergebnis */
async function resultChart(t: Tenant, year: string, todayIso: string, basis: Basis) {
  const noIdeell = t.nonprofit ? "AND sp <> 'ideell'" : '';
  const rev = await all<{ m: string; s: number | string }>(
    `SELECT m, SUM(s) s FROM (
       SELECT substr(dt, 6, 2) m, s FROM (${paidDocsSql(docCol(basis))}) d WHERE substr(dt, 1, 4) = ? ${noIdeell}
       UNION ALL
       SELECT substr(entry_date, 6, 2) m, ${basis === 'gross' ? 'amount' : CASH_NET} s FROM cash_entries
       WHERE tenant_id = ? AND substr(entry_date, 1, 4) = ? AND ${CASH_INCOME} ${t.nonprofit ? "AND COALESCE(NULLIF(sphere, ''), ?) <> 'ideell'" : ''}
     ) x GROUP BY m`,
    ...paidDocsParams(t), year, t.id, year, ...(t.nonprofit ? [t.default_sphere || 'business'] : []),
  );
  const r = new Map(rev.map((x) => [String(x.m), Number(x.s)]));
  const k = await yearCosts(t, year, basis);
  const nowYm = todayIso.slice(0, 7);
  const points: ComparePoint[] = MONTHS_SHORT.map((label, i) => {
    const mm = String(i + 1).padStart(2, '0');
    const ym = `${year}-${mm}`;
    return {
      label,
      title: `${MONTHS[i]} ${year}`,
      revenue: r.get(mm) ?? 0,
      cost: k.get(mm) ?? 0,
      current: ym === nowYm,
      future: ym > nowYm,
      revenueHref: `/overview/${ym}#einnahmen`,
      costHref: `/overview/${ym}#ausgaben`,
    };
  });
  const costLabel = 'Ausgaben';
  return compareChart(points, {
    caption: `Umsatz und Ausgaben ${year}`,
    sub: `${basis === 'gross' ? 'brutto' : t.small_business ? 'Umsatz netto, Ausgaben brutto (kein Vorsteuerabzug)' : 'netto'} nach Zahlungsdatum, inkl. Barbuchungen ohne Beleg${t.nonprofit ? ', ohne ideellen Bereich' : ''} · Ergebnis vor Steuern und sonstigen Abzügen`,
    emptyText: `${year} gibt es noch keine Zahlungen.`,
    hint: 'Klick auf eine Säule zeigt alle Einnahmen bzw. Ausgaben des Monats – Rechnungen und Buchungen ohne Rechnung.',
    costLabel,
  });
}

/**
 * Kachel mit Umschalter: Top-Lieferanten nach Kosten bzw. größte Verbindlichkeiten (alle
 * Eingangsrechnungen, offene wie bezahlte) – jeweils für ein wählbares Jahr oder den ganzen Bestand.
 */
async function supplierCard(t: Tenant, period: string, years: string[], dashYear: string, basis: Basis) {
  const all_ = period === 'all';
  // Wie Ausgaben und Ergebnis nach Zahlungsdatum: nur bezahlte Eingangsrechnungen im gewählten Jahr
  const paidWhere = all_ ? '' : 'AND substr(p.paid_at, 1, 4) = ?';
  const params = all_ ? [] : [period];
  const rows = await all<{ id: number; label: string; s: number | string }>(
    `SELECT c.id, COALESCE(NULLIF(c.company, ''), c.name) label, ${COST(t, basis)} s
     FROM purchase_invoices p JOIN contacts c ON c.id = p.contact_id
     WHERE p.tenant_id = ? AND p.status = 'paid' AND p.paid_at IS NOT NULL ${paidWhere}
     GROUP BY c.id, label ORDER BY s DESC`,
    t.id, ...params,
  );
  const positive = rows.map((r) => ({ ...r, s: Number(r.s) })).filter((r) => r.s > 0);
  const slices: PieSlice[] = positive.slice(0, 5).map((r) => ({ label: r.label, value: r.s, href: `/contacts/${r.id}` }));
  const rest = positive.slice(5).reduce((a, r) => a + r.s, 0);
  if (rest > 0) slices.push({ label: `Sonstige (${positive.length - 5})`, value: rest, rest: true });
  const label = all_ ? 'gesamt' : period;
  const pie = pieChart(slices, {
    caption: 'Top-Lieferanten',
    sub: `${t.small_business || basis === 'gross' ? 'Kosten brutto' : 'Kosten netto'}, ${all_ ? 'bezahlt in allen Jahren' : `bezahlt im Jahr ${period}`}`,
    emptyText: all_ ? 'Es wurden noch keine Eingangsrechnungen bezahlt.' : `${period} wurden keine Eingangsrechnungen bezahlt.`,
    centerLabel: label,
    bare: true,
  });

  // Bezahlte nach Zahlungsjahr; noch offene gehören zum laufenden Jahr (bzw. zu „Alle Jahre“)
  const withOpen = all_ || period === today().slice(0, 4);
  const biggest = await all<Purchase & { contact_label: string | null }>(
    `SELECT p.*, COALESCE(NULLIF(c.company, ''), c.name) AS contact_label FROM purchase_invoices p LEFT JOIN contacts c ON c.id = p.contact_id
     WHERE p.tenant_id = ? AND p.is_credit = 0
       AND ((p.status = 'paid' AND p.paid_at IS NOT NULL ${paidWhere})${withOpen ? " OR p.status = 'open'" : ''})
     ORDER BY p.gross_total DESC, COALESCE(p.paid_at, p.issue_date) DESC LIMIT 6`,
    t.id, ...params,
  );
  const liabilities = biggest.length
    ? html`<ul class="plain liability-list">${biggest.map((p) => {
        const st = purchaseStatus(p);
        return html`<li>
          <a href="/purchases/${p.id}" class="liability-name">${p.contact_label ?? 'ohne Lieferant'}<span class="muted small"> · ${p.number || 'ohne Nr.'} · ${p.status === 'paid' && p.paid_at ? `bezahlt ${formatDate(p.paid_at)}` : formatDate(p.issue_date)}</span>${p.description ? html`<span class="muted small liability-desc">${p.description}</span>` : ''}</a>
          <span class="liability-due small">${st === 'open' ? html`<span class="muted">fällig ${formatDate(dueOf(p))}</span>` : purchaseBadge(st)}</span>
          <strong class="num">${formatMoney(p.gross_total)}</strong>
        </li>`;
      })}</ul>
      <p class="small"><a href="/purchases">Alle Eingangsrechnungen</a></p>`
    : html`<p class="muted small pie-empty">${all_ ? 'Keine Eingangsrechnungen.' : `${period} wurden keine Eingangsrechnungen bezahlt${withOpen ? ', offen ist auch keine' : ''}.`}</p>`;

  return html`<section class="card dual" data-tabs>
    <div class="dual-head">
      <h2 data-tab-title>Lieferanten</h2>
      <form method="get" action="/" class="dual-period">
        <input type="hidden" name="year" value="${dashYear}">
        <select name="sp" class="year-select small-select" data-autosubmit aria-label="Zeitraum Lieferanten">
          ${years.map((y) => html`<option value="${y}"${selected(y, period)}>${y}</option>`)}
          <option value="all"${selected('all', period)}>Alle Jahre</option>
        </select>
        <noscript><button class="btn small">OK</button></noscript>
      </form>
      <div class="tabs small-tabs" role="tablist">
        <button type="button" role="tab" data-tab="suppliers" aria-selected="true">Top-Lieferanten</button>
        <button type="button" role="tab" data-tab="liabilities" aria-selected="false">Größte Verbindlichkeiten</button>
      </div>
    </div>
    <div data-panel="suppliers" role="tabpanel"><h3 class="panel-title">Top-Lieferanten</h3>${pie}</div>
    <div data-panel="liabilities" role="tabpanel"><h3 class="panel-title">Größte Verbindlichkeiten</h3>${liabilities}</div>
  </section>`;
}

/** Kleinunternehmergrenze nach § 19 UStG – nur wenn die Regelung aktiv ist */
async function smallBusinessLimits(t: Tenant, year: number) {
  const withCash = (y: number) => yearRevenue(t, y);
  const prev = await withCash(year - 1);
  const cur = await withCash(year);
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
    <p class="muted small">Nach vereinnahmten Entgelten (§ 19 Abs. 2 UStG): bezahlte Rechnungen im Jahr der Zahlung und die Bareinnahmen ohne Rechnung im Kassenbuch (netto)${t.nonprofit ? ', ohne ideellen Bereich' : ''}. Maßgeblich ist dein gesamter Umsatz – Umsätze außerhalb von Schottr zählen mit.</p>
  </section>`;
}

/** Einnahmen (brutto) je Tätigkeitsbereich eines Jahres; Rechnungen ohne Zuordnung zählen zum Vorgabe-Bereich */
type SphereSum = { n: number; s: number; cashN: number; cash: number };

async function sphereRevenue(t: Tenant, year: number): Promise<Record<Sphere, SphereSum>> {
  const rows = await all<{ sp: string; n: number; s: number | string }>(
    `SELECT sp, SUM(s >= 0) n, SUM(s) s FROM (${paidDocsSql('gross_total')}) x WHERE substr(dt, 1, 4) = ? GROUP BY sp`,
    ...paidDocsParams(t), String(year),
  );
  const out = Object.fromEntries(SPHERES.map((x) => [x.value, { n: 0, s: 0, cashN: 0, cash: 0 }])) as Record<Sphere, SphereSum>;
  for (const r of rows) if (isSphere(String(r.sp))) out[r.sp as Sphere] = { n: Number(r.n), s: Number(r.s), cashN: 0, cash: 0 };
  for (const r of await cashRevenue(t, year)) {
    if (!isSphere(r.sp)) continue;
    out[r.sp].cash = r.gross;
    out[r.sp].cashN = r.n;
    out[r.sp].s += r.gross;
  }
  return out;
}

/**
 * Einnahmen ohne Rechnung aus dem Kassenbuch (z. B. Getränkeverkauf): freie Einnahme-Buchungen
 * und Kassenzählungen (deren Differenz – positiv wie negativ – ist der geschätzte Barumsatz).
 * Brutto und netto (abzüglich enthaltener USt.), je Bereich; nie negativ.
 */
async function cashRevenue(t: Tenant, year: number): Promise<{ sp: Sphere; n: number; gross: number; net: number }[]> {
  const rows = await all<{ sp: string; n: number; gross: number | string; net: number | string }>(
    `SELECT COALESCE(NULLIF(sphere, ''), ?) sp, COUNT(*) n,
       SUM(amount) gross, SUM(amount - IF(vat_rate > 0, ROUND(amount * vat_rate / (10000 + vat_rate)), 0)) net
     FROM cash_entries
     WHERE tenant_id = ? AND substr(entry_date, 1, 4) = ? AND ${CASH_INCOME}
     GROUP BY sp`,
    t.default_sphere || 'business', t.id, String(year),
  );
  return rows
    .filter((r) => isSphere(String(r.sp)) || !t.nonprofit)
    .map((r) => ({ sp: String(r.sp) as Sphere, n: Number(r.n), gross: Math.max(0, Number(r.gross)), net: Math.max(0, Number(r.net)) }));
}

/**
 * Wirtschaftliche Geschäftsbetriebe eines Jahres (brutto). Sportliche Veranstaltungen über der
 * Zweckbetriebsgrenze des § 67a AO sind selbst ein wirtschaftlicher Geschäftsbetrieb und zählen dann mit.
 */
function businessIncome(r: Record<Sphere, { s: number }>, year: number) {
  const sportOver = r.sport.s > nonprofitLimits(year).sport;
  return { s: r.business.s + (sportOver ? r.sport.s : 0), sportOver };
}

/** Grenzen für gemeinnützige Körperschaften (§ 64 Abs. 3, § 67a, § 55 Abs. 1 Nr. 5 AO) – nur wenn aktiviert */
async function nonprofitLimitsCard(t: Tenant, year: number) {
  const lim = nonprofitLimits(year);
  const cur = await sphereRevenue(t, year);
  const prev = await sphereRevenue(t, year - 1);
  const biz = businessIncome(cur, year);
  const prevBiz = businessIncome(prev, year - 1);
  const prevLim = nonprofitLimits(year - 1);
  const gifts = await donationTotals(t.id, year);
  const giftSum = gifts.money.s + gifts.membership.s + gifts.goods.s;
  const giftCount = gifts.money.n + gifts.membership.n + gifts.goods.n;
  const total = SPHERES.reduce((a, x) => a + cur[x.value].s, 0) + giftSum;
  const euro = (v: number) => formatMoney(v).replace(/,00(?=\s?€)/, '');
  const level = (v: number, max: number) => (v > max ? 'danger' : v >= max * 0.8 ? 'warn' : 'ok') as 'ok' | 'warn' | 'danger';

  const bizState = level(biz.s, lim.business);
  const bizStatus = bizState === 'danger'
    ? html`<strong>${euro(lim.business)} überschritten:</strong> Der Gewinn der wirtschaftlichen Geschäftsbetriebe ist ${year} körperschaft- und gewerbesteuerpflichtig –
        bei Vereinen und Stiftungen nach Abzug eines Freibetrags von je ${euro(NONPROFIT_ALLOWANCE)} (§ 24 KStG, § 11 GewStG). Am besten mit dem Steuerberater sprechen.`
    : html`${bizState === 'warn' ? html`<strong>Achtung:</strong> nur noch` : 'Noch'} <strong>${formatMoney(lim.business - biz.s)}</strong> bis ${euro(lim.business)} –
        bleiben die Einnahmen darunter, fällt auf den Gewinn der wirtschaftlichen Geschäftsbetriebe keine Körperschaft- und Gewerbesteuer an.`;

  const sportState = level(cur.sport.s, lim.sport);
  const sport = cur.sport.s > 0 || prev.sport.s > 0
    ? html`${meter(cur.sport.s, lim.sport, { label: `Sportliche Veranstaltungen ${year} (§ 67a AO)`, state: sportState })}
      <p class="small ku-status ku-${sportState}">${sportState === 'danger'
        ? html`<strong>${euro(lim.sport)} überschritten:</strong> Die sportlichen Veranstaltungen sind ${year} ein steuerpflichtiger wirtschaftlicher Geschäftsbetrieb
            und zählen oben mit – es sei denn, der Verein hat nach § 67a Abs. 2 AO auf die Zweckbetriebsgrenze verzichtet.`
        : html`Bis ${euro(lim.sport)} (einschl. USt.) gelten sportliche Veranstaltungen als Zweckbetrieb – noch ${formatMoney(lim.sport - cur.sport.s)}.`}</p>`
    : '';

  const fundsState = total > lim.funds ? 'over' : 'ok';
  return html`<section class="card ku npo">
    <h2>Gemeinnützigkeit ${year} <span class="muted small">Grenzen nach der Abgabenordnung</span></h2>
    ${meter(biz.s, lim.business, { label: html`Wirtschaftliche Geschäftsbetriebe ${year} (§ 64 Abs. 3 AO)${biz.sportOver ? ' inkl. Sport' : ''}`, state: bizState })}
    <p class="small ku-status ku-${bizState}">${bizStatus}</p>
    ${sport}
    ${meter(total, lim.funds, { label: `Einnahmen ${year} gesamt (§ 55 Abs. 1 Nr. 5 AO)`, state: fundsState === 'over' ? 'warn' : 'ok' })}
    <p class="small ku-status ku-${fundsState}">${fundsState === 'over'
      ? html`<strong>Über ${euro(lim.funds)}:</strong> Die Mittel müssen zeitnah – spätestens bis Ende des übernächsten Jahres – für die satzungsmäßigen Zwecke verwendet werden.`
      : html`Bis ${euro(lim.funds)} Einnahmen im Jahr entfällt die Pflicht zur zeitnahen Mittelverwendung.
          Enthalten sind Rechnungen, die unter „Spenden“ erfassten Zuwendungen und die Bareinnahmen aus dem Kassenbuch.`}</p>
    <ul class="plain npo-split small">${SPHERES.map((x) => html`<li>
      <a href="/overview/${year}?sphere=${x.value}&amp;basis=gross" title="${x.hint} – alle Einnahmen und Ausgaben des Bereichs">${x.label}</a>
      <span class="muted">${cur[x.value].n} bezahlte Rechnung(en)${cur[x.value].cash > 0 ? html` · bar ohne Rechnung ${formatMoney(cur[x.value].cash)}` : ''}</span>
      <strong class="num">${formatMoney(cur[x.value].s)}</strong></li>`)}
      <li><a href="/donations?year=${year}">Spenden und Mitgliedsbeiträge</a>
        <span class="muted">${giftCount} Zuwendung(en)</span>
        <strong class="num">${formatMoney(giftSum)}</strong></li></ul>
    <p class="small ${prevBiz.s > prevLim.business ? 'danger-text' : 'muted'}">Vorjahr ${year - 1}: ${formatMoney(prevBiz.s)} in wirtschaftlichen Geschäftsbetrieben
      ${prevBiz.s > prevLim.business ? ` – über der Grenze von ${euro(prevLim.business)}.` : ` – innerhalb der Grenze von ${euro(prevLim.business)}.`}</p>
    <p class="muted small">Brutto nach Zahlungseingang (Zuflussprinzip): bezahlte Rechnungen im Jahr der Zahlung (Stornos bezahlter Rechnungen als Erstattung abgezogen)
      und die Einnahmen ohne Rechnung aus dem Kassenbuch – freie Einnahme-Buchungen und Kassenzählungen, z. B. Getränkeverkauf –, jeweils nach ihrem Bereich. Keine Steuerberatung.</p>
  </section>`;
}


/* ---------- Aufstellung: alles, was in einer Säule bzw. einem Bereich steckt ---------- */

interface MonthLine { date: string; title: string; sub: string; href: string; amount: number; files?: number }

/**
 * Einnahmen und Ausgaben eines Monats (YYYY-MM) oder Jahres (YYYY) nach Zahlungsdatum – mit
 * denselben Regeln wie yearRevenue / yearCosts bzw. der Gemeinnützigkeits-Kachel, damit die Summen
 * genau passen. Ohne Bereich bleibt bei gemeinnützigen Mandanten der ideelle Bereich bei den
 * Einnahmen außen vor; mit Bereich gibt es nur dessen Einnahmen und Ausgaben.
 */
async function periodLines(t: Tenant, period: string, basis: Basis, sphere?: Sphere) {
  const col = docCol(basis);
  const def = t.default_sphere || 'business';
  const len = period.length;
  const spFilter = sphere ? 'AND sp = ?' : t.nonprofit ? "AND sp <> 'ideell'" : '';
  const spParams = sphere ? [sphere] : [];
  const prepaid = (alias: string) => `(SELECT COALESCE(SUM(p.${col}), 0) FROM document_prepayments x JOIN documents p ON p.id = x.prepaid_id WHERE x.document_id = ${alias}.id)`;

  const docs = await all<{ id: number; number: string; type_code: string; dt: string; sp: string; label: string | null; subject: string | null; s: number | string }>(
    `SELECT * FROM (
       SELECT d.id, d.number, d.type_code, d.paid_at dt, COALESCE(NULLIF(d.sphere, ''), ?) sp,
         COALESCE(NULLIF(c.company, ''), c.name) label, d.subject, d.${col} - ${prepaid('d')} s
       FROM documents d LEFT JOIN contacts c ON c.id = d.contact_id
       WHERE d.tenant_id = ? AND d.kind = 'invoice' AND d.finalized_at IS NOT NULL AND d.type_code <> '381'
         AND d.paid_at IS NOT NULL AND substr(d.paid_at, 1, ${len}) = ?
       UNION ALL
       SELECT d.id, d.number, d.type_code, d.issue_date dt, COALESCE(NULLIF(o.sphere, ''), ?) sp,
         COALESCE(NULLIF(c.company, ''), c.name) label, d.subject, -d.${col} s
       FROM documents d JOIN documents o ON o.id = d.corrects_id LEFT JOIN contacts c ON c.id = d.contact_id
       WHERE d.tenant_id = ? AND d.kind = 'invoice' AND d.finalized_at IS NOT NULL AND d.type_code = '381'
         AND o.paid_at IS NOT NULL AND substr(d.issue_date, 1, ${len}) = ?
     ) x WHERE 1 = 1 ${spFilter} ORDER BY dt, number`,
    def, t.id, period, def, t.id, period, ...spParams,
  );

  type EntryRow = { id: number; account_id: number; entry_date: string; source: string; text: string; receipt_ref: string; category: string | null; sp: string; vat_rate: number; account: string; s: number | string };
  const entries = async (cond: string, amount: string, filter: string, params: string[]) => all<EntryRow>(
    `SELECT * FROM (
       SELECT e.id, e.account_id, e.entry_date, e.source, e.text, e.receipt_ref, e.category, e.vat_rate,
         COALESCE(NULLIF(e.sphere, ''), ?) sp, a.name account, ${amount} s
       FROM cash_entries e JOIN cash_accounts a ON a.id = e.account_id
       WHERE e.tenant_id = ? AND substr(e.entry_date, 1, ${len}) = ? AND ${cond}
     ) x WHERE 1 = 1 ${filter} ORDER BY entry_date, id`,
    def, t.id, period, ...params,
  );
  const net = (a: string) => `${a}.amount - IF(${a}.vat_rate > 0, ROUND(${a}.amount * ${a}.vat_rate / (10000 + ${a}.vat_rate)), 0)`;
  const cashIn = await entries("(e.source = 'count' OR (e.source = 'manual' AND e.amount > 0))", basis === 'gross' ? 'e.amount' : net('e'), spFilter, spParams);
  // Ausgaben: ohne Bereich alle (wie im Ergebnis), mit Bereich nur dessen
  const costFilter = sphere ? 'AND sp = ?' : '';
  const cashOut = await entries("e.source = 'manual' AND e.amount < 0", t.small_business || basis === 'gross' ? '-e.amount' : `-(${net('e')})`, costFilter, spParams);

  const costCol = t.small_business || basis === 'gross' ? 'gross_total' : 'net_total';
  const purchases = await all<{ id: number; number: string; dt: string; sp: string; label: string | null; description: string | null; category: string | null; is_credit: number; s: number | string }>(
    `SELECT * FROM (
       SELECT p.id, p.number, p.paid_at dt, COALESCE(NULLIF(p.sphere, ''), ?) sp, COALESCE(NULLIF(c.company, ''), c.name) label,
         p.description, p.category, p.is_credit, CASE WHEN p.is_credit = 1 THEN -p.${costCol} ELSE p.${costCol} END s
       FROM purchase_invoices p LEFT JOIN contacts c ON c.id = p.contact_id
       WHERE p.tenant_id = ? AND p.status = 'paid' AND p.paid_at IS NOT NULL AND substr(p.paid_at, 1, ${len}) = ?
     ) x WHERE 1 = 1 ${costFilter} ORDER BY dt, id`,
    def, t.id, period, ...spParams,
  );

  const files = await fileCounts([...cashIn, ...cashOut].map((e) => e.id));
  const showSphere = t.nonprofit && !sphere;
  const sphereTxt = (sp: string) => (showSphere ? ` · ${sphereLabel(sp)}` : '');
  const entryLine = (e: EntryRow): MonthLine => ({
    date: e.entry_date,
    title: e.text || SOURCE_LABELS[e.source as keyof typeof SOURCE_LABELS] || 'Buchung',
    sub: [e.source === 'count' ? 'Kassenzählung' : 'ohne Rechnung', e.account, e.category ? categoryLabel(e.category) : '', e.receipt_ref ? `Beleg ${e.receipt_ref}` : '', e.vat_rate ? `inkl. ${e.vat_rate / 100} % USt.` : '']
      .filter(Boolean).join(' · ') + sphereTxt(e.sp),
    href: e.source === 'count' ? `/cashbook/counts?account=${e.account_id}` : `/cashbook/entries/${e.id}/edit`,
    amount: Number(e.s),
    files: files.get(e.id),
  });

  const income: MonthLine[] = [
    ...docs.map((d) => ({
      date: d.dt,
      title: `${d.type_code === '381' ? 'Storno' : 'Rechnung'} ${d.number} · ${d.label ?? ''}`,
      sub: (d.type_code === '381' ? 'Erstattung einer bezahlten Rechnung' : d.subject || 'bezahlte Rechnung') + sphereTxt(d.sp),
      href: `/invoices/${d.id}`,
      amount: Number(d.s),
    })),
    ...cashIn.map(entryLine),
  ].sort((a, b) => a.date.localeCompare(b.date));
  const costs: MonthLine[] = [
    ...purchases.map((p) => ({
      date: p.dt,
      title: `${p.is_credit ? 'Gutschrift' : 'Eingangsrechnung'}${p.number ? ` ${p.number}` : ''} · ${p.label ?? 'ohne Lieferant'}`,
      sub: ([p.description, p.category ? categoryLabel(p.category) : ''].filter(Boolean).join(' · ') || 'bezahlte Eingangsrechnung') + sphereTxt(p.sp),
      href: `/purchases/${p.id}`,
      amount: Number(p.s),
    })),
    ...cashOut.map(entryLine),
  ].sort((a, b) => a.date.localeCompare(b.date));
  return { income, costs };
}

function monthTable(lines: MonthLine[], emptyText: string, sumLabel: string): SafeHtml {
  if (!lines.length) return html`<p class="muted">${emptyText}</p>`;
  const sum = lines.reduce((a, l) => a + l.amount, 0);
  return html`<div class="card flush"><table class="table month-table stack-mobile">
    <thead><tr><th>Datum</th><th>Vorgang</th><th class="right">Betrag</th></tr></thead>
    <tbody>${lines.map((l) => html`<tr class="rowlink">
      <td data-label="Datum" class="nowrap">${formatDate(l.date)}</td>
      <td data-label="Vorgang"><a href="${l.href}">${l.title}</a>
        <div class="muted small">${l.sub}${l.files ? html` · <span class="has-file">${l.files} ${l.files === 1 ? 'Beleg' : 'Belege'}</span>` : ''}</div></td>
      <td data-label="Betrag" class="right num ${l.amount < 0 ? 'kpi-alert' : ''}">${formatMoney(l.amount)}</td>
    </tr>`)}</tbody>
    <tfoot><tr><td colspan="2"><strong>${sumLabel}</strong></td><td class="right num"><strong>${formatMoney(sum)}</strong></td></tr></tfoot>
  </table></div>`;
}

export const dashboardModule: Module = {
  name: 'dashboard',
  nav: { label: 'Übersicht', href: '/', order: 0, group: 'start', icon: 'dashboard' },
  register(app) {
    app.get('/overview/:period', async (c) => {
      const t = tenantOf(c);
      const period = c.req.param('period');
      if (!/^\d{4}(-(0[1-9]|1[0-2]))?$/.test(period)) notFound();
      const spQ = c.req.query('sphere') ?? '';
      const sphere = t.nonprofit && isSphere(spQ) ? spQ : undefined;
      // ?basis= gilt hier nur für diese Ansicht (die Gemeinnützigkeits-Kachel verlinkt brutto)
      const bq = c.req.query('basis');
      const basis: Basis = bq === 'net' || bq === 'gross' ? bq : dashBasis(c, t);
      const { income, costs } = await periodLines(t, period, basis, sphere);
      const isMonth = period.length === 7;
      const [y, m] = period.split('-').map(Number);
      const shift = (d: number) => {
        if (!isMonth) return String(y + d);
        const i = y * 12 + (m - 1) + d;
        return `${Math.floor(i / 12)}-${String((i % 12) + 1).padStart(2, '0')}`;
      };
      // Umschalter in dieser Ansicht: Basis explizit in der Adresse, ohne die Vorgabe der Übersicht zu ändern
      const q = (b: Basis) => `?${new URLSearchParams({ ...(sphere ? { sphere } : {}), basis: b })}`;
      const keep = (extra: Record<string, string> = {}) => {
        const p = new URLSearchParams({ ...extra, ...(bq === 'net' || bq === 'gross' ? { basis: bq } : {}) });
        const str = p.toString();
        return str ? `?${str}` : '';
      };
      const navQ = keep(sphere ? { sphere } : {});
      const sumIn = income.reduce((a, l) => a + l.amount, 0);
      const sumOut = costs.reduce((a, l) => a + l.amount, 0);
      const toggle = html`<span class="seg-toggle" role="group" aria-label="Beträge netto oder brutto">
        ${(['net', 'gross'] as const).map((b) => html`<a href="/overview/${period}${q(b)}" class="${b === basis ? 'active' : ''}">${basisWord(b)}</a>`)}
      </span>`;
      const label = isMonth ? `${MONTHS[m - 1]} ${y}` : String(y);
      const prevLabel = isMonth ? MONTHS_SHORT[(m + 10) % 12] : String(y - 1);
      const nextLabel = isMonth ? MONTHS_SHORT[m % 12] : String(y + 1);
      const scope = sphere
        ? `nur ${sphereLabel(sphere)}`
        : t.nonprofit ? 'Einnahmen ohne ideellen Bereich' : '';
      return page(c, {
        title: sphere ? `${sphereLabel(sphere)} · ${label}` : label,
        back: { href: `/?year=${y}`, label: 'Übersicht' },
        actions: html`<a class="btn" href="/overview/${shift(-1)}${navQ}" aria-label="${isMonth ? 'Vormonat' : 'Vorjahr'}">← ${prevLabel}</a>
          <a class="btn" href="/overview/${shift(1)}${navQ}" aria-label="${isMonth ? 'Folgemonat' : 'Folgejahr'}">${nextLabel} →</a>`,
        body: html`
        <div class="month-summary card">
          <div><span class="muted small">Einnahmen</span><strong class="num">${formatMoney(sumIn)}</strong></div>
          <div><span class="muted small">Ausgaben</span><strong class="num">${formatMoney(sumOut)}</strong></div>
          <div><span class="muted small">Ergebnis</span><strong class="num ${sumIn - sumOut < 0 ? 'kpi-alert' : ''}">${formatMoney(sumIn - sumOut)}</strong></div>
          <div class="month-basis">${toggle}<span class="muted small">nach Zahlungsdatum${scope ? ` · ${scope}` : ''}</span></div>
        </div>
        ${t.nonprofit
          ? html`<nav class="tabs sphere-tabs" aria-label="Bereich">
              <a href="/overview/${period}${keep()}" class="${sphere ? '' : 'active'}">Alle Bereiche</a>
              ${SPHERES.map((x) => html`<a href="/overview/${period}${keep({ sphere: x.value })}" class="${sphere === x.value ? 'active' : ''}" title="${x.hint}">${x.short}</a>`)}
            </nav>`
          : ''}
        <h2 class="section-title" id="einnahmen">Einnahmen <span class="count">${income.length}</span></h2>
        ${monthTable(income, `${isMonth ? 'In diesem Monat' : `${y}`} gibt es keine Einnahmen${sphere ? ' in diesem Bereich' : ''}.`, 'Summe Einnahmen')}
        <h2 class="section-title" id="ausgaben">Ausgaben <span class="count">${costs.length}</span></h2>
        ${monthTable(costs, `${isMonth ? 'In diesem Monat' : `${y}`} gibt es keine Ausgaben${sphere ? ' in diesem Bereich' : ''}.`, 'Summe Ausgaben')}`,
      });
    });

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
      const basis = dashBasis(c, t);
      const revenue = await yearRevenue(t, selYear, basis);
      const chart = await monthlyChart(t.id, d, basis);
      const result = await resultChart(t, selYear, d, basis);
      const customers = await topCustomers(t.id, d, basis);
      const spParam = c.req.query('sp') ?? '';
      const suppliers = await supplierCard(t, spParam === 'all' || years.includes(spParam) ? spParam : selYear, years, selYear, basis);
      const liab = await openLiabilities(t.id);
      const ku = t.small_business ? await smallBusinessLimits(t, Number(year)) : null;
      const npo = t.nonprofit ? await nonprofitLimitsCard(t, Number(year)) : null;
      const cash = await cashbookDash(t);
      const pending = cashbookEnabled(t) ? pendingCard(c, await pendingDues(t), '/') : '';
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
      const inboxN = await inboxCount(t.id);
      const costs = [...(await yearCosts(t, selYear, basis)).values()].reduce((a, x) => a + x, 0);
      const toCapture = Number((await one<{ n: number }>("SELECT COUNT(*) n FROM purchase_invoices WHERE tenant_id = ? AND status = 'draft'", t.id))?.n ?? 0);
      const basisHref = (b: Basis) => {
        const q = new URLSearchParams({ year: selYear, basis: b });
        if (spParam) q.set('sp', spParam);
        return `/?${q}`;
      };
      const basisToggle = html`<span class="seg-toggle" role="group" aria-label="Beträge netto oder brutto">
        ${(['net', 'gross'] as const).map((b) => html`<a href="${basisHref(b)}" class="${b === basis ? 'active' : ''}"${b === basis ? raw(' aria-current="true"') : ''}>${basisWord(b)}</a>`)}
      </span>`;
      const n = (k: number, one_: string, many: string) => `${k} ${k === 1 ? one_ : many}`;
      const row = (href: string, label: string, amount: number, sub: string, alert = '') => html`<a class="kpi-row" href="${href}">
        <span class="kpi-label">${label}</span><strong class="num">${formatMoney(amount)}</strong>
        <small>${sub}${alert ? html` · <span class="kpi-alert">${alert}</span>` : ''}</small></a>`;
      const kpis = html`<div class="kpis">
        <section class="kpi wide">
          <h2>Offene Posten</h2>
          ${row(overdue.n ? '/dunning' : '/invoices?status=open', 'Forderungen', open.s, n(open.n, 'Rechnung', 'Rechnungen'), overdue.n ? `${formatMoney(overdue.s)} überfällig` : '')}
          ${row(`/purchases?status=${liab.overdueN ? 'overdue' : 'open'}`, 'Verbindlichkeiten', liab.s, n(liab.n, 'Eingangsrechnung', 'Eingangsrechnungen'), liab.overdueN ? `${formatMoney(liab.overdueS)} überfällig` : '')}
          ${row('/quotes?status=sent', 'Angebote', quotes.s, `${quotes.n} offen`)}
        </section>
        <section class="kpi wide">
          <form method="get" action="/" class="stat-year kpi-head">
            <label for="revenue-year">Umsatz</label>
            <select id="revenue-year" name="year" data-autosubmit>${years.map((y) => html`<option value="${y}"${selected(y, selYear)}>${y}</option>`)}</select>
            ${basisToggle}<span>nach Zahlung</span>
            <noscript><button class="btn">OK</button></noscript>
          </form>
          <a class="kpi-big" href="/overview/${selYear}" title="Alle Einnahmen und Ausgaben ${selYear}"><strong class="num">${formatMoney(revenue.s)}</strong>
            <small>${n(revenue.n, 'bezahlte Rechnung', 'bezahlte Rechnungen')}${revenue.cashN ? ` · bar ohne Rechnung ${formatMoney(revenue.cash)}` : ''}${t.nonprofit ? ' · ohne ideellen Bereich' : ''}</small></a>
          <ul class="plain kpi-list">
            <li><a href="/purchases?paid=${selYear}" title="Bezahlte Eingangsrechnungen und Ausgaben ohne Beleg aus dem Kassenbuch, nach Zahlungsdatum">Ausgaben</a><span class="num">${formatMoney(costs)}</span></li>
            <li><span>Ergebnis</span><strong class="num ${revenue.s - costs < 0 ? 'kpi-alert' : ''}">${formatMoney(revenue.s - costs)}</strong></li>
          </ul>
        </section>
        ${cash ? html`<section class="kpi">
          <h2><a href="/cashbook">Konten</a></h2>
          <a class="kpi-big" href="/cashbook"><strong class="num ${cash.total < 0 ? 'kpi-alert' : ''}">${formatMoney(cash.total)}</strong><small>${cash.list.length > 1 ? 'gesamt' : cash.list[0].name}</small></a>
          ${cash.list.length > 1 ? html`<ul class="plain kpi-list">${cash.list.map((a) => html`<li><a href="/cashbook?account=${a.id}">${a.name}</a><span class="num ${a.balance < 0 ? 'kpi-alert' : ''}">${formatMoney(a.balance)}</span></li>`)}</ul>` : ''}
        </section>` : ''}
        <section class="kpi ${inboxN ? 'attention' : ''} ${cash ? '' : 'wide'}">
          <h2><a href="/inbox">Belege</a></h2>
          <a class="kpi-big" href="/inbox"><strong>${inboxN}</strong><small>nicht zugeordnet</small></a>
          ${toCapture ? html`<a class="small" href="/purchases?status=draft">${n(toCapture, 'Eingangsrechnung', 'Eingangsrechnungen')} zu erfassen</a>` : ''}
          <a class="btn small hide-mobile kpi-action" href="/capture">Beleg erfassen</a>
        </section>
      </div>`;
      const charts = html`<section class="card dual chart-tabs" data-tabs>
        <div class="dual-head">
          <h2 data-tab-title>Verlauf</h2>
          <div class="tabs small-tabs" role="tablist">
            <button type="button" role="tab" data-tab="result" aria-selected="true">Ergebnis ${selYear}</button>
            <button type="button" role="tab" data-tab="invoices" aria-selected="false" title="Festgeschriebene Rechnungen der letzten 24 Monate">Rechnungen</button>
            ${cash ? html`<button type="button" role="tab" data-tab="balance" aria-selected="false">Kontostände</button>` : ''}
          </div>
        </div>
        <div data-panel="result" role="tabpanel">${result}</div>
        <div data-panel="invoices" role="tabpanel">${chart}</div>
        ${cash ? html`<div data-panel="balance" role="tabpanel">${cash.chart}</div>` : ''}
      </section>`;
      return page(c, {
        title: 'Übersicht',
        actions: html`<a class="btn" href="/quotes/new">Neues Angebot</a><a class="btn primary" href="/invoices/new">Neue Rechnung</a>`,
        body: html`
        <section class="capture-cta" aria-label="Beleg erfassen">
          <a class="btn primary big" href="/capture">📷 Beleg erfassen</a>
        </section>
        ${invitationsBox(c, invites)}
        ${problems.length
          ? html`<div class="notice">Deine Firmendaten sind noch unvollständig – es fehlen: ${problems.join(", ")}. <a href="/settings">Jetzt ergänzen</a></div>`
          : ''}
        ${kpis}
        ${pending}
        ${charts}
        <div class="dash-grid">${customers}${suppliers}</div>
        ${ku || npo ? html`<div class="dash-grid ${ku && npo ? '' : 'single'}">${npo ?? ''}${ku ?? ''}</div>` : ''}
        <h2 class="section-title">Offene Rechnungen</h2>
        ${openList.length ? documentTable(openList, 'invoice') : html`<p class="muted">Keine offenen Rechnungen. 🎉</p>`}
        ${drafts.length ? html`<h2 class="section-title">Rechnungsentwürfe</h2>${documentTable(drafts, 'invoice')}` : ''}`,
      });
    });
  },
};
