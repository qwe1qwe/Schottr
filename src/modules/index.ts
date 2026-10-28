import type { Module } from '../types.ts';
import { authModule } from './auth.ts';
import { dashboardModule } from './dashboard.ts';
import { contactsModule } from './contacts.ts';
import { quotesModule, invoicesModule } from './documents/routes.ts';
import { settingsModule } from './settings.ts';
import { articlesModule } from './articles.ts';
import { dunningModule } from './dunning.ts';
import { invitationsModule } from './invitations.ts';
import { adminModule } from './admin.ts';
import { exportModule } from './export.ts';
import { proofsModule } from './proofs.ts';
import { correctionModule } from './documents/correction.ts';
import { purchasesModule } from './purchases/routes.ts';
import { donationsModule } from './donations/routes.ts';
import { cashbookModule } from './cashbook/routes.ts';

/**
 * Alle aktiven Module. Ein neues Modul (z. B. Zeiterfassung)
 * exportiert ein `Module`-Objekt und wird hier eingetragen; eigene Tabellen kommen
 * als neue Migration in src/db/migrations.ts dazu.
 */
export const modules: Module[] = [
  authModule,
  dashboardModule,
  contactsModule,
  articlesModule,
  quotesModule,
  invoicesModule,
  correctionModule,
  purchasesModule,
  proofsModule,
  donationsModule,
  cashbookModule,
  dunningModule,
  exportModule,
  invitationsModule,
  settingsModule,
  adminModule,
];
