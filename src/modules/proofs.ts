import { all, one, run, nowIso } from '../db/index.ts';
import { audit } from '../lib/audit.ts';
import { html, raw, type SafeHtml } from '../lib/html.ts';
import { attachment, idParam, notFound, readForm, redirectWith, str, tenantOf, userOf } from '../lib/http.ts';
import { inspectPdf } from '../lib/pdfmerge.ts';
import { readStoredFile, removeStoredFile, saveFile, sha256 } from '../lib/files.ts';
import { csrfField, empty, page } from '../views/layout.ts';
import { fromDbTime } from '../db/index.ts';
import type { App, Ctx, Module } from '../types.ts';

/**
 * Nachweisdokumentationen: zentral hochgeladene, benannte PDFs (Aufmaß, Stundenzettel,
 * Abnahmeprotokoll …), die an Rechnungen angehängt werden – als zusätzliche Seiten im
 * Rechnungs-PDF und als rechnungsbegründende Unterlagen (BG-24) in der XRechnung.
 */
export const MAX_PROOF_SIZE = 10 * 1024 * 1024;

export interface Proof {
  id: number;
  name: string;
  filename: string;
  size: number;
  pages: number;
  pdfa_ok: number;
  archived: number;
  created_at: string;
}

const COLS = 'id, name, filename, size, pages, pdfa_ok, archived, created_at';

export async function proofOptions(tenantId: number, includeIds: number[] = []): Promise<Proof[]> {
  return all<Proof>(
    `SELECT ${COLS} FROM proof_documents WHERE tenant_id = ? AND (archived = 0 OR id IN (${includeIds.length ? includeIds.map(() => '?').join(',') : '0'}))
     ORDER BY name`,
    tenantId, ...includeIds,
  );
}

export async function getProofIds(docId: number): Promise<number[]> {
  return (await all<{ proof_id: number }>('SELECT proof_id FROM document_proofs WHERE document_id = ? ORDER BY `position`', docId)).map((r) => r.proof_id);
}

/** Inhalt eines Nachweises – aus der Dateiablage (bzw. bei Altbeständen noch aus der Datenbank) */
async function proofContent(r: { path: string | null; data?: Buffer | null }): Promise<Buffer> {
  if (r.path) return readStoredFile('nachweise', r.path);
  if (r.data) return Buffer.from(r.data);
  throw new Error('Nachweis ohne Inhalt');
}

/** Angehängte Nachweise eines Belegs inkl. Inhalt (für PDF/XML) */
export async function getProofFiles(docId: number) {
  const rows = await all<{ id: number; name: string; filename: string; path: string | null; data: Buffer | null; pdfa_ok: number }>(
    `SELECT p.id, p.name, p.filename, p.path, IF(p.path IS NULL, p.data, NULL) AS data, p.pdfa_ok
     FROM document_proofs dp JOIN proof_documents p ON p.id = dp.proof_id
     WHERE dp.document_id = ? ORDER BY dp.\`position\`, p.name`,
    docId,
  );
  const out = [];
  for (const r of rows) out.push({ id: r.id, name: r.name, filename: r.filename, pdfa_ok: r.pdfa_ok, data: await proofContent(r) });
  return out;
}

/**
 * Einmalige Umstellung: Nachweise, deren Inhalt noch in der Datenbank liegt, in die Dateiablage
 * verschieben. Der Datenbankinhalt wird erst gelöscht, nachdem die Datei geschrieben und
 * erneut gelesen (Prüfsumme) wurde.
 */
export async function migrateProofBlobs(): Promise<number> {
  const ids = await all<{ id: number }>('SELECT id FROM proof_documents WHERE path IS NULL AND data IS NOT NULL');
  for (const { id } of ids) {
    const r = await one<{ tenant_id: number; filename: string; data: Buffer }>('SELECT tenant_id, filename, data FROM proof_documents WHERE id = ?', id);
    if (!r) continue;
    const data = Buffer.from(r.data);
    const stored = await saveFile('nachweise', r.tenant_id, r.filename, data);
    if (sha256(await readStoredFile('nachweise', stored.path)) !== stored.sha256) throw new Error(`Nachweis ${id}: Prüfsumme stimmt nach dem Schreiben nicht`);
    await run('UPDATE proof_documents SET path = ?, sha256 = ?, data = NULL WHERE id = ? AND path IS NULL', stored.path, stored.sha256, id);
  }
  if (ids.length) console.log(`${ids.length} Nachweis(e) aus der Datenbank in die Dateiablage verschoben`);
  return ids.length;
}

/** Verknüpfungen eines Entwurfs speichern (nur Nachweise desselben Mandanten). */
export async function writeProofLinks(tenantId: number, docId: number, ids: number[]) {
  await run('DELETE FROM document_proofs WHERE document_id = ?', docId);
  let pos = 0;
  for (const id of ids) {
    const ok = await one('SELECT 1 FROM proof_documents WHERE id = ? AND tenant_id = ?', id, tenantId);
    if (ok) await run('INSERT INTO document_proofs (document_id, proof_id, `position`) VALUES (?, ?, ?)', docId, id, pos++);
  }
}

