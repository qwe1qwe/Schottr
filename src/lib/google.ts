import crypto from 'node:crypto';
import { config } from '../config.ts';
import { one } from '../db/index.ts';
import { html } from './html.ts';
import type { Ctx } from '../types.ts';

/**
 * Anmeldung mit Google (OpenID Connect, Authorization Code Flow mit PKCE).
 * Ohne zusätzliche Abhängigkeit: Das ID-Token kommt direkt per TLS vom Token-Endpunkt
 * von Google und muss deshalb nicht zusätzlich per JWKS-Signatur geprüft werden
 * (OpenID Connect Core 1.0, Abschnitt 3.1.3.7). Aussteller, Empfänger, Ablauf und Nonce
 * werden trotzdem geprüft.
 */
const AUTH_ENDPOINT = 'https://accounts.google.com/o/oauth2/v2/auth';
const TOKEN_ENDPOINT = 'https://oauth2.googleapis.com/token';
const ISSUERS = ['https://accounts.google.com', 'accounts.google.com'];

export const googleEnabled = () => !!(config.googleClientId && config.googleClientSecret);

const b64url = (buf: Buffer) => buf.toString('base64url');
export const randomToken = (bytes = 32) => b64url(crypto.randomBytes(bytes));
export const pkceChallenge = (verifier: string) => b64url(crypto.createHash('sha256').update(verifier).digest());

/** Rücksprung-URL – muss exakt so in der Google Cloud Console eingetragen sein. */
export function redirectUri(c: Ctx): string {
  if (config.publicUrl) return `${config.publicUrl}/auth/google/callback`;
  const url = new URL(c.req.url);
  const proto = config.trustProxy ? (c.req.header('x-forwarded-proto')?.split(',')[0].trim() || url.protocol.slice(0, -1)) : url.protocol.slice(0, -1);
  const host = (config.trustProxy ? c.req.header('x-forwarded-host') : undefined) ?? c.req.header('host') ?? url.host;
  return `${proto}://${host}/auth/google/callback`;
}

export function authorizationUrl(p: { state: string; nonce: string; verifier: string; redirectUri: string; loginHint?: string }): string {
  const q = new URLSearchParams({
    client_id: config.googleClientId,
    redirect_uri: p.redirectUri,
    response_type: 'code',
    scope: 'openid email profile',
    state: p.state,
    nonce: p.nonce,
    code_challenge: pkceChallenge(p.verifier),
    code_challenge_method: 'S256',
    prompt: 'select_account',
  });
  if (p.loginHint) q.set('login_hint', p.loginHint);
  return `${AUTH_ENDPOINT}?${q}`;
}

export interface GoogleProfile {
  sub: string;
  email: string;
  emailVerified: boolean;
  name: string;
}

export class GoogleAuthError extends Error {}

/** Prüft die Angaben im ID-Token (ohne Signatur, siehe oben). */
export function checkIdToken(idToken: string, nonce: string, now = Date.now()): GoogleProfile {
  const part = idToken.split('.')[1];
  if (!part) throw new GoogleAuthError('Ungültiges ID-Token');
  let claims: Record<string, unknown>;
  try {
    claims = JSON.parse(Buffer.from(part, 'base64url').toString('utf8'));
  } catch {
    throw new GoogleAuthError('Ungültiges ID-Token');
  }
  if (!ISSUERS.includes(String(claims.iss))) throw new GoogleAuthError('Falscher Aussteller');
  const aud = Array.isArray(claims.aud) ? claims.aud : [claims.aud];
  if (!aud.includes(config.googleClientId)) throw new GoogleAuthError('Token gilt nicht für diese Anwendung');
  if (typeof claims.exp !== 'number' || claims.exp * 1000 < now - 60_000) throw new GoogleAuthError('Token abgelaufen');
  if (typeof claims.nonce !== 'string' || !safeEq(claims.nonce, nonce)) throw new GoogleAuthError('Nonce stimmt nicht');
  if (typeof claims.sub !== 'string' || !claims.sub) throw new GoogleAuthError('Kein Benutzerkennzeichen');
  return {
    sub: claims.sub,
    email: String(claims.email ?? '').toLowerCase().slice(0, 200),
    emailVerified: claims.email_verified === true || claims.email_verified === 'true',
    name: String(claims.name ?? '').slice(0, 200),
  };
}

