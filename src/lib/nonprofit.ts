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

export const SPHERES: { value: Sphere; label: string; short: string; hint: string }[] = [
  {
    value: 'business', label: 'Wirtschaftlicher Geschäftsbetrieb', short: 'Wirtsch. Geschäftsbetrieb',
    hint: 'z. B. Sponsoring/Werbung, Verkauf, Bewirtung, Vermietung mit Zusatzleistungen',
  },
  {
    value: 'purpose', label: 'Zweckbetrieb', short: 'Zweckbetrieb',
    hint: 'Leistungen, die den Satzungszweck unmittelbar verwirklichen, z. B. Kurse, Eintritt zu kulturellen Veranstaltungen',
  },
  {
    value: 'sport', label: 'Sportliche Veranstaltungen (§ 67a AO)', short: 'Sportveranstaltungen',
    hint: 'Startgelder, Eintritt zu Sportveranstaltungen – Werbung und Bewirtung dabei zählen zum wirtschaftlichen Geschäftsbetrieb',
  },
  {
    value: 'asset', label: 'Vermögensverwaltung', short: 'Vermögensverwaltung',
    hint: 'z. B. langfristige Vermietung oder Verpachtung, Überlassung von Rechten',
  },
  {
    value: 'ideell', label: 'Ideeller Bereich', short: 'Ideeller Bereich',
    hint: 'z. B. Mitgliedsbeiträge, Spenden, Zuschüsse',
  },
];

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
