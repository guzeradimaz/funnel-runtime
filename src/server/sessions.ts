import crypto from 'node:crypto';
import type { DB } from './db';
import type { FunnelConfig, FunnelState, ResolvedFunnel } from '../shared/types';
import { initialState, normalizeState, resolveFunnel } from '../shared/engine';
import { getActiveVersion, getConfig, HttpError } from './versions';
import { ingestEvents } from './events';

export const UTM_KEYS = ['utm_source', 'utm_medium', 'utm_campaign', 'utm_content', 'utm_term'] as const;
export type Utm = Partial<Record<(typeof UTM_KEYS)[number], string>>;

export interface SessionRow {
  id: string;
  funnel_id: string;
  version: number;
  experiment_id: string;
  variant: string;
  variant_source: 'hash' | 'override';
  utm_source: string | null;
  utm_medium: string | null;
  utm_campaign: string | null;
  utm_content: string | null;
  utm_term: string | null;
  state_json: string;
  created_at: string;
  updated_at: string;
  expires_at: string;
}

/**
 * Deterministic weighted assignment: the same (session, experiment) always maps to the same variant,
 * so assignment is reproducible even without the stored row.
 */
export function assignVariant(sessionId: string, experimentId: string, variants: Record<string, { weight: number }>) {
  const names = Object.keys(variants).sort();
  const total = names.reduce((s, n) => s + Math.max(0, variants[n].weight), 0);
  const hash = crypto.createHash('sha256').update(`${experimentId}:${sessionId}`).digest();
  const bucket = (hash.readUInt32BE(0) / 0x100000000) * total;
  let acc = 0;
  for (const n of names) {
    acc += Math.max(0, variants[n].weight);
    if (bucket < acc) return n;
  }
  return names[names.length - 1];
}

function cleanUtm(input: unknown): Utm {
  const out: Utm = {};
  if (!input || typeof input !== 'object') return out;
  for (const k of UTM_KEYS) {
    const v = (input as Record<string, unknown>)[k];
    if (typeof v === 'string' && v.trim()) out[k] = v.trim().slice(0, 100);
  }
  return out;
}

export interface SessionView {
  sessionId: string;
  funnelId: string;
  version: number;
  variant: string;
  variantSource: string;
  variants: string[];
  experimentId: string;
  isActiveVersion: boolean;
  expiresAt: string;
  utm: Utm;
  state: FunnelState;
  funnel: ResolvedFunnel;
}

function toView(db: DB, row: SessionRow): SessionView {
  const cfg = getConfig(db, row.funnel_id, row.version)!;
  const funnel = resolveFunnel(cfg, row.variant);
  const utm: Utm = {};
  for (const k of UTM_KEYS) if (row[k]) utm[k] = row[k]!;
  return {
    sessionId: row.id,
    funnelId: row.funnel_id,
    version: row.version,
    variant: row.variant,
    variantSource: row.variant_source,
    variants: Object.keys(cfg.experiment.variants),
    experimentId: row.experiment_id,
    isActiveVersion: getActiveVersion(db, row.funnel_id) === row.version,
    expiresAt: row.expires_at,
    utm,
    state: normalizeState(funnel, JSON.parse(row.state_json)),
    funnel,
  };
}

export function createSession(
  db: DB,
  input: { funnelId: string; utm?: unknown; variantOverride?: unknown; query?: unknown; clientTs?: unknown },
  now = new Date(),
): SessionView {
  const version = getActiveVersion(db, input.funnelId);
  if (version === null) throw new HttpError(404, `Funnel ${input.funnelId} has no published version`);
  const cfg = getConfig(db, input.funnelId, version) as FunnelConfig;
  const id = crypto.randomUUID();
  const variants = cfg.experiment.variants;
  // QA override: the query parameter name comes from the config (experiment.overrideQueryParam).
  const fromQuery =
    input.query && typeof input.query === 'object'
      ? (input.query as Record<string, unknown>)[cfg.experiment.overrideQueryParam]
      : undefined;
  const rawOverride = input.variantOverride ?? fromQuery;
  const override = typeof rawOverride === 'string' ? rawOverride.toUpperCase() : null;
  const [variant, source] =
    override && variants[override] ? [override, 'override' as const] : [assignVariant(id, cfg.experiment.id, variants), 'hash' as const];
  const utm = cleanUtm(input.utm);
  const state = initialState(resolveFunnel(cfg, variant));
  const ts = now.toISOString();
  const clientTs =
    typeof input.clientTs === 'string' && !Number.isNaN(new Date(input.clientTs).getTime()) ? input.clientTs : undefined;
  const expires = new Date(now.getTime() + cfg.session.ttlHours * 3600_000).toISOString();

  db.transaction(() => {
    db.prepare(
      `INSERT INTO sessions (id, funnel_id, version, experiment_id, variant, variant_source,
        utm_source, utm_medium, utm_campaign, utm_content, utm_term, state_json, created_at, updated_at, expires_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      id, cfg.funnelId, version, cfg.experiment.id, variant, source,
      utm.utm_source ?? null, utm.utm_medium ?? null, utm.utm_campaign ?? null, utm.utm_content ?? null, utm.utm_term ?? null,
      JSON.stringify(state), ts, ts, expires,
    );
    // session_started is emitted by the server: it is the source of truth for "sessions created".
    ingestEvents(db, [{ event_id: `session_started:${id}`, session_id: id, name: 'session_started', client_ts: clientTs }], now);
  })();

  return getSession(db, id, now);
}

export function getSessionRow(db: DB, id: string): SessionRow | undefined {
  return db.prepare('SELECT * FROM sessions WHERE id = ?').get(id) as SessionRow | undefined;
}

export function getSession(db: DB, id: string, now = new Date()): SessionView {
  const row = getSessionRow(db, id);
  if (!row) throw new HttpError(404, 'Session not found');
  if (row.expires_at < now.toISOString()) throw new HttpError(410, 'Session expired');
  return toView(db, row);
}

/**
 * Saves navigation state. Uses `rev` as optimistic concurrency: stale writes (older rev, e.g. a delayed request
 * from another tab) are ignored and the server copy is returned.
 */
export function saveState(db: DB, id: string, incoming: unknown, now = new Date()): SessionView {
  const row = getSessionRow(db, id);
  if (!row) throw new HttpError(404, 'Session not found');
  if (row.expires_at < now.toISOString()) throw new HttpError(410, 'Session expired');
  const s = incoming as FunnelState;
  if (!s || typeof s !== 'object' || !Array.isArray(s.history) || typeof s.answers !== 'object' || s.answers === null)
    throw new HttpError(400, 'Invalid state');
  if (!Number.isSafeInteger(s.rev) || s.rev < 0 || s.rev > 1_000_000) throw new HttpError(400, 'Invalid state rev');
  const json = JSON.stringify(s);
  if (json.length > 20_000) throw new HttpError(413, 'State too large');
  const funnel = resolveFunnel(getConfig(db, row.funnel_id, row.version)!, row.variant);
  const current = JSON.parse(row.state_json) as FunnelState;
  if (s.rev > (current.rev ?? 0)) {
    const normalized = normalizeState(funnel, s);
    db.prepare('UPDATE sessions SET state_json = ?, updated_at = ? WHERE id = ?').run(
      JSON.stringify(normalized),
      now.toISOString(),
      id,
    );
  }
  return getSession(db, id, now);
}
