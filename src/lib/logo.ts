import { one } from '../db/index.ts';

/** Firmenlogo des Mandanten (PNG/JPEG) oder null */
export async function getLogo(tenantId: number): Promise<{ data: Buffer; mime: string } | null> {
  const row = await one<{ data: Buffer; mime: string }>('SELECT data, mime FROM tenant_logos WHERE tenant_id = ?', tenantId);
  return row ? { data: Buffer.from(row.data), mime: row.mime } : null;
}
