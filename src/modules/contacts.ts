import { all, one, run, nowIso } from '../db/index.ts';
import { html } from '../lib/html.ts';
import { readForm, str, redirectWith, tenantOf, idParam, notFound, type Form } from '../lib/http.ts';
import { nextNumber } from '../lib/numbering.ts';
import { today } from '../lib/dates.ts';
import { isCountryCode, isValidEmail, isValidVatId, normalizeVatId } from '../lib/validate.ts';
import { csrfField, page, empty } from '../views/layout.ts';
import { documentTable } from './documents/views.ts';
import type { App, Ctx, Module } from '../types.ts';

export interface Contact {
  id: number;
  tenant_id: number;
  customer_number: string;
  company: string;
  name: string;
  street: string;
  address_extra: string;
  zip: string;
  city: string;
  country: string;
  email: string;
  phone: string;
  vat_id: string;
  leitweg_id: string;
  notes: string;
  archived: number;
}

export function contactLabel(c: Pick<Contact, 'company' | 'name'>): string {
  return c.company || c.name;
}

export async function getContact(tenantId: number, id: number): Promise<Contact | undefined> {
  return await one<Contact>('SELECT * FROM contacts WHERE tenant_id = ? AND id = ?', tenantId, id);
}

export async function contactOptions(tenantId: number, includeId?: number): Promise<Contact[]> {
  return await all<Contact>(
    'SELECT * FROM contacts WHERE tenant_id = ? AND (archived = 0 OR id = ?) ORDER BY COALESCE(NULLIF(company, \'\'), name)',
    tenantId, includeId ?? 0,
  );
}

const FIELDS = ['company', 'name', 'street', 'address_extra', 'zip', 'city', 'country', 'email', 'phone', 'vat_id', 'leitweg_id', 'notes'] as const;

function parseContact(form: Form) {
  const v = Object.fromEntries(FIELDS.map((k) => [k, str(form, k, k === 'notes' ? 4000 : 200)])) as Record<(typeof FIELDS)[number], string>;
  v.country = (v.country || 'DE').toUpperCase();
  v.vat_id = normalizeVatId(v.vat_id);
  const errors: string[] = [];
  if (!v.company && !v.name) errors.push('Bitte Firma oder Name angeben.');
  if (!isCountryCode(v.country)) errors.push('Land bitte als ISO-Code (z. B. DE).');
  if (v.email && !isValidEmail(v.email)) errors.push('Die E-Mail-Adresse ist ungültig.');
  if (v.vat_id && !isValidVatId(v.vat_id)) errors.push('Die USt-IdNr. hat kein gültiges Format.');
  return { v, errors };
}

function contactForm(c: Ctx, action: string, ct: Partial<Contact>) {
  const f = (key: keyof Contact, label: string, extra = '') =>
    html`<label>${label} <input name="${key}" value="${ct[key] ?? ''}" maxlength="200" ${extra ? html`${extra}` : ''}></label>`;
  return html`
  <form method="post" action="${action}" class="card stack">
    ${csrfField(c)}
    <div class="grid-2">
      ${f('company', 'Firma')}
      ${f('name', 'Ansprechpartner / Name')}
      ${f('street', 'Straße und Hausnummer')}
      ${f('address_extra', 'Adresszusatz')}
      ${f('zip', 'PLZ')}
      ${f('city', 'Ort')}
      ${f('country', 'Land (ISO)')}
      ${f('email', 'E-Mail')}
      ${f('phone', 'Telefon')}
      ${f('vat_id', 'USt-IdNr.')}
      <label>Leitweg-ID <input name="leitweg_id" value="${ct.leitweg_id ?? ''}" maxlength="50">
        <small class="muted">nur für öffentliche Auftraggeber (XRechnung)</small></label>
      <label class="span-2">Notizen <textarea name="notes" rows="3">${ct.notes ?? ''}</textarea></label>
    </div>
    <div class="form-actions"><button class="btn primary">Speichern</button></div>
  </form>`;
}

