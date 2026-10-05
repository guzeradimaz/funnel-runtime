import { safeGet, safeSet, uuid } from './api';

export interface ClientEvent {
  event_id: string;
  session_id: string;
  name: string;
  step_id: string | null;
  client_ts: string;
  funnel_version: number;
  variant: string;
  utm_source?: string;
  utm_medium?: string;
  utm_campaign?: string;
  properties: Record<string, string | number | boolean>;
}

const QUEUE_KEY = 'funnel:eventQueue';
const BATCH = 50;

/**
 * Durable client-side event queue.
 * - Events get their event_id at creation, so every retry resends the same id and the server deduplicates.
 * - The queue is mirrored to localStorage: events survive refresh / closed tab and are resent on next load.
 * - On page hide the rest of the queue goes out via sendBeacon; it stays queued, and a later resend is harmless.
 */
export class Tracker {
  private queue: ClientEvent[];
  private inflight = false;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private failures = 0;

  constructor(private context: Omit<ClientEvent, 'event_id' | 'name' | 'step_id' | 'client_ts' | 'properties'>) {
    try {
      this.queue = JSON.parse(safeGet(QUEUE_KEY) ?? '[]');
    } catch {
      this.queue = [];
    }
    window.addEventListener('pagehide', this.beacon);
    document.addEventListener('visibilitychange', this.onVisibility);
    if (this.queue.length) this.schedule(0);
  }

  dispose() {
    window.removeEventListener('pagehide', this.beacon);
    document.removeEventListener('visibilitychange', this.onVisibility);
    if (this.timer) clearTimeout(this.timer);
  }

  track(name: string, stepId: string | null, properties: ClientEvent['properties'] = {}) {
    this.queue.push({
      ...this.context,
      event_id: uuid(),
      name,
      step_id: stepId,
      client_ts: new Date().toISOString(),
      properties,
    });
    this.persist();
    this.schedule(400);
  }

  private persist() {
    safeSet(QUEUE_KEY, JSON.stringify(this.queue.slice(-500)));
  }

  private schedule(ms: number) {
    if (this.timer) return;
    this.timer = setTimeout(() => {
      this.timer = null;
      void this.flush();
    }, ms);
  }

  async flush() {
    if (this.inflight || this.queue.length === 0) return;
    this.inflight = true;
    const batch = this.queue.slice(0, BATCH);
    try {
      const ctrl = new AbortController();
      const t = setTimeout(() => ctrl.abort(), 5000);
      const res = await fetch('/api/events', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ events: batch }),
        signal: ctrl.signal,
        keepalive: true,
      }).finally(() => clearTimeout(t));
      // 5xx, 408 (timeout) and 429 (rate limit) are transient: keep the batch and retry with the same event_ids.
      if (res.status >= 500 || res.status === 408 || res.status === 429) throw new Error(`HTTP ${res.status}`);
      // Accepted, duplicate and rejected are all final: a rejected event will not become valid on retry.
      const done = new Set(batch.map((e) => e.event_id));
      if (res.ok) {
        const body = (await res.json()) as { results: { event_id: string; status: string; error?: string }[] };
        for (const r of body.results) if (r.status === 'rejected') console.warn('event rejected', r);
      }
      this.queue = this.queue.filter((e) => !done.has(e.event_id));
      this.persist();
      this.failures = 0;
    } catch {
      // Timeout or network error: keep the batch. Resending the same event_ids is safe.
      this.failures++;
    } finally {
      this.inflight = false;
      if (this.queue.length) this.schedule(this.failures ? Math.min(30_000, 1000 * 2 ** this.failures) : 0);
    }
  }

  private onVisibility = () => {
    if (document.visibilityState === 'hidden') this.beacon();
  };

  private beacon = () => {
    if (!this.queue.length || !navigator.sendBeacon) return;
    const body = JSON.stringify({ events: this.queue.slice(0, BATCH) });
    navigator.sendBeacon('/api/events', new Blob([body], { type: 'text/plain' }));
  };
}
