import { newDb } from 'pg-mem';
import { Db, migrate } from '../src/db';
import { seedDatabase } from '../src/seed';

describe('seed script', () => {
  it('seeds admin/operator/viewer users, 20 meters, 7 days of readings, and alerts idempotently', async () => {
    const mem = newDb();
    const { Pool } = mem.adapters.createPg();
    const db = new Pool() as unknown as Db;
    await migrate(db);

    const first = await seedDatabase(db, { days: 7, intervalMinutes: 360, hashRounds: 4 });
    expect(first.users).toBe(3);
    expect(first.meters).toBe(20);
    expect(first.readings).toBe(20 * 28); // 7 days * 4 samples/day
    expect(first.alerts).toBe(6);

    const users = (await db.query('SELECT email, role FROM users ORDER BY role')).rows;
    expect(users.map((u) => u.role)).toEqual(['admin', 'operator', 'viewer']);

    const meters = (await db.query('SELECT id FROM meters')).rows;
    expect(meters).toHaveLength(20);

    // Second invocation must be completely idempotent
    const second = await seedDatabase(db, { days: 7, intervalMinutes: 360, hashRounds: 4 });
    expect(second).toEqual({ users: 0, meters: 0, readings: 0, alerts: 0 });
  });
});
