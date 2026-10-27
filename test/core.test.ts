import { test } from 'node:test';
import assert from 'node:assert/strict';
import { calculate } from '../src/lib/calc.ts';
import { parseDecimal, centsToDecimal, milliToDecimal, bpToDecimal } from '../src/lib/money.ts';
import { formatNumber, periodFor } from '../src/lib/numbering.ts';
import { isValidIban, isValidVatId } from '../src/lib/validate.ts';
import { addDays } from '../src/lib/dates.ts';

test('Dezimalzahlen deutsch und englisch', () => {
  assert.equal(parseDecimal('1.234,56', 2), 123456);
  assert.equal(parseDecimal('1234.56', 2), 123456);
  assert.equal(parseDecimal('19,995', 2), 2000);
  assert.equal(parseDecimal('6,5', 3), 6500);
  assert.equal(parseDecimal('-1', 3), -1000);
  assert.equal(parseDecimal('abc', 2), null);
  assert.equal(parseDecimal('', 2), null);
});

test('XML-Zahlenformate', () => {
  assert.equal(centsToDecimal(123456), '1234.56');
  assert.equal(centsToDecimal(-5), '-0.05');
  assert.equal(milliToDecimal(1500), '1.5');
  assert.equal(milliToDecimal(3000), '3');
  assert.equal(bpToDecimal(1900), '19');
  assert.equal(bpToDecimal(750), '7.5');
});

test('Summen nach EN 16931 – Steuer je Steuersatz', () => {
  const t = calculate(
    [
      { title: 'A', description: '', quantity: 6500, unit: 'HUR', unitPrice: 9500, vatRate: 1900 },
      { title: 'B', description: '', quantity: 3000, unit: 'C62', unitPrice: 1999, vatRate: 1900 },
      { title: 'C', description: '', quantity: 1000, unit: 'C62', unitPrice: 3990, vatRate: 700 },
    ],
    'standard',
  );
  assert.equal(t.net, 71737);
  assert.deepEqual(t.taxes.map((g) => [g.rate, g.basis, g.tax]), [[1900, 67747, 12872], [700, 3990, 279]]);
  assert.equal(t.gross, 84888);
});

test('Kleinunternehmer: keine Umsatzsteuer', () => {
  const t = calculate([{ title: 'A', description: '', quantity: 1000, unit: 'C62', unitPrice: 10000, vatRate: 1900 }], 'small_business');
  assert.equal(t.tax, 0);
  assert.equal(t.taxes[0].category, 'E');
  assert.equal(t.gross, 10000);
});

test('Nummernkreise', () => {
  assert.equal(formatNumber('RE-{YYYY}-{NNNN}', 7, '2026-10-27'), 'RE-2026-0007');
  assert.equal(formatNumber('{YY}{MM}-{NNN}', 12, '2026-03-01'), '2603-012');
  assert.equal(periodFor('RE-{YYYY}-{NNNN}', '2026-10-27'), '2026');
  assert.equal(periodFor('{YY}{MM}-{NNN}', '2026-03-01'), '2026-03');
  assert.equal(periodFor('K{NNNNN}', '2026-03-01'), 'all');
});

test('IBAN und USt-IdNr.', () => {
  assert.ok(isValidIban('DE02 1203 0000 0000 2020 51'));
  assert.ok(!isValidIban('DE02 1203 0000 0000 2020 52'));
  assert.ok(isValidVatId('DE123456789'));
  assert.ok(!isValidVatId('DE12345'));
});

test('Datumsrechnung', () => {
  assert.equal(addDays('2026-12-25', 14), '2027-01-08');
});
