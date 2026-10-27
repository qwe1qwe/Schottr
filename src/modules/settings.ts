import { all, one, run, tx, nowIso } from '../db/index.ts';
import { hashPassword } from '../lib/auth.ts';
import { html, checked, selected, type SafeHtml } from '../lib/html.ts';
import { readForm, str, redirectWith, requireOwner, tenantOf, userOf, idParam, notFound } from '../lib/http.ts';
import { isValidFormat } from '../lib/numbering.ts';
import { formatAmount, parseDecimal } from '../lib/money.ts';
import { formatDate } from '../lib/dates.ts';
import { audit } from '../lib/audit.ts';
import { getLogo } from '../lib/logo.ts';
import { canEmbedImage } from '../einvoice/pdf.ts';
import { isValidBic, isValidEmail, isValidIban, isValidVatId, normalizeIban, normalizeVatId, formatIban, isCountryCode } from '../lib/validate.ts';
import { csrfField, page } from '../views/layout.ts';
import { emailSchema, passwordSchema } from './auth.ts';
import { EXPENSE_CATEGORIES } from '../lib/expenses.ts';
import type { App, Ctx, Module, Tenant } from '../types.ts';

type Field = { key: keyof Tenant; label: string; type?: string; max?: number; hint?: string; textarea?: boolean; options?: [string, string][]; min?: number; max2?: number };

