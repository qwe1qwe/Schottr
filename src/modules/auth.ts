import { z } from 'zod';
import { all, one, run, tx, nowIso } from '../db/index.ts';
import {
  hashPassword, verifyPassword, dummyVerify, createSession, destroySession, setSessionTenant,
  loginThrottled, recordLoginFailure, clearLoginFailures,
} from '../lib/auth.ts';
import { html } from '../lib/html.ts';
import {
  readForm, str, type Form, setSessionCookie, clearSessionCookie, redirectWith, clientIp, userOf,
} from '../lib/http.ts';
import { barePage, csrfField, page } from '../views/layout.ts';
import { config } from '../config.ts';
import { audit, getSetting } from '../lib/audit.ts';
import { orgFromForm, orgFields, type OrgType } from '../lib/nonprofit.ts';
import type { App, Module } from '../types.ts';

/** Angaben zur Organisationsform aus den Anlegeformularen */
export const tenantOptions = (form: Form) => ({ smallBusiness: str(form, 'small_business') === '1', ...orgFromForm(form) });

/**
 * Registrierung offen? Die Ersteinrichtung ist immer möglich. Danach entscheidet die
 * Einstellung in der Administration – oder, falls dort nichts gesetzt ist, SCHOTTR_ALLOW_REGISTRATION.
 */
export async function registrationOpen(): Promise<boolean> {
  if (!await one('SELECT 1 FROM users LIMIT 1')) return true;
  const setting = await getSetting('allow_registration');
  return setting === null ? config.allowRegistration : setting === '1';
}

export async function createTenant(
  name: string, ownerId: number, opts: { smallBusiness?: boolean; orgType?: OrgType; nonprofit?: boolean } = {},
): Promise<number> {
  const res = await run(
    'INSERT INTO tenants (name, small_business, org_type, nonprofit, created_at) VALUES (?, ?, ?, ?, ?)',
    name, opts.smallBusiness ? 1 : 0, opts.orgType ?? 'company', opts.nonprofit ? 1 : 0, nowIso(),
  );
  const tenantId = Number(res.insertId);
  await run('INSERT INTO memberships (user_id, tenant_id, role) VALUES (?, ?, ?)', ownerId, tenantId, 'owner');
  return tenantId;
}

const passwordSchema = z.string().min(10, 'Das Passwort muss mindestens 10 Zeichen lang sein.').max(200);
const emailSchema = z.email('Bitte eine gültige E-Mail-Adresse angeben.').max(200);

async function loginForm(c: Parameters<typeof barePage>[0], email = '') {
  return html`
  <form method="post" action="/login" class="stack">
    <label>E-Mail <input type="email" name="email" value="${email}" autocomplete="username" required autofocus></label>
    <label>Passwort <input type="password" name="password" autocomplete="current-password" required></label>
    <button class="btn primary">Anmelden</button>
  </form>
  ${await registrationOpen() ? html`<p class="muted center">Noch kein Zugang? <a href="/register">Registrieren</a></p>` : ''}`;
}

async function registerForm(values: Record<string, string> = {}) {
  const first = !await one('SELECT 1 FROM users LIMIT 1');
  return html`
  ${first ? html`<p class="muted">Ersteinrichtung: Lege deinen Zugang und deinen ersten Mandanten (deine Firma) an.</p>` : ''}
  <form method="post" action="/register" class="stack">
    <label>Firma / Verein (Mandant) <input name="company" value="${values.company ?? ''}" required maxlength="200"></label>
    ${orgFields(values)}
    <label>Dein Name <input name="name" value="${values.name ?? ''}" required maxlength="200" autocomplete="name"></label>
    <label>E-Mail <input type="email" name="email" value="${values.email ?? ''}" required autocomplete="username"></label>
    <label>Passwort <input type="password" name="password" required minlength="10" autocomplete="new-password">
      <small class="muted">mindestens 10 Zeichen</small></label>
    <label class="check"><input type="checkbox" name="small_business" value="1"> Kleinunternehmer nach § 19 UStG</label>
    <button class="btn primary">Konto anlegen</button>
  </form>
  <p class="muted center"><a href="/login">Zur Anmeldung</a></p>`;
}

