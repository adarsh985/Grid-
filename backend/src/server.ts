import 'dotenv/config';
import http from 'http';
import { Server } from 'socket.io';
import { createApp } from './app';
import { verifyToken } from './auth';
import { createPool, migrate } from './db';
import { HttpMlClient } from './mlClient';
import { seedDatabase } from './seed';

async function main() {
  const port = Number(process.env.PORT ?? 4000);
  const jwtSecret = process.env.JWT_SECRET;
  const dbUrl = process.env.DATABASE_URL;
  if (!jwtSecret || !dbUrl) throw new Error('JWT_SECRET and DATABASE_URL must be set (see .env.example)');

  const db = createPool(dbUrl);
  // Postgres may still be starting under docker compose; retry briefly.
  for (let i = 0; ; i++) {
    try {
      await migrate(db);
      break;
    } catch (e) {
      if (i >= 30) throw e;
      console.log('[db] waiting for postgres...');
      await new Promise((r) => setTimeout(r, 2000));
    }
  }

  if (process.env.AUTO_SEED !== 'false') {
    const seeded = await seedDatabase(db);
    console.log('[seed] startup check:', seeded);
  }

  const server = http.createServer();
  const io = new Server(server, { cors: { origin: process.env.CORS_ORIGIN ?? '*' } });
  io.use((socket, next) => {
    try {
      socket.data.user = verifyToken(String(socket.handshake.auth?.token ?? ''), jwtSecret);
      next();
    } catch {
      next(new Error('unauthorized'));
    }
  });

  const app = createApp({
    db,
    ml: new HttpMlClient(process.env.ML_SERVICE_URL ?? 'http://localhost:8000'),
    emitter: { emit: (event, payload) => io.emit(event, payload) },
    jwtSecret,
    ingestApiKey: process.env.INGEST_API_KEY ?? '',
    corsOrigin: process.env.CORS_ORIGIN,
  });
  server.on('request', app);
  server.listen(port, () => console.log(`GridSense backend listening on :${port}`));
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
