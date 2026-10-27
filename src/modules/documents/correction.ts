import crypto from 'node:crypto';
import { all, one, run, tx, nowIso, fromDbTime } from '../../db/index.ts';
import { audit } from '../../lib/audit.ts';
import { html, type SafeHtml } from '../../lib/html.ts';
import { attachment, idParam, notFound, readForm, redirectWith, str, tenantOf, userOf } from '../../lib/http.ts';
import { formatMoney } from '../../lib/money.ts';
import { csrfField, page } from '../../views/layout.ts';
import type { App, Ctx, Module, Tenant } from '../../types.ts';

/**
 * Nachträgliche Bearbeitung festgeschriebener Rechnungen.
 *
 * GoBD verlangt, dass der ursprüngliche Inhalt feststellbar bleibt. Deshalb wird vor dem
 * Öffnen die bisherige Fassung (Daten, ZUGFeRD-PDF, XRechnung) unveränderlich in
 * document_versions archiviert, ein Änderungsgrund ist Pflicht und alles wird protokolliert.
 * Die Rechnungsnummer bleibt erhalten; nach der Bearbeitung wird erneut festgeschrieben.
 */

const ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // ohne 0/O, 1/I – gut abschreibbar
const codes = new Map<string, { code: string; exp: number; tries: number }>();

function issueCode(key: string): string {
  const code = Array.from({ length: 6 }, () => ALPHABET[crypto.randomInt(ALPHABET.length)]).join('');
  codes.set(key, { code, exp: Date.now() + 10 * 60_000, tries: 0 });
  if (codes.size > 5000) for (const [k, v] of codes) if (v.exp < Date.now()) codes.delete(k);
  return code;
}

interface ReopenableDoc {
  id: number;
  number: string;
  type_code: string;
  status: string;
  finalized_at: string | null;
  revision: number;
  gross_total: number;
}

/** Gründe, warum eine Rechnung nicht nachträglich bearbeitet werden kann (oder null). */
export async function reopenBlocker(doc: ReopenableDoc): Promise<string | null> {
  if (!doc.finalized_at) return 'Die Rechnung ist nicht festgeschrieben.';
  if (doc.type_code === '381') return 'Stornorechnungen können nicht nachträglich bearbeitet werden.';
  if (doc.status === 'cancelled') return 'Stornierte Rechnungen können nicht nachträglich bearbeitet werden.';
  const usedIn = await one<{ number: string }>(
    `SELECT f.number FROM document_prepayments p JOIN documents f ON f.id = p.document_id
     WHERE p.prepaid_id = ? AND f.finalized_at IS NOT NULL AND f.status <> 'cancelled' LIMIT 1`,
    doc.id,
  );
  if (usedIn) return `Diese Teilrechnung ist bereits in ${usedIn.number} abgezogen und kann daher nicht mehr geändert werden.`;
  return null;
}

/** Abschnitt „Versionen“ auf der Rechnungsseite */
export async function versionsSection(docId: number): Promise<SafeHtml> {
  const versions = await all(
    'SELECT version, number, gross_total, finalized_at, reason, reopened_by_email, reopened_at FROM document_versions WHERE document_id = ? ORDER BY version DESC',
    docId,
  );
  if (!versions.length) return html``;
  const dt = (v: string) => fromDbTime(v).toLocaleString('de-DE', { timeZone: 'Europe/Berlin', dateStyle: 'short', timeStyle: 'short' });
  return html`<section>
    <h2 class="section-title">Frühere Fassungen <span class="count">${versions.length}</span></h2>
    <div class="card flush"><table class="table">
      <thead><tr><th>Fassung</th><th>Festgeschrieben</th><th class="right">Brutto</th><th>Geöffnet</th><th>Grund</th><th></th></tr></thead>
      <tbody>${versions.map((v) => html`<tr>
        <td>Version ${v.version}</td>
        <td>${dt(v.finalized_at)}</td>
        <td class="right num">${formatMoney(v.gross_total)}</td>
        <td>${dt(v.reopened_at)}<div class="muted small">${v.reopened_by_email}</div></td>
        <td class="small">${v.reason}</td>
        <td class="right nowrap"><a href="/invoices/${docId}/versions/${v.version}/pdf" target="_blank">PDF</a> · <a href="/invoices/${docId}/versions/${v.version}/xml">XML</a></td>
      </tr>`)}</tbody></table></div>
  </section>`;
}

