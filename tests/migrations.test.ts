import Database from 'better-sqlite3';
import { migrate } from '../src/server/db';
import { ingestEvents } from '../src/server/events';
import { seedConfigs } from '../src/server/seed';
import { CONFIG_FILES, eid, FUNNEL_ID } from './helpers';

describe('schema migrations', () => {
  it('upgrades a v1-schema database in place and backfills full UTM on old events', () => {
    // A database created by the first release: only migration 1 applied.
    const db = new Database(':memory:');
    db.pragma('foreign_keys = ON');
    migrate(db, 1);
    seedConfigs(db, { files: [CONFIG_FILES[1]] });
    // Rows written by the old release (inserted directly: the events table has no utm_content / utm_term yet).
    const s = 'old-session-1';
    const now = '2026-10-01T00:00:00.000Z';
    db.prepare(
      `INSERT INTO sessions (id, funnel_id, version, experiment_id, variant, variant_source, utm_campaign, utm_content, utm_term,
         state_json, created_at, updated_at, expires_at)
       VALUES (?, ?, 1, 'exp', 'A', 'hash', 'c', 'banner', 'remote', '{"answers":{},"history":["intro"],"rev":0}', ?, ?, '2999-01-01T00:00:00.000Z')`,
    ).run(s, FUNNEL_ID, now, now);
    db.prepare(
      `INSERT INTO events (event_id, session_id, name, funnel_id, funnel_version, experiment_id, variant, utm_campaign, server_ts)
       VALUES ('session_started:old-session-1', ?, 'session_started', ?, 1, 'exp', 'A', 'c', ?)`,
    ).run(s, FUNNEL_ID, now);
    const cols = () => (db.prepare('PRAGMA table_info(events)').all() as { name: string }[]).map((c) => c.name);
    expect(cols()).not.toContain('utm_content');

    migrate(db); // what the new release does on start
    expect(cols()).toEqual(expect.arrayContaining(['utm_content', 'utm_term']));
    const old = db.prepare("SELECT utm_content, utm_term FROM events WHERE name = 'session_started'").get();
    expect(old).toEqual({ utm_content: 'banner', utm_term: 'remote' });

    // New events get the columns directly; analytics data from before the upgrade is untouched.
    ingestEvents(db, [{ event_id: eid(), session_id: s, name: 'step_viewed', step_id: 'intro' }]);
    expect(db.prepare("SELECT utm_content FROM events WHERE name = 'step_viewed'").pluck().get()).toBe('banner');
    expect(db.prepare('SELECT COUNT(*) FROM events').pluck().get()).toBe(2);

    migrate(db); // idempotent
    expect(db.prepare('SELECT COUNT(*) FROM schema_migrations').pluck().get()).toBe(2);
  });
});
