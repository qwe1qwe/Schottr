import { all, one, run, nowIso } from '../db/index.ts';
import { html, selected } from '../lib/html.ts';
import { readForm, str, redirectWith, tenantOf, idParam, notFound, type Form } from '../lib/http.ts';
import { formatAmount, formatMoney, formatRate, parseDecimal } from '../lib/money.ts';
import { UNITS, isUnit, unitShort } from '../lib/units.ts';
import { VAT_RATES } from '../lib/calc.ts';
import { csrfField, page, empty } from '../views/layout.ts';
import type { App, Ctx, Module } from '../types.ts';

/**
 * Artikelstamm – rein optional. Beim Einfügen in einen Beleg werden die Werte
 * kopiert; spätere Änderungen am Artikel verändern bestehende Belege nicht.
 */
export interface Article {
  id: number;
  tenant_id: number;
  number: string;
  title: string;
  description: string;
  unit: string;
  unit_price: number;
  vat_rate: number;
  archived: number;
}

export async function articleOptions(tenantId: number): Promise<Article[]> {
  return all<Article>('SELECT * FROM articles WHERE tenant_id = ? AND archived = 0 ORDER BY title LIMIT 2000', tenantId);
}

async function getArticle(tenantId: number, id: number) {
  return one<Article>('SELECT * FROM articles WHERE tenant_id = ? AND id = ?', tenantId, id);
}

function parseArticle(form: Form) {
  const errors: string[] = [];
  const v = {
    number: str(form, 'number', 40),
    title: str(form, 'title', 300),
    description: str(form, 'description', 4000),
    unit: str(form, 'unit') || 'C62',
    unit_price: parseDecimal(str(form, 'unit_price') || '0', 2),
    vat_rate: Number(str(form, 'vat_rate') || 1900),
  };
  if (!v.title) errors.push('Bitte eine Bezeichnung angeben.');
  if (!isUnit(v.unit)) errors.push('Unbekannte Einheit.');
  if (v.unit_price === null) errors.push('Ungültiger Preis.');
  if (!(VAT_RATES as readonly number[]).includes(v.vat_rate)) errors.push('Ungültiger Steuersatz.');
  return { v: { ...v, unit_price: v.unit_price ?? 0 }, errors };
}

function articleForm(c: Ctx, action: string, a: Partial<Article>) {
  return html`
  <form method="post" action="${action}" class="card stack">
    ${csrfField(c)}
    <div class="grid-3">
      <label>Artikelnummer <input name="number" value="${a.number ?? ''}" maxlength="40" placeholder="optional"></label>
      <label class="span-2">Bezeichnung <input name="title" value="${a.title ?? ''}" maxlength="300" required></label>
      <label class="span-3">Beschreibung <textarea name="description" rows="3">${a.description ?? ''}</textarea></label>
      <label>Einheit <select name="unit">${UNITS.map((u) => html`<option value="${u.code}"${selected(u.code, a.unit ?? 'C62')}>${u.label}</option>`)}</select></label>
      <label>Einzelpreis netto (€) <input name="unit_price" class="num" inputmode="decimal" value="${a.unit_price !== undefined ? formatAmount(a.unit_price).replace(/\./g, '') : ''}" placeholder="0,00"></label>
      <label>USt. <select name="vat_rate">${VAT_RATES.map((r) => html`<option value="${r}"${selected(r, a.vat_rate ?? 1900)}>${r / 100} %</option>`)}</select></label>
    </div>
    <div class="form-actions"><button class="btn primary">Speichern</button></div>
  </form>`;
}