function codeBox(code: string): SafeHtml {
  // Zeichen nur per CSS-Pseudoelement → nicht markier- oder kopierbar
  return html`<div class="confirm-code" aria-hidden="true">${[...code].map((ch) => html`<span data-c="${ch}"></span>`)}</div>`;
}

async function loadDoc(t: Tenant, id: number) {
  return one<ReopenableDoc & { issue_date: string; paid_at: string | null }>(
    "SELECT id, number, type_code, status, finalized_at, revision, gross_total, issue_date, paid_at FROM documents WHERE tenant_id = ? AND id = ? AND kind = 'invoice'",
    t.id, id,
  );
}

function confirmPage(c: Ctx, doc: Awaited<ReturnType<typeof loadDoc>> & {}, code: string, reason = '', error?: string) {
  return page(c, {
    title: `Rechnung ${doc.number} nachträglich bearbeiten`,
    back: { href: `/invoices/${doc.id}`, label: `Rechnung ${doc.number}` },
    status: error ? 400 : 200,
    body: html`
    ${error ? html`<div class="flash flash-error" role="alert">${error}</div>` : ''}
    <div class="notice danger-notice">
      <strong>Achtung – festgeschriebene Rechnungen sollten grundsätzlich nicht verändert werden.</strong>
      <ul>
        <li>Wurde die Rechnung schon verschickt, hat dein Kunde die alte Fassung. Rechtlich sauber ist dann meist <strong>Stornieren und neu erstellen</strong> bzw. eine Korrekturrechnung (§ 14 Abs. 4, § 31 Abs. 5 UStDV).</li>
        <li>Ein falscher Steuerausweis kann nach § 14c UStG zu einer zusätzlichen Steuerschuld führen.</li>
        <li>Schottr archiviert die bisherige Fassung (PDF, XRechnung, Daten) unveränderlich und protokolliert die Änderung mit Grund – so bleibt der ursprüngliche Inhalt nach GoBD nachvollziehbar.</li>
        <li>Die Rechnungsnummer bleibt <strong>${doc.number}</strong>. Bis zum erneuten Festschreiben ist die Rechnung ein Entwurf.</li>
      </ul>
    </div>
    <form method="post" action="/invoices/${doc.id}/correct" class="card stack narrow" autocomplete="off">
      ${csrfField(c)}
      <label>Grund der Änderung <span class="muted small">(Pflicht, erscheint in der Versionshistorie)</span>
        <textarea name="reason" rows="3" required minlength="10" maxlength="1000" placeholder="z. B. Tippfehler in der Anschrift des Kunden korrigiert">${reason}</textarea>
      </label>
      <div>
        <p class="small">Zur Bestätigung bitte diesen Code abschreiben:</p>
        ${codeBox(code)}
      </div>
      <label>Code <input name="code" required maxlength="6" class="code-input" data-no-paste autocomplete="off" spellcheck="false" autocapitalize="characters"></label>
      <div class="form-actions"><button class="btn danger">Rechnung zur Bearbeitung öffnen</button></div>
    </form>`,
  });
}

