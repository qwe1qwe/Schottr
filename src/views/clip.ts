import { html, type SafeHtml } from '../lib/html.ts';

/** Büroklammer: Anlage vorhanden – Herkunft im Tooltip, bei mehreren die Anzahl daneben */
export function clip(title: string, n = 1): SafeHtml {
  return html`<span class="clip" title="${title}" role="img" aria-label="Anlage: ${title}">📎${n > 1 ? html`<span class="clip-n">${n}</span>` : ''}</span>`;
}
