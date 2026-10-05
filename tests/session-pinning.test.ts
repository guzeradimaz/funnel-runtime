import request from 'supertest';
import { createApp } from '../src/server/app';
import { ingestEvents } from '../src/server/events';
import { createSession, getSession, saveState } from '../src/server/sessions';
import { publish, rollback } from '../src/server/versions';
import { eid, FUNNEL_ID, setupDb } from './helpers';

describe('session version pinning', () => {
  it('a v1 session stays on v1 after v2 is published; new sessions use v2', async () => {
    const db = setupDb();
    const app = createApp(db);
    const old = (await request(app).post('/api/sessions').send({ funnelId: FUNNEL_ID })).body;
    expect(old.version).toBe(1);

    publish(db, FUNNEL_ID, 2);

    const reopened = await request(app).get(`/api/sessions/${old.sessionId}`);
    expect(reopened.status).toBe(200);
    expect(reopened.body.version).toBe(1);
    expect(reopened.body.isActiveVersion).toBe(false);
    expect(reopened.body.variant).toBe(old.variant);
    expect(reopened.body.funnel.version).toBe(1);
    expect(reopened.body.funnel.sequence).not.toContain('meeting_hours');

    const fresh = (await request(app).post('/api/sessions').send({ funnelId: FUNNEL_ID })).body;
    expect(fresh.version).toBe(2);
    expect(fresh.funnel.sequence).toContain('meeting_hours');
  });

  it('a v2 session keeps working after rollback to v1', async () => {
    const db = setupDb();
    const app = createApp(db);
    publish(db, FUNNEL_ID, 2);
    const s = createSession(db, { funnelId: FUNNEL_ID, variantOverride: 'A' });
    rollback(db, FUNNEL_ID);

    const res = await request(app).get(`/api/sessions/${s.sessionId}`);
    expect(res.body.version).toBe(2);
    expect(res.body.funnel.steps.meeting_hours).toBeDefined();

    const ev = await request(app)
      .post('/api/events')
      .send({ events: [{ event_id: eid(), session_id: s.sessionId, name: 'step_viewed', step_id: 'meeting_hours' }] });
    expect(ev.body.accepted).toBe(1);
  });

  it('events for an old v1 session are still accepted after publish, and stored as v1', () => {
    const db = setupDb();
    const s = createSession(db, { funnelId: FUNNEL_ID });
    publish(db, FUNNEL_ID, 2);
    publish(db, FUNNEL_ID, 3);
    const id = eid();
    const [r] = ingestEvents(db, [{ event_id: id, session_id: s.sessionId, name: 'step_viewed', step_id: 'work_mode' }]);
    expect(r.status).toBe('accepted');
    const row = db.prepare('SELECT funnel_version FROM events WHERE event_id = ?').get(id) as { funnel_version: number };
    expect(row.funnel_version).toBe(1);
  });

  it('a step that exists only in a newer version is rejected for an old session', () => {
    const db = setupDb();
    const s = createSession(db, { funnelId: FUNNEL_ID });
    publish(db, FUNNEL_ID, 2);
    const [r] = ingestEvents(db, [{ event_id: eid(), session_id: s.sessionId, name: 'step_viewed', step_id: 'meeting_hours' }]);
    expect(r).toMatchObject({ status: 'rejected', error: 'unknown step_id' });
  });

  it('recommendation_expanded (v3-only) is rejected for a v2 session and accepted for a v3 session', () => {
    const db = setupDb();
    publish(db, FUNNEL_ID, 2);
    const v2 = createSession(db, { funnelId: FUNNEL_ID });
    publish(db, FUNNEL_ID, 3);
    const v3 = createSession(db, { funnelId: FUNNEL_ID });
    expect(v3.version).toBe(3);

    const [r2, r3] = ingestEvents(db, [
      { event_id: eid(), session_id: v2.sessionId, name: 'recommendation_expanded', properties: { result_id: 'balanced' } },
      { event_id: eid(), session_id: v3.sessionId, name: 'recommendation_expanded', properties: { result_id: 'balanced' } },
    ]);
    expect(r2.status).toBe('rejected');
    expect(r3.status).toBe('accepted');
  });
});

describe('session state', () => {
  it('saves state with a higher rev and ignores a stale rev', async () => {
    const db = setupDb();
    const app = createApp(db);
    const s = createSession(db, { funnelId: FUNNEL_ID, variantOverride: 'A' });
    expect(s.state).toEqual({ answers: {}, history: ['intro'], rev: 0 });

    const next = { answers: { team_size: 8 }, history: ['intro', 'team_size', 'work_mode'], rev: 2 };
    const saved = await request(app).put(`/api/sessions/${s.sessionId}/state`).send({ state: next });
    expect(saved.status).toBe(200);
    expect(saved.body.state).toMatchObject(next);

    const stale = { answers: {}, history: ['intro'], rev: 1 };
    const res = await request(app).put(`/api/sessions/${s.sessionId}/state`).send({ state: stale });
    expect(res.body.state).toMatchObject(next);

    // Refresh restores the server copy.
    expect((await request(app).get(`/api/sessions/${s.sessionId}`)).body.state).toMatchObject(next);
  });

  it('rejects malformed state with 400', async () => {
    const db = setupDb();
    const s = createSession(db, { funnelId: FUNNEL_ID });
    const res = await request(createApp(db)).put(`/api/sessions/${s.sessionId}/state`).send({ state: { history: 'x' } });
    expect(res.status).toBe(400);
  });

  it('an expired session returns 410', async () => {
    const db = setupDb();
    const created = new Date('2020-01-01T00:00:00Z');
    const s = createSession(db, { funnelId: FUNNEL_ID }, created);
    const ttl = 72 * 3600_000;

    expect(getSession(db, s.sessionId, new Date(created.getTime() + ttl - 1000)).sessionId).toBe(s.sessionId);
    expect(() => getSession(db, s.sessionId, new Date(created.getTime() + ttl + 1000))).toThrow(
      expect.objectContaining({ status: 410 }),
    );
    expect(() => saveState(db, s.sessionId, { answers: {}, history: ['intro'], rev: 1 }, new Date(created.getTime() + ttl + 1000))).toThrow(
      expect.objectContaining({ status: 410 }),
    );
    // Created in 2020: the real clock is long past expiry, so the HTTP endpoint sees it as expired too.
    expect((await request(createApp(db)).get(`/api/sessions/${s.sessionId}`)).status).toBe(410);
  });

  it('an unknown session returns 404', async () => {
    const db = setupDb();
    expect((await request(createApp(db)).get('/api/sessions/does-not-exist')).status).toBe(404);
  });
});
