import { formatDate } from '../../lib/dates.ts';
import type { Tenant } from '../../types.ts';
import type { Contact } from '../contacts.ts';

/**
 * Zuwendungsbestätigungen nach amtlichem Muster (§ 50 Abs. 1 EStDV, BMF-Schreiben vom 7.11.2013,
 * BStBl I S. 1333) für steuerbegünstigte Körperschaften im Sinne des § 5 Abs. 1 Nr. 9 KStG:
 *   - Anlage 3:  Bestätigung über Geldzuwendungen/Mitgliedsbeitrag
 *   - Anlage 4:  Bestätigung über Sachzuwendungen
 *   - Anlage 14: Sammelbestätigung über Geldzuwendungen/Mitgliedsbeiträge
 * Wortwahl und Reihenfolge der Textpassagen sind verbindlich – nicht zutreffende Passagen
 * (z. B. die jeweils andere Bescheid-Variante) dürfen entfallen.
 */
export type ReceiptKind = 'single' | 'collective' | 'goods';
export type DonationKind = 'money' | 'membership' | 'goods';
export type GoodsOrigin = '' | 'business' | 'private' | 'unknown';

export const DONATION_KINDS: Record<DonationKind, string> = {
  money: 'Geldzuwendung',
  membership: 'Mitgliedsbeitrag',
  goods: 'Sachzuwendung',
};

export interface ReceiptItem {
  date: string;
  kind: 'money' | 'membership';
  waiver: boolean;
  amount: number;
}

export interface ReceiptData {
  version: 1;
  kind: ReceiptKind;
  number: string;
  issueDate: string;
  issuer: { name: string; street: string; zip: string; city: string };
  donor: string[];
  total: number;
  /** Tag der Zuwendung (Einzel- und Sachbestätigung) */
  date?: string;
  /** Zeitraum der Sammelbestätigung */
  periodFrom?: string;
  periodTo?: string;
  /** Verzicht auf Erstattung von Aufwendungen (Einzelbestätigung) */
  waiver?: boolean;
  goods?: { description: string; origin: GoodsOrigin; documents: boolean };
  notice: { type: 'exemption' | 'assessment'; taxOffice: string; taxNumber: string; date: string; period: string };
  purposes: string;
  /** Bestätigung „kein Mitgliedsbeitrag, dessen Abzug ausgeschlossen ist“ (nur bei nicht abziehbaren Beiträgen) */
  membershipNotDeductible: boolean;
  signer: string;
  items?: ReceiptItem[];
}