const kb = (n: number) => (n >= 1024 * 1024 ? `${(n / 1024 / 1024).toFixed(1).replace('.', ',')} MB` : `${Math.max(1, Math.round(n / 1024))} KB`);

/** Auswahl im Rechnungsformular */
export function proofPicker(proofs: Proof[], selectedIds: number[]): SafeHtml {
  return html`<section class="card">
    <h2>Nachweise anhängen</h2>
    ${proofs.length
      ? html`<p class="muted small">Ausgewählte Nachweise werden hinten an das Rechnungs-PDF angehängt und in der XRechnung als rechnungsbegründende Unterlagen mitgeschickt.</p>
        <ul class="plain proof-list">${proofs.map((p) => html`<li>
          <label class="check"><input type="checkbox" name="proof_ids[]" value="${p.id}"${selectedIds.includes(p.id) ? raw(' checked') : ''}>
            <span><strong>${p.name}</strong> <span class="muted small">· ${p.filename} · ${p.pages} Seite(n) · ${kb(p.size)}</span>
            ${p.pdfa_ok ? '' : html` <span class="tag warn" title="Schriften nicht eingebettet – das Rechnungs-PDF ist damit nicht mehr streng PDF/A-3">nicht PDF/A</span>`}</span>
          </label></li>`)}</ul>`
      : html`<p class="muted small">Noch keine Nachweise vorhanden. <a href="/proofs">Nachweise hochladen</a></p>`}
  </section>`;
}

