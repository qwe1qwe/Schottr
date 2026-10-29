import { html, raw, selected, type SafeHtml } from './html.ts';
import { str, type Form } from './http.ts';

/**
 * Vereine und gemeinnützige (steuerbegünstigte) Körperschaften nach §§ 51 ff. AO.
 *
 * Ein gemeinnütziger Verein ordnet jede Einnahme einem von vier Bereichen („Sphären“) zu –
 * davon hängt ab, ob und welche Grenzen greifen. Sportliche Veranstaltungen sind ein
 * Sonderfall des Zweckbetriebs mit eigener Grenze (§ 67a AO) und deshalb getrennt geführt.
 */
export type OrgType = 'company' | 'association';
export type Sphere = 'ideell' | 'asset' | 'purpose' | 'sport' | 'business';

export const SPHERES: { value: Sphere; label: string; short: string; hint: string; examples: string }[] = [
  {
    value: 'business', label: 'Wirtschaftlicher Geschäftsbetrieb', short: 'Wirtsch. Geschäftsbetrieb',
    hint: 'Der Verein verdient wie ein Unternehmen Geld. Bis 50.000 € Einnahmen im Jahr (alle zusammen) keine Körperschaft- und Gewerbesteuer, darüber wird der Gewinn besteuert; Umsatzsteuer fällt unabhängig davon an (außer als Kleinunternehmer).',
    examples: 'Getränke- und Speisenverkauf, Bewirtung bei Festen, Werbung und Sponsoring mit Gegenleistung, Warenverkauf – dazu die Ausgaben dafür (z. B. Getränke-Einkauf).',
  },
  {
    value: 'purpose', label: 'Zweckbetrieb', short: 'Zweckbetrieb',
    hint: 'Leistungen gegen Entgelt, die den Satzungszweck unmittelbar erfüllen. Keine Körperschaft- und Gewerbesteuer; Umsatzsteuer meist 7 % oder steuerfrei.',
    examples: 'Kurse und Workshops, Konzert- oder Theatereintritt, Fortbildungen, Ferienfreizeiten – dazu die Ausgaben dafür (z. B. Dozenten, Saalmiete fürs Konzert).',
  },
  {
    value: 'sport', label: 'Sportliche Veranstaltungen (§ 67a AO)', short: 'Sportveranstaltungen',
    hint: 'Sonderfall des Zweckbetriebs: bis 50.000 € Einnahmen im Jahr wie ein Zweckbetrieb behandelt, darüber als wirtschaftlicher Geschäftsbetrieb.',
    examples: 'Startgelder, Eintritt zu Spielen und Turnieren, Teilnehmergebühren – nicht Werbung oder Bewirtung dabei (die gehören zum wirtschaftlichen Geschäftsbetrieb).',
  },
  {
    value: 'asset', label: 'Vermögensverwaltung', short: 'Vermögensverwaltung',
    hint: 'Vorhandenes Vermögen arbeiten lassen, ohne selbst aktiv zu wirtschaften. Keine Körperschaft- und Gewerbesteuer; Vermietung meist umsatzsteuerfrei.',
    examples: 'langfristige Vermietung oder Verpachtung (z. B. verpachtete Vereinsgaststätte), Zinsen, Logo eines Sponsors ohne Werbeleistung (bloße Duldung).',
  },
  {
    value: 'ideell', label: 'Ideeller Bereich', short: 'Ideeller Bereich',
    hint: 'Der eigentliche Vereinszweck ohne Gegenleistung – nicht steuerbar.',
    examples: 'Mitgliedsbeiträge, Spenden, Zuschüsse; Ausgaben für Vereinsheim, Verwaltung, Übungsbetrieb, Ehrungen, Nachrufe, Jugendarbeit.',
  },
];

/**
 * Auswahl des Bereichs mit Erklärung: Überfahren der Auswahl zeigt die Erklärung des gewählten
 * Bereichs als Tooltip, darunter steht sie als Text (wechselt beim Auswählen), und ein
 * aufklappbarer Hinweis erklärt alle Bereiche mit Beispielen.
 */
