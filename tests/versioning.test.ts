import request from 'supertest';
import { createApp } from '../src/server/app';
import { createSession } from '../src/server/sessions';
import { getActiveVersion, listVersions, publish, rollback, storeVersion } from '../src/server/versions';
import { FUNNEL_ID, loadConfig, setupDb } from './helpers';

describe('storeVersion', () => {
  it('accepts an identical re-upload as a no-op', () => {
    const db = setupDb([1]);
    expect(storeVersion(db, loadConfig(1))).toEqual({ funnelId: FUNNEL_ID, version: 1, created: false });
  });

  it('rejects the same version number with different content (409)', async () => {
    const db = setupDb([1]);
    const changed = loadConfig(1);
    changed.title = 'Something else';
    expect(() => storeVersion(db, changed)).toThrow(expect.objectContaining({ status: 409 }));

    const res = await request(createApp(db)).post('/api/admin/versions').send(changed);
    expect(res.status).toBe(409);
  });

  it('rejects an invalid config with 400 and an error list', async () => {
    const db = setupDb([1]);
    const bad = loadConfig(1) as unknown as Record<string, unknown>;
    bad.version = 9;
    delete bad.defaultResultId;
    (bad.steps as Record<string, { type: string }>).intro.type = 'carousel';

    const res = await request(createApp(db)).post('/api/admin/versions').send(bad);
    expect(res.status).toBe(400);
    expect(res.body.details).toEqual(
      expect.arrayContaining(['steps.intro: unknown type carousel', 'defaultResultId must reference a result']),
    );
    expect(listVersions(db, FUNNEL_ID).versions.map((v) => v.version)).toEqual([1]);
  });

  it('uploads and publishes over HTTP with ?publish=1', async () => {
    const db = setupDb([1]);
    const app = createApp(db);
    const res = await request(app).post('/api/admin/versions?publish=1').send(loadConfig(2));
    expect(res.status).toBe(201);
    expect(res.body.published).toMatchObject({ version: 2, previous: 1 });
    expect(getActiveVersion(db, FUNNEL_ID)).toBe(2);
  });
});

describe('publish and rollback', () => {
  it('seed publishes v1 only', () => {
    const db = setupDb();
    expect(getActiveVersion(db, FUNNEL_ID)).toBe(1);
    expect(createSession(db, { funnelId: FUNNEL_ID }).version).toBe(1);
  });

  it('publishing v2 makes new sessions start on v2; rollback returns to v1', async () => {
    const db = setupDb();
    const app = createApp(db);

    const pub = await request(app).post(`/api/admin/funnels/${FUNNEL_ID}/publish`).send({ version: 2 });
    expect(pub.status).toBe(200);
    expect(pub.body).toMatchObject({ version: 2, previous: 1 });
    const s2 = await request(app).post('/api/sessions').send({ funnelId: FUNNEL_ID });
    expect(s2.body.version).toBe(2);
    expect(s2.body.funnel.sequence).toContain('meeting_hours');

    const rb = await request(app).post(`/api/admin/funnels/${FUNNEL_ID}/rollback`);
    expect(rb.status).toBe(200);
    expect(rb.body).toMatchObject({ version: 1, previous: 2 });
    const s1 = await request(app).post('/api/sessions').send({ funnelId: FUNNEL_ID });
    expect(s1.body.version).toBe(1);
    expect(s1.body.funnel.sequence).not.toContain('meeting_hours');
  });

  it('rolls back step by step v3 -> v2 -> v1 (rollback actions are not rollback targets)', () => {
    const db = setupDb();
    publish(db, FUNNEL_ID, 2);
    publish(db, FUNNEL_ID, 3);

    expect(rollback(db, FUNNEL_ID).version).toBe(2);
    expect(rollback(db, FUNNEL_ID).version).toBe(1);
    expect(getActiveVersion(db, FUNNEL_ID)).toBe(1);
    // v1 was the first publish: nothing before it.
    expect(() => rollback(db, FUNNEL_ID)).toThrow(expect.objectContaining({ status: 409 }));

    const log = listVersions(db, FUNNEL_ID).log as { version: number; action: string }[];
    expect(log.map((l) => `${l.action}:${l.version}`)).toEqual(['rollback:1', 'rollback:2', 'publish:3', 'publish:2', 'publish:1']);
  });

  it('rollback with no history returns 409', async () => {
    const db = setupDb();
    const res = await request(createApp(db)).post(`/api/admin/funnels/${FUNNEL_ID}/rollback`);
    expect(res.status).toBe(409);
  });

  it('rollback of an unpublished funnel returns 409', () => {
    const db = setupDb();
    expect(() => rollback(db, 'nope')).toThrow(expect.objectContaining({ status: 409 }));
  });

  it('publishing the active version is 409, an unknown version is 404', async () => {
    const db = setupDb();
    const app = createApp(db);
    expect((await request(app).post(`/api/admin/funnels/${FUNNEL_ID}/publish`).send({ version: 1 })).status).toBe(409);
    expect((await request(app).post(`/api/admin/funnels/${FUNNEL_ID}/publish`).send({ version: 42 })).status).toBe(404);
  });

  it('validates publish input over HTTP', async () => {
    const db = setupDb([1]);
    const app = createApp(db);
    const noVersion = await request(app).post(`/api/admin/funnels/${FUNNEL_ID}/publish`).send({});
    expect(noVersion.status).toBe(400);
    const draft = await request(app).post('/api/admin/versions?publish=0').send(loadConfig(2));
    expect(draft.body.published).toBeNull();
    expect(getActiveVersion(db, FUNNEL_ID)).toBe(1);
  });
});