const sections: { title: string; text?: string; fields: Field[] }[] = [
  {
    title: 'Firma',
    fields: [
      { key: 'name', label: 'Firmenname', max: 200 },
      { key: 'contact_name', label: 'Ansprechpartner / Inhaber', max: 200, hint: 'Pflicht für XRechnung (Verkäuferkontakt)' },
      { key: 'street', label: 'Straße und Hausnummer', max: 200 },
      { key: 'zip', label: 'PLZ', max: 10 },
      { key: 'city', label: 'Ort', max: 100 },
      { key: 'country', label: 'Land (ISO-Code)', max: 2 },
    ],
  },
  {
    title: 'Kontakt',
    fields: [
      { key: 'email', label: 'E-Mail', type: 'email', max: 200, hint: 'Pflicht für XRechnung' },
      { key: 'phone', label: 'Telefon', max: 50, hint: 'Pflicht für XRechnung' },
      { key: 'website', label: 'Website', max: 200 },
    ],
  },
  {
    title: 'Steuern & Register',
    text: 'Auf jeder Rechnung muss die Steuernummer oder die USt-IdNr. stehen (§ 14 Abs. 4 Nr. 2 UStG) – eine der beiden genügt. Kleinunternehmer ohne USt-IdNr. tragen einfach nur die Steuernummer ein.',
    fields: [
      { key: 'tax_number', label: 'Steuernummer', max: 30 },
      { key: 'vat_id', label: 'USt-IdNr. (optional)', max: 20, hint: 'z. B. DE123456789 – nur nötig, wenn vorhanden oder für Reverse Charge' },
      { key: 'managing_directors', label: 'Geschäftsführer', max: 200, hint: 'bei GmbH/UG Pflichtangabe (§ 35a GmbHG)' },
      { key: 'register_court', label: 'Registergericht', max: 100, hint: 'z. B. Amtsgericht München' },
      { key: 'register_number', label: 'Registernummer', max: 50, hint: 'z. B. HRB 123456' },
    ],
  },
  {
    title: 'Bankverbindung',
    fields: [
      { key: 'bank_name', label: 'Bank', max: 100 },
      { key: 'iban', label: 'IBAN', max: 40 },
      { key: 'bic', label: 'BIC', max: 11 },
    ],
  },
  {
    title: 'Nummernkreise',
    text: 'Platzhalter: {YYYY} Jahr, {YY} Jahr zweistellig, {MM} Monat, {NNNN} laufende Nummer (Anzahl N = Stellen). Mit Jahr im Format beginnt die Zählung jährlich neu.',
    fields: [
      { key: 'quote_number_format', label: 'Angebotsnummer', max: 40 },
      { key: 'invoice_number_format', label: 'Rechnungsnummer', max: 40 },
      { key: 'customer_number_format', label: 'Kundennummer', max: 40 },
      { key: 'supplier_number_format', label: 'Lieferantennummer', max: 40 },
    ],
  },
  {
    title: 'Mahnwesen',
    text: 'Stufe 1 = Zahlungserinnerung, Stufe 2 = 1. Mahnung, Stufe 3 = 2. (letzte) Mahnung. Mahngebühren sind kein Entgelt und daher ohne Umsatzsteuer. Für jede Mahnung lassen sich die Werte noch anpassen.',
    fields: [
      { key: 'dunning_fee_1', label: 'Gebühr Zahlungserinnerung (€)', type: 'money' },
      { key: 'dunning_fee_2', label: 'Gebühr 1. Mahnung (€)', type: 'money' },
      { key: 'dunning_fee_3', label: 'Gebühr 2. Mahnung (€)', type: 'money' },
      { key: 'dunning_deadline_days', label: 'Zahlungsfrist in der Mahnung (Tage)', type: 'number' },
      { key: 'dunning_interval_days', label: 'Kulanz nach Fälligkeit bzw. Frist (Tage)', type: 'number', hint: 'erst danach wird die nächste Mahnstufe vorgeschlagen' },
    ],
  },
  {
    title: 'DATEV-Export',
    text: 'Angaben für den Buchungsstapel an den Steuerberater. Berater- und Mandantennummer erfährst du von deiner Kanzlei. Standard-Erlöskonten: SKR03 – 8400 (19 %), 8300 (7 %), 8195 (Kleinunternehmer), 8337 (§ 13b), 8100 (steuerfrei); SKR04 – 4400, 4300, 4185, 4337, 4100.',
    fields: [
      { key: 'datev_consultant', label: 'Beraternummer', max: 7 },
      { key: 'datev_client', label: 'Mandantennummer', max: 5 },
      { key: 'datev_skr', label: 'Kontenrahmen', options: [['03', 'SKR03'], ['04', 'SKR04']] },
      { key: 'datev_account_length', label: 'Sachkontenlänge', type: 'number', min: 4, max2: 8, hint: 'meist 4' },
      { key: 'datev_debtor_mode', label: 'Debitoren', options: [['collective', 'Sammeldebitor'], ['individual', 'Debitor je Kunde']] },
      { key: 'datev_debtor_account', label: 'Debitorenkonto bzw. Startnummer', type: 'number', min: 1, max2: 999999999, hint: 'Sammeldebitor z. B. 10000; je Kunde: Startnummer + Ziffern der Kundennummer' },
      { key: 'datev_accounts', label: 'Abweichende Erlöskonten (optional)', max: 200, hint: 'z. B. 19=8400, 7=8300, ku=8195, rc=8337, frei=8100' },
    ],
  },
  {
    title: 'DATEV-Export: Eingangsrechnungen',
    text: `Eingangsrechnungen werden je Steuersatz als Buchung Kreditor an Aufwandskonto übergeben, die Vorsteuer über den BU-Schlüssel (9 = 19 %, 8 = 7 %). Als Kleinunternehmer wird der Bruttobetrag ohne Vorsteuer gebucht. Standard-Aufwandskonten je Kostenart (SKR03 / SKR04): ${EXPENSE_CATEGORIES.map((x) => `${x.label} ${x.skr03} / ${x.skr04}`).join(' · ')}. Am besten einmal mit der Kanzlei abstimmen.`,
    fields: [
      { key: 'datev_creditor_mode', label: 'Kreditoren', options: [['collective', 'Sammelkreditor'], ['individual', 'Kreditor je Lieferant']] },
      { key: 'datev_creditor_account', label: 'Kreditorenkonto bzw. Startnummer', type: 'number', min: 1, max2: 999999999, hint: 'Sammelkreditor z. B. 70000; je Lieferant: Startnummer + Ziffern der Lieferantennummer' },
      { key: 'datev_expense_accounts', label: 'Abweichende Aufwandskonten (optional)', max: 400, hint: `Kürzel: ${EXPENSE_CATEGORIES.map((x) => x.key).join(', ')} – z. B. buero=4930, software=4964` },
    ],
  },
  {
    title: 'Vorgaben',
    fields: [
      { key: 'payment_days', label: 'Zahlungsziel (Tage)', type: 'number' },
      { key: 'quote_valid_days', label: 'Angebot gültig (Tage)', type: 'number' },
      { key: 'skonto_percent', label: 'Skonto (%)', type: 'money', hint: 'Vorgabe für neue Rechnungen, leer = kein Skonto' },
      { key: 'skonto_days', label: 'Skonto bei Zahlung binnen … Tagen', type: 'number' },
      { key: 'quote_intro', label: 'Einleitungstext Angebot', textarea: true, max: 2000 },
      { key: 'quote_outro', label: 'Schlusstext Angebot', textarea: true, max: 2000 },
      { key: 'invoice_intro', label: 'Einleitungstext Rechnung', textarea: true, max: 2000 },
      { key: 'invoice_outro', label: 'Schlusstext Rechnung', textarea: true, max: 2000 },
    ],
  },
];