function register(app: App) {
  app.get('/proofs', async (c) => {
    const t = tenantOf(c);
    const showArchived = c.req.query('archived') === '1';
    const rows = await all<Proof & { used: number }>(
      `SELECT ${COLS.split(', ').map((x) => `p.${x}`).join(', ')},
         (SELECT COUNT(*) FROM document_proofs dp WHERE dp.proof_id = p.id) AS used
       FROM proof_documents p WHERE p.tenant_id = ? AND p.archived = ? ORDER BY p.name`,
      t.id, showArchived ? 1 : 0,
    );
    return page(c, {
      title: 'Nachweise',
      body: html`
      <p class="muted">Nachweisdokumentationen wie Aufmaße, Stundenzettel oder Abnahmeprotokolle zentral ablegen und beim Schreiben einer Rechnung auswählen.</p>
      <section class="card">
        <h2>Nachweis hochladen</h2>
        <form method="post" action="/proofs" enctype="multipart/form-data" class="grid-3 upload-form">
          ${csrfField(c)}
          <label>Bezeichnung <input name="name" required maxlength="200" placeholder="z. B. Aufmaß Bauabschnitt 1"></label>
          <label>PDF-Datei <input type="file" name="file" accept="application/pdf" required></label>
          <div class="form-actions"><button class="btn primary">Hochladen</button></div>
        </form>
        <small class="muted">Nur PDF, max. 10 MB. Am besten PDF/A bzw. PDFs mit eingebetteten Schriften (z. B. Scans oder „Als PDF/A speichern“), dann bleibt die Rechnung voll PDF/A-3-konform.</small>
      </section>
      <form class="toolbar" method="get">
        <label class="check small"><input type="checkbox" name="archived" value="1" data-autosubmit ${showArchived ? html`checked` : ''}> Archiv</label>
      </form>
      ${rows.length
        ? html`<div class="card flush"><table class="table">
          <thead><tr><th>Bezeichnung</th><th>Datei</th><th class="right">Seiten</th><th class="right">Größe</th><th>Hochgeladen</th><th class="right">Verwendet</th><th></th></tr></thead>
          <tbody>${rows.map((p) => html`<tr>
            <td>
              <form method="post" action="/proofs/${p.id}/rename" class="rename-form">${csrfField(c)}
                <input name="name" value="${p.name}" maxlength="200" aria-label="Bezeichnung" required>
                <button class="link">Umbenennen</button>
              </form>
              ${p.pdfa_ok ? '' : html`<span class="tag warn" title="Schriften nicht eingebettet">nicht PDF/A</span>`}
            </td>
            <td><a href="/proofs/${p.id}/file" target="_blank">${p.filename}</a></td>
            <td class="right num">${p.pages}</td>
            <td class="right num">${kb(p.size)}</td>
            <td>${fromDbTime(p.created_at).toLocaleDateString('de-DE', { timeZone: 'Europe/Berlin' })}</td>
            <td class="right num">${p.used}×</td>
            <td class="right nowrap">
              <form method="post" action="/proofs/${p.id}/archive" class="inline">${csrfField(c)}<button class="link">${p.archived ? 'Wiederherstellen' : 'Archivieren'}</button></form>
              ${p.used ? '' : html` · <form method="post" action="/proofs/${p.id}/delete" class="inline" data-confirm="Nachweis „${p.name}“ löschen?">${csrfField(c)}<button class="link danger">Löschen</button></form>`}
            </td></tr>`)}
          </tbody></table></div>`
        : empty(showArchived ? 'Keine archivierten Nachweise.' : 'Noch keine Nachweise hochgeladen.')}`,
    });
  });

  app.post('/proofs', async (c) => {
    const t = tenantOf(c);
    const body = await c.req.parseBody();
    const name = String(body.name ?? '').trim().slice(0, 200);
    const file = body.file;
    if (!name) return redirectWith(c, '/proofs', 'error', 'Bitte eine Bezeichnung angeben.');
    if (!(file instanceof File) || !file.size) return redirectWith(c, '/proofs', 'error', 'Bitte eine PDF-Datei auswählen.');
    if (file.size > MAX_PROOF_SIZE) return redirectWith(c, '/proofs', 'error', 'Die Datei darf höchstens 10 MB groß sein.');
    const data = Buffer.from(await file.arrayBuffer());
    let info;
    try {
      info = await inspectPdf(data);
    } catch (err) {
      const msg = /encrypt/i.test(String(err)) ? 'Verschlüsselte bzw. passwortgeschützte PDFs können nicht angehängt werden.' : 'Die Datei ist keine gültige PDF.';
      return redirectWith(c, '/proofs', 'error', msg);
    }
    const filename = (file.name || 'nachweis.pdf').replace(/[^\w.\-äöüÄÖÜß ]+/g, '_').slice(0, 150).replace(/(\.pdf)?$/i, '.pdf');
    const now = nowIso();
    const stored = await saveFile('nachweise', t.id, filename, data);
    try {
      await run(
        'INSERT INTO proof_documents (tenant_id, name, filename, path, sha256, size, pages, pdfa_ok, created_by, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
        t.id, name, filename, stored.path, stored.sha256, data.length, info.pages, info.fontsEmbedded ? 1 : 0, userOf(c).id, now, now,
      );
    } catch (err) {
      await removeStoredFile('nachweise', stored.path);
      throw err;
    }
    await audit(c, 'proof.upload', `${name} (${filename})`);
    return redirectWith(c, '/proofs', 'ok', info.fontsEmbedded
      ? `„${name}“ hochgeladen.`
      : `„${name}“ hochgeladen. Hinweis: Die PDF enthält nicht eingebettete Schriften – Rechnungen mit diesem Anhang sind nicht mehr streng PDF/A-3 (die E-Rechnungsdaten bleiben gültig).`);
  });

  app.get('/proofs/:id/file', async (c) => {
    const t = tenantOf(c);
    const p = (await one<{ path: string | null; data: Buffer | null; filename: string }>(
      'SELECT path, IF(path IS NULL, data, NULL) AS data, filename FROM proof_documents WHERE id = ? AND tenant_id = ?', idParam(c), t.id,
    )) ?? notFound();
    return c.body(new Uint8Array(await proofContent(p)), 200, {
      'Content-Type': 'application/pdf',
      'Content-Disposition': attachment(p.filename, true),
      'Cache-Control': 'private, no-store',
    });
  });

  app.post('/proofs/:id/rename', async (c) => {
    const t = tenantOf(c);
    const name = str(await readForm(c), 'name', 200);
    if (!name) return redirectWith(c, '/proofs', 'error', 'Bitte eine Bezeichnung angeben.');
    await run('UPDATE proof_documents SET name = ?, updated_at = ? WHERE id = ? AND tenant_id = ?', name, nowIso(), idParam(c), t.id);
    return redirectWith(c, '/proofs', 'ok', 'Bezeichnung geändert. Bereits festgeschriebene Rechnungen behalten die alte Bezeichnung.');
  });

  app.post('/proofs/:id/archive', async (c) => {
    const t = tenantOf(c);
    const p = (await one('SELECT id, archived FROM proof_documents WHERE id = ? AND tenant_id = ?', idParam(c), t.id)) ?? notFound();
    await run('UPDATE proof_documents SET archived = ?, updated_at = ? WHERE id = ?', p.archived ? 0 : 1, nowIso(), p.id);
    return redirectWith(c, `/proofs${p.archived ? '?archived=1' : ''}`, 'ok', p.archived ? 'Nachweis wiederhergestellt.' : 'Nachweis archiviert.');
  });

  app.post('/proofs/:id/delete', async (c) => {
    const t = tenantOf(c);
    const p = (await one('SELECT id, name, path FROM proof_documents WHERE id = ? AND tenant_id = ?', idParam(c), t.id)) ?? notFound();
    if (await one('SELECT 1 FROM document_proofs WHERE proof_id = ? LIMIT 1', p.id)) {
      return redirectWith(c, '/proofs', 'error', 'Dieser Nachweis ist an Belegen angehängt und kann nur archiviert werden.');
    }
    await run('DELETE FROM proof_documents WHERE id = ?', p.id);
    if (p.path) await removeStoredFile('nachweise', p.path);
    await audit(c, 'proof.delete', p.name);
    return redirectWith(c, '/proofs', 'ok', 'Nachweis gelöscht.');
  });
}

export const proofsModule: Module = {
  name: 'proofs',
  nav: { label: 'Nachweise', href: '/proofs', order: 40, group: 'sales', icon: 'proofs' },
  register,
};

export type { Ctx };
