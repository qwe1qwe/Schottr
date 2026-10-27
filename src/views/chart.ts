import { html, type SafeHtml } from '../lib/html.ts';
import { formatMoney } from '../lib/money.ts';

/**
 * Schlichtes Säulendiagramm ohne Bibliothek und ohne Inline-Styles (CSP).
 * Die Säulen liegen in einem SVG mit festem Koordinatensystem, das per
 * preserveAspectRatio="none" auf die volle Breite gezogen wird; Achsenbeschriftungen
 * sind normales HTML, damit die Schrift auch am Handy lesbar bleibt.
 */

export interface ChartPoint {
  /** Kurzbeschriftung der x-Achse, z. B. "Okt" */
  label: string;
  /** Beschriftung im Detail, z. B. "Oktober 2026" */
  title: string;
  /** Wert in Cent */
  value: number;
  count: number;
  /** z. B. laufender Monat */
  current?: boolean;
  /** Jahreswechsel – Beschriftung mit Jahr */
  yearStart?: string;
  /** Ziel beim Anklicken der Säule */
  href?: string;
}

const H = 100; // Höhe des Koordinatensystems
const SLOT = 10; // Breite je Säule inkl. Abstand

function niceStep(range: number, ticks: number): number {
  const raw = range / ticks;
  const pow = 10 ** Math.floor(Math.log10(raw));
  for (const f of [1, 2, 2.5, 5, 10]) if (f * pow >= raw) return f * pow;
  return 10 * pow;
}

/** Cent → "12,5 T€" / "1,2 Mio. €" für die Achse */
function axisLabel(cents: number): string {
  const eur = cents / 100;
  const fmt = (n: number) => n.toLocaleString('de-DE', { maximumFractionDigits: 1 });
  if (Math.abs(eur) >= 1_000_000) return `${fmt(eur / 1_000_000)} Mio. €`;
  if (Math.abs(eur) >= 1_000) return `${fmt(eur / 1_000)} T€`;
  return `${fmt(eur)} €`;
}

const plural = (n: number) => `${n} ${n === 1 ? 'Rechnung' : 'Rechnungen'}`;

export function barChart(points: ChartPoint[], opts: { caption: string; emptyText: string; hint?: string }): SafeHtml {
  const values = points.map((p) => p.value);
  const max = Math.max(0, ...values);
  const min = Math.min(0, ...values);
  const step = niceStep(max - min || 100_000, 4);
  const lo = Math.floor(min / step) * step;
  const hi = Math.max(Math.ceil(max / step) * step, lo + step);
  const y = (v: number) => H - ((v - lo) / (hi - lo)) * H;
  const ticks: number[] = [];
  for (let v = hi; v >= lo - step / 2; v -= step) ticks.push(Math.round(v));

  const total = values.reduce((a, b) => a + b, 0);
  const count = points.reduce((a, p) => a + p.count, 0);
  const summary = `Gesamt: ${formatMoney(total)} netto · ${plural(count)}`;
  const width = points.length * SLOT;

  return html`<figure class="chart card" data-chart>
    <figcaption class="chart-head">
      <h2>${opts.caption}</h2>
      <p class="chart-readout" data-chart-readout aria-live="polite">${summary}</p>
    </figcaption>
    <div class="chart-body">
      <div class="chart-y" aria-hidden="true">${ticks.map((t) => html`<span>${axisLabel(t)}</span>`)}</div>
      <div class="chart-plot">
        <div class="chart-grid" aria-hidden="true">${ticks.map((t) => html`<span class="${t === 0 ? 'zero' : ''}"></span>`)}</div>
        <svg class="chart-svg" viewBox="0 0 ${width} ${H}" preserveAspectRatio="none" role="list" aria-label="${opts.caption}">
          ${points.map((p, i) => {
            const top = Math.min(y(p.value), y(0));
            const h = Math.max(Math.abs(y(p.value) - y(0)), p.value ? 0.6 : 0);
            const text = `${p.title}: ${formatMoney(p.value)} netto · ${plural(p.count)}`;
            const cls = `chart-bar${p.current ? ' current' : ''}${p.value < 0 ? ' neg' : ''}`;
            const shapes = html`<rect class="hit" x="${i * SLOT}" y="0" width="${SLOT}" height="${H}"></rect>
              <rect class="bar" x="${i * SLOT + 1.5}" y="${top.toFixed(2)}" width="${SLOT - 3}" height="${h.toFixed(2)}"></rect>`;
            return p.href
              ? html`<a href="${p.href}" class="${cls}" data-bar="${text}" role="listitem" aria-label="${text}">${shapes}</a>`
              : html`<g class="${cls}" data-bar="${text}" tabindex="0" role="listitem" aria-label="${text}">${shapes}</g>`;
          })}
        </svg>
        ${total === 0 && count === 0 ? html`<p class="chart-empty muted small">${opts.emptyText}</p>` : ''}
      </div>
      <span></span>
      <div class="chart-x" aria-hidden="true">${points.map((p) => html`<span class="${p.yearStart ? 'year' : ''}${p.current ? ' current' : ''}">${p.yearStart ? html`${p.label}<b>${p.yearStart}</b>` : p.label}</span>`)}</div>
    </div>
    ${opts.hint ? html`<p class="chart-hint muted small">${opts.hint}</p>` : ''}
  </figure>`;
}

