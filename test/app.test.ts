import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import mysql from 'mysql2/promise';
import { openDatabase, closeDatabase, one, all, run } from '../src/db/index.ts';
import { createApp } from '../src/app.ts';

/**
 * Durchlauf über die HTTP-Schnittstelle gegen eine MariaDB-Testdatenbank
 * (TEST_DATABASE_URL, z. B. mysql://schottr:schottr@127.0.0.1:3306/schottr_test).
 * ACHTUNG: Alle Tabellen dieser Datenbank werden vor dem Test gelöscht.
 * Ohne TEST_DATABASE_URL wird der Test übersprungen.
 * Registrierung → Firmendaten → Adresse → Angebot → Rechnung → Festschreiben → Storno.
 */
let app: ReturnType<typeof createApp>;
let cookie = '';
let csrf = '';

const TEST_DB = process.env.TEST_DATABASE_URL;
const opts = { skip: TEST_DB ? false : 'TEST_DATABASE_URL nicht gesetzt' };

before(async () => {
  if (!TEST_DB) return;
  // frische Testdatenbank: alle Tabellen löschen
  const conn = await mysql.createConnection({ uri: TEST_DB, multipleStatements: true });
  const [tables] = await conn.query<mysql.RowDataPacket[]>('SELECT table_name AS t FROM information_schema.tables WHERE table_schema = DATABASE()');
  await conn.query('SET FOREIGN_KEY_CHECKS = 0');
  for (const { t } of tables) await conn.query(`DROP TABLE \`${t}\``);
  await conn.query('SET FOREIGN_KEY_CHECKS = 1');
  await conn.end();
  await openDatabase(TEST_DB, { retries: 1 });
  app = createApp();
});

after(async () => {
  if (TEST_DB) await closeDatabase();
});

async function req(path: string, init: { method?: string; form?: Record<string, string | string[]> } = {}) {
  const headers: Record<string, string> = { cookie };
  let body: URLSearchParams | undefined;
  if (init.form) {
    body = new URLSearchParams();
    if (csrf) body.append('_csrf', csrf);
    for (const [k, v] of Object.entries(init.form)) for (const x of [v].flat()) body.append(k, x);
    headers['content-type'] = 'application/x-www-form-urlencoded';
  }
  const res = await app.request(path, { method: init.method ?? (body ? 'POST' : 'GET'), headers, body });
  for (const c of res.headers.getSetCookie()) {
    const [pair] = c.split(';');
    const [name, value] = pair.split('=');
    if (name === 'schottr_sid') cookie = value ? `schottr_sid=${value}` : '';
  }
  return res;
}

async function refreshCsrf() {
  const html = await (await req('/account')).text();
  csrf = /name="_csrf" value="([^"]+)"/.exec(html)![1];
}

const location = (res: Response) => res.headers.get('location') ?? '';