function field(t: Tenant, f: Field, disabled: boolean): SafeHtml {
  const value = t[f.key] as string | number;
  const attrs = html`name="${f.key}" ${f.max ? html`maxlength="${f.max}"` : ''} ${disabled ? html`disabled` : ''}`;
  if (f.options) {
    return html`<label>${f.label}
      <select name="${f.key}" ${disabled ? html`disabled` : ''}>${f.options.map(([v, l]) => html`<option value="${v}"${selected(v, value)}>${l}</option>`)}</select>
      ${f.hint ? html`<small class="muted">${f.hint}</small>` : ''}</label>`;
  }
  return html`<label class="${f.textarea ? 'span-2' : ''}">${f.label}
    ${f.textarea
      ? html`<textarea ${attrs} rows="3">${value}</textarea>`
      : html`<input type="${f.type === 'money' ? 'text' : (f.type ?? 'text')}" ${attrs} value="${f.type === 'money' ? formatAmount(Number(value)).replace(/\./g, '') : f.key === 'iban' && value ? formatIban(String(value)) : value}" ${f.type === 'number' ? html`min="${f.min ?? 0}" max="${f.max2 ?? 365}"` : ''} ${f.type === 'money' ? html`inputmode="decimal" class="num"` : ''}>`}
    ${f.hint ? html`<small class="muted">${f.hint}</small>` : ''}
  </label>`;
}

/** Prüft die Firmendaten und liefert Fehlermeldungen. */
export function tenantProblems(t: Tenant): string[] {
  const p: string[] = [];
  if (!t.name) p.push('Firmenname');
  if (!t.street || !t.zip || !t.city) p.push('vollständige Anschrift');
  if (!t.tax_number && !t.vat_id) p.push(t.small_business ? 'Steuernummer' : 'Steuernummer (oder alternativ USt-IdNr.)');
  if (!t.iban) p.push('IBAN');
  if (!t.contact_name) p.push('Ansprechpartner');
  if (!t.email) p.push('E-Mail');
  if (!t.phone) p.push('Telefon');
  return p;
}

