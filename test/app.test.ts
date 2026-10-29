import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import mysql from 'mysql2/promise';
import { PDFDocument } from 'pdf-lib';
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
  // eigene, leere Dateiablage für Nachweise und Eingangsrechnungen
  process.env.SCHOTTR_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'schottr-test-'));
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
  // Inhalt liegt als Datei unter <data>/nachweise/<Mandant>/, nicht in der Datenbank
  assert.equal(proof.data, null);
  assert.match(proof.path, new RegExp(`^${first.id}/`));
  assert.deepEqual(fs.readFileSync(path.join(process.env.SCHOTTR_DATA_DIR!, 'nachweise', proof.path)), pdfBytes);

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

/* ---------------- Eingangsrechnungen ---------------- */

const fixture = (name: string) => fs.readFileSync(new URL(`./fixtures/${name}`, import.meta.url));

async function upload(files: { name: string; data: Buffer; type: string }[]) {
  const fd = new FormData();
  fd.append('_csrf', csrf);
  for (const f of files) fd.append('files[]', new Blob([new Uint8Array(f.data)], { type: f.type }), f.name);
  return app.request('/purchases/upload', { method: 'POST', headers: { cookie }, body: fd });
}

const flashOf = (res: Response) => {
  const c = res.headers.getSetCookie().find((x) => x.startsWith('schottr_flash='));
  if (!c) return '';
  let v = c.split(';')[0].slice('schottr_flash='.length);
  while (v.startsWith('%')) v = decodeURIComponent(v);
  return JSON.parse(v).message as string;
};

test('Adressen: Kunden und Lieferanten getrennt', opts, async () => {
  const first = (await one<{ id: number }>("SELECT id FROM tenants WHERE name = 'Test GmbH'"))!;
  await req('/tenant/switch', { form: { tenant_id: String(first.id) } });
  let res = await req('/contacts', { form: { kind: 'supplier', company: 'Papier Meier KG', city: 'Würzburg', country: 'DE' } });
  const supplierId = Number(location(res).split('/').pop());
  const supplier = (await one('SELECT * FROM contacts WHERE id = ?', supplierId))!;
  assert.equal(supplier.kind, 'supplier');
  assert.match(supplier.customer_number, /^L\d{5}$/, 'eigener Nummernkreis für Lieferanten');

  // Filter im Adressbereich
  const suppliers = await (await req('/contacts?kind=supplier')).text();
  assert.match(suppliers, /Papier Meier KG/);
  assert.doesNotMatch(suppliers, /Kunde AG/);
  const customers = await (await req('/contacts?kind=customer')).text();
  assert.doesNotMatch(customers, /Papier Meier KG/);

  // Lieferanten stehen nicht zur Auswahl für Rechnungen und werden abgelehnt
  assert.doesNotMatch(await (await req('/invoices/new')).text(), /Papier Meier KG/);
  res = await req('/invoices', {
    form: { contact_id: String(supplierId), type_code: '380', issue_date: '2026-09-01', 'item_title[]': 'x', 'item_price[]': '1', 'item_vat[]': '1900' },
  });
  assert.match(flashOf(res), /als Lieferant angelegt/);
  // Kunden mit Belegen bleiben Kunde
  const kunde = (await one<{ id: number }>("SELECT id FROM contacts WHERE company = 'Kunde AG' AND tenant_id = ?", first.id))!;
  res = await req(`/contacts/${kunde.id}`, { form: { kind: 'supplier', company: 'Kunde AG', street: 'Str. 2', zip: '54321', city: 'Ort', country: 'DE' } });
  assert.match(flashOf(res), /bleibt daher Kunde/);
});

