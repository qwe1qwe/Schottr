/**
 * Umsatzsteuersätze in Basispunkten (1900 = 19 %). Neben den üblichen Sätzen lässt sich jeder
 * Satz frei eintragen – z. B. 16 % bzw. 5 % aus der befristeten Senkung vom 1.7. bis 31.12.2020.
 */
export const MAX_RATE = 10000;

/** Gültiger Satz: ganze Basispunkte zwischen 0 (bzw. 0,01 %) und 100 % */
export function isRate(rate: number, allowZero = true): boolean {
  return Number.isInteger(rate) && rate <= MAX_RATE && (allowZero ? rate >= 0 : rate > 0);
}

/** Satz aus einem Formularwert („1600“), ungültig → null */
export function rateFrom(value: string | undefined, allowZero = true): number | null {
  if (!value || !/^\d{1,5}$/.test(value.trim())) return null;
  const n = Number(value.trim());
  return isRate(n, allowZero) ? n : null;
}

/**
 * DATEV wertet die Automatik-Schlüssel nach dem Belegdatum aus: Im zweiten Halbjahr 2020
 * gelten 19 %-Schlüssel und -Konten als 16 %, 7 % als 5 %. Liefert den Standardsatz, unter dem
 * ein Satz gebucht wird, oder null, wenn es keinen Automatik-Schlüssel dafür gibt.
 */
export function datevStandardRate(rate: number, date: string): 1900 | 700 | null {
  if (rate === 1900 || rate === 700) return rate;
  const corona = date >= '2020-07-01' && date <= '2020-12-31';
  if (corona && rate === 1600) return 1900;
  if (corona && rate === 500) return 700;
  return null;
}
