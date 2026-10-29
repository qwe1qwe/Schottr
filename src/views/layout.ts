import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { html, raw, type SafeHtml, selected } from '../lib/html.ts';
import { takeFlash } from '../lib/http.ts';
import { NAV_GROUPS, type Ctx, type NavItem, type Tenant, type User } from '../types.ts';
import { icon } from './icons.ts';

/** Versionskennung der statischen Dateien – erzwingt nach Updates das Neuladen im Browser */
const ASSET_VERSION = crypto
  .createHash('sha1')
  .update(['app.css', 'app.js'].map((f) => fs.readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), '../../public', f))).join(''))
  .digest('hex')
  .slice(0, 10);

let navItems: NavItem[] = [];
export function setNav(items: NavItem[]) {
  navItems = [...items];
}

/** Menüeinträge nach Gruppen; die Administration hängt als letzter Eintrag an „Verwaltung“ */
function navGroups(tenant: Tenant, user: User) {
  const groupOf = (n: NavItem) => n.group ?? 'start';
  const items: NavItem[] = navItems.filter((n) => !n.visible || n.visible(tenant));
  if (user.is_admin) items.push({ label: 'Administration', href: '/admin', order: 1000, group: 'manage', icon: 'admin' });
  return NAV_GROUPS.map((g) => ({
    ...g,
    items: items.filter((n) => groupOf(n) === g.id).sort((a, b) => a.order - b.order),
  })).filter((g) => g.items.length);
}

/** Initialen für den Avatar: „Julia Maier“ → „JM“, sonst erster Buchstabe der E-Mail */
function initials(user: User): string {
  const parts = (user.name || '').trim().split(/\s+/).filter(Boolean);
  const letters = parts.length > 1 ? parts[0][0] + parts[parts.length - 1][0] : (parts[0] || user.email || '?')[0];
  return letters.toUpperCase();
}

export function csrfField(c: Ctx): SafeHtml {
  const s = c.get('session');
  return s ? html`<input type="hidden" name="_csrf" value="${s.csrf}">` : html``;
}

interface PageOptions {
  title: string;
  body: SafeHtml;
  actions?: SafeHtml;
  back?: { href: string; label: string };
  status?: number;
}