/* ---------------- Ringdiagramm ---------------- */

export interface PieSlice {
  label: string;
  value: number;
  href?: string;
  /** "Sonstige" o. Ä. – neutral eingefärbt */
  rest?: boolean;
}

const pct = (v: number) => `${v.toLocaleString('de-DE', { maximumFractionDigits: 1 })} %`;

/**
 * Ringdiagramm aus Kreisen mit stroke-dasharray (pathLength = 100), daneben eine Legende
 * mit Betrag und Anteil. Überfahren/Fokus eines Segments hebt die Legendenzeile hervor.
 */
export function pieChart(slices: PieSlice[], opts: { caption: string; sub?: string; emptyText: string; centerLabel: string; bare?: boolean }): SafeHtml {
  const data = slices.filter((s) => s.value > 0);
  const total = data.reduce((a, s) => a + s.value, 0);
  let offset = 0;
  const segs = data.map((s, i) => {
    const share = (s.value / total) * 100;
    const seg = { ...s, i, share, offset };
    offset += share;
    return seg;
  });
  const color = (s: (typeof segs)[number]) => (s.rest ? 'pie-rest' : `pie-${(s.i % 5) + 1}`);
  // kleine Lücke zwischen den Segmenten (nicht bei nur einem Segment)
  const gap = segs.length > 1 ? 0.6 : 0;

  return html`<figure class="${opts.bare ? 'pie bare' : 'card pie'}" data-pie>
    ${opts.bare
      ? (opts.sub ? html`<figcaption class="chart-readout pie-sub">${opts.sub}</figcaption>` : '')
      : html`<figcaption class="chart-head"><h2>${opts.caption}</h2>${opts.sub ? html`<p class="chart-readout">${opts.sub}</p>` : ''}</figcaption>`}
    ${total <= 0
      ? html`<p class="muted small pie-empty">${opts.emptyText}</p>`
      : html`<div class="pie-body">
        <svg class="pie-svg" viewBox="0 0 42 42" role="img" aria-label="${opts.caption}">
          <circle class="pie-track" cx="21" cy="21" r="15.915" pathLength="100"></circle>
          ${segs.map((s) => {
            const len = Math.max(s.share - gap, 0.2);
            const circle = html`<circle class="pie-seg ${color(s)}" cx="21" cy="21" r="15.915" pathLength="100"
              stroke-dasharray="${len.toFixed(3)} ${(100 - len).toFixed(3)}" stroke-dashoffset="${(25 - s.offset).toFixed(3)}"></circle>`;
            const label = `${s.label}: ${formatMoney(s.value)} (${pct(s.share)})`;
            return s.href
              ? html`<a href="${s.href}" data-slice="${s.i}" aria-label="${label}"><title>${label}</title>${circle}</a>`
              : html`<g data-slice="${s.i}" tabindex="0" aria-label="${label}"><title>${label}</title>${circle}</g>`;
          })}
          <text class="pie-total" x="21" y="21">${Math.round(total / 100).toLocaleString('de-DE')} €</text>
          <text class="pie-total-label" x="21" y="25.5">${opts.centerLabel}</text>
        </svg>
        <ol class="pie-legend">${segs.map((s) => html`<li data-slice="${s.i}">
          <span class="swatch ${color(s)}" aria-hidden="true"></span>
          <span class="pie-name">${s.href ? html`<a href="${s.href}">${s.label}</a>` : s.label}</span>
          <span class="pie-value num">${formatMoney(s.value)}</span>
          <span class="pie-share num">${pct(s.share)}</span>
        </li>`)}</ol>
      </div>`}
  </figure>`;
}

