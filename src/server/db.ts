import Database from 'better-sqlite3';
import fs from 'node:fs';
import path from 'node:path';

export type DB = Database.Database;

// Append-only list. Never edit an applied migration; add a new one instead.
const MIGRATIONS: { id: number; sql: string }[] = [
  {
    id: 1,
    sql: `
      CREATE TABLE funnel_versions (
        funnel_id     TEXT NOT NULL,
        version       INTEGER NOT NULL,
        config_json   TEXT NOT NULL,
        checksum      TEXT NOT NULL,
        release_note  TEXT,
        created_at    TEXT NOT NULL,
        PRIMARY KEY (funnel_id, version)
      );

      -- Which version new sessions start on. One row per funnel.
      CREATE TABLE funnel_active (
        funnel_id   TEXT PRIMARY KEY,
        version     INTEGER NOT NULL,
        updated_at  TEXT NOT NULL
      );

      -- Audit log of publish / rollback actions; rollback walks this log.
      CREATE TABLE publications (
        id            INTEGER PRIMARY KEY AUTOINCREMENT,
        funnel_id     TEXT NOT NULL,
        version       INTEGER NOT NULL,
        from_version  INTEGER,
        action        TEXT NOT NULL CHECK (action IN ('publish', 'rollback')),
        created_at    TEXT NOT NULL
      );

      CREATE TABLE sessions (
        id             TEXT PRIMARY KEY,
        funnel_id      TEXT NOT NULL,
        version        INTEGER NOT NULL,
        experiment_id  TEXT NOT NULL,
        variant        TEXT NOT NULL,
        variant_source TEXT NOT NULL,
        utm_source     TEXT,
        utm_medium     TEXT,
        utm_campaign   TEXT,
        utm_content    TEXT,
        utm_term       TEXT,
        state_json     TEXT NOT NULL,
        created_at     TEXT NOT NULL,
        updated_at     TEXT NOT NULL,
        expires_at     TEXT NOT NULL,
        FOREIGN KEY (funnel_id, version) REFERENCES funnel_versions (funnel_id, version)
      );
      CREATE INDEX sessions_version ON sessions (funnel_id, version, variant);

      -- event_id is the idempotency key: INSERT OR IGNORE makes retries safe.
      CREATE TABLE events (
        event_id         TEXT PRIMARY KEY,
        session_id       TEXT NOT NULL REFERENCES sessions (id),
        name             TEXT NOT NULL,
        funnel_id        TEXT NOT NULL,
        funnel_version   INTEGER NOT NULL,
        experiment_id    TEXT NOT NULL,
        variant          TEXT NOT NULL,
        step_id          TEXT,
        utm_source       TEXT,
        utm_medium       TEXT,
        utm_campaign     TEXT,
        client_ts        TEXT,
        server_ts        TEXT NOT NULL,
        properties_json  TEXT NOT NULL DEFAULT '{}'
      );
      CREATE INDEX events_session ON events (session_id);
      CREATE INDEX events_agg ON events (funnel_id, funnel_version, variant, name);
      CREATE INDEX events_campaign ON events (utm_campaign);
    `,
  },
  {
    // Every event row carries the full UTM set (TASK 4.1). Existing rows are backfilled from their session.
    id: 2,
    sql: `
      ALTER TABLE events ADD COLUMN utm_content TEXT;
      ALTER TABLE events ADD COLUMN utm_term TEXT;
      UPDATE events SET
        utm_content = (SELECT utm_content FROM sessions s WHERE s.id = events.session_id),
        utm_term    = (SELECT utm_term    FROM sessions s WHERE s.id = events.session_id);
    `,
  },
];

export function openDb(file = process.env.DB_PATH ?? path.resolve('data/funnel.db')): DB {
  if (file !== ':memory:') fs.mkdirSync(path.dirname(file), { recursive: true });
  const db = new Database(file);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  db.pragma('busy_timeout = 5000');
  migrate(db);
  return db;
}

/** Applies pending migrations in order. `upTo` exists for tests that simulate an older database. */
export function migrate(db: DB, upTo = Infinity) {
  db.exec('CREATE TABLE IF NOT EXISTS schema_migrations (id INTEGER PRIMARY KEY, applied_at TEXT NOT NULL)');
  const applied = new Set(db.prepare('SELECT id FROM schema_migrations').pluck().all() as number[]);
  for (const m of MIGRATIONS) {
    if (applied.has(m.id) || m.id > upTo) continue;
    db.transaction(() => {
      db.exec(m.sql);
      db.prepare('INSERT INTO schema_migrations (id, applied_at) VALUES (?, ?)').run(m.id, new Date().toISOString());
    })();
  }
}
