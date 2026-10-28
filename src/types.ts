import type { Context, Hono } from 'hono';
import type { Session } from './lib/auth.ts';

export interface User {
  id: number;
  email: string;
  name: string;
  /** Systemweiter Administrator (übergreifende Administration) */
  is_admin: number;
}

export interface Tenant {
  id: number;
  name: string;
  contact_name: string;
  street: string;
  zip: string;
  city: string;
  country: string;
  email: string;
  phone: string;
  website: string;
  vat_id: string;
  tax_number: string;
  register_court: string;
  register_number: string;
  managing_directors: string;
  bank_name: string;
  iban: string;
  bic: string;
  small_business: number;
  /** Unternehmen oder Verein */
  org_type: 'company' | 'association';
  /** steuerbegünstigt nach §§ 51 ff. AO (gemeinnützig) */
  nonprofit: number;
  /** Vorgabe für den Tätigkeitsbereich neuer Rechnungen (siehe lib/nonprofit.ts) */
  default_sphere: string;
  /** Zuwendungsbestätigungen: begünstigte Zwecke (wird hinter „Förderung“ eingesetzt) */
  npo_purposes: string;
  /** Freistellungsbescheid bzw. Anlage zum KSt-Bescheid oder Feststellung nach § 60a AO */
  npo_notice: 'exemption' | 'assessment';
  npo_tax_office: string;
  npo_notice_date: string | null;
  /** letzter Veranlagungszeitraum laut Freistellungsbescheid */
  npo_notice_period: string;
  /** Mitgliedsbeiträge abziehbar? (nicht z. B. bei Sport, § 10b Abs. 1 Satz 8 EStG) */
  npo_membership_deductible: number;
  npo_signer: string;
  donation_receipt_number_format: string;
  payment_days: number;
  quote_valid_days: number;
  quote_number_format: string;
  invoice_number_format: string;
  customer_number_format: string;
  quote_intro: string;
  quote_outro: string;
  invoice_intro: string;
  invoice_outro: string;
  dunning_fee_1: number;
  dunning_fee_2: number;
  dunning_fee_3: number;
  dunning_deadline_days: number;
  dunning_interval_days: number;
  disabled: number;
  skonto_percent: number;
  skonto_days: number;
  datev_consultant: string;
  datev_client: string;
  datev_skr: string;
  datev_account_length: number;
  datev_debtor_mode: 'collective' | 'individual';
  datev_debtor_account: number;
  datev_accounts: string;
  supplier_number_format: string;
  datev_creditor_mode: 'collective' | 'individual';
  datev_creditor_account: number;
  datev_expense_accounts: string;
}

export type Role = 'owner' | 'member';

export type AppEnv = {
  Variables: {
    session: Session | null;
    user: User | null;
    tenant: Tenant | null;
    role: Role | null;
    tenants: { id: number; name: string }[];
  };
};

export type Ctx = Context<AppEnv>;
export type App = Hono<AppEnv>;

/**
 * Ein Modul bringt eigene Routen und optional einen Menüeintrag mit.
 * Neue Funktionen (z. B. Zeiterfassung, Mahnwesen) werden als weiteres Modul
 * in src/modules/index.ts eingetragen.
 */
export interface Module {
  name: string;
  /** visible: Menüeintrag nur für passende Mandanten zeigen (z. B. Spenden nur bei gemeinnützigen) */
  nav?: { label: string; href: string; order: number; visible?: (t: Tenant) => boolean };
  register(app: App): void;
}