export function page(c: Ctx, opts: PageOptions) {
  const user = c.get('user');
  const tenant = c.get('tenant');
  const tenants = c.get('tenants') ?? [];
  const flash = takeFlash(c);
  const path = new URL(c.req.url).pathname;
  const isActive = (href: string) => (href === '/' ? path === '/' : path.startsWith(href));

  return c.html(
    html`<!doctype html>
<html lang="de">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${opts.title} · Schottr</title>
<link rel="stylesheet" href="/static/app.css?v=${ASSET_VERSION}">
<link rel="icon" href="/static/favicon.svg" type="image/svg+xml">
<script src="/static/app.js?v=${ASSET_VERSION}" defer></script>
</head>
<body>
<div class="shell">
  <aside class="sidebar">
    <div class="sidebar-top">
      <a class="brand" href="/"><span class="brand-mark">S</span><span>Schottr</span></a>
      ${user
        ? html`<button type="button" class="menu-toggle" data-menu-toggle aria-controls="main-menu" aria-expanded="false" aria-label="Menü öffnen">
            <span class="menu-icon" aria-hidden="true"><span></span><span></span><span></span></span>
          </button>`
        : ''}
    </div>
    <div class="sidebar-panel" id="main-menu">
    ${tenant && user
      ? html`<nav class="nav" aria-label="Hauptmenü">
          ${navGroups(tenant, user).map(
            (g) => html`<div class="nav-group nav-group-${g.id}">
              ${g.label ? html`<div class="nav-label">${g.label}</div>` : ''}
              ${g.items.map((n) => {
                const label = typeof n.label === 'function' ? n.label(tenant) : n.label;
                const active = isActive(n.href);
                return html`<a href="${n.href}" class="${active ? 'active' : ''}"${active ? raw(' aria-current="page"') : ''}>${icon(n.icon)}<span>${label}</span></a>`;
              })}
            </div>`,
          )}
        </nav>`
      : ''}
    ${user
      ? html`<div class="sidebar-foot">
          ${tenants.length > 1
            ? html`<form method="post" action="/tenant/switch" class="tenant-box tenant-switch">
                ${csrfField(c)}
                <label for="tenant-select" class="tenant-label">Mandant</label>
                <div class="tenant-select-wrap">
                  <select id="tenant-select" name="tenant_id" data-autosubmit>
                    ${tenants.map((t) => html`<option value="${t.id}"${selected(t.id, tenant?.id)}>${t.name}</option>`)}
                  </select>
                  ${icon('switch', 'icon tenant-select-icon')}
                </div>
              </form>`
            : tenant
              ? html`<div class="tenant-box"><span class="tenant-label">Mandant</span><span class="tenant-name">${tenant.name}</span></div>`
              : ''}
          <div class="user-box">
            <a href="/account" class="user-card ${path.startsWith('/account') ? 'active' : ''}" title="Mein Konto">
              <span class="avatar" aria-hidden="true">${initials(user)}</span>
              <span class="user-text">
                <span class="user-name">${user.name || user.email}</span>
                <span class="user-sub">${user.name ? user.email : 'Mein Konto'}</span>
              </span>
            </a>
            <form method="post" action="/logout" class="logout-form">
              ${csrfField(c)}
              <button class="icon-btn" title="Abmelden" aria-label="Abmelden">${icon('logout')}<span class="logout-text">Abmelden</span></button>
            </form>
          </div>
        </div>`
      : ''}
    </div>
  </aside>
  <main class="main">
    ${opts.back ? html`<a class="back" href="${opts.back.href}">← ${opts.back.label}</a>` : ''}
    <header class="page-head">
      <h1>${opts.title}</h1>
      ${opts.actions ? html`<div class="actions">${opts.actions}</div>` : ''}
    </header>
    ${flash ? html`<div class="flash flash-${flash.type}" role="status">${flash.message}</div>` : ''}
    ${opts.body}
  </main>
</div>
</body>
</html>`.value,
    (opts.status ?? 200) as 200,
  );
}

/** Einfache Seite ohne Navigation (Login, Registrierung). */
export function barePage(
  c: Ctx,
  title: string,
  body: SafeHtml,
  status: 200 | 400 | 401 | 403 | 429 = 200,
  notice?: { type: 'ok' | 'error'; message: string },
) {
  const flash = notice ?? takeFlash(c);
  return c.html(
    html`<!doctype html>
<html lang="de">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${title} · Schottr</title>
<link rel="stylesheet" href="/static/app.css?v=${ASSET_VERSION}">
<link rel="icon" href="/static/favicon.svg" type="image/svg+xml">
<script src="/static/app.js?v=${ASSET_VERSION}" defer></script>
</head>
<body class="bare">
<main class="auth-card">
  <div class="brand big"><span class="brand-mark">S</span><span>Schottr</span></div>
  ${flash ? html`<div class="flash flash-${flash.type}" role="status">${flash.message}</div>` : ''}
  ${body}
</main>
</body>
</html>`.value,
    status,
  );
}

export function empty(text: string, action?: SafeHtml) {
  return html`<div class="empty"><p>${text}</p>${action ?? ''}</div>`;
}

export function badge(status: string): SafeHtml {
  const labels: Record<string, string> = {
    draft: 'Entwurf',
    sent: 'Versendet',
    accepted: 'Angenommen',
    rejected: 'Abgelehnt',
    invoiced: 'Abgerechnet',
    open: 'Offen',
    paid: 'Bezahlt',
    cancelled: 'Storniert',
    overdue: 'Überfällig',
    settled: 'Erledigt',
  };
  return html`<span class="badge badge-${status}">${labels[status] ?? status}</span>`;
}

export { raw };
