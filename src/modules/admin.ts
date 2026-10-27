import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { all, one, run, tx, nowIso, fromDbTime } from '../db/index.ts';
import { hashPassword, setSessionTenant } from '../lib/auth.ts';
import { audit, getSetting, recentAudit, setSetting } from '../lib/audit.ts';
import { html, checked, selected, type SafeHtml } from '../lib/html.ts';
import { idParam, notFound, readForm, redirectWith, str, userOf } from '../lib/http.ts';
import { formatMoney } from '../lib/money.ts';
import { csrfField, page, empty } from '../views/layout.ts';
import { config } from '../config.ts';
import { createTenant, emailSchema, passwordSchema } from './auth.ts';
import type { App, Ctx, Module } from '../types.ts';

/**
 * Übergreifende Administration – über allen Mandanten.
 * Zugriff nur für Benutzer mit is_admin (Prüfung zentral in app.ts für /admin/*).
 * Der erste registrierte Benutzer ist automatisch Administrator.
 */

const pkg = JSON.parse(
  fs.readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), '../../package.json'), 'utf8'),
) as { version: string };

const dt = (v: string | null | undefined) =>
  v ? fromDbTime(v).toLocaleString('de-DE', { timeZone: 'Europe/Berlin', dateStyle: 'short', timeStyle: 'short' }) : '–';

const ACTIONS: Record<string, string> = {
  'login.success': 'Anmeldung',
  'user.register': 'Registrierung',
  'login.failed': 'Fehlgeschlagene Anmeldung',
  'login.disabled': 'Anmeldung gesperrtes Konto',
  'invoice.finalize': 'Rechnung festgeschrieben',
  'invoice.cancel': 'Rechnung storniert',
  'invoice.reopen': 'Rechnung nachträglich geöffnet',
  'invoice.refinalize': 'Rechnung erneut festgeschrieben',
  'settings.update': 'Firmendaten geändert',
  'member.invite': 'Benutzer eingeladen',
  'member.accept': 'Einladung angenommen',
  'member.remove': 'Benutzer entfernt',
  'member.create': 'Konto angelegt',
  'settings.logo': 'Logo geändert',
  'proof.upload': 'Nachweis hochgeladen',
  'proof.delete': 'Nachweis gelöscht',
  'export.datev': 'DATEV-Export',
  'export.journal': 'Export Rechnungsausgangsbuch',
  'export.zip': 'Export Belege (ZIP)',
};
const actionLabel = (a: string) => ACTIONS[a] ?? a.replace(/^admin\./, 'Admin: ');

function tabs(c: Ctx, active: string): SafeHtml {
  const items = [
    ['/admin', 'Übersicht'], ['/admin/tenants', 'Mandanten'], ['/admin/users', 'Benutzer'],
    ['/admin/audit', 'Protokoll'], ['/admin/system', 'System'],
  ];
  return html`<nav class="tabs admin-tabs">${items.map(([href, label]) => html`<a href="${href}" class="${active === href ? 'active' : ''}">${label}</a>`)}</nav>`;
}

function adminPage(c: Ctx, active: string, opts: Parameters<typeof page>[1]) {
  return page(c, { ...opts, body: html`${tabs(c, active)}${opts.body}` });
}

async function adminCount(): Promise<number> {
  return (await one<{ n: number }>('SELECT COUNT(*) n FROM users WHERE is_admin = 1 AND disabled = 0'))!.n;
}

/** Mandanten, in denen der Benutzer der einzige Inhaber ist */
async function soleOwnerOf(userId: number) {
  return all<{ id: number; name: string }>(
    `SELECT t.id, t.name FROM memberships m JOIN tenants t ON t.id = m.tenant_id
     WHERE m.user_id = ? AND m.role = 'owner'
       AND (SELECT COUNT(*) FROM memberships o WHERE o.tenant_id = m.tenant_id AND o.role = 'owner') = 1`,
    userId,
  );
}

