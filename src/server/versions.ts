import crypto from 'node:crypto';
import type { DB } from './db';
import type { FunnelConfig } from '../shared/types';
import { validateConfig } from '../shared/validateConfig';

export class HttpError extends Error {
  constructor(
    public status: number,
    message: string,
    public details?: unknown,
  ) {
    super(message);
  }
}

export interface VersionRow {
  funnel_id: string;
  version: number;
  config_json: string;
  checksum: string;
  release_note: string | null;
  created_at: string;
}

const now = () => new Date().toISOString();
// Checksum over a key-sorted serialization: the same config with reordered keys is the same version.
const canonical = (v: unknown): unknown =>
  Array.isArray(v)
    ? v.map(canonical)
    : v && typeof v === 'object'
      ? Object.fromEntries(Object.keys(v).sort().map((k) => [k, canonical((v as Record<string, unknown>)[k])]))
      : v;
const checksum = (cfg: unknown) => crypto.createHash('sha256').update(JSON.stringify(canonical(cfg))).digest('hex').slice(0, 16);

// Versions are cached in memory: they are immutable once stored.
const cache = new WeakMap<DB, Map<string, FunnelConfig>>();

export function getConfig(db: DB, funnelId: string, version: number): FunnelConfig | null {
  let m = cache.get(db);
  if (!m) cache.set(db, (m = new Map()));
  const key = `${funnelId}@${version}`;
  const hit = m.get(key);
  if (hit) return hit;
  const row = db
    .prepare('SELECT config_json FROM funnel_versions WHERE funnel_id = ? AND version = ?')
    .get(funnelId, version) as { config_json: string } | undefined;
  if (!row) return null;
  const cfg = JSON.parse(row.config_json) as FunnelConfig;
  m.set(key, cfg);
  return cfg;
}

/** Stores a version (draft). Re-uploading identical content is a no-op; different content under the same number is rejected. */
export function storeVersion(db: DB, raw: unknown): { funnelId: string; version: number; created: boolean } {
  const res = validateConfig(raw);
  if (!res.ok) throw new HttpError(400, 'Invalid funnel config', res.errors);
  const cfg = res.config;
  const json = JSON.stringify(cfg);
  const sum = checksum(cfg);
  const existing = db
    .prepare('SELECT checksum FROM funnel_versions WHERE funnel_id = ? AND version = ?')
    .get(cfg.funnelId, cfg.version) as { checksum: string } | undefined;
  if (existing) {
    if (existing.checksum !== sum)
      throw new HttpError(409, `Version ${cfg.version} already exists with different content. Bump "version".`);
    return { funnelId: cfg.funnelId, version: cfg.version, created: false };
  }
  db.prepare(
    'INSERT INTO funnel_versions (funnel_id, version, config_json, checksum, release_note, created_at) VALUES (?, ?, ?, ?, ?, ?)',
  ).run(cfg.funnelId, cfg.version, json, sum, cfg.releaseNote ?? null, now());
  return { funnelId: cfg.funnelId, version: cfg.version, created: true };
}

export function getActiveVersion(db: DB, funnelId: string): number | null {
  const row = db.prepare('SELECT version FROM funnel_active WHERE funnel_id = ?').get(funnelId) as
    | { version: number }
    | undefined;
  return row?.version ?? null;
}

function setActive(db: DB, funnelId: string, version: number, action: 'publish' | 'rollback') {
  const from = getActiveVersion(db, funnelId);
  db.prepare(
    `INSERT INTO funnel_active (funnel_id, version, updated_at) VALUES (?, ?, ?)
     ON CONFLICT (funnel_id) DO UPDATE SET version = excluded.version, updated_at = excluded.updated_at`,
  ).run(funnelId, version, now());
  db.prepare(
    'INSERT INTO publications (funnel_id, version, from_version, action, created_at) VALUES (?, ?, ?, ?, ?)',
  ).run(funnelId, version, from, action, now());
  return { funnelId, version, previous: from };
}

/** Makes a stored version the one new sessions start on. Existing sessions keep their pinned version. */
export function publish(db: DB, funnelId: string, version: number) {
  if (!getConfig(db, funnelId, version)) throw new HttpError(404, `Version ${version} not found`);
  return db.transaction(() => {
    if (getActiveVersion(db, funnelId) === version) throw new HttpError(409, `Version ${version} is already active`);
    return setActive(db, funnelId, version, 'publish');
  })();
}

/**
 * Rolls back to the version that was active before the current one.
 * Walks the publication log: the target is the `from_version` of the action that made the current version active.
 */
export function rollback(db: DB, funnelId: string) {
  return db.transaction(() => {
    const current = getActiveVersion(db, funnelId);
    if (current === null) throw new HttpError(409, 'Nothing is published');
    const last = db
      .prepare(
        `SELECT from_version FROM publications WHERE funnel_id = ? AND version = ? AND action = 'publish' AND from_version IS NOT NULL
         ORDER BY id DESC LIMIT 1`,
      )
      .get(funnelId, current) as { from_version: number } | undefined;
    if (!last) throw new HttpError(409, 'No previous version to roll back to');
    return setActive(db, funnelId, last.from_version, 'rollback');
  })();
}

export function listVersions(db: DB, funnelId: string) {
  const active = getActiveVersion(db, funnelId);
  const rows = db
    .prepare(
      `SELECT v.version, v.checksum, v.release_note, v.created_at,
              (SELECT COUNT(*) FROM sessions s WHERE s.funnel_id = v.funnel_id AND s.version = v.version) AS sessions
       FROM funnel_versions v WHERE v.funnel_id = ? ORDER BY v.version DESC`,
    )
    .all(funnelId) as { version: number; checksum: string; release_note: string | null; created_at: string; sessions: number }[];
  const log = db
    .prepare('SELECT version, from_version, action, created_at FROM publications WHERE funnel_id = ? ORDER BY id DESC LIMIT 50')
    .all(funnelId);
  return {
    funnelId,
    activeVersion: active,
    versions: rows.map((r) => ({ ...r, active: r.version === active })),
    log,
  };
}

export function listFunnels(db: DB): string[] {
  // Oldest funnel first: uploading another funnel never changes which one "/" serves by default.
  return db
    .prepare('SELECT funnel_id FROM funnel_versions GROUP BY funnel_id ORDER BY MIN(created_at), funnel_id')
    .pluck()
    .all() as string[];
}