test('Eingangsrechnungen: E-Rechnung, Scan, manuell, Export und Übersicht', opts, async () => {
  const first = (await one<Record<string, any>>("SELECT * FROM tenants WHERE name = 'Test GmbH'"))!;
  await req('/tenant/switch', { form: { tenant_id: String(first.id) } });
  const dataDir = process.env.SCHOTTR_DATA_DIR!;

  // 1) XRechnung (CII) aus der KoSIT-Testsuite: wird vollständig übernommen, Lieferant neu angelegt
  let res = await upload([{ name: 'xrechnung.xml', data: fixture('02.01a-INVOICE_uncefact.xml'), type: 'application/xml' }]);
  assert.equal(res.status, 303);
  assert.match(flashOf(res), /E-Rechnung übernommen.*neu angelegt/);
  const xr = (await one('SELECT * FROM purchase_invoices WHERE tenant_id = ? AND file_name = ?', first.id, 'xrechnung.xml'))!;
  assert.equal(xr.status, 'open');
  assert.equal(xr.number, '1234567');
  assert.equal(xr.issue_date, '2018-04-13');
  assert.equal(xr.gross_total, 1282969);
  assert.equal(xr.einvoice_format, 'XRechnung (CII)');
  assert.ok(fs.existsSync(path.join(dataDir, 'verbindlichkeiten', xr.file_path)));
  assert.match(xr.file_path, new RegExp(`^${first.id}/`));
  const taxes = await all('SELECT category, rate FROM purchase_invoice_taxes WHERE purchase_id = ? ORDER BY `position`', xr.id);
  assert.deepEqual(taxes.map((t) => `${t.category}${t.rate}`), ['S1900', 'E0']);
  const seller = (await one('SELECT * FROM contacts WHERE id = ?', xr.contact_id))!;
  assert.equal(seller.kind, 'supplier');
  assert.equal(seller.vat_id, 'ATU123456789');
  const detail = await (await req(`/purchases/${xr.id}`)).text();
  assert.match(detail, /Positionen laut E-Rechnung/);
  assert.match(detail, /12\.829,69/);

  // dieselbe Datei nochmal → nicht doppelt
  res = await upload([{ name: 'nochmal.xml', data: fixture('02.01a-INVOICE_uncefact.xml'), type: 'application/xml' }]);
  assert.match(flashOf(res), /bereits hochgeladen/);
  // UBL derselben Rechnung (andere Datei, gleiche Nummer, gleicher Lieferant) → als Dublette erkannt
  const ubl = fixture('03.01a-INVOICE_ubl.xml');
  res = await upload([{ name: 'ubl.xml', data: ubl, type: 'application/xml' }]);
  assert.match(flashOf(res), /übernommen/);
  const ublRow = (await one('SELECT * FROM purchase_invoices WHERE file_name = ?', 'ubl.xml'))!;
  assert.equal(ublRow.einvoice_format, 'XRechnung (UBL)');
  assert.equal(ublRow.contact_id, xr.contact_id, 'Lieferant über die USt-IdNr. wiedererkannt');
  // Zahlbetrag negativ (Vorauszahlung höher) → nichts mehr zu zahlen
  assert.equal(ublRow.status, 'paid');

  // 2) ZUGFeRD-PDF: Rechnung aus Schottr selbst als Eingangsrechnung hochladen
  const own = (await one<{ id: number; number: string }>("SELECT id, number FROM documents WHERE tenant_id = ? AND kind = 'invoice' AND type_code = '380' AND finalized_at IS NOT NULL AND pdf IS NOT NULL LIMIT 1", first.id))!;
  const zugferd = Buffer.from(await (await req(`/invoices/${own.id}/pdf`)).arrayBuffer());
  res = await upload([{ name: 'zugferd.pdf', data: zugferd, type: 'application/pdf' }]);
  const zf = (await one('SELECT * FROM purchase_invoices WHERE file_name = ?', 'zugferd.pdf'))!;
  assert.equal(zf.number, own.number);
  assert.equal(zf.einvoice_format, 'ZUGFeRD (EN 16931)');
  // Absender „Test GmbH“ existierte nur als eigener Mandant → neuer Lieferant
  assert.equal((await one('SELECT company FROM contacts WHERE id = ?', zf.contact_id))!.company, 'Test GmbH');
  // E-Rechnungsdaten lassen sich nicht überschreiben, Kostenart schon
  await req(`/purchases/${zf.id}`, { form: { category: 'software', number: 'ANDERS', due_date: '', description: 'Lizenz', paid_at: '' } });
  const zf2 = (await one('SELECT * FROM purchase_invoices WHERE id = ?', zf.id))!;
  assert.equal(zf2.number, own.number);
  assert.equal(zf2.category, 'software');
  assert.equal((await one('SELECT expense_category FROM contacts WHERE id = ?', zf.contact_id))!.expense_category, 'software', 'Kostenart wird beim Lieferanten gemerkt');

  // 3) Scan (JPEG) + normale PDF ohne XML → zwei Belege „zu erfassen“
  const jpeg = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(200, 1)]);
  const quote = (await one<{ id: number }>("SELECT id FROM documents WHERE kind = 'quote' AND tenant_id = ? LIMIT 1", first.id))!;
  const plainPdf = Buffer.from(await (await req(`/quotes/${quote.id}/pdf`)).arrayBuffer());
  res = await upload([
    { name: 'kassenbon.jpg', data: jpeg, type: 'image/jpeg' },
    { name: 'rechnung.pdf', data: plainPdf, type: 'application/pdf' },
    { name: 'notiz.txt', data: Buffer.from('hallo'), type: 'text/plain' },
  ]);
  assert.equal(location(res), '/purchases?status=draft');
  assert.match(flashOf(res), /2 Beleg\(e\) hochgeladen.*notiz\.txt/);
  const scan = (await one('SELECT * FROM purchase_invoices WHERE file_name = ?', 'kassenbon.jpg'))!;
  assert.equal(scan.status, 'draft');
  assert.equal(scan.file_mime, 'image/jpeg');
  // Formular mit Vorschau
  const edit = await (await req(`/purchases/${scan.id}/edit`)).text();
  assert.match(edit, new RegExp(`src="/purchases/${scan.id}/file\\?inline=1"`));
  // Vorschau darf eingebettet werden, aber nur von der eigenen Seite
  const preview = await req(`/purchases/${scan.id}/file?inline=1`);
  assert.match(preview.headers.get('content-security-policy') ?? '', /frame-ancestors 'self'/);
  assert.equal(preview.headers.get('content-type'), 'image/jpeg');
  assert.match((await req(`/purchases/${scan.id}/file`)).headers.get('content-security-policy') ?? '', /frame-ancestors 'none'/);

  // Erfassen: neuer Lieferant per Name, nur Brutto 19 % angegeben
  res = await req(`/purchases/${scan.id}`, {
    form: {
      contact_id: '', new_supplier: 'Tankstelle Süd', number: 'B-77', issue_date: '2026-09-10', due_date: '', category: 'kfz',
      description: 'Diesel', paid_at: '2026-09-10', 'tax_rate[]': '1900', 'tax_net[]': '', 'tax_tax[]': '', 'tax_gross[]': '119,00',
    },
  });
  const saved = (await one('SELECT * FROM purchase_invoices WHERE id = ?', scan.id))!;
  assert.equal(saved.status, 'paid');
  assert.equal(saved.net_total, 10000);
  assert.equal(saved.tax_total, 1900);
  const tank = (await one('SELECT * FROM contacts WHERE id = ?', saved.contact_id))!;
  assert.equal(tank.company, 'Tankstelle Süd');
  assert.equal(tank.kind, 'supplier');

  // Manuell ohne Beleg, zwei Steuersätze, offen und überfällig
  const meier = (await one<{ id: number }>("SELECT id FROM contacts WHERE company = 'Papier Meier KG'"))!;
  res = await req('/purchases', {
    form: {
      contact_id: String(meier.id), number: 'PM-1', issue_date: '2026-09-15', due_date: '2026-09-29', category: 'buero', description: '',
      'tax_rate[]': ['1900', '700'], 'tax_net[]': ['100,00', '50'], 'tax_tax[]': ['', ''], 'tax_gross[]': ['', ''],
    },
  });
  const pm = (await one('SELECT * FROM purchase_invoices WHERE number = ?', 'PM-1'))!;
  assert.equal(pm.status, 'open');
  assert.equal(pm.gross_total, 11900 + 5350);
  // doppelte Rechnungsnummer beim selben Lieferanten → abgelehnt
  res = await req('/purchases', { form: { contact_id: String(meier.id), number: 'PM-1', issue_date: '2026-09-16', 'tax_rate[]': '1900', 'tax_net[]': '1' } });
  assert.match(flashOf(res), /bereits erfasst/);
  // ohne Betrag → Fehler
  res = await req('/purchases', { form: { contact_id: String(meier.id), issue_date: '2026-09-16', 'tax_rate[]': '1900', 'tax_net[]': '' } });
  assert.match(flashOf(res), /mindestens einen Betrag/);

  // Liste: Filter überfällig
  const overdue = await (await req('/purchases?status=overdue')).text();
  assert.match(overdue, /PM-1/);
  assert.doesNotMatch(overdue, /B-77/);

  // 4) Übersicht: Verbindlichkeiten, Umsatz/Ausgaben, Lieferanten-Kachel
  const dash = await (await req('/?year=2026')).text();
  assert.match(dash, /Verbindlichkeiten/);
  assert.match(dash, /Umsatz und Ausgaben 2026/);
  assert.match(dash, /href="\/overview\/2026-09#ausgaben"/);
  assert.match(dash, /Größte Verbindlichkeiten/);
  // Lieferanten nach Zahlungsdatum: bezahlte Tankquittung im Jahr der Zahlung, offene PM-1 unter „Alle Jahre“
  assert.match(dash, /Tankstelle Süd/);
  assert.match(await (await req('/?year=2026&sp=all')).text(), /PM-1/);
  // nach Zahlungsdatum: nur die bezahlte Tankquittung (100 € netto), PM-1 ist noch offen
  assert.match(dash, /September 2026: Umsatz [^"]* · Ausgaben 100,00.€/);
  // Umschalter brutto: dieselbe Quittung mit 119 €
  assert.match(await (await req('/?year=2026&basis=gross')).text(), /September 2026: Umsatz [^"]* · Ausgaben 119,00.€/);
  // Monatsaufstellung: alles, was in der Säule steckt
  const month = await (await req('/overview/2026-09')).text();
  assert.match(month, /September 2026/);
  assert.match(month, /B-77/);
  assert.doesNotMatch(month, /PM-1/);
  assert.match(month, /Summe Ausgaben/);
  assert.equal((await req('/overview/2026-13')).status, 404);
  const paidList = await (await req('/purchases?paid=2026-09')).text();
  assert.match(paidList, /B-77/);
  assert.doesNotMatch(paidList, /PM-1/);

  // 5) Export: DATEV (nur Eingang), Rechnungseingangsbuch, ZIP
  const q = 'from=2026-09-01&to=2026-09-30';
  const datev = Buffer.from(await (await req(`/export/datev?${q}&in=1`)).arrayBuffer()).toString('latin1');
  const lines = datev.trim().split('\r\n');
  assert.match(lines[0], /"Eingangsrechnungen 2026-09"/);
  const rows = lines.slice(2).map((l) => l.split(';'));
  // Tankstelle: 119,00 H, Kreditor 70000, Kfz 4530, BU 9 · Papier Meier: 119,00 + 53,50 mit BU 9 und 8 (Bürobedarf 4930)
  assert.deepEqual(
    rows.map((r) => [r[0], r[1], r[6], r[7], r[8]].join(' ')).sort(),
    ['119,00 "H" 70000 4530 "9"', '119,00 "H" 70000 4930 "9"', '53,50 "H" 70000 4930 "8"'].sort(),
  );
  const book = await (await req(`/export/purchases?${q}`)).text();
  assert.match(book, /Tankstelle Süd/);
  assert.match(book, /Bürobedarf;4930;70000;100,00;19,00;50,00;3,50/);
  const zip = Buffer.from(await (await req(`/export/zip?${q}`)).arrayBuffer()).toString('latin1');
  assert.match(zip, /Rechnungseingangsbuch_2026-09-01_2026-09-30\.csv/);
  assert.match(zip, /Eingangsrechnungen\/2026-09-10_Tankstelle_S/);

  // Kleinunternehmer: brutto ohne BU-Schlüssel
  await run('UPDATE tenants SET small_business = 1 WHERE id = ?', first.id);
  try {
    const ku = Buffer.from(await (await req(`/export/datev?${q}&in=1`)).arrayBuffer()).toString('latin1');
    assert.ok(ku.trim().split('\r\n').slice(2).every((l) => l.split(';')[8] === '""'));
  } finally {
    await run('UPDATE tenants SET small_business = 0 WHERE id = ?', first.id);
  }

  // 6) Bezahlt / offen, Löschen entfernt die Datei
  await req(`/purchases/${pm.id}/paid`, { form: { paid_at: '2026-10-01' } });
  assert.equal((await one('SELECT status, paid_at FROM purchase_invoices WHERE id = ?', pm.id))!.paid_at, '2026-10-01');
  await req(`/purchases/${pm.id}/open`, { form: {} });
  assert.equal((await one('SELECT status FROM purchase_invoices WHERE id = ?', pm.id))!.status, 'open');
  const pdfDraft = (await one('SELECT * FROM purchase_invoices WHERE file_name = ?', 'rechnung.pdf'))!;
  await req(`/purchases/${pdfDraft.id}/delete`, { form: {} });
  assert.equal(await one('SELECT 1 FROM purchase_invoices WHERE id = ?', pdfDraft.id), undefined);
  assert.equal(fs.existsSync(path.join(dataDir, 'verbindlichkeiten', pdfDraft.file_path)), false);

  // Lieferant mit Eingangsrechnungen lässt sich nicht löschen
  await req(`/contacts/${meier.id}/delete`, { form: {} });
  assert.ok(await one('SELECT 1 FROM contacts WHERE id = ?', meier.id));

  // Mandantentrennung: anderer Mandant sieht die Belege nicht
  const other = (await one<{ id: number; disabled: number }>(
    "SELECT t.id, t.disabled FROM tenants t JOIN memberships m ON m.tenant_id = t.id JOIN users u ON u.id = m.user_id WHERE t.id <> ? AND u.email = 'tina@example.com' ORDER BY t.id LIMIT 1",
    first.id,
  ))!;
  await run('UPDATE tenants SET disabled = 0 WHERE id = ?', other.id);
  try {
    await req('/tenant/switch', { form: { tenant_id: String(other.id) } });
    assert.doesNotMatch(await (await req('/purchases')).text(), /xrechnung\.xml|PM-1/);
    assert.equal((await req(`/purchases/${xr.id}`)).status, 404);
    assert.equal((await req(`/purchases/${xr.id}/file`)).status, 404);
  } finally {
    await run('UPDATE tenants SET disabled = ? WHERE id = ?', other.disabled, other.id);
    await req('/tenant/switch', { form: { tenant_id: String(first.id) } });
  }
});

test('Nachweise aus der Datenbank werden in die Dateiablage verschoben', opts, async () => {
  const { migrateProofBlobs } = await import('../src/modules/proofs.ts');
  const first = (await one<{ id: number }>("SELECT id FROM tenants WHERE name = 'Test GmbH'"))!;
  const data = fixture('02.01a-INVOICE_uncefact.xml'); // Inhalt egal
  const now = new Date().toISOString().replace('T', ' ').slice(0, 23);
  const res = await run(
    'INSERT INTO proof_documents (tenant_id, name, filename, data, size, pages, created_at, updated_at) VALUES (?, ?, ?, ?, ?, 1, ?, ?)',
    first.id, 'Altbestand', 'alt.pdf', data, data.length, now, now,
  );
  assert.equal(await migrateProofBlobs(), 1);
  const row = (await one('SELECT * FROM proof_documents WHERE id = ?', res.insertId))!;
  assert.equal(row.data, null);
  assert.deepEqual(fs.readFileSync(path.join(process.env.SCHOTTR_DATA_DIR!, 'nachweise', row.path)), data);
  assert.equal(await migrateProofBlobs(), 0, 'läuft nur einmal');
  await req('/tenant/switch', { form: { tenant_id: String(first.id) } });
  assert.deepEqual(Buffer.from(await (await req(`/proofs/${row.id}/file`)).arrayBuffer()), data);
});

test('Gemeinnütziger Verein: Bereich je Rechnung, Grenzen in der Übersicht, Vorstand auf dem Beleg', opts, async () => {
  await refreshCsrf();
  let res = await req('/tenants', { form: { name: 'Musikverein Teststadt e. V.', org_type: 'association', nonprofit: '1' } });
  assert.equal(location(res), '/settings');
  const t = (await one("SELECT * FROM tenants WHERE name = 'Musikverein Teststadt e. V.'"))!;
  assert.equal(t.org_type, 'association');
  assert.equal(t.nonprofit, 1);

  // Einstellungen mit Vereins-Beschriftungen
  let page = await (await req('/settings')).text();
  assert.match(page, /<legend>Verein<\/legend>/);
  assert.match(page, /Name des Vereins/);
  assert.match(page, /Vorstand/);
  assert.match(page, /name="nonprofit" value="1" checked/);

  res = await req('/settings', {
    form: {
      name: 'Musikverein Teststadt e. V.', contact_name: 'Kai Kasse', street: 'Weg 3', zip: '12345', city: 'Teststadt', country: 'DE',
      email: 'verein@example.com', phone: '0301234', website: '', tax_number: '12/345/99999', vat_id: '',
      managing_directors: 'Vera Vorstand', register_court: 'Amtsgericht Teststadt', register_number: 'VR 1234', bank_name: 'Bank',
      iban: 'DE02120300000000202051', bic: '', quote_number_format: 'AN-{YYYY}-{NNNN}', invoice_number_format: 'MV-{YYYY}-{NNNN}',
      customer_number_format: 'K{NNNNN}', supplier_number_format: 'L{NNNNN}', payment_days: '14', quote_valid_days: '30',
      org_type: 'association', nonprofit: '1', default_sphere: 'purpose',
    },
  });
  assert.equal(location(res), '/settings');
  assert.equal((await one('SELECT default_sphere FROM tenants WHERE id = ?', t.id))!.default_sphere, 'purpose');

  res = await req('/contacts', { form: { company: 'Brauerei GmbH', street: 'Hopfenweg 1', zip: '54321', city: 'Ort', country: 'DE', email: 'b@example.com' } });
  const contactId = location(res).split('/').pop()!;

  // Formular zeigt den Bereich mit der Vorgabe
  page = await (await req('/invoices/new')).text();
  assert.match(page, /Bereich \(Gemeinnützigkeit\)/);
  assert.match(page, /<option value="purpose"[^>]* selected>/);

  const d = new Date().toISOString().slice(0, 10);
  const year = d.slice(0, 4);
  const invoice = async (sphere: string, price: string, paid = true) => {
    const r = await req('/invoices', {
      form: {
        contact_id: contactId, type_code: '380', issue_date: d, due_date: d, service_mode: 'date', service_date: d, sphere,
        'item_title[]': 'Leistung', 'item_description[]': '', 'item_quantity[]': '1', 'item_unit[]': 'LS', 'item_price[]': price, 'item_vat[]': '1900',
      },
    });
    const id = location(r).split('/').pop()!;
    assert.match(id, /^\d+$/);
    await req(`/invoices/${id}/finalize`, { form: {} });
    if (paid) await req(`/invoices/${id}/paid`, { form: { paid_at: d } });
    const doc = (await one('SELECT * FROM documents WHERE id = ?', Number(id)))!;
    assert.ok(doc.finalized_at, 'festgeschrieben');
    assert.equal(doc.sphere, sphere);
    return doc;
  };
  // Sponsoring 42.000 € brutto (wirtschaftlicher Geschäftsbetrieb) und 1.190 € brutto ideeller Bereich
  const sponsoring = await invoice('business', '35294,12');
  const beitrag = await invoice('ideell', '1000', false); // bleibt offen (wird im Kassenbuch-Test bezahlt)
  assert.equal(sponsoring.gross_total, 4200000);
  assert.equal(sponsoring.paid_at, d);
  // unbezahlt zählt noch nicht (Zuflussprinzip)
  const offen = await invoice('business', '5000', false);
  assert.equal(offen.paid_at, null);

  // Vorstand statt Geschäftsführer im XML
  const xml = await (await req(`/invoices/${sponsoring.id}/xrechnung.xml`)).text();
  assert.match(xml, /Vorstand: Vera Vorstand/);
  assert.doesNotMatch(xml, /Geschäftsführer/);

  // Übersicht: Grenze § 64 Abs. 3 AO, 42.000 € ≥ 80 % von 50.000 € → Warnung
  page = await (await req('/')).text();
  assert.match(page, /Gemeinnützigkeit \d{4}/);
  assert.match(page, /§ 64 Abs\. 3 AO/);
  assert.match(page, /aria-valuemax="5000000" aria-valuenow="4200000"/);
  assert.match(page, /ku-status ku-warn"><strong>Achtung:<\/strong> nur noch/);
  assert.match(page, /aria-valuemax="10000000" aria-valuenow="4200000"/, 'Einnahmen gesamt gegen 100.000 € – nur bezahlte Rechnungen');
  assert.match(page, new RegExp(`href="/overview/${year}\\?sphere=ideell&amp;basis=gross"`));
  assert.doesNotMatch(page, /Sportliche Veranstaltungen \d{4}/, 'ohne Sporteinnahmen keine Sportzeile');

  // Liste nach Jahr und Bereich filtern
  const list = await (await req(`/invoices?year=${year}&sphere=ideell`)).text();
  assert.match(list, new RegExp(`href="/invoices/${beitrag.id}"`));
  assert.doesNotMatch(list, new RegExp(`href="/invoices/${sponsoring.id}"`));

  // Bereich nach dem Festschreiben ändern: Sponsoring war doch Zweckbetrieb
  res = await req(`/invoices/${sponsoring.id}/sphere`, { form: { sphere: 'purpose' } });
  assert.equal(location(res), `/invoices/${sponsoring.id}`);
  assert.equal((await one('SELECT sphere FROM documents WHERE id = ?', sponsoring.id))!.sphere, 'purpose');
  page = await (await req('/')).text();
  assert.match(page, /aria-valuemax="5000000" aria-valuenow="0"/);

  // Sportliche Veranstaltungen über 50.000 € zählen zum wirtschaftlichen Geschäftsbetrieb
  await run("UPDATE documents SET sphere = 'sport' WHERE id = ?", sponsoring.id);
  await invoice('sport', '9000'); // + 10.710 € → 52.710 € Sport
  page = await (await req('/')).text();
  assert.match(page, /Sportliche Veranstaltungen \d{4} \(§ 67a AO\)/);
  assert.match(page, /inkl\. Sport/);
  assert.match(page, /aria-valuemax="5000000" aria-valuenow="5271000"/);

  // Kleinunternehmergrenze ohne ideellen Bereich (netto)
  await run('UPDATE tenants SET small_business = 1 WHERE id = ?', t.id);
  page = await (await req('/')).text();
  assert.match(page, /Kleinunternehmergrenze/);
  assert.match(page, /aria-valuemax="10000000" aria-valuenow="4429412"/, '35.294,12 € + 9.000 € netto, ohne die 1.000 € Beitrag');
  assert.match(page, /, ohne ideellen Bereich\./);

  // ohne Gemeinnützigkeit keine Kachel und kein Bereichsfeld
  await run('UPDATE tenants SET nonprofit = 0, small_business = 0 WHERE id = ?', t.id);
  page = await (await req('/')).text();
  assert.doesNotMatch(page, /Gemeinnützigkeit \d{4}/);
  assert.doesNotMatch(await (await req('/invoices/new')).text(), /Bereich \(Gemeinnützigkeit\)/);
});

test('Spenden: erfassen, Einzel-, Sach- und Sammelbestätigung, Storno', opts, async () => {
  const t = (await one("SELECT * FROM tenants WHERE name = 'Musikverein Teststadt e. V.'"))!;
  await req('/tenant/switch', { form: { tenant_id: String(t.id) } });
  await run('UPDATE tenants SET nonprofit = 1 WHERE id = ?', t.id);
  const year = Number(new Date().toISOString().slice(0, 4));
  const d = (m: string) => `${year}-${m}`;

  // Menüpunkt nur bei gemeinnützigen Mandanten
  let page = await (await req('/')).text();
  assert.match(page, /href="\/donations"/);

  {
    const r = await req('/contacts', { form: { name: 'Erika Mustermann', street: 'Hauptstraße 5', zip: '12345', city: 'Teststadt', country: 'DE' } });
    assert.match(location(r), /^\/contacts\/\d+$/);
  }
  const erika = (await one("SELECT id FROM contacts WHERE name = 'Erika Mustermann' AND tenant_id = ?", t.id))!.id;
  const brauerei = (await one("SELECT id FROM contacts WHERE company = 'Brauerei GmbH' AND tenant_id = ?", t.id))!.id;

  const donate = async (form: Record<string, string>) => {
    const r = await req('/donations', { form: { contact_id: String(erika), kind: 'money', ...form } });
    const id = location(r).split('/').pop()!;
    assert.match(id, /^\d+$/, `Zuwendung angelegt: ${JSON.stringify(form)}`);
    return Number(id);
  };
  const m1 = await donate({ donation_date: d('01-15'), amount: '100' });
  const m2 = await donate({ donation_date: d('01-20'), amount: '50,50', waiver: '1' });
  const beitrag = await donate({ donation_date: d('01-02'), amount: '60', kind: 'membership' });
  const sache = await donate({ donation_date: d('01-10'), amount: '800', kind: 'goods', description: 'Notenständer, 10 Stück, neuwertig', goods_origin: 'private' });
  const fremd = await donate({ contact_id: String(brauerei), donation_date: d('01-03'), amount: '1000' });

  // Ohne Bescheid-Angaben keine Bestätigung
  let r = await req(`/donations/${m1}/receipt`, { form: {} });
  assert.equal((await one('SELECT receipt_id FROM donations WHERE id = ?', m1))!.receipt_id, null);
  page = await (await req('/donations')).text();
  assert.match(page, /Für Zuwendungsbestätigungen fehlt noch etwas/);

  // Bescheid eintragen (Musik = abziehbare Beiträge)
  await run(
    `UPDATE tenants SET npo_purposes = ?, npo_notice = 'exemption', npo_tax_office = 'Teststadt', npo_notice_date = ?, npo_notice_period = '2021 bis 2023',
       npo_signer = 'Kai Kasse, Kassenwart', npo_membership_deductible = 1, donation_receipt_number_format = 'ZB-{YYYY}-{NNNN}' WHERE id = ?`,
    'von Kunst und Kultur (§ 52 Abs. 2 Satz 1 Nr. 5 AO)', `${year - 1}-05-14`, t.id,
  );

  // Sachzuwendung einzeln bestätigen
  r = await req(`/donations/${sache}/receipt`, { form: {} });
  assert.match(location(r), /^\/donations\/receipts\/\d+$/);
  const sachReceipt = (await one('SELECT * FROM donation_receipts WHERE id = ?', Number(location(r).split('/').pop())))!;
  assert.equal(sachReceipt.kind, 'goods');
  assert.equal(sachReceipt.number, `ZB-${year}-0001`);
  assert.equal(sachReceipt.total, 80000);
  assert.equal(Buffer.from(sachReceipt.pdf).subarray(0, 5).toString(), '%PDF-');
  const snap = JSON.parse(sachReceipt.snapshot);
  assert.equal(snap.goods.origin, 'private');
  assert.deepEqual(snap.donor, ['Erika Mustermann', 'Hauptstraße 5', '12345 Teststadt']);

  // Bestätigte Zuwendung ist gesperrt – auch in der Datenbank
  await assert.rejects(run('UPDATE donations SET amount = 1 WHERE id = ?', sache), /Bestaetigte Zuwendungen/);
  await assert.rejects(run('UPDATE donation_receipts SET total = 1 WHERE id = ?', sachReceipt.id), /Zuwendungsbestaetigungen/);
  await assert.rejects(run('DELETE FROM donation_receipts WHERE id = ?', sachReceipt.id), /Zuwendungsbestaetigungen/);
  r = await req(`/donations/${sache}/delete`, { form: {} });
  assert.ok(await one('SELECT 1 FROM donations WHERE id = ?', sache), 'nicht gelöscht');

  // Jahresabschluss: Erika bekommt eine Sammelbestätigung (Spende, Aufwandsspende, Beitrag), die Brauerei eine Einzelbestätigung
  page = await (await req(`/donations?year=${year}`)).text();
  assert.match(page, /4 unbestätigte Zuwendung\(en\) von 2 Zuwendenden/);
  r = await req(`/donations/receipts/collective?year=${year}`, { form: {} });
  const receipts = await all('SELECT * FROM donation_receipts WHERE tenant_id = ? ORDER BY id', t.id);
  assert.equal(receipts.length, 3);
  const sammel = receipts.find((x) => x.contact_id === erika && x.kind === 'collective')!;
  const einzel = receipts.find((x) => x.contact_id === brauerei)!;
  assert.equal(sammel.total, 10000 + 5050 + 6000);
  assert.equal(String(sammel.period_from), `${year}-01-01`);
  assert.equal(String(sammel.period_to), `${year}-12-31`);
  assert.equal(einzel.kind, 'single');
  const items = JSON.parse(sammel.snapshot).items;
  assert.deepEqual(items.map((i: any) => [i.kind, i.waiver, i.amount]), [['membership', false, 6000], ['money', false, 10000], ['money', true, 5050]]);
  for (const id of [m1, m2, beitrag, fremd]) assert.ok((await one('SELECT receipt_id FROM donations WHERE id = ?', id))!.receipt_id);

  // PDF abrufbar, Sammelbestätigung hat die Anlage auf Seite 2
  r = await req(`/donations/receipts/${sammel.id}/pdf`);
  assert.equal(r.headers.get('content-type'), 'application/pdf');
  const pdf = Buffer.from(await r.arrayBuffer()).toString('latin1');
  assert.equal([...pdf.matchAll(/\/Type \/Page\b/g)].length, 2);

  // Storno: Doppel bleibt, Zuwendungen werden frei, neue Bestätigung bekommt neue Nummer
  r = await req(`/donations/receipts/${sammel.id}/cancel`, { form: { reason: 'Betrag korrigiert' } });
  assert.equal((await one('SELECT status FROM donation_receipts WHERE id = ?', sammel.id))!.status, 'cancelled');
  assert.equal((await one('SELECT receipt_id FROM donations WHERE id = ?', m2))!.receipt_id, null);
  r = await req(`/donations/${m2}`, { form: { contact_id: String(erika), kind: 'money', donation_date: d('01-20'), amount: '55', waiver: '1' } });
  assert.equal((await one('SELECT amount FROM donations WHERE id = ?', m2))!.amount, 5500);
  r = await req(`/donations/receipts/collective?year=${year}&contact=${erika}`, { form: {} });
  const neu = (await one("SELECT * FROM donation_receipts WHERE tenant_id = ? AND status = 'issued' AND kind = 'collective'", t.id))!;
  assert.equal(neu.total, 10000 + 5500 + 6000);
  assert.equal(neu.number, `ZB-${year}-0004`);

  // Nicht abziehbare Mitgliedsbeiträge (z. B. Sportverein) werden nicht bestätigt
  await run('UPDATE tenants SET npo_membership_deductible = 0 WHERE id = ?', t.id);
  const b2 = await donate({ donation_date: d('02-01'), amount: '60', kind: 'membership' });
  r = await req(`/donations/${b2}/receipt`, { form: {} });
  assert.equal((await one('SELECT receipt_id FROM donations WHERE id = ?', b2))!.receipt_id, null);
  page = await (await req(`/donations/${b2}`)).text();
  assert.match(page, /ohne Bestätigung/);

  // Zu alter Bescheid (§ 63 Abs. 5 AO) → keine Bestätigung
  await run('UPDATE tenants SET npo_notice_date = ? WHERE id = ?', `${year - 6}-01-01`, t.id);
  const m3 = await donate({ donation_date: d('02-02'), amount: '20' });
  r = await req(`/donations/${m3}/receipt`, { form: {} });
  assert.equal((await one('SELECT receipt_id FROM donations WHERE id = ?', m3))!.receipt_id, null);

  // Übersicht: Spenden zählen zu den Einnahmen (§ 55 AO)
  page = await (await req('/')).text();
  assert.match(page, /Spenden und Mitgliedsbeiträge/);

  // Adressen mit Zuwendungen lassen sich nicht löschen
  r = await req(`/contacts/${erika}/delete`, { form: {} });
  assert.ok(await one('SELECT 1 FROM contacts WHERE id = ?', erika));

  // ohne Gemeinnützigkeit kein Menüpunkt und kein Zugriff
  await run('UPDATE tenants SET nonprofit = 0 WHERE id = ?', t.id);
  page = await (await req('/')).text();
  assert.doesNotMatch(page, /href="\/donations"/);
  r = await req('/donations');
  assert.equal(r.status, 303);
});

test('Kassenbuch: Konten, Zuordnung, Umbuchung, Kassenzählung, Abschluss, Steuerbüro-Paket', opts, async () => {
  const t = (await one("SELECT * FROM tenants WHERE name = 'Musikverein Teststadt e. V.'"))!;
  await req('/tenant/switch', { form: { tenant_id: String(t.id) } });
  await run('UPDATE tenants SET nonprofit = 1, small_business = 0, cashbook_locked_until = NULL WHERE id = ?', t.id);
  const today = new Date().toISOString().slice(0, 10);
  const year = Number(today.slice(0, 4));

  // Menüpunkt für Vereine; ohne Konten geht es zur Kontenverwaltung
  let page = await (await req('/')).text();
  assert.match(page, /href="\/cashbook"/);
  let r = await req('/cashbook');
  assert.equal(location(r), '/cashbook/accounts');

  r = await req('/cashbook/accounts', { form: { name: 'Girokonto', kind: 'bank', iban: '', opening_date: `${year}-01-01`, opening_balance: '1000' } });
  const bank = Number(new URLSearchParams(location(r).split('?')[1]).get('account'));
  r = await req('/cashbook/accounts', { form: { name: 'Barkasse', kind: 'cash', iban: '', opening_date: `${year}-01-01`, opening_balance: '50' } });
  const kasse = Number(new URLSearchParams(location(r).split('?')[1]).get('account'));
  assert.ok(bank && kasse);
  const balance = async (id: number) => {
    const a = (await one('SELECT * FROM cash_accounts WHERE id = ?', id))!;
    const s = (await one('SELECT COALESCE(SUM(amount), 0) s FROM cash_entries WHERE account_id = ?', id))!;
    return Number(a.opening_balance) + Number(s.s);
  };
  assert.equal(await balance(bank), 100000);

  // Spenden ohne Konto erscheinen unter „Noch nicht zugeordnet“
  page = await (await req('/cashbook')).text();
  assert.match(page, /Noch nicht zugeordnet/);
  const spende = (await one("SELECT * FROM donations WHERE tenant_id = ? AND kind = 'money' ORDER BY id LIMIT 1", t.id))!;
  r = await req('/cashbook/assign', { form: { source: 'donation', id: String(spende.id), account_id: String(bank), entry_date: String(spende.donation_date), amount: formatCents(spende.amount) } });
  assert.equal((await one('SELECT account_id FROM cash_entries WHERE donation_id = ?', spende.id))!.account_id, bank);

  // Neue Spende direkt mit Konto
  const erika = (await one("SELECT id FROM contacts WHERE name = 'Erika Mustermann' AND tenant_id = ?", t.id))!.id;
  r = await req('/donations', { form: { contact_id: String(erika), kind: 'money', donation_date: today, amount: '25', account_id: String(kasse) } });
  const neueSpende = Number(location(r).split('/').pop());
  assert.equal((await one('SELECT amount FROM cash_entries WHERE donation_id = ?', neueSpende))!.amount, 2500);

  // Rechnung bezahlt auf das Girokonto (mit Skonto-Betrag), wieder offen → Buchung weg
  const inv = (await one("SELECT * FROM documents WHERE tenant_id = ? AND kind = 'invoice' AND status = 'open' AND sphere = 'ideell'", t.id))!;
  r = await req(`/invoices/${inv.id}/paid`, { form: { paid_at: today, account_id: String(bank), amount: '1166,20' } });
  let entry = (await one('SELECT * FROM cash_entries WHERE document_id = ?', inv.id))!;
  assert.equal(entry.amount, 116620);
  assert.equal((await one('SELECT status FROM documents WHERE id = ?', inv.id))!.status, 'paid');
  r = await req(`/invoices/${inv.id}/paid`, { form: {} });
  assert.equal(await one('SELECT 1 FROM cash_entries WHERE document_id = ?', inv.id), undefined);
  r = await req(`/invoices/${inv.id}/paid`, { form: { paid_at: today, account_id: String(bank), amount: '1190' } });

  // Vereine haben eigene Kostenarten (Unternehmen nicht)
  page = await (await req('/purchases/new')).text();
  assert.match(page, /<optgroup label="Verein">/);
  assert.match(page, /Verbandsbeiträge, GEMA &amp; Abgaben/);

  // Eingangsrechnung bezahlt aus der Kasse
  r = await req('/purchases', { form: { new_supplier: 'Getränke Huber', issue_date: today, sphere: 'business', category: 'bewirtung', 'tax_rate[]': '1900', 'tax_net[]': '', 'tax_tax[]': '', 'tax_gross[]': '119,00' } });
  const pid = Number(location(r).split('/').pop());
  assert.equal((await one('SELECT sphere FROM purchase_invoices WHERE id = ?', pid))!.sphere, 'business');
  assert.equal((await one('SELECT category FROM purchase_invoices WHERE id = ?', pid))!.category, 'bewirtung');
  r = await req(`/purchases/${pid}/paid`, { form: { paid_at: today, account_id: String(kasse), amount: '119' } });
  assert.equal((await one('SELECT amount FROM cash_entries WHERE purchase_id = ?', pid))!.amount, -11900);

  // Freie Buchung, Umbuchung
  r = await req('/cashbook/entries', { form: { account_id: String(kasse), entry_date: today, direction: 'out', amount: '20', text: 'Porto', receipt_ref: 'Q1', sphere: 'ideell', vat_rate: '0' } });
  const porto = (await one("SELECT * FROM cash_entries WHERE tenant_id = ? AND text = 'Porto'", t.id))!;
  assert.equal(porto.amount, -2000);
  r = await req('/cashbook/transfer', { form: { from_id: String(bank), to_id: String(kasse), entry_date: today, amount: '200', text: '' } });
  assert.equal((await all("SELECT * FROM cash_entries WHERE tenant_id = ? AND source = 'transfer'", t.id)).length, 2);

  // Kasse: 50 + 25 − 119 − 20 + 200 = 136 € Buchbestand; gezählt 2×100 + 1×20 + 3×2 = 226 € → 90 € Getränkeverkauf
  assert.equal(await balance(kasse), 13600);
  r = await req('/cashbook/count', { form: { account_id: String(kasse), count_date: today, count_mode: 'denominations', d_10000: '2', d_2000: '1', d_200: '3', text: 'Getränkeverkauf Probenabende', sphere: 'business', vat_rate: '1900', note: 'gezählt von Kai' } });
  const count = (await one('SELECT * FROM cash_counts WHERE account_id = ?', kasse))!;
  assert.equal(count.counted, 22600);
  assert.equal(count.book_balance, 13600);
  assert.equal(count.difference, 9000);
  const diff = (await one('SELECT * FROM cash_entries WHERE count_id = ?', count.id))!;
  assert.equal(diff.amount, 9000);
  assert.equal(diff.sphere, 'business');
  assert.equal(diff.vat_rate, 1900);
  assert.equal(await balance(kasse), 22600);

  // Aufstellung je Bereich (Link aus der Gemeinnützigkeits-Kachel): Bareinnahmen ohne Rechnung und Ausgaben ohne Rechnung
  const yr = today.slice(0, 4);
  let sp = await (await req(`/overview/${yr}?sphere=business&basis=gross`)).text();
  assert.match(sp, /Getränkeverkauf Probenabende/);
  assert.match(sp, /90,00.€/);
  assert.doesNotMatch(sp, />Porto</);
  sp = await (await req(`/overview/${yr}?sphere=ideell&basis=gross`)).text();
  assert.match(sp, />Porto</);
  assert.doesNotMatch(sp, /Getränkeverkauf Probenabende/);
  sp = await (await req(`/overview/${yr}`)).text();
  assert.match(sp, /Getränkeverkauf Probenabende/);
  assert.match(sp, />Porto</, 'ohne Bereich: alle Ausgaben wie im Ergebnis');

  // Übersicht und Kassenbuch zeigen Stände und Verlauf
  page = await (await req('/')).text();
  assert.match(page, /Kontostände/);
  assert.match(page, /class="chart balance-chart"/);
  page = await (await req(`/cashbook?account=${kasse}`)).text();
  assert.match(page, /Getränkeverkauf Probenabende/);
  assert.match(page, /226,00.€/);
  assert.ok([...page.matchAll(/class="chart-bar balance-day/g)].length >= 300, 'ein Tag je Trefferfläche');

  // Zählung nur mit Gesamtsumme: 200,50 € statt 226,00 € → Fehlbetrag 25,50 €
  r = await req('/cashbook/count', { form: { account_id: String(kasse), count_date: today, count_mode: 'total', counted_total: '200,50', text: '', vat_rate: '0' } });
  const count2 = (await one('SELECT * FROM cash_counts WHERE account_id = ? ORDER BY id DESC LIMIT 1', kasse))!;
  assert.equal(count2.counted, 20050);
  assert.equal(count2.denominations, '{}');
  assert.equal(count2.difference, -2550);
  assert.equal((await one('SELECT text FROM cash_entries WHERE count_id = ?', count2.id))!.text, 'Kassenfehlbetrag lt. Kassenzählung');
  assert.equal(await balance(kasse), 20050);
  page = await (await req(`/cashbook/counts?account=${kasse}`)).text();
  assert.match(page, /nur Gesamtsumme/);
  // ohne Summe → Fehler, nichts gespeichert
  r = await req('/cashbook/count', { form: { account_id: String(kasse), count_date: today, count_mode: 'total', counted_total: '' } });
  assert.equal((await all('SELECT id FROM cash_counts WHERE account_id = ?', kasse)).length, 2);

  // Gemeinnützigkeits-Kachel: Barumsatz aus der Kassenzählung zählt im wirtschaftlichen Geschäftsbetrieb mit
  page = await (await req('/')).text();
  assert.match(page, /bar ohne Rechnung 90,00.€/);
  // Umsatz-Kachel enthält die Bareinnahmen ohne Rechnung
  assert.match(page, /class="kpi-big"[^>]*><strong class="num">[^<]*<\/strong>\s*<small>[^<]*bar ohne Rechnung/);

  // Eingangsrechnung mit „Bezahlt am“: Konto ist Pflicht und wird gebucht
  const purchaseCount = async () => Number((await one('SELECT COUNT(*) n FROM purchase_invoices WHERE tenant_id = ?', t.id))!.n);
  const before = await purchaseCount();
  const pform = { new_supplier: 'Druckerei Klein', issue_date: today, paid_at: today, description: 'Plakate Sommerfest', 'tax_rate[]': '1900', 'tax_net[]': '', 'tax_tax[]': '', 'tax_gross[]': '59,50' };
  r = await req('/purchases', { form: pform });
  assert.equal(await purchaseCount(), before, 'ohne Konto nicht gespeichert');
  r = await req('/purchases', { form: { ...pform, paid_account_id: String(bank) } });
  const druck = Number(location(r).split('/').pop());
  assert.equal((await one('SELECT amount FROM cash_entries WHERE purchase_id = ?', druck))!.amount, -5950);
  // Beschreibung in der Tabelle
  page = await (await req('/purchases')).text();
  assert.match(page, /Plakate Sommerfest/);

  // Lieferanten-Kachel: Jahr oder alle Jahre, größte Rechnungen auch bezahlte
  page = await (await req('/?sp=all')).text();
  assert.match(page, /<option value="all" selected>Alle Jahre<\/option>/);
  assert.match(page, /class="liability-name">Druckerei Klein/);

  // Kostenart bei freien Buchungen
  r = await req('/cashbook/entries', { form: { account_id: String(bank), entry_date: today, direction: 'out', amount: '120', text: 'Beitrag Landesverband', category: 'verband', vat_rate: '0' } });
  assert.equal((await one("SELECT category FROM cash_entries WHERE tenant_id = ? AND text = 'Beitrag Landesverband'", t.id))!.category, 'verband');
  // Belege an Buchungen: Foto (JPEG) und PDF beim Erfassen, später nachreichen, Prüfung des Typs
  const multipart = async (path: string, fields: Record<string, string>, files: { name: string; data: Buffer; type: string }[]) => {
    const fd = new FormData();
    fd.append('_csrf', csrf);
    for (const [k, v] of Object.entries(fields)) fd.append(k, v);
    for (const f of files) fd.append('files[]', new Blob([new Uint8Array(f.data)], { type: f.type }), f.name);
    return app.request(path, { method: 'POST', headers: { cookie }, body: fd });
  };
  const jpeg = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(200, 1)]);
  const pdfFile = Buffer.from('%PDF-1.4\n%Testbeleg\n');
  r = await multipart('/cashbook/entries', { account_id: String(kasse), entry_date: today, direction: 'out', amount: '12,40', text: 'Putzmittel Vereinsheim', category: 'vereinsheim', vat_rate: '0' },
    [{ name: 'IMG_0815.jpg', data: jpeg, type: 'image/jpeg' }, { name: 'quittung.pdf', data: pdfFile, type: 'application/pdf' }]);
  const putz = (await one("SELECT * FROM cash_entries WHERE tenant_id = ? AND text = 'Putzmittel Vereinsheim'", t.id))!;
  let att = await all('SELECT * FROM cash_entry_files WHERE entry_id = ? ORDER BY id', putz.id);
  assert.deepEqual(att.map((f) => [f.file_name, f.file_mime]), [['IMG_0815.jpg', 'image/jpeg'], ['quittung.pdf', 'application/pdf']]);
  assert.ok(fs.existsSync(path.join(process.env.SCHOTTR_DATA_DIR!, 'verbindlichkeiten', att[0].file_path)), 'Datei in der Belegablage');
  // Abruf
  r = await req(`/cashbook/files/${att[0].id}?inline=1`);
  assert.equal(r.headers.get('content-type'), 'image/jpeg');
  assert.deepEqual(Buffer.from(await r.arrayBuffer()), jpeg);
  // Liste zeigt die Anzahl, Bearbeiten-Seite die Belege
  page = await (await req(`/cashbook?account=${kasse}`)).text();
  assert.match(page, /2 Belege/);
  page = await (await req(`/cashbook/entries/${putz.id}/edit`)).text();
  assert.match(page, /capture="environment"/);
  assert.match(page, /quittung\.pdf/);
  // nachreichen; falscher Dateityp wird abgelehnt
  r = await multipart(`/cashbook/entries/${putz.id}/files`, {}, [{ name: 'notiz.txt', data: Buffer.from('hallo'), type: 'text/plain' }]);
  assert.equal((await all('SELECT id FROM cash_entry_files WHERE entry_id = ?', putz.id)).length, 2);
  r = await multipart(`/cashbook/entries/${putz.id}/files`, {}, [{ name: 'nachtrag.png', data: Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(50)]), type: 'image/png' }]);
  assert.equal((await all('SELECT id FROM cash_entry_files WHERE entry_id = ?', putz.id)).length, 3);
  // Beleg entfernen und Buchung samt Belegen löschen
  r = await req(`/cashbook/files/${att[1].id}/delete`, { form: {} });
  att = await all('SELECT * FROM cash_entry_files WHERE entry_id = ?', putz.id);
  assert.equal(att.length, 2);
  const putzFile = path.join(process.env.SCHOTTR_DATA_DIR!, 'verbindlichkeiten', att[0].file_path);
  r = await req(`/cashbook/entries/${putz.id}/delete`, { form: {} });
  assert.equal(await one('SELECT 1 FROM cash_entries WHERE id = ?', putz.id), undefined);
  assert.equal((await all('SELECT id FROM cash_entry_files WHERE entry_id = ?', putz.id)).length, 0);
  assert.ok(!fs.existsSync(putzFile), 'Datei aufgeräumt');
  // ein Beleg bleibt für das Steuerbüro-Paket
  r = await multipart('/cashbook/entries', { account_id: String(kasse), entry_date: today, direction: 'out', amount: '3', text: 'Briefmarken', vat_rate: '0' },
    [{ name: 'briefmarken.jpg', data: jpeg, type: 'image/jpeg' }]);

  // Beleg erfassen (Handy): zwei Fotos → ein PDF im Belegeingang (data/other), dann als Buchung zugeordnet
  const png = fs.readFileSync(path.join(import.meta.dirname, 'logo.png'));
  const inboxRows = () => all('SELECT * FROM inbox_files WHERE tenant_id = ? ORDER BY id', t.id);
  page = await (await req('/capture')).text();
  assert.match(page, /Kassenbuch-Buchung/);
  r = await multipart('/capture', { target: 'cash', note: 'Getränke Sommerfest' }, [{ name: 'image.png', data: png, type: 'image/png' }, { name: 'image.png', data: png, type: 'image/png' }]);
  let inbox = await inboxRows();
  assert.equal(inbox.length, 1);
  assert.equal(location(r), `/cashbook/new?inbox=${inbox[0].id}`);
  assert.equal(inbox[0].file_mime, 'application/pdf');
  assert.match(inbox[0].file_name, /^Beleg_\d{4}-\d{2}-\d{2}_\d{4}\.pdf$/);
  const inboxFile = path.join(process.env.SCHOTTR_DATA_DIR!, 'other', inbox[0].file_path);
  assert.ok(fs.existsSync(inboxFile), 'Datei unter data/other');
  r = await req(`/inbox/${inbox[0].id}/file?inline=1`);
  const merged = await PDFDocument.load(new Uint8Array(await r.arrayBuffer()));
  assert.equal(merged.getPageCount(), 2, 'ein PDF mit zwei Seiten');
  page = await (await req(`/cashbook/new?inbox=${inbox[0].id}`)).text();
  assert.match(page, new RegExp(`<iframe src="/inbox/${inbox[0].id}/file\\?inline=1"`));
  assert.match(page, new RegExp(`<option value="${inbox[0].id}" selected>`));
  page = await (await req('/')).text();
  assert.match(page, /<strong>1<\/strong><small>nicht zugeordnet<\/small>/);
  assert.match(page, /Offene Posten/);
  r = await multipart('/cashbook/entries', { account_id: String(kasse), entry_date: today, direction: 'out', amount: '48,90', text: 'Getränke Sommerfest', vat_rate: '0', inbox_id: String(inbox[0].id) }, []);
  const drinks = (await one("SELECT * FROM cash_entries WHERE tenant_id = ? AND text = 'Getränke Sommerfest'", t.id))!;
  att = await all('SELECT * FROM cash_entry_files WHERE entry_id = ?', drinks.id);
  assert.equal(att.length, 1);
  assert.equal(att[0].file_mime, 'application/pdf');
  assert.ok(fs.existsSync(path.join(process.env.SCHOTTR_DATA_DIR!, 'verbindlichkeiten', att[0].file_path)), 'in die Belegablage verschoben');
  assert.ok(!fs.existsSync(inboxFile), 'aus data/other entfernt');
  assert.equal((await inboxRows()).length, 0);

  // „Später zuordnen“ und dann als Eingangsrechnung übernehmen
  const jpeg2 = Buffer.concat([jpeg, Buffer.from('rechnung')]);
  r = await multipart('/capture', { target: 'later' }, [{ name: 'rechnung_baumarkt.jpg', data: jpeg2, type: 'image/jpeg' }]);
  assert.equal(location(r), '/inbox');
  inbox = await inboxRows();
  assert.equal(inbox[0].file_name, 'rechnung_baumarkt.jpg');
  page = await (await req('/inbox')).text();
  assert.match(page, /rechnung_baumarkt\.jpg/);
  assert.match(page, new RegExp(`href="/cashbook/new\\?inbox=${inbox[0].id}"`));
  r = await req(`/inbox/${inbox[0].id}/purchase`, { form: {} });
  const fromInbox = (await one('SELECT * FROM purchase_invoices WHERE tenant_id = ? AND file_name = ?', t.id, 'rechnung_baumarkt.jpg'))!;
  assert.equal(location(r), `/purchases/${fromInbox.id}/edit`);
  assert.equal(fromInbox.status, 'draft');
  assert.equal((await inboxRows()).length, 0);
  // direkt als Eingangsrechnung fotografieren
  r = await multipart('/capture', { target: 'purchase' }, [{ name: 'image.jpg', data: Buffer.concat([jpeg, Buffer.from('foto')]), type: 'image/jpeg' }]);
  assert.match(location(r) ?? '', /^\/purchases\/\d+\/edit$/);
  page = await (await req('/purchases')).text();
  assert.match(page, /data-photo-submit/);
  // Alle Belege
  page = await (await req('/inbox?tab=all')).text();
  assert.match(page, /Getränke Sommerfest/);
  assert.match(page, /rechnung_baumarkt\.jpg/);
  assert.match(page, /briefmarken\.jpg/);
  // falscher Typ: nichts abgelegt
  r = await multipart('/capture', { target: 'later' }, [{ name: 'notiz.txt', data: Buffer.from('hallo'), type: 'text/plain' }]);
  assert.equal((await inboxRows()).length, 0);

  // Einnahmen haben keine Kostenart – auch wenn eine mitgeschickt wird
  r = await req('/cashbook/entries', { form: { account_id: String(kasse), entry_date: today, direction: 'in', amount: '5', text: 'Kuchenverkauf', category: 'verband', vat_rate: '0' } });
  assert.equal((await one("SELECT category FROM cash_entries WHERE tenant_id = ? AND text = 'Kuchenverkauf'", t.id))!.category, '');

  // Dauerauftrag: Miete am 3. jeden Monats seit Jahresbeginn
  r = await req('/cashbook/recurring', { form: { direction: 'out', text: 'Miete Vereinsheim', account_id: String(bank), amount: '350', rhythm: 'monthly',
    start_date: `${year}-01-03`, end_date: '', receipt_ref: 'Mietvertrag vom 01.12.2025', category: 'halle', sphere: 'ideell', vat_rate: '0' } });
  const rec = Number(location(r).split('/').pop());
  assert.ok(rec > 0);
  const dues = Array.from({ length: 12 }, (_, i) => `${year}-${String(i + 1).padStart(2, '0')}-03`).filter((d) => d <= today);
  page = await (await req('/')).text();
  assert.match(page, new RegExp(`Fällige Daueraufträge <span class="count">${dues.length}</span>`));
  // ersten Termin buchen, zweiten überspringen, Rest auf einmal
  r = await req(`/cashbook/recurring/${rec}/book?due=${dues[0]}&back=/`, { form: {} });
  assert.equal(location(r), '/');
  const first = (await one('SELECT * FROM cash_entries WHERE recurring_id = ? AND recurring_due = ?', rec, dues[0]))!;
  assert.equal(first.amount, -35000);
  assert.equal(first.category, 'halle');
  assert.equal(first.text, `Miete Vereinsheim Januar ${year}`);
  r = await req(`/cashbook/recurring/${rec}/book?due=${dues[0]}`, { form: {} });
  assert.equal((await all('SELECT id FROM cash_entries WHERE recurring_id = ?', rec)).length, 1, 'nicht doppelt');
  if (dues.length > 1) r = await req(`/cashbook/recurring/${rec}/skip?due=${dues[1]}`, { form: {} });
  r = await req('/cashbook/recurring/book-all?back=/', { form: {} });
  assert.equal((await all('SELECT id FROM cash_entries WHERE recurring_id = ?', rec)).length, Math.max(1, dues.length - 1));
  page = await (await req('/')).text();
  assert.doesNotMatch(page, /Fällige Daueraufträge/);
  // zukünftige Termine lassen sich nicht vorab buchen
  r = await req(`/cashbook/recurring/${rec}/book?due=${year + 1}-01-03`, { form: {} });
  assert.equal(await one('SELECT 1 FROM cash_entries WHERE recurring_id = ? AND recurring_due = ?', rec, `${year + 1}-01-03`), undefined);

  // Steuerbüro-Paket
  r = await req(`/export/package?year=${year}`);
  assert.equal(r.headers.get('content-type'), 'application/zip');
  const zip = Buffer.from(await r.arrayBuffer()).toString('latin1');
  for (const name of [`00_Uebersicht_${year}.pdf`, `01_Kassenbuch/Barkasse_${year}.pdf`, `01_Kassenbuch/Girokonto_${year}.csv`, `02_Kassenzaehlungen_${year}.csv`,
    `03_Ausgangsrechnungen/Rechnungsausgangsbuch_${year}.csv`, `04_Eingangsrechnungen/Rechnungseingangsbuch_${year}.csv`, `05_Spenden/Zuwendungsliste_${year}.csv`,
    `06_Einnahmen_Ausgaben_${year}.csv`]) {
    assert.ok(zip.includes(name), `${name} im Paket`);
  }
  assert.match(zip, /05_Spenden\/Zuwendungsbestaetigungen\/ZB-\d{4}-0001\.pdf/);
  assert.match(zip, /01_Kassenbuch\/Belege\/Barkasse\/\d{4}-\d{2}-\d{2}_B\d+_briefmarken\.jpg/);

  // Abschluss: danach keine Änderungen mehr – auch nicht direkt in der Datenbank
  r = await req('/cashbook/lock', { form: { date: today } });
  r = await req(`/cashbook/entries/${porto.id}/delete`, { form: {} });
  assert.ok(await one('SELECT 1 FROM cash_entries WHERE id = ?', porto.id), 'nicht gelöscht');
  await assert.rejects(run('UPDATE cash_entries SET amount = 1 WHERE id = ?', porto.id), /abgeschlossen/);
  r = await req(`/purchases/${pid}/open`, { form: {} });
  assert.equal((await one('SELECT status FROM purchase_invoices WHERE id = ?', pid))!.status, 'paid', 'Zahlung im abgeschlossenen Zeitraum bleibt');

  // Unternehmen haben kein Kassenbuch und keine Vereins-Kostenarten
  await run("UPDATE tenants SET org_type = 'company', nonprofit = 0 WHERE id = ?", t.id);
  page = await (await req('/')).text();
  assert.doesNotMatch(page, /href="\/cashbook"/);
  page = await (await req('/purchases/new')).text();
  assert.doesNotMatch(page, /Verbandsbeiträge/);
  await run("UPDATE tenants SET org_type = 'association' WHERE id = ?", t.id);
});

function formatCents(c: number) {
  return (c / 100).toFixed(2).replace('.', ',');
}
