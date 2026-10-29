import { all, tx } from '../../db/index.ts';
import { audit } from '../../lib/audit.ts';
import { formatDate } from '../../lib/dates.ts';
import { checked, html, type SafeHtml } from '../../lib/html.ts';
import { attachment, idParam, notFound, readForm, redirectWith, str, tenantOf, userOf, UserError } from '../../lib/http.ts';
import { formatMoney } from '../../lib/money.ts';
import { csrfField, empty, page } from '../../views/layout.ts';
import { cashbookEnabled } from '../cashbook/repo.ts';
import { filesFrom } from '../cashbook/files.ts';
import { fileUploader } from '../cashbook/routes.ts';
import { importPurchaseFile, importRedirect } from '../purchases/routes.ts';
import { addInbox, combine, dropInbox, getInbox, inboxOf, readInbox, removeInboxFile, type InboxFile } from './repo.ts';
import type { App, Ctx, Module, Tenant } from '../../types.ts';

/**
 * Belege: ein Ort für alle Belege des Mandanten.
 * - „Beleg erfassen“ (/capture): mit dem Handy fotografieren oder Datei wählen und gleich sagen,
 *   wohin damit – Eingangsrechnung, Kassenbuch-Buchung oder „später zuordnen“.
 * - Belegeingang (/inbox): noch nicht zugeordnete Belege (data/other/…), mit einem Klick als
 *   Eingangsrechnung übernehmen oder einer Buchung zuordnen – die Datei wird dabei verschoben.
 * - „Alle Belege“: Eingangsrechnungen, Kassenbuch-Belege und Belegeingang in einer Liste.
 */

type Target = 'purchase' | 'cash' | 'later';

function postButton(c: Ctx, action: string, label: string, cls = 'btn', confirm?: string): SafeHtml {
  return html`<form method="post" action="${action}" class="inline" ${confirm ? html`data-confirm="${confirm}"` : ''}>${csrfField(c)}<button class="${cls}">${label}</button></form>`;
}

const kb = (n: number) => `${Math.max(1, Math.round(n / 1024))} KB`;

function thumb(f: InboxFile): SafeHtml {
  const src = `/inbox/${f.id}/file?inline=1`;
  return html`<a href="${src}" target="_blank" rel="noopener" class="inbox-thumb" title="${f.file_name} öffnen">
    ${f.file_mime.startsWith('image/') ? html`<img src="${src}" alt="Beleg ${f.file_name}" loading="lazy">` : html`<span class="pdf-badge">PDF</span>`}
  </a>`;
}

function inboxCard(c: Ctx, t: Tenant, f: InboxFile): SafeHtml {
  return html`<li class="inbox-item">
    ${thumb(f)}
    <div class="inbox-meta">
      <strong class="truncate">${f.file_name}</strong>
      <span class="muted small">${formatDate(f.created_at.slice(0, 10))} · ${kb(f.file_size)}${f.note ? html` · ${f.note}` : ''}</span>
      <div class="inline-form">
        ${postButton(c, `/inbox/${f.id}/purchase`, 'Als Eingangsrechnung', 'btn small primary')}
        ${cashbookEnabled(t) ? html`<a class="btn small" href="/cashbook/new?inbox=${f.id}">Als Buchung</a>` : ''}
        ${postButton(c, `/inbox/${f.id}/delete`, 'Löschen', 'btn small ghost danger', `Beleg „${f.file_name}“ endgültig löschen?`)}
      </div>
    </div>
  </li>`;
}

function targetChoice(t: Tenant, current: Target): SafeHtml {
  const opt = (value: Target, label: string, hint: string) => html`<label class="target-option">
    <input type="radio" name="target" value="${value}"${checked(current === value)}>
    <span><strong>${label}</strong><small class="muted">${hint}</small></span></label>`;
  return html`<fieldset class="target-choice"><legend>Was ist das für ein Beleg?</legend>
    ${opt('purchase', 'Eingangsrechnung', 'Rechnung eines Lieferanten – danach Betrag, Lieferant und Kostenart erfassen. E-Rechnungen werden automatisch übernommen.')}
    ${cashbookEnabled(t) ? opt('cash', 'Kassenbuch-Buchung', 'Quittung, Kassenbon, Auslage aus der Barkasse – danach direkt die Buchung erfassen.') : ''}
    ${opt('later', 'Später zuordnen', 'Erst einmal ablegen – im Belegeingang wartet der Beleg auf die Zuordnung.')}
  </fieldset>`;
}

