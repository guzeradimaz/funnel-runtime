import path from 'node:path';
import { createApp } from './app';
import { openDb } from './db';
import { seedConfigs } from './seed';

const db = openDb();
const seeded = seedConfigs(db, { initialVersion: Number(process.env.INITIAL_VERSION ?? 1) });
console.log(`Configs in store: ${seeded.map((s) => `${s.funnelId}@v${s.version}`).join(', ')}`);

const app = createApp(db, {
  adminToken: process.env.ADMIN_TOKEN || undefined,
  staticDir: process.env.NODE_ENV === 'production' ? path.resolve('dist') : undefined,
});

const port = Number(process.env.PORT ?? 3000);
// HOST=127.0.0.1 behind a reverse proxy; default listens on all interfaces (Docker, local dev).
const host = process.env.HOST ?? '0.0.0.0';
app.listen(port, host, () => console.log(`Funnel runtime API on http://${host}:${port}`));
