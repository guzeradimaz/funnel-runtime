// Synthetic traffic over the real HTTP API. Uses the shared engine to walk the funnel like a browser would.
import crypto from 'node:crypto';
import type { AnswerValue, Answers, ResolvedFunnel, Step } from '../../src/shared/types';
import { answerKind, firstStepId, nextStepId, progress, resolveResultId } from '../../src/shared/engine';

export interface Client {
  base: string;
  adminToken?: string;
}

export async function http<T = any>(c: Client, method: string, path: string, body?: unknown): Promise<T> {
  const res = await fetch(c.base + path, {
    method,
    headers: { 'content-type': 'application/json', 'x-admin-token': c.adminToken ?? '' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`${method} ${path} -> ${res.status} ${JSON.stringify(json)}`);
  return json as T;
}

/** Small seeded PRNG (mulberry32) so runs are reproducible with --seed. */
export function rng(seed: number) {
  let a = seed >>> 0;
  const next = () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  return {
    next,
    chance: (p: number) => next() < p,
    pick: <T>(xs: T[]) => xs[Math.floor(next() * xs.length)],
    int: (min: number, max: number) => min + Math.floor(next() * (max - min + 1)),
  };
}
export type Rng = ReturnType<typeof rng>;

export const CAMPAIGNS = [
  { utm_source: 'google', utm_medium: 'cpc', utm_campaign: 'spring_launch', quality: 1.0 },
  { utm_source: 'facebook', utm_medium: 'paid_social', utm_campaign: 'team_health', quality: 0.8 },
  { utm_source: 'newsletter', utm_medium: 'email', utm_campaign: 'october_digest', quality: 1.25 },
  { utm_source: 'linkedin', utm_medium: 'paid_social', utm_campaign: 'hr_leaders', quality: 1.1 },
  { quality: 0.9 }, // direct traffic, no UTM
];

interface Ev {
  event_id: string;
  session_id: string;
  name: string;
  step_id: string | null;
  client_ts: string;
  properties: Record<string, unknown>;
}

export interface SessionPlan {
  sessionId: string;
  version: number;
  variant: string;
  campaign: string;
  reachedResult: boolean;
  cta: boolean;
  furthestStep: string | null;
  events: Ev[];
}

function randomAnswer(r: Rng, step: Step): AnswerValue {
  const opts = step.input?.options?.map((o) => o.value) ?? [];
  if (step.type === 'single-select') return r.pick(opts);
  if (step.type === 'multi-select') {
    const max = step.validation?.maxSelections ?? opts.length;
    const n = r.int(step.validation?.minSelections ?? 1, Math.min(max, 3));
    return [...opts].sort(() => r.next() - 0.5).slice(0, n);
  }
  const { min = 0, max = 10 } = step.input ?? {};
  // Skew numbers toward realistic ranges.
  return Math.min(max, min + Math.floor(r.next() ** 2 * (Math.min(max, min + 40) - min)));
}

/**
 * Simulates one visitor. Drop probability per step depends on campaign quality and variant,
 * so the dashboard shows real differences between segments.
 */
export function simulate(r: Rng, view: { sessionId: string; version: number; variant: string; funnel: ResolvedFunnel }, quality: number, campaign: string, t0: number): SessionPlan {
  const f = view.funnel;
  const events: Ev[] = [];
  let ts = t0;
  const ev = (name: string, step_id: string | null, properties: Record<string, unknown> = {}) => {
    ts += r.int(800, 9000);
    events.push({ event_id: crypto.randomUUID(), session_id: view.sessionId, name, step_id, client_ts: new Date(ts).toISOString(), properties });
  };
  const variantBoost = view.variant === 'B' ? 0.85 : 1; // B loses fewer people per step (the hypothesis)
  const ctaRate = Math.min(0.9, (view.variant === 'B' ? 0.58 : 0.44) * quality);

  const answers: Answers = {};
  const history: string[] = [firstStepId(f)];
  const viewStep = (id: string) => {
    const p = progress(f, id, answers);
    ev('step_viewed', id, { step_type: f.steps[id].type, visible_step_index: p.index, visible_step_count: p.count });
  };

  let furthest: string | null = null;
  const pos = (id: string) => f.sequence.indexOf(id);
  for (let guard = 0; guard < 60; guard++) {
    const id = history[history.length - 1];
    const step = f.steps[id];
    viewStep(id);
    if (!furthest || pos(id) > pos(furthest)) furthest = id;
    if (r.chance(0.06)) viewStep(id); // refresh: repeated view of the same step

    if (step.type === 'result') {
      const resultId = resolveResultId(f, answers);
      ev('result_viewed', id, { result_id: resultId });
      const cta = r.chance(ctaRate);
      if (cta) {
        ev('cta_clicked', id, { result_id: resultId, action: f.results[resultId].cta.action });
        if (f.allowedEvents.some((e) => e.name === 'recommendation_expanded'))
          ev('recommendation_expanded', id, { result_id: resultId, action: f.results[resultId].cta.action, source: 'cta' });
      }
      return { sessionId: view.sessionId, version: view.version, variant: view.variant, campaign, reachedResult: true, cta, furthestStep: id, events };
    }

    const dropP = (step.type === 'info' ? 0.07 : step.type === 'multi-select' ? 0.09 : 0.05) * variantBoost / quality;
    if (r.chance(dropP)) {
      return { sessionId: view.sessionId, version: view.version, variant: view.variant, campaign, reachedResult: false, cta: false, furthestStep: furthest, events };
    }

    // Occasionally go back one step and come forward again.
    if (history.length > 2 && r.chance(0.07)) {
      const dest = history[history.length - 2];
      ev('back_clicked', id, { destination_step_id: dest });
      history.pop();
      continue;
    }

    if (step.input) {
      const value = randomAnswer(r, step);
      answers[step.input.name] = value;
      ev('answer_submitted', id, { answer_kind: answerKind(step, value) });
    }
    const next = nextStepId(f, id, answers)!;
    ev('step_completed', id, { next_step_id: next });
    history.push(next);
  }
  throw new Error('walk did not terminate');
}

export interface SendStats {
  requests: number;
  accepted: number;
  duplicate: number;
  rejected: number;
}

/**
 * Sends a session's events in batches, injecting delivery problems:
 * - out of order: batches sent in shuffled order,
 * - retry after timeout: the same batch sent twice,
 * - duplicate inside a batch,
 * - one malformed event mixed into a valid batch.
 */
export async function deliver(c: Client, r: Rng, plan: SessionPlan, stats: SendStats) {
  const batches: Ev[][] = [];
  for (let i = 0; i < plan.events.length; ) {
    const n = r.int(3, 8);
    batches.push(plan.events.slice(i, i + n));
    i += n;
  }
  if (batches.length > 1 && r.chance(0.15)) batches.reverse(); // out of order
  if (r.chance(0.1) && batches[0]?.length) batches[0] = [...batches[0], batches[0][0]]; // duplicate inside a batch
  const send = async (events: unknown[]) => {
    const res = await http<{ accepted: number; duplicate: number; rejected: number }>(c, 'POST', '/api/events', { events });
    stats.requests++;
    stats.accepted += res.accepted;
    stats.duplicate += res.duplicate;
    stats.rejected += res.rejected;
  };
  for (const b of batches) {
    const withBad = r.chance(0.04) ? [...b, { event_id: 'x', name: 'step_viewed' }] : b;
    await send(withBad);
    if (r.chance(0.1)) await send(b); // client timed out and retried the whole batch
  }
}

export interface Expected {
  started: number;
  reachedResult: number;
  ctaClicked: number;
}

export async function generate(c: Client, opts: { sessions: number; seed: number; overrideShare?: number; log?: (s: string) => void }) {
  const r = rng(opts.seed);
  const log = opts.log ?? console.log;
  const stats: SendStats = { requests: 0, accepted: 0, duplicate: 0, rejected: 0 };
  const expected = new Map<string, Expected>(); // key `${version}|${variant}`
  const plans: SessionPlan[] = [];
  const t0 = Date.now() - 3 * 24 * 3600_000;
  for (let i = 0; i < opts.sessions; i++) {
    const camp = r.pick(CAMPAIGNS);
    const { quality, ...utm } = camp;
    const override = r.chance(opts.overrideShare ?? 0.05) ? r.pick(['A', 'B']) : undefined;
    const view = await http(c, 'POST', '/api/sessions', { utm, variant: override });
    const plan = simulate(r, view, quality, utm.utm_campaign ?? '(none)', t0 + i * 60_000);
    await deliver(c, r, plan, stats);
    plans.push(plan);
    if (view.variantSource === 'override') continue; // QA sessions are excluded from analytics by design
    const k = `${plan.version}|${plan.variant}`;
    const e = expected.get(k) ?? { started: 0, reachedResult: 0, ctaClicked: 0 };
    e.started++;
    if (plan.reachedResult) e.reachedResult++;
    if (plan.cta) e.ctaClicked++;
    expected.set(k, e);
  }
  const qa = plans.length - [...expected.values()].reduce((s, e) => s + e.started, 0);
  log(
    `Generated ${opts.sessions} sessions (${qa} with QA override, excluded from analytics): ${stats.requests} batch requests, ${stats.accepted} accepted, ` +
      `${stats.duplicate} duplicates ignored, ${stats.rejected} malformed rejected`,
  );
  return { expected, plans, stats };
}

type AnalyticsLite = { versions: { version: number; variants: Record<string, Expected> }[] };

export async function snapshot(c: Client): Promise<Map<string, Expected>> {
  const a = await http<AnalyticsLite>(c, 'GET', '/api/admin/analytics');
  const m = new Map<string, Expected>();
  for (const v of a.versions)
    for (const [variant, x] of Object.entries(v.variants))
      m.set(`${v.version}|${variant}`, { started: x.started, reachedResult: x.reachedResult, ctaClicked: x.ctaClicked });
  return m;
}

/** Compares dashboard deltas (after - before) with what the generator knows it sent. */
export function verify(before: Map<string, Expected>, after: Map<string, Expected>, expected: Map<string, Expected>, log = console.log) {
  let ok = true;
  for (const [k, e] of [...expected].sort()) {
    const b = before.get(k) ?? { started: 0, reachedResult: 0, ctaClicked: 0 };
    const a = after.get(k) ?? { started: 0, reachedResult: 0, ctaClicked: 0 };
    const d = { started: a.started - b.started, reachedResult: a.reachedResult - b.reachedResult, ctaClicked: a.ctaClicked - b.ctaClicked };
    const match = d.started === e.started && d.reachedResult === e.reachedResult && d.ctaClicked === e.ctaClicked;
    ok &&= match;
    const [version, variant] = k.split('|');
    log(
      `  v${version} ${variant}: started ${e.started}, result ${e.reachedResult}, cta ${e.ctaClicked}` +
        ` | dashboard delta ${d.started}/${d.reachedResult}/${d.ctaClicked} ${match ? 'OK' : 'MISMATCH'}`,
    );
  }
  return ok;
}
