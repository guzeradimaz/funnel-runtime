import fs from 'node:fs';
import path from 'node:path';
import type { DB } from './db';
import { getActiveVersion, publish, storeVersion } from './versions';

export const CONFIG_DIR = path.resolve('configs');

/**
 * Imports every configs/*.json as a stored (draft) version. Idempotent.
 * On an empty database it also publishes `initialVersion` so the funnel works out of the box.
 */
export function seedConfigs(db: DB, opts: { initialVersion?: number; files?: string[] } = {}) {
  const files =
    opts.files ??
    fs
      .readdirSync(CONFIG_DIR)
      .filter((f) => f.endsWith('.json'))
      .sort()
      .map((f) => path.join(CONFIG_DIR, f));
  const stored = files.map((file) => storeVersion(db, JSON.parse(fs.readFileSync(file, 'utf8'))));
  const initial = opts.initialVersion ?? 1;
  for (const funnelId of new Set(stored.map((s) => s.funnelId))) {
    if (getActiveVersion(db, funnelId) === null && stored.some((s) => s.funnelId === funnelId && s.version === initial))
      publish(db, funnelId, initial);
  }
  return stored;
}
