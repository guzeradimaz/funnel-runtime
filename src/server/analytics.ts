import type { DB } from './db';
import { getConfig } from './versions';

/*
 * Aggregation rules (also described in README):
 * - Every metric counts unique sessions, never events. Event rows are already deduplicated by event_id.
 * - Order of arrival and timestamps are not used: a session's progress is the set of steps it reached,
 *   so out-of-order events, repeated views and back navigation do not change the numbers.
 * - Later events imply earlier ones: step_completed / answer_submitted imply step_viewed for that step,
 *   cta_clicked implies result_viewed. This keeps rates <= 100% if an event was lost.
 * - Drop-off: a session that never reached the result is attributed to its furthest step, measured by position
 *   in that session's own step sequence (version + variant), not by the last event received.
 * - Invariant per segment: started = no_step_viewed + sum(drop_off) + reached_result.
 */

export interface Filters {
  funnelId: string;
  version?: number | null;
  campaign?: string | null;
  /** Include QA sessions with a forced variant. Off by default: they are not randomized. */
  includeQa?: boolean;
}

interface SessionAgg {
  version: number;
  variant: string;
  started: boolean;
  viewed: Set<string>;
  completed: Set<string>;
  backClicked: boolean;
  result: boolean;
  resultIds: Set<string>;
  cta: boolean;
  extra: Set<string>; // other event names (e.g. recommendation_expanded)
  transitions: Set<string>; // `${step}>${next_step_id}` from step_completed
}

export interface Rates {
  started: number;
  reachedResult: number;
  ctaClicked: number;
  resultRate: number;
  ctr: number;
  ctaPerStart: number;
}

const ratio = (a: number, b: number) => (b === 0 ? 0 : a / b);

function rates(list: SessionAgg[]): Rates {
  const started = list.filter((s) => s.started).length;
  const reachedResult = list.filter((s) => s.started && s.result).length;
  const ctaClicked = list.filter((s) => s.started && s.cta).length;
  return {
    started,
    reachedResult,
    ctaClicked,
    resultRate: ratio(reachedResult, started),
    ctr: ratio(ctaClicked, reachedResult),
    ctaPerStart: ratio(ctaClicked, started),
  };
}

/** Two-sided two-proportion z-test. */
export function zTest(x1: number, n1: number, x2: number, n2: number) {
  if (n1 === 0 || n2 === 0) return { z: 0, pValue: 1 };
  const p = (x1 + x2) / (n1 + n2);
  const se = Math.sqrt(p * (1 - p) * (1 / n1 + 1 / n2));
  if (se === 0) return { z: 0, pValue: 1 };
  const z = (x2 / n2 - x1 / n1) / se;
  return { z, pValue: 2 * (1 - normCdf(Math.abs(z))) };
}

function normCdf(x: number) {
  // Abramowitz-Stegun 7.1.26 approximation of erf.
  const t = 1 / (1 + 0.3275911 * (x / Math.SQRT2));
  const y = 1 - ((((1.061405429 * t - 1.453152027) * t + 1.421413741) * t - 0.284496736) * t + 0.254829592) * t * Math.exp(-(x * x) / 2);
  return 0.5 * (1 + y);
}