function register(app: App) {
  /* ---------------- Übersicht ---------------- */
  app.get('/admin', async (c) => {
    const n = async (sql: string) => (await one<{ n: number }>(sql))!.n;
    const stats = {
      tenants: await n('SELECT COUNT(*) n FROM tenants WHERE disabled = 0'),
      tenantsDisabled: await n('SELECT COUNT(*) n FROM tenants WHERE disabled = 1'),
      users: await n('SELECT COUNT(*) n FROM users WHERE disabled = 0'),
      usersDisabled: await n('SELECT COUNT(*) n FROM users WHERE disabled = 1'),
      invoices: await n("SELECT COUNT(*) n FROM documents WHERE kind = 'invoice' AND finalized_at IS NOT NULL"),
      quotes: await n("SELECT COUNT(*) n FROM documents WHERE kind = 'quote'"),
      sessions: await n('SELECT COUNT(*) n FROM sessions WHERE expires_at > UTC_TIMESTAMP(3)'),
      failed: await n("SELECT COUNT(*) n FROM audit_log WHERE action = 'login.failed' AND created_at > UTC_TIMESTAMP(3) - INTERVAL 1 DAY"),
    };
    const orphaned = await all<{ id: number; name: string }>(
      `SELECT t.id, t.name FROM tenants t WHERE NOT EXISTS
        (SELECT 1 FROM memberships m JOIN users u ON u.id = m.user_id WHERE m.tenant_id = t.id AND m.role = 'owner' AND u.disabled = 0)`,
    );
    return adminPage(c, '/admin', {
      title: 'Administration',
      body: html`
      ${orphaned.length
        ? html`<div class="notice">Ohne aktiven Inhaber: ${orphaned.map((t, i) => html`${i ? ', ' : ''}<a href="/admin/tenants/${t.id}">${t.name}</a>`)}</div>`
        : ''}
      <div class="stats">
        <a class="stat" href="/admin/tenants"><span>Mandanten</span><strong>${stats.tenants}</strong><small>${stats.tenantsDisabled} gesperrt</small></a>
        <a class="stat" href="/admin/users"><span>Benutzer</span><strong>${stats.users}</strong><small>${stats.usersDisabled} gesperrt · ${stats.sessions} aktive Sitzungen</small></a>
        <div class="stat"><span>Belege</span><strong>${stats.invoices}</strong><small>Rechnungen festgeschrieben · ${stats.quotes} Angebote</small></div>
        <a class="stat ${stats.failed > 10 ? 'alert' : ''}" href="/admin/audit?action=login.failed"><span>Fehlversuche (24 h)</span><strong>${stats.failed}</strong><small>fehlgeschlagene Anmeldungen</small></a>
      </div>
      <h2 class="section-title">Letzte Ereignisse</h2>
      ${auditTable(await recentAudit({ limit: 15 }))}
      <p><a href="/admin/audit">Gesamtes Protokoll</a></p>`,
    });
  });

  /* ---------------- Mandanten ---------------- */
  app.get('/admin/tenants', async (c) => {
    const q = (c.req.query('q') ?? '').trim().slice(0, 100);
    const rows = await all(
      `SELECT t.*, (SELECT COUNT(*) FROM memberships m WHERE m.tenant_id = t.id) AS members,
         (SELECT COUNT(*) FROM documents d WHERE d.tenant_id = t.id AND d.kind = 'invoice' AND d.finalized_at IS NOT NULL) AS invoices,
         (SELECT MAX(d.issue_date) FROM documents d WHERE d.tenant_id = t.id AND d.kind = 'invoice') AS last_invoice,
         (SELECT GROUP_CONCAT(u.email ORDER BY u.email SEPARATOR ', ') FROM memberships m JOIN users u ON u.id = m.user_id
           WHERE m.tenant_id = t.id AND m.role = 'owner') AS owners
       FROM tenants t WHERE (? = '' OR t.name LIKE ?) ORDER BY t.disabled, t.name LIMIT 1000`,
      q, `%${q}%`,
    );
    return adminPage(c, '/admin/tenants', {
      title: 'Mandanten',
      actions: html`<a class="btn primary" href="/admin/tenants/new">Neuer Mandant</a>`,
      body: html`
      <form class="toolbar" method="get"><input type="search" name="q" value="${q}" placeholder="Suchen …" aria-label="Suchen"></form>
      ${rows.length
        ? html`<div class="card flush"><table class="table">
          <thead><tr><th>Name</th><th>Inhaber</th><th class="right">Benutzer</th><th class="right">Rechnungen</th><th>Letzte Rechnung</th><th>Angelegt</th></tr></thead>
          <tbody>${rows.map((t) => html`<tr class="rowlink" data-href="/admin/tenants/${t.id}">
            <td><a href="/admin/tenants/${t.id}">${t.name}</a> ${t.disabled ? html`<span class="badge badge-cancelled">gesperrt</span>` : ''}</td>
            <td class="small">${t.owners ?? html`<span class="tag">kein Inhaber</span>`}</td>
            <td class="right num">${t.members}</td><td class="right num">${t.invoices}</td>
            <td>${t.last_invoice ? String(t.last_invoice).split('-').reverse().join('.') : '–'}</td>
            <td>${dt(t.created_at)}</td></tr>`)}
          </tbody></table></div>`
        : empty('Keine Mandanten gefunden.')}`,
    });
  });

  app.get('/admin/tenants/new', async (c) =>
    adminPage(c, '/admin/tenants', {
      title: 'Neuer Mandant',
      back: { href: '/admin/tenants', label: 'Mandanten' },
      body: html`<form method="post" action="/admin/tenants" class="card narrow stack">
        ${csrfField(c)}
        <label>Firmenname <input name="name" required maxlength="200"></label>
        <label>Inhaber (E-Mail eines bestehenden Kontos) <input type="email" name="owner" required></label>
        <label class="check"><input type="checkbox" name="small_business" value="1"> Kleinunternehmer nach § 19 UStG</label>
        <button class="btn primary">Anlegen</button>
      </form>`,
    }),
  );

  app.post('/admin/tenants', async (c) => {
    const form = await readForm(c);
    const name = str(form, 'name', 200);
    const owner = await one<{ id: number }>('SELECT id FROM users WHERE email = ?', str(form, 'owner', 200).toLowerCase());
    if (!name) return redirectWith(c, '/admin/tenants/new', 'error', 'Bitte einen Namen angeben.');
    if (!owner) return redirectWith(c, '/admin/tenants/new', 'error', 'Kein Konto mit dieser E-Mail-Adresse – bitte zuerst unter „Benutzer“ anlegen.');
    const id = await tx(() => createTenant(name, owner.id, str(form, 'small_business') === '1'));
    await audit(c, 'admin.tenant.create', name, { tenantId: id });
    return redirectWith(c, `/admin/tenants/${id}`, 'ok', `Mandant „${name}“ angelegt.`);
  });

  app.get('/admin/tenants/:id', async (c) => {
    const t = (await one('SELECT * FROM tenants WHERE id = ?', idParam(c))) ?? notFound();
    const members = await all(
      `SELECT u.id, u.name, u.email, u.disabled, m.role FROM memberships m JOIN users u ON u.id = m.user_id
       WHERE m.tenant_id = ? ORDER BY m.role DESC, u.email`,
      t.id,
    );
    const count = async (sql: string) => (await one<{ n: number; s?: number }>(sql, t.id))!;
    const contacts = await count('SELECT COUNT(*) n FROM contacts WHERE tenant_id = ?');
    const quotes = await count("SELECT COUNT(*) n FROM documents WHERE tenant_id = ? AND kind = 'quote'");
    const invoices = await count(
      "SELECT COUNT(*) n, COALESCE(SUM(CASE WHEN type_code = '381' THEN -net_total ELSE net_total END), 0) s FROM documents WHERE tenant_id = ? AND kind = 'invoice' AND finalized_at IS NOT NULL",
    );
    const docsTotal = await count('SELECT COUNT(*) n FROM documents WHERE tenant_id = ?');
    const me = userOf(c);
    const isMember = members.some((m) => m.id === me.id);
    return adminPage(c, '/admin/tenants', {
      title: t.name,
      back: { href: '/admin/tenants', label: 'Mandanten' },
      body: html`
      ${t.disabled ? html`<div class="notice">Dieser Mandant ist gesperrt. Seine Benutzer können ihn nicht mehr öffnen; die Daten bleiben vollständig erhalten.</div>` : ''}
      <div class="stats">
        <div class="stat"><span>Adressen</span><strong>${contacts.n}</strong></div>
        <div class="stat"><span>Angebote</span><strong>${quotes.n}</strong></div>
        <div class="stat"><span>Rechnungen</span><strong>${invoices.n}</strong><small>Umsatz netto gesamt ${formatMoney(invoices.s ?? 0)}</small></div>
        <div class="stat"><span>Angelegt</span><strong class="small-strong">${dt(t.created_at)}</strong><small>ID ${t.id}</small></div>
      </div>

      <h2 class="section-title">Benutzer <span class="count">${members.length}</span></h2>
      <div class="card flush"><table class="table">
        <thead><tr><th>Name</th><th>E-Mail</th><th>Rolle</th><th></th></tr></thead>
        <tbody>${members.map((m) => html`<tr>
          <td><a href="/admin/users/${m.id}">${m.name || '–'}</a> ${m.disabled ? html`<span class="badge badge-cancelled">gesperrt</span>` : ''}</td>
          <td>${m.email}</td>
          <td><form method="post" action="/admin/tenants/${t.id}/members/${m.id}/role" class="inline">${csrfField(c)}
            <select name="role" data-autosubmit aria-label="Rolle">
              <option value="owner"${selected(m.role, 'owner')}>Inhaber</option><option value="member"${selected(m.role, 'member')}>Mitglied</option>
            </select></form></td>
          <td class="right"><form method="post" action="/admin/tenants/${t.id}/members/${m.id}/remove" class="inline" data-confirm="${m.email} aus ${t.name} entfernen?">${csrfField(c)}<button class="link danger">Entfernen</button></form></td>
        </tr>`)}</tbody></table></div>

      <div class="detail-grid">
        <section class="card">
          <h2>Benutzer zuordnen</h2>
          <p class="muted small">Ordnet ein bestehendes Konto direkt zu – ohne Einladung.</p>
          <form method="post" action="/admin/tenants/${t.id}/members" class="stack">
            ${csrfField(c)}
            <label>E-Mail <input type="email" name="email" required></label>
            <label>Rolle <select name="role"><option value="member">Mitglied</option><option value="owner">Inhaber</option></select></label>
            <button class="btn">Zuordnen</button>
          </form>
        </section>
        <section class="card">
          <h2>Mandant verwalten</h2>
          <form method="post" action="/admin/tenants/${t.id}/rename" class="stack">
            ${csrfField(c)}
            <label>Name <input name="name" value="${t.name}" required maxlength="200"></label>
            <button class="btn">Umbenennen</button>
          </form>
          <div class="danger-zone">
            ${isMember && !t.disabled
              ? html`<form method="post" action="/admin/tenants/${t.id}/open" class="inline">${csrfField(c)}<button class="btn">Mandant öffnen</button></form>`
              : ''}
            <form method="post" action="/admin/tenants/${t.id}/disable" class="inline" data-confirm="${t.disabled ? 'Mandant wieder freigeben?' : 'Mandant sperren? Seine Benutzer verlieren sofort den Zugriff.'}">${csrfField(c)}
              <button class="btn ${t.disabled ? '' : 'danger'}">${t.disabled ? 'Entsperren' : 'Sperren'}</button></form>
            ${docsTotal.n === 0
              ? html`<form method="post" action="/admin/tenants/${t.id}/delete" class="inline" data-confirm="Mandant „${t.name}“ endgültig löschen?">${csrfField(c)}<button class="btn danger">Löschen</button></form>`
              : html`<span class="muted small">Löschen ist nur ohne Belege möglich (Aufbewahrungspflicht) – stattdessen sperren.</span>`}
          </div>
        </section>
      </div>

      <h2 class="section-title">Protokoll dieses Mandanten</h2>
      ${auditTable(await recentAudit({ tenantId: t.id, limit: 30 }))}`,
    });
  });

  app.post('/admin/tenants/:id/members', async (c) => {
    const id = idParam(c);
    const t = (await one('SELECT id, name FROM tenants WHERE id = ?', id)) ?? notFound();
    const form = await readForm(c);
    const email = str(form, 'email', 200).toLowerCase();
    const role = str(form, 'role') === 'owner' ? 'owner' : 'member';
    const u = await one<{ id: number }>('SELECT id FROM users WHERE email = ?', email);
    if (!u) return redirectWith(c, `/admin/tenants/${id}`, 'error', 'Kein Konto mit dieser E-Mail-Adresse.');
    await run(
      'INSERT INTO memberships (user_id, tenant_id, role) VALUES (?, ?, ?) ON DUPLICATE KEY UPDATE role = VALUES(role)',
      u.id, t.id, role,
    );
    await run("UPDATE invitations SET status = 'accepted', responded_at = ? WHERE tenant_id = ? AND email = ? AND status = 'pending'", nowIso(), t.id, email);
    await audit(c, 'admin.member.add', `${email} als ${role === 'owner' ? 'Inhaber' : 'Mitglied'}`, { tenantId: t.id });
    return redirectWith(c, `/admin/tenants/${id}`, 'ok', `${email} zugeordnet.`);
  });

  app.post('/admin/tenants/:id/members/:uid/role', async (c) => {
    const id = idParam(c);
    const uid = idParam(c, 'uid');
    const role = str(await readForm(c), 'role') === 'owner' ? 'owner' : 'member';
    if (role === 'member') {
      const owners = (await one<{ n: number }>("SELECT COUNT(*) n FROM memberships WHERE tenant_id = ? AND role = 'owner' AND user_id != ?", id, uid))!.n;
      if (!owners) return redirectWith(c, `/admin/tenants/${id}`, 'error', 'Ein Mandant braucht mindestens einen Inhaber.');
    }
    await run('UPDATE memberships SET role = ? WHERE tenant_id = ? AND user_id = ?', role, id, uid);
    await audit(c, 'admin.member.role', `Benutzer ${uid} → ${role === 'owner' ? 'Inhaber' : 'Mitglied'}`, { tenantId: id });
    return redirectWith(c, `/admin/tenants/${id}`, 'ok', 'Rolle geändert.');
  });

  app.post('/admin/tenants/:id/members/:uid/remove', async (c) => {
    const id = idParam(c);
    const uid = idParam(c, 'uid');
    const m = await one('SELECT role FROM memberships WHERE tenant_id = ? AND user_id = ?', id, uid);
    if (!m) notFound();
    if (m.role === 'owner') {
      const owners = (await one<{ n: number }>("SELECT COUNT(*) n FROM memberships WHERE tenant_id = ? AND role = 'owner'", id))!.n;
      const members = (await one<{ n: number }>('SELECT COUNT(*) n FROM memberships WHERE tenant_id = ?', id))!.n;
      if (owners === 1 && members > 1) return redirectWith(c, `/admin/tenants/${id}`, 'error', 'Bitte zuerst einen anderen Inhaber bestimmen.');
    }
    await tx(async () => {
      await run('DELETE FROM memberships WHERE tenant_id = ? AND user_id = ?', id, uid);
      await run('UPDATE sessions SET tenant_id = NULL WHERE user_id = ? AND tenant_id = ?', uid, id);
    });
    await audit(c, 'admin.member.remove', `Benutzer ${uid}`, { tenantId: id });
    return redirectWith(c, `/admin/tenants/${id}`, 'ok', 'Benutzer entfernt.');
  });

  app.post('/admin/tenants/:id/rename', async (c) => {
    const id = idParam(c);
    const name = str(await readForm(c), 'name', 200);
    if (!name) return redirectWith(c, `/admin/tenants/${id}`, 'error', 'Bitte einen Namen angeben.');
    await run('UPDATE tenants SET name = ? WHERE id = ?', name, id);
    await audit(c, 'admin.tenant.rename', name, { tenantId: id });
    return redirectWith(c, `/admin/tenants/${id}`, 'ok', 'Mandant umbenannt.');
  });

  app.post('/admin/tenants/:id/disable', async (c) => {
    const t = (await one('SELECT id, disabled FROM tenants WHERE id = ?', idParam(c))) ?? notFound();
    await run('UPDATE tenants SET disabled = ? WHERE id = ?', t.disabled ? 0 : 1, t.id);
    if (!t.disabled) await run('UPDATE sessions SET tenant_id = NULL WHERE tenant_id = ?', t.id);
    await audit(c, t.disabled ? 'admin.tenant.enable' : 'admin.tenant.disable', '', { tenantId: t.id });
    return redirectWith(c, `/admin/tenants/${t.id}`, 'ok', t.disabled ? 'Mandant entsperrt.' : 'Mandant gesperrt.');
  });

  app.post('/admin/tenants/:id/open', async (c) => {
    const id = idParam(c);
    const m = await one('SELECT 1 FROM memberships m JOIN tenants t ON t.id = m.tenant_id WHERE m.user_id = ? AND m.tenant_id = ? AND t.disabled = 0', userOf(c).id, id);
    if (!m) return redirectWith(c, `/admin/tenants/${id}`, 'error', 'Du bist kein Mitglied dieses Mandanten.');
    await setSessionTenant(c.get('session')!.id, id);
    return c.redirect('/', 303);
  });

  app.post('/admin/tenants/:id/delete', async (c) => {
    const t = (await one('SELECT id, name FROM tenants WHERE id = ?', idParam(c))) ?? notFound();
    if (await one('SELECT 1 FROM documents WHERE tenant_id = ? LIMIT 1', t.id)) {
      return redirectWith(c, `/admin/tenants/${t.id}`, 'error', 'Mandanten mit Belegen können nicht gelöscht werden – bitte sperren.');
    }
    await tx(async () => {
      await run('UPDATE sessions SET tenant_id = NULL WHERE tenant_id = ?', t.id);
      await run('DELETE FROM tenants WHERE id = ?', t.id);
    });
    await audit(c, 'admin.tenant.delete', t.name, { tenantId: null });
    return redirectWith(c, '/admin/tenants', 'ok', `Mandant „${t.name}“ gelöscht.`);
  });

  /* ---------------- Benutzer ---------------- */
  app.get('/admin/users', async (c) => {
    const q = (c.req.query('q') ?? '').trim().slice(0, 100);
    const rows = await all(
      `SELECT u.id, u.name, u.email, u.is_admin, u.disabled, u.last_login_at, u.created_at,
         (SELECT GROUP_CONCAT(t.name ORDER BY t.name SEPARATOR ', ') FROM memberships m JOIN tenants t ON t.id = m.tenant_id WHERE m.user_id = u.id) AS tenants
       FROM users u WHERE (? = '' OR u.email LIKE ? OR u.name LIKE ?) ORDER BY u.disabled, u.email LIMIT 1000`,
      q, `%${q}%`, `%${q}%`,
    );
    return adminPage(c, '/admin/users', {
      title: 'Benutzer',
      actions: html`<a class="btn primary" href="/admin/users/new">Neuer Benutzer</a>`,
      body: html`
      <form class="toolbar" method="get"><input type="search" name="q" value="${q}" placeholder="Suchen …" aria-label="Suchen"></form>
      <div class="card flush"><table class="table">
        <thead><tr><th>Name</th><th>E-Mail</th><th>Mandanten</th><th>Letzte Anmeldung</th><th></th></tr></thead>
        <tbody>${rows.map((u) => html`<tr class="rowlink" data-href="/admin/users/${u.id}">
          <td><a href="/admin/users/${u.id}">${u.name || '–'}</a></td>
          <td>${u.email}</td>
          <td class="small truncate">${u.tenants ?? html`<span class="muted">–</span>`}</td>
          <td>${dt(u.last_login_at)}</td>
          <td class="right">${u.is_admin ? html`<span class="badge badge-sent">Admin</span>` : ''} ${u.disabled ? html`<span class="badge badge-cancelled">gesperrt</span>` : ''}</td>
        </tr>`)}</tbody></table></div>`,
    });
  });

  app.get('/admin/users/new', async (c) =>
    adminPage(c, '/admin/users', {
      title: 'Neuer Benutzer',
      back: { href: '/admin/users', label: 'Benutzer' },
      body: html`<form method="post" action="/admin/users" class="card narrow stack">
        ${csrfField(c)}
        <label>Name <input name="name" maxlength="200"></label>
        <label>E-Mail <input type="email" name="email" required></label>
        <label>Startpasswort <input type="password" name="password" minlength="10" required autocomplete="new-password"></label>
        <label class="check"><input type="checkbox" name="is_admin" value="1"> Administrator</label>
        <button class="btn primary">Anlegen</button>
      </form>`,
    }),
  );

  app.post('/admin/users', async (c) => {
    const form = await readForm(c);
    const email = str(form, 'email', 200).toLowerCase();
    if (!emailSchema.safeParse(email).success) return redirectWith(c, '/admin/users/new', 'error', 'Ungültige E-Mail-Adresse.');
    if (await one('SELECT 1 FROM users WHERE email = ?', email)) return redirectWith(c, '/admin/users/new', 'error', 'Diese E-Mail-Adresse ist bereits vergeben.');
    const pw = passwordSchema.safeParse(str(form, 'password', 200));
    if (!pw.success) return redirectWith(c, '/admin/users/new', 'error', pw.error.issues[0].message);
    const res = await run(
      'INSERT INTO users (email, name, password_hash, is_admin, created_at) VALUES (?, ?, ?, ?, ?)',
      email, str(form, 'name', 200), await hashPassword(pw.data), str(form, 'is_admin') === '1' ? 1 : 0, nowIso(),
    );
    await audit(c, 'admin.user.create', email, { tenantId: null });
    return redirectWith(c, `/admin/users/${res.insertId}`, 'ok', 'Benutzer angelegt. Ordne ihn jetzt einem Mandanten zu.');
  });

  app.get('/admin/users/:id', async (c) => {
    const u = (await one('SELECT * FROM users WHERE id = ?', idParam(c))) ?? notFound();
    const memberships = await all(
      'SELECT t.id, t.name, t.disabled, m.role FROM memberships m JOIN tenants t ON t.id = m.tenant_id WHERE m.user_id = ? ORDER BY t.name',
      u.id,
    );
    const sessions = (await one<{ n: number }>('SELECT COUNT(*) n FROM sessions WHERE user_id = ? AND expires_at > UTC_TIMESTAMP(3)', u.id))!.n;
    const self = u.id === userOf(c).id;
    return adminPage(c, '/admin/users', {
      title: u.name || u.email,
      back: { href: '/admin/users', label: 'Benutzer' },
      body: html`
      ${u.disabled ? html`<div class="notice">Dieses Konto ist gesperrt.</div>` : ''}
      <div class="detail-grid">
        <section class="card">
          <h2>Konto</h2>
          <form method="post" action="/admin/users/${u.id}" class="stack">
            ${csrfField(c)}
            <label>Name <input name="name" value="${u.name}" maxlength="200"></label>
            <label>E-Mail <input type="email" name="email" value="${u.email}" required></label>
            <label class="check"><input type="checkbox" name="is_admin" value="1"${checked(u.is_admin)} ${self ? html`disabled` : ''}> Administrator</label>
            <button class="btn">Speichern</button>
          </form>
          <dl class="dl small spaced">
            <dt>Angelegt</dt><dd>${dt(u.created_at)}</dd>
            <dt>Letzte Anmeldung</dt><dd>${dt(u.last_login_at)}</dd>
            <dt>Aktive Sitzungen</dt><dd>${sessions}</dd>
          </dl>
        </section>
        <section class="card">
          <h2>Passwort zurücksetzen</h2>
          <form method="post" action="/admin/users/${u.id}/password" class="stack">
            ${csrfField(c)}
            <label>Neues Passwort <input type="password" name="password" minlength="10" required autocomplete="new-password"></label>
            <small class="muted">Alle Sitzungen des Benutzers werden beendet. Teile das Passwort persönlich mit.</small>
            <button class="btn">Passwort setzen</button>
          </form>
        </section>
      </div>
      <h2 class="section-title">Mandanten <span class="count">${memberships.length}</span></h2>
      ${memberships.length
        ? html`<ul class="plain">${memberships.map((m) => html`<li><a href="/admin/tenants/${m.id}">${m.name}</a> <span class="muted">· ${m.role === 'owner' ? 'Inhaber' : 'Mitglied'}</span>
            ${m.disabled ? html`<span class="badge badge-cancelled">gesperrt</span>` : ''}</li>`)}</ul>`
        : html`<p class="muted">Keinem Mandanten zugeordnet.</p>`}
      ${self
        ? html`<p class="muted small">Dein eigenes Konto kannst du hier nicht sperren oder löschen.</p>`
        : html`<div class="danger-zone">
            <form method="post" action="/admin/users/${u.id}/sessions" class="inline">${csrfField(c)}<button class="btn ghost">Alle Sitzungen beenden</button></form>
            <form method="post" action="/admin/users/${u.id}/disable" class="inline" data-confirm="${u.disabled ? 'Konto entsperren?' : 'Konto sperren? Der Benutzer wird sofort abgemeldet.'}">${csrfField(c)}
              <button class="btn ${u.disabled ? '' : 'danger'}">${u.disabled ? 'Entsperren' : 'Sperren'}</button></form>
            <form method="post" action="/admin/users/${u.id}/delete" class="inline" data-confirm="Benutzer ${u.email} endgültig löschen? Erstellte Belege bleiben erhalten.">${csrfField(c)}
              <button class="btn danger">Löschen</button></form>
          </div>`}`,
    });
  });

  app.post('/admin/users/:id', async (c) => {
    const u = (await one('SELECT * FROM users WHERE id = ?', idParam(c))) ?? notFound();
    const form = await readForm(c);
    const email = str(form, 'email', 200).toLowerCase();
    if (!emailSchema.safeParse(email).success) return redirectWith(c, `/admin/users/${u.id}`, 'error', 'Ungültige E-Mail-Adresse.');
    if (await one('SELECT 1 FROM users WHERE email = ? AND id != ?', email, u.id)) {
      return redirectWith(c, `/admin/users/${u.id}`, 'error', 'Diese E-Mail-Adresse ist bereits vergeben.');
    }
    const self = u.id === userOf(c).id;
    const isAdmin = self ? 1 : str(form, 'is_admin') === '1' ? 1 : 0;
    if (u.is_admin && !isAdmin && (await adminCount()) <= 1) {
      return redirectWith(c, `/admin/users/${u.id}`, 'error', 'Es muss mindestens ein Administrator bleiben.');
    }
    await run('UPDATE users SET name = ?, email = ?, is_admin = ? WHERE id = ?', str(form, 'name', 200), email, isAdmin, u.id);
    await audit(c, 'admin.user.update', `${email}${isAdmin !== u.is_admin ? (isAdmin ? ' → Admin' : ' → kein Admin') : ''}`, { tenantId: null });
    return redirectWith(c, `/admin/users/${u.id}`, 'ok', 'Gespeichert.');
  });

  app.post('/admin/users/:id/password', async (c) => {
    const u = (await one('SELECT id, email FROM users WHERE id = ?', idParam(c))) ?? notFound();
    const pw = passwordSchema.safeParse(str(await readForm(c), 'password', 200));
    if (!pw.success) return redirectWith(c, `/admin/users/${u.id}`, 'error', pw.error.issues[0].message);
    await run('UPDATE users SET password_hash = ? WHERE id = ?', await hashPassword(pw.data), u.id);
    await run('DELETE FROM sessions WHERE user_id = ? AND id != ?', u.id, c.get('session')!.id);
    await audit(c, 'admin.user.password', u.email, { tenantId: null });
    return redirectWith(c, `/admin/users/${u.id}`, 'ok', 'Passwort gesetzt.');
  });

  app.post('/admin/users/:id/sessions', async (c) => {
    const u = (await one('SELECT id, email FROM users WHERE id = ?', idParam(c))) ?? notFound();
    await run('DELETE FROM sessions WHERE user_id = ?', u.id);
    await audit(c, 'admin.user.logout', u.email, { tenantId: null });
    return redirectWith(c, `/admin/users/${u.id}`, 'ok', 'Alle Sitzungen beendet.');
  });

  app.post('/admin/users/:id/disable', async (c) => {
    const u = (await one('SELECT id, email, disabled, is_admin FROM users WHERE id = ?', idParam(c))) ?? notFound();
    if (u.id === userOf(c).id) return redirectWith(c, `/admin/users/${u.id}`, 'error', 'Du kannst dich nicht selbst sperren.');
    if (!u.disabled && u.is_admin && (await adminCount()) <= 1) {
      return redirectWith(c, `/admin/users/${u.id}`, 'error', 'Es muss mindestens ein aktiver Administrator bleiben.');
    }
    await run('UPDATE users SET disabled = ? WHERE id = ?', u.disabled ? 0 : 1, u.id);
    if (!u.disabled) await run('DELETE FROM sessions WHERE user_id = ?', u.id);
    await audit(c, u.disabled ? 'admin.user.enable' : 'admin.user.disable', u.email, { tenantId: null });
    return redirectWith(c, `/admin/users/${u.id}`, 'ok', u.disabled ? 'Konto entsperrt.' : 'Konto gesperrt und abgemeldet.');
  });

  app.post('/admin/users/:id/delete', async (c) => {
    const u = (await one('SELECT id, email, is_admin FROM users WHERE id = ?', idParam(c))) ?? notFound();
    if (u.id === userOf(c).id) return redirectWith(c, `/admin/users/${u.id}`, 'error', 'Du kannst dich nicht selbst löschen.');
    if (u.is_admin && (await adminCount()) <= 1) return redirectWith(c, `/admin/users/${u.id}`, 'error', 'Es muss mindestens ein Administrator bleiben.');
    const sole = await soleOwnerOf(u.id);
    const blocking = [];
    for (const t of sole) {
      const others = (await one<{ n: number }>('SELECT COUNT(*) n FROM memberships WHERE tenant_id = ? AND user_id != ?', t.id, u.id))!.n;
      if (others) blocking.push(t.name);
    }
    if (blocking.length) {
      return redirectWith(c, `/admin/users/${u.id}`, 'error', `Einziger Inhaber von: ${blocking.join(', ')}. Bitte zuerst einen anderen Inhaber bestimmen.`);
    }
    await run('DELETE FROM users WHERE id = ?', u.id);
    await audit(c, 'admin.user.delete', u.email, { tenantId: null });
    return redirectWith(c, '/admin/users', 'ok', `Benutzer ${u.email} gelöscht.`);
  });

  /* ---------------- Protokoll ---------------- */
  app.get('/admin/audit', async (c) => {
    const action = (c.req.query('action') ?? '').trim().slice(0, 64);
    const rows = await recentAudit({ action, limit: 500 });
    const filters = [['', 'Alle'], ['login', 'Anmeldungen'], ['login.failed', 'Fehlversuche'], ['invoice', 'Rechnungen'], ['member', 'Benutzer'], ['admin', 'Administration']];
    return adminPage(c, '/admin/audit', {
      title: 'Protokoll',
      body: html`
      <div class="toolbar"><div class="tabs">${filters.map(([v, l]) => html`<a href="/admin/audit${v ? `?action=${v}` : ''}" class="${action === v ? 'active' : ''}">${l}</a>`)}</div></div>
      ${auditTable(rows)}
      <p class="muted small">Es werden die letzten 500 Einträge angezeigt.</p>`,
    });
  });

  /* ---------------- System ---------------- */
  app.get('/admin/system', async (c) => {
    const reg = await getSetting('allow_registration');
    const regOpen = reg === null ? config.allowRegistration : reg === '1';
    const db = await one<{ v: string }>('SELECT VERSION() AS v');
    const schema = await one<{ v: number }>('SELECT MAX(version) AS v FROM schema_migrations');
    const size = await one<{ mb: number }>(
      'SELECT ROUND(SUM(data_length + index_length) / 1024 / 1024, 1) AS mb FROM information_schema.tables WHERE table_schema = DATABASE()',
    );
    return adminPage(c, '/admin/system', {
      title: 'System',
      body: html`
      <div class="detail-grid">
        <section class="card">
          <h2>Registrierung</h2>
          <form method="post" action="/admin/system" class="stack">
            ${csrfField(c)}
            <label class="check"><input type="checkbox" name="allow_registration" value="1"${checked(regOpen)}> Jeder darf sich selbst registrieren</label>
            <small class="muted">Aus: Neue Benutzer entstehen nur über die Administration oder durch Inhaber (Einladung bzw. Konto anlegen).
              ${reg === null ? ' Aktuell gilt der Wert aus SCHOTTR_ALLOW_REGISTRATION.' : ''}</small>
            <button class="btn">Speichern</button>
          </form>
        </section>
        <section class="card">
          <h2>Informationen</h2>
          <dl class="dl">
            <dt>Schottr</dt><dd>${pkg.version}</dd>
            <dt>Node.js</dt><dd>${process.version}</dd>
            <dt>Datenbank</dt><dd>MariaDB ${db?.v ?? '?'}</dd>
            <dt>Schema</dt><dd>Version ${schema?.v ?? '?'}</dd>
            <dt>Datenbankgröße</dt><dd>${size?.mb ?? 0} MB</dd>
            <dt>Laufzeit</dt><dd>${Math.floor(process.uptime() / 3600)} h ${Math.floor((process.uptime() % 3600) / 60)} min</dd>
          </dl>
        </section>
      </div>`,
    });
  });

  app.post('/admin/system', async (c) => {
    const open = str(await readForm(c), 'allow_registration') === '1';
    await setSetting('allow_registration', open ? '1' : '0');
    await audit(c, 'admin.system.registration', open ? 'offen' : 'geschlossen', { tenantId: null });
    return redirectWith(c, '/admin/system', 'ok', 'Gespeichert.');
  });
}

function auditTable(rows: any[]): SafeHtml {
  if (!rows.length) return html`<p class="muted">Noch keine Einträge.</p>`;
  return html`<div class="card flush"><table class="table">
    <thead><tr><th>Zeit</th><th>Ereignis</th><th>Benutzer</th><th>Mandant</th><th>Details</th><th>IP</th></tr></thead>
    <tbody>${rows.map((r) => html`<tr>
      <td class="nowrap">${dt(r.created_at)}</td>
      <td class="${r.action === 'login.failed' ? 'danger-text' : ''}">${actionLabel(r.action)}</td>
      <td>${r.user_email}</td>
      <td>${r.tenant_name ?? ''}</td>
      <td class="small truncate">${r.details}</td>
      <td class="mono small">${r.ip}</td></tr>`)}
    </tbody></table></div>`;
}

export const adminModule: Module = { name: 'admin', register };