test('Gesamter Ablauf', opts, async () => {
  let res = await req('/register', {
    form: { company: 'Test GmbH', name: 'Tina Test', email: 'tina@example.com', password: 'langes-passwort-1' },
  });
  assert.equal(res.status, 303);
  await refreshCsrf();

  res = await req('/settings', {
    form: {
      name: 'Test GmbH', contact_name: 'Tina Test', street: 'Weg 1', zip: '12345', city: 'Teststadt', country: 'DE',
      email: 'tina@example.com', phone: '0301234567', website: '', tax_number: '12/345/67890', vat_id: 'DE123456789',
      managing_directors: 'Tina Test', register_court: '', register_number: '', bank_name: 'Bank',
      iban: 'DE02120300000000202051', bic: '', quote_number_format: 'AN-{YYYY}-{NNNN}',
      invoice_number_format: 'RE-{YYYY}-{NNNN}', customer_number_format: 'K{NNNNN}', payment_days: '14',
      quote_valid_days: '30', quote_intro: '', quote_outro: '', invoice_intro: 'Hallo', invoice_outro: '',
    },
  });
  assert.equal(location(res), '/settings');

  res = await req('/contacts', { form: { company: 'Kunde AG', street: 'Str. 2', zip: '54321', city: 'Ort', country: 'DE', email: 'k@example.com' } });
  const contactId = location(res).split('/').pop()!;
  assert.match(contactId, /^\d+$/);

  res = await req('/quotes', {
    form: {
      contact_id: contactId, issue_date: '2026-10-27', valid_until: '2026-11-26', subject: 'Test',
      'item_title[]': ['Arbeit', 'Material'], 'item_description[]': ['', ''], 'item_quantity[]': ['2', '1,5'],
      'item_unit[]': ['HUR', 'KGM'], 'item_price[]': ['80', '10,00'], 'item_vat[]': ['1900', '700'],
    },
  });
  const quoteId = location(res).split('/').pop()!;
  const quote = (await one('SELECT * FROM documents WHERE id = ?', Number(quoteId)))!;
  assert.equal(quote.number, 'AN-2026-0001');
  assert.equal(quote.gross_total, 19040 + 1605);

  res = await req(`/quotes/${quoteId}/invoice`, { form: {} });
  const invoiceId = location(res).split('/').pop()!;
  const draft = (await one('SELECT * FROM documents WHERE id = ?', Number(invoiceId)))!;
  assert.equal(draft.number, null);
  assert.equal(draft.status, 'draft');

  res = await req(`/invoices/${invoiceId}/finalize`, { form: {} });
  const inv = (await one('SELECT * FROM documents WHERE id = ?', Number(invoiceId)))!;
  assert.equal(inv.status, 'open');
  assert.match(inv.number, /^RE-\d{4}-0001$/);
  assert.ok(inv.pdf && inv.xml);

  // GoBD: Datenbank verweigert Änderungen
  await assert.rejects(run('UPDATE documents SET gross_total = 1 WHERE id = ?', inv.id), /Festgeschriebene/);
  await assert.rejects(run('DELETE FROM documents WHERE id = ?', inv.id), /Festgeschriebene/);
  await assert.rejects(run('UPDATE document_items SET title = ? WHERE document_id = ?', 'x', inv.id), /Positionen/);
  await assert.rejects(run('DELETE FROM document_items WHERE document_id = ?', inv.id), /Positionen/);

  res = await req(`/invoices/${invoiceId}/xrechnung.xml`);
  const xml = await res.text();
  assert.match(xml, /urn:xeinkauf\.de:kosit:xrechnung_3\.0/);
  assert.match(xml, /<ram:GrandTotalAmount>206\.45<\/ram:GrandTotalAmount>/);

  res = await req(`/invoices/${invoiceId}/pdf`);
  assert.equal(res.headers.get('content-type'), 'application/pdf');
  const pdf = Buffer.from(await res.arrayBuffer()).toString('latin1');
  assert.match(pdf, /factur-x\.xml/);
  assert.match(pdf, /pdfaid:part>3</);

  res = await req(`/invoices/${invoiceId}/cancel`, { form: {} });
  const storno = (await one("SELECT * FROM documents WHERE type_code = '381'"))!;
  assert.equal(storno.status, 'settled');
  assert.equal(storno.corrects_id, inv.id);
  assert.equal((await one('SELECT status FROM documents WHERE id = ?', inv.id))!.status, 'cancelled');

  // ohne CSRF-Token abgelehnt
  const saved = csrf;
  csrf = '';
  res = await req('/contacts', { form: { company: 'X' } });
  assert.equal(res.status, 403);
  csrf = saved;
});

test('Mandantentrennung', opts, async () => {
  // zweiter Mandant desselben Benutzers sieht die Belege des ersten nicht
  let res = await req('/tenants', { form: { name: 'Zweitfirma' } });
  assert.equal(location(res), '/settings');
  res = await req('/invoices/1');
  assert.equal(res.status, 404);
  res = await req('/contacts');
  assert.doesNotMatch(await res.text(), /Kunde AG/);
});

test('Paralleles Festschreiben vergibt lückenlose, eindeutige Nummern', opts, async () => {
  // zurück zum ersten Mandanten
  const first = (await one<{ id: number }>("SELECT id FROM tenants WHERE name = 'Test GmbH'"))!;
  await req('/tenant/switch', { form: { tenant_id: String(first.id) } });
  const contact = (await one<{ id: number }>("SELECT id FROM contacts WHERE company = 'Kunde AG'"))!;
  const ids: string[] = [];
  for (let i = 0; i < 5; i++) {
    const res = await req('/invoices', {
      form: {
        contact_id: String(contact.id), issue_date: '2026-10-28', due_date: '2026-11-11', service_mode: 'date',
        service_date: '2026-10-28', 'item_title[]': `Leistung ${i}`, 'item_quantity[]': '1', 'item_unit[]': 'C62',
        'item_price[]': '100', 'item_vat[]': '1900', 'item_description[]': '',
      },
    });
    ids.push(location(res).split('/').pop()!);
  }
  await Promise.all(ids.map((id) => req(`/invoices/${id}/finalize`, { form: {} })));
  const numbers = (await Promise.all(ids.map((id) => one<{ number: string }>('SELECT number FROM documents WHERE id = ?', Number(id)))))
    .map((r) => r!.number)
    .sort();
  // RE-2026-0001 und -0002 sind Rechnung + Storno aus dem ersten Test
  assert.deepEqual(numbers, ['RE-2026-0003', 'RE-2026-0004', 'RE-2026-0005', 'RE-2026-0006', 'RE-2026-0007']);
});

