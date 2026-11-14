import { z } from 'zod';
import { Db } from './db';
import { MlClient, ScoreResult } from './mlClient';

export const readingSchema = z.object({
  timestamp: z.string().datetime({ offset: true }),
  meter_id: z.string().min(1).max(64),
  voltage_a: z.number().min(0).max(1000),
  voltage_b: z.number().min(0).max(1000),
  voltage_c: z.number().min(0).max(1000),
  current_a: z.number().min(0).max(5000),
  current_b: z.number().min(0).max(5000),
  current_c: z.number().min(0).max(5000),
  power_factor: z.number().min(0).max(1),
  frequency: z.number().min(40).max(70),
  active_energy_kwh: z.number().min(0),
  fault_label: z.string().max(64).optional().nullable(), // simulator ground truth; stored for evaluation only
});
export const batchSchema = z.object({ readings: z.array(readingSchema).min(1).max(2000) });
export type ReadingIn = z.infer<typeof readingSchema>;

export interface Emitter {
  emit(event: string, payload: unknown): void;
}

export const DEDUP_WINDOW_MS = 5 * 60 * 1000;
// A detection with no prior history is credited with one nominal minute of loss.
const INITIAL_LOSS_HOURS = 1 / 60;
// Cap the integration step so a long reporting gap isn't billed as continuous theft.
const MAX_LOSS_STEP_HOURS = 15 / 60;

export interface IngestResult {
  received: number;
  inserted: number;
  duplicates: number;
  alerts_created: number;
  alerts_updated: number;
  ml_available: boolean;
}

export async function ingestReadings(
  db: Db,
  ml: MlClient,
  emitter: Emitter,
  input: ReadingIn[],
): Promise<IngestResult> {
  // Out-of-order handling: process chronologically regardless of arrival order.
  const readings = [...input].sort((a, b) => Date.parse(a.timestamp) - Date.parse(b.timestamp));
  const inserted: ReadingIn[] = [];

  for (const id of new Set(readings.map((r) => r.meter_id))) {
    await db.query('INSERT INTO meters (id, name) VALUES ($1, $2) ON CONFLICT (id) DO NOTHING', [id, id]);
  }

  for (const r of readings) {
    // Explicit existence check (clear semantics + portable); ON CONFLICT below still
    // guards the race where two concurrent batches carry the same reading.
    const dup = await db.query('SELECT id FROM readings WHERE meter_id = $1 AND ts = $2', [r.meter_id, r.timestamp]);
    if (dup.rows.length) continue;
    const res = await db.query(
      `INSERT INTO readings (meter_id, ts, voltage_a, voltage_b, voltage_c, current_a, current_b, current_c,
         power_factor, frequency, active_energy_kwh, fault_label)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)
       ON CONFLICT (meter_id, ts) DO NOTHING RETURNING id`,
      [r.meter_id, r.timestamp, r.voltage_a, r.voltage_b, r.voltage_c, r.current_a, r.current_b, r.current_c,
       r.power_factor, r.frequency, r.active_energy_kwh, r.fault_label ?? null],
    );
    if (res.rows.length === 0) continue; // duplicate delivery -> ignored
    inserted.push(r);
    // last_seen only moves forward so late arrivals don't rewind it.
    await db.query('UPDATE meters SET last_seen = $2 WHERE id = $1 AND (last_seen IS NULL OR last_seen < $2)', [
      r.meter_id,
      r.timestamp,
    ]);
    emitter.emit('reading', r);
  }

  const result: IngestResult = {
    received: input.length,
    inserted: inserted.length,
    duplicates: input.length - inserted.length,
    alerts_created: 0,
    alerts_updated: 0,
    ml_available: true,
  };
  if (inserted.length === 0) return result;

  let scored: ScoreResult[] = [];
  try {
    scored = await ml.score(inserted);
  } catch (err) {
    // Telemetry must never be lost because scoring is down.
    console.warn('[ingest] ML scoring failed:', (err as Error).message);
    result.ml_available = false;
    return result;
  }

  const byKey = new Map(inserted.map((r) => [`${r.meter_id}|${r.timestamp}`, r]));
  for (const s of scored) {
    if (!s.is_anomaly) continue;
    const reading = byKey.get(`${s.meter_id}|${s.timestamp}`);
    if (!reading) continue;
    const outcome = await upsertAlert(db, emitter, s, reading);
    if (outcome === 'created') result.alerts_created++;
    else result.alerts_updated++;
  }
  return result;
}