/* ---------------- Fortschrittsbalken mit Grenzmarken ---------------- */

export interface MeterMark {
  value: number;
  label: string;
}

/**
 * Balken von 0 bis max mit senkrechten Marken (z. B. 25.000 € innerhalb von 100.000 €).
 * Gezeichnet als SVG mit Prozent-Koordinaten (keine Inline-Styles wegen CSP). Der Teil
 * jenseits der ersten Marke wird abgesetzt eingefärbt, damit das Überschreiten auffällt.
 * Die Beschriftungen der Marken stehen unter dem Balken an ihrer Position (auf 5 % gerundet,
 * da die Position über CSS-Klassen gesetzt wird).
 */
export function meter(value: number, max: number, opts: { label: SafeHtml | string; marks?: MeterMark[]; state: 'ok' | 'warn' | 'over' | 'danger' }): SafeHtml {
  const x = (v: number) => Math.min(100, Math.max(0, (v / max) * 100));
  const marks = (opts.marks ?? []).filter((m) => m.value > 0 && m.value < max);
  const first = marks[0]?.value ?? max;
  const v = Math.max(0, value);
  const fillEnd = x(v);
  const split = Math.min(fillEnd, x(first));
  return html`<div class="meter meter-${opts.state}">
    <div class="meter-head"><span>${opts.label}</span><strong class="num">${formatMoney(value)}</strong></div>
    <svg class="meter-svg" viewBox="0 0 100 10" preserveAspectRatio="none" role="meter"
      aria-valuemin="0" aria-valuemax="${max}" aria-valuenow="${v}" aria-label="${formatMoney(value)} von ${formatMoney(max)}">
      <rect class="meter-track" x="0" y="0" width="100" height="10"></rect>
      ${split > 0 ? html`<rect class="meter-fill" x="0" y="0" width="${split.toFixed(2)}" height="10"></rect>` : ''}
      ${fillEnd > split ? html`<rect class="meter-fill beyond" x="${split.toFixed(2)}" y="0" width="${(fillEnd - split).toFixed(2)}" height="10"></rect>` : ''}
      ${marks.map((m) => html`<line class="meter-mark" x1="${x(m.value)}" y1="-3" x2="${x(m.value)}" y2="13" vector-effect="non-scaling-stroke"></line>`)}
    </svg>
    <div class="meter-scale" aria-hidden="true">
      ${marks.map((m) => html`<span class="meter-mark-label at-${Math.round(x(m.value) / 5) * 5}">${m.label}</span>`)}
      <span class="meter-max">${formatMoney(max).replace(/,00(?=\s?€)/, '')}</span>
    </div>
  </div>`;
}

/* ---------------- Umsatz und Ausgaben je Monat ---------------- */

export interface ComparePoint {
  label: string;
  title: string;
  revenue: number;
  cost: number;
  current?: boolean;
  /** Monat liegt in der Zukunft – keine Ergebnislinie */
  future?: boolean;
  revenueHref?: string;
  costHref?: string;
}

/**
 * Gruppierte Säulen (Umsatz, Ausgaben) je Monat plus Linie für das Ergebnis (Umsatz − Ausgaben).
 * Gleiche Technik wie barChart: SVG mit festem Koordinatensystem, Beschriftungen in HTML.
 */
