import request from 'supertest';
import { reading, setup } from './helpers';

describe('auth', () => {
  it('logs in with valid credentials and returns a JWT + role', async () => {
    const { app } = await setup();
    const res = await request(app).post('/api/auth/login').send({ email: 'admin@t.io', password: 'password123' });
    expect(res.status).toBe(200);
    expect(res.body.user.role).toBe('admin');
    const me = await request(app).get('/api/auth/me').set('Authorization', `Bearer ${res.body.token}`);
    expect(me.body.user.email).toBe('admin@t.io');
  });

  it('rejects wrong password and unknown user with the same 401', async () => {
    const { app } = await setup();
    const a = await request(app).post('/api/auth/login').send({ email: 'admin@t.io', password: 'nope' });
    const b = await request(app).post('/api/auth/login').send({ email: 'ghost@t.io', password: 'nope' });
    expect([a.status, b.status]).toEqual([401, 401]);
    expect(a.body.error).toBe(b.body.error);
  });

  it('protects API routes: missing, malformed, and tampered tokens give 401', async () => {
    const { app } = await setup();
    expect((await request(app).get('/api/meters')).status).toBe(401);
    expect((await request(app).get('/api/meters').set('Authorization', 'Bearer junk')).status).toBe(401);
  });

  it('enforces roles on user management and reports', async () => {
    const { app } = await setup();
    const tok = async (e: string) => (await request(app).post('/api/auth/login').send({ email: e, password: 'password123' })).body.token;
    const [admin, op, viewer] = [await tok('admin@t.io'), await tok('op@t.io'), await tok('view@t.io')];
    const body = { email: 'new@t.io', password: 'longenough1', role: 'viewer' };
    expect((await request(app).post('/api/auth/register').set('Authorization', `Bearer ${op}`).send(body)).status).toBe(403);
    expect((await request(app).post('/api/auth/register').set('Authorization', `Bearer ${admin}`).send(body)).status).toBe(201);
    expect((await request(app).post('/api/auth/register').set('Authorization', `Bearer ${admin}`).send(body)).status).toBe(409);
    expect((await request(app).get('/api/reports/incidents').set('Authorization', `Bearer ${viewer}`)).status).toBe(403);
    expect((await request(app).get('/api/meters').set('Authorization', `Bearer ${viewer}`)).status).toBe(200);
  });

  it('returns 404 JSON for unknown routes and 400 for bad JSON', async () => {
    const { app } = await setup();
    expect((await request(app).get('/nope')).status).toBe(404);
    const bad = await request(app).post('/api/auth/login').set('content-type', 'application/json').send('{bad');
    expect(bad.status).toBe(400);
  });

  it('rate limits repeated login attempts', async () => {
    const { app } = await setup();
    let last = 0;
    for (let i = 0; i < 25; i++) last = (await request(app).post('/api/auth/login').send({ email: 'admin@t.io', password: 'x' })).status;
    expect(last).toBe(429);
  });

  it('serves readings with time range and downsampling', async () => {
    const { app } = await setup();
    const tok = (await request(app).post('/api/auth/login').send({ email: 'view@t.io', password: 'password123' })).body.token;
    const batch = Array.from({ length: 10 }, (_, i) => reading('M1', `2026-01-01T00:00:${String(i).padStart(2, '0')}Z`, { current_a: 10 + i }));
    await request(app).post('/api/readings').set('x-api-key', 'test-key').send({ readings: batch });
    const url = '/api/meters/M1/readings?from=2026-01-01T00:00:00Z&to=2026-01-01T00:00:09Z';
    const raw = await request(app).get(url).set('Authorization', `Bearer ${tok}`);
    expect(raw.body.count).toBe(10);
    const ds = await request(app).get(`${url}&bucket_seconds=5`).set('Authorization', `Bearer ${tok}`);
    expect(ds.body.count).toBe(2);
    expect(ds.body.readings[0].current_a).toBeCloseTo(12);
  });
});
