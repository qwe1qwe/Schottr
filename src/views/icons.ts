import { raw, type SafeHtml } from '../lib/html.ts';

/**
 * Kleines, eigenes Strich-Icon-Set (24×24, currentColor) für Navigation und Bedienelemente.
 * Bewusst ohne Fremdbibliothek; neue Symbole einfach als Pfad-Markup ergänzen.
 */
const paths = {
  dashboard: '<rect x="3.5" y="3.5" width="7" height="8" rx="1.5"/><rect x="13.5" y="3.5" width="7" height="5" rx="1.5"/><rect x="13.5" y="11.5" width="7" height="9" rx="1.5"/><rect x="3.5" y="14.5" width="7" height="6" rx="1.5"/>',
  contacts: '<circle cx="9" cy="8.5" r="3.5"/><path d="M3 19.5c.6-3.2 3.1-5 6-5s5.4 1.8 6 5"/><path d="M15.5 5.2a3.4 3.4 0 0 1 0 6.6"/><path d="M17.5 14.8c1.8.6 3 2.2 3.5 4.7"/>',
  articles: '<path d="M12 3 20 7.5v9L12 21l-8-4.5v-9L12 3Z"/><path d="m4 7.5 8 4.5 8-4.5"/><path d="M12 12v9"/>',
  quotes: '<path d="M14 3.5H7A1.5 1.5 0 0 0 5.5 5v14A1.5 1.5 0 0 0 7 20.5h10a1.5 1.5 0 0 0 1.5-1.5V8L14 3.5Z"/><path d="M14 3.5V8h4.5"/><path d="M9 12.5h6M9 16h4"/>',
  invoices: '<path d="M6 3.5h12v17l-2.5-1.6-2 1.6-1.5-1.2-1.5 1.2-2-1.6L6 20.5v-17Z"/><path d="M9.5 8h5M9.5 11.5h5"/><path d="M9.5 15h3"/>',
  purchases: '<path d="M14 3.5H7A1.5 1.5 0 0 0 5.5 5v14A1.5 1.5 0 0 0 7 20.5h10a1.5 1.5 0 0 0 1.5-1.5V8L14 3.5Z"/><path d="M14 3.5V8h4.5"/><path d="M12 10.5v6M9.5 14l2.5 2.5 2.5-2.5"/>',
  inbox: '<path d="M3.5 13.5 6 5.5A1.5 1.5 0 0 1 7.4 4.5h9.2A1.5 1.5 0 0 1 18 5.5l2.5 8"/><path d="M3.5 13.5V18a1.5 1.5 0 0 0 1.5 1.5h14a1.5 1.5 0 0 0 1.5-1.5v-4.5H15.5l-1.5 2.5h-4l-1.5-2.5h-5Z"/>',
  proofs: '<path d="m20 11.5-7.8 7.8a5 5 0 0 1-7.1-7.1l7.9-7.9a3.4 3.4 0 0 1 4.8 4.8l-7.9 7.9a1.7 1.7 0 0 1-2.4-2.4l7.2-7.2"/>',
  donations: '<path d="M12 20s-7.5-4.4-7.5-10A4.3 4.3 0 0 1 12 7.2 4.3 4.3 0 0 1 19.5 10c0 5.6-7.5 10-7.5 10Z"/>',
  cashbook: '<path d="M4 7.5A2 2 0 0 1 6 5.5h11.5V9"/><rect x="4" y="9" width="16.5" height="10.5" rx="2"/><path d="M16 14.2h1.5"/>',
  dunning: '<path d="M6 16.5V11a6 6 0 0 1 12 0v5.5l1.5 2h-15l1.5-2Z"/><path d="M10 20.5a2.2 2.2 0 0 0 4 0"/>',
  export: '<path d="M12 4v11M7.5 10.5 12 15l4.5-4.5"/><path d="M4.5 16v2.5A1.5 1.5 0 0 0 6 20h12a1.5 1.5 0 0 0 1.5-1.5V16"/>',
  organization: '<path d="M4.5 20.5V5A1.5 1.5 0 0 1 6 3.5h7A1.5 1.5 0 0 1 14.5 5v15.5"/><path d="M14.5 9.5H18a1.5 1.5 0 0 1 1.5 1.5v9.5"/><path d="M3 20.5h18"/><path d="M8 7.5h3M8 11h3M8 14.5h3"/>',
  admin: '<path d="M12 3.5 19 6v5.5c0 4.3-3 7.6-7 9-4-1.4-7-4.7-7-9V6l7-2.5Z"/><path d="m9 12 2.2 2.2L15.5 10"/>',
  logout: '<path d="M14 4.5H6.5A1.5 1.5 0 0 0 5 6v12a1.5 1.5 0 0 0 1.5 1.5H14"/><path d="M10 12h10M16.5 8.5 20 12l-3.5 3.5"/>',
  account: '<circle cx="12" cy="12" r="8.5"/><circle cx="12" cy="10" r="3"/><path d="M6.5 18.2c1.2-2 3.2-3 5.5-3s4.3 1 5.5 3"/>',
  switch: '<path d="m8 9 4-4 4 4M8 15l4 4 4-4"/>',
} as const;

export type IconName = keyof typeof paths;

export function icon(name: IconName | undefined, cls = 'icon'): SafeHtml {
  if (!name || !(name in paths)) return raw('');
  return raw(
    `<svg class="${cls}" viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false">${paths[name]}</svg>`,
  );
}
