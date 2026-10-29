import { all, one } from '../db/index.ts';
import { html, selected } from '../lib/html.ts';
import { barChart, compareChart, meter, pieChart, type ChartPoint, type ComparePoint, type PieSlice } from '../views/chart.ts';
import { formatDate, MONTH_NAMES, today } from '../lib/dates.ts';
import { formatMoney } from '../lib/money.ts';
import { tenantOf } from '../lib/http.ts';
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
import type { Module, Tenant } from '../types.ts';

/**
 * Netto-Umsatz festgeschriebener Rechnungen. Stornos zählen negativ; bei Teilschluss- und
 * Schlussrechnungen werden die bereits als Teilrechnung erfassten Beträge abgezogen (sonst doppelt).
 */
const revenueSql = (col: 'net_total' | 'gross_total') => `COALESCE(SUM(CASE WHEN documents.type_code = '381' THEN -documents.${col} ELSE documents.${col} -
  (SELECT COALESCE(SUM(p.${col}), 0) FROM document_prepayments x JOIN documents p ON p.id = x.prepaid_id WHERE x.document_id = documents.id)
END), 0)`;
const REVENUE = revenueSql('net_total');
/** Wie REVENUE, aber brutto – die Grenzen der Abgabenordnung beziehen sich auf Einnahmen einschließlich Umsatzsteuer */
const GROSS_REVENUE = revenueSql('gross_total');

const MONTHS = MONTH_NAMES;

/**
 * Ausgaben aus erfassten Eingangsrechnungen (Gutschriften negativ). Mit Vorsteuerabzug zählt
 * der Nettobetrag, als Kleinunternehmer der Bruttobetrag – die Vorsteuer bekommt man dann nicht erstattet.
 */
const COST = (t: Pick<Tenant, 'small_business'>) => {
  const col = t.small_business ? 'gross_total' : 'net_total';
  return `COALESCE(SUM(CASE WHEN p.is_credit = 1 THEN -p.${col} ELSE p.${col} END), 0)`;
};

/** Grenzen der Kleinunternehmerregelung (§ 19 Abs. 1 UStG, gültig ab 2025), in Cent */
const KU_PREV_YEAR_LIMIT = 25_000_00;
const KU_CURRENT_YEAR_LIMIT = 100_000_00;

/**
 * Netto-Umsatz eines Jahres aus festgeschriebenen Rechnungen. Bei gemeinnützigen Mandanten
 * (Vorgabe-Bereich übergeben) bleibt der ideelle Bereich außen vor – er ist nicht unternehmerisch.
 */
