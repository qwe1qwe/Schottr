import { AsyncLocalStorage } from 'node:async_hooks';
import mysql, { type Pool, type PoolConnection, type ResultSetHeader, type RowDataPacket } from 'mysql2/promise';
import { migrations } from './migrations.ts';

export type Row = Record<string, any>;
type Param = string | number | boolean | null | Buffer | Uint8Array | Date;

let pool: Pool | null = null;
const txStore = new AsyncLocalStorage<PoolConnection>();

/** Verbindung zur MariaDB herstellen (mit Wiederholung, falls die DB gerade erst startet) und migrieren. */
export async function openDatabase(url: string, opts: { retries?: number } = {}): Promise<Pool> {
  pool = mysql.createPool({
    uri: url,
    connectionLimit: 10,
    charset: 'utf8mb4_unicode_ci',
    timezone: 'Z',
    dateStrings: true, // DATE/DATETIME als Text – keine Zeitzonen-Überraschungen
    supportBigNumbers: true,
    decimalNumbers: true,
  });
  const retries = opts.retries ?? 30;
  for (let attempt = 1; ; attempt++) {
    try {
      await pool.query('SELECT 1');
      break;
    } catch (err) {
      if (attempt >= retries) throw err;
      console.log(`Warte auf Datenbank … (${attempt}/${retries}) ${(err as Error).message}`);
      await new Promise((r) => setTimeout(r, 2000));
    }
  }
  await migrate(pool);
  return pool;
}

export async function closeDatabase() {
  await pool?.end();
  pool = null;
}

function db(): Pool | PoolConnection {
  const conn = txStore.getStore();
  if (conn) return conn;
  if (!pool) throw new Error('Datenbank nicht geöffnet');
  return pool;
}

async function migrate(p: Pool) {
  await p.query(`CREATE TABLE IF NOT EXISTS schema_migrations (
    version INT PRIMARY KEY, applied_at DATETIME(3) NOT NULL
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`);
  const [rows] = await p.query<RowDataPacket[]>('SELECT version FROM schema_migrations');
  const applied = new Set(rows.map((r) => Number(r.version)));
  for (const m of migrations) {
    if (applied.has(m.version)) continue;
    // DDL committet in MariaDB implizit – daher Anweisung für Anweisung
    for (const statement of m.statements) await p.query(statement);
    await p.query('INSERT INTO schema_migrations (version, applied_at) VALUES (?, ?)', [m.version, nowIso()]);
    console.log(`Migration ${m.version} angewendet`);
  }
}

/* Kleine Helfer, damit die Repositories lesbar bleiben. */

export async function one<T = Row>(sql: string, ...params: Param[]): Promise<T | undefined> {
  const [rows] = await db().query<RowDataPacket[]>(sql, params);
  return rows[0] as T | undefined;
}

export async function all<T = Row>(sql: string, ...params: Param[]): Promise<T[]> {
  const [rows] = await db().query<RowDataPacket[]>(sql, params);
  return rows as T[];
}

export async function run(sql: string, ...params: Param[]): Promise<{ insertId: number; affectedRows: number }> {
  const [res] = await db().query<ResultSetHeader>(sql, params);
  return { insertId: Number(res.insertId), affectedRows: res.affectedRows };
}

/**
 * Führt fn in einer Transaktion aus. Alle one/all/run-Aufrufe innerhalb (auch in
 * aufgerufenen Funktionen) laufen automatisch über dieselbe Verbindung.
 * Verschachtelte Aufrufe laufen in der äußeren Transaktion mit.
 */
export async function tx<T>(fn: () => Promise<T>): Promise<T> {
  if (txStore.getStore()) return fn();
  if (!pool) throw new Error('Datenbank nicht geöffnet');
  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();
    const result = await txStore.run(conn, fn);
    await conn.commit();
    return result;
  } catch (err) {
    await conn.rollback().catch(() => {});
    throw err;
  } finally {
    conn.release();
  }
}

/** Zeitstempel in UTC im DATETIME-Format: "2026-10-27 08:34:12.123" */
export function toDbTime(date: Date): string {
  return date.toISOString().replace('T', ' ').replace('Z', '');
}

export const nowIso = () => toDbTime(new Date());

/** DATETIME aus der DB (UTC) als Date */
export function fromDbTime(value: string): Date {
  return new Date(`${value.replace(' ', 'T')}Z`);
}
