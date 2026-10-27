import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
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

test('Teil-/Schlussrechnung, Skonto, Logo und Export', opts, async () => {
  const first = (await one<{ id: number }>("SELECT id FROM tenants WHERE name = 'Test GmbH'"))!;
  await req('/tenant/switch', { form: { tenant_id: String(first.id) } });
  const contact = (await one<{ id: number }>("SELECT id FROM contacts WHERE company = 'Kunde AG'"))!;
  const invoice = async (type: string, price: string, extra: Record<string, string | string[]> = {}) => {
    const res = await req('/invoices', {
      form: {
        contact_id: String(contact.id), type_code: type, issue_date: '2026-11-02', due_date: '2026-11-16', service_mode: 'date',
        service_date: '2026-11-01', 'item_title[]': `Leistung ${type}`, 'item_description[]': '', 'item_quantity[]': '1',
        'item_unit[]': 'LS', 'item_price[]': price, 'item_vat[]': '1900', ...extra,
      },
    });
    const id = location(res).split('/').pop()!;
    assert.match(id, /^\d+$/, `Rechnung ${type} angelegt`);
    return id;
  };

  // Teilrechnung 875 festschreiben
  const partialId = await invoice('875', '1000');
  await req(`/invoices/${partialId}/finalize`, { form: {} });
  const partial = (await one('SELECT * FROM documents WHERE id = ?', Number(partialId)))!;
  assert.equal(partial.type_code, '875');
  assert.equal(partial.gross_total, 119000);

  // Schlussrechnung 877 mit Abzug + 2 % Skonto / 10 Tage
  const finalId = await invoice('877', '3000', { 'prepayment_ids[]': partialId, skonto_percent: '2', skonto_days: '10' });
  await req(`/invoices/${finalId}/finalize`, { form: {} });
  const fin = (await one('SELECT * FROM documents WHERE id = ?', Number(finalId)))!;
  assert.equal(fin.status, 'open');
  assert.equal(fin.gross_total, 357000);
  assert.equal(fin.prepaid_total, 119000);
  const xml = await (await req(`/invoices/${finalId}/xrechnung.xml`)).text();
  assert.match(xml, /<ram:TypeCode>877<\/ram:TypeCode>/);
  assert.match(xml, /<ram:TotalPrepaidAmount>1190.00<\/ram:TotalPrepaidAmount><ram:DuePayableAmount>2380.00<\/ram:DuePayableAmount>/);
  assert.match(xml, /#SKONTO#TAGE=10#PROZENT=2.00#\n/);
  assert.match(xml, new RegExp(`<ram:InvoiceReferencedDocument><ram:IssuerAssignedID>${partial.number}<`));

  // eine bereits abgezogene Teilrechnung kann nicht ein zweites Mal abgezogen werden
  const res = await req('/invoices', {
    form: {
      contact_id: String(contact.id), type_code: '877', issue_date: '2026-11-03', due_date: '2026-11-17', service_mode: 'date',
      service_date: '2026-11-01', 'item_title[]': 'x', 'item_description[]': '', 'item_quantity[]': '1', 'item_unit[]': 'LS',
      'item_price[]': '10', 'item_vat[]': '1900', 'prepayment_ids[]': partialId,
    },
  });
  assert.equal(location(res), '/invoices/new');

  // Logo hochladen (Multipart)
  const fd = new FormData();
  fd.append('_csrf', csrf);
  fd.append('logo', new Blob([fs.readFileSync('test/logo.png')], { type: 'image/png' }), 'logo.png');
  const up = await app.request('/settings/logo', { method: 'POST', headers: { cookie }, body: fd });
  assert.equal(up.status, 303);
  assert.ok(await one('SELECT 1 FROM tenant_logos WHERE tenant_id = ?', first.id));
  assert.equal((await req('/settings/logo')).headers.get('content-type'), 'image/png');

  // Exporte
  await req('/settings', {
    form: {
      name: 'Test GmbH', contact_name: 'Tina Test', street: 'Weg 1', zip: '12345', city: 'Teststadt', country: 'DE',
      email: 'tina@example.com', phone: '0301234567', website: '', tax_number: '12/345/67890', vat_id: 'DE123456789',
      managing_directors: 'Tina Test', register_court: '', register_number: '', bank_name: 'Bank',
      iban: 'DE02120300000000202051', bic: '', quote_number_format: 'AN-{YYYY}-{NNNN}',
      invoice_number_format: 'RE-{YYYY}-{NNNN}', customer_number_format: 'K{NNNNN}', payment_days: '14',
      quote_valid_days: '30', quote_intro: '', quote_outro: '', invoice_intro: 'Hallo', invoice_outro: '',
      datev_consultant: '1234567', datev_client: '12345', datev_skr: '03', datev_account_length: '4',
      datev_debtor_mode: 'collective', datev_debtor_account: '10000', datev_accounts: '',
    },
  });
  const datev = Buffer.from(await (await req('/export/datev?from=2026-11-01&to=2026-11-30')).arrayBuffer()).toString('latin1');
  const lines = datev.trim().split('\r\n');
  assert.match(lines[0], /^"EXTF";700;21;"Buchungsstapel";13;/);
  assert.match(lines[0], /;1234567;12345;20260101;4;20261101;20261130;/);
  // 875: 1190 S, 877: 3570 S, Verrechnung 875: 1190 H
  assert.deepEqual(lines.slice(2).map((l) => l.split(';').slice(0, 2).join(' ')), ['1190,00 "S"', '3570,00 "S"', '1190,00 "H"']);
  const journal = await (await req('/export/journal?from=2026-11-01&to=2026-11-30')).text();
  assert.match(journal, /Schlussrechnung/);
  const zip = Buffer.from(await (await req('/export/zip?from=2026-11-01&to=2026-11-30')).arrayBuffer());
  assert.equal(zip.readUInt32LE(0), 0x04034b50);
  assert.match(zip.toString('latin1'), /_Schlussrechnung\.pdf/);
});

test('Nachweisdokumentationen', opts, async () => {
  const first = (await one<{ id: number }>("SELECT id FROM tenants WHERE name = 'Test GmbH'"))!;
  await req('/tenant/switch', { form: { tenant_id: String(first.id) } });
  const contact = (await one<{ id: number }>("SELECT id FROM contacts WHERE company = 'Kunde AG'"))!;

  // Nachweis hochladen: ein PDF aus Schottr selbst (Schriften eingebettet)
  const quote = (await one<{ id: number }>("SELECT id FROM documents WHERE kind = 'quote' LIMIT 1"))!;
  const pdfBytes = Buffer.from(await (await req(`/quotes/${quote.id}/pdf`)).arrayBuffer());
  const fd = new FormData();
  fd.append('_csrf', csrf);
  fd.append('name', 'Aufmaß Halle 1');
  fd.append('file', new Blob([pdfBytes], { type: 'application/pdf' }), 'aufmass.pdf');
  let res = await app.request('/proofs', { method: 'POST', headers: { cookie }, body: fd });
  assert.equal(res.status, 303);
  const proof = (await one('SELECT * FROM proof_documents WHERE name = ?', 'Aufmaß Halle 1'))!;
  assert.equal(proof.pdfa_ok, 1);
  assert.equal(proof.pages, 1);

  // Keine PDF → abgelehnt
  const bad = new FormData();
  bad.append('_csrf', csrf);
  bad.append('name', 'Kaputt');
  bad.append('file', new Blob(['hallo'], { type: 'application/pdf' }), 'x.pdf');
  await app.request('/proofs', { method: 'POST', headers: { cookie }, body: bad });
  assert.equal(await one('SELECT 1 FROM proof_documents WHERE name = ?', 'Kaputt'), undefined);

  // An Rechnung anhängen und festschreiben
  res = await req('/invoices', {
    form: {
      contact_id: String(contact.id), type_code: '380', issue_date: '2026-11-05', due_date: '2026-11-19', service_mode: 'date',
      service_date: '2026-11-05', 'item_title[]': 'Mit Nachweis', 'item_description[]': '', 'item_quantity[]': '1',
      'item_unit[]': 'LS', 'item_price[]': '100', 'item_vat[]': '1900', 'proof_ids[]': String(proof.id),
    },
  });
  const id = location(res).split('/').pop()!;
  await req(`/invoices/${id}/finalize`, { form: {} });
  const xml = await (await req(`/invoices/${id}/xrechnung.xml`)).text();
  assert.match(xml, /<ram:AdditionalReferencedDocument><ram:IssuerAssignedID>NW-1<\/ram:IssuerAssignedID><ram:TypeCode>916<\/ram:TypeCode><ram:Name>Aufmaß Halle 1<\/ram:Name><ram:AttachmentBinaryObject mimeCode="application\/pdf" filename="01_aufmass.pdf">JVBER/);
  const pdf = Buffer.from(await (await req(`/invoices/${id}/pdf`)).arrayBuffer()).toString('latin1');
  assert.equal((pdf.match(/\/Type \/Page\b/g) ?? []).length, 2, 'Rechnung + 1 Seite Nachweis');
  assert.match(pdf, /factur-x\.xml/);

  // Verwendete Nachweise lassen sich nicht löschen, nur archivieren
  await req(`/proofs/${proof.id}/delete`, { form: {} });
  assert.ok(await one('SELECT 1 FROM proof_documents WHERE id = ?', proof.id));
  await assert.rejects(run('DELETE FROM document_proofs WHERE document_id = ?', Number(id)), /Festgeschriebene/);
});

test('Stornorechnungen lassen sich nicht duplizieren', opts, async () => {
  const storno = (await one<{ id: number; tenant_id: number }>("SELECT id, tenant_id FROM documents WHERE type_code = '381' LIMIT 1"))!;
  await req('/tenant/switch', { form: { tenant_id: String(storno.tenant_id) } });
  const before = (await one<{ n: number }>("SELECT COUNT(*) n FROM documents WHERE type_code = '381'"))!.n;
  assert.doesNotMatch(await (await req(`/invoices/${storno.id}`)).text(), /\/duplicate"/);
  await req(`/invoices/${storno.id}/duplicate`, { form: {} });
  assert.equal((await one<{ n: number }>("SELECT COUNT(*) n FROM documents WHERE type_code = '381'"))!.n, before);
});

test('Nachträgliche Bearbeitung festgeschriebener Rechnungen', opts, async () => {
  const first = (await one<{ id: number }>("SELECT id FROM tenants WHERE name = 'Test GmbH'"))!;
  await req('/tenant/switch', { form: { tenant_id: String(first.id) } });
  const contact = (await one<{ id: number }>("SELECT id FROM contacts WHERE company = 'Kunde AG'"))!;
  let res = await req('/invoices', {
    form: {
      contact_id: String(contact.id), type_code: '380', issue_date: '2026-11-10', due_date: '2026-11-24', service_mode: 'date',
      service_date: '2026-11-10', 'item_title[]': 'Vor Korrektur', 'item_description[]': '', 'item_quantity[]': '1',
      'item_unit[]': 'LS', 'item_price[]': '100', 'item_vat[]': '1900',
    },
  });
  const id = location(res).split('/').pop()!;
  await req(`/invoices/${id}/finalize`, { form: {} });
  const before = (await one('SELECT number, pdf FROM documents WHERE id = ?', Number(id)))!;
  const counter = (await one<{ value: number }>("SELECT `value` FROM counters WHERE tenant_id = ? AND kind = 'invoice'", first.id))!.value;

  // Bestätigungsseite liefert einen 6-stelligen Code (nur als CSS-Pseudoelement)
  const pageHtml = await (await req(`/invoices/${id}/correct`)).text();
  const code = [...pageHtml.matchAll(/<span data-c="([A-Z0-9])"><\/span>/g)].map((m) => m[1]).join('');
  assert.equal(code.length, 6);

  // falscher Code → nichts passiert
  res = await req(`/invoices/${id}/correct`, { form: { reason: 'Anschrift korrigiert', code: 'XXXXXX' } });
  assert.equal(res.status, 400);
  assert.ok((await one('SELECT finalized_at FROM documents WHERE id = ?', Number(id)))!.finalized_at);

  // richtiger Code, aber ohne ausreichenden Grund → nichts passiert
  res = await req(`/invoices/${id}/correct`, { form: { reason: 'kurz', code: code.toLowerCase() } });
  assert.equal(res.status, 400);

  // korrekt → geöffnet, alte Fassung archiviert
  res = await req(`/invoices/${id}/correct`, { form: { reason: 'Positionstext korrigiert', code } });
  assert.equal(location(res), `/invoices/${id}/edit`);
  const opened = (await one('SELECT * FROM documents WHERE id = ?', Number(id)))!;
  assert.equal(opened.finalized_at, null);
  assert.equal(opened.revision, 1);
  assert.equal(opened.number, before.number);
  const v1 = (await one('SELECT * FROM document_versions WHERE document_id = ? AND version = 1', Number(id)))!;
  assert.equal(v1.reason, 'Positionstext korrigiert');
  assert.deepEqual(Buffer.from(v1.pdf), Buffer.from(before.pdf));
  await assert.rejects(run('UPDATE document_versions SET reason = ? WHERE id = ?', 'x', v1.id), /Archivierte/);
  await assert.rejects(run('DELETE FROM document_versions WHERE id = ?', v1.id), /Archivierte/);
  // geöffnete Rechnung kann nicht gelöscht werden
  await req(`/invoices/${id}/delete`, { form: {} });
  assert.ok(await one('SELECT 1 FROM documents WHERE id = ?', Number(id)));

  // bearbeiten und erneut festschreiben → gleiche Nummer, kein neuer Zähler
  await req(`/invoices/${id}`, {
    form: {
      contact_id: String(contact.id), type_code: '380', issue_date: '2026-11-10', due_date: '2026-11-24', service_mode: 'date',
      service_date: '2026-11-10', 'item_title[]': 'Nach Korrektur', 'item_description[]': '', 'item_quantity[]': '1',
      'item_unit[]': 'LS', 'item_price[]': '120', 'item_vat[]': '1900',
    },
  });
  await req(`/invoices/${id}/finalize`, { form: {} });
  const after = (await one('SELECT * FROM documents WHERE id = ?', Number(id)))!;
  assert.ok(after.finalized_at);
  assert.equal(after.number, before.number);
  assert.equal(after.gross_total, 14280);
  assert.equal((await one<{ value: number }>("SELECT `value` FROM counters WHERE tenant_id = ? AND kind = 'invoice'", first.id))!.value, counter);
  // die Sperre gilt wieder
  await assert.rejects(run('UPDATE documents SET gross_total = 1 WHERE id = ?', Number(id)), /Festgeschriebene/);
  // alte Fassung abrufbar
  assert.equal((await req(`/invoices/${id}/versions/1/pdf`)).headers.get('content-type'), 'application/pdf');
  assert.match(await (await req(`/invoices/${id}`)).text(), /Frühere Fassungen/);
});

test('Übersicht: Umsatzjahr wählbar und Diagramm der letzten 24 Monate', opts, async () => {
  const first = (await one<{ id: number }>("SELECT id FROM tenants WHERE name = 'Test GmbH'"))!;
  await req('/tenant/switch', { form: { tenant_id: String(first.id) } });
  const contact = (await one<{ id: number }>("SELECT id FROM contacts WHERE company = 'Kunde AG'"))!;
  // Rechnung aus dem Vorjahr (liegt sicher innerhalb der letzten 24 Monate)
  const lastYear = String(new Date().getFullYear() - 1);
  let res = await req('/invoices', {
    form: {
      contact_id: String(contact.id), type_code: '380', issue_date: `${lastYear}-12-15`, due_date: `${lastYear}-12-29`, service_mode: 'date',
      service_date: `${lastYear}-12-15`, 'item_title[]': 'Vorjahr', 'item_description[]': '', 'item_quantity[]': '1',
      'item_unit[]': 'LS', 'item_price[]': '1234,56', 'item_vat[]': '1900',
    },
  });
  const id = location(res).split('/').pop()!;
  await req(`/invoices/${id}/finalize`, { form: {} });
  assert.ok((await one('SELECT finalized_at FROM documents WHERE id = ?', Number(id)))!.finalized_at);

  const page = await (await req(`/?year=${lastYear}`)).text();
  assert.match(page, new RegExp(`<option value="${lastYear}" selected>`));
  assert.match(page, /1\.234,56&nbsp;€|1\.234,56\s€/);
  assert.equal([...page.matchAll(/class="chart-bar[^"]*" data-bar=/g)].length, 24);
  assert.match(page, new RegExp(`Dezember ${lastYear}: 1\\.234,56.€ netto · 1 Rechnung`));

  // unbekanntes Jahr → laufendes Jahr
  const fallback = await (await req('/?year=1999')).text();
  assert.match(fallback, new RegExp(`<option value="${new Date().getFullYear()}" selected>`));
  assert.doesNotMatch(fallback, /value="1999"/);
});

test('Übersicht: Top-Kunden, Kleinunternehmergrenze und Monatsfilter', opts, async () => {
  const first = (await one<{ id: number }>("SELECT id FROM tenants WHERE name = 'Test GmbH'"))!;
  await req('/tenant/switch', { form: { tenant_id: String(first.id) } });
  const contact = (await one<{ id: number }>("SELECT id FROM contacts WHERE company = 'Kunde AG' AND tenant_id = ?", first.id))!;

  // Ringdiagramm mit Link auf die Adresse; ohne Kleinunternehmerregelung keine Grenz-Kachel
  let page = await (await req('/')).text();
  assert.match(page, /data-pie/);
  assert.match(page, new RegExp(`href="/contacts/${contact.id}"`));
  assert.doesNotMatch(page, /Kleinunternehmergrenze/);
  // Säulen verlinken auf den Monatsfilter
  const ym = new Date().toISOString().slice(0, 7);
  assert.match(page, new RegExp(`href="/invoices\\?month=${ym}"`));

  // mit Kleinunternehmerregelung: Kachel mit beiden Grenzen
  await run('UPDATE tenants SET small_business = 1 WHERE id = ?', first.id);
  try {
    page = await (await req('/')).text();
    assert.match(page, /Kleinunternehmergrenze/);
    assert.match(page, /meter-mark-label at-25">25\.000 € · Grenze für \d{4}</);
    assert.match(page, /aria-valuemax="10000000"/);
    assert.match(page, /bis 25\.000 €|25\.000 € überschritten/);
  } finally {
    await run('UPDATE tenants SET small_business = 0 WHERE id = ?', first.id);
  }

  // Monatsfilter: nur festgeschriebene Rechnungen des Monats
  const lastYear = new Date().getFullYear() - 1;
  const expected = (await all<{ number: string }>(
    "SELECT number FROM documents WHERE tenant_id = ? AND kind = 'invoice' AND finalized_at IS NOT NULL AND issue_date BETWEEN ? AND ?",
    first.id, `${lastYear}-12-01`, `${lastYear}-12-31`,
  )).map((r) => r.number);
  assert.ok(expected.length >= 1);
  const list = await (await req(`/invoices?month=${lastYear}-12`)).text();
  assert.match(list, new RegExp(`Dezember ${lastYear}`));
  const shown = [...list.matchAll(/<td class="mono"><a href="\/invoices\/\d+">([^<]+)<\/a>/g)].map((m) => m[1]);
  assert.deepEqual(shown.sort(), expected.sort());
  // ungültiger Monat wird ignoriert
  assert.doesNotMatch(await (await req('/invoices?month=2026-13')).text(), /filter-chip/);
});
