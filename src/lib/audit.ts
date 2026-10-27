import { all, one, run, nowIso } from '../db/index.ts';
import { clientIp } from './http.ts';
import type { Ctx } from '../types.ts';

/**
 * Protokoll wichtiger Vorgänge (Anmeldungen, Festschreiben, Administration).
 * Ohne Fremdschlüssel, damit Einträge auch nach dem Löschen von Benutzern erhalten bleiben.
 */
export async function audit(
  c: Ctx | null,
  action: string,
  details = '',
  opts: { tenantId?: number | null; userId?: number | null; email?: string } = {},
): Promise<void> {
  try {
    const user = c?.get('user');
    await run(
      'INSERT INTO audit_log (created_at, user_id, user_email, tenant_id, action, details, ip) VALUES (?, ?, ?, ?, ?, ?, ?)',
      nowIso(),
      opts.userId !== undefined ? opts.userId : (user?.id ?? null),
      (opts.email ?? user?.email ?? '').slice(0, 200),
      opts.tenantId !== undefined ? opts.tenantId : (c?.get('tenant')?.id ?? null),
      action.slice(0, 64),
      details.slice(0, 1000),
      c ? clientIp(c).slice(0, 64) : '',
    );
  } catch (err) {
    // Protokollierung darf nie den eigentlichen Vorgang verhindern
    console.error('Audit-Protokoll fehlgeschlagen:', err);
  }
}

/* ---------- Systemweite Einstellungen (Administration) ---------- */

const cache = new Map<string, string | null>();

export async function getSetting(key: string): Promise<string | null> {
  if (cache.has(key)) return cache.get(key)!;
  const row = await one<{ value: string }>('SELECT `value` FROM app_settings WHERE `key` = ?', key);
  cache.set(key, row?.value ?? null);
  return row?.value ?? null;
}

export async function setSetting(key: string, value: string): Promise<void> {
  await run(
    'INSERT INTO app_settings (`key`, `value`, updated_at) VALUES (?, ?, ?) ON DUPLICATE KEY UPDATE `value` = VALUES(`value`), updated_at = VALUES(updated_at)',
    key, value, nowIso(),
  );
  cache.set(key, value);
}

export function clearSettingsCache() {
  cache.clear();
}

export async function recentAudit(filter: { tenantId?: number; action?: string; limit?: number } = {}) {
  const where: string[] = [];
  const params: (string | number)[] = [];
  if (filter.tenantId) {
    where.push('a.tenant_id = ?');
    params.push(filter.tenantId);
  }
  if (filter.action) {
    where.push('a.action LIKE ?');
    params.push(`${filter.action}%`);
  }
  return all(
    `SELECT a.*, t.name AS tenant_name FROM audit_log a LEFT JOIN tenants t ON t.id = a.tenant_id
     ${where.length ? `WHERE ${where.join(' AND ')}` : ''} ORDER BY a.id DESC LIMIT ${Math.min(filter.limit ?? 200, 1000)}`,
    ...params,
  );
}
