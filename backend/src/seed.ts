import 'dotenv/config';
import bcrypt from 'bcryptjs';
import { createPool, Db, migrate } from './db';

export interface SeedOptions {
  days?: number;
  intervalMinutes?: number;
  hashRounds?: number;
}

export interface SeedSummary {
  users: number;
  meters: number;
  readings: number;
  alerts: number;
}

const FEEDERS = [
  'North Substation - Feeder A',
  'North Substation - Feeder B',
  'East Industrial Park - Line 1',
  'East Industrial Park - Line 2',
  'Central Commercial - Block C',
];

function dailyLoadMultiplier(date: Date): number {
  const hour = date.getUTCHours() + date.getUTCMinutes() / 60;
  const nightBase = 0.4;
  const morning = 0.45 * Math.exp(-((hour - 8.5) ** 2) / (2 * 2.0 ** 2));
  const midday = 0.3 * Math.exp(-((hour - 13.5) ** 2) / (2 * 3.0 ** 2));
  const evening = 1.05 * Math.exp(-((hour - 19.75) ** 2) / (2 * 2.2 ** 2));
  return Math.max(0.25, Math.min(2.0, nightBase + morning + midday + evening));
}

export async function seedDatabase(db: Db, options: SeedOptions = {}): Promise<SeedSummary> {
  const days = options.days ?? 7;
  const intervalMinutes = options.intervalMinutes ?? 30;
  const hashRounds = options.hashRounds ?? 10;

  // 1. Users (admin, operator, viewer)
  const adminEmail = (process.env.ADMIN_EMAIL ?? 'admin@gridsense.local').toLowerCase();
  const adminPassword = process.env.ADMIN_PASSWORD ?? 'ChangeMe123!';
  const seedUsers: Array<{ email: string; password: string; role: 'admin' | 'operator' | 'viewer' }> = [
    { email: adminEmail, password: adminPassword, role: 'admin' },
    { email: 'operator@gridsense.local', password: 'ChangeMe123!', role: 'operator' },
    { email: 'viewer@gridsense.local', password: 'ChangeMe123!', role: 'viewer' },
  ];

  let usersInserted = 0;
  for (const u of seedUsers) {
    const existing = await db.query('SELECT id FROM users WHERE email = $1', [u.email]);
    if (existing.rows.length === 0) {
      const hash = await bcrypt.hash(u.password, hashRounds);
      await db.query('INSERT INTO users (email, password_hash, role) VALUES ($1, $2, $3)', [
        u.email,
        hash,
        u.role,
      ]);
      usersInserted++;
    }
  }

  // 2. 20 Smart Meters (MTR-001 .. MTR-020)
  const meterIds = Array.from({ length: 20 }, (_, i) => `MTR-${String(i + 1).padStart(3, '0')}`);
  let metersInserted = 0;
  for (let i = 0; i < meterIds.length; i++) {
    const id = meterIds[i];
    const existing = await db.query('SELECT id FROM meters WHERE id = $1', [id]);
    if (existing.rows.length === 0) {
      await db.query('INSERT INTO meters (id, name, location) VALUES ($1, $2, $3)', [
        id,
        id,
        `${FEEDERS[i % FEEDERS.length]} #${i + 1}`,
      ]);
      metersInserted++;
    }
  }

  // 3. 7 Days of Historical Readings (idempotent check)
  const existingReadingsCountRes = await db.query('SELECT COUNT(*) AS cnt FROM readings');
  const existingReadingsCount = Number(existingReadingsCountRes.rows[0]?.cnt ?? 0);
  let readingsInserted = 0;

  if (existingReadingsCount === 0) {
    const now = Date.now();
    const totalSteps = Math.floor((days * 24 * 60) / intervalMinutes);
    const stepMs = intervalMinutes * 60_000;
    const startMs = now - totalSteps * stepMs;

    const energyCounters: Record<string, number> = {};
    for (let i = 0; i < meterIds.length; i++) {
      energyCounters[meterIds[i]] = 1200 + i * 180;
    }

    const batchRows: any[][] = [];
    const BATCH_SIZE = 200;

    const flushBatch = async () => {
      if (batchRows.length === 0) return;
      const valuesSql: string[] = [];
      const params: unknown[] = [];
      let pIdx = 1;
      for (const row of batchRows) {
        const placeholders = row.map(() => `$${pIdx++}`).join(',');
        valuesSql.push(`(${placeholders})`);
        params.push(...row);
      }
      await db.query(
        `INSERT INTO readings (
          meter_id, ts, voltage_a, voltage_b, voltage_c,
          current_a, current_b, current_c,
          power_factor, frequency, active_energy_kwh, fault_label
        ) VALUES ${valuesSql.join(',')}
        ON CONFLICT (meter_id, ts) DO NOTHING`,
        params,
      );
      readingsInserted += batchRows.length;
      batchRows.length = 0;
    };

    for (let step = 0; step < totalSteps; step++) {
      const tsDate = new Date(startMs + step * stepMs);
      const tsIso = tsDate.toISOString();
      const loadMult = dailyLoadMultiplier(tsDate);

      for (let mIdx = 0; mIdx < meterIds.length; mIdx++) {
        const meterId = meterIds[mIdx];
        const baseI = (12 + (mIdx % 7) * 1.8) * loadMult;
        let va = 230 + Math.sin(step * 0.3 + mIdx) * 1.1;
        let vb = 230 + Math.cos(step * 0.25 + mIdx) * 1.1;
        let vc = 230 + Math.sin(step * 0.2 - mIdx) * 1.0;
        let ia = baseI * (1 + 0.02 * Math.sin(step + mIdx));
        let ib = baseI * (1 + 0.02 * Math.cos(step + mIdx));
        let ic = baseI * (1 - 0.015 * Math.sin(step + mIdx));
        let pf = 0.95;
        let freq = 50.0 + Math.sin(step * 0.1) * 0.03;
        let label = 'normal';

        // Deterministic fault patterns on specific historical steps
        if (mIdx === 2 && step % 60 === 12) {
          label = 'power_theft';
          ia *= 0.5;
          ib *= 0.5;
          ic *= 0.5;
        } else if (mIdx === 5 && step % 75 === 20) {
          label = 'phase_imbalance';
          ib *= 1.28;
        } else if (mIdx === 8 && step % 90 === 30) {
          label = 'voltage_sag';
          va = 192.0;
          vb = 194.5;
          vc = 193.0;
        }

        const kw = ((va * ia + vb * ib + vc * ic) * pf) / 1000;
        energyCounters[meterId] += kw * (intervalMinutes / 60);

        batchRows.push([
          meterId,
          tsIso,
          Number(va.toFixed(2)),
          Number(vb.toFixed(2)),
          Number(vc.toFixed(2)),
          Number(ia.toFixed(2)),
          Number(ib.toFixed(2)),
          Number(ic.toFixed(2)),
          Number(pf.toFixed(4)),
          Number(freq.toFixed(3)),
          Number(energyCounters[meterId].toFixed(3)),
          label,
        ]);

        if (batchRows.length >= BATCH_SIZE) {
          await flushBatch();
        }
      }
    }
    await flushBatch();

    const lastTsIso = new Date(startMs + (totalSteps - 1) * stepMs).toISOString();
    for (const meterId of meterIds) {
      await db.query(
        'UPDATE meters SET last_seen = $2 WHERE id = $1 AND (last_seen IS NULL OR last_seen < $2)',
        [meterId, lastTsIso],
      );
    }
  }

  // 4. Seed representative alerts across past weeks for immediate Analytics / Alerts visibility
  const existingAlertsRes = await db.query('SELECT COUNT(*) AS cnt FROM alerts');
  const existingAlertsCount = Number(existingAlertsRes.rows[0]?.cnt ?? 0);
  let alertsInserted = 0;

  if (existingAlertsCount === 0) {
    const nowMs = Date.now();
    const hourMs = 3_600_000;
    const dayMs = 24 * hourMs;
    const samples = [
      {
        meter_id: 'MTR-003',
        type: 'power_theft',
        severity: 'critical',
        score: 0.92,
        status: 'open',
        assigned_to: null,
        offsetMs: 2 * hourMs,
        loss_kw: 4.8,
        energy_loss_kwh: 2.4,
        explanation: [
          {
            feature: 'load_vs_profile',
            deviation_pct: -48.0,
            z_score: 4.2,
            description: "Load is 48% below this meter's typical level for this time of day",
          },
          {
            feature: 'current_mean_rel_dev_60m',
            deviation_pct: -46.5,
            z_score: 3.9,
            description: 'Three-phase average load (6.4A) is 47% below its 60-minute baseline',
          },
          {
            feature: 'voltage_a',
            deviation_pct: 0.2,
            z_score: 0.1,
            description: 'Phase A voltage (230.4V) is 0% above its 60-minute baseline',
          },
        ],
      },
      {
        meter_id: 'MTR-006',
        type: 'phase_imbalance',
        severity: 'high',
        score: 0.86,
        status: 'acknowledged',
        assigned_to: 'operator@gridsense.local',
        offsetMs: 6 * hourMs,
        loss_kw: 0,
        energy_loss_kwh: 0,
        explanation: [
          {
            feature: 'current_imbalance_nema',
            deviation_pct: 26.5,
            z_score: 3.7,
            description: 'Phase current imbalance index is 27% above balanced 3-phase baseline',
          },
        ],
      },
      {
        meter_id: 'MTR-009',
        type: 'voltage_sag',
        severity: 'high',
        score: 0.92,
        status: 'closed',
        assigned_to: 'crew-north-2',
        offsetMs: 2 * dayMs,
        loss_kw: 0,
        energy_loss_kwh: 0,
        explanation: [
          {
            feature: 'voltage_a',
            deviation_pct: -16.5,
            z_score: 4.9,
            description: 'Phase A voltage (192.0V) is 17% below its 60-minute baseline',
          },
        ],
      },
      {
        meter_id: 'MTR-012',
        type: 'power_theft',
        severity: 'critical',
        score: 0.89,
        status: 'closed',
        assigned_to: 'audit-team-1',
        offsetMs: 8 * dayMs,
        loss_kw: 5.2,
        energy_loss_kwh: 6.4,
        explanation: [
          {
            feature: 'load_vs_profile',
            deviation_pct: -52.0,
            z_score: 4.5,
            description: "Load is 52% below this meter's typical level for this time of day",
          },
        ],
      },
      {
        meter_id: 'MTR-015',
        type: 'harmonic_distortion',
        severity: 'medium',
        score: 0.88,
        status: 'closed',
        assigned_to: 'operator@gridsense.local',
        offsetMs: 15 * dayMs,
        loss_kw: 0,
        energy_loss_kwh: 0,
        explanation: [
          {
            feature: 'power_factor',
            deviation_pct: -28.0,
            z_score: 4.1,
            description: 'Power factor (0.68) is 28% below its 60-minute baseline',
          },
        ],
      },
      {
        meter_id: 'MTR-003',
        type: 'power_theft',
        severity: 'critical',
        score: 0.90,
        status: 'closed',
        assigned_to: 'audit-team-1',
        offsetMs: 22 * dayMs,
        loss_kw: 4.1,
        energy_loss_kwh: 5.2,
        explanation: [
          {
            feature: 'load_vs_profile',
            deviation_pct: -41.0,
            z_score: 3.8,
            description: "Load is 41% below this meter's typical level for this time of day",
          },
        ],
      },
    ];

    for (const s of samples) {
      const ts = new Date(nowMs - s.offsetMs).toISOString();
      const res = await db.query(
        `INSERT INTO alerts (
          meter_id, type, severity, score, explanation, status, assigned_to,
          detected_at, last_detected_at, loss_kw, energy_loss_kwh
        ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$8,$9,$10) RETURNING id`,
        [
          s.meter_id,
          s.type,
          s.severity,
          s.score,
          JSON.stringify(s.explanation),
          s.status,
          s.assigned_to,
          ts,
          s.loss_kw,
          s.energy_loss_kwh,
        ],
      );
      const alertId = res.rows[0].id;
      await db.query(
        'INSERT INTO alert_events (alert_id, actor, action, details) VALUES ($1, $2, $3, $4)',
        [alertId, 'system', 'created', `seeded score=${s.score}`],
      );
      alertsInserted++;
    }
  }

  return {
    users: usersInserted,
    meters: metersInserted,
    readings: readingsInserted,
    alerts: alertsInserted,
  };
}

async function runCli() {
  const dbUrl = process.env.DATABASE_URL;
  if (!dbUrl) {
    throw new Error('DATABASE_URL must be set to run seed script');
  }
  const pool = createPool(dbUrl);
  try {
    await migrate(pool);
    const summary = await seedDatabase(pool);
    console.log('[seed] complete:', summary);
  } finally {
    await pool.end();
  }
}

if (require.main === module) {
  runCli().catch((err) => {
    console.error('[seed] failed:', err);
    process.exit(1);
  });
}
