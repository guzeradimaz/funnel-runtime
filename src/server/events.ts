import type { DB } from './db';
import type { SessionRow } from './sessions';
import { getConfig } from './versions';

export interface IncomingEvent {
  event_id?: unknown;
  session_id?: unknown;
  name?: unknown;
  step_id?: unknown;
  client_ts?: unknown;
  properties?: unknown;
  // Clients may also send funnel_version / variant / utm_*; they are ignored and taken from the session.
  [k: string]: unknown;
}

export type EventResult =
  | { event_id: string | null; status: 'accepted' | 'duplicate' }
  | { event_id: string | null; status: 'rejected'; error: string };

export const MAX_BATCH = 200;
const EVENT_ID_RE = /^[A-Za-z0-9:_-]{8,80}$/;

function primitive(v: unknown): v is string | number | boolean {
  return typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean';
}

/**
 * Validates and stores a batch. Each event is handled independently: one bad event never fails the batch.
 * Idempotency: event_id is the primary key, so a resent event (retry after timeout, duplicate send) is reported
 * as `duplicate` and not stored twice.
 */
export function ingestEvents(db: DB, events: IncomingEvent[], now = new Date()): EventResult[] {
  const serverTs = now.toISOString();
  const insert = db.prepare(
    `INSERT OR IGNORE INTO events (event_id, session_id, name, funnel_id, funnel_version, experiment_id, variant,
       step_id, utm_source, utm_medium, utm_campaign, utm_content, utm_term, client_ts, server_ts, properties_json)
     VALUES (@event_id, @session_id, @name, @funnel_id, @funnel_version, @experiment_id, @variant,
       @step_id, @utm_source, @utm_medium, @utm_campaign, @utm_content, @utm_term, @client_ts, @server_ts, @properties_json)`,
  );
  const getSession = db.prepare('SELECT * FROM sessions WHERE id = ?');
  const sessions = new Map<string, SessionRow | undefined>();

  const handle = (e: IncomingEvent): EventResult => {
    const id = typeof e?.event_id === 'string' ? e.event_id : null;
    const reject = (error: string): EventResult => ({ event_id: id, status: 'rejected', error });
    if (!e || typeof e !== 'object') return reject('event must be an object');
    if (!id || !EVENT_ID_RE.test(id)) return reject('invalid event_id');
    if (typeof e.session_id !== 'string') return reject('session_id is required');
    if (typeof e.name !== 'string') return reject('name is required');

    if (!sessions.has(e.session_id)) sessions.set(e.session_id, getSession.get(e.session_id) as SessionRow | undefined);
    const session = sessions.get(e.session_id);
    if (!session) return reject('unknown session');

    // Schema comes from the version pinned to the session, so old sessions keep their old event contract
    // and events added in a later version (e.g. recommendation_expanded in v3) are only valid there.
    const cfg = getConfig(db, session.funnel_id, session.version)!;
    const spec = cfg.events.allowed.find((x) => x.name === e.name);
    if (!spec) return reject(`event "${e.name}" is not allowed in version ${session.version}`);

    let stepId: string | null = null;
    if (e.step_id !== undefined && e.step_id !== null) {
      // The step must exist in this session's variant (v3 variant B has no tool_count, for example).
      const seq = cfg.experiment.variants[session.variant]?.stepSequence ?? [];
      if (typeof e.step_id !== 'string' || !seq.includes(e.step_id)) return reject('unknown step_id');
      stepId = e.step_id;
    }

    let clientTs: string | null = null;
    if (e.client_ts !== undefined && e.client_ts !== null) {
      const d = new Date(e.client_ts as string);
      if (Number.isNaN(d.getTime())) return reject('invalid client_ts');
      clientTs = d.toISOString();
    }

    // Privacy: keep only properties declared for this event, and only scalar values.
    // Anything else (for example a raw answer) is dropped before it reaches storage.
    const props: Record<string, string | number | boolean> = {};
    const rawProps = e.properties && typeof e.properties === 'object' ? (e.properties as Record<string, unknown>) : {};
    for (const key of spec.properties) {
      const v = rawProps[key];
      if (primitive(v)) props[key] = typeof v === 'string' ? v.slice(0, 120) : v;
    }

    const info = insert.run({
      event_id: id,
      session_id: session.id,
      name: e.name,
      funnel_id: session.funnel_id,
      funnel_version: session.version,
      experiment_id: session.experiment_id,
      variant: session.variant,
      step_id: stepId,
      utm_source: session.utm_source,
      utm_medium: session.utm_medium,
      utm_campaign: session.utm_campaign,
      utm_content: session.utm_content,
      utm_term: session.utm_term,
      client_ts: clientTs,
      server_ts: serverTs,
      properties_json: JSON.stringify(props),
    });
    return { event_id: id, status: info.changes === 1 ? 'accepted' : 'duplicate' };
  };

  return db.transaction(() =>
    events.map((e) => {
      try {
        return handle(e);
      } catch (err) {
        return { event_id: typeof e?.event_id === 'string' ? e.event_id : null, status: 'rejected', error: String(err) } as EventResult;
      }
    }),
  )();
}
