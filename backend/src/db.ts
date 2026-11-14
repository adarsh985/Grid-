import fs from 'fs';
import path from 'path';
import { Pool } from 'pg';

/** Minimal query interface so tests can inject an in-memory Postgres (pg-mem). */
export interface Db {
  query(text: string, params?: unknown[]): Promise<{ rows: any[]; rowCount: number | null }>;
}

export function createPool(connectionString: string): Pool {
  return new Pool({ connectionString });
}

export async function migrate(db: Db): Promise<void> {
  const sql = fs.readFileSync(path.join(__dirname, 'schema.sql'), 'utf8');
  // Statement-by-statement so it works on every pg driver/adapter.
  for (const stmt of sql.split(';').map((s) => s.trim()).filter(Boolean)) {
    await db.query(stmt);
  }
}
