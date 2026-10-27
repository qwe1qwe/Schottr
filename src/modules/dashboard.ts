import { all, one } from '../db/index.ts';
import { html } from '../lib/html.ts';
import { today } from '../lib/dates.ts';
import { formatMoney } from '../lib/money.ts';
import { tenantOf } from '../lib/http.ts';
import { page } from '../views/layout.ts';
import { tenantProblems } from './settings.ts';
import { documentTable } from './documents/views.ts';
import { invitationsBox, pendingInvitations } from './invitations.ts';
import { userOf } from '../lib/http.ts';
import type { Module } from '../types.ts';

export const dashboardModule: Module = {
  name: 'dashboard',
  nav: { label: 'Übersicht', href: '/', order: 0 },
  register(app) {
    app.get('/', async (c) => {
      const t = tenantOf(c);
      const d = today();
      const year = d.slice(0, 4);
      const stat = async (sql: string, ...p: (string | number)[]) => (await one<{ n: number; s: number }>(sql, t.id, ...p)) ?? { n: 0, s: 0 };
      const open = await stat("SELECT COUNT(*) n, COALESCE(SUM(gross_total), 0) s FROM documents WHERE tenant_id = ? AND kind = 'invoice' AND status = 'open'");
      const overdue = await stat("SELECT COUNT(*) n, COALESCE(SUM(gross_total), 0) s FROM documents WHERE tenant_id = ? AND kind = 'invoice' AND status = 'open' AND due_date < ?", d);
      const quotes = await stat("SELECT COUNT(*) n, COALESCE(SUM(gross_total), 0) s FROM documents WHERE tenant_id = ? AND kind = 'quote' AND status IN ('draft', 'sent')");
      const revenue = await stat(
        `SELECT COUNT(*) n, COALESCE(SUM(CASE WHEN type_code = '381' THEN -net_total ELSE net_total END), 0) s
         FROM documents WHERE tenant_id = ? AND kind = 'invoice' AND finalized_at IS NOT NULL AND substr(issue_date, 1, 4) = ?`,
        year,
      );
      const drafts = await all(
        `SELECT d.*, COALESCE(NULLIF(c.company, ''), c.name) contact_label FROM documents d JOIN contacts c ON c.id = d.contact_id
         WHERE d.tenant_id = ? AND d.kind = 'invoice' AND d.status = 'draft' ORDER BY d.updated_at DESC LIMIT 10`, t.id,
      );
      const openList = await all(
        `SELECT d.*, COALESCE(NULLIF(c.company, ''), c.name) contact_label,
           (SELECT MAX(level) FROM dunnings x WHERE x.invoice_id = d.id) AS dunning_level
         FROM documents d JOIN contacts c ON c.id = d.contact_id
         WHERE d.tenant_id = ? AND d.kind = 'invoice' AND d.status = 'open' ORDER BY d.due_date LIMIT 10`, t.id,
      );
      const problems = tenantProblems(t);
      const invites = await pendingInvitations(userOf(c).email);
      return page(c, {
        title: 'Übersicht',
        actions: html`<a class="btn" href="/quotes/new">Neues Angebot</a><a class="btn primary" href="/invoices/new">Neue Rechnung</a>`,
        body: html`
        ${invitationsBox(c, invites)}
        ${problems.length
          ? html`<div class="notice">Deine Firmendaten sind noch unvollständig – es fehlen: ${problems.join(", ")}. <a href="/settings">Jetzt ergänzen</a></div>`
          : ''}
        <div class="stats">
          <a class="stat" href="/invoices?status=open"><span>Offene Rechnungen</span><strong>${formatMoney(open.s)}</strong><small>${open.n} Beleg(e)</small></a>
          <a class="stat ${overdue.n ? 'alert' : ''}" href="/dunning"><span>Überfällig</span><strong>${formatMoney(overdue.s)}</strong><small>${overdue.n} Beleg(e)</small></a>
          <a class="stat" href="/quotes?status=sent"><span>Offene Angebote</span><strong>${formatMoney(quotes.s)}</strong><small>${quotes.n} Beleg(e)</small></a>
          <div class="stat"><span>Umsatz ${year} (netto)</span><strong>${formatMoney(revenue.s)}</strong><small>${revenue.n} Rechnung(en)</small></div>
        </div>
        ${drafts.length ? html`<h2 class="section-title">Rechnungsentwürfe</h2>${documentTable(drafts, 'invoice')}` : ''}
        <h2 class="section-title">Offene Rechnungen</h2>
        ${openList.length ? documentTable(openList, 'invoice') : html`<p class="muted">Keine offenen Rechnungen. 🎉</p>`}`,
      });
    });
  },
};
