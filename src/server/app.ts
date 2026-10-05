import express, { type NextFunction, type Request, type Response } from 'express';
import fs from 'node:fs';
import path from 'node:path';
import type { DB } from './db';
import { computeAnalytics } from './analytics';
import { ingestEvents, MAX_BATCH } from './events';
import { createSession, getSession, saveState } from './sessions';
import { getConfig, HttpError, listFunnels, listVersions, publish, rollback, storeVersion } from './versions';

export function createApp(db: DB, opts: { adminToken?: string; staticDir?: string; defaultFunnelId?: string } = {}) {
  const app = express();
  app.disable('x-powered-by');
  app.set('trust proxy', true);
  const defaultFunnel = () => opts.defaultFunnelId ?? listFunnels(db)[0];

  const admin = (req: Request, _res: Response, next: NextFunction) => {
    if (!opts.adminToken) return next();
    const token = req.get('x-admin-token') ?? req.query.token;
    if (token !== opts.adminToken) return next(new HttpError(401, 'Admin token required'));
    next();
  };

  const api = express.Router();
  api.use(express.json({ limit: '1mb' }));

  api.get('/health', (_req, res) => {
    res.json({ ok: true });
  });

  // ----- public funnel runtime -----
  api.post('/sessions', (req, res) => {
    const body = req.body ?? {};
    const view = createSession(db, {
      funnelId: body.funnelId ?? defaultFunnel(),
      utm: body.utm,
      variantOverride: body.variant,
      query: body.query,
      clientTs: body.clientTs,
    });
    res.status(201).json(view);
  });

  api.get('/sessions/:id', (req, res) => {
    res.json(getSession(db, req.params.id));
  });

  api.put('/sessions/:id/state', (req, res) => {
    res.json(saveState(db, req.params.id, req.body?.state));
  });

  // Accepts application/json and text/plain (navigator.sendBeacon on page hide).
  api.post('/events', express.text({ type: 'text/plain', limit: '1mb' }), (req, res) => {
    let body: unknown = req.body;
    if (typeof body === 'string') {
      try {
        body = JSON.parse(body);
      } catch {
        throw new HttpError(400, 'Body must be JSON');
      }
    }
    const events = Array.isArray(body) ? body : (body as { events?: unknown })?.events;
    if (!Array.isArray(events)) throw new HttpError(400, 'Expected { events: [...] }');
    if (events.length > MAX_BATCH) throw new HttpError(413, `Batch limit is ${MAX_BATCH}`);
    const results = ingestEvents(db, events);
    const count = (s: string) => results.filter((r) => r.status === s).length;
    res.json({ accepted: count('accepted'), duplicate: count('duplicate'), rejected: count('rejected'), results });
  });

  // ----- internal: versions -----
  api.get('/admin/funnels', admin, (_req, res) => {
    res.json({ funnels: listFunnels(db) });
  });

  api.get('/admin/funnels/:funnelId/versions', admin, (req, res) => {
    res.json(listVersions(db, req.params.funnelId as string));
  });

  api.get('/admin/funnels/:funnelId/versions/:version', admin, (req, res) => {
    const cfg = getConfig(db, req.params.funnelId as string, Number(req.params.version));
    if (!cfg) throw new HttpError(404, 'Version not found');
    res.json(cfg);
  });

  // Upload a new config (stored as draft). `?publish=1` also activates it.
  api.post('/admin/versions', admin, (req, res) => {
    const stored = storeVersion(db, req.body);
    const published = req.query.publish === '1' ? publish(db, stored.funnelId, stored.version) : null;
    res.status(stored.created ? 201 : 200).json({ ...stored, published });
  });

  api.post('/admin/funnels/:funnelId/publish', admin, (req, res) => {
    const version = Number(req.body?.version);
    if (!Number.isInteger(version) || version < 1) throw new HttpError(400, 'Body must be { "version": <positive integer> }');
    res.json(publish(db, req.params.funnelId as string, version));
  });

  api.post('/admin/funnels/:funnelId/rollback', admin, (req, res) => {
    res.json(rollback(db, req.params.funnelId as string));
  });

  // ----- internal: analytics -----
  api.get('/admin/analytics', admin, (req, res) => {
    const funnelId = (req.query.funnelId as string) || defaultFunnel();
    if (!funnelId) throw new HttpError(404, 'No funnels');
    const version = req.query.version ? Number(req.query.version) : null;
    const campaign = (req.query.campaign as string) || null;
    const includeQa = req.query.includeQa === '1';
    res.json(computeAnalytics(db, { funnelId, version, campaign, includeQa }));
  });

  app.use('/api', api);
  app.use('/api', (_req, res) => {
    res.status(404).json({ error: 'Not found' });
  });

  if (opts.staticDir && fs.existsSync(opts.staticDir)) {
    app.use(express.static(opts.staticDir, { index: false, maxAge: '1h' }));
    const indexHtml = path.join(opts.staticDir, 'index.html');
    app.get(/.*/, (_req, res) => {
      res.sendFile(indexHtml);
    });
  }

  app.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => {
    if (err instanceof HttpError) {
      res.status(err.status).json({ error: err.message, details: err.details });
      return;
    }
    const e = err as { type?: string; status?: number };
    if (e?.type === 'entity.parse.failed') {
      res.status(400).json({ error: 'Malformed JSON' });
      return;
    }
    if (e?.type === 'entity.too.large') {
      res.status(413).json({ error: 'Payload too large' });
      return;
    }
    console.error(err);
    res.status(500).json({ error: 'Internal error' });
  });

  return app;
}
