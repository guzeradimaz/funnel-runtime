import crypto from 'node:crypto';
import request from 'supertest';
import { createApp } from '../src/server/app';
import { ingestEvents } from '../src/server/events';
import { assignVariant, createSession } from '../src/server/sessions';
import { eid, FUNNEL_ID, loadConfig, setupDb } from './helpers';

const variants = loadConfig(1).experiment.variants;
const EXP = 'question-order-and-result-framing-v1';

describe('assignVariant', () => {
  it('is deterministic for the same session id', () => {
    const id = crypto.randomUUID();
    const first = assignVariant(id, EXP, variants);
    for (let i = 0; i < 20; i++) expect(assignVariant(id, EXP, variants)).toBe(first);
  });

  it('splits roughly 50/50 over 2000 ids', () => {
    let a = 0;
    for (let i = 0; i < 2000; i++) if (assignVariant(`session-${i}`, EXP, variants) === 'A') a++;
    expect(a / 2000).toBeGreaterThan(0.45);
    expect(a / 2000).toBeLessThan(0.55);
  });

  it('respects weights (0 weight never assigned)', () => {
    for (let i = 0; i < 200; i++) expect(assignVariant(`s${i}`, EXP, { A: { weight: 0 }, B: { weight: 1 } })).toBe('B');
  });
});

describe('variant on a session', () => {
  it('is stable across repeated reads', async () => {
    const db = setupDb();
    const app = createApp(db);
    const created = (await request(app).post('/api/sessions').send({ funnelId: FUNNEL_ID })).body;
    expect(created.variantSource).toBe('hash');
    expect(created.variant).toBe(assignVariant(created.sessionId, created.experimentId, variants));
    for (let i = 0; i < 5; i++) {
      const res = await request(app).get(`/api/sessions/${created.sessionId}`);
      expect(res.body.variant).toBe(created.variant);
      expect(res.body.funnel.variant).toBe(created.variant);
    }
  });

  it('can be overridden via the `variant` body field, case-insensitively', async () => {
    const app = createApp(setupDb());
    for (const v of ['b', 'B', 'a']) {
      const res = (await request(app).post('/api/sessions').send({ funnelId: FUNNEL_ID, variant: v })).body;
      expect(res.variant).toBe(v.toUpperCase());
      expect(res.variantSource).toBe('override');
    }
    const b = (await request(app).post('/api/sessions').send({ funnelId: FUNNEL_ID, variant: 'b' })).body;
    expect(b.funnel.sequence[1]).toBe('work_mode'); // variant B question order
    expect(b.funnel.steps.intro.content.primaryActionLabel).toBe('Show me'); // variant B copy
  });

  it('falls back to hash assignment for an unknown override', () => {
    const db = setupDb();
    const s = createSession(db, { funnelId: FUNNEL_ID, variantOverride: 'Z' });
    expect(s.variantSource).toBe('hash');
    expect(s.variant).toBe(assignVariant(s.sessionId, s.experimentId, variants));
  });
});

describe('event attribution', () => {
  it('stores funnel_version, variant and utm from the session, ignoring client-sent values', () => {
    const db = setupDb();
    const s = createSession(db, { funnelId: FUNNEL_ID, variantOverride: 'A', utm: { utm_campaign: 'spring', utm_source: 'ads' } });
    ingestEvents(db, [
      {
        event_id: eid(),
        session_id: s.sessionId,
        name: 'step_viewed',
        step_id: 'intro',
        funnel_version: 99,
        variant: 'B',
        experiment_id: 'hacked',
        utm_campaign: 'other',
      },
      { event_id: eid(), session_id: s.sessionId, name: 'cta_clicked', variant: 'B' },
    ]);
    const rows = db
      .prepare('SELECT name, funnel_version, variant, experiment_id, utm_campaign, utm_source FROM events WHERE session_id = ?')
      .all(s.sessionId);
    expect(rows).toHaveLength(3); // session_started + 2
    for (const r of rows)
      expect(r).toMatchObject({ funnel_version: 1, variant: 'A', experiment_id: EXP, utm_campaign: 'spring', utm_source: 'ads' });
  });
});
