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
  nav?: { label: string; href: string; order: number };
  register(app: App): void;
}
