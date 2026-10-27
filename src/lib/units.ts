/** Häufige Mengeneinheiten nach UN/ECE Recommendation 20 (Pflicht in XRechnung/ZUGFeRD). */
export const UNITS: { code: string; label: string; short: string }[] = [
  { code: 'C62', label: 'Stück', short: 'Stk.' },
  { code: 'HUR', label: 'Stunde', short: 'Std.' },
  { code: 'DAY', label: 'Tag', short: 'Tag(e)' },
  { code: 'MON', label: 'Monat', short: 'Monat(e)' },
  { code: 'ANN', label: 'Jahr', short: 'Jahr(e)' },
  { code: 'LS', label: 'Pauschale', short: 'pausch.' },
  { code: 'KMT', label: 'Kilometer', short: 'km' },
  { code: 'MTR', label: 'Meter', short: 'm' },
  { code: 'MTK', label: 'Quadratmeter', short: 'm²' },
  { code: 'MTQ', label: 'Kubikmeter', short: 'm³' },
  { code: 'KGM', label: 'Kilogramm', short: 'kg' },
  { code: 'LTR', label: 'Liter', short: 'l' },
  { code: 'SET', label: 'Satz', short: 'Satz' },
];

const byCode = new Map(UNITS.map((u) => [u.code, u]));

export function unitShort(code: string): string {
  return byCode.get(code)?.short ?? code;
}

export function isUnit(code: string): boolean {
  return byCode.has(code);
}
