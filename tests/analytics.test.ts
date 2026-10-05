import { computeAnalytics, zTest } from '../src/server/analytics';
import type { DB } from '../src/server/db';
import { ingestEvents, type IncomingEvent } from '../src/server/events';
import { createSession } from '../src/server/sessions';
import { publish } from '../src/server/versions';
import { eid, FUNNEL_ID, setupDb } from './helpers';

type Ev = [name: string, stepId?: string, props?: Record<string, unknown>];

/** Script for one session: variant, campaign and its events in the order they arrive at the server. */
interface Script {
  variant: 'A' | 'B';
  campaign?: string;
  events: Ev[];
}

const views = (...steps: string[]): Ev[] => steps.map((s) => ['step_viewed', s]);
const result: Ev = ['result_viewed', 'result', { result_id: 'async_native' }];
const cta: Ev = ['cta_clicked', 'result', { result_id: 'async_native', action: 'expand_recommendation' }];
const A_FULL = ['intro', 'team_size', 'work_mode', 'priorities', 'timezone_span', 'async_maturity', 'tool_count'];

const DATASET: Script[] = [
  // A1: completes and clicks the CTA.
  { variant: 'A', campaign: 'spring', events: [...views(...A_FULL), result, cta] },
  // A2: reaches work_mode (3rd step), goes back to team_size, views it again and quits -> drop at work_mode.
  {
    variant: 'A',
    campaign: 'spring',
    events: [...views('intro', 'team_size', 'work_mode'), ['back_clicked', 'work_mode'], ...views('team_size')],
  },
  // A3: session created, nothing viewed.
  { variant: 'A', events: [] },
  // A4: out of order: step_completed before step_viewed, cta_clicked before result_viewed.
  {
    variant: 'A',
    campaign: 'autumn',
    events: [['step_completed', 'intro'], ['step_viewed', 'intro'], cta, result],
  },
  // A5: repeated views of intro (refreshes), drops at team_size.
  { variant: 'A', events: views('intro', 'intro', 'intro', 'team_size') },
  // B1: sees the result, no CTA.
  { variant: 'B', events: [...views('intro', 'work_mode'), result] },
  // B2: drops at intro.
  { variant: 'B', events: views('intro') },
  // B3: completes and clicks.
  { variant: 'B', events: [...views('intro', 'work_mode'), result, cta] },
];

function toEvents(sid: string, script: Script): IncomingEvent[] {
  return script.events.map(([name, step_id, properties]) => ({ event_id: eid(), session_id: sid, name, step_id, properties }));
}

function load(db: DB, scripts: Script[], order: (evs: IncomingEvent[]) => IncomingEvent[] = (x) => x) {
  const all = scripts.flatMap((s) => {
    // The override pins the variant for a deterministic fixture; the session is then marked as randomized,
    // because analytics excludes QA override sessions (see the dedicated test below).
    const { sessionId } = createSession(db, { funnelId: FUNNEL_ID, variantOverride: s.variant, utm: { utm_campaign: s.campaign } });
    db.prepare("UPDATE sessions SET variant_source = 'hash' WHERE id = ?").run(sessionId);
    return toEvents(sessionId, s);
  });
  const res = ingestEvents(db, order(all));
  expect(res.every((r) => r.status === 'accepted')).toBe(true);
  return all;
}

const byVariant = (a: ReturnType<typeof computeAnalytics>, v: string) => a.variants.find((x) => x.variant === v)!;