/** Estimated stolen power (kW): what the meter should have seen minus what it saw. */
export function estimateLossKw(s: ScoreResult, r: ReadingIn): number {
  if (s.predicted_type !== 'power_theft') return 0;
  const actualKw = ((r.voltage_a * r.current_a + r.voltage_b * r.current_b + r.voltage_c * r.current_c) * r.power_factor) / 1000;
  const drop =
    s.explanations.find((e) => e.feature === 'load_vs_profile') ??
    s.explanations.find((e) => e.feature === 'current_mean_rel_dev_60m');
  // deviation_pct is signed (negative for a drop); fall back to the 30% rule threshold.
  const frac = drop ? Math.min(Math.max(Math.abs(drop.deviation_pct) / 100, 0.05), 0.9) : 0.3;
  return actualKw * (frac / (1 - frac));
}

async function upsertAlert(db: Db, emitter: Emitter, s: ScoreResult, r: ReadingIn): Promise<'created' | 'updated'> {
  const ts = Date.parse(r.timestamp);
  const lossKw = estimateLossKw(s, r);

  const existing = await db.query(
    `SELECT id, last_detected_at, score, loss_kw FROM alerts
     WHERE meter_id = $1 AND type = $2 AND status <> 'closed'
       AND last_detected_at >= $3 AND last_detected_at <= $4
     ORDER BY last_detected_at DESC LIMIT 1`,
    [s.meter_id, s.predicted_type, new Date(ts - DEDUP_WINDOW_MS).toISOString(), new Date(ts + DEDUP_WINDOW_MS).toISOString()],
  );

  if (existing.rows.length) {
    const row = existing.rows[0];
    const prev = new Date(row.last_detected_at).getTime();
    const stepH = Math.min(Math.max(ts - prev, 0) / 3_600_000, MAX_LOSS_STEP_HOURS);
    await db.query(
      `UPDATE alerts SET last_detected_at = $2, score = $3, energy_loss_kwh = energy_loss_kwh + $4, updated_at = now()
       WHERE id = $1`,
      [row.id, ts > prev ? r.timestamp : new Date(prev).toISOString(), Math.max(Number(row.score), s.anomaly_score), lossKw * stepH],
    );
    return 'updated';
  }

  const ins = await db.query(
    `INSERT INTO alerts (meter_id, type, severity, score, explanation, detected_at, last_detected_at, loss_kw, energy_loss_kwh)
     VALUES ($1,$2,$3,$4,$5,$6,$6,$7,$8) RETURNING *`,
    [s.meter_id, s.predicted_type, s.severity, s.anomaly_score, JSON.stringify(s.explanations), r.timestamp, lossKw, lossKw * INITIAL_LOSS_HOURS],
  );
  const alert = ins.rows[0];
  await db.query('INSERT INTO alert_events (alert_id, actor, action, details) VALUES ($1,$2,$3,$4)', [
    alert.id,
    'system',
    'created',
    `score=${s.anomaly_score}`,
  ]);
  emitter.emit('alert', serializeAlert(alert));
  return 'created';
}

export function serializeAlert(a: any) {
  let explanation: unknown = a.explanation;
  try {
    explanation = JSON.parse(a.explanation);
  } catch {
    /* keep raw string */
  }
  return { ...a, explanation };
}