function register(app: App) {
  app.get('/invoices/:id/correct', async (c) => {
    const t = tenantOf(c);
    const doc = (await loadDoc(t, idParam(c))) ?? notFound();
    const blocker = await reopenBlocker(doc);
    if (blocker) return redirectWith(c, `/invoices/${doc.id}`, 'error', blocker);
    const code = issueCode(`${c.get('session')!.id}:${doc.id}`);
    return confirmPage(c, doc, code);
  });

  app.post('/invoices/:id/correct', async (c) => {
    const t = tenantOf(c);
    const user = userOf(c);
    const doc = (await loadDoc(t, idParam(c))) ?? notFound();
    const blocker = await reopenBlocker(doc);
    if (blocker) return redirectWith(c, `/invoices/${doc.id}`, 'error', blocker);

    const form = await readForm(c);
    const reason = str(form, 'reason', 1000);
    const typed = str(form, 'code', 20).toUpperCase().replace(/\s+/g, '');
    const key = `${c.get('session')!.id}:${doc.id}`;
    const entry = codes.get(key);

    if (!entry || entry.exp < Date.now()) {
      return confirmPage(c, doc, issueCode(key), reason, 'Der Code ist abgelaufen. Bitte den neuen Code abschreiben.');
    }
    if (typed !== entry.code) {
      entry.tries++;
      const code = entry.tries >= 3 ? issueCode(key) : entry.code;
      return confirmPage(c, doc, code, reason, entry.tries >= 3 ? 'Code dreimal falsch – hier ist ein neuer Code.' : 'Der Code stimmt nicht.');
    }
    if (reason.length < 10) return confirmPage(c, doc, entry.code, reason, 'Bitte den Grund der Änderung angeben (mind. 10 Zeichen).');
    codes.delete(key);

    const version = await tx(async () => {
      const cur = await one('SELECT * FROM documents WHERE id = ? FOR UPDATE', doc.id);
      if (!cur?.finalized_at) throw new Error('Rechnung ist nicht (mehr) festgeschrieben.');
      const v = cur.revision + 1;
      await run(
        `INSERT INTO document_versions (document_id, version, number, status, net_total, tax_total, gross_total, snapshot, xml, pdf,
           finalized_at, reason, reopened_by, reopened_by_email, reopened_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        cur.id, v, cur.number, cur.status, cur.net_total, cur.tax_total, cur.gross_total, cur.snapshot, cur.xml, cur.pdf,
        cur.finalized_at, reason, user.id, user.email, nowIso(),
      );
      // Sperre nur für genau diese Rechnung und nur in dieser Transaktion lösen
      await run('SET @schottr_reopen = ?', cur.id);
      try {
        await run(
          "UPDATE documents SET finalized_at = NULL, status = 'draft', snapshot = NULL, xml = NULL, pdf = NULL, revision = ?, updated_at = ? WHERE id = ?",
          v, nowIso(), cur.id,
        );
      } finally {
        await run('SET @schottr_reopen = NULL');
      }
      return v;
    });
    await audit(c, 'invoice.reopen', `${doc.number} (Fassung ${version} archiviert): ${reason}`);
    return redirectWith(c, `/invoices/${doc.id}/edit`, 'ok',
      `Rechnung ${doc.number} ist zur Bearbeitung geöffnet. Die bisherige Fassung ist als Version ${version} archiviert. Nach dem Bearbeiten bitte erneut festschreiben.`);
  });

  app.get('/invoices/:id/versions/:v/:format{pdf|xml}', async (c) => {
    const t = tenantOf(c);
    const doc = (await loadDoc(t, idParam(c))) ?? notFound();
    const v = await one<{ pdf: Buffer | null; xml: string | null; number: string; version: number }>(
      'SELECT pdf, xml, number, version FROM document_versions WHERE document_id = ? AND version = ?', doc.id, Number(c.req.param('v')),
    );
    if (!v) notFound();
    const name = `${v.number}_Version_${v.version}`.replace(/[^\w.\-]+/g, '_');
    if (c.req.param('format') === 'pdf') {
      if (!v.pdf) notFound();
      return c.body(new Uint8Array(v.pdf), 200, { 'Content-Type': 'application/pdf', 'Content-Disposition': attachment(`${name}.pdf`, true), 'Cache-Control': 'private, no-store' });
    }
    if (!v.xml) notFound();
    return c.body(v.xml, 200, { 'Content-Type': 'application/xml; charset=utf-8', 'Content-Disposition': attachment(`${name}_XRechnung.xml`), 'Cache-Control': 'private, no-store' });
  });
}

export const correctionModule: Module = { name: 'invoice-correction', register };
