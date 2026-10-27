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
export function pieChart(slices: PieSlice[], opts: { caption: string; sub?: string; emptyText: string; centerLabel: string }): SafeHtml {
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

  return html`<figure class="card pie" data-pie>
    <figcaption class="chart-head"><h2>${opts.caption}</h2>${opts.sub ? html`<p class="chart-readout">${opts.sub}</p>` : ''}</figcaption>
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

/* ---------------- Fortschrittsbalken (Grenzwerte) ---------------- */

export function meter(value: number, limit: number, opts: { label: SafeHtml | string; detail?: SafeHtml | string }): SafeHtml {
  const ratio = limit > 0 ? value / limit : 0;
  const state = ratio >= 1 ? 'over' : ratio >= 0.8 ? 'warn' : 'ok';
  // 20 Stufen à 5 % – Breite über Klassen, da die CSP keine Inline-Styles erlaubt
  const step = Math.min(20, Math.max(value > 0 ? 1 : 0, Math.round(ratio * 20)));
  return html`<div class="meter meter-${state}">
    <div class="meter-head"><span>${opts.label}</span><strong class="num">${pct(Math.round(ratio * 1000) / 10)}</strong></div>
    <div class="meter-track" role="meter" aria-valuemin="0" aria-valuemax="${limit}" aria-valuenow="${Math.max(0, value)}"><span class="meter-fill w${step}"></span></div>
    <div class="meter-foot num">${formatMoney(value)} von ${formatMoney(limit)}${opts.detail ? html` · ${opts.detail}` : ''}</div>
  </div>`;
}
