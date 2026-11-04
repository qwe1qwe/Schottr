import crypto from 'node:crypto';
import { html, type SafeHtml } from './html.ts';

/**
 * Sicherheitscode für folgenschwere Aktionen (Rechnung nachträglich bearbeiten, Kassenzählung
 * löschen): 6 Zeichen, die abgetippt werden müssen – nicht markier- oder einfügbar. Gültig
 * 10 Minuten je Sitzung und Vorgang, nach drei Fehlversuchen gibt es einen neuen.
 */
const ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // ohne 0/O, 1/I – gut abschreibbar
const codes = new Map<string, { code: string; exp: number; tries: number }>();

export function issueCode(key: string): string {
  const code = Array.from({ length: 6 }, () => ALPHABET[crypto.randomInt(ALPHABET.length)]).join('');
  codes.set(key, { code, exp: Date.now() + 10 * 60_000, tries: 0 });
  if (codes.size > 5000) for (const [k, v] of codes) if (v.exp < Date.now()) codes.delete(k);
  return code;
}

export type CodeCheck = { ok: true } | { ok: false; code: string; error: string };

/** Eingabe prüfen; bei Erfolg ist der Code verbraucht, sonst kommt der (ggf. neue) Code zum Anzeigen zurück */
export function checkCode(key: string, typedRaw: string): CodeCheck {
  const typed = typedRaw.toUpperCase().replace(/\s+/g, '');
  const entry = codes.get(key);
  if (!entry || entry.exp < Date.now()) return { ok: false, code: issueCode(key), error: 'Der Code ist abgelaufen. Bitte den neuen Code abschreiben.' };
  if (typed !== entry.code) {
    entry.tries++;
    if (entry.tries >= 3) return { ok: false, code: issueCode(key), error: 'Code dreimal falsch – hier ist ein neuer Code.' };
    return { ok: false, code: entry.code, error: 'Der Code stimmt nicht.' };
  }
  codes.delete(key);
  return { ok: true };
}

/** Aktuellen Code anzeigen, ohne ihn zu verbrauchen (z. B. wenn ein anderes Feld fehlt) */
export const currentCode = (key: string) => codes.get(key)?.code ?? issueCode(key);

/** Code zum Abschreiben – Zeichen nur per CSS-Pseudoelement, dadurch nicht markier- oder kopierbar */
export function codeBox(code: string): SafeHtml {
  return html`<div class="confirm-code" aria-hidden="true">${[...code].map((ch) => html`<span data-c="${ch}"></span>`)}</div>`;
}

/** Eingabefeld für den Code (Einfügen gesperrt) */
export const codeInput = () =>
  html`<label>Code <input name="code" required maxlength="6" class="code-input" data-no-paste autocomplete="off" spellcheck="false" autocapitalize="characters"></label>`;