export const TEXT = {
  issuerLabel: 'Aussteller (Bezeichnung und Anschrift der steuerbegünstigten Einrichtung)',
  basis: 'im Sinne des § 10b des Einkommensteuergesetzes an eine der in § 5 Abs. 1 Nr. 9 des Körperschaftsteuergesetzes bezeichneten Körperschaften, Personenvereinigungen oder Vermögensmassen',
  titles: {
    single: 'Bestätigung über Geldzuwendungen/Mitgliedsbeitrag',
    goods: 'Bestätigung über Sachzuwendungen',
    collective: 'Sammelbestätigung über Geldzuwendungen/Mitgliedsbeiträge',
  } satisfies Record<ReceiptKind, string>,
  donor: 'Name und Anschrift des Zuwendenden:',
  amount: { single: 'Betrag der Zuwendung', goods: 'Wert der Zuwendung', collective: 'Gesamtbetrag der Zuwendung' } satisfies Record<ReceiptKind, string>,
  digits: '- in Ziffern -',
  letters: '- in Buchstaben -',
  date: 'Tag der Zuwendung:',
  period: 'Zeitraum der Sammelbestätigung:',
  waiver: 'Es handelt sich um den Verzicht auf Erstattung von Aufwendungen',
  goodsDescription: 'Genaue Bezeichnung der Sachzuwendung mit Alter, Zustand, Kaufpreis usw.',
  goodsOrigin: {
    business: 'Die Sachzuwendung stammt nach den Angaben des Zuwendenden aus dem Betriebsvermögen. Die Zuwendung ist mit dem Entnahmewert (ggf. mit dem niedrigeren gemeinen Wert) bewertet.',
    private: 'Die Sachzuwendung stammt nach den Angaben des Zuwendenden aus dem Privatvermögen.',
    unknown: 'Der Zuwendende hat trotz Aufforderung keine Angaben zur Herkunft der Sachzuwendung gemacht.',
  },
  goodsDocuments: 'Geeignete Unterlagen, die zur Wertermittlung gedient haben, z. B. Rechnung, Gutachten, liegen vor.',
  membershipLabel: 'Nur für steuerbegünstigte Einrichtungen, bei denen die Mitgliedsbeiträge steuerlich nicht abziehbar sind:',
  membership: 'Es wird bestätigt, dass es sich nicht um einen Mitgliedsbeitrag handelt, dessen Abzug nach § 10b Abs. 1 des Einkommensteuergesetzes ausgeschlossen ist.',
  noOther: 'Es wird bestätigt, dass über die in der Gesamtsumme enthaltenen Zuwendungen keine weiteren Bestätigungen, weder formelle Zuwendungsbestätigungen noch Beitragsquittungen oder ähnliches ausgestellt wurden und werden.',
  waiverInAnnex: 'Ob es sich um den Verzicht auf Erstattung von Aufwendungen handelt, ist der Anlage zur Sammelbestätigung zu entnehmen.',
  signature: '(Ort, Datum und Unterschrift des Zuwendungsempfängers)',
  hintTitle: 'Hinweis:',
  hint1: 'Wer vorsätzlich oder grob fahrlässig eine unrichtige Zuwendungsbestätigung erstellt oder veranlasst, dass Zuwendungen nicht zu den in der Zuwendungsbestätigung angegebenen steuerbegünstigten Zwecken verwendet werden, haftet für die entgangene Steuer (§ 10b Abs. 4 EStG, § 9 Abs. 3 KStG, § 9 Nr. 5 GewStG).',
  hint2: 'Diese Bestätigung wird nicht als Nachweis für die steuerliche Berücksichtigung der Zuwendung anerkannt, wenn das Datum des Freistellungsbescheides länger als 5 Jahre bzw. das Datum der Feststellung der Einhaltung der satzungsmäßigen Voraussetzungen nach § 60a Abs. 1 AO länger als 3 Jahre seit Ausstellung des Bescheides zurückliegt (§ 63 Abs. 5 AO).',
  annexTitle: 'Anlage zur Sammelbestätigung',
  annexCols: ['Datum der Zuwendung', 'Art der Zuwendung (Geldzuwendung/Mitgliedsbeitrag)', 'Verzicht auf die Erstattung von Aufwendungen (ja/nein)', 'Betrag'],
  annexTotal: 'Gesamtsumme',
};

/** Absatz zum Freistellungsbescheid bzw. zur Feststellung nach § 60a AO */
export function noticeText(d: Pick<ReceiptData, 'notice' | 'purposes'>): string {
  const n = d.notice;
  if (n.type === 'assessment') {
    return `Die Einhaltung der satzungsmäßigen Voraussetzungen nach den §§ 51, 59, 60 und 61 AO wurde vom Finanzamt ${n.taxOffice} StNr. ${n.taxNumber} `
      + `mit Bescheid vom ${formatDate(n.date)} nach § 60a AO gesondert festgestellt. Wir fördern nach unserer Satzung (Förderung ${d.purposes}).`;
  }
  return `Wir sind wegen Förderung ${d.purposes} nach dem Freistellungsbescheid bzw. nach der Anlage zum Körperschaftsteuerbescheid des Finanzamtes `
    + `${n.taxOffice} StNr. ${n.taxNumber} vom ${formatDate(n.date)} für den letzten Veranlagungszeitraum ${n.period} nach § 5 Abs. 1 Nr. 9 des `
    + 'Körperschaftsteuergesetzes von der Körperschaftsteuer und nach § 3 Nr. 6 des Gewerbesteuergesetzes von der Gewerbesteuer befreit.';
}

