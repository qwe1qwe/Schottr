import { html, selected, type SafeHtml } from '../lib/html.ts';
import { formatRate } from '../lib/money.ts';

/**
 * Optionen für eine USt.-Auswahl: die üblichen Sätze, ein bereits gespeicherter abweichender Satz
 * und „Anderer Satz …“ (fragt per Skript nach dem Prozentwert, z. B. 16 % für 2020).
 * Das <select> braucht das Attribut data-vat-select.
 */
export function vatOptions(standard: readonly (readonly [number, string])[], current: number): SafeHtml {
  const extra = standard.some(([v]) => v === current) ? null : current;
  return html`${standard.map(([v, l]) => html`<option value="${v}"${selected(v, current)}>${l}</option>`)}
    ${extra !== null ? html`<option value="${extra}" selected>${formatRate(extra)}</option>` : ''}
    <option value="custom">Anderer Satz …</option>`;
}

/** Übliche Sätze als Liste für vatOptions */
export const rateList = (rates: readonly number[]) => rates.map((r) => [r, formatRate(r).replace(',00', '')] as const);