export function compareChart(points: ComparePoint[], opts: { caption: string; sub: string; emptyText: string; hint?: string; costLabel: string }): SafeHtml {
  const results = points.map((p) => p.revenue - p.cost);
  const max = Math.max(0, ...points.flatMap((p) => [p.revenue, p.cost]), ...results);
  const min = Math.min(0, ...results.filter((_, i) => !points[i].future), ...points.flatMap((p) => [p.revenue, p.cost]));
  const step = niceStep(max - min || 100_000, 4);
  const lo = Math.floor(min / step) * step;
  const hi = Math.max(Math.ceil(max / step) * step, lo + step);
  const y = (v: number) => H - ((v - lo) / (hi - lo)) * H;
  const ticks: number[] = [];
  for (let v = hi; v >= lo - step / 2; v -= step) ticks.push(Math.round(v));
  const width = points.length * SLOT;

  const revenue = points.reduce((a, p) => a + p.revenue, 0);
  const cost = points.reduce((a, p) => a + p.cost, 0);
  const result = revenue - cost;
  const summary = `Umsatz ${formatMoney(revenue)} − ${opts.costLabel} ${formatMoney(cost)} = Ergebnis ${formatMoney(result)}`;
  const line = points
    .map((p, i) => (p.future ? null : `${(i * SLOT + SLOT / 2).toFixed(2)},${y(results[i]).toFixed(2)}`))
    .filter(Boolean)
    .join(' ');
  const bar = (v: number, x: number, w: number) => {
    const top = Math.min(y(v), y(0));
    const h = Math.max(Math.abs(y(v) - y(0)), v ? 0.6 : 0);
    return html`<rect class="bar" x="${x.toFixed(2)}" y="${top.toFixed(2)}" width="${w}" height="${h.toFixed(2)}"></rect>`;
  };

  return html`<figure class="chart card cmp" data-chart>
    <figcaption class="chart-head">
      <div><h2>${opts.caption}</h2><p class="muted small cmp-sub">${opts.sub}</p></div>
      <p class="chart-readout" data-chart-readout aria-live="polite">${summary}</p>
    </figcaption>
    <ul class="cmp-legend small" aria-hidden="true">
      <li><span class="swatch cmp-rev"></span>Umsatz</li>
      <li><span class="swatch cmp-cost"></span>${opts.costLabel}</li>
      <li><span class="swatch cmp-res"></span>Ergebnis</li>
    </ul>
    <div class="chart-body">
      <div class="chart-y" aria-hidden="true">${ticks.map((t) => html`<span>${axisLabel(t)}</span>`)}</div>
      <div class="chart-plot">
        <div class="chart-grid" aria-hidden="true">${ticks.map((t) => html`<span class="${t === 0 ? 'zero' : ''}"></span>`)}</div>
        <svg class="chart-svg" viewBox="0 0 ${width} ${H}" preserveAspectRatio="none" role="list" aria-label="${opts.caption}">
          ${points.map((p, i) => {
            const text = `${p.title}: Umsatz ${formatMoney(p.revenue)} · ${opts.costLabel} ${formatMoney(p.cost)} · Ergebnis ${formatMoney(results[i])}`;
            const x = i * SLOT;
            const slot = (cls: string, href: string | undefined, shape: SafeHtml, label: string) =>
              href
                ? html`<a href="${href}" class="cmp-bar chart-bar ${cls}${p.current ? ' current' : ''}" data-bar="${text}" role="listitem" aria-label="${label}">${shape}</a>`
                : html`<g class="cmp-bar chart-bar ${cls}${p.current ? ' current' : ''}" data-bar="${text}" tabindex="0" role="listitem" aria-label="${label}">${shape}</g>`;
            return html`${slot('rev', p.revenueHref, html`<rect class="hit" x="${x}" y="0" width="${SLOT / 2}" height="${H}"></rect>${bar(p.revenue, x + 1.2, 3.6)}`, `${p.title}: Umsatz ${formatMoney(p.revenue)}`)}
              ${slot('cost', p.costHref, html`<rect class="hit" x="${x + SLOT / 2}" y="0" width="${SLOT / 2}" height="${H}"></rect>${bar(p.cost, x + 5.2, 3.6)}`, `${p.title}: ${opts.costLabel} ${formatMoney(p.cost)}`)}`;
          })}
          ${line ? html`<polyline class="cmp-line" points="${line}" vector-effect="non-scaling-stroke"></polyline>` : ''}
        </svg>
        ${revenue === 0 && cost === 0 ? html`<p class="chart-empty muted small">${opts.emptyText}</p>` : ''}
      </div>
      <span></span>
      <div class="chart-x m${points.length}" aria-hidden="true">${points.map((p) => html`<span class="${p.current ? 'current' : ''}">${p.label}</span>`)}</div>
    </div>
    <p class="cmp-total ${result < 0 ? 'neg' : ''}"><span>Ergebnis</span> <strong class="num">${formatMoney(result)}</strong></p>
    ${opts.hint ? html`<p class="chart-hint muted small">${opts.hint}</p>` : ''}
  </figure>`;
}
