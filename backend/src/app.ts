import bcrypt from 'bcryptjs';
import cors from 'cors';
import express, { Express } from 'express';
import helmet from 'helmet';
import rateLimit from 'express-rate-limit';
import { z } from 'zod';
import { authenticate, requireRole, signToken } from './auth';
import { Db } from './db';
import {
  computeBackendEnergyLossTodayKwh,
  getIstDateKey,
  getIstDayEndUtcIso,
  getIstDayStartUtcIso,
} from './energyLoss';
import { asyncHandler, errorHandler, HttpError, notFound } from './errors';
import { batchSchema, Emitter, ingestReadings, serializeAlert } from './ingest';
import { MlClient } from './mlClient';

export interface AppDeps {
  db: Db;
  ml: MlClient;
  emitter: Emitter;
  jwtSecret: string;
  ingestApiKey: string;
  corsOrigin?: string;
  /** Requests/minute for the general API limiter, and attempts/15min for login. */
  limits?: { api?: number; ingest?: number; login?: number };
}

const csvEscape = (v: unknown) => {
  const s = v === null || v === undefined ? '' : String(v instanceof Date ? v.toISOString() : v);
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};
const toCsv = (cols: string[], rows: any[]) =>
  [cols.join(','), ...rows.map((r) => cols.map((c) => csvEscape(r[c])).join(','))].join('\n') + '\n';

const iso = (v: unknown) => new Date(v as any).toISOString();

