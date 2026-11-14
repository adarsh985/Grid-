import bcrypt from 'bcryptjs';
import { newDb } from 'pg-mem';
import { createApp } from '../src/app';
import { Db, migrate } from '../src/db';
import { MlClient, ScoreResult } from '../src/mlClient';

export const API_KEY = 'test-key';
export const SECRET = 'test-secret';

export class FakeMl implements MlClient {
  /** Override per test: decides anomaly output for each reading. */
  rule: (r: any) => Partial<ScoreResult> | null = () => null;
  fail = false;
  calls = 0;
  async score(readings: any[]): Promise<ScoreResult[]> {
    this.calls++;
    if (this.fail) throw new Error('ml down');
    return readings.map((r) => {
      const o = this.rule(r);
      return {
        timestamp: r.timestamp,
        meter_id: r.meter_id,
        is_anomaly: !!o,
        anomaly_score: 0.9,
        predicted_type: o ? 'power_theft' : 'normal',
        severity: 'critical',
        explanations: [
          { feature: 'current_mean_rel_dev_60m', deviation_pct: -45, z_score: 3, description: 'Three-phase average load is 45% below its 60-minute baseline' },
        ],
        ...(o ?? {}),
      };
    });
  }
  async modelInfo() {
    return { version: 'vtest' };
  }
}

export async function setup() {
  const mem = newDb();
  const { Pool } = mem.adapters.createPg();
  const db = new Pool() as unknown as Db;
  await migrate(db);
  for (const [email, role] of [['admin@t.io', 'admin'], ['op@t.io', 'operator'], ['view@t.io', 'viewer']]) {
    await db.query('INSERT INTO users (email, password_hash, role) VALUES ($1,$2,$3)', [email, await bcrypt.hash('password123', 4), role]);
  }
  const ml = new FakeMl();
  const events: { event: string; payload: any }[] = [];
  const app = createApp({
    db,
    ml,
    emitter: { emit: (event, payload) => events.push({ event, payload }) },
    jwtSecret: SECRET,
    ingestApiKey: API_KEY,
  });
  return { app, db, ml, events };
}

export const reading = (meter: string, ts: string, over: Record<string, unknown> = {}) => ({
  timestamp: ts,
  meter_id: meter,
  voltage_a: 230, voltage_b: 230, voltage_c: 230,
  current_a: 10, current_b: 10, current_c: 10,
  power_factor: 0.95, frequency: 50, active_energy_kwh: 100,
  ...over,
});
