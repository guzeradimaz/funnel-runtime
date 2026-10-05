// Pure funnel engine shared by the browser, the server, the traffic generator and tests.
import type {
  AnswerValue,
  Answers,
  Condition,
  FunnelConfig,
  FunnelState,
  ResolvedFunnel,
  Result,
  Step,
} from './types';

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

export function deepMerge<T>(base: T, patch: unknown): T {
  if (!isObject(base) || !isObject(patch)) return (patch === undefined ? base : patch) as T;
  const out: Record<string, unknown> = { ...base };
  for (const [k, v] of Object.entries(patch)) {
    out[k] = isObject(v) && isObject(out[k]) ? deepMerge(out[k], v) : v;
  }
  return out as T;
}

export function resolveFunnel(config: FunnelConfig, variant: string): ResolvedFunnel {
  const v = config.experiment.variants[variant];
  if (!v) throw new Error(`Unknown variant ${variant}`);
  const steps: Record<string, Step> = {};
  for (const id of v.stepSequence) {
    steps[id] = deepMerge(config.steps[id], v.stepOverrides?.[id]);
  }
  const results: Record<string, Result> = {};
  for (const [id, r] of Object.entries(config.results)) {
    results[id] = deepMerge(r, v.resultOverrides?.[id]);
  }
  return {
    funnelId: config.funnelId,
    version: config.version,
    title: config.title,
    experimentId: config.experiment.id,
    variant,
    overrideQueryParam: config.experiment.overrideQueryParam,
    sequence: [...v.stepSequence],
    steps,
    results,
    resultRules: config.resultRules,
    defaultResultId: config.defaultResultId,
    progress: config.progress,
    allowedEvents: config.events.allowed,
  };
}

// ---------- conditions ----------

export function evaluate(cond: Condition, answers: Answers): boolean {
  if ('all' in cond) return cond.all.every((c) => evaluate(c, answers));
  if ('any' in cond) return cond.any.some((c) => evaluate(c, answers));
  if ('not' in cond) return !evaluate(cond.not, answers);
  const actual = answers[cond.answer];
  const expected = cond.value;
  // A missing answer never satisfies a condition (except an explicit negative `exists` check).
  if (actual === undefined || actual === null || actual === '') {
    return cond.operator === 'exists' ? expected === false : false;
  }
  switch (cond.operator) {
    case 'exists':
      return expected !== false;
    case 'eq':
      return actual === expected;
    case 'neq':
      return actual !== expected;
    case 'in':
      return Array.isArray(expected) && expected.includes(actual as never);
    case 'not_in':
      return Array.isArray(expected) && !expected.includes(actual as never);
    case 'contains':
      return Array.isArray(actual) && actual.includes(expected as string);
    case 'gt':
      return typeof actual === 'number' && actual > (expected as number);
    case 'gte':
      return typeof actual === 'number' && actual >= (expected as number);
    case 'lt':
      return typeof actual === 'number' && actual < (expected as number);
    case 'lte':
      return typeof actual === 'number' && actual <= (expected as number);
    default:
      return false;
  }
}

// ---------- navigation ----------

export function isVisible(step: Step, answers: Answers): boolean {
  return !step.visibleWhen || evaluate(step.visibleWhen, answers);
}

/** Answers for steps that are currently reachable. Answers on hidden branches are ignored. */
export function effectiveAnswers(f: ResolvedFunnel, answers: Answers): Answers {
  // Iterate in sequence order so a step's visibility is judged only by answers to visible steps.
  const out: Answers = {};
  for (const id of f.sequence) {
    const step = f.steps[id];
    if (!isVisible(step, out)) continue;
    const name = step.input?.name;
    if (name && answers[name] !== undefined) out[name] = answers[name];
  }
  return out;
}

export function visibleSequence(f: ResolvedFunnel, answers: Answers): string[] {
  const eff = effectiveAnswers(f, answers);
  return f.sequence.filter((id) => isVisible(f.steps[id], eff));
}

export function nextStepId(f: ResolvedFunnel, currentId: string, answers: Answers): string | null {
  const eff = effectiveAnswers(f, answers);
  const idx = f.sequence.indexOf(currentId);
  for (let i = idx + 1; i < f.sequence.length; i++) {
    const id = f.sequence[i];
    if (isVisible(f.steps[id], eff)) return id;
  }
  return null;
}

export function firstStepId(f: ResolvedFunnel): string {
  return visibleSequence(f, {})[0];
}

export interface Progress {
  index: number; // 1-based position of the current step among counted steps (0 if current is not counted)
  count: number;
  ratio: number;
}