export const purposeText = (d: Pick<ReceiptData, 'purposes'>) => `Es wird bestätigt, dass die Zuwendung nur zur Förderung ${d.purposes} verwendet wird.`;

/** Bis wann Bestätigungen mit diesem Bescheid anerkannt werden (§ 63 Abs. 5 AO) */
export function noticeValidUntil(t: Pick<Tenant, 'npo_notice' | 'npo_notice_date'>): string | null {
  if (!t.npo_notice_date) return null;
  const years = t.npo_notice === 'assessment' ? 3 : 5;
  const [y, m, d] = t.npo_notice_date.split('-').map(Number);
  // gleicher Kalendertag n Jahre später (29.2. → 28.2.)
  const target = new Date(Date.UTC(y + years, m - 1, d));
  if (target.getUTCMonth() !== m - 1) target.setUTCDate(0);
  return target.toISOString().slice(0, 10);
}

/** Fehlende oder abgelaufene Angaben, ohne die keine Bestätigung ausgestellt werden darf */
export function receiptProblems(t: Tenant, issueDate: string): string[] {
  const p: string[] = [];
  if (!t.nonprofit) p.push('Der Mandant ist nicht als gemeinnützig eingestellt.');
  if (!t.name || !t.street || !t.zip || !t.city) p.push('Name und Anschrift des Vereins fehlen.');
  if (!t.npo_purposes) p.push('Die begünstigten Zwecke fehlen.');
  if (!t.npo_tax_office) p.push('Das Finanzamt fehlt.');
  if (!t.tax_number) p.push('Die Steuernummer fehlt.');
  if (!t.npo_notice_date) p.push('Das Datum des Bescheids fehlt.');
  if (t.npo_notice === 'exemption' && !t.npo_notice_period) p.push('Der letzte Veranlagungszeitraum des Freistellungsbescheids fehlt.');
  const valid = noticeValidUntil(t);
  if (valid && issueDate > valid) {
    p.push(`Der Bescheid vom ${formatDate(t.npo_notice_date)} ist zu alt (§ 63 Abs. 5 AO: ${t.npo_notice === 'assessment' ? '3' : '5'} Jahre) – Bestätigungen würden nicht anerkannt. Bitte den aktuellen Bescheid eintragen.`);
  }
  if (t.npo_notice_date && issueDate < t.npo_notice_date) p.push('Das Ausstellungsdatum liegt vor dem Datum des Bescheids.');
  return p;
}

export function donorLines(c: Pick<Contact, 'company' | 'name' | 'street' | 'address_extra' | 'zip' | 'city' | 'country'>): string[] {
  return [
    c.company, c.name, c.street, c.address_extra, [c.zip, c.city].filter(Boolean).join(' '),
    c.country && c.country !== 'DE' ? c.country : '',
  ].filter(Boolean);
}

/** Gemeinsame Angaben aus den Einstellungen */
export function receiptBase(t: Tenant): Pick<ReceiptData, 'issuer' | 'notice' | 'purposes' | 'membershipNotDeductible' | 'signer'> {
  return {
    issuer: { name: t.name, street: t.street, zip: t.zip, city: t.city },
    notice: {
      type: t.npo_notice === 'assessment' ? 'assessment' : 'exemption',
      taxOffice: t.npo_tax_office,
      taxNumber: t.tax_number,
      date: t.npo_notice_date ?? '',
      period: t.npo_notice_period,
    },
    purposes: t.npo_purposes,
    membershipNotDeductible: !t.npo_membership_deductible,
    signer: t.npo_signer,
  };
}

/** Zeitraum-Text, z. B. „01.01.2026 – 31.12.2026“ */
export const periodText = (from: string, to: string) => `${formatDate(from)} – ${formatDate(to)}`;

export const yearRange = (year: number) => ({ from: `${year}-01-01`, to: `${year}-12-31` });

