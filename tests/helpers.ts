import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { openDb, type DB } from '../src/server/db';
import { seedConfigs } from '../src/server/seed';
import type { FunnelConfig } from '../src/shared/types';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

export const CONFIG_FILES = {
  1: path.join(root, 'configs/funnel-v1.json'),
  2: path.join(root, 'configs/funnel-v2.json'),
  3: path.join(root, 'configs/iteration-2/funnel-v3.json'),
} as const;

export const FUNNEL_ID = 'workstyle-planner';

export function loadConfig(version: 1 | 2 | 3): FunnelConfig {
  return JSON.parse(fs.readFileSync(CONFIG_FILES[version], 'utf8')) as FunnelConfig;
}

/** In-memory DB with v1 published and v2 (and optionally v3) stored as drafts. */
export function setupDb(versions: (1 | 2 | 3)[] = [1, 2, 3]): DB {
  const db = openDb(':memory:');
  seedConfigs(db, { files: versions.map((v) => CONFIG_FILES[v]) });
  return db;
}

let counter = 0;
/** Unique event id that satisfies the server's event_id format. */
export const eid = (prefix = 'evt') => `${prefix}_${process.pid}_${++counter}_${Math.random().toString(36).slice(2, 8)}`;