function register(app: App) {
  app.get('/articles', async (c) => {
    const t = tenantOf(c);
    const q = (c.req.query('q') ?? '').trim().slice(0, 100);
    const showArchived = c.req.query('archived') === '1';
    const like = `%${q}%`;
    const rows = await all<Article>(
      `SELECT * FROM articles WHERE tenant_id = ? AND archived = ?
       AND (? = '' OR number LIKE ? OR title LIKE ? OR description LIKE ?) ORDER BY title LIMIT 500`,
      t.id, showArchived ? 1 : 0, q, like, like, like,
    );
    return page(c, {
      title: 'Artikel',
      actions: html`<a class="btn primary" href="/articles/new">Neuer Artikel</a>`,
      body: html`
      <p class="muted small">Der Artikelstamm ist optional: Im Beleg kannst du Artikel einfügen oder Positionen weiterhin frei eingeben.</p>
      <form class="toolbar" method="get">
        <input type="search" name="q" value="${q}" placeholder="Suchen …" aria-label="Suchen">
        <label class="check small"><input type="checkbox" name="archived" value="1" data-autosubmit ${showArchived ? html`checked` : ''}> Archiv</label>
      </form>
      ${rows.length
        ? html`<div class="card flush"><table class="table">
            <thead><tr><th>Nr.</th><th>Bezeichnung</th><th>Einheit</th><th class="right">Preis netto</th><th class="right">USt.</th></tr></thead>
            <tbody>${rows.map((a) => html`<tr class="rowlink" data-href="/articles/${a.id}">
              <td class="mono">${a.number}</td>
              <td><a href="/articles/${a.id}">${a.title}</a>${a.description ? html`<div class="muted small truncate">${a.description}</div>` : ''}</td>
              <td>${unitShort(a.unit)}</td>
              <td class="right num">${formatMoney(a.unit_price)}</td>
              <td class="right num">${formatRate(a.vat_rate)}</td></tr>`)}
            </tbody></table></div>`
        : empty(q ? 'Keine Treffer.' : 'Noch keine Artikel.', q ? undefined : html`<a class="btn primary" href="/articles/new">Ersten Artikel anlegen</a>`)}`,
    });
  });

  app.get('/articles/new', async (c) =>
    page(c, { title: 'Neuer Artikel', back: { href: '/articles', label: 'Artikel' }, body: articleForm(c, '/articles', {}) }),
  );

  app.post('/articles', async (c) => {
    const t = tenantOf(c);
    const { v, errors } = parseArticle(await readForm(c));
    if (errors.length) return redirectWith(c, '/articles/new', 'error', errors.join(' '));
    const now = nowIso();
    await run(
      'INSERT INTO articles (tenant_id, number, title, description, unit, unit_price, vat_rate, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
      t.id, v.number, v.title, v.description, v.unit, v.unit_price, v.vat_rate, now, now,
    );
    return redirectWith(c, '/articles', 'ok', 'Artikel angelegt.');
  });

  app.get('/articles/:id', async (c) => {
    const t = tenantOf(c);
    const a = (await getArticle(t.id, idParam(c))) ?? notFound();
    return page(c, {
      title: a.title,
      back: { href: '/articles', label: 'Artikel' },
      body: html`${articleForm(c, `/articles/${a.id}`, a)}
      <p class="muted small">Änderungen wirken sich nur auf neue Positionen aus, nicht auf bestehende Angebote oder Rechnungen.</p>
      <div class="danger-zone">
        <form method="post" action="/articles/${a.id}/archive">${csrfField(c)}<button class="btn ghost">${a.archived ? 'Aus Archiv holen' : 'Archivieren'}</button></form>
        <form method="post" action="/articles/${a.id}/delete" data-confirm="Artikel endgültig löschen?">${csrfField(c)}<button class="btn danger">Löschen</button></form>
      </div>`,
    });
  });

  app.post('/articles/:id', async (c) => {
    const t = tenantOf(c);
    const a = (await getArticle(t.id, idParam(c))) ?? notFound();
    const { v, errors } = parseArticle(await readForm(c));
    if (errors.length) return redirectWith(c, `/articles/${a.id}`, 'error', errors.join(' '));
    await run(
      'UPDATE articles SET number = ?, title = ?, description = ?, unit = ?, unit_price = ?, vat_rate = ?, updated_at = ? WHERE id = ? AND tenant_id = ?',
      v.number, v.title, v.description, v.unit, v.unit_price, v.vat_rate, nowIso(), a.id, t.id,
    );
    return redirectWith(c, '/articles', 'ok', 'Artikel gespeichert.');
  });

  app.post('/articles/:id/archive', async (c) => {
    const t = tenantOf(c);
    const a = (await getArticle(t.id, idParam(c))) ?? notFound();
    await run('UPDATE articles SET archived = ?, updated_at = ? WHERE id = ?', a.archived ? 0 : 1, nowIso(), a.id);
    return redirectWith(c, '/articles', 'ok', a.archived ? 'Artikel wiederhergestellt.' : 'Artikel archiviert.');
  });

  app.post('/articles/:id/delete', async (c) => {
    const t = tenantOf(c);
    const a = (await getArticle(t.id, idParam(c))) ?? notFound();
    await run('DELETE FROM articles WHERE id = ? AND tenant_id = ?', a.id, t.id);
    return redirectWith(c, '/articles', 'ok', 'Artikel gelöscht.');
  });
}

export const articlesModule: Module = {
  name: 'articles',
  nav: { label: 'Artikel', href: '/articles', order: 15 },
  register,
};