function register(app: App) {
  app.get('/login', async (c) => (c.get('user') ? c.redirect('/') : barePage(c, 'Anmelden', await loginForm(c))));

  app.post('/login', async (c) => {
    const form = await readForm(c);
    const email = str(form, 'email', 200).toLowerCase();
    const password = str(form, 'password', 200);
    const key = `${clientIp(c)}|${email}`;
    if (loginThrottled(key)) {
      return barePage(c, 'Anmelden', await loginForm(c, email), 429, { type: 'error', message: 'Zu viele Fehlversuche. Bitte in 15 Minuten erneut versuchen.' });
    }
    const user = await one('SELECT * FROM users WHERE email = ?', email);
    const ok = user ? await verifyPassword(password, user.password_hash) : (await dummyVerify(password), false);
    if (!user || !ok) {
      recordLoginFailure(key);
      await audit(c, 'login.failed', '', { userId: user?.id ?? null, email, tenantId: null });
      return barePage(c, 'Anmelden', await loginForm(c, email), 401, { type: 'error', message: 'E-Mail oder Passwort ist falsch.' });
    }
    clearLoginFailures(key);
    if (user.disabled) {
      await audit(c, 'login.disabled', '', { userId: user.id, email, tenantId: null });
      return barePage(c, 'Anmelden', await loginForm(c, email), 403, { type: 'error', message: 'Dieses Konto ist gesperrt. Bitte wende dich an den Administrator.' });
    }
    await run('UPDATE users SET last_login_at = ? WHERE id = ?', nowIso(), user.id);
    await audit(c, 'login.success', '', { userId: user.id, email, tenantId: null });
    const membership = await one(
      'SELECT m.tenant_id FROM memberships m JOIN tenants t ON t.id = m.tenant_id WHERE m.user_id = ? AND t.disabled = 0 ORDER BY m.tenant_id LIMIT 1',
      user.id,
    );
    const { token } = await createSession(user.id, membership?.tenant_id ?? null);
    setSessionCookie(c, token);
    return c.redirect('/', 303);
  });

  app.post('/logout', async (c) => {
    const s = c.get('session');
    if (s) await destroySession(s.id);
    clearSessionCookie(c);
    return c.redirect('/login', 303);
  });

  app.get('/register', async (c) => {
    if (!await registrationOpen()) return c.redirect('/login');
    return barePage(c, 'Registrieren', await registerForm());
  });

  app.post('/register', async (c) => {
    if (!await registrationOpen()) return c.redirect('/login');
    const form = await readForm(c);
    const values = {
      company: str(form, 'company', 200),
      name: str(form, 'name', 200),
      email: str(form, 'email', 200).toLowerCase(),
      org_type: str(form, 'org_type', 20),
      nonprofit: str(form, 'nonprofit', 1),
    };
    const parsed = z
      .object({ company: z.string().min(1, 'Bitte einen Firmennamen angeben.'), name: z.string().min(1, 'Bitte deinen Namen angeben.'), email: emailSchema, password: passwordSchema })
      .safeParse({ ...values, password: str(form, 'password', 200) });
    if (!parsed.success) {
      return barePage(c, 'Registrieren', await registerForm(values), 400, { type: 'error', message: parsed.error.issues[0].message });
    }
    if (await one('SELECT 1 FROM users WHERE email = ?', values.email)) {
      return barePage(c, 'Registrieren', await registerForm(values), 400, { type: 'error', message: 'Diese E-Mail-Adresse ist bereits registriert.' });
    }
    const hash = await hashPassword(parsed.data.password);
    const { userId, tenantId } = await tx(async () => {
      // Der allererste Benutzer wird Administrator
      const first = !await one('SELECT 1 FROM users LIMIT 1');
      const res = await run(
        'INSERT INTO users (email, name, password_hash, is_admin, created_at) VALUES (?, ?, ?, ?, ?)',
        values.email, values.name, hash, first ? 1 : 0, nowIso(),
      );
      const userId = Number(res.insertId);
      const tenantId = await createTenant(values.company, userId, tenantOptions(form));
      await run('UPDATE tenants SET contact_name = ?, email = ? WHERE id = ?', values.name, values.email, tenantId);
      return { userId, tenantId };
    });
    await run('UPDATE users SET last_login_at = ? WHERE id = ?', nowIso(), userId);
    await audit(c, 'user.register', values.company, { userId, email: values.email, tenantId });
    const { token } = await createSession(userId, tenantId);
    setSessionCookie(c, token);
    return redirectWith(c, '/settings', 'ok', 'Willkommen bei Schottr! Bitte vervollständige zuerst deine Firmendaten.');
  });

  app.post('/tenant/switch', async (c) => {
    const form = await readForm(c);
    const user = userOf(c);
    const tenantId = Number(str(form, 'tenant_id'));
    const m = await one(
      'SELECT 1 FROM memberships m JOIN tenants t ON t.id = m.tenant_id WHERE m.user_id = ? AND m.tenant_id = ? AND t.disabled = 0',
      user.id, tenantId,
    );
    if (m) await setSessionTenant(c.get('session')!.id, tenantId);
    return c.redirect('/', 303);
  });

  app.get('/account', async (c) => {
    const user = userOf(c);
    const memberships = await all(
      'SELECT t.name, m.role FROM memberships m JOIN tenants t ON t.id = m.tenant_id WHERE m.user_id = ? ORDER BY t.name',
      user.id,
    );
    return page(c, {
      title: 'Mein Konto',
      body: html`
      <section class="card narrow">
        <h2>Profil</h2>
        <form method="post" action="/account" class="stack">
          ${csrfField(c)}
          <label>Name <input name="name" value="${user.name}" required maxlength="200"></label>
          <label>E-Mail <input value="${user.email}" disabled></label>
          <button class="btn">Speichern</button>
        </form>
      </section>
      <section class="card narrow">
        <h2>Passwort ändern</h2>
        <form method="post" action="/account/password" class="stack">
          ${csrfField(c)}
          <label>Aktuelles Passwort <input type="password" name="current" required autocomplete="current-password"></label>
          <label>Neues Passwort <input type="password" name="password" required minlength="10" autocomplete="new-password"></label>
          <button class="btn">Passwort ändern</button>
        </form>
      </section>
      <section class="card narrow">
        <h2>Meine Mandanten</h2>
        <ul class="plain">${memberships.map((m) => html`<li>${m.name} <span class="muted">· ${m.role === 'owner' ? 'Inhaber' : 'Mitglied'}</span></li>`)}</ul>
        <a class="btn" href="/tenants/new">Weiteren Mandanten anlegen</a>
      </section>`,
    });
  });

  app.post('/account', async (c) => {
    const form = await readForm(c);
    await run('UPDATE users SET name = ? WHERE id = ?', str(form, 'name', 200), userOf(c).id);
    return redirectWith(c, '/account', 'ok', 'Profil gespeichert.');
  });

  app.post('/account/password', async (c) => {
    const form = await readForm(c);
    const user = (await one('SELECT * FROM users WHERE id = ?', userOf(c).id))!;
    if (!(await verifyPassword(str(form, 'current', 200), user.password_hash))) {
      return redirectWith(c, '/account', 'error', 'Das aktuelle Passwort ist falsch.');
    }
    const parsed = passwordSchema.safeParse(str(form, 'password', 200));
    if (!parsed.success) return redirectWith(c, '/account', 'error', parsed.error.issues[0].message);
    await run('UPDATE users SET password_hash = ? WHERE id = ?', await hashPassword(parsed.data), user.id);
    // alle anderen Sitzungen beenden
    await run('DELETE FROM sessions WHERE user_id = ? AND id != ?', user.id, c.get('session')!.id);
    return redirectWith(c, '/account', 'ok', 'Passwort geändert. Andere Sitzungen wurden abgemeldet.');
  });

  app.get('/tenants/new', async (c) =>
    page(c, {
      title: 'Neuer Mandant',
      back: { href: '/account', label: 'Mein Konto' },
      body: html`<section class="card narrow">
        <form method="post" action="/tenants" class="stack">
          ${csrfField(c)}
          <label>Name der Firma bzw. des Vereins <input name="name" required maxlength="200" autofocus></label>
          ${orgFields()}
          <label class="check"><input type="checkbox" name="small_business" value="1"> Kleinunternehmer nach § 19 UStG</label>
          <button class="btn primary">Anlegen</button>
        </form></section>`,
    }),
  );

  app.post('/tenants', async (c) => {
    const form = await readForm(c);
    const name = str(form, 'name', 200);
    if (!name) return redirectWith(c, '/tenants/new', 'error', 'Bitte einen Namen angeben.');
    const user = userOf(c);
    const id = await tx(async () => await createTenant(name, user.id, tenantOptions(form)));
    await setSessionTenant(c.get('session')!.id, id);
    return redirectWith(c, '/settings', 'ok', `Mandant „${name}“ angelegt.`);
  });
}

export const authModule: Module = { name: 'auth', register };
export { passwordSchema, emailSchema };
