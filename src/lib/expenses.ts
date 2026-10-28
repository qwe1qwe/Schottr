import type { Tenant } from '../types.ts';

/**
 * Kostenarten für Eingangsrechnungen – bewusst wenige, gängige Gruppen.
 * Jede Art hat ein Standard-Aufwandskonto je Kontenrahmen (ohne Vorsteuer-Automatik,
 * die Vorsteuer steuert der BU-Schlüssel im DATEV-Export). Abweichende Konten lassen sich
 * in den Einstellungen festlegen, z. B. „buero=4930, software=4964“.
 */
type Category = { key: string; label: string; skr03: string; skr04: string; association?: true };

export const EXPENSE_CATEGORIES = [
  { key: 'ware', label: 'Waren & Material', skr03: '3200', skr04: '5200' },
  { key: 'fremd', label: 'Fremdleistungen', skr03: '3100', skr04: '5900' },
  { key: 'miete', label: 'Miete & Raumkosten', skr03: '4210', skr04: '6310' },
  { key: 'kfz', label: 'Kfz-Kosten', skr03: '4530', skr04: '6530' },
  { key: 'reise', label: 'Reisekosten', skr03: '4670', skr04: '6670' },
  { key: 'werbung', label: 'Werbung', skr03: '4600', skr04: '6600' },
  { key: 'telefon', label: 'Telefon & Internet', skr03: '4920', skr04: '6805' },
  { key: 'buero', label: 'Bürobedarf', skr03: '4930', skr04: '6815' },
  { key: 'software', label: 'Software & IT', skr03: '4806', skr04: '6495' },
  { key: 'beratung', label: 'Beratung & Buchführung', skr03: '4950', skr04: '6825' },
  { key: 'versicherung', label: 'Versicherungen & Beiträge', skr03: '4360', skr04: '6400' },
  { key: 'sonstiges', label: 'Sonstiges', skr03: '4900', skr04: '6300' },
  // nur bei Vereinen zur Auswahl (Konten an SKR03/04 angelehnt – mit der Kanzlei abstimmen, bei SKR49 abweichend)
  { key: 'vereinsbetrieb', label: 'Sport-/Übungsbetrieb: Geräte, Ausrüstung, Noten', skr03: '4980', skr04: '6850', association: true },
  { key: 'uebungsleiter', label: 'Trainer, Übungsleiter & Dirigenten', skr03: '4190', skr04: '6030', association: true },
  { key: 'halle', label: 'Hallen-, Platz- & Raummiete', skr03: '4210', skr04: '6310', association: true },
  { key: 'spielbetrieb', label: 'Wettkampf & Spielbetrieb: Startgelder, Schiedsrichter', skr03: '4980', skr04: '6850', association: true },
  { key: 'verband', label: 'Verbandsbeiträge, GEMA & Abgaben', skr03: '4380', skr04: '6420', association: true },
  { key: 'bewirtung', label: 'Getränke & Speisen (Einkauf für Verkauf)', skr03: '3200', skr04: '5200', association: true },
  { key: 'veranstaltung', label: 'Veranstaltungen & Feste', skr03: '4900', skr04: '6300', association: true },
  { key: 'vereinsheim', label: 'Vereinsheim: Instandhaltung & Nebenkosten', skr03: '4260', skr04: '6335', association: true },
  { key: 'jugend', label: 'Jugendarbeit', skr03: '4900', skr04: '6300', association: true },
  { key: 'ehrungen', label: 'Ehrungen, Geschenke & Mitgliederpflege', skr03: '4900', skr04: '6300', association: true },
] as const satisfies readonly Category[];

export type ExpenseCategory = (typeof EXPENSE_CATEGORIES)[number]['key'];

/** Kostenarten zur Auswahl: Vereine bekommen zusätzlich ihre eigenen (oben einsortiert) */
export function categoriesFor(t: Pick<Tenant, 'org_type'>): readonly Category[] {
  const all = EXPENSE_CATEGORIES as readonly Category[];
  if (t.org_type !== 'association') return all.filter((c) => !c.association);
  return [...all.filter((c) => c.association), ...all.filter((c) => !c.association)];
}
export const DEFAULT_CATEGORY: ExpenseCategory = 'sonstiges';

export function isExpenseCategory(v: string): v is ExpenseCategory {
  return EXPENSE_CATEGORIES.some((c) => c.key === v);
}

export function categoryLabel(key: string): string {
  return EXPENSE_CATEGORIES.find((c) => c.key === key)?.label ?? key;
}

/** Aufwandskonten des Mandanten (Standard je SKR, überschrieben durch die Einstellungen) */
export function expenseAccounts(t: Pick<Tenant, 'datev_skr' | 'datev_expense_accounts'>): Record<string, string> {
  const skr = t.datev_skr === '04' ? 'skr04' : 'skr03';
  const accounts: Record<string, string> = Object.fromEntries(EXPENSE_CATEGORIES.map((c) => [c.key, c[skr]]));
  for (const part of (t.datev_expense_accounts ?? '').split(',')) {
    const [k, v] = part.split('=').map((x) => x.trim().toLowerCase());
    if (k && v && k in accounts && /^\d+$/.test(v)) accounts[k] = v;
  }
  return accounts;
}

/** Hinweis für die Einstellungen: "ware=3200, fremd=3100, …" */
export function expenseAccountHint(skr: '03' | '04'): string {
  return EXPENSE_CATEGORIES.map((c) => `${c.label} ${skr === '04' ? c.skr04 : c.skr03}`).join(', ');
}