describe('computeAnalytics', () => {
  let db: DB;
  let events: IncomingEvent[];
  beforeEach(() => {
    db = setupDb();
    events = load(db, DATASET);
  });

  it('counts unique sessions per variant, result reach and CTR', () => {
    const a = computeAnalytics(db, { funnelId: FUNNEL_ID, version: 1 });
    expect(a.totals).toMatchObject({ started: 8, reachedResult: 4, ctaClicked: 3, sessions: 8, repeatedViews: 3 });
    expect(byVariant(a, 'A')).toMatchObject({ started: 5, reachedResult: 2, ctaClicked: 2, ctr: 1, resultRate: 0.4, ctaPerStart: 0.4 });
    expect(byVariant(a, 'B')).toMatchObject({ started: 3, reachedResult: 2, ctaClicked: 1, ctr: 0.5 });
    expect(byVariant(a, 'A').backClickedSessions).toBe(1);
    expect(byVariant(a, 'A').results).toEqual({ async_native: { sessions: 2, cta: 2 } });
  });

  it('builds the step funnel with drop-off at the furthest step reached', () => {
    const a = computeAnalytics(db, { funnelId: FUNNEL_ID, version: 1 });
    const steps = byVariant(a, 'A').steps!;
    const row = (id: string) => steps.rows.find((r) => r.stepId === id)!;
    expect(steps.started).toBe(5);
    expect(steps.noStepViewed).toBe(1);
    expect(row('intro')).toMatchObject({ viewed: 4, completed: 1, dropOff: 0 });
    // A2 went back from work_mode to team_size: the drop is still attributed to work_mode.
    expect(row('team_size')).toMatchObject({ viewed: 3, dropOff: 1 });
    expect(row('work_mode')).toMatchObject({ viewed: 2, dropOff: 1 });
    expect(row('office_days')).toMatchObject({ viewed: 0, conditional: true });
    expect(row('result')).toMatchObject({ viewed: 2, completed: 2, stepConversion: null });

    const b = byVariant(a, 'B').steps!;
    expect(b.rows.find((r) => r.stepId === 'intro')).toMatchObject({ viewed: 3, dropOff: 1 });
  });

  it('holds started = noStepViewed + sum(dropOff) + reachedResult per variant', () => {
    const a = computeAnalytics(db, { funnelId: FUNNEL_ID, version: 1 });
    for (const v of a.variants) {
      const drops = v.steps!.rows.reduce((s, r) => s + r.dropOff, 0);
      expect(v.steps!.noStepViewed + drops + v.reachedResult).toBe(v.started);
    }
  });

  it('is not inflated by duplicate deliveries or repeated views', () => {
    const before = computeAnalytics(db, { funnelId: FUNNEL_ID, version: 1 });
    // Retry the whole traffic: all duplicates.
    expect(ingestEvents(db, events).every((r) => r.status === 'duplicate')).toBe(true);
    // New step_viewed events (new ids) for steps already seen: repeat views.
    const sids = db.prepare('SELECT DISTINCT session_id FROM events').pluck().all() as string[];
    ingestEvents(db, sids.map((sid) => ({ event_id: eid(), session_id: sid, name: 'step_viewed', step_id: 'intro' })));
    const after = computeAnalytics(db, { funnelId: FUNNEL_ID, version: 1 });

    // A3 never viewed a step before; now it viewed intro, so it moves from noStepViewed to drop at intro.
    const strip = (x: typeof before) => x.variants.map((v) => ({ ...v, steps: null }));
    expect(strip(after)).toEqual(strip(before));
    expect(byVariant(after, 'A').steps!.rows.find((r) => r.stepId === 'intro')!.viewed).toBe(5);
    expect(byVariant(after, 'A').steps!.rows.find((r) => r.stepId === 'team_size')!.viewed).toBe(3);
  });

  it('gives the same numbers when events arrive in reverse order', () => {
    const reversed = setupDb();
    load(reversed, DATASET, (evs) => [...evs].reverse());
    const pick = (x: ReturnType<typeof computeAnalytics>) => ({ variants: x.variants, versions: x.versions, abTest: x.abTest });
    expect(pick(computeAnalytics(reversed, { funnelId: FUNNEL_ID, version: 1 }))).toEqual(
      pick(computeAnalytics(db, { funnelId: FUNNEL_ID, version: 1 })),
    );
  });

  it('filters by utm campaign', () => {
    const spring = computeAnalytics(db, { funnelId: FUNNEL_ID, version: 1, campaign: 'spring' });
    expect(spring.totals).toMatchObject({ started: 2, reachedResult: 1, ctaClicked: 1 });
    expect(spring.variants.map((v) => v.variant)).toEqual(['A']);

    const none = computeAnalytics(db, { funnelId: FUNNEL_ID, version: 1, campaign: '(none)' });
    expect(none.totals).toMatchObject({ started: 5, reachedResult: 2, ctaClicked: 1 });
    expect(spring.campaigns).toEqual(['(none)', 'autumn', 'spring']);
  });

  it('compares versions', () => {
    publish(db, FUNNEL_ID, 2);
    load(db, [
      { variant: 'A', events: [...views('intro', 'meeting_hours'), result, cta] },
      { variant: 'B', events: [] },
    ]);
    const a = computeAnalytics(db, { funnelId: FUNNEL_ID });
    expect(a.versionsWithData).toEqual([1, 2]);
    expect(a.versions).toHaveLength(2);
    expect(a.versions[0]).toMatchObject({ version: 1, total: { started: 8, reachedResult: 4, ctaClicked: 3 } });
    expect(a.versions[1].total).toMatchObject({ started: 2, reachedResult: 1, ctaClicked: 1 });
    expect(a.versions[1].variants.A).toMatchObject({ started: 1, ctaClicked: 1 });
    expect(a.versions[1].variants.B).toMatchObject({ started: 1, ctaClicked: 0 });
    // No version selected: step funnels are not mixed across versions.
    expect(a.variants.every((v) => v.steps === null)).toBe(true);

    const only2 = computeAnalytics(db, { funnelId: FUNNEL_ID, version: 2 });
    expect(only2.totals.started).toBe(2);
  });

  it('reports the A/B test on cta per started session', () => {
    const a = computeAnalytics(db, { funnelId: FUNNEL_ID, version: 1 });
    expect(a.abTest).toMatchObject({ a: 2 / 5, b: 1 / 3 });
    expect(a.abTest!.liftAbs).toBeCloseTo(1 / 3 - 2 / 5);
  });
});

