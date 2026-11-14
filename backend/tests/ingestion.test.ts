import request from 'supertest';
import { API_KEY, reading, setup } from './helpers';

const post = (app: any, readings: any[], key: string | null = API_KEY) => {
  const r = request(app).post('/api/readings');
  if (key) r.set('x-api-key', key);
  return r.send({ readings });
};

describe('ingestion', () => {
  it('rejects missing/invalid API key', async () => {
    const { app } = await setup();
    expect((await post(app, [reading('M1', '2026-01-01T00:00:00Z')], null)).status).toBe(401);
    expect((await post(app, [reading('M1', '2026-01-01T00:00:00Z')], 'bad')).status).toBe(401);
  });

  it('validates the payload schema', async () => {
    const { app } = await setup();
    const res = await post(app, [reading('M1', 'not-a-date', { power_factor: 3 })]);
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('Validation failed');
    expect((await request(app).post('/api/readings').set('x-api-key', API_KEY).send({})).status).toBe(400);
  });

  it('stores readings, auto-registers meters, and calls the ML service', async () => {
    const { app, db, ml, events } = await setup();
    const res = await post(app, [reading('M1', '2026-01-01T00:00:00Z'), reading('M2', '2026-01-01T00:00:00Z')]);
    expect(res.status).toBe(202);
    expect(res.body).toMatchObject({ received: 2, inserted: 2, duplicates: 0, alerts_created: 0, ml_available: true });
    expect(ml.calls).toBe(1);
    expect((await db.query('SELECT * FROM meters')).rows).toHaveLength(2);
    expect(events.filter((e) => e.event === 'reading')).toHaveLength(2);
  });

  it('ignores duplicate readings (idempotent redelivery)', async () => {
    const { app, db } = await setup();
    const batch = [reading('M1', '2026-01-01T00:00:00Z')];
    await post(app, batch);
    const again = await post(app, [...batch, reading('M1', '2026-01-01T00:00:01Z')]);
    expect(again.body).toMatchObject({ received: 2, inserted: 1, duplicates: 1 });
    expect((await db.query('SELECT * FROM readings')).rows).toHaveLength(2);
  });

  it('handles out-of-order readings without rewinding last_seen', async () => {
    const { app, db } = await setup();
    await post(app, [reading('M1', '2026-01-01T00:00:10Z')]);
    await post(app, [reading('M1', '2026-01-01T00:00:05Z'), reading('M1', '2026-01-01T00:00:02Z')]);
    const m = (await db.query('SELECT last_seen FROM meters WHERE id = $1', ['M1'])).rows[0];
    expect(new Date(m.last_seen).toISOString()).toBe('2026-01-01T00:00:10.000Z');
    const ts = (await db.query('SELECT ts FROM readings WHERE meter_id = $1 ORDER BY ts', ['M1'])).rows.map((r) => new Date(r.ts).toISOString());
    expect(ts).toEqual(['2026-01-01T00:00:02.000Z', '2026-01-01T00:00:05.000Z', '2026-01-01T00:00:10.000Z']);
  });

  it('still stores readings when the ML service is down', async () => {
    const { app, db, ml } = await setup();
    ml.fail = true;
    const res = await post(app, [reading('M1', '2026-01-01T00:00:00Z')]);
    expect(res.status).toBe(202);
    expect(res.body.ml_available).toBe(false);
    expect((await db.query('SELECT * FROM readings')).rows).toHaveLength(1);
  });
});
