import {
  deepMerge,
  effectiveAnswers,
  evaluate,
  nextStepId,
  normalizeState,
  progress,
  resolveFunnel,
  resolveResultId,
  validateAnswer,
  visibleSequence,
} from '../src/shared/engine';
import type { Answers, Step } from '../src/shared/types';
import { validateConfig } from '../src/shared/validateConfig';
import { loadConfig } from './helpers';

const v1A = resolveFunnel(loadConfig(1), 'A');
const v2A = resolveFunnel(loadConfig(2), 'A');
const v3A = resolveFunnel(loadConfig(3), 'A');

describe('evaluate', () => {
  const answers: Answers = { mode: 'hybrid', n: 10, list: ['a', 'b'] };
  it.each([
    [{ answer: 'mode', operator: 'eq', value: 'hybrid' }, true],
    [{ answer: 'mode', operator: 'neq', value: 'hybrid' }, false],
    [{ answer: 'mode', operator: 'in', value: ['remote', 'hybrid'] }, true],
    [{ answer: 'mode', operator: 'not_in', value: ['remote', 'hybrid'] }, false],
    [{ answer: 'list', operator: 'contains', value: 'b' }, true],
    [{ answer: 'list', operator: 'contains', value: 'z' }, false],
    [{ answer: 'n', operator: 'gt', value: 10 }, false],
    [{ answer: 'n', operator: 'gte', value: 10 }, true],
    [{ answer: 'n', operator: 'lt', value: 11 }, true],
    [{ answer: 'n', operator: 'lte', value: 9 }, false],
    [{ answer: 'n', operator: 'exists' }, true],
    [{ answer: 'missing', operator: 'exists', value: false }, true],
    [{ answer: 'missing', operator: 'neq', value: 'x' }, false], // missing answers never match
    [{ answer: 'missing', operator: 'not_in', value: ['x'] }, false],
    [{ all: [{ answer: 'mode', operator: 'eq', value: 'hybrid' }, { answer: 'n', operator: 'gt', value: 5 }] }, true],
    [{ any: [{ answer: 'mode', operator: 'eq', value: 'remote' }, { answer: 'n', operator: 'gt', value: 50 }] }, false],
    [{ not: { answer: 'mode', operator: 'eq', value: 'remote' } }, true],
  ] as const)('%j -> %s', (cond, expected) => {
    expect(evaluate(cond as never, answers)).toBe(expected);
  });
});

describe('branching', () => {
  it('office_days is hidden for remote and visible for hybrid/office', () => {
    expect(visibleSequence(v1A, { work_mode: 'remote' })).not.toContain('office_days');
    expect(visibleSequence(v1A, { work_mode: 'hybrid' })).toContain('office_days');
    expect(visibleSequence(v1A, { work_mode: 'office' })).toContain('office_days');
    expect(visibleSequence(v1A, {})).not.toContain('office_days');
    expect(nextStepId(v1A, 'timezone_span', { work_mode: 'remote' })).toBe('async_maturity');
    expect(nextStepId(v1A, 'timezone_span', { work_mode: 'hybrid' })).toBe('office_days');
  });

  it('v3 security_constraints appears only when priorities contain compliance', () => {
    expect(visibleSequence(v3A, { priorities: ['speed', 'compliance'] })).toContain('security_constraints');
    expect(visibleSequence(v3A, { priorities: ['speed'] })).not.toContain('security_constraints');
    const v3B = resolveFunnel(loadConfig(3), 'B');
    expect(visibleSequence(v3B, { priorities: ['compliance'] })).toContain('security_constraints');
    expect(v3B.sequence).not.toContain('tool_count'); // screen removed for variant B in v3
  });

  it('effectiveAnswers ignores answers from a hidden branch', () => {
    const answers: Answers = { work_mode: 'remote', office_days: 3, team_size: 5 };
    expect(effectiveAnswers(v1A, answers)).toEqual({ work_mode: 'remote', team_size: 5 });
    expect(effectiveAnswers(v1A, { ...answers, work_mode: 'hybrid' })).toMatchObject({ office_days: 3 });
  });

  it('normalizeState drops history entries for steps that became hidden', () => {
    const state = normalizeState(v1A, {
      answers: { team_size: 8, work_mode: 'remote', office_days: 2 },
      history: ['intro', 'team_size', 'work_mode', 'office_days'],
      rev: 3,
    });
    expect(state.history).toEqual(['intro', 'team_size', 'work_mode']);
    expect(normalizeState(v1A, null).history).toEqual(['intro']);
  });

  it('normalizeState rejects forged paths, invalid answers and unsafe rev', () => {
    // Skipping questions: history must follow nextStepId from the first step.
    expect(normalizeState(v1A, { answers: {}, history: ['intro', 'result'], rev: 1 }).history).toEqual(['intro']);
    // Invalid answer is dropped, so the path stops before the step that needed it.
    const s = normalizeState(v1A, {
      answers: { team_size: 'zzz' as never, work_mode: 'hybrid' },
      history: ['intro', 'team_size', 'work_mode'],
      rev: 1,
    });
    expect(s.answers).toEqual({ work_mode: 'hybrid' });
    expect(s.history).toEqual(['intro', 'team_size']);
    expect(normalizeState(v1A, { answers: {}, history: ['intro'], rev: 1e308 }).rev).toBe(0);
  });
});