test('Artikel, Mahnwesen und Einladungen', opts, async () => {
  const first = (await one<{ id: number }>("SELECT id FROM tenants WHERE name = 'Test GmbH'"))!;
  const second = (await one<{ id: number }>("SELECT id FROM tenants WHERE name = 'Zweitfirma'"))!;
  await req('/tenant/switch', { form: { tenant_id: String(first.id) } });

  // Artikel anlegen und in Rechnung verwenden (Artikelnummer → BT-155)
  let res = await req('/articles', { form: { number: 'A-1', title: 'Wartung', description: '', unit: 'LS', unit_price: '100', vat_rate: '1900' } });
  assert.equal(location(res), '/articles');
  const contact = (await one<{ id: number }>("SELECT id FROM contacts WHERE company = 'Kunde AG'"))!;
  res = await req('/invoices', {
    form: {
      contact_id: String(contact.id), issue_date: '2026-09-01', due_date: '2026-09-15', service_mode: 'date', service_date: '2026-09-01',
      'item_article[]': ['A-1', ''], 'item_title[]': ['Wartung', 'Freitext'], 'item_description[]': ['', ''],
      'item_quantity[]': ['1', '1'], 'item_unit[]': ['LS', 'C62'], 'item_price[]': ['100', '50'], 'item_vat[]': ['1900', '1900'],
    },
  });
  const invId = location(res).split('/').pop()!;
  await req(`/invoices/${invId}/finalize`, { form: {} });
  const xml = await (await req(`/invoices/${invId}/xrechnung.xml`)).text();
  assert.match(xml, /<ram:SellerAssignedID>A-1<\/ram:SellerAssignedID><ram:Name>Wartung<\/ram:Name>/);

  // Mahnwesen: überfällige Rechnung erscheint, drei Stufen, dann Schluss
  res = await req('/dunning');
  assert.match(await res.text(), new RegExp(`/invoices/${invId}/dunning/new`));
  for (const [level, date, deadline] of [[1, '2026-09-20', '2026-09-30'], [2, '2026-10-05', '2026-10-15'], [3, '2026-10-20', '2026-10-30']] as const) {
    res = await req(`/invoices/${invId}/dunning`, { form: { issue_date: date, deadline, fee: level === 1 ? '0' : '5,00', text: `Stufe ${level}` } });
    assert.equal(location(res), `/invoices/${invId}`);
  }
  const dunnings = await all('SELECT * FROM dunnings WHERE invoice_id = ? ORDER BY level', Number(invId));
  assert.deepEqual(dunnings.map((d) => [d.level, d.fee]), [[1, 0], [2, 500], [3, 500]]);
  res = await req(`/invoices/${invId}/dunning`, { form: { issue_date: '2026-10-31', deadline: '2026-11-10', fee: '0', text: 'x' } });
  assert.equal(await all('SELECT id FROM dunnings WHERE invoice_id = ?', Number(invId)).then((r) => r.length), 3);
  res = await req(`/dunnings/${dunnings[2].id}/pdf`);
  assert.equal(res.headers.get('content-type'), 'application/pdf');
  // nur die letzte Stufe darf gelöscht werden
  res = await req(`/dunnings/${dunnings[0].id}/delete`, { form: {} });
  assert.equal(await all('SELECT id FROM dunnings WHERE invoice_id = ?', Number(invId)).then((r) => r.length), 3);

  // Einladungen: Konto „Max“ existiert in der Zweitfirma …
  await req('/tenant/switch', { form: { tenant_id: String(second.id) } });
  res = await req('/settings/users', { form: { name: 'Max', email: 'max@example.com', password: 'max-passwort-123', role: 'member' } });
  assert.equal(location(res), '/settings/users');
  // … und wird in die Test GmbH eingeladen
  await req('/tenant/switch', { form: { tenant_id: String(first.id) } });
  await req('/settings/invitations', { form: { email: 'MAX@example.com', role: 'member' } });
  await req('/settings/invitations', { form: { email: 'fremd@example.com', role: 'member' } });
  const invites = await all("SELECT id, email FROM invitations WHERE status = 'pending' ORDER BY id");
  assert.deepEqual(invites.map((i) => i.email), ['max@example.com', 'fremd@example.com']);

  // Als Max anmelden
  const tina = { cookie, csrf };
  cookie = '';
  csrf = '';
  res = await req('/login', { form: { email: 'max@example.com', password: 'max-passwort-123' } });
  assert.equal(res.status, 303);
  await refreshCsrf();
  const dash = await (await req('/')).text();
  assert.match(dash, /Du wurdest eingeladen/);
  assert.match(dash, /Test GmbH/);
  // fremde Einladung kann nicht angenommen werden
  res = await req(`/invitations/${invites[1].id}/accept`, { form: {} });
  assert.equal(res.status, 404);
  res = await req(`/invitations/${invites[0].id}/accept`, { form: {} });
  assert.equal(location(res), '/');
  assert.ok(await one('SELECT 1 FROM memberships m JOIN users u ON u.id = m.user_id WHERE u.email = ? AND m.tenant_id = ?', 'max@example.com', first.id));
  assert.match(await (await req('/invoices')).text(), /RE-2026-/);
  ({ cookie, csrf } = tina);
});

