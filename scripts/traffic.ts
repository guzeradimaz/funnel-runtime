// npm run traffic -- [--sessions 150] [--seed 42] [--base http://localhost:3000]
import { generate, snapshot, verify, type Client } from './lib/traffic';

function arg(name: string, fallback: string) {
  const i = process.argv.indexOf(`--${name}`);
  return i > 0 ? process.argv[i + 1] : fallback;
}

const client: Client = { base: arg('base', process.env.BASE_URL ?? 'http://localhost:3000'), adminToken: process.env.ADMIN_TOKEN };
const sessions = Number(arg('sessions', '150'));
const seed = Number(arg('seed', String(Date.now() % 100000)));

const before = await snapshot(client);
const { expected } = await generate(client, { sessions, seed });
const after = await snapshot(client);
console.log(`Seed ${seed}. Generator ground truth vs dashboard (unique sessions):`);
const ok = verify(before, after, expected);
console.log(ok ? 'Dashboard matches generated data.' : 'Dashboard does NOT match generated data.');
console.log(`Open ${client.base}/dashboard`);
process.exit(ok ? 0 : 1);