export function sphereSelect(opts: { name?: string; value: string; label?: string; note?: string; disabled?: boolean; ariaLabel?: string; compact?: boolean }): SafeHtml {
  const current = SPHERES.find((s) => s.value === opts.value) ?? SPHERES[0];
  const select = html`<select name="${opts.name ?? 'sphere'}" data-sphere-select title="${current.hint} Beispiele: ${current.examples}"
      ${opts.disabled ? html`disabled` : ''} ${opts.ariaLabel ? html`aria-label="${opts.ariaLabel}"` : ''}>
    ${SPHERES.map((s) => html`<option value="${s.value}" title="${s.hint} Beispiele: ${s.examples}" data-hint="${s.hint}" data-examples="${s.examples}"${selected(s.value, current.value)}>${s.label}</option>`)}
  </select>`;
  if (opts.compact) return select;
  return html`<div class="sphere-field stack-tight">
    <label>${opts.label ?? 'Bereich (Gemeinnützigkeit)'}
      ${select}
      <small class="muted sphere-hint" data-sphere-hint><strong>${current.hint}</strong> z. B. ${current.examples}</small>
      ${opts.note ? html`<small class="muted">${opts.note}</small>` : ''}
    </label>
    ${sphereHelp()}
  </div>`;
}

/** Aufklappbare Erklärung aller Bereiche */
export function sphereHelp(): SafeHtml {
  return html`<details class="sphere-help small">
    <summary>Was bedeuten die Bereiche?</summary>
    <dl>${SPHERES.map((s) => html`<dt>${s.label}</dt><dd>${s.hint} <span class="muted">z. B. ${s.examples}</span></dd>`)}</dl>
    <p class="muted">Eine Ausgabe gehört in den Bereich, dem sie dient. Bei gemischter Nutzung (z. B. Vereinsheim mit Getränkeverkauf) im Zweifel mit dem Steuerbüro klären.</p>
  </details>`;
}

export const isSphere = (v: string): v is Sphere => SPHERES.some((s) => s.value === v);
export const sphereLabel = (v: string) => SPHERES.find((s) => s.value === v)?.label ?? '';

/**
 * Betragsgrenzen in Cent, Einnahmen jeweils einschließlich Umsatzsteuer.
 * Seit 2026 durch das Steueränderungsgesetz 2025 angehoben; davor (seit 2020) galten 45.000 €.
 */
export function nonprofitLimits(year: number) {
  const since2026 = year >= 2026;
  return {
    /** § 64 Abs. 3 AO: Besteuerungsgrenze für alle wirtschaftlichen Geschäftsbetriebe zusammen */
    business: since2026 ? 50_000_00 : 45_000_00,
    /** § 67a Abs. 1 AO: sportliche Veranstaltungen gelten bis zu dieser Grenze als Zweckbetrieb */
    sport: since2026 ? 50_000_00 : 45_000_00,
    /** § 55 Abs. 1 Nr. 5 Satz 4 AO: keine Pflicht zur zeitnahen Mittelverwendung */
    funds: since2026 ? 100_000_00 : 45_000_00,
  };
}

/** Freibetrag für Vereine und Stiftungen (§ 24 KStG, § 11 Abs. 1 GewStG), in Cent */
export const NONPROFIT_ALLOWANCE = 5_000_00;

/**
 * Organisationsform beim Anlegen eines Mandanten: Art (Unternehmen oder Verein) und – nur bei
 * Vereinen – das Häkchen „gemeinnützig“. Die Gemeinnützigkeit ist ein eigener Status wie die
 * Kleinunternehmerregelung: Sie kann wegfallen oder neu hinzukommen, ohne dass sich die Art ändert.
 */
export function orgFields(values: { org_type?: string; nonprofit?: string } = {}): SafeHtml {
  return html`<label>Art
    <select name="org_type">
      <option value="company"${selected('company', values.org_type ?? 'company')}>Unternehmen / Selbstständig</option>
      <option value="association"${selected('association', values.org_type ?? 'company')}>Verein (e. V. oder nicht eingetragen)</option>
    </select></label>
  <label class="check" data-show-if="org_type=association"><input type="checkbox" name="nonprofit" value="1"${values.nonprofit === '1' ? raw(' checked') : ''}>
    Gemeinnützig (steuerbegünstigt nach §§ 51 ff. AO)</label>`;
}

/** Liest orgFields(): gemeinnützig gibt es nur bei Vereinen */
export function orgFromForm(form: Form): { orgType: OrgType; nonprofit: boolean } {
  const orgType: OrgType = str(form, 'org_type') === 'association' ? 'association' : 'company';
  return { orgType, nonprofit: orgType === 'association' && str(form, 'nonprofit') === '1' };
}