/** Counts only visible steps that are not excluded by type (info/result by default). */
export function progress(f: ResolvedFunnel, currentId: string, answers: Answers): Progress {
  const counted = visibleSequence(f, answers).filter((id) => !f.progress.excludeTypes.includes(f.steps[id].type));
  const count = counted.length;
  const type = f.steps[currentId]?.type;
  if (type === 'result') return { index: count, count, ratio: 1 };
  // For info steps: number of counted steps already passed.
  const seqIdx = f.sequence.indexOf(currentId);
  const passed = counted.filter((id) => f.sequence.indexOf(id) < seqIdx).length;
  const index = counted.includes(currentId) ? passed + 1 : passed;
  return { index, count, ratio: count === 0 ? 0 : passed / count };
}

export function resolveResultId(f: ResolvedFunnel, answers: Answers): string {
  const eff = effectiveAnswers(f, answers);
  for (const rule of f.resultRules) {
    if (f.results[rule.resultId] && evaluate(rule.when, eff)) return rule.resultId;
  }
  return f.defaultResultId;
}

// ---------- validation ----------

export function validateAnswer(step: Step, value: AnswerValue | undefined): string | null {
  const v = step.validation ?? {};
  const msg = (key: string, fallback: string) => v.messages?.[key] ?? fallback;
  switch (step.type) {
    case 'single-select': {
      if (value === undefined || value === '') return v.required ? msg('required', 'Select an option.') : null;
      const ok = step.input?.options?.some((o) => o.value === value);
      return ok ? null : msg('invalid', 'Select one of the options.');
    }
    case 'multi-select': {
      const arr = Array.isArray(value) ? value : [];
      const allowed = new Set(step.input?.options?.map((o) => o.value));
      if (arr.some((x) => !allowed.has(x))) return msg('invalid', 'Unknown option selected.');
      const min = v.minSelections ?? (v.required ? 1 : 0);
      if (arr.length < min) return msg('minSelections', msg('required', `Choose at least ${min}.`));
      if (v.maxSelections !== undefined && arr.length > v.maxSelections)
        return msg('maxSelections', `Choose no more than ${v.maxSelections}.`);
      return null;
    }
    case 'number': {
      if (value === undefined || value === '' || (typeof value === 'number' && Number.isNaN(value)))
        return v.required ? msg('required', 'Enter a number.') : null;
      if (typeof value !== 'number' || !Number.isFinite(value)) return msg('invalid', 'Enter a number.');
      const { min, max, step: stepSize } = step.input ?? {};
      if (min !== undefined && value < min) return msg('min', `Enter at least ${min}.`);
      if (max !== undefined && value > max) return msg('max', `Enter at most ${max}.`);
      if (stepSize === 1 && !Number.isInteger(value)) return msg('integer', 'Enter a whole number.');
      return null;
    }
    default:
      return null;
  }
}

/** Privacy-safe description of an answer: never the raw value. */
export function answerKind(step: Step, value: AnswerValue): string {
  if (step.type === 'multi-select') return `multi:${Array.isArray(value) ? value.length : 0}`;
  if (step.type === 'number') return 'number';
  return 'single';
}

// ---------- state transitions ----------

export function initialState(f: ResolvedFunnel): FunnelState {
  return { answers: {}, history: [firstStepId(f)], rev: 0 };
}

export function currentStepId(state: FunnelState): string {
  return state.history[state.history.length - 1];
}

/**
 * Repairs a persisted (untrusted) state against the funnel:
 * - keeps only answers that belong to a step of this variant and pass its validation;
 * - keeps the longest history prefix that is a real path: starts at the first step and every next entry is
 *   exactly nextStepId() of the previous one, which requires a valid answer on every interactive step passed.
 */
export function normalizeState(f: ResolvedFunnel, state: FunnelState | null | undefined): FunnelState {
  if (!state || typeof state !== 'object' || !Array.isArray(state.history)) return initialState(f);
  const answers: Answers = {};
  const raw = state.answers && typeof state.answers === 'object' ? state.answers : {};
  for (const id of f.sequence) {
    const step = f.steps[id];
    const name = step.input?.name;
    if (name && raw[name] !== undefined && validateAnswer(step, raw[name]) === null) answers[name] = raw[name];
  }
  const history = [firstStepId(f)];
  for (let i = 1; i < state.history.length; i++) {
    const prev = f.steps[history[history.length - 1]];
    if (prev.input && answers[prev.input.name] === undefined) break;
    const expected = nextStepId(f, prev.id, answers);
    if (!expected || state.history[i] !== expected) break;
    history.push(expected);
  }
  const rev = Number.isSafeInteger(state.rev) && state.rev >= 0 ? state.rev : 0;
  const ctaResultId = typeof state.ctaResultId === 'string' && f.results[state.ctaResultId] ? state.ctaResultId : undefined;
  return { answers, history, rev, ctaResultId };
}