function register(app: App) {
  app.get('/settings', async (c) => {
    const t = tenantOf(c);
    const owner = c.get('role') === 'owner';
    const problems = tenantProblems(t);
    const logo = await one<{ updated: string }>('SELECT UNIX_TIMESTAMP(updated_at) AS updated FROM tenant_logos WHERE tenant_id = ?', t.id);
    return page(c, {
      title: 'Einstellungen',
      actions: html`<a class="btn" href="/settings/users">Benutzer</a>`,
      body: html`
      ${problems.length
        ? html`<div class="notice">Für E-Rechnungen fehlen noch: <strong>${problems.join(', ')}</strong>.</div>`
        : ''}
      ${owner ? '' : html`<p class="muted">Nur Inhaber können die Firmendaten ändern.</p>`}
      <section class="card logo-card">
        <h2>Logo</h2>
        <div class="logo-row">
          ${logo ? html`<img src="/settings/logo?v=${logo.updated}" alt="Firmenlogo" class="logo-preview">` : html`<div class="logo-placeholder muted small">kein Logo</div>`}
          ${owner
            ? html`<div class="stack">
                <form method="post" action="/settings/logo" enctype="multipart/form-data" class="logo-form">
                  ${csrfField(c)}
                  <input type="file" name="logo" accept="image/png,image/jpeg" required aria-label="Logo-Datei">
                  <button class="btn">${logo ? 'Ersetzen' : 'Hochladen'}</button>
                </form>
                <small class="muted">PNG (auch transparent) oder JPEG, max. 1 MB. Erscheint oben rechts auf Angeboten, Rechnungen und Mahnungen (max. 60 × 22 mm).</small>
                ${logo ? html`<form method="post" action="/settings/logo/delete" data-confirm="Logo entfernen?">${csrfField(c)}<button class="link danger">Logo entfernen</button></form>` : ''}
              </div>`
            : ''}
        </div>
      </section>
      <form method="post" action="/settings" class="settings">
        ${csrfField(c)}
        ${sections.map(
          (s) => html`<fieldset class="card">
            <legend>${s.title}</legend>
            ${s.text ? html`<p class="muted small">${s.text}</p>` : ''}
            <div class="grid-2">${s.fields.map((f) => field(t, f, !owner))}</div>
          </fieldset>`,
        )}
        <fieldset class="card">
          <legend>Umsatzsteuer</legend>
          <label class="check"><input type="checkbox" name="small_business" value="1"${checked(t.small_business)} ${owner ? '' : html`disabled`}>
            Kleinunternehmer nach § 19 UStG (keine Umsatzsteuer ausweisen)</label>
        </fieldset>
        ${owner ? html`<div class="form-actions"><button class="btn primary">Speichern</button></div>` : ''}
      </form>`,
    });
  });

  app.post('/settings', async (c) => {
    requireOwner(c);
    const t = tenantOf(c);
    const form = await readForm(c);
    const v: Record<string, string | number> = {};
    const errors0: string[] = [];
    for (const s of sections) for (const f of s.fields) v[f.key] = str(form, f.key, f.max ?? 2000);
    v.iban = normalizeIban(String(v.iban));
    v.bic = String(v.bic).replace(/\s+/g, '').toUpperCase();
    v.vat_id = normalizeVatId(String(v.vat_id));
    v.country = String(v.country || 'DE').toUpperCase();
    v.payment_days = Math.max(0, Math.min(365, Number(v.payment_days) || 0));
    v.quote_valid_days = Math.max(0, Math.min(365, Number(v.quote_valid_days) || 0));
    v.dunning_deadline_days = Math.max(1, Math.min(365, Number(v.dunning_deadline_days) || 10));
    v.dunning_interval_days = Math.max(0, Math.min(365, Number(v.dunning_interval_days) || 0));
    const skonto = parseDecimal(String(v.skonto_percent || '0'), 2);
    if (skonto === null || skonto < 0 || skonto > 2000) errors0.push('Skonto: Prozentsatz zwischen 0 und 20 angeben.');
    v.skonto_percent = skonto ?? 0;
    v.skonto_days = Math.max(0, Math.min(365, Number(v.skonto_days) || 0));
    if ((Number(v.skonto_percent) > 0) !== (Number(v.skonto_days) > 0)) errors0.push('Skonto: bitte Prozentsatz und Tage angeben (oder beides leer lassen).');
    v.datev_skr = v.datev_skr === '04' ? '04' : '03';
    v.datev_debtor_mode = v.datev_debtor_mode === 'individual' ? 'individual' : 'collective';
    v.datev_account_length = Math.max(4, Math.min(8, Number(v.datev_account_length) || 4));
    v.datev_debtor_account = Math.max(1, Math.min(999999999, Number(v.datev_debtor_account) || 10000));
    v.supplier_number_format = v.supplier_number_format || 'L{NNNNN}';
    v.datev_creditor_mode = v.datev_creditor_mode === 'individual' ? 'individual' : 'collective';
    v.datev_creditor_account = Math.max(1, Math.min(999999999, Number(v.datev_creditor_account) || 70000));
    if (v.datev_expense_accounts) {
      const keys = new Set<string>(EXPENSE_CATEGORIES.map((x) => x.key));
      const parts = String(v.datev_expense_accounts).split(',').map((x) => x.trim()).filter(Boolean);
      if (parts.some((p) => !/^\w+\s*=\s*\d{3,9}$/.test(p) || !keys.has(p.split('=')[0].trim().toLowerCase()))) {
        errors0.push(`Aufwandskonten bitte im Format „buero=4930, software=4964“ (Kürzel: ${[...keys].join(', ')}).`);
      }
    }
    if (v.datev_consultant && !/^\d{4,7}$/.test(String(v.datev_consultant))) errors0.push('DATEV-Beraternummer: 4–7 Ziffern.');
    if (v.datev_client && !/^\d{1,5}$/.test(String(v.datev_client))) errors0.push('DATEV-Mandantennummer: 1–5 Ziffern.');
    if (v.datev_accounts && !/^\s*(\w+\s*=\s*\d{3,9}\s*,?\s*)*$/.test(String(v.datev_accounts))) errors0.push('Erlöskonten bitte im Format „19=8400, 7=8300“.');
    for (const k of ['dunning_fee_1', 'dunning_fee_2', 'dunning_fee_3']) {
      const fee = parseDecimal(String(v[k] || '0'), 2);
      if (fee === null || fee < 0 || fee > 100_000) errors0.push('Ungültige Mahngebühr.');
      v[k] = fee ?? 0;
    }
    v.small_business = str(form, 'small_business') === '1' ? 1 : 0;

    const errors: string[] = [...errors0];
    if (!v.name) errors.push('Firmenname darf nicht leer sein.');
    if (!isCountryCode(String(v.country))) errors.push('Land bitte als zweistelligen ISO-Code (z. B. DE).');
    if (v.iban && !isValidIban(String(v.iban))) errors.push('Die IBAN ist ungültig.');
    if (v.bic && !isValidBic(String(v.bic))) errors.push('Die BIC ist ungültig.');
    if (v.vat_id && !isValidVatId(String(v.vat_id))) errors.push('Die USt-IdNr. hat kein gültiges Format.');
    if (v.email && !isValidEmail(String(v.email))) errors.push('Die E-Mail-Adresse ist ungültig.');
    for (const k of ['quote_number_format', 'invoice_number_format', 'customer_number_format', 'supplier_number_format']) {
      if (!isValidFormat(String(v[k]))) errors.push(`Nummernformat „${v[k]}“ braucht einen Platzhalter {NNN…}.`);
    }
    if (errors.length) return redirectWith(c, '/settings', 'error', errors.join(' '));

    const keys = Object.keys(v);
    await run(
      `UPDATE tenants SET ${keys.map((k) => `${k} = ?`).join(', ')} WHERE id = ?`,
      ...keys.map((k) => v[k]), t.id,
    );
    await audit(c, 'settings.update');
    return redirectWith(c, '/settings', 'ok', 'Einstellungen gespeichert.');
  });

  app.get('/settings/logo', async (c) => {
    const logo = await getLogo(tenantOf(c).id);
    if (!logo) notFound();
    return c.body(new Uint8Array(logo.data), 200, { 'Content-Type': logo.mime, 'Cache-Control': 'private, max-age=86400' });
  });

  app.post('/settings/logo', async (c) => {
    requireOwner(c);
    const t = tenantOf(c);
    const body = await c.req.parseBody();
    const file = body.logo;
    if (!(file instanceof File) || !file.size) return redirectWith(c, '/settings', 'error', 'Bitte eine Bilddatei auswählen.');
    if (file.size > 1024 * 1024) return redirectWith(c, '/settings', 'error', 'Das Logo darf höchstens 1 MB groß sein.');
    const data = Buffer.from(await file.arrayBuffer());
    const mime = data.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))
      ? 'image/png'
      : data[0] === 0xff && data[1] === 0xd8 ? 'image/jpeg' : null;
    if (!mime) return redirectWith(c, '/settings', 'error', 'Bitte ein PNG- oder JPEG-Bild hochladen.');
    if (!canEmbedImage(data)) return redirectWith(c, '/settings', 'error', 'Dieses Bild kann nicht ins PDF übernommen werden (z. B. interlaced PNG). Bitte anders speichern.');
    await run(
      'INSERT INTO tenant_logos (tenant_id, data, mime, updated_at) VALUES (?, ?, ?, ?) ON DUPLICATE KEY UPDATE data = VALUES(data), mime = VALUES(mime), updated_at = VALUES(updated_at)',
      t.id, data, mime, nowIso(),
    );
    await audit(c, 'settings.logo', `${mime}, ${Math.round(data.length / 1024)} KB`);
    return redirectWith(c, '/settings', 'ok', 'Logo gespeichert. Es erscheint auf allen neuen PDFs.');
  });

  app.post('/settings/logo/delete', async (c) => {
    requireOwner(c);
    await run('DELETE FROM tenant_logos WHERE tenant_id = ?', tenantOf(c).id);
    return redirectWith(c, '/settings', 'ok', 'Logo entfernt.');
  });

  app.get('/settings/users', async (c) => {
    const t = tenantOf(c);
    const owner = c.get('role') === 'owner';
    const me = userOf(c);
    const users = await all(
      'SELECT u.id, u.name, u.email, m.role FROM memberships m JOIN users u ON u.id = m.user_id WHERE m.tenant_id = ? ORDER BY u.name',
      t.id,
    );
    const invites = await all(
      `SELECT i.id, i.email, i.role, i.created_at, (SELECT 1 FROM users u WHERE u.email = i.email) AS has_account
       FROM invitations i WHERE i.tenant_id = ? AND i.status = 'pending' ORDER BY i.created_at`,
      t.id,
    );
    const roleLabel = (r: string) => (r === 'owner' ? 'Inhaber' : 'Mitglied');
    return page(c, {
      title: 'Benutzer',
      back: { href: '/settings', label: 'Einstellungen' },
      body: html`
      <section class="card flush">
        <table class="table">
          <thead><tr><th>Name</th><th>E-Mail</th><th>Rolle</th><th></th></tr></thead>
          <tbody>${users.map(
            (u) => html`<tr><td>${u.name}</td><td>${u.email}</td><td>${roleLabel(u.role)}</td>
            <td class="right">${owner && u.id !== me.id
              ? html`<form method="post" action="/settings/users/${u.id}/remove" data-confirm="Benutzer aus diesem Mandanten entfernen?">${csrfField(c)}<button class="link danger">Entfernen</button></form>`
              : ''}</td></tr>`,
          )}</tbody>
        </table>
      </section>
      ${invites.length
        ? html`<h2 class="section-title">Offene Einladungen <span class="count">${invites.length}</span></h2>
          <section class="card flush"><table class="table">
            <thead><tr><th>E-Mail</th><th>Rolle</th><th>Eingeladen am</th><th></th></tr></thead>
            <tbody>${invites.map((i) => html`<tr>
              <td>${i.email}${i.has_account ? '' : html`<div class="muted small">noch kein Konto – die Einladung erscheint, sobald eines existiert</div>`}</td>
              <td>${roleLabel(i.role)}</td><td>${formatDate(String(i.created_at).slice(0, 10))}</td>
              <td class="right">${owner
                ? html`<form method="post" action="/settings/invitations/${i.id}/revoke">${csrfField(c)}<button class="link danger">Zurückziehen</button></form>`
                : ''}</td></tr>`)}
            </tbody></table></section>`
        : ''}
      ${owner
        ? html`<div class="detail-grid">
          <section class="card">
            <h2>Benutzer einladen</h2>
            <p class="muted small">Die Person sieht die Einladung nach der Anmeldung in ihrer Übersicht und kann sie dort annehmen – ganz ohne E-Mail-Versand.</p>
            <form method="post" action="/settings/invitations" class="stack">
              ${csrfField(c)}
              <label>E-Mail-Adresse <input type="email" name="email" required maxlength="200"></label>
              <label>Rolle <select name="role"><option value="member">Mitglied</option><option value="owner">Inhaber</option></select></label>
              <button class="btn primary">Einladen</button>
            </form>
          </section>
          <section class="card">
            <h2>Neues Konto anlegen</h2>
            <p class="muted small">Für Personen ohne Schottr-Zugang: Du vergibst ein Startpasswort und teilst es ihr persönlich mit.</p>
            <form method="post" action="/settings/users" class="stack">
              ${csrfField(c)}
              <label>Name <input name="name" maxlength="200"></label>
              <label>E-Mail <input type="email" name="email" required></label>
              <label>Startpasswort <input type="password" name="password" minlength="10" required autocomplete="new-password"></label>
              <label>Rolle <select name="role"><option value="member">Mitglied</option><option value="owner">Inhaber</option></select></label>
              <button class="btn">Konto anlegen</button>
            </form>
          </section></div>`
        : ''}`,
    });
  });

  app.post('/settings/users', async (c) => {
    requireOwner(c);
    const t = tenantOf(c);
    const form = await readForm(c);
    const email = str(form, 'email', 200).toLowerCase();
    const role = str(form, 'role') === 'owner' ? 'owner' : 'member';
    if (!emailSchema.safeParse(email).success) return redirectWith(c, '/settings/users', 'error', 'Ungültige E-Mail-Adresse.');
    if (await one('SELECT id FROM users WHERE email = ?', email)) {
      return redirectWith(c, '/settings/users', 'error', 'Für diese E-Mail gibt es bereits ein Konto – bitte stattdessen einladen.');
    }
    const pw = passwordSchema.safeParse(str(form, 'password', 200));
    if (!pw.success) return redirectWith(c, '/settings/users', 'error', pw.error.issues[0].message);
    const hash = await hashPassword(pw.data);
    await tx(async () => {
      const res = await run('INSERT INTO users (email, name, password_hash, created_at) VALUES (?, ?, ?, ?)', email, str(form, 'name', 200), hash, nowIso());
      await run('INSERT INTO memberships (user_id, tenant_id, role) VALUES (?, ?, ?)', res.insertId, t.id, role);
    });
    await audit(c, 'member.create', `${email} als ${role === 'owner' ? 'Inhaber' : 'Mitglied'}`);
    return redirectWith(c, '/settings/users', 'ok', 'Konto angelegt.');
  });

  app.post('/settings/users/:id/remove', async (c) => {
    requireOwner(c);
    const t = tenantOf(c);
    const id = idParam(c);
    if (id === userOf(c).id) return redirectWith(c, '/settings/users', 'error', 'Du kannst dich nicht selbst entfernen.');
    await tx(async () => {
      await run('DELETE FROM memberships WHERE user_id = ? AND tenant_id = ?', id, t.id);
      await run('UPDATE sessions SET tenant_id = NULL WHERE user_id = ? AND tenant_id = ?', id, t.id);
    });
    await audit(c, 'member.remove', `Benutzer ${id}`);
    return redirectWith(c, '/settings/users', 'ok', 'Benutzer entfernt.');
  });
}

export const settingsModule: Module = {
  name: 'settings',
  nav: { label: 'Einstellungen', href: '/settings', order: 90 },
  register,
};

export type { Ctx };
