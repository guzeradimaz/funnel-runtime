import request from 'supertest';
import { createApp } from '../src/server/app';
import { ingestEvents } from '../src/server/events';
import { createSession } from '../src/server/sessions';
import { eid, FUNNEL_ID, setupDb } from './helpers';

function setup() {
  const db = setupDb();
  const app = createApp(db);
  const s = createSession(db, { funnelId: FUNNEL_ID, variantOverride: 'A' });
  const count = (where = '1=1') =>
    (db.prepare(`SELECT COUNT(*) FROM events WHERE session_id = ? AND ${where}`).pluck().get(s.sessionId) as number);
  return { db, app, sid: s.sessionId, count };
}

describe('deduplication', () => {
  it('the same event_id twice in one batch stores one row', async () => {
    const { app, sid, count } = setup();
    const ev = { event_id: eid(), session_id: sid, name: 'step_viewed', step_id: 'intro' };
    const res = await request(app).post('/api/events').send({ events: [ev, ev] });
    expect(res.body).toMatchObject({ accepted: 1, duplicate: 1, rejected: 0 });
    expect(count("name = 'step_viewed'")).toBe(1);
  });

  it('the same event_id across two requests stores one row', async () => {
    const { app, sid, count } = setup();
    const ev = { event_id: eid(), session_id: sid, name: 'step_viewed', step_id: 'intro' };
    await request(app).post('/api/events').send({ events: [ev] });
    const res = await request(app).post('/api/events').send({ events: [{ ...ev, client_ts: new Date().toISOString() }] });
    expect(res.body.results[0].status).toBe('duplicate');
    expect(count("name = 'step_viewed'")).toBe(1);
  });

  it('resending a whole batch (retry after timeout) reports every event as duplicate', async () => {
    const { app, sid, count } = setup();
    const batch = ['intro', 'team_size', 'work_mode'].map((step_id) => ({
      event_id: eid(),
      session_id: sid,
      name: 'step_viewed',
      step_id,
    }));
    expect((await request(app).post('/api/events').send({ events: batch })).body.accepted).toBe(3);
    const retry = await request(app).post('/api/events').send({ events: batch });
    expect(retry.body).toMatchObject({ accepted: 0, duplicate: 3, rejected: 0 });
    expect(count()).toBe(4); // session_started + 3
  });
});

describe('validation per event', () => {
  it('invalid events do not block valid ones in the same batch', async () => {
    const { app, sid, count } = setup();
    const good1 = eid();
    const good2 = eid();
    const res = await request(app)
      .post('/api/events')
      .send({
        events: [
          { event_id: good1, session_id: sid, name: 'step_viewed', step_id: 'intro' },
          { event_id: 'bad id!', session_id: sid, name: 'step_viewed' },
          { event_id: eid(), session_id: 'no-such-session', name: 'step_viewed' },
          { event_id: eid(), session_id: sid, name: 'made_up_event' },
          { event_id: eid(), session_id: sid, name: 'step_viewed', step_id: 'no_such_step' },
          { event_id: eid(), session_id: sid, name: 'step_viewed', step_id: 'intro', client_ts: 'not a date' },
          null,
          { event_id: good2, session_id: sid, name: 'back_clicked', step_id: 'team_size' },
        ],
      });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ accepted: 2, duplicate: 0, rejected: 6 });
    expect(res.body.results.map((r: { error?: string }) => r.error ?? 'ok')).toEqual([
      'ok',
      'invalid event_id',
      'unknown session',
      'event "made_up_event" is not allowed in version 1',
      'unknown step_id',
      'invalid client_ts',
      'event must be an object',
      'ok',
    ]);
    expect(count("name != 'session_started'")).toBe(2);
  });

  it('drops undeclared properties such as raw answers', () => {
    const { db, sid } = setup();
    const id = eid();
    ingestEvents(db, [
      {
        event_id: id,
        session_id: sid,
        name: 'answer_submitted',
        step_id: 'team_size',
        properties: { answer_kind: 'number', value: 12, answer: 'raw', nested: { a: 1 } },
      },
    ]);
    const row = db.prepare('SELECT properties_json FROM events WHERE event_id = ?').get(id) as { properties_json: string };
    expect(JSON.parse(row.properties_json)).toEqual({ answer_kind: 'number' });
  });

  it('stores client_ts normalized and a server timestamp', () => {
    const { db, sid } = setup();
    const id = eid();
    const now = new Date('2026-05-01T10:00:00Z');
    ingestEvents(db, [{ event_id: id, session_id: sid, name: 'step_viewed', step_id: 'intro', client_ts: '2026-05-01T09:59:58+00:00' }], now);
    expect(db.prepare('SELECT client_ts, server_ts FROM events WHERE event_id = ?').get(id)).toEqual({
      client_ts: '2026-05-01T09:59:58.000Z',
      server_ts: '2026-05-01T10:00:00.000Z',
    });
  });
});

describe('endpoint', () => {
  it('rejects a batch over 200 events with 413 and stores nothing', async () => {
    const { app, sid, count } = setup();
    const events = Array.from({ length: 201 }, () => ({ event_id: eid(), session_id: sid, name: 'step_viewed', step_id: 'intro' }));
    const res = await request(app).post('/api/events').send({ events });
    expect(res.status).toBe(413);
    expect(count()).toBe(1);
  });

  it('accepts exactly 200 events', async () => {
    const { app, sid } = setup();
    const events = Array.from({ length: 200 }, () => ({ event_id: eid(), session_id: sid, name: 'step_viewed', step_id: 'intro' }));
    expect((await request(app).post('/api/events').send({ events })).body.accepted).toBe(200);
  });

  it('accepts a text/plain body (navigator.sendBeacon)', async () => {
    const { app, sid, count } = setup();
    const res = await request(app)
      .post('/api/events')
      .set('Content-Type', 'text/plain;charset=UTF-8')
      .send(JSON.stringify({ events: [{ event_id: eid(), session_id: sid, name: 'step_viewed', step_id: 'intro' }] }));
    expect(res.status).toBe(200);
    expect(res.body.accepted).toBe(1);
    expect(count("name = 'step_viewed'")).toBe(1);
  });

  it('accepts a bare array and rejects non-JSON text with 400', async () => {
    const { app, sid } = setup();
    const arr = await request(app).post('/api/events').send([{ event_id: eid(), session_id: sid, name: 'step_viewed' }]);
    expect(arr.body.accepted).toBe(1);
    const bad = await request(app).post('/api/events').set('Content-Type', 'text/plain').send('not json');
    expect(bad.status).toBe(400);
    const noEvents = await request(app).post('/api/events').send({ foo: 1 });
    expect(noEvents.status).toBe(400);
  });
});

describe('session_started', () => {
  it('is created by the server exactly once per session', async () => {
    const { db, app } = setup();
    const res = await request(app).post('/api/sessions').send({ funnelId: FUNNEL_ID });
    const rows = db.prepare('SELECT event_id, name FROM events WHERE session_id = ?').all(res.body.sessionId);
    expect(rows).toEqual([{ event_id: `session_started:${res.body.sessionId}`, name: 'session_started' }]);

    // A client trying to send it again is a duplicate.
    const [r] = ingestEvents(db, [{ event_id: `session_started:${res.body.sessionId}`, session_id: res.body.sessionId, name: 'session_started' }]);
    expect(r.status).toBe('duplicate');
  });
});
