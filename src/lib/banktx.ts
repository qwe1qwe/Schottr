import crypto from 'node:crypto';

/**
 * Hilfsfunktionen für abgerufene Kontoumsätze (FinTS/CAMT) – ohne Datenbank, damit testbar.
 * Beträge in Cent mit Vorzeichen (+ Gutschrift, − Lastschrift), Daten als ISO-Datum.
 */

export interface RawTransaction {
  entryDate: Date;
  valueDate?: Date;
  amount: number;
  purpose?: unknown;
  remoteName?: unknown;
  remoteAccountNumber?: unknown;
  remoteIdentifier?: unknown;
  bookingText?: unknown;
  additionalInformation?: unknown;
  e2eReference?: unknown;
  mandateReference?: unknown;
  bankReference?: unknown;
}

export interface BankTx {
  fingerprint: string;
  booking_date: string;
  value_date: string | null;
  amount: number;
  remote_name: string;
  remote_iban: string;
  purpose: string;
  booking_text: string;
  e2e_ref: string;
  mandate_ref: string;
  bank_ref: string;
}

/** Datum aus dem Parser (Ortszeit, mittags) als ISO-Datum */
export function isoDay(d: Date | undefined | null): string | null {
  if (!d || Number.isNaN(d.getTime())) return null;
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

/** Freitext aus CAMT/MT940: mehrzeilige Felder kommen teils als Array */
export function text(v: unknown, max: number): string {
  const s = Array.isArray(v) ? v.map((x) => String(x ?? '')).join(' ') : v == null ? '' : String(v);
  const clean = s.replace(/\s+/g, ' ').trim();
  return clean === 'NOTPROVIDED' || clean === 'NONREF' ? '' : clean.slice(0, max);
}

const ibanLike = (v: string) => (/^[A-Z]{2}\d{2}[A-Z0-9]{10,30}$/.test(v.replace(/\s/g, '').toUpperCase()) ? v.replace(/\s/g, '').toUpperCase() : '');

/**
 * Umsätze eines Abrufs vereinheitlichen und mit einem stabilen Fingerabdruck versehen.
 * Gleiche Umsätze am selben Tag (z. B. zwei Mitgliedsbeiträge über 24 €) werden durchgezählt –
 * ein Abruf enthält immer ganze Tage, so bleibt die Zählung bei jedem weiteren Abruf gleich.
 */
export function normalizeTransactions(raw: RawTransaction[]): BankTx[] {
  const seen = new Map<string, number>();
  const out: BankTx[] = [];
  for (const r of raw) {
    const booking = isoDay(r.entryDate);
    if (!booking || !Number.isFinite(r.amount)) continue;
    const tx = {
      booking_date: booking,
      value_date: isoDay(r.valueDate),
      amount: Math.round(r.amount * 100),
      remote_name: text(r.remoteName, 200),
      remote_iban: ibanLike(text(r.remoteAccountNumber, 40)) || ibanLike(text(r.remoteIdentifier, 40)),
      purpose: text(r.purpose, 1000),
      booking_text: text(r.bookingText ?? r.additionalInformation, 200),
      e2e_ref: text(r.e2eReference, 100),
      mandate_ref: text(r.mandateReference, 100),
      bank_ref: text(r.bankReference, 100),
    };
    const key = JSON.stringify([tx.booking_date, tx.value_date, tx.amount, tx.remote_iban, tx.remote_name, tx.purpose, tx.e2e_ref, tx.bank_ref]);
    const n = (seen.get(key) ?? 0) + 1;
    seen.set(key, n);
    out.push({ ...tx, fingerprint: crypto.createHash('sha256').update(`${key}#${n}`).digest('hex') });
  }
  return out;
}

/** Zum Vergleich mit Rechnungsnummern: nur Buchstaben und Ziffern, Großschreibung */
export const compact = (s: string) => s.toUpperCase().replace(/[^A-Z0-9]/g, '');

/**
 * Steht die Belegnummer im Verwendungszweck? Ganze Nummer, nicht nur ein Teil davon –
 * „RE-2026-1“ passt nicht zu „RE-2026-12“. Sehr kurze Nummern (unter 4 Zeichen) zählen nicht.
 */
export function mentions(purpose: string, number: string | null | undefined): boolean {
  const n = compact(number ?? '');
  if (n.length < 4) return false;
  const p = compact(purpose);
  let i = p.indexOf(n);
  while (i >= 0) {
    const after = p[i + n.length];
    const before = p[i - 1];
    const digitEnd = /\d/.test(n[n.length - 1]);
    const digitStart = /\d/.test(n[0]);
    if (!(digitEnd && after && /\d/.test(after)) && !(digitStart && before && /\d/.test(before))) return true;
    i = p.indexOf(n, i + 1);
  }
  return false;
}

/** Abstand zweier ISO-Daten in Tagen (Betrag) */
export function dayDistance(a: string, b: string): number {
  return Math.abs(Date.parse(`${a}T00:00:00Z`) - Date.parse(`${b}T00:00:00Z`)) / 86_400_000;
}