describe('zTest', () => {
  it('gives p ~ 1 for equal proportions', () => {
    expect(zTest(10, 100, 10, 100).pValue).toBeCloseTo(1, 5);
    expect(zTest(0, 0, 1, 1)).toEqual({ z: 0, pValue: 1 });
    expect(zTest(0, 50, 0, 50)).toEqual({ z: 0, pValue: 1 });
  });

  it('gives a small p for a large difference, z positive when B is higher', () => {
    const r = zTest(50, 100, 80, 100);
    expect(r.z).toBeCloseTo(4.447, 2);
    expect(r.pValue).toBeLessThan(0.001);
    expect(zTest(40, 100, 50, 100).pValue).toBeGreaterThan(0.1);
  });

  it('excludes QA override sessions from all metrics', () => {
    const db = setupDb([1]);
    const qa = createSession(db, { funnelId: FUNNEL_ID, variantOverride: 'B' });
    const real = createSession(db, { funnelId: FUNNEL_ID });
    const a = computeAnalytics(db, { funnelId: FUNNEL_ID, version: 1 });
    expect(qa.variantSource).toBe('override');
    expect(real.variantSource).toBe('hash');
    expect(a.totals.started).toBe(1);
    expect(a.totals.qaSessionsExcluded).toBe(1);
  });

  it('can include QA sessions on request', () => {
    const db = setupDb([1]);
    createSession(db, { funnelId: FUNNEL_ID, variantOverride: 'B' });
    const a = computeAnalytics(db, { funnelId: FUNNEL_ID, version: 1, includeQa: true });
    expect(a.totals.started).toBe(1);
    expect(a.totals.qaSessionsExcluded).toBe(0);
  });

  it('scopes data-quality counters to the selected version', () => {
    const db = setupDb([1, 2]);
    const s1 = createSession(db, { funnelId: FUNNEL_ID });
    publish(db, FUNNEL_ID, 2);
    createSession(db, { funnelId: FUNNEL_ID });
    ingestEvents(db, [
      { event_id: eid(), session_id: s1.sessionId, name: 'step_viewed', step_id: 'intro' },
      { event_id: eid(), session_id: s1.sessionId, name: 'step_viewed', step_id: 'intro' },
    ]);
    const v1 = computeAnalytics(db, { funnelId: FUNNEL_ID, version: 1 });
    const v2 = computeAnalytics(db, { funnelId: FUNNEL_ID, version: 2 });
    expect(v1.totals.events).toBe(3); // session_started + 2 views
    expect(v1.totals.repeatedViews).toBe(1);
    expect(v2.totals.events).toBe(1);
    expect(v2.totals.repeatedViews).toBe(0);
  });

  it('splits conversion between steps by branch', () => {
    const db = setupDb([1]);
    const mk = (next: string) => {
      const s = createSession(db, { funnelId: FUNNEL_ID, variantOverride: 'A' });
      db.prepare("UPDATE sessions SET variant_source = 'hash' WHERE id = ?").run(s.sessionId);
      ingestEvents(db, [
        { event_id: eid(), session_id: s.sessionId, name: 'step_viewed', step_id: 'timezone_span' },
        { event_id: eid(), session_id: s.sessionId, name: 'step_completed', step_id: 'timezone_span', properties: { next_step_id: next } },
      ]);
    };
    mk('office_days');
    mk('office_days');
    mk('async_maturity');
    const row = computeAnalytics(db, { funnelId: FUNNEL_ID, version: 1 })
      .variants[0].steps!.rows.find((r) => r.stepId === 'timezone_span')!;
    expect(row.stepConversion).toBe(1);
    expect(row.next).toEqual([
      { stepId: 'office_days', sessions: 2, rate: 2 / 3 },
      { stepId: 'async_maturity', sessions: 1, rate: 1 / 3 },
    ]);
  });
});
