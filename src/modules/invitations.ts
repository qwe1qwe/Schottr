import { all, one, run, tx, nowIso } from '../db/index.ts';
import { setSessionTenant } from '../lib/auth.ts';
import { html, type SafeHtml } from '../lib/html.ts';
import { idParam, notFound, readForm, redirectWith, requireOwner, str, tenantOf, userOf } from '../lib/http.ts';
import { csrfField, page } from '../views/layout.ts';
import { emailSchema } from './auth.ts';
import { audit } from '../lib/audit.ts';
import type { App, Ctx, Module } from '../types.ts';

/**
 * Einladungen in einen Mandanten – rein portalintern, ohne E-Mail-Versand.
 * Ein Inhaber lädt eine E-Mail-Adresse ein; wer mit genau dieser Adresse angemeldet ist,
 * sieht die Einladung in der Übersicht und kann sie annehmen oder ablehnen.
 */
export interface PendingInvitation {
  id: number;
  tenant_name: string;
  role: 'owner' | 'member';
  inviter: string | null;
  created_at: string;
}

export async function pendingInvitations(email: string): Promise<PendingInvitation[]> {
  return all<PendingInvitation>(
    `SELECT i.id, t.name AS tenant_name, i.role, COALESCE(NULLIF(u.name, ''), u.email) AS inviter, i.created_at
     FROM invitations i JOIN tenants t ON t.id = i.tenant_id LEFT JOIN users u ON u.id = i.invited_by
     WHERE i.email = ? AND i.status = 'pending' ORDER BY i.created_at`,
    email,
  );
}

/** Kasten mit offenen Einladungen (für Übersicht und Einladungsseite). */
export function invitationsBox(c: Ctx, list: PendingInvitation[]): SafeHtml {
  if (!list.length) return html``;
  return html`<section class="card invite-box">
    <h2>${list.length === 1 ? 'Du wurdest eingeladen' : `Du hast ${list.length} Einladungen`}</h2>
    <ul class="plain">${list.map((i) => html`<li class="invite">
      <div><strong>${i.tenant_name}</strong>
        <div class="muted small">als ${i.role === 'owner' ? 'Inhaber' : 'Mitglied'}${i.inviter ? ` · eingeladen von ${i.inviter}` : ''}</div></div>
      <div class="actions">
        <form method="post" action="/invitations/${i.id}/decline" class="inline" data-confirm="Einladung ablehnen?">${csrfField(c)}<button class="btn ghost">Ablehnen</button></form>
        <form method="post" action="/invitations/${i.id}/accept" class="inline">${csrfField(c)}<button class="btn primary">Annehmen</button></form>
      </div></li>`)}
    </ul></section>`;
}

async function ownInvitation(c: Ctx) {
  const user = userOf(c);
  const inv = await one('SELECT * FROM invitations WHERE id = ? AND email = ? AND status = ?', idParam(c), user.email, 'pending');
  return inv ?? notFound();
}

function register(app: App) {
  // Einladen (Inhaber)
  app.post('/settings/invitations', async (c) => {
    requireOwner(c);
    const t = tenantOf(c);
    const form = await readForm(c);
    const email = str(form, 'email', 200).toLowerCase();
    const role = str(form, 'role') === 'owner' ? 'owner' : 'member';
    if (!emailSchema.safeParse(email).success) return redirectWith(c, '/settings/users', 'error', 'Ungültige E-Mail-Adresse.');
    const member = await one(
      'SELECT 1 FROM memberships m JOIN users u ON u.id = m.user_id WHERE m.tenant_id = ? AND u.email = ?', t.id, email,
    );
    if (member) return redirectWith(c, '/settings/users', 'error', 'Diese Person gehört bereits zu diesem Mandanten.');
    if (await one("SELECT 1 FROM invitations WHERE tenant_id = ? AND email = ? AND status = 'pending'", t.id, email)) {
      return redirectWith(c, '/settings/users', 'error', 'Für diese E-Mail-Adresse gibt es bereits eine offene Einladung.');
    }
    await run(
      'INSERT INTO invitations (tenant_id, email, role, invited_by, created_at) VALUES (?, ?, ?, ?, ?)',
      t.id, email, role, userOf(c).id, nowIso(),
    );
    await audit(c, 'member.invite', `${email} als ${role === 'owner' ? 'Inhaber' : 'Mitglied'}`);
    return redirectWith(c, '/settings/users', 'ok', `${email} wurde eingeladen. Die Einladung erscheint nach der Anmeldung in der Übersicht.`);
  });

  app.post('/settings/invitations/:id/revoke', async (c) => {
    requireOwner(c);
    const t = tenantOf(c);
    await run(
      "UPDATE invitations SET status = 'revoked', responded_at = ? WHERE id = ? AND tenant_id = ? AND status = 'pending'",
      nowIso(), idParam(c), t.id,
    );
    return redirectWith(c, '/settings/users', 'ok', 'Einladung zurückgezogen.');
  });

  // Eigene Einladungen (auch ohne aktiven Mandanten erreichbar)
  app.get('/invitations', async (c) => {
    const list = await pendingInvitations(userOf(c).email);
    return page(c, {
      title: 'Einladungen',
      body: html`
        ${list.length ? invitationsBox(c, list) : html`<p class="muted">Keine offenen Einladungen.</p>`}
        ${c.get('tenant')
          ? ''
          : html`<section class="card narrow"><h2>Noch keinem Mandanten zugeordnet</h2>
              <p class="muted">Nimm eine Einladung an oder lege deine eigene Firma als Mandanten an.</p>
              <a class="btn" href="/tenants/new">Eigenen Mandanten anlegen</a></section>`}`,
    });
  });

  app.post('/invitations/:id/accept', async (c) => {
    const user = userOf(c);
    const inv = await ownInvitation(c);
    await tx(async () => {
      await run('INSERT IGNORE INTO memberships (user_id, tenant_id, role) VALUES (?, ?, ?)', user.id, inv.tenant_id, inv.role);
      await run("UPDATE invitations SET status = 'accepted', responded_at = ? WHERE id = ?", nowIso(), inv.id);
    });
    await setSessionTenant(c.get('session')!.id, inv.tenant_id);
    await audit(c, 'member.accept', `als ${inv.role === 'owner' ? 'Inhaber' : 'Mitglied'}`, { tenantId: inv.tenant_id });
    const t = await one('SELECT name FROM tenants WHERE id = ?', inv.tenant_id);
    return redirectWith(c, '/', 'ok', `Willkommen bei ${t?.name ?? 'deinem neuen Mandanten'}! Du arbeitest jetzt in diesem Mandanten.`);
  });

  app.post('/invitations/:id/decline', async (c) => {
    const inv = await ownInvitation(c);
    await run("UPDATE invitations SET status = 'declined', responded_at = ? WHERE id = ?", nowIso(), inv.id);
    return redirectWith(c, c.get('tenant') ? '/' : '/invitations', 'ok', 'Einladung abgelehnt.');
  });
}

export const invitationsModule: Module = { name: 'invitations', register };
