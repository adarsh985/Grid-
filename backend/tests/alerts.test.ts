import request from 'supertest';
import { API_KEY, reading, setup } from './helpers';

const login = async (app: any, email: string) =>
  (await request(app).post('/api/auth/login').send({ email, password: 'password123' })).body.token as string;

describe('alerts', () => {
  it('creates an alert with explanation and emits a socket event', async () => {
    const { app, ml, events } = await setup();
    ml.rule = () => ({});
    const res = await request(app).post('/api/readings').set('x-api-key', API_KEY).send({ readings: [reading('M1', '2026-01-01T00:00:00Z')] });
    expect(res.body.alerts_created).toBe(1);
    const created = events.filter((e) => e.event === 'alert');
    expect(created).toHaveLength(1);
    expect(created[0].payload).toMatchObject({ meter_id: 'M1', type: 'power_theft', status: 'open' });
    expect(created[0].payload.explanation[0].description).toMatch(/below/);
  });

  it('deduplicates same meter+type within 5 minutes and accumulates loss', async () => {
    const { app, db, ml, events } = await setup();
    ml.rule = () => ({});
    const send = (ts: string) => request(app).post('/api/readings').set('x-api-key', API_KEY).send({ readings: [reading('M1', ts)] });
    await send('2026-01-01T00:00:00Z');
    const b = await send('2026-01-01T00:02:00Z');
    const c = await send('2026-01-01T00:06:00Z'); // 4 min after the 2nd -> sliding window keeps it merged
    expect(b.body).toMatchObject({ alerts_created: 0, alerts_updated: 1 });
    expect(c.body).toMatchObject({ alerts_created: 0, alerts_updated: 1 });
    const rows = (await db.query('SELECT * FROM alerts')).rows;
    expect(rows).toHaveLength(1);
    expect(rows[0].energy_loss_kwh).toBeGreaterThan(rows[0].loss_kw / 60);
    expect(events.filter((e) => e.event === 'alert')).toHaveLength(1);
  });

  it('creates a new alert after the 5 minute window, and for different meters', async () => {
    const { app, db, ml } = await setup();
    ml.rule = () => ({});
    const send = (m: string, ts: string) => request(app).post('/api/readings').set('x-api-key', API_KEY).send({ readings: [reading(m, ts)] });
    await send('M1', '2026-01-01T00:00:00Z');
    await send('M1', '2026-01-01T00:10:00Z');
    await send('M2', '2026-01-01T00:10:00Z');
    expect((await db.query('SELECT * FROM alerts')).rows).toHaveLength(3);
  });

  it('supports acknowledge / assign / close with audit log and role checks', async () => {
    const { app, ml } = await setup();
    ml.rule = () => ({});
    await request(app).post('/api/readings').set('x-api-key', API_KEY).send({ readings: [reading('M1', '2026-01-01T00:00:00Z')] });
    const op = await login(app, 'op@t.io');
    const viewer = await login(app, 'view@t.io');

    const list = await request(app).get('/api/alerts?status=open&meter_id=M1').set('Authorization', `Bearer ${viewer}`);
    expect(list.body.total).toBe(1);
    const id = list.body.alerts[0].id;

    expect((await request(app).post(`/api/alerts/${id}/acknowledge`).set('Authorization', `Bearer ${viewer}`)).status).toBe(403);
    expect((await request(app).post(`/api/alerts/${id}/acknowledge`).set('Authorization', `Bearer ${op}`)).body.status).toBe('acknowledged');
    expect((await request(app).post(`/api/alerts/${id}/assign`).set('Authorization', `Bearer ${op}`).send({ assigned_to: 'crew-7' })).body.assigned_to).toBe('crew-7');
    expect((await request(app).post(`/api/alerts/${id}/close`).set('Authorization', `Bearer ${op}`).send({})).body.status).toBe('closed');
    expect((await request(app).post(`/api/alerts/${id}/close`).set('Authorization', `Bearer ${op}`).send({})).status).toBe(409);

    const detail = await request(app).get(`/api/alerts/${id}`).set('Authorization', `Bearer ${viewer}`);
    expect(detail.body.events.map((e: any) => e.action)).toEqual(['created', 'acknowledged', 'assigned', 'closed']);
  });

  it('maintains open_count and today_energy_loss_kwh parity across DB, /api/alerts, and /api/reports/energy-loss', async () => {
    const { app, db, ml, events } = await setup();
    ml.rule = () => ({});
    const op = await login(app, 'op@t.io');

    // Trigger fault via operator inject-fault endpoint -> ML -> Postgres -> Socket.IO
    const inj = await request(app)
      .post('/api/simulator/inject-fault')
      .set('Authorization', `Bearer ${op}`)
      .send({ meter_id: 'MTR-004', fault_type: 'power_theft' });
    expect(inj.status).toBe(202);
    expect(inj.body.alerts_created).toBe(1);
    expect(events.some((e) => e.event === 'alert' && e.payload?.meter_id === 'MTR-004')).toBe(true);

    const listOpen = await request(app).get('/api/alerts').set('Authorization', `Bearer ${op}`);
    const dbOpenRes = await db.query("SELECT id FROM alerts WHERE status = 'open'");
    expect(listOpen.body.open_count).toBe(dbOpenRes.rows.length);

    const report = await request(app).get('/api/reports/energy-loss').set('Authorization', `Bearer ${op}`);
    const alertLoss = Number(listOpen.body.alerts[0].energy_loss_kwh);
    expect(report.body.today_energy_loss_kwh).toBeCloseTo(Math.round(alertLoss * 100) / 100, 2);

    // Acknowledge returns full events array and drops open_count to 0
    const ackRes = await request(app)
      .post(`/api/alerts/${listOpen.body.alerts[0].id}/acknowledge`)
      .set('Authorization', `Bearer ${op}`);
    expect(ackRes.body.status).toBe('acknowledged');
    expect(ackRes.body.events.map((e: any) => e.action)).toContain('acknowledged');

    const afterAck = await request(app).get('/api/alerts').set('Authorization', `Bearer ${op}`);
    expect(afterAck.body.open_count).toBe(0);
  });

  it('exports incidents and weekly energy loss as CSV', async () => {
    const { app, ml } = await setup();
    ml.rule = () => ({});
    await request(app).post('/api/readings').set('x-api-key', API_KEY).send({ readings: [reading('M1', new Date().toISOString())] });
    const op = await login(app, 'op@t.io');
    const inc = await request(app).get('/api/reports/incidents?format=csv').set('Authorization', `Bearer ${op}`);
    expect(inc.headers['content-type']).toMatch(/text\/csv/);
    expect(inc.text.split('\n')[0]).toContain('meter_id,type,severity');
    expect(inc.text).toContain('M1,power_theft');
    const loss = await request(app).get('/api/reports/energy-loss').set('Authorization', `Bearer ${op}`);
    expect(loss.body.weeks).toHaveLength(1);
    expect(loss.body.weeks[0].energy_loss_kwh).toBeGreaterThan(0);
  });
});
