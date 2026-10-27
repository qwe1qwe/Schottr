/** Geld in Cent, Mengen in Tausendstel, Steuersätze in Basispunkten – keine Fließkomma-Rundungsfehler. */

const eur = new Intl.NumberFormat('de-DE', { style: 'currency', currency: 'EUR' });
const num = (digits: number) =>
  new Intl.NumberFormat('de-DE', { minimumFractionDigits: 0, maximumFractionDigits: digits });

export function formatMoney(cents: number): string {
  return eur.format(cents / 100);
}

/** 123456 -> "1.234,56" (ohne Währung) */
export function formatAmount(cents: number): string {
  return new Intl.NumberFormat('de-DE', { minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(cents / 100);
}

export function formatQuantity(milli: number): string {
  return num(3).format(milli / 1000);
}

export function formatRate(bp: number): string {
  return `${num(2).format(bp / 100)} %`;
}

/** Deutsche oder englische Dezimalschreibweise in eine ganze Zahl mit `decimals` Nachkommastellen umrechnen. */
export function parseDecimal(input: unknown, decimals: number): number | null {
  if (input === null || input === undefined) return null;
  let s = String(input).trim().replace(/\s|€|%/g, '');
  if (s === '') return null;
  if (s.includes(',')) s = s.replace(/\./g, '').replace(',', '.'); // 1.234,56 -> 1234.56
  if (!/^-?\d*(\.\d*)?$/.test(s) || s === '-' || s === '.') return null;
  const negative = s.startsWith('-');
  const [intPart, fracPart = ''] = s.replace('-', '').split('.');
  const frac = (fracPart + '0'.repeat(decimals + 1)).slice(0, decimals + 1);
  let value = Number(intPart || '0') * 10 ** decimals + Number(frac.slice(0, decimals) || '0');
  if (Number(frac[decimals]) >= 5) value += 1; // kaufmännisch runden
  return negative ? -value : value;
}

/** Kaufmännisches Runden (half away from zero) einer Division. */
export function roundDiv(numerator: number, denominator: number): number {
  const sign = Math.sign(numerator) * Math.sign(denominator) || 1;
  return sign * Math.round(Math.abs(numerator) / Math.abs(denominator));
}

/** Cent als Dezimalstring für XML: 123456 -> "1234.56" */
export function centsToDecimal(cents: number): string {
  const sign = cents < 0 ? '-' : '';
  const abs = Math.abs(cents);
  return `${sign}${Math.floor(abs / 100)}.${String(abs % 100).padStart(2, '0')}`;
}

/** Tausendstel als Dezimalstring für XML: 1500 -> "1.5" */
export function milliToDecimal(milli: number): string {
  const sign = milli < 0 ? '-' : '';
  const abs = Math.abs(milli);
  const frac = String(abs % 1000).padStart(3, '0').replace(/0+$/, '');
  return `${sign}${Math.floor(abs / 1000)}${frac ? '.' + frac : ''}`;
}

/** Basispunkte als Dezimalstring: 1900 -> "19", 750 -> "7.5" */
export function bpToDecimal(bp: number): string {
  const frac = String(bp % 100).padStart(2, '0').replace(/0+$/, '');
  return `${Math.floor(bp / 100)}${frac ? '.' + frac : ''}`;
}
