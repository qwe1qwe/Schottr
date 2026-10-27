/** Prüfungen für deutsche Stammdaten. */

export function normalizeIban(iban: string): string {
  return iban.replace(/\s+/g, '').toUpperCase();
}

export function isValidIban(input: string): boolean {
  const iban = normalizeIban(input);
  if (!/^[A-Z]{2}\d{2}[A-Z0-9]{10,30}$/.test(iban)) return false;
  if (iban.startsWith('DE') && iban.length !== 22) return false;
  const rearranged = iban.slice(4) + iban.slice(0, 4);
  const digits = rearranged.replace(/[A-Z]/g, (ch) => String(ch.charCodeAt(0) - 55));
  let rest = 0;
  for (const d of digits) rest = (rest * 10 + Number(d)) % 97;
  return rest === 1;
}

export function formatIban(input: string): string {
  return normalizeIban(input).replace(/(.{4})/g, '$1 ').trim();
}

export function isValidBic(bic: string): boolean {
  return /^[A-Z]{4}[A-Z]{2}[A-Z0-9]{2}([A-Z0-9]{3})?$/.test(bic.replace(/\s+/g, '').toUpperCase());
}

/** USt-IdNr.: grobe Formatprüfung, für DE exakt "DE" + 9 Ziffern. */
export function isValidVatId(input: string): boolean {
  const v = input.replace(/\s+/g, '').toUpperCase();
  if (v.startsWith('DE')) return /^DE\d{9}$/.test(v);
  return /^[A-Z]{2}[A-Z0-9+*]{2,12}$/.test(v);
}

export function normalizeVatId(input: string): string {
  return input.replace(/\s+/g, '').toUpperCase();
}

export function isValidEmail(email: string): boolean {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
}

export function isValidZipDe(zip: string): boolean {
  return /^\d{5}$/.test(zip);
}

export function isCountryCode(code: string): boolean {
  return /^[A-Z]{2}$/.test(code);
}