test('Übergreifende Administration', opts, async () => {
  // Tina ist als erste Registrierte Administratorin
  assert.equal((await one<{ is_admin: number }>("SELECT is_admin FROM users WHERE email = 'tina@example.com'"))!.is_admin, 1);
  let res = await req('/admin');
  assert.equal(res.status, 200);
  for (const p of ['/admin/tenants', '/admin/users', '/admin/audit', '/admin/system']) assert.equal((await req(p)).status, 200, p);
  assert.match(await (await req('/admin/audit?action=login')).text(), /Anmeldung/);
  assert.match(await (await req('/admin/audit?action=invoice')).text(), /Rechnung festgeschrieben/);

  // Letzter Admin kann sich das Recht nicht entziehen lassen
  const tina = (await one<{ id: number }>("SELECT id FROM users WHERE email = 'tina@example.com'"))!;
  const max = (await one<{ id: number }>("SELECT id FROM users WHERE email = 'max@example.com'"))!;
  res = await req(`/admin/users/${tina.id}/disable`, { form: {} });
  assert.equal((await one<{ disabled: number }>('SELECT disabled FROM users WHERE id = ?', tina.id))!.disabled, 0);

  // Max als normaler Benutzer: kein Zugriff auf /admin
  const tinaSession = { cookie, csrf };
  cookie = '';
  csrf = '';
  await req('/login', { form: { email: 'max@example.com', password: 'max-passwort-123' } });
  await refreshCsrf();
  assert.equal((await req('/admin')).status, 403);
  const maxSession = { cookie, csrf };

  // Admin sperrt Max → Sitzung ungültig, Anmeldung verweigert
  ({ cookie, csrf } = tinaSession);
  await req(`/admin/users/${max.id}/disable`, { form: {} });
  ({ cookie, csrf } = maxSession);
  res = await req('/');
  assert.equal(location(res), '/login');
  cookie = '';
  csrf = '';
  res = await req('/login', { form: { email: 'max@example.com', password: 'max-passwort-123' } });
  assert.equal(res.status, 403);
  ({ cookie, csrf } = tinaSession);
  await req(`/admin/users/${max.id}/disable`, { form: {} }); // wieder entsperren

  // Mandant sperren → verschwindet aus der Auswahl, Daten bleiben
  const second = (await one<{ id: number }>("SELECT id FROM tenants WHERE name = 'Zweitfirma'"))!;
  await req(`/admin/tenants/${second.id}/disable`, { form: {} });
  res = await req('/tenant/switch', { form: { tenant_id: String(second.id) } });
  assert.doesNotMatch(await (await req('/')).text(), /<option value="\d+"[^>]*>Zweitfirma/);
  // Mandant mit Belegen kann nicht gelöscht werden
  const first = (await one<{ id: number }>("SELECT id FROM tenants WHERE name = 'Test GmbH'"))!;
  await req(`/admin/tenants/${first.id}/delete`, { form: {} });
  assert.ok(await one('SELECT 1 FROM tenants WHERE id = ?', first.id));

  // Registrierung über die Administration öffnen
  await req('/admin/system', { form: { allow_registration: '1' } });
  cookie = '';
  csrf = '';
  assert.equal((await req('/register')).status, 200);
  ({ cookie, csrf } = tinaSession);
  await req('/admin/system', { form: {} });
});