export function computeAnalytics(db: DB, f: Filters) {
  const where = ['funnel_id = @funnelId'];
  if (f.campaign) where.push(f.campaign === '(none)' ? 'utm_campaign IS NULL' : 'utm_campaign = @campaign');
  const rows = db
    .prepare(
      `SELECT e.session_id, e.name, e.funnel_version, e.variant, e.step_id, e.properties_json, s.variant_source
       FROM events e JOIN sessions s ON s.id = e.session_id
       WHERE ${where.map((w) => `e.${w}`).join(' AND ')}`,
    )
    .all({ funnelId: f.funnelId, campaign: f.campaign }) as {
    variant_source: string;
    session_id: string;
    name: string;
    funnel_version: number;
    variant: string;
    step_id: string | null;
    properties_json: string;
  }[];

  const sessions = new Map<string, SessionAgg>();
  // Data-quality counters follow the version filter, like every metric shown next to them.
  const inSelection = (v: number) => !f.version || v === f.version;
  let repeatedViews = 0;
  let selectedEvents = 0;
  const viewCounts = new Map<string, number>();
  // QA sessions with a forced variant (?variant=) are not randomized: they would bias the A/B comparison.
  const qaSessions = new Set<string>();
  for (const r of rows) {
    if (r.variant_source === 'override' && !f.includeQa) {
      if (inSelection(r.funnel_version)) qaSessions.add(r.session_id);
      continue;
    }
    if (inSelection(r.funnel_version)) selectedEvents++;
    let s = sessions.get(r.session_id);
    if (!s) {
      s = {
        version: r.funnel_version,
        variant: r.variant,
        started: false,
        viewed: new Set(),
        completed: new Set(),
        backClicked: false,
        result: false,
        resultIds: new Set(),
        cta: false,
        extra: new Set(),
        transitions: new Set(),
      };
      sessions.set(r.session_id, s);
    }
    switch (r.name) {
      case 'session_started':
        s.started = true;
        break;
      case 'step_viewed': {
        if (r.step_id) s.viewed.add(r.step_id);
        const k = `${r.session_id}|${r.step_id}`;
        const n = (viewCounts.get(k) ?? 0) + 1;
        viewCounts.set(k, n);
        if (n > 1 && inSelection(r.funnel_version)) repeatedViews++;
        break;
      }
      case 'answer_submitted':
        if (r.step_id) s.viewed.add(r.step_id);
        break;
      case 'step_completed':
        if (r.step_id) {
          s.viewed.add(r.step_id);
          s.completed.add(r.step_id);
          const next = (JSON.parse(r.properties_json) as { next_step_id?: string }).next_step_id;
          if (next) s.transitions.add(`${r.step_id}>${next}`);
        }
        break;
      case 'back_clicked':
        s.backClicked = true;
        break;
      case 'result_viewed':
      case 'cta_clicked': {
        s.result = true;
        if (r.name === 'cta_clicked') s.cta = true;
        const rid = (JSON.parse(r.properties_json) as { result_id?: string }).result_id;
        if (rid) s.resultIds.add(rid);
        break;
      }
      default:
        s.extra.add(r.name);
    }
  }

  const all = [...sessions.values()];
  const campaigns = db
    .prepare('SELECT DISTINCT COALESCE(utm_campaign, \'(none)\') FROM sessions WHERE funnel_id = ? ORDER BY 1')
    .pluck()
    .all(f.funnelId) as string[];
  const versionsWithData = [...new Set(all.map((s) => s.version))].sort((a, b) => a - b);

  // Version x variant comparison.
  const versionRows = versionsWithData.map((v) => {
    const inV = all.filter((s) => s.version === v);
    const variants = [...new Set(inV.map((s) => s.variant))].sort();
    return {
      version: v,
      total: rates(inV),
      variants: Object.fromEntries(variants.map((x) => [x, rates(inV.filter((s) => s.variant === x))])),
    };
  });

  // Detailed view for one version (or every version when none is selected).
  const selected = f.version ? all.filter((s) => s.version === f.version) : all;
  const variantNames = [...new Set(selected.map((s) => s.variant))].sort();

  const variants = variantNames.map((variant) => {
    const list = selected.filter((s) => s.variant === variant);
    return {
      variant,
      ...rates(list),
      backClickedSessions: list.filter((s) => s.backClicked).length,
      steps: f.version ? stepFunnel(db, f.funnelId, f.version, variant, list) : null,
      results: countResults(list),
      extraEvents: countExtra(list),
    };
  });

  let abTest = null;
  const a = variants.find((v) => v.variant === 'A');
  const b = variants.find((v) => v.variant === 'B');
  if (a && b) {
    abTest = {
      metric: 'cta_clicked sessions / started sessions',
      a: a.ctaPerStart,
      b: b.ctaPerStart,
      liftAbs: b.ctaPerStart - a.ctaPerStart,
      liftRel: a.ctaPerStart ? b.ctaPerStart / a.ctaPerStart - 1 : null,
      ...zTest(a.ctaClicked, a.started, b.ctaClicked, b.started),
    };
  }

  return {
    filters: f,
    campaigns,
    versionsWithData,
    totals: { ...rates(selected), sessions: selected.length, events: selectedEvents, repeatedViews, qaSessionsExcluded: qaSessions.size },
    variants,
    abTest,
    versions: versionRows,
  };
}

function stepFunnel(db: DB, funnelId: string, version: number, variant: string, list: SessionAgg[]) {
  const cfg = getConfig(db, funnelId, version);
  const seq = cfg?.experiment.variants[variant]?.stepSequence;
  if (!cfg || !seq) return null;
  const started = list.filter((s) => s.started);
  const pos = new Map(seq.map((id, i) => [id, i]));
  const dropAt = new Map<string, number>();
  let noStepViewed = 0;
  for (const s of started) {
    if (s.result) continue;
    let furthest = -1;
    for (const id of s.viewed) furthest = Math.max(furthest, pos.get(id) ?? -1);
    if (furthest < 0) noStepViewed++;
    else dropAt.set(seq[furthest], (dropAt.get(seq[furthest]) ?? 0) + 1);
  }
  const n = started.length;
  const rows = seq.map((id) => {
    const step = cfg.steps[id];
    const isResult = step.type === 'result';
    const viewed = isResult ? started.filter((s) => s.result).length : started.filter((s) => s.viewed.has(id)).length;
    const completed = isResult ? viewed : started.filter((s) => s.completed.has(id)).length;
    const drop = dropAt.get(id) ?? 0;
    // Conversion between steps, split by branch: share of sessions that saw this step and moved on to each next step.
    const nextCounts = new Map<string, number>();
    for (const s of started)
      for (const t of s.transitions) {
        const [from, to] = t.split('>');
        if (from === id) nextCounts.set(to, (nextCounts.get(to) ?? 0) + 1);
      }
    const next = [...nextCounts]
      .sort((a, b) => b[1] - a[1])
      .map(([stepId, sessions]) => ({ stepId, sessions, rate: ratio(sessions, viewed) }));
    return {
      stepId: id,
      type: step.type,
      conditional: Boolean(step.visibleWhen),
      viewed,
      completed,
      reachRate: ratio(viewed, n),
      stepConversion: isResult ? null : ratio(completed, viewed),
      dropOff: drop,
      dropRate: ratio(drop, viewed),
      next,
    };
  });
  return { started: n, noStepViewed, rows };
}

function countResults(list: SessionAgg[]) {
  const out: Record<string, { sessions: number; cta: number }> = {};
  for (const s of list) {
    if (!s.started) continue;
    for (const r of s.resultIds) {
      out[r] ??= { sessions: 0, cta: 0 };
      out[r].sessions++;
      if (s.cta) out[r].cta++;
    }
  }
  return out;
}

function countExtra(list: SessionAgg[]) {
  const out: Record<string, number> = {};
  for (const s of list) for (const e of s.extra) out[e] = (out[e] ?? 0) + 1;
  return out;
}
