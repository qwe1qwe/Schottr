import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { html, raw, type SafeHtml, selected } from '../lib/html.ts';
import { takeFlash } from '../lib/http.ts';
import type { Ctx, Module } from '../types.ts';

/** Versionskennung der statischen Dateien – erzwingt nach Updates das Neuladen im Browser */
const ASSET_VERSION = crypto
  .createHash('sha1')
  .update(['app.css', 'app.js'].map((f) => fs.readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), '../../public', f))).join(''))
  .digest('hex')
  .slice(0, 10);

let navItems: NonNullable<Module['nav']>[] = [];
export function setNav(items: NonNullable<Module['nav']>[]) {
  navItems = [...items].sort((a, b) => a.order - b.order);
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
    ${tenant
      ? html`<nav class="nav">
          ${navItems.filter((n) => !n.visible || n.visible(tenant)).map(
            (n) => html`<a href="${n.href}" class="${isActive(n.href) ? 'active' : ''}">${n.label}</a>`,
          )}
        </nav>`
      : ''}
    ${user
      ? html`<div class="sidebar-foot">
          ${tenants.length > 1
            ? html`<form method="post" action="/tenant/switch" class="tenant-switch">
                ${csrfField(c)}
                <label for="tenant-select">Mandant</label>
                <select id="tenant-select" name="tenant_id" data-autosubmit>
                  ${tenants.map((t) => html`<option value="${t.id}"${selected(t.id, tenant?.id)}>${t.name}</option>`)}
                </select>
              </form>`
            : tenant
              ? html`<div class="tenant-name" title="Mandant">${tenant.name}</div>`
              : ''}
          ${user.is_admin ? html`<a href="/admin" class="admin-link ${path.startsWith('/admin') ? 'active' : ''}">Administration</a>` : ''}
          <a href="/account" class="user-link">${user.name || user.email}</a>
          <form method="post" action="/logout">${csrfField(c)}<button class="link">Abmelden</button></form>
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
