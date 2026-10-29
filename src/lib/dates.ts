/** Datumswerte werden als ISO-Datum (YYYY-MM-DD) in Europe/Berlin gespeichert. */

export function today(): string {
  return new Intl.DateTimeFormat('sv-SE', { timeZone: 'Europe/Berlin' }).format(new Date());
}

export function addDays(isoDate: string, days: number): string {
  const d = new Date(`${isoDate}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

export function daysBetween(from: string, to: string): number {
  return Math.round((Date.parse(`${to}T12:00:00Z`) - Date.parse(`${from}T12:00:00Z`)) / 86_400_000);
}

export function formatDate(isoDate: string | null | undefined): string {
  if (!isoDate) return '';
  const [y, m, d] = isoDate.slice(0, 10).split('-');
  return `${d}.${m}.${y}`;
}

export function isIsoDate(value: unknown): value is string {
  return typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value) && !Number.isNaN(Date.parse(value));
}

/** "20261027" für CII (Format 102) */
export function toCiiDate(isoDate: string): string {
  return isoDate.replaceAll('-', '');
}

export const MONTH_NAMES = ['Januar', 'Februar', 'März', 'April', 'Mai', 'Juni', 'Juli', 'August', 'September', 'Oktober', 'November', 'Dezember'];

/** "2026-10" → "Oktober 2026" (oder null bei ungültiger Angabe) */
export function monthLabel(ym: string): string | null {
  const m = /^(\d{4})-(0[1-9]|1[0-2])$/.exec(ym);
  return m ? `${MONTH_NAMES[Number(m[2]) - 1]} ${m[1]}` : null;
}

/**
 * Zahlungszeitraum aus der Übersicht: Jahr „2026“ oder Monat „2026-10“ → Von/Bis und Bezeichnung
 */
export function paidPeriod(v: string): { from: string; to: string; label: string } | null {
  if (/^\d{4}$/.test(v)) return { from: `${v}-01-01`, to: `${v}-12-31`, label: `bezahlt ${v}` };
  const label = monthLabel(v);
  return label ? { from: `${v}-01`, to: monthEnd(v), label: `bezahlt im ${label}` } : null;
}

/** Letzter Tag eines Monats "2026-02" → "2026-02-28" */
export function monthEnd(ym: string): string {
  const [y, m] = ym.split('-').map(Number);
  return `${ym}-${String(new Date(Date.UTC(y, m, 0)).getUTCDate()).padStart(2, '0')}`;
}
