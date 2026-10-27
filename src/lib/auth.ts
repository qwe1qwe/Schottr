import crypto from 'node:crypto';
import { promisify } from 'node:util';
import { one, run, nowIso, toDbTime, fromDbTime } from '../db/index.ts';
import { config } from '../config.ts';

const scrypt = promisify(crypto.scrypt) as (
  password: string,
  salt: Buffer,
  keylen: number,
  options: crypto.ScryptOptions,
) => Promise<Buffer>;

// OWASP-Empfehlung für scrypt: N=2^17, r=8, p=1
const SCRYPT = { N: 2 ** 17, r: 8, p: 1, maxmem: 256 * 1024 * 1024 };

export async function hashPassword(password: string): Promise<string> {
  const salt = crypto.randomBytes(16);
  const key = await scrypt(password.normalize('NFKC'), salt, 32, SCRYPT);
  return `scrypt$${SCRYPT.N}$${SCRYPT.r}$${SCRYPT.p}$${salt.toString('base64')}$${key.toString('base64')}`;
}

export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const [algo, n, r, p, salt, hash] = stored.split('$');
  if (algo !== 'scrypt') return false;
  const expected = Buffer.from(hash, 'base64');
  const key = await scrypt(password.normalize('NFKC'), Buffer.from(salt, 'base64'), expected.length, {
    N: Number(n), r: Number(r), p: Number(p), maxmem: SCRYPT.maxmem,
  });
  return crypto.timingSafeEqual(key, expected);
}

/** Zum Zeitausgleich bei unbekannter E-Mail, damit Logins keine Konten verraten. */
let dummyHash: string | null = null;
export async function dummyVerify(password: string) {
  dummyHash ??= await hashPassword('dummy-password');
  await verifyPassword(password, dummyHash);
}

const sha256 = (v: string) => crypto.createHash('sha256').update(v).digest('hex');

export interface Session {
  id: string;
  userId: number;
  tenantId: number | null;
  csrf: string;
}

export async function createSession(userId: number, tenantId: number | null): Promise<{ token: string; session: Session }> {
  const token = crypto.randomBytes(32).toString('base64url');
  const csrf = crypto.randomBytes(24).toString('base64url');
  const id = sha256(token);
  const expires = toDbTime(new Date(Date.now() + config.sessionDays * 86_400_000));
  await run(
    'INSERT INTO sessions (id, user_id, tenant_id, csrf, expires_at, created_at) VALUES (?, ?, ?, ?, ?, ?)',
    id, userId, tenantId, csrf, expires, nowIso(),
  );
  return { token, session: { id, userId, tenantId, csrf } };
}

export async function loadSession(token: string | undefined): Promise<Session | null> {
  if (!token || token.length > 100) return null;
  const id = sha256(token);
  const row = await one('SELECT * FROM sessions WHERE id = ?', id);
  if (!row) return null;
  const expires = fromDbTime(row.expires_at).getTime();
  if (expires < Date.now()) {
    await run('DELETE FROM sessions WHERE id = ?', id);
    return null;
  }
  // gleitende Gültigkeit – höchstens einmal pro Stunde aktualisieren
  const newExpiry = Date.now() + config.sessionDays * 86_400_000;
  if (expires < newExpiry - 3_600_000) {
    await run('UPDATE sessions SET expires_at = ? WHERE id = ?', toDbTime(new Date(newExpiry)), id);
  }
  return { id, userId: row.user_id, tenantId: row.tenant_id, csrf: row.csrf };
}

export async function destroySession(id: string) {
  await run('DELETE FROM sessions WHERE id = ?', id);
}

export async function setSessionTenant(id: string, tenantId: number) {
  await run('UPDATE sessions SET tenant_id = ? WHERE id = ?', tenantId, id);
}

export async function purgeExpiredSessions() {
  await run('DELETE FROM sessions WHERE expires_at < ?', nowIso());
}

export function safeEqual(a: string, b: string): boolean {
  const ba = Buffer.from(a);
  const bb = Buffer.from(b);
  return ba.length === bb.length && crypto.timingSafeEqual(ba, bb);
}

/** Einfache Bremse gegen Passwort-Raten (im Speicher, pro IP + E-Mail). */
const attempts = new Map<string, { count: number; until: number }>();
export function loginThrottled(key: string): boolean {
  const entry = attempts.get(key);
  return !!entry && entry.count >= 8 && entry.until > Date.now();
}
export function recordLoginFailure(key: string) {
  const entry = attempts.get(key);
  if (!entry || entry.until < Date.now()) attempts.set(key, { count: 1, until: Date.now() + 15 * 60_000 });
  else entry.count++;
  if (attempts.size > 10_000) attempts.clear();
}
export function clearLoginFailures(key: string) {
  attempts.delete(key);
}