describe('progress', () => {
  it('counts only visible non-info/result steps', () => {
    // A: team_size, work_mode, priorities, timezone_span, [office_days], async_maturity, tool_count
    expect(progress(v1A, 'team_size', { work_mode: 'remote' })).toEqual({ index: 1, count: 6, ratio: 0 });
    expect(progress(v1A, 'team_size', { work_mode: 'hybrid' }).count).toBe(7);
    expect(progress(v1A, 'intro', {})).toMatchObject({ index: 0, ratio: 0 });
    expect(progress(v1A, 'tool_count', { work_mode: 'remote' })).toMatchObject({ index: 6, count: 6 });
    expect(progress(v1A, 'result', { work_mode: 'remote' })).toEqual({ index: 6, count: 6, ratio: 1 });
  });
});

describe('resolveResultId', () => {
  it('follows rule order (v1)', () => {
    expect(resolveResultId(v1A, { work_mode: 'remote', timezone_span: 'wide' })).toBe('async_native');
    expect(resolveResultId(v1A, { work_mode: 'hybrid', async_maturity: 'high' })).toBe('async_native');
    expect(resolveResultId(v1A, { work_mode: 'hybrid', async_maturity: 'low' })).toBe('hybrid_structured');
    expect(resolveResultId(v1A, { work_mode: 'office' })).toBe('office_core');
    expect(resolveResultId(v1A, { work_mode: 'remote', timezone_span: 'same' })).toBe('balanced');
  });

  it('v2 meeting_heavy takes precedence over later rules', () => {
    const answers: Answers = { work_mode: 'remote', timezone_span: 'global', async_maturity: 'high', meeting_hours: 15 };
    expect(resolveResultId(v2A, answers)).toBe('meeting_heavy');
    expect(resolveResultId(v2A, { ...answers, meeting_hours: 14 })).toBe('async_native');
  });

  it('v3 regulated_scale needs compliance and strict/regulated constraints', () => {
    expect(resolveResultId(v3A, { priorities: ['compliance'], security_constraints: 'strict', meeting_hours: 30 })).toBe(
      'regulated_scale',
    );
    // Answer on a now-hidden branch does not count.
    expect(resolveResultId(v3A, { priorities: ['speed'], security_constraints: 'strict', work_mode: 'office' })).toBe('office_core');
  });

  it('uses only effective answers (switched to remote after answering office_days)', () => {
    const v2 = loadConfig(2);
    v2.resultRules = [{ resultId: 'office_core', when: { answer: 'office_days', operator: 'gte', value: 3 } }];
    const f = resolveFunnel(v2, 'A');
    expect(resolveResultId(f, { work_mode: 'hybrid', office_days: 4 })).toBe('office_core');
    expect(resolveResultId(f, { work_mode: 'remote', office_days: 4 })).toBe('balanced');
  });
});

