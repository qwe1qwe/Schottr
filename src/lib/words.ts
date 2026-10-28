/**
 * Beträge in Worten, wie sie Zuwendungsbestätigungen verlangen
 * (BMF-Schreiben vom 7.11.2013: Betrag „in Ziffern“ und „in Buchstaben“).
 * 1250,50 € → „eintausendzweihundertfünfzig Euro und fünfzig Cent“
 */
const ONES = ['null', 'eins', 'zwei', 'drei', 'vier', 'fünf', 'sechs', 'sieben', 'acht', 'neun', 'zehn',
  'elf', 'zwölf', 'dreizehn', 'vierzehn', 'fünfzehn', 'sechzehn', 'siebzehn', 'achtzehn', 'neunzehn'];
const TENS = ['', '', 'zwanzig', 'dreißig', 'vierzig', 'fünfzig', 'sechzig', 'siebzig', 'achtzig', 'neunzig'];

/** 0–999; `prefix` = als Vorsilbe („ein“hundert, „ein“tausend, „ein“undzwanzig) */
function below1000(n: number, prefix: boolean): string {
  const h = Math.floor(n / 100);
  const r = n % 100;
  let out = h ? `${h === 1 ? 'ein' : ONES[h]}hundert` : '';
  if (r === 0) return out;
  if (r === 1) return out + (prefix ? 'ein' : 'eins');
  if (r < 20) return out + ONES[r];
  const one = r % 10;
  return out + (one ? `${one === 1 ? 'ein' : ONES[one]}und` : '') + TENS[Math.floor(r / 10)];
}

/** Ganze Zahl in Worten (bis unter eine Billion) */
export function numberToWords(value: number): string {
  const n = Math.floor(Math.abs(value));
  if (n === 0) return 'null';
  if (n >= 1e12) throw new RangeError('Zahl zu groß');
  const billions = Math.floor(n / 1e9);
  const millions = Math.floor((n % 1e9) / 1e6);
  const thousands = Math.floor((n % 1e6) / 1000);
  const rest = n % 1000;
  const parts: string[] = [];
  if (billions) parts.push(billions === 1 ? 'eine Milliarde' : `${below1000(billions, true)} Milliarden`);
  if (millions) parts.push(millions === 1 ? 'eine Million' : `${below1000(millions, true)} Millionen`);
  let tail = '';
  if (thousands) tail += `${below1000(thousands, true)}tausend`;
  if (rest) tail += below1000(rest, false);
  if (tail) parts.push(tail);
  return (value < 0 ? 'minus ' : '') + parts.join(' ');
}

/** Cent-Betrag in Worten */
export function amountInWords(cents: number): string {
  const abs = Math.abs(cents);
  const euros = Math.floor(abs / 100);
  const ct = abs % 100;
  const euroText = euros === 1 ? 'ein Euro' : `${numberToWords(euros)} Euro`;
  const centText = ct === 1 ? 'ein Cent' : `${numberToWords(ct)} Cent`;
  const text = euros && ct ? `${euroText} und ${centText}` : ct ? centText : euroText;
  return (cents < 0 ? 'minus ' : '') + text;
}
