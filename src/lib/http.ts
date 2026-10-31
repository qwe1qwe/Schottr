import { AsyncLocalStorage } from 'node:async_hooks';
import { getCookie, setCookie, deleteCookie } from 'hono/cookie';
import { HTTPException } from 'hono/http-exception';
import { config } from '../config.ts';
import type { Ctx, Tenant, User } from '../types.ts';

export type Form = Record<string, string | string[]>;

export async function readForm(c: Ctx): Promise<Form> {
  const body = await c.req.parseBody({ all: true });
  const out: Form = {};
  for (const [key, value] of Object.entries(body)) {
    const k = key.endsWith('[]') ? key.slice(0, -2) : key;
    if (Array.isArray(value)) out[k] = value.map((v) => (typeof v === 'string' ? v : ''));
    else out[k] = typeof value === 'string' ? value : '';
  }
  return out;
}

export function str(form: Form, key: string, max = 2000): string {
  const v = form[key];
  const s = Array.isArray(v) ? (v[0] ?? '') : (v ?? '');
  return s.replace(/\r\n/g, '\n').trim().slice(0, max);
}

export function list(form: Form, key: string): string[] {
  const v = form[key];
  if (v === undefined) return [];
  return Array.isArray(v) ? v : [v];
}

export function isSecure(c: Ctx): boolean {
  if (config.secureCookies === 'true') return true;
  if (config.secureCookies === 'false') return false;
  return c.req.header('x-forwarded-proto') === 'https' || c.req.url.startsWith('https:');
}

export function clientIp(c: Ctx): string {
  if (config.trustProxy) {
    const fwd = c.req.header('x-forwarded-for');
    if (fwd) return fwd.split(',')[0].trim();
  }
  return c.req.header('x-real-ip') ?? 'local';
}

export const SESSION_COOKIE = 'schottr_sid';
const FLASH_COOKIE = 'schottr_flash';

export function setSessionCookie(c: Ctx, token: string) {
  setCookie(c, SESSION_COOKIE, token, {
    httpOnly: true,
    sameSite: 'Lax',
    secure: isSecure(c),
    path: '/',
    maxAge: config.sessionDays * 86400,
  });
}

export function clearSessionCookie(c: Ctx) {
  deleteCookie(c, SESSION_COOKIE, { path: '/' });
}

export type FlashType = 'ok' | 'error';
export function flash(c: Ctx, type: FlashType, message: string) {
  setCookie(c, FLASH_COOKIE, encodeURIComponent(JSON.stringify({ type, message })), {
    httpOnly: true, sameSite: 'Lax', secure: isSecure(c), path: '/', maxAge: 60,
  });
}

export function takeFlash(c: Ctx): { type: FlashType; message: string } | null {
  const v = getCookie(c, FLASH_COOKIE);
  if (!v) return null;
  deleteCookie(c, FLASH_COOKIE, { path: '/' });
  try {
    return JSON.parse(decodeURIComponent(v));
  } catch {
    return null;
  }
}

/**
 * Hinweise aus tieferen Schichten (z. B. „Kassenzählung neu berechnet“), die an die nächste
 * Erfolgsmeldung der Anfrage angehängt werden.
 */
const notesStore = new AsyncLocalStorage<string[]>();
export const withNotes = <T>(fn: () => Promise<T>) => notesStore.run([], fn);
export function addNote(message: string) {
  notesStore.getStore()?.push(message);
}

export function redirectWith(c: Ctx, to: string, type: FlashType, message: string) {
  const notes = type === 'ok' ? notesStore.getStore() ?? [] : [];
  if (notes.length) message = [message, ...notes].join(' ');
  flash(c, type, message);
  return c.redirect(to, 303);
}

/** Fachlicher Fehler, der dem Benutzer angezeigt wird. */
export class UserError extends Error {}

export function notFound(): never {
  throw new HTTPException(404, { message: 'Nicht gefunden' });
}

export function tenantOf(c: Ctx): Tenant {
  const t = c.get('tenant');
  if (!t) throw new HTTPException(403, { message: 'Kein Mandant ausgewählt' });
  return t;
}

export function userOf(c: Ctx): User {
  const u = c.get('user');
  if (!u) throw new HTTPException(401, { message: 'Nicht angemeldet' });
  return u;
}

export function requireOwner(c: Ctx) {
  if (c.get('role') !== 'owner') throw new HTTPException(403, { message: 'Nur für Inhaber des Mandanten' });
}

export function idParam(c: Ctx, name = 'id'): number {
  const id = Number(c.req.param(name));
  if (!Number.isInteger(id) || id <= 0) notFound();
  return id;
}

/** Dateiname für Content-Disposition (ASCII + RFC 5987). */
export function attachment(filename: string, inline = false): string {
  const ascii = filename.replace(/[^\w.\-]+/g, '_');
  return `${inline ? 'inline' : 'attachment'}; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(filename)}`;
}
