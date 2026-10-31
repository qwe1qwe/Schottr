import { Hono } from 'hono';
import { getCookie } from 'hono/cookie';
import { secureHeaders } from 'hono/secure-headers';
import { bodyLimit } from 'hono/body-limit';
import { HTTPException } from 'hono/http-exception';
import { serveStatic } from '@hono/node-server/serve-static';
import { all, one } from './db/index.ts';
import { loadSession, safeEqual, destroySession } from './lib/auth.ts';
import { html } from './lib/html.ts';
import { SESSION_COOKIE, UserError, clearSessionCookie, redirectWith, withNotes } from './lib/http.ts';
import { page, barePage, setNav } from './views/layout.ts';
import { modules } from './modules/index.ts';
import type { AppEnv, Tenant, User, Role } from './types.ts';

const PUBLIC_PATHS = ['/login', '/register', '/health'];

export function createApp() {
  const app = new Hono<AppEnv>();

  const strictHeaders = secureHeaders({
    contentSecurityPolicy: {
      defaultSrc: ["'self'"],
      scriptSrc: ["'self'"],
      styleSrc: ["'self'"],
      imgSrc: ["'self'", 'data:'],
      fontSrc: ["'self'"],
      formAction: ["'self'"],
      frameAncestors: ["'none'"],
      objectSrc: ["'none'"],
      baseUri: ["'self'"],
    },
    crossOriginEmbedderPolicy: false,
    // „no-referrer“ würde Browser dazu bringen, bei Formularen „Origin: null“ zu senden
    referrerPolicy: 'same-origin',
    });
  // Belegvorschau (PDF/Bild) darf in der eigenen Seite eingebettet werden. Ohne weitere
  // CSP-Vorgaben, sonst verweigern manche Browser ihren PDF-Betrachter.
  const framableHeaders = secureHeaders({
    contentSecurityPolicy: { frameAncestors: ["'self'"] },
    xFrameOptions: 'SAMEORIGIN',
    crossOriginEmbedderPolicy: false,
    crossOriginResourcePolicy: 'same-origin',
    referrerPolicy: 'same-origin',
  });
  app.use((c, next) =>
    c.req.query('inline') === '1' && /^\/(purchases\/\d+\/file|cashbook\/files\/\d+|inbox\/\d+\/file)$/.test(new URL(c.req.url).pathname)
      ? framableHeaders(c, next)
      : strictHeaders(c, next),
  );

  // Uploads (Logo, Nachweise, mehrere Belege auf einmal) und Formulare begrenzen
  app.use(bodyLimit({ maxSize: 50 * 1024 * 1024, onError: (c) => c.text('Anfrage zu groß (max. 50 MB je Upload)', 413) }));

  app.use('/static/*', serveStatic({ root: './public', rewriteRequestPath: (p) => p.replace(/^\/static/, '') }));
  app.use('/fonts/*', serveStatic({ root: './assets' }));
  app.get('/health', async (c) => c.json({ ok: true }));

  // Hinweise aus der Fachlogik sammeln (werden an die Erfolgsmeldung angehängt)
  app.use((c, next) => withNotes(() => next()));

  // Sitzung, Benutzer und aktiven Mandanten laden
  app.use(async (c, next) => {
    c.set('session', null);
    c.set('user', null);
    c.set('tenant', null);
    c.set('role', null);
    c.set('tenants', []);
    const session = await loadSession(getCookie(c, SESSION_COOKIE));
    if (session) {
      const user = await one<User & { disabled: number }>('SELECT id, email, name, is_admin, disabled FROM users WHERE id = ?', session.userId);
      if (user?.disabled) {
        // gesperrtes Konto: Sitzung sofort beenden
        await destroySession(session.id);
      } else if (user) {
        c.set('session', session);
        c.set('user', user);
        const tenants = await all<{ id: number; name: string; role: Role }>(
          'SELECT t.id, t.name, m.role FROM memberships m JOIN tenants t ON t.id = m.tenant_id WHERE m.user_id = ? AND t.disabled = 0 ORDER BY t.name',
          user.id,
        );
        c.set('tenants', tenants);
        const active = tenants.find((t) => t.id === session.tenantId) ?? tenants[0];
        if (active) {
          c.set('tenant', (await one<Tenant>('SELECT * FROM tenants WHERE id = ?', active.id))!);
          c.set('role', active.role);
        }
      }
    }
    await next();
  });

  // CSRF-Schutz: Token je Sitzung bei allen schreibenden Anfragen
  app.use(async (c, next) => {
    if (c.req.method !== 'GET' && c.req.method !== 'HEAD') {
      const session = c.get('session');
      if (session) {
        const body = await c.req.parseBody({ all: true });
        const token = typeof body._csrf === 'string' ? body._csrf : '';
        if (!safeEqual(token, session.csrf)) throw new HTTPException(403, { message: 'Ungültiges Formular-Token. Bitte Seite neu laden.' });
      } else {
        // Ohne Sitzung (Login/Registrierung): Herkunft prüfen
        const origin = c.req.header('origin');
        const host = c.req.header('x-forwarded-host') ?? c.req.header('host');
        let originHost: string | null = null;
        try {
          originHost = origin && origin !== 'null' ? new URL(origin).host : null;
        } catch {
          originHost = 'invalid';
        }
        if (originHost && host && originHost !== host) throw new HTTPException(403, { message: 'Ungültige Herkunft' });
      }
    }
    await next();
  });

  // Anmeldung erzwingen
  app.use(async (c, next) => {
    const path = new URL(c.req.url).pathname;
    if (PUBLIC_PATHS.includes(path)) return next();
    if (!c.get('user')) {
      if (c.req.method === 'GET') return c.redirect('/login');
      clearSessionCookie(c);
      return c.redirect('/login', 303);
    }
    // Ohne Mandant: Einladungen annehmen oder eigenen Mandanten anlegen
    const allowedWithoutTenant = ['/account', '/account/password', '/logout', '/tenants', '/tenants/new', '/tenant/switch', '/invitations'];
    if (path === '/admin' || path.startsWith('/admin/')) {
      // Übergreifende Administration – nur für Administratoren, auch ohne eigenen Mandanten
      if (!c.get('user')!.is_admin) throw new HTTPException(403, { message: 'Nur für Administratoren' });
      return next();
    }
    if (!c.get('tenant') && !allowedWithoutTenant.includes(path) && !path.startsWith('/invitations/')) {
      return c.redirect('/invitations', 303);
    }
    return next();
  });

  for (const m of modules) m.register(app);
  setNav(modules.flatMap((m) => (m.nav ? [m.nav] : [])));

  app.notFound((c) =>
    c.get('user')
      ? page(c, { title: 'Nicht gefunden', status: 404, body: html`<p>Diese Seite gibt es nicht.</p><p><a href="/">Zur Übersicht</a></p>` })
      : c.redirect('/login'),
  );

  app.onError((err, c) => {
    if (err instanceof UserError) {
      const back = c.req.header('referer');
      let target = '/';
      try {
        if (back && new URL(back).host === new URL(c.req.url).host) target = back;
      } catch { /* ignorieren */ }
      return redirectWith(c, target, 'error', err.message);
    }
    const status = err instanceof HTTPException ? err.status : 500;
    if (status >= 500) console.error(err);
    const message = err instanceof HTTPException ? err.message : 'Es ist ein unerwarteter Fehler aufgetreten.';
    const body = html`<p>${message}</p><p><a href="/">Zur Übersicht</a></p>`;
    if (c.get('user')) {
      return page(c, { title: 'Fehler', body, status });
    }
    return barePage(c, 'Fehler', body, status as 400);
  });

  return app;
}
