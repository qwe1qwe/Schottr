import { roundDiv } from './money.ts';

export type TaxMode = 'standard' | 'small_business' | 'reverse_charge' | 'exempt';

export interface ItemInput {
  title: string;
  description: string;
  quantity: number; // Tausendstel
  unit: string;
  unitPrice: number; // Cent
  vatRate: number; // Basispunkte
  /** Artikelnummer aus dem Artikelstamm (optional, BT-155) */
  articleNumber?: string;
}

export interface CalculatedItem extends ItemInput {
  position: number;
  lineTotal: number;
}

export interface TaxGroup {
  /** EN 16931 VAT category code (BT-118): S, E, AE */
  category: 'S' | 'E' | 'AE';
  rate: number; // Basispunkte
  basis: number; // Cent
  tax: number; // Cent
}

export interface Totals {
  items: CalculatedItem[];
  taxes: TaxGroup[];
  net: number;
  tax: number;
  gross: number;
}

export const VAT_RATES = [1900, 700] as const;

export function taxCategory(mode: TaxMode): 'S' | 'E' | 'AE' {
  if (mode === 'reverse_charge') return 'AE';
  if (mode === 'small_business' || mode === 'exempt') return 'E';
  return 'S';
}

/** Bei steuerfreien Modi ist der effektive Satz 0. */
export function effectiveRate(mode: TaxMode, rate: number): number {
  return taxCategory(mode) === 'S' ? rate : 0;
}

export function lineTotal(quantity: number, unitPrice: number): number {
  return roundDiv(quantity * unitPrice, 1000);
}

/**
 * Summenbildung nach EN 16931: Positionsbeträge gerundet, Steuer je Steuersatz
 * auf die Summe der Positionen berechnet (nicht je Position).
 */
export function calculate(items: ItemInput[], mode: TaxMode): Totals {
  const category = taxCategory(mode);
  const calculated: CalculatedItem[] = items.map((item, i) => ({
    ...item,
    vatRate: effectiveRate(mode, item.vatRate),
    position: i + 1,
    lineTotal: lineTotal(item.quantity, item.unitPrice),
  }));

  const groups = new Map<number, TaxGroup>();
  for (const item of calculated) {
    const g = groups.get(item.vatRate) ?? { category, rate: item.vatRate, basis: 0, tax: 0 };
    g.basis += item.lineTotal;
    groups.set(item.vatRate, g);
  }
  const taxes = [...groups.values()]
    .map((g) => ({ ...g, tax: roundDiv(g.basis * g.rate, 10000) }))
    .sort((a, b) => b.rate - a.rate);

  const net = calculated.reduce((s, i) => s + i.lineTotal, 0);
  const tax = taxes.reduce((s, g) => s + g.tax, 0);
  return { items: calculated, taxes, net, tax, gross: net + tax };
}