function register(app: App) {
  /* ---------- Beleg erfassen (vor allem fürs Handy) ---------- */

  app.get('/capture', async (c) => {
    const t = tenantOf(c);
    const q = c.req.query('target');
    const target: Target = q === 'purchase' || q === 'later' || (q === 'cash' && cashbookEnabled(t)) ? q : 'purchase';
    return page(c, {
      title: 'Beleg erfassen',
      back: { href: '/', label: 'Übersicht' },
      body: html`<form method="post" action="/capture" enctype="multipart/form-data" class="card stack capture-form">
        ${csrfField(c)}
        ${fileUploader('Beleg', [], undefined, 'Mehrere Fotos nacheinander aufnehmen, wenn der Beleg mehrere Seiten hat – sie werden zu einem PDF zusammengefasst. PDF, JPEG oder PNG, je höchstens 10 MB.')}
        ${targetChoice(t, target)}
        <label>Notiz (optional) <input name="note" maxlength="300" placeholder="z. B. Getränke fürs Sommerfest, bar bezahlt"></label>
        <div class="form-actions"><button class="btn primary">Weiter</button> <a class="btn ghost" href="/inbox">Belegeingang</a></div>
      </form>`,
    });
  });

  app.post('/capture', async (c) => {
    const t = tenantOf(c);
    const user = userOf(c);
    const form = await readForm(c);
    const raw = str(form, 'target');
    const target: Target = raw === 'cash' && cashbookEnabled(t) ? 'cash' : raw === 'later' ? 'later' : 'purchase';
    const note = str(form, 'note', 300);
    let prepared;
    try {
      prepared = await combine(filesFrom(await c.req.parseBody({ all: true })));
    } catch (err) {
      if (err instanceof UserError) return redirectWith(c, `/capture?target=${target}`, 'error', err.message);
      throw err;
    }
    if (target === 'purchase') {
      const r = await importPurchaseFile(c, t, user.id, { name: prepared.name, data: prepared.data });
      if (r.kind === 'skipped' && !r.id) {
        // nicht übernehmbar (z. B. defektes PDF) – nicht verlieren, sondern in den Belegeingang
        const id = await addInbox(t, user.id, prepared, note);
        await audit(c, 'inbox.add', prepared.name);
        return redirectWith(c, '/inbox', 'error', `Als Eingangsrechnung nicht übernommen (${r.message}) – der Beleg liegt jetzt im Belegeingang (Nr. ${id}).`);
      }
      return importRedirect(c, r);
    }
    const id = await addInbox(t, user.id, prepared, note);
    await audit(c, 'inbox.add', prepared.name);
    if (target === 'cash') return redirectWith(c, `/cashbook/new?inbox=${id}`, 'ok', 'Beleg gespeichert – jetzt die Buchung erfassen.');
    return redirectWith(c, '/inbox', 'ok', 'Beleg im Belegeingang abgelegt.');
  });

  /* ---------- Belegeingang ---------- */

  app.get('/inbox', async (c) => {
    const t = tenantOf(c);
    const tab = c.req.query('tab') === 'all' ? 'all' : 'open';
    const items = await inboxOf(t.id);
    const tabs = html`<div class="tabs">
      <a href="/inbox" class="${tab === 'open' ? 'active' : ''}">Nicht zugeordnet <span class="count">${items.length}</span></a>
      <a href="/inbox?tab=all" class="${tab === 'all' ? 'active' : ''}">Alle Belege</a>
    </div>`;
    const uploadCard = html`<section class="card">
      <form method="post" action="/capture" enctype="multipart/form-data" class="stack">
        ${csrfField(c)}<input type="hidden" name="target" value="later">
        ${fileUploader('Beleg ablegen', [], undefined, 'Mehrere Dateien oder Fotos werden zu einem PDF zusammengefasst – für einzelne Belege bitte einzeln ablegen.')}
        <label>Notiz (optional) <input name="note" maxlength="300"></label>
        <div><button class="btn primary">Ablegen</button></div>
      </form>
    </section>`;
    if (tab === 'open') {
      return page(c, {
        title: 'Belege',
        actions: html`<a class="btn primary" href="/capture">Beleg erfassen</a>`,
        body: html`${tabs}
        ${items.length
          ? html`<ul class="plain inbox-grid">${items.map((f) => inboxCard(c, t, f))}</ul>`
          : empty('Keine offenen Belege – alles zugeordnet.')}
        ${uploadCard}
        <p class="muted small">Belege im Eingang liegen unter <code>data/other</code> und werden beim Zuordnen zur Eingangsrechnung bzw. Buchung verschoben.</p>`,
      });
    }

    const q = (c.req.query('q') ?? '').trim().slice(0, 100);
    const like = `%${q}%`;
    type Row = { kind: 'purchase' | 'cash' | 'inbox'; date: string; title: string; sub: string; amount: number | null; href: string; file: string; name: string };
    const purchases = await all<{ id: number; issue_date: string | null; created_at: string; number: string; description: string; file_name: string; gross_total: number; is_credit: number; status: string; label: string | null }>(
      `SELECT p.id, p.issue_date, p.created_at, p.number, p.description, p.file_name, p.gross_total, p.is_credit, p.status,
              COALESCE(NULLIF(c.company, ''), c.name) label
       FROM purchase_invoices p LEFT JOIN contacts c ON c.id = p.contact_id
       WHERE p.tenant_id = ? AND p.file_path IS NOT NULL AND p.file_path <> ''
         ${q ? 'AND (p.number LIKE ? OR p.description LIKE ? OR p.file_name LIKE ? OR c.company LIKE ? OR c.name LIKE ?)' : ''}
       ORDER BY COALESCE(p.issue_date, DATE(p.created_at)) DESC, p.id DESC LIMIT 500`,
      t.id, ...(q ? Array(5).fill(like) : []),
    );
    const cash = cashbookEnabled(t)
      ? await all<{ id: number; entry_id: number; file_name: string; entry_date: string; text: string; amount: number; account: string }>(
        `SELECT f.id, f.entry_id, f.file_name, e.entry_date, e.text, e.amount, a.name account
         FROM cash_entry_files f JOIN cash_entries e ON e.id = f.entry_id JOIN cash_accounts a ON a.id = e.account_id
         WHERE f.tenant_id = ? ${q ? 'AND (f.file_name LIKE ? OR e.text LIKE ? OR e.receipt_ref LIKE ?)' : ''}
         ORDER BY e.entry_date DESC, f.id DESC LIMIT 500`,
        t.id, ...(q ? Array(3).fill(like) : []),
      )
      : [];
    const rows: Row[] = [
      ...purchases.map((p): Row => ({
        kind: 'purchase', date: p.issue_date ?? p.created_at.slice(0, 10), title: p.label || (p.status === 'draft' ? 'Noch nicht erfasst' : 'Eingangsrechnung'),
        sub: [p.number, p.description].filter(Boolean).join(' · '), amount: p.status === 'draft' ? null : (p.is_credit ? -p.gross_total : p.gross_total),
        href: p.status === 'draft' ? `/purchases/${p.id}/edit` : `/purchases/${p.id}`, file: `/purchases/${p.id}/file?inline=1`, name: p.file_name,
      })),
      ...cash.map((f): Row => ({
        kind: 'cash', date: f.entry_date, title: f.text, sub: f.account, amount: f.amount,
        href: `/cashbook/entries/${f.entry_id}/edit`, file: `/cashbook/files/${f.id}?inline=1`, name: f.file_name,
      })),
      ...items.filter((f) => !q || `${f.file_name} ${f.note}`.toLowerCase().includes(q.toLowerCase())).map((f): Row => ({
        kind: 'inbox', date: f.created_at.slice(0, 10), title: 'Nicht zugeordnet', sub: f.note, amount: null,
        href: '/inbox', file: `/inbox/${f.id}/file?inline=1`, name: f.file_name,
      })),
    ].sort((a, b) => b.date.localeCompare(a.date));
    const KIND = { purchase: 'Eingangsrechnung', cash: 'Kassenbuch', inbox: 'Belegeingang' } as const;
    return page(c, {
      title: 'Belege',
      actions: html`<a class="btn primary" href="/capture">Beleg erfassen</a>`,
      body: html`${tabs}
      <form class="toolbar" method="get"><input type="hidden" name="tab" value="all">
        <input type="search" name="q" value="${q}" placeholder="Suchen …" aria-label="Suchen"></form>
      ${rows.length
        ? html`<div class="card flush"><table class="table stack-mobile">
            <thead><tr><th>Datum</th><th>Art</th><th>Beleg</th><th>Datei</th><th class="num">Betrag</th></tr></thead>
            <tbody>${rows.map((r) => html`<tr>
              <td data-label="Datum">${formatDate(r.date)}</td>
              <td data-label="Art"><span class="tag">${KIND[r.kind]}</span></td>
              <td data-label="Beleg"><a href="${r.href}">${r.title}</a>${r.sub ? html`<div class="muted small">${r.sub}</div>` : ''}</td>
              <td data-label="Datei"><a href="${r.file}" target="_blank" rel="noopener" class="truncate">${r.name}</a></td>
              <td data-label="Betrag" class="num">${r.amount === null ? '' : formatMoney(r.amount)}</td>
            </tr>`)}</tbody></table></div>
          <p class="muted small right">${rows.length} Beleg(e)</p>`
        : empty(q ? 'Keine Belege gefunden.' : 'Noch keine Belege.')}`,
    });
  });

  app.get('/inbox/:id/file', async (c) => {
    const t = tenantOf(c);
    const f = await getInbox(t.id, idParam(c)) ?? notFound();
    return c.body(new Uint8Array(await readInbox(f)), 200, {
      'Content-Type': f.file_mime,
      'Content-Disposition': attachment(f.file_name, c.req.query('inline') === '1'),
      'Cache-Control': 'private, no-store',
      'X-Content-Type-Options': 'nosniff',
    });
  });

  /** Als Eingangsrechnung übernehmen – die Datei wandert in die Belegablage der Eingangsrechnungen */
  app.post('/inbox/:id/purchase', async (c) => {
    const t = tenantOf(c);
    const f = await getInbox(t.id, idParam(c)) ?? notFound();
    const r = await importPurchaseFile(c, t, userOf(c).id, { name: f.file_name, data: new Uint8Array(await readInbox(f)) });
    if (r.kind === 'skipped') {
      return r.id
        ? redirectWith(c, '/inbox', 'error', `„${f.file_name}“ ist bereits als Eingangsrechnung erfasst – den Eintrag im Belegeingang kannst du löschen.`)
        : redirectWith(c, '/inbox', 'error', `„${f.file_name}“: ${r.message}.`);
    }
    await dropInbox(f);
    await removeInboxFile(f);
    return importRedirect(c, r);
  });

  app.post('/inbox/:id/delete', async (c) => {
    const t = tenantOf(c);
    const f = await getInbox(t.id, idParam(c)) ?? notFound();
    await tx(() => dropInbox(f));
    await removeInboxFile(f);
    await audit(c, 'inbox.delete', f.file_name);
    return redirectWith(c, '/inbox', 'ok', 'Beleg gelöscht.');
  });
}

export const inboxModule: Module = {
  name: 'inbox',
  nav: { label: 'Belege', href: '/inbox', order: 31.5 },
  register,
};
