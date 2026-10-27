/** Minimaler, synchroner HTML-Template-Helfer mit automatischem Escaping. */

export class SafeHtml {
  readonly value: string;
  constructor(value: string) {
    this.value = value;
  }
  toString() {
    return this.value;
  }
}

export function escapeHtml(value: unknown): string {
  return String(value ?? '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

function render(value: unknown): string {
  if (value === null || value === undefined || value === false) return '';
  if (value instanceof SafeHtml) return value.value;
  if (Array.isArray(value)) return value.map(render).join('');
  return escapeHtml(value);
}

export function html(strings: TemplateStringsArray, ...values: unknown[]): SafeHtml {
  let out = strings[0];
  for (let i = 0; i < values.length; i++) out += render(values[i]) + strings[i + 1];
  return new SafeHtml(out);
}

export function raw(value: string): SafeHtml {
  return new SafeHtml(value);
}

/** Mehrzeiligen Text mit Zeilenumbrüchen ausgeben. */
export function nl2br(value: string): SafeHtml {
  return raw(escapeHtml(value).replaceAll('\n', '<br>'));
}

export const selected = (a: unknown, b: unknown) => (String(a) === String(b) ? raw(' selected') : '');
export const checked = (v: unknown) => (v ? raw(' checked') : '');