describe('validateAnswer', () => {
  const steps = loadConfig(1).steps;
  const num = steps.team_size; // min 1, max 200, step 1, required
  const multi = steps.priorities; // 1..3
  const single = steps.work_mode;

  it('number: required, min, max, integer', () => {
    expect(validateAnswer(num, undefined)).toBe('Enter the team size.');
    expect(validateAnswer(num, Number.NaN)).toBe('Enter the team size.');
    expect(validateAnswer(num, 0)).toBe('The team must have at least one person.');
    expect(validateAnswer(num, 201)).toBe('For this demo, enter a value up to 200.');
    expect(validateAnswer(num, 2.5)).toBe('Enter a whole number.');
    expect(validateAnswer(num, '5')).toBe('Enter a number.');
    expect(validateAnswer(num, 1)).toBeNull();
    expect(validateAnswer(num, 200)).toBeNull();
    const optional: Step = { ...num, validation: {} };
    expect(validateAnswer(optional, undefined)).toBeNull();
  });

  it('multi-select: min/max selections and unknown options', () => {
    expect(validateAnswer(multi, [])).toBe('Choose at least one priority.');
    expect(validateAnswer(multi, ['speed', 'focus', 'culture', 'cost'])).toBe('Choose no more than three priorities.');
    expect(validateAnswer(multi, ['speed', 'nope'])).toBe('Unknown option selected.');
    expect(validateAnswer(multi, ['speed', 'focus', 'culture'])).toBeNull();
  });

  it('single-select: required and option membership', () => {
    expect(validateAnswer(single, undefined)).toBe("Select the team's main work mode.");
    expect(validateAnswer(single, 'mars')).toBe('Select one of the options.');
    expect(validateAnswer(single, 'remote')).toBeNull();
    expect(validateAnswer(steps.intro, undefined)).toBeNull();
  });
});

describe('configs', () => {
  it.each([1, 2, 3] as const)('v%i passes validateConfig', (v) => {
    const res = validateConfig(loadConfig(v));
    expect(res).toEqual({ ok: true, config: expect.anything() });
  });

  it('rejects a branch that depends on an answer asked later', () => {
    const c = loadConfig(1);
    c.experiment.variants.B.stepSequence = ['intro', 'office_days', 'work_mode', 'timezone_span', 'team_size', 'async_maturity', 'priorities', 'tool_count', 'result'];
    const res = validateConfig(c);
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.errors).toContain('variant B: step "office_days" depends on "work_mode" asked later or not at all');
  });

  it('rejects a config without a result step at the end and with unknown operators', () => {
    const c = loadConfig(1);
    c.experiment.variants.A.stepSequence = c.experiment.variants.A.stepSequence.slice(0, -1);
    c.steps.office_days.visibleWhen = { answer: 'work_mode', operator: 'like' as never, value: 'x' };
    const res = validateConfig(c);
    expect(res.ok).toBe(false);
    if (!res.ok)
      expect(res.errors).toEqual(
        expect.arrayContaining(['variant A: last step must be a result step', 'steps.office_days.visibleWhen: unknown operator "like"']),
      );
  });
});

describe('resolveFunnel', () => {
  it('applies variant B overrides and order without touching variant A', () => {
    const cfg = loadConfig(1);
    const b = resolveFunnel(cfg, 'B');
    expect(b.sequence).toEqual(cfg.experiment.variants.B.stepSequence);
    expect(b.steps.intro.content.title).toBe('How should your team really work?');
    expect(b.steps.intro.type).toBe('info'); // deep merge keeps non-overridden fields
    expect(b.steps.priorities.input?.options).toHaveLength(5);
    expect(b.results.async_native.title).toBe('Your team is ready to reduce meetings');
    expect(b.results.async_native.summary).toBe(cfg.results.async_native.summary);
    expect(v1A.steps.intro.content.title).toBe('Build a work model your team can actually follow');
    expect(v1A.results.async_native.title).toBe('Async-native');
    expect(() => resolveFunnel(cfg, 'C')).toThrow();
  });

  it('deepMerge replaces arrays instead of merging them', () => {
    expect(deepMerge({ a: [1, 2], b: { c: 1, d: 2 } }, { a: [3], b: { d: 5 } })).toEqual({ a: [3], b: { c: 1, d: 5 } });
  });
});