export async function exchangeCode(code: string, verifier: string, redirect: string, nonce: string): Promise<GoogleProfile> {
  const res = await fetch(TOKEN_ENDPOINT, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' },
    body: new URLSearchParams({
      code,
      client_id: config.googleClientId,
      client_secret: config.googleClientSecret,
      redirect_uri: redirect,
      grant_type: 'authorization_code',
      code_verifier: verifier,
    }),
    signal: AbortSignal.timeout(15_000),
  });
  const data = (await res.json().catch(() => ({}))) as { id_token?: string; error?: string; error_description?: string };
  if (!res.ok || !data.id_token) {
    throw new GoogleAuthError(`Google hat die Anmeldung abgelehnt (${data.error ?? res.status}${data.error_description ? `: ${data.error_description}` : ''})`);
  }
  return checkIdToken(data.id_token, nonce);
}

function safeEq(a: string, b: string) {
  const ba = Buffer.from(a);
  const bb = Buffer.from(b);
  return ba.length === bb.length && crypto.timingSafeEqual(ba, bb);
}

/** Signierte Kurzzeit-Daten im Cookie (Schlüssel aus dem Client-Secret abgeleitet). */
const signKey = () => crypto.createHmac('sha256', 'schottr-google-cookie').update(config.googleClientSecret).digest();
export function seal(data: object, ttlMs: number): string {
  const body = b64url(Buffer.from(JSON.stringify({ ...data, exp: Date.now() + ttlMs })));
  const mac = b64url(crypto.createHmac('sha256', signKey()).update(body).digest());
  return `${body}.${mac}`;
}
export function unseal<T>(value: string | undefined): T | null {
  if (!value) return null;
  const [body, mac] = value.split('.');
  if (!body || !mac) return null;
  const expected = b64url(crypto.createHmac('sha256', signKey()).update(body).digest());
  if (!safeEq(mac, expected)) return null;
  try {
    const data = JSON.parse(Buffer.from(body, 'base64url').toString('utf8'));
    return typeof data.exp === 'number' && data.exp > Date.now() ? (data as T) : null;
  } catch {
    return null;
  }
}

/** Hat das Konto ein Passwort? (Konten, die über Google angelegt wurden, zunächst nicht.) */
export const hasPassword = (hash: string | null | undefined) => !!hash && hash.startsWith('scrypt$');

/** Abschnitt „Google-Anmeldung“ für die Seite „Mein Konto“. */
export async function googleAccountSection(c: Ctx, userId: number, csrf: ReturnType<typeof html>) {
  if (!googleEnabled()) return '';
  const identity = await one<{ email: string }>('SELECT email FROM user_identities WHERE user_id = ? AND provider = ?', userId, 'google');
  return html`
  <section class="card narrow">
    <h2>Anmeldung mit Google</h2>
    ${identity
      ? html`<p>Verknüpft mit <strong>${identity.email || 'Google-Konto'}</strong>.</p>
        <form method="post" action="/account/google/unlink" class="stack">${csrf}
          <button class="btn danger">Verknüpfung lösen</button>
        </form>`
      : html`<p class="muted">Melde dich künftig mit deinem Google-Konto an – zusätzlich zum Passwort.</p>
        <a class="btn google" href="/auth/google?link=1">${googleIcon()} Mit Google verknüpfen</a>`}
  </section>`;
}

export const googleIcon = () => html`<svg class="google-g" viewBox="0 0 48 48" width="18" height="18" aria-hidden="true"><path fill="#FFC107" d="M43.6 20.5H42V20H24v8h11.3C33.7 32.7 29.2 36 24 36c-6.6 0-12-5.4-12-12s5.4-12 12-12c3.1 0 5.8 1.2 7.9 3.1l5.7-5.7C34 6.1 29.3 4 24 4 12.9 4 4 12.9 4 24s8.9 20 20 20 20-8.9 20-20c0-1.3-.1-2.4-.4-3.5z"/><path fill="#FF3D00" d="m6.3 14.7 6.6 4.8C14.7 15.1 19 12 24 12c3.1 0 5.8 1.2 7.9 3.1l5.7-5.7C34 6.1 29.3 4 24 4 16.3 4 9.7 8.3 6.3 14.7z"/><path fill="#4CAF50" d="M24 44c5.2 0 9.9-2 13.4-5.2l-6.2-5.2C29.2 35.1 26.7 36 24 36c-5.2 0-9.6-3.3-11.3-7.9l-6.5 5C9.5 39.6 16.2 44 24 44z"/><path fill="#1976D2" d="M43.6 20.5H42V20H24v8h11.3c-.8 2.2-2.2 4.2-4.1 5.6l6.2 5.2C37 39.2 44 34 44 24c0-1.3-.1-2.4-.4-3.5z"/></svg>`;