async function yearRevenue(tenantId: number, year: string | number, nonprofitDefault: string | null = null): Promise<{ n: number; s: number }> {
  const r = await one<{ n: number; s: number | string }>(
    `SELECT COUNT(*) n, ${REVENUE} s FROM documents
     WHERE tenant_id = ? AND kind = 'invoice' AND finalized_at IS NOT NULL AND substr(issue_date, 1, 4) = ?
       ${nonprofitDefault !== null ? "AND COALESCE(NULLIF(sphere, ''), ?) <> 'ideell'" : ''}`,
    tenantId, String(year), ...(nonprofitDefault !== null ? [nonprofitDefault] : []),
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

/** Jahre mit festgeschriebenen Rechnungen oder Eingangsrechnungen plus das laufende Jahr, neueste zuerst */
async function revenueYears(tenantId: number, current: string): Promise<string[]> {
  const rows = await all<{ y: string }>(
    `SELECT DISTINCT substr(issue_date, 1, 4) y FROM documents WHERE tenant_id = ? AND kind = 'invoice' AND finalized_at IS NOT NULL
     UNION SELECT DISTINCT substr(issue_date, 1, 4) y FROM purchase_invoices WHERE tenant_id = ? AND status <> 'draft' AND issue_date IS NOT NULL`,
    tenantId, tenantId,
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

/** Umsatz und Ausgaben je Monat eines Jahres mit Ergebnis */
async function resultChart(t: Tenant, year: string, todayIso: string) {
  const rev = await all<{ m: string; s: number | string }>(
    `SELECT substr(issue_date, 6, 2) m, ${REVENUE} s FROM documents
     WHERE tenant_id = ? AND kind = 'invoice' AND finalized_at IS NOT NULL AND substr(issue_date, 1, 4) = ? GROUP BY m`,
    t.id, year,
  );
  const cost = await all<{ m: string; s: number | string }>(
    `SELECT substr(p.issue_date, 6, 2) m, ${COST(t)} s FROM purchase_invoices p
     WHERE p.tenant_id = ? AND p.status <> 'draft' AND substr(p.issue_date, 1, 4) = ? GROUP BY m`,
    t.id, year,
  );
  const r = new Map(rev.map((x) => [String(x.m), Number(x.s)]));
  const k = new Map(cost.map((x) => [String(x.m), Number(x.s)]));
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
      revenueHref: `/invoices?month=${ym}`,
      costHref: `/purchases?month=${ym}`,
    };
  });
  const costLabel = 'Ausgaben';
  return compareChart(points, {
    caption: `Umsatz und Ausgaben ${year}`,
    sub: `${t.small_business ? 'Umsatz netto, Ausgaben brutto (kein Vorsteuerabzug)' : 'netto'} nach Rechnungsdatum · Ergebnis vor Steuern und sonstigen Abzügen`,
    emptyText: `${year} gibt es noch keine Rechnungen oder Eingangsrechnungen.`,
    hint: 'Klick auf eine Säule zeigt die Rechnungen bzw. Eingangsrechnungen des Monats.',
    costLabel,
  });
}

/**
 * Kachel mit Umschalter: Top-Lieferanten nach Kosten bzw. größte Verbindlichkeiten (alle
 * Eingangsrechnungen, offene wie bezahlte) – jeweils für ein wählbares Jahr oder den ganzen Bestand.
 */
async function supplierCard(t: Tenant, period: string, years: string[], dashYear: string) {
  const all_ = period === 'all';
  const where = all_ ? '' : 'AND substr(p.issue_date, 1, 4) = ?';
  const params = all_ ? [] : [period];
  const rows = await all<{ id: number; label: string; s: number | string }>(
    `SELECT c.id, COALESCE(NULLIF(c.company, ''), c.name) label, ${COST(t)} s
     FROM purchase_invoices p JOIN contacts c ON c.id = p.contact_id
     WHERE p.tenant_id = ? AND p.status <> 'draft' ${where}
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
    sub: `${t.small_business ? 'Kosten brutto' : 'Kosten netto'} ${all_ ? 'aller Jahre' : `im Jahr ${period}`}`,
    emptyText: all_ ? 'Es wurden noch keine Eingangsrechnungen erfasst.' : `${period} wurden keine Eingangsrechnungen erfasst.`,
    centerLabel: label,
    bare: true,
  });

  const biggest = await all<Purchase & { contact_label: string | null }>(
    `SELECT p.*, COALESCE(NULLIF(c.company, ''), c.name) AS contact_label FROM purchase_invoices p LEFT JOIN contacts c ON c.id = p.contact_id
     WHERE p.tenant_id = ? AND p.status <> 'draft' AND p.is_credit = 0 ${where}
     ORDER BY p.gross_total DESC, p.issue_date DESC LIMIT 6`,
    t.id, ...params,
  );
  const liabilities = biggest.length
    ? html`<ul class="plain liability-list">${biggest.map((p) => {
        const st = purchaseStatus(p);
        return html`<li>
          <a href="/purchases/${p.id}" class="liability-name">${p.contact_label ?? 'ohne Lieferant'}<span class="muted small"> · ${p.number || 'ohne Nr.'} · ${formatDate(p.issue_date)}</span>${p.description ? html`<span class="muted small liability-desc">${p.description}</span>` : ''}</a>
          <span class="liability-due small">${st === 'open' ? html`<span class="muted">fällig ${formatDate(dueOf(p))}</span>` : purchaseBadge(st)}</span>
          <strong class="num">${formatMoney(p.gross_total)}</strong>
        </li>`;
      })}</ul>
      <p class="small"><a href="/purchases">Alle Eingangsrechnungen</a></p>`
    : html`<p class="muted small pie-empty">${all_ ? 'Keine Eingangsrechnungen.' : `Keine Eingangsrechnungen in ${period}.`}</p>`;

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
  const npo = t.nonprofit ? t.default_sphere : null;
  const withCash = async (y: number) => {
    const r = await yearRevenue(t.id, y, npo);
    const cash = (await cashRevenue(t, y)).filter((x) => !t.nonprofit || x.sp !== 'ideell').reduce((a, x) => a + x.net, 0);
    return { n: r.n, s: r.s + cash };
  };
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
    <p class="muted small">Berechnet aus den festgeschriebenen Rechnungen und den Bareinnahmen ohne Rechnung im Kassenbuch (netto)${t.nonprofit ? ', ohne ideellen Bereich' : ''}. Maßgeblich ist dein gesamter Umsatz – Umsätze außerhalb von Schottr zählen mit.</p>
  </section>`;
}

/** Einnahmen (brutto) je Tätigkeitsbereich eines Jahres; Rechnungen ohne Zuordnung zählen zum Vorgabe-Bereich */
type SphereSum = { n: number; s: number; cashN: number; cash: number };

async function sphereRevenue(t: Tenant, year: number): Promise<Record<Sphere, SphereSum>> {
  const rows = await all<{ sp: string; n: number; s: number | string }>(
    `SELECT COALESCE(NULLIF(sphere, ''), ?) sp, COUNT(*) n, ${GROSS_REVENUE} s FROM documents
     WHERE tenant_id = ? AND kind = 'invoice' AND finalized_at IS NOT NULL AND substr(issue_date, 1, 4) = ?
     GROUP BY sp`,
    t.default_sphere || 'business', t.id, String(year),
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
     WHERE tenant_id = ? AND substr(entry_date, 1, 4) = ? AND (source = 'count' OR (source = 'manual' AND amount > 0))
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
      <a href="/invoices?year=${year}&amp;sphere=${x.value}" title="${x.hint}">${x.label}</a>
      <span class="muted">${cur[x.value].n} Rechnung(en)${cur[x.value].cash > 0 ? html` · bar ohne Rechnung ${formatMoney(cur[x.value].cash)}` : ''}</span>
      <strong class="num">${formatMoney(cur[x.value].s)}</strong></li>`)}
      <li><a href="/donations?year=${year}">Spenden und Mitgliedsbeiträge</a>
        <span class="muted">${giftCount} Zuwendung(en)</span>
        <strong class="num">${formatMoney(giftSum)}</strong></li></ul>
    <p class="small ${prevBiz.s > prevLim.business ? 'danger-text' : 'muted'}">Vorjahr ${year - 1}: ${formatMoney(prevBiz.s)} in wirtschaftlichen Geschäftsbetrieben
      ${prevBiz.s > prevLim.business ? ` – über der Grenze von ${euro(prevLim.business)}.` : ` – innerhalb der Grenze von ${euro(prevLim.business)}.`}</p>
    <p class="muted small">Brutto aus den festgeschriebenen Rechnungen (Stornos abgezogen) und den Einnahmen ohne Rechnung aus dem Kassenbuch –
      freie Einnahme-Buchungen und Kassenzählungen, z. B. Getränkeverkauf –, jeweils nach ihrem Bereich. Keine Steuerberatung.</p>
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
      const result = await resultChart(t, selYear, d);
      const customers = await topCustomers(t.id, d);
      const spParam = c.req.query('sp') ?? '';
      const suppliers = await supplierCard(t, spParam === 'all' || years.includes(spParam) ? spParam : selYear, years, selYear);
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
      const costs = Number((await one<{ s: number | string }>(
        `SELECT ${COST(t)} s FROM purchase_invoices p WHERE p.tenant_id = ? AND p.status <> 'draft' AND substr(p.issue_date, 1, 4) = ?`, t.id, selYear,
      ))?.s ?? 0);
      const toCapture = Number((await one<{ n: number }>("SELECT COUNT(*) n FROM purchase_invoices WHERE tenant_id = ? AND status = 'draft'", t.id))?.n ?? 0);
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
            <span>netto</span>
            <noscript><button class="btn">OK</button></noscript>
          </form>
          <a class="kpi-big" href="/invoices?year=${selYear}"><strong class="num">${formatMoney(revenue.s)}</strong><small>${n(revenue.n, 'Rechnung', 'Rechnungen')}</small></a>
          <ul class="plain kpi-list">
            <li><a href="/purchases" title="Eingangsrechnungen netto nach Rechnungsdatum">Ausgaben</a><span class="num">${formatMoney(costs)}</span></li>
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
