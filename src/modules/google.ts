import { getCookie, setCookie, deleteCookie } from 'hono/cookie';
import { z } from 'zod';
import { one, run, tx, nowIso } from '../db/index.ts';
import { html } from '../lib/html.ts';
import { readForm, str, isSecure, redirectWith, userOf, setSessionCookie } from '../lib/http.ts';
import { audit } from '../lib/audit.ts';
import { orgFields } from '../lib/nonprofit.ts';
import {
  googleEnabled, randomToken, redirectUri, authorizationUrl, exchangeCode, seal, unseal, hasPassword,
  GoogleAuthError, type GoogleProfile,
} from '../lib/google.ts';
import { createSession } from '../lib/auth.ts';
import { barePage } from '../views/layout.ts';
import { completeLogin, createTenant, registrationOpen, tenantOptions } from './auth.ts';
import type { App, Ctx, Module } from '../types.ts';

/**
 * Anmeldung mit Google. Aktiv, sobald GOOGLE_CLIENT_ID und GOOGLE_CLIENT_SECRET gesetzt sind.
 *
 * - Bereits verknüpftes Google-Konto → Anmeldung.
 * - Noch nicht verknüpft, aber ein Schottr-Konto mit derselben (von Google bestätigten)
 *   E-Mail-Adresse → wird automatisch verknüpft und angemeldet.
 * - Unbekannt und Registrierung offen → Registrierung (Mandant anlegen) ohne Passwort.
 * - Unter „Mein Konto“ lässt sich Google nachträglich verknüpfen oder trennen.
 */
const FLOW_COOKIE = 'schottr_oidc';
const PENDING_COOKIE = 'schottr_gpending';
const COOKIE_PATH = '/auth/google';

interface Flow { state: string; nonce: string; verifier: string; redirect: string; link: boolean }
type Pending = Pick<GoogleProfile, 'sub' | 'email' | 'name'>;

const cookieOpts = (c: Ctx, maxAge: number) => ({ httpOnly: true, sameSite: 'Lax' as const, secure: isSecure(c), path: COOKIE_PATH, maxAge });

const fail = (c: Ctx, to: string, message: string) => redirectWith(c, to, 'error', message);

const userBySubject = (sub: string) =>
  one<{ id: number; email: string; disabled: number }>(
    `SELECT u.id, u.email, u.disabled FROM user_identities i JOIN users u ON u.id = i.user_id
     WHERE i.provider = 'google' AND i.subject = ?`, sub,
  );

async function linkIdentity(userId: number, p: GoogleProfile) {
  await run(
    'INSERT INTO user_identities (user_id, provider, subject, email, created_at, last_login_at) VALUES (?, ?, ?, ?, ?, ?)',
    userId, 'google', p.sub, p.email, nowIso(), nowIso(),
  );
}

function registerForm(c: Ctx, p: Pending, values: Record<string, string> = {}) {
  return html`
  <p class="muted">Du meldest dich mit <strong>${p.email}</strong> an. Lege jetzt deinen Mandanten (Firma bzw. Verein) an.</p>
  <form method="post" action="/auth/google/register" class="stack">
    <label>Firma / Verein (Mandant) <input name="company" value="${values.company ?? ''}" required maxlength="200" autofocus></label>
    ${orgFields(values)}
    <label>Dein Name <input name="name" value="${values.name ?? p.name}" required maxlength="200" autocomplete="name"></label>
    <label class="check"><input type="checkbox" name="small_business" value="1"> Kleinunternehmer nach § 19 UStG</label>
    <button class="btn primary">Konto anlegen</button>
  </form>
  <p class="muted center"><a href="/login">Abbrechen</a></p>`;
}

