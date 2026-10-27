import { one, run, tx } from '../db/index.ts';

/**
 * Nummernkreise mit Platzhaltern: {YYYY} {YY} {MM} {NNNN} (Anzahl N = Stellen).
 * Enthält das Format ein Jahr (bzw. Monat), beginnt der Zähler je Jahr (bzw. Monat) neu.
 * Rechnungsnummern werden erst beim Festschreiben vergeben – dadurch lückenlos (§ 14 Abs. 4 Nr. 4 UStG).
 */
export function formatNumber(format: string, value: number, date: string): string {
  const [yyyy, mm] = date.split('-');
  return format
    .replaceAll('{YYYY}', yyyy)
    .replaceAll('{YY}', yyyy.slice(2))
    .replaceAll('{MM}', mm)
    .replace(/\{(N+)\}/g, (_, n: string) => String(value).padStart(n.length, '0'));
}

export function periodFor(format: string, date: string): string {
  const [yyyy, mm] = date.split('-');
  if (format.includes('{MM}')) return `${yyyy}-${mm}`;
  if (format.includes('{YY')) return yyyy;
  return 'all';
}

export function isValidFormat(format: string): boolean {
  return /\{N+\}/.test(format) && format.length <= 40 && !/[<>"'\\/]/.test(format);
}

/**
 * Zähler atomar erhöhen. Die Zeile bleibt bis zum Ende der Transaktion gesperrt –
 * wird sie zurückgerollt (z. B. weil das PDF nicht erzeugt werden konnte), ist auch
 * die Nummer wieder frei. So bleibt der Rechnungsnummernkreis lückenlos.
 */
export async function nextNumber(tenantId: number, kind: string, format: string, date: string): Promise<string> {
  return tx(async () => {
    const period = periodFor(format, date);
    await run(
      `INSERT INTO counters (tenant_id, kind, period, \`value\`) VALUES (?, ?, ?, LAST_INSERT_ID(1))
       ON DUPLICATE KEY UPDATE \`value\` = LAST_INSERT_ID(\`value\` + 1)`,
      tenantId, kind, period,
    );
    const row = await one<{ v: number }>('SELECT LAST_INSERT_ID() AS v');
    return formatNumber(format, Number(row!.v), date);
  });
}