export function createApp(deps: AppDeps): Express {
  const { db, ml, emitter, jwtSecret } = deps;
  const app = express();
  const limits = { api: 600, ingest: 600, login: 20, ...deps.limits };

  app.set('trust proxy', 1);
  app.use(helmet());
  app.use(cors({ origin: deps.corsOrigin ?? '*' }));
  app.use(express.json({ limit: '2mb' }));

  const mkLimiter = (max: number, windowMs: number) =>
    rateLimit({ windowMs, max, standardHeaders: true, legacyHeaders: false, message: { error: 'Too many requests' } });
  const apiLimiter = mkLimiter(limits.api, 60_000);
  const auth = authenticate(jwtSecret);

  app.get('/health', (_req, res) => res.json({ status: 'ok' }));

  // ---------- Auth ----------
  const loginSchema = z.object({ email: z.string().email(), password: z.string().min(1) });
  app.post(
    '/api/auth/login',
    mkLimiter(limits.login, 15 * 60_000),
    asyncHandler(async (req, res) => {
      const { email, password } = loginSchema.parse(req.body);
      const r = await db.query('SELECT * FROM users WHERE email = $1', [email.toLowerCase()]);
      const u = r.rows[0];
      // Same message for unknown user / wrong password to avoid account enumeration.
      if (!u || !(await bcrypt.compare(password, u.password_hash))) throw new HttpError(401, 'Invalid credentials');
      const user = { id: u.id, email: u.email, role: u.role };
      res.json({ token: signToken(user, jwtSecret), user });
    }),
  );

  app.get('/api/auth/me', apiLimiter, auth, (req, res) => res.json({ user: req.user }));

  const registerSchema = z.object({
    email: z.string().email(),
    password: z.string().min(8),
    role: z.enum(['admin', 'operator', 'viewer']),
  });
  app.post(
    '/api/auth/register',
    apiLimiter,
    auth,
    requireRole('admin'),
    asyncHandler(async (req, res) => {
      const b = registerSchema.parse(req.body);
      const hash = await bcrypt.hash(b.password, 10);
      try {
        const r = await db.query('INSERT INTO users (email, password_hash, role) VALUES ($1,$2,$3) RETURNING id, email, role', [
          b.email.toLowerCase(),
          hash,
          b.role,
        ]);
        res.status(201).json({ user: r.rows[0] });
      } catch (e: any) {
        if (/unique|duplicate/i.test(e.message)) throw new HttpError(409, 'Email already registered');
        throw e;
      }
    }),
  );

  app.get(
    '/api/users',
    apiLimiter,
    auth,
    requireRole('operator'),
    asyncHandler(async (_req, res) => {
      const r = await db.query('SELECT id, email, role FROM users ORDER BY email');
      res.json({ users: r.rows });
    }),
  );

  // ---------- Ingestion (machine-to-machine, API key) ----------
  app.post(
    '/api/readings',
    mkLimiter(limits.ingest, 60_000),
    asyncHandler(async (req, res) => {
      if (req.header('x-api-key') !== deps.ingestApiKey) throw new HttpError(401, 'Invalid API key');
      const { readings } = batchSchema.parse(req.body);
      const result = await ingestReadings(db, ml, emitter, readings);
      res.status(202).json(result);
    }),
  );

  // Everything below requires a logged-in user.
  app.use('/api', apiLimiter, auth);

  // ---------- Meters ----------
  app.get(
    '/api/meters',
    asyncHandler(async (_req, res) => {
      const r = await db.query(`SELECT id, name, location, last_seen FROM meters ORDER BY id`);
      const meters = [];
      for (const m of r.rows) {
        const latest = await db.query('SELECT * FROM readings WHERE meter_id = $1 ORDER BY ts DESC LIMIT 1', [m.id]);
        const open = await db.query(
          `SELECT severity, type FROM alerts WHERE meter_id = $1 AND status <> 'closed' ORDER BY detected_at DESC`,
          [m.id],
        );
        meters.push({ ...m, latest_reading: latest.rows[0] ?? null, open_alerts: open.rows });
      }
      res.json({ meters });
    }),
  );

  app.get(
    '/api/meters/:id',
    asyncHandler(async (req, res) => {
      const m = await db.query('SELECT id, name, location, last_seen FROM meters WHERE id = $1', [req.params.id]);
      if (!m.rows[0]) throw new HttpError(404, 'Meter not found');
      const latest = await db.query('SELECT * FROM readings WHERE meter_id = $1 ORDER BY ts DESC LIMIT 1', [req.params.id]);
      res.json({ ...m.rows[0], latest_reading: latest.rows[0] ?? null });
    }),
  );

  // ---------- Readings with time range + downsampling ----------
  const NUM = ['voltage_a', 'voltage_b', 'voltage_c', 'current_a', 'current_b', 'current_c', 'power_factor', 'frequency', 'active_energy_kwh'];
  const readingsQuery = z.object({
    meter_id: z.string().min(1),
    from: z.string().datetime({ offset: true }).optional(),
    to: z.string().datetime({ offset: true }).optional(),
    bucket_seconds: z.coerce.number().int().min(1).max(86400).optional(),
    limit: z.coerce.number().int().min(1).max(20000).default(5000),
  });
  const readingsHandler = asyncHandler(async (req, res) => {
    const q = readingsQuery.parse({ ...req.query, meter_id: req.params.id ?? req.query.meter_id });
    const to = q.to ?? new Date().toISOString();
    const from = q.from ?? new Date(Date.parse(to) - 15 * 60_000).toISOString();
    const r = await db.query(
      'SELECT * FROM readings WHERE meter_id = $1 AND ts >= $2 AND ts <= $3 ORDER BY ts ASC LIMIT $4',
      [q.meter_id, from, to, q.limit],
    );
    let rows: any[] = r.rows.map((x) => ({ ...x, ts: iso(x.ts) }));
    if (q.bucket_seconds) {
      // Averaged buckets keep charts light for long ranges; done in app code to stay DB-portable.
      const size = q.bucket_seconds * 1000;
      const buckets = new Map<number, any[]>();
      for (const x of rows) {
        const k = Math.floor(Date.parse(x.ts) / size) * size;
        (buckets.get(k) ?? buckets.set(k, []).get(k)!).push(x);
      }
      rows = [...buckets.entries()].map(([k, xs]) => {
        const o: any = { meter_id: q.meter_id, ts: new Date(k).toISOString(), samples: xs.length };
        for (const c of NUM) o[c] = xs.reduce((s, x) => s + x[c], 0) / xs.length;
        o.active_energy_kwh = xs[xs.length - 1].active_energy_kwh; // cumulative counter -> last value
        return o;
      });
    }
    res.json({ meter_id: q.meter_id, from, to, count: rows.length, readings: rows });
  });
  app.get('/api/readings', readingsHandler);
  app.get('/api/meters/:id/readings', readingsHandler);

  // ---------- Alerts ----------
  const alertsQuery = z.object({
    severity: z.string().optional(),
    type: z.string().optional(),
    status: z.enum(['open', 'acknowledged', 'closed']).optional(),
    meter_id: z.string().optional(),
    limit: z.coerce.number().int().min(1).max(500).default(100),
    offset: z.coerce.number().int().min(0).default(0),
  });
  app.get(
    '/api/alerts',
    asyncHandler(async (req, res) => {
      const q = alertsQuery.parse(req.query);
      const where: string[] = [];
      const params: unknown[] = [];
      for (const k of ['severity', 'type', 'status', 'meter_id'] as const) {
        if (q[k]) {
          params.push(q[k]);
          where.push(`${k} = $${params.length}`);
        }
      }
      const w = where.length ? `WHERE ${where.join(' AND ')}` : '';
      const total = await db.query(`SELECT id FROM alerts ${w}`, params);
      const openAll = await db.query(`SELECT id FROM alerts WHERE status = 'open'`);
      params.push(q.limit, q.offset);
      const r = await db.query(
        `SELECT * FROM alerts ${w} ORDER BY detected_at DESC LIMIT $${params.length - 1} OFFSET $${params.length}`,
        params,
      );
      res.json({
        total: total.rows.length,
        open_count: openAll.rows.length,
        alerts: r.rows.map(serializeAlert),
      });
    }),
  );

  app.get(
    '/api/alerts/:id',
    asyncHandler(async (req, res) => {
      const a = await db.query('SELECT * FROM alerts WHERE id = $1', [Number(req.params.id)]);
      if (!a.rows[0]) throw new HttpError(404, 'Alert not found');
      const ev = await db.query('SELECT * FROM alert_events WHERE alert_id = $1 ORDER BY id ASC', [Number(req.params.id)]);
      res.json({ ...serializeAlert(a.rows[0]), events: ev.rows });
    }),
  );

  async function transition(id: number, actor: string, action: string, set: string, params: unknown[], details?: string) {
    const cur = await db.query('SELECT * FROM alerts WHERE id = $1', [id]);
    if (!cur.rows[0]) throw new HttpError(404, 'Alert not found');
    if (cur.rows[0].status === 'closed') throw new HttpError(409, 'Alert is already closed');
    const r = await db.query(`UPDATE alerts SET ${set}, updated_at = now() WHERE id = $1 RETURNING *`, [id, ...params]);
    await db.query('INSERT INTO alert_events (alert_id, actor, action, details) VALUES ($1,$2,$3,$4)', [id, actor, action, details ?? null]);
    const ev = await db.query('SELECT * FROM alert_events WHERE alert_id = $1 ORDER BY id DESC', [id]);
    const out = { ...serializeAlert(r.rows[0]), events: ev.rows };
    emitter.emit('alert:update', out);
    return out;
  }

  app.post(
    '/api/alerts/:id/acknowledge',
    requireRole('operator'),
    asyncHandler(async (req, res) => {
      res.json(await transition(Number(req.params.id), req.user!.email, 'acknowledged', `status = 'acknowledged'`, []));
    }),
  );
  app.post(
    '/api/alerts/:id/assign',
    requireRole('operator'),
    asyncHandler(async (req, res) => {
      const { assigned_to } = z.object({ assigned_to: z.string().min(1).max(255) }).parse(req.body);
      res.json(await transition(Number(req.params.id), req.user!.email, 'assigned', `assigned_to = $2`, [assigned_to], assigned_to));
    }),
  );
  app.post(
    '/api/alerts/:id/close',
    requireRole('operator'),
    asyncHandler(async (req, res) => {
      const { note } = z.object({ note: z.string().max(500).optional() }).parse(req.body ?? {});
      res.json(await transition(Number(req.params.id), req.user!.email, 'closed', `status = 'closed'`, [], note));
    }),
  );

  // ---------- Reports / analytics ----------
  const rangeQuery = z.object({
    from: z.string().datetime({ offset: true }).optional(),
    to: z.string().datetime({ offset: true }).optional(),
    format: z.enum(['json', 'csv']).default('json'),
  });
  const range = (q: z.infer<typeof rangeQuery>) => {
    const to = q.to ?? new Date().toISOString();
    return { from: q.from ?? new Date(Date.parse(to) - 30 * 86_400_000).toISOString(), to };
  };
  const fetchAlerts = async (from: string, to: string) =>
    (await db.query('SELECT * FROM alerts WHERE detected_at >= $1 AND detected_at <= $2 ORDER BY detected_at ASC', [from, to])).rows;

  app.get(
    '/api/reports/incidents',
    requireRole('operator'),
    asyncHandler(async (req, res) => {
      const q = rangeQuery.parse(req.query);
      const { from, to } = range(q);
      const rows = (await fetchAlerts(from, to)).map((a) => ({
        ...a,
        detected_at: iso(a.detected_at),
        explanation: serializeAlert(a).explanation && Array.isArray(serializeAlert(a).explanation)
          ? (serializeAlert(a).explanation as any[]).map((e) => e.description).join(' | ')
          : a.explanation,
        energy_loss_kwh: Number(a.energy_loss_kwh).toFixed(4),
      }));
      if (q.format === 'csv') {
        res.type('text/csv').attachment('incidents.csv');
        return res.send(
          toCsv(['id', 'meter_id', 'type', 'severity', 'score', 'status', 'assigned_to', 'detected_at', 'energy_loss_kwh', 'explanation'], rows),
        );
      }
      res.json({ from, to, incidents: rows });
    }),
  );

  /** Weekly estimated energy loss + today IST total using shared energyLoss helper. */
  app.get(
    '/api/reports/energy-loss',
    asyncHandler(async (req, res) => {
      const q = rangeQuery.parse(req.query);
      const { from, to } = range({ ...q, from: q.from ?? new Date(Date.parse(q.to ?? new Date().toISOString()) - 56 * 86_400_000).toISOString() });
      const weeks = new Map<string, { week_start: string; energy_loss_kwh: number; incidents: number }>();
      for (const a of await fetchAlerts(from, to)) {
        if (a.type !== 'power_theft') continue;
        const d = new Date(a.detected_at);
        const monday = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() - ((d.getUTCDay() + 6) % 7)));
        const key = monday.toISOString().slice(0, 10);
        const w = weeks.get(key) ?? { week_start: key, energy_loss_kwh: 0, incidents: 0 };
        w.energy_loss_kwh += Number(a.energy_loss_kwh);
        w.incidents += 1;
        weeks.set(key, w);
      }
      const rows = [...weeks.values()].sort((a, b) => a.week_start.localeCompare(b.week_start)).map((w) => ({ ...w, energy_loss_kwh: +w.energy_loss_kwh.toFixed(4) }));
      if (q.format === 'csv') {
        res.type('text/csv').attachment('energy-loss.csv');
        return res.send(toCsv(['week_start', 'incidents', 'energy_loss_kwh'], rows));
      }
      const nowMs = Date.now();
      const todayRows = await fetchAlerts(getIstDayStartUtcIso(nowMs), getIstDayEndUtcIso(nowMs));
      res.json({
        from,
        to,
        weeks: rows,
        today_date_ist: getIstDateKey(nowMs),
        today_energy_loss_kwh: computeBackendEnergyLossTodayKwh(todayRows, nowMs),
      });
    }),
  );

  // ---------- Simulator Demo Trigger (routes through ML + DB + Socket.IO) ----------
  const simInjectSchema = z.object({
    meter_id: z.string().min(1).max(64).default('MTR-004'),
    fault_type: z.enum(['power_theft', 'phase_imbalance', 'voltage_sag']).default('power_theft'),
  });
  app.post(
    '/api/simulator/inject-fault',
    requireRole('operator'),
    asyncHandler(async (req, res) => {
      const { meter_id, fault_type } = simInjectSchema.parse(req.body ?? {});
      const latest = await db.query(
        'SELECT * FROM readings WHERE meter_id = $1 ORDER BY ts DESC LIMIT 1',
        [meter_id],
      );
      const prev = latest.rows[0];
      const nextMs = Math.max(Date.now(), prev ? Date.parse(String(prev.ts)) + 1000 : 0);
      const tsIso = new Date(nextMs).toISOString();

      let voltage_a = 230.2;
      let voltage_b = 229.8;
      let voltage_c = 230.4;
      let current_a = 15.0;
      let current_b = 14.9;
      let current_c = 15.1;
      let power_factor = 0.95;

      if (fault_type === 'power_theft') {
        const baseI = prev ? Math.max(12.0, Number(prev.current_a)) : 16.0;
        current_a = +(baseI * 0.44).toFixed(2);
        current_b = +(baseI * 0.45).toFixed(2);
        current_c = +(baseI * 0.43).toFixed(2);
      } else if (fault_type === 'phase_imbalance') {
        current_b = +(current_a * 1.45).toFixed(2);
        voltage_b = 216.8;
      } else {
        voltage_a = 194.2;
        voltage_b = 195.4;
        voltage_c = 194.8;
      }

      const prevEnergy = prev ? Number(prev.active_energy_kwh) : 1850;
      const readingPayload = {
        timestamp: tsIso,
        meter_id,
        voltage_a,
        voltage_b,
        voltage_c,
        current_a,
        current_b,
        current_c,
        power_factor,
        frequency: 50.01,
        active_energy_kwh: +(prevEnergy + 0.01).toFixed(3),
        fault_label: fault_type,
      };
      const outcome = await ingestReadings(db, ml, emitter, [readingPayload]);
      res.status(202).json({ meter_id, fault_type, timestamp: tsIso, ...outcome });
    }),
  );

  app.get(
    '/api/reports/fault-frequency',
    asyncHandler(async (req, res) => {
      const q = rangeQuery.parse(req.query);
      const { from, to } = range(q);
      const counts: Record<string, number> = {};
      for (const a of await fetchAlerts(from, to)) counts[a.type] = (counts[a.type] ?? 0) + 1;
      res.json({ from, to, frequency: Object.entries(counts).map(([type, count]) => ({ type, count })) });
    }),
  );

  // ---------- Model health (proxy to ML service) ----------
  app.get(
    '/api/model/info',
    asyncHandler(async (_req, res) => {
      try {
        res.json(await ml.modelInfo());
      } catch {
        throw new HttpError(502, 'ML service unavailable');
      }
    }),
  );

  app.use(notFound);
  app.use(errorHandler);
  return app;
}
