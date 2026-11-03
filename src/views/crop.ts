import { canCrop, hasCrop, type Croppable } from '../lib/crop.ts';
import { html, type SafeHtml } from '../lib/html.ts';
import type { Ctx } from '../types.ts';

/**
 * Knöpfe zum nachträglichen Zuschneiden eines Foto-Belegs. Das Zuschneiden passiert im Browser
 * (public/app.js, [data-crop-action]): Der Dialog lädt immer das Original, der Ausschnitt geht
 * als Feld „image“ per POST an `action`; „Zuschnitt verwerfen“ schickt reset=1.
 * Bewusst Buttons statt Formulare – so lassen sie sich auch innerhalb eines anderen Formulars
 * (z. B. der Erfassung einer Eingangsrechnung) verwenden.
 *
 * @param action  POST-Ziel, z. B. /cashbook/files/12/crop
 * @param fileUrl Adresse der Datei, z. B. /cashbook/files/12 (ohne Query)
 */
export function cropControls(c: Ctx, f: Croppable, action: string, fileUrl: string, opts: { small?: boolean } = {}): SafeHtml {
  if (!canCrop(f)) return html``;
  const csrf = c.get('session')?.csrf ?? '';
  const cls = opts.small ? 'link' : 'btn small ghost';
  return html`<span class="crop-controls">
    <button type="button" class="${cls}" data-crop-action="${action}" data-crop-src="${fileUrl}?inline=1&original=1" data-csrf="${csrf}">${hasCrop(f) ? 'Neu zuschneiden' : '✂ Zuschneiden'}</button>
    ${hasCrop(f)
      ? html`<button type="button" class="${cls}" data-crop-reset="${action}" data-csrf="${csrf}"
          data-confirm-text="Zuschnitt verwerfen? Danach wird wieder das unveränderte Original angezeigt und exportiert.">Zuschnitt verwerfen</button>
        <a class="${opts.small ? 'small' : 'btn small ghost'}" href="${fileUrl}?inline=1&original=1" target="_blank" rel="noopener">Original</a>`
      : ''}
  </span>`;
}
