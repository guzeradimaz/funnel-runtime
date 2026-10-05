import type { FunnelState, ResolvedFunnel } from '../shared/types';

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
  utm: Record<string, string>;
  state: FunnelState;
  funnel: ResolvedFunnel;
}

export class ApiError extends Error {
  constructor(
    public status: number,
    message: string,
    public details?: unknown,
  ) {
    super(message);
  }
}

const TOKEN_KEY = 'funnel:adminToken';
export const adminToken = {
  get: () => safeGet(TOKEN_KEY) ?? '',
  set: (v: string) => safeSet(TOKEN_KEY, v),
};

export async function api<T>(path: string, init: RequestInit & { json?: unknown; timeoutMs?: number } = {}): Promise<T> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), init.timeoutMs ?? 10_000);
  const headers: Record<string, string> = { ...(init.headers as Record<string, string>) };
  if (init.json !== undefined) headers['content-type'] = 'application/json';
  if (path.startsWith('/api/admin')) headers['x-admin-token'] = adminToken.get();
  try {
    const res = await fetch(path, {
      ...init,
      headers,
      body: init.json !== undefined ? JSON.stringify(init.json) : init.body,
      signal: ctrl.signal,
    });
    const body = await res.json().catch(() => ({}));
    if (!res.ok) throw new ApiError(res.status, body.error ?? res.statusText, body.details);
    return body as T;
  } finally {
    clearTimeout(timer);
  }
}

export function safeGet(key: string): string | null {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}

export function safeSet(key: string, value: string | null) {
  try {
    if (value === null) localStorage.removeItem(key);
    else localStorage.setItem(key, value);
  } catch {
    /* storage unavailable: state still lives on the server */
  }
}

export function uuid(): string {
  if (typeof crypto.randomUUID === 'function') return crypto.randomUUID();
  const b = crypto.getRandomValues(new Uint8Array(16));
  b[6] = (b[6] & 0x0f) | 0x40;
  b[8] = (b[8] & 0x3f) | 0x80;
  const h = [...b].map((x) => x.toString(16).padStart(2, '0')).join('');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}
