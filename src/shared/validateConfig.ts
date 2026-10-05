// Structural validation of a funnel config before it can be stored or published.
import type { Condition, FunnelConfig } from './types';

const STEP_TYPES = new Set(['info', 'single-select', 'multi-select', 'number', 'result']);
const OPERATORS = new Set(['eq', 'neq', 'in', 'not_in', 'contains', 'gt', 'gte', 'lt', 'lte', 'exists']);
const REQUIRED_EVENTS = [
  'session_started',
  'step_viewed',
  'answer_submitted',
  'step_completed',
  'back_clicked',
  'result_viewed',
  'cta_clicked',
];

export function validateConfig(raw: unknown): { ok: true; config: FunnelConfig } | { ok: false; errors: string[] } {
  const errors: string[] = [];
  const c = raw as FunnelConfig;
  if (!c || typeof c !== 'object') return { ok: false, errors: ['Config must be an object'] };
  if (typeof c.funnelId !== 'string' || !/^[a-z0-9_-]+$/i.test(c.funnelId)) errors.push('funnelId is required');
  if (!Number.isInteger(c.version) || c.version < 1) errors.push('version must be a positive integer');
  if (!c.steps || typeof c.steps !== 'object') return { ok: false, errors: [...errors, 'steps is required'] };
  if (!c.results || typeof c.results !== 'object') errors.push('results is required');
  if (!c.experiment?.variants || Object.keys(c.experiment.variants).length === 0)
    return { ok: false, errors: [...errors, 'experiment.variants is required'] };
  if (!c.experiment.id) errors.push('experiment.id is required');

  const answerNames = new Set<string>();
  for (const [id, step] of Object.entries(c.steps)) {
    if (step.id !== id) errors.push(`steps.${id}: id mismatch`);
    if (!STEP_TYPES.has(step.type)) errors.push(`steps.${id}: unknown type ${step.type}`);
    if (['single-select', 'multi-select', 'number'].includes(step.type)) {
      if (!step.input?.name) errors.push(`steps.${id}: input.name is required`);
      else answerNames.add(step.input.name);
      if (step.type !== 'number' && !step.input?.options?.length) errors.push(`steps.${id}: options are required`);
    }
  }

  const checkCond = (cond: Condition | undefined, where: string) => {
    if (!cond) return;
    if ('all' in cond) return cond.all.forEach((x, i) => checkCond(x, `${where}.all[${i}]`));
    if ('any' in cond) return cond.any.forEach((x, i) => checkCond(x, `${where}.any[${i}]`));
    if ('not' in cond) return checkCond(cond.not, `${where}.not`);
    if (!answerNames.has(cond.answer)) errors.push(`${where}: unknown answer "${cond.answer}"`);
    if (!OPERATORS.has(cond.operator)) errors.push(`${where}: unknown operator "${cond.operator}"`);
  };

  for (const [id, step] of Object.entries(c.steps)) checkCond(step.visibleWhen, `steps.${id}.visibleWhen`);

  let hasBranch = false;
  for (const [name, v] of Object.entries(c.experiment.variants)) {
    const seq = v.stepSequence ?? [];
    if (seq.length < 6) errors.push(`variant ${name}: at least 6 steps required`);
    if (new Set(seq).size !== seq.length) errors.push(`variant ${name}: duplicate step in sequence`);
    seq.forEach((id) => {
      if (!c.steps[id]) errors.push(`variant ${name}: unknown step "${id}"`);
    });
    const last = c.steps[seq[seq.length - 1]];
    if (last?.type !== 'result') errors.push(`variant ${name}: last step must be a result step`);
    // Branch conditions must only reference answers collected earlier in this variant.
    seq.forEach((id, i) => {
      const cond = c.steps[id]?.visibleWhen;
      if (!cond) return;
      hasBranch = true;
      const earlier = new Set(seq.slice(0, i).map((s) => c.steps[s]?.input?.name));
      for (const ref of condAnswers(cond))
        if (!earlier.has(ref)) errors.push(`variant ${name}: step "${id}" depends on "${ref}" asked later or not at all`);
    });
    for (const id of Object.keys(v.stepOverrides ?? {}))
      if (!seq.includes(id)) errors.push(`variant ${name}: override for step "${id}" not in sequence`);
    for (const id of Object.keys(v.resultOverrides ?? {}))
      if (!c.results?.[id]) errors.push(`variant ${name}: override for unknown result "${id}"`);
  }
  if (!hasBranch) errors.push('at least one conditional step is required');

  for (const [i, rule] of (c.resultRules ?? []).entries()) {
    if (!c.results?.[rule.resultId]) errors.push(`resultRules[${i}]: unknown result "${rule.resultId}"`);
    checkCond(rule.when, `resultRules[${i}].when`);
  }
  if (!c.results?.[c.defaultResultId]) errors.push('defaultResultId must reference a result');

  const eventNames = new Set((c.events?.allowed ?? []).map((e) => e.name));
  for (const e of REQUIRED_EVENTS) if (!eventNames.has(e)) errors.push(`events.allowed must include ${e}`);

  return errors.length ? { ok: false, errors } : { ok: true, config: c };
}

function condAnswers(cond: Condition): string[] {
  if ('all' in cond) return cond.all.flatMap(condAnswers);
  if ('any' in cond) return cond.any.flatMap(condAnswers);
  if ('not' in cond) return condAnswers(cond.not);
  return [cond.answer];
}