function register(app: App) {
  // Schritt 1: zu Google weiterleiten
  app.get('/auth/google', async (c) => {
    if (!googleEnabled()) return c.redirect('/login');
    const link = c.req.query('link') === '1';
    if (link && !c.get('user')) return c.redirect('/login');
    if (!link && c.get('user')) return c.redirect('/');
    const flow: Flow = { state: randomToken(), nonce: randomToken(), verifier: randomToken(48), redirect: redirectUri(c), link };
    setCookie(c, FLOW_COOKIE, seal(flow, 10 * 60_000), cookieOpts(c, 600));
    return c.redirect(authorizationUrl({ ...flow, redirectUri: flow.redirect, loginHint: link ? c.get('user')!.email : undefined }), 302);
  });

  // Schritt 2: Rückkehr von Google
  app.get('/auth/google/callback', async (c) => {
    if (!googleEnabled()) return c.redirect('/login');
    const flow = unseal<Flow>(getCookie(c, FLOW_COOKIE));
    deleteCookie(c, FLOW_COOKIE, { path: COOKIE_PATH });
    const back = flow?.link ? '/account' : '/login';
    if (c.req.query('error')) {
      return fail(c, back, c.req.query('error') === 'access_denied' ? 'Anmeldung mit Google abgebrochen.' : `Google meldet einen Fehler: ${c.req.query('error')}`);
    }
    const code = c.req.query('code');
    if (!flow || !code || c.req.query('state') !== flow.state) {
      return fail(c, back, 'Die Anmeldung mit Google ist abgelaufen oder ungültig. Bitte erneut versuchen.');
    }
    let profile: GoogleProfile;
    try {
      profile = await exchangeCode(code, flow.verifier, flow.redirect, flow.nonce);
    } catch (err) {
      if (!(err instanceof GoogleAuthError)) console.error(err);
      return fail(c, back, err instanceof GoogleAuthError ? err.message : 'Google ist gerade nicht erreichbar. Bitte später erneut versuchen.');
    }

    // Verknüpfen aus „Mein Konto“
    if (flow.link) {
      const user = c.get('user');
      if (!user) return c.redirect('/login');
      const existing = await userBySubject(profile.sub);
      if (existing && existing.id !== user.id) return fail(c, '/account', 'Dieses Google-Konto ist bereits mit einem anderen Schottr-Konto verknüpft.');
      if (!existing) {
        if (await one("SELECT 1 FROM user_identities WHERE user_id = ? AND provider = 'google'", user.id)) {
          return fail(c, '/account', 'Dein Konto ist bereits mit einem Google-Konto verknüpft.');
        }
        await linkIdentity(user.id, profile);
        await audit(c, 'user.google.link', profile.email);
      }
      return redirectWith(c, '/account', 'ok', 'Google-Konto verknüpft. Du kannst dich jetzt auch mit Google anmelden.');
    }

    // Anmeldung
    let user = await userBySubject(profile.sub);
    if (user) {
      await run("UPDATE user_identities SET last_login_at = ?, email = ? WHERE provider = 'google' AND subject = ?", nowIso(), profile.email, profile.sub);
    } else if (profile.emailVerified && profile.email) {
      const byEmail = await one<{ id: number; email: string; disabled: number }>('SELECT id, email, disabled FROM users WHERE email = ?', profile.email);
      if (byEmail && !byEmail.disabled) {
        if (await one("SELECT 1 FROM user_identities WHERE user_id = ? AND provider = 'google'", byEmail.id)) {
          // Konto ist schon mit einem anderen Google-Konto verknüpft – nicht stillschweigend umhängen
          return fail(c, '/login', 'Dein Schottr-Konto ist mit einem anderen Google-Konto verknüpft.');
        }
        await linkIdentity(byEmail.id, profile);
        await audit(c, 'user.google.link', `${profile.email} (automatisch über bestätigte E-Mail)`, { userId: byEmail.id, email: byEmail.email, tenantId: null });
      }
      user = byEmail;
    }

    if (!user) {
      if (!profile.emailVerified || !profile.email) return fail(c, '/login', 'Die E-Mail-Adresse deines Google-Kontos ist nicht bestätigt.');
      if (!await registrationOpen()) {
        await audit(c, 'login.failed', 'Google: kein Konto', { userId: null, email: profile.email, tenantId: null });
        return fail(c, '/login', 'Zu diesem Google-Konto gibt es noch keinen Zugang. Bitte den Administrator um ein Konto bitten oder dich mit Passwort anmelden und Google unter „Mein Konto“ verknüpfen.');
      }
      const pending: Pending = { sub: profile.sub, email: profile.email, name: profile.name };
      setCookie(c, PENDING_COOKIE, seal(pending, 30 * 60_000), cookieOpts(c, 1800));
      return c.redirect('/auth/google/register', 303);
    }
    if (user.disabled) {
      await audit(c, 'login.disabled', 'Google', { userId: user.id, email: user.email, tenantId: null });
      return fail(c, '/login', 'Dieses Konto ist gesperrt. Bitte wende dich an den Administrator.');
    }
    return completeLogin(c, user, 'Google');
  });

  // Schritt 3 (nur für neue Konten): Mandant anlegen
  app.get('/auth/google/register', async (c) => {
    const p = unseal<Pending>(getCookie(c, PENDING_COOKIE));
    if (!p || !googleEnabled() || !await registrationOpen()) return c.redirect('/login');
    return barePage(c, 'Registrieren', registerForm(c, p));
  });

  app.post('/auth/google/register', async (c) => {
    const p = unseal<Pending>(getCookie(c, PENDING_COOKIE));
    if (!p || !googleEnabled() || !await registrationOpen()) return c.redirect('/login', 303);
    const form = await readForm(c);
    const values = {
      company: str(form, 'company', 200), name: str(form, 'name', 200),
      org_type: str(form, 'org_type', 20), nonprofit: str(form, 'nonprofit', 1),
    };
    const parsed = z.object({ company: z.string().min(1, 'Bitte einen Firmennamen angeben.'), name: z.string().min(1, 'Bitte deinen Namen angeben.') }).safeParse(values);
    if (!parsed.success) return barePage(c, 'Registrieren', registerForm(c, p, values), 400, { type: 'error', message: parsed.error.issues[0].message });
    if (await one('SELECT 1 FROM users WHERE email = ?', p.email) || await userBySubject(p.sub)) {
      deleteCookie(c, PENDING_COOKIE, { path: COOKIE_PATH });
      return fail(c, '/login', 'Für diese E-Mail-Adresse gibt es bereits ein Konto. Bitte melde dich an.');
    }
    const { userId, tenantId } = await tx(async () => {
      const first = !await one('SELECT 1 FROM users LIMIT 1');
      const res = await run(
        'INSERT INTO users (email, name, password_hash, is_admin, created_at, last_login_at) VALUES (?, ?, ?, ?, ?, ?)',
        p.email, values.name, '', first ? 1 : 0, nowIso(), nowIso(),
      );
      const userId = Number(res.insertId);
      await linkIdentity(userId, { ...p, emailVerified: true });
      const tenantId = await createTenant(values.company, userId, tenantOptions(form));
      await run('UPDATE tenants SET contact_name = ?, email = ? WHERE id = ?', values.name, p.email, tenantId);
      return { userId, tenantId };
    });
    deleteCookie(c, PENDING_COOKIE, { path: COOKIE_PATH });
    await audit(c, 'user.register', `${values.company} (Google)`, { userId, email: p.email, tenantId });
    const { token } = await createSession(userId, tenantId);
    setSessionCookie(c, token);
    return redirectWith(c, '/settings', 'ok', 'Willkommen bei Schottr! Bitte vervollständige zuerst deine Firmendaten.');
  });

  // Verknüpfung lösen – nur, wenn danach noch ein Passwort zur Anmeldung bleibt
  app.post('/account/google/unlink', async (c) => {
    const user = userOf(c);
    const row = await one<{ password_hash: string }>('SELECT password_hash FROM users WHERE id = ?', user.id);
    if (!hasPassword(row?.password_hash)) {
      return fail(c, '/account', 'Bitte lege zuerst ein Passwort fest – sonst könntest du dich nicht mehr anmelden.');
    }
    await run("DELETE FROM user_identities WHERE user_id = ? AND provider = 'google'", user.id);
    await audit(c, 'user.google.unlink');
    return redirectWith(c, '/account', 'ok', 'Verknüpfung mit Google gelöst.');
  });
}

export const googleModule: Module = { name: 'google', register };
