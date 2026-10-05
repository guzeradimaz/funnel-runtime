// End-to-end scenario for both iterations over the HTTP API of a running server:
//   v1 traffic -> publish v2 -> traffic -> upload+publish v3 (iteration 2) -> old sessions continue -> rollback to v2.
// npm run demo -- [--base http://localhost:3000] [--sessions 120]
import fs from 'node:fs';
import { firstStepId, nextStepId } from '../src/shared/engine';
import { generate, http, snapshot, verify, type Client, type Expected } from './lib/traffic';

function arg(name: string, fallback: string) {
  const i = process.argv.indexOf(`--${name}`);
  return i > 0 ? process.argv[i + 1] : fallback;
}

const c: Client = { base: arg('base', process.env.BASE_URL ?? 'http://localhost:3000'), adminToken: process.env.ADMIN_TOKEN };
const perVersion = Number(arg('sessions', '120'));
const FUNNEL = 'workstyle-planner';
const step = (s: string) => console.log(`\n== ${s}`);
let allOk = true;

async function versions() {
  return http<{ activeVersion: number; versions: { version: number }[] }>(c, 'GET', `/api/admin/funnels/${FUNNEL}/versions`);
}

async function ensureActive(v: number) {
  const info = await versions();
  if (info.activeVersion !== v) await http(c, 'POST', `/api/admin/funnels/${FUNNEL}/publish`, { version: v });
  console.log(`active version: v${v}`);
}

async function run(seed: number) {
  const before = await snapshot(c);
  const { expected } = await generate(c, { sessions: perVersion, seed });
  const after = await snapshot(c);
  allOk = verify(before, after, expected) && allOk;
}

/** Starts sessions and leaves them on the second step, to be continued after the next publish. */
async function startPending(n: number) {
  const out = [];
  for (let i = 0; i < n; i++) {
    const v = await http(c, 'POST', '/api/sessions', { utm: { utm_source: 'demo', utm_campaign: 'pending_users' } });
    const first = firstStepId(v.funnel);
    const second = nextStepId(v.funnel, first, {})!;
    await http(c, 'POST', '/api/events', {
      events: [
        { event_id: `demo-${v.sessionId}-1`, session_id: v.sessionId, name: 'step_viewed', step_id: first, properties: {} },
        { event_id: `demo-${v.sessionId}-2`, session_id: v.sessionId, name: 'step_completed', step_id: first, properties: { next_step_id: second } },
      ],
    });
    await http(c, 'PUT', `/api/sessions/${v.sessionId}/state`, { state: { answers: {}, history: [first, second], rev: 1 } });
    out.push(v.sessionId as string);
  }
  return out;
}

/** Continues pending sessions: re-reads them from the server, checks the pinned version, walks to the result. */
async function finishPending(ids: string[], expectVersion: number) {
  let ok = 0;
  for (const id of ids) {
    const v = await http(c, 'GET', `/api/sessions/${id}`);
    if (v.version !== expectVersion) throw new Error(`session ${id} moved to v${v.version}`);
    const f = v.funnel;
    const answers: Record<string, unknown> = {};
    let cur = v.state.history.at(-1);
    const events = [];
    let n = 3;
    while (f.steps[cur].type !== 'result') {
      const s = f.steps[cur];
      events.push({ event_id: `demo-${id}-${n++}`, session_id: id, name: 'step_viewed', step_id: cur, properties: {} });
      if (s.input) {
        answers[s.input.name] = s.type === 'number' ? s.input.min ?? 1 : s.type === 'multi-select' ? [s.input.options[0].value] : s.input.options[0].value;
      }
      const next = nextStepId(f, cur, answers as never)!;
      events.push({ event_id: `demo-${id}-${n++}`, session_id: id, name: 'step_completed', step_id: cur, properties: { next_step_id: next } });
      cur = next;
    }
    events.push({ event_id: `demo-${id}-${n++}`, session_id: id, name: 'result_viewed', step_id: cur, properties: { result_id: f.defaultResultId } });
    const res = await http(c, 'POST', '/api/events', { events });
    if (res.rejected === 0) ok++;
  }
  console.log(`${ok}/${ids.length} old v${expectVersion} sessions finished on v${expectVersion} without rejected events`);
  allOk &&= ok === ids.length;
}

step('Iteration 1: v1 is live');
await ensureActive(1);
await run(101);
const pendingV1 = await startPending(5);

step('Publish v2 without redeploy');
await ensureActive(2);
const fresh = await http(c, 'POST', '/api/sessions', {});
console.log(`new session starts on v${fresh.version}`);
allOk &&= fresh.version === 2;
await finishPending(pendingV1, 1);
await run(202);
const pendingV2 = await startPending(5);

step('Iteration 2: upload and publish v3 (compliance branch, shorter B, recommendation_expanded)');
const v3 = JSON.parse(fs.readFileSync('configs/iteration-2/funnel-v3.json', 'utf8'));
const up = await http(c, 'POST', '/api/admin/versions?publish=1', v3).catch(async (e) => {
  if (String(e).includes('already active')) return { version: 3, published: null };
  throw e;
});
console.log(`uploaded v${up.version}`);
await ensureActive(3);
await finishPending(pendingV2, 2);
await run(303);
const pendingV3 = await startPending(5);

step('Rollback v3 -> v2');
const rb = await http(c, 'POST', `/api/admin/funnels/${FUNNEL}/rollback`);
console.log(`rolled back v${rb.previous} -> v${rb.version}`);
const afterRb = await http(c, 'POST', '/api/sessions', {});
console.log(`new session after rollback starts on v${afterRb.version}`);
allOk &&= afterRb.version === 2;
await finishPending(pendingV3, 3);

step('Analytics survived publish and rollback');
const snap = await snapshot(c);
for (const [k, e] of [...snap].sort()) console.log(`  v${k.replace('|', ' ')}: ${(e as Expected).started} started`);

console.log(allOk ? '\nDemo OK' : '\nDemo FAILED');
console.log(`Dashboard: ${c.base}/dashboard   Versions: ${c.base}/admin`);
process.exit(allOk ? 0 : 1);