function register(app: App) {
  app.get('/contacts', async (c) => {
    const t = tenantOf(c);
    const q = (c.req.query('q') ?? '').trim().slice(0, 100);
    const showArchived = c.req.query('archived') === '1';
    const like = `%${q}%`;
    const rows = await all<Contact & { docs: number }>(
      `SELECT c.*, (SELECT COUNT(*) FROM documents d WHERE d.contact_id = c.id) AS docs
       FROM contacts c WHERE c.tenant_id = ? AND c.archived = ?
       AND (? = '' OR c.company LIKE ? OR c.name LIKE ? OR c.city LIKE ? OR c.customer_number LIKE ? OR c.email LIKE ?)
       ORDER BY COALESCE(NULLIF(c.company, ''), c.name) LIMIT 500`,
      t.id, showArchived ? 1 : 0, q, like, like, like, like, like,
    );
    return page(c, {
      title: 'Adressen',
      actions: html`<a class="btn primary" href="/contacts/new">Neue Adresse</a>`,
      body: html`
      <form class="toolbar" method="get">
        <input type="search" name="q" value="${q}" placeholder="Suchen …" aria-label="Suchen">
        <label class="check small"><input type="checkbox" name="archived" value="1" data-autosubmit ${showArchived ? html`checked` : ''}> Archiv</label>
      </form>
      ${rows.length
        ? html`<div class="card flush"><table class="table">
            <thead><tr><th>Nr.</th><th>Name</th><th>Ort</th><th>E-Mail</th><th class="right">Belege</th></tr></thead>
            <tbody>${rows.map(
              (r) => html`<tr class="rowlink" data-href="/contacts/${r.id}">
                <td class="mono">${r.customer_number}</td>
                <td><a href="/contacts/${r.id}">${contactLabel(r)}</a>${r.company && r.name ? html`<div class="muted small">${r.name}</div>` : ''}</td>
                <td>${[r.zip, r.city].filter(Boolean).join(' ')}</td>
                <td>${r.email}</td>
                <td class="right">${r.docs}</td></tr>`,
            )}</tbody></table></div>`
        : empty(q ? 'Keine Treffer.' : 'Noch keine Adressen.', q ? undefined : html`<a class="btn primary" href="/contacts/new">Erste Adresse anlegen</a>`)}`,
    });
  });

  app.get('/contacts/new', async (c) =>
    page(c, { title: 'Neue Adresse', back: { href: '/contacts', label: 'Adressen' }, body: contactForm(c, '/contacts', { country: 'DE' }) }),
  );

  app.post('/contacts', async (c) => {
    const t = tenantOf(c);
    const { v, errors } = parseContact(await readForm(c));
    if (errors.length) return redirectWith(c, '/contacts/new', 'error', errors.join(' '));
    const number = await nextNumber(t.id, 'customer', t.customer_number_format, today());
    const now = nowIso();
    const res = await run(
      `INSERT INTO contacts (tenant_id, customer_number, ${FIELDS.join(', ')}, created_at, updated_at)
       VALUES (?, ?, ${FIELDS.map(() => '?').join(', ')}, ?, ?)`,
      t.id, number, ...FIELDS.map((k) => v[k]), now, now,
    );
    return redirectWith(c, `/contacts/${res.insertId}`, 'ok', 'Adresse angelegt.');
  });

  app.get('/contacts/:id', async (c) => {
    const t = tenantOf(c);
    const ct = await getContact(t.id, idParam(c)) ?? notFound();
    const docs = await all('SELECT * FROM documents WHERE tenant_id = ? AND contact_id = ? ORDER BY issue_date DESC, id DESC', t.id, ct.id);
    const quotes = docs.filter((d) => d.kind === 'quote');
    const invoices = docs.filter((d) => d.kind === 'invoice');
    const address = [ct.company, ct.name, ct.street, ct.address_extra, [ct.zip, ct.city].filter(Boolean).join(' '), ct.country !== 'DE' ? ct.country : '']
      .filter(Boolean);
    return page(c, {
      title: contactLabel(ct),
      back: { href: '/contacts', label: 'Adressen' },
      actions: html`
        <a class="btn" href="/quotes/new?contact=${ct.id}">Neues Angebot</a>
        <a class="btn" href="/invoices/new?contact=${ct.id}">Neue Rechnung</a>
        <a class="btn ghost" href="/contacts/${ct.id}/edit">Bearbeiten</a>`,
      body: html`
      ${ct.archived ? html`<div class="notice">Diese Adresse ist archiviert.</div>` : ''}
      <div class="detail-grid">
        <section class="card">
          <h2>Anschrift</h2>
          <address>${address.map((l) => html`${l}<br>`)}</address>
        </section>
        <section class="card">
          <h2>Daten</h2>
          <dl class="dl">
            <dt>Kundennummer</dt><dd class="mono">${ct.customer_number}</dd>
            ${ct.email ? html`<dt>E-Mail</dt><dd><a href="mailto:${ct.email}">${ct.email}</a></dd>` : ''}
            ${ct.phone ? html`<dt>Telefon</dt><dd>${ct.phone}</dd>` : ''}
            ${ct.vat_id ? html`<dt>USt-IdNr.</dt><dd>${ct.vat_id}</dd>` : ''}
            ${ct.leitweg_id ? html`<dt>Leitweg-ID</dt><dd>${ct.leitweg_id}</dd>` : ''}
          </dl>
          ${ct.notes ? html`<p class="notes">${ct.notes}</p>` : ''}
        </section>
      </div>
      <section>
        <h2 class="section-title">Angebote <span class="count">${quotes.length}</span></h2>
        ${quotes.length ? documentTable(quotes, 'quote', false) : html`<p class="muted">Noch keine Angebote.</p>`}
      </section>
      <section>
        <h2 class="section-title">Rechnungen <span class="count">${invoices.length}</span></h2>
        ${invoices.length ? documentTable(invoices, 'invoice', false) : html`<p class="muted">Noch keine Rechnungen.</p>`}
      </section>`,
    });
  });

  app.get('/contacts/:id/edit', async (c) => {
    const t = tenantOf(c);
    const ct = await getContact(t.id, idParam(c)) ?? notFound();
    const used = await one('SELECT 1 FROM documents WHERE contact_id = ? LIMIT 1', ct.id);
    return page(c, {
      title: 'Adresse bearbeiten',
      back: { href: `/contacts/${ct.id}`, label: contactLabel(ct) },
      body: html`${contactForm(c, `/contacts/${ct.id}`, ct)}
      <p class="muted small">Änderungen wirken sich nicht auf bereits festgeschriebene Rechnungen aus.</p>
      <div class="danger-zone">
        <form method="post" action="/contacts/${ct.id}/archive">${csrfField(c)}
          <button class="btn ghost">${ct.archived ? 'Aus Archiv holen' : 'Archivieren'}</button></form>
        ${used ? '' : html`<form method="post" action="/contacts/${ct.id}/delete" data-confirm="Adresse endgültig löschen?">${csrfField(c)}
          <button class="btn danger">Löschen</button></form>`}
      </div>`,
    });
  });

  app.post('/contacts/:id', async (c) => {
    const t = tenantOf(c);
    const ct = await getContact(t.id, idParam(c)) ?? notFound();
    const { v, errors } = parseContact(await readForm(c));
    if (errors.length) return redirectWith(c, `/contacts/${ct.id}/edit`, 'error', errors.join(' '));
    await run(
      `UPDATE contacts SET ${FIELDS.map((k) => `${k} = ?`).join(', ')}, updated_at = ? WHERE id = ? AND tenant_id = ?`,
      ...FIELDS.map((k) => v[k]), nowIso(), ct.id, t.id,
    );
    return redirectWith(c, `/contacts/${ct.id}`, 'ok', 'Adresse gespeichert.');
  });

  app.post('/contacts/:id/archive', async (c) => {
    const t = tenantOf(c);
    const ct = await getContact(t.id, idParam(c)) ?? notFound();
    await run('UPDATE contacts SET archived = ?, updated_at = ? WHERE id = ?', ct.archived ? 0 : 1, nowIso(), ct.id);
    return redirectWith(c, `/contacts/${ct.id}`, 'ok', ct.archived ? 'Adresse wiederhergestellt.' : 'Adresse archiviert.');
  });

  app.post('/contacts/:id/delete', async (c) => {
    const t = tenantOf(c);
    const ct = await getContact(t.id, idParam(c)) ?? notFound();
    if (await one('SELECT 1 FROM documents WHERE contact_id = ? LIMIT 1', ct.id)) {
      return redirectWith(c, `/contacts/${ct.id}`, 'error', 'Adressen mit Belegen können nur archiviert werden.');
    }
    await run('DELETE FROM contacts WHERE id = ? AND tenant_id = ?', ct.id, t.id);
    return redirectWith(c, '/contacts', 'ok', 'Adresse gelöscht.');
  });
}

export const contactsModule: Module = {
  name: 'contacts',
  nav: { label: 'Adressen', href: '/contacts', order: 10 },
  register,
};
