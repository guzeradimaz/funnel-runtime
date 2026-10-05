// Types for funnel JSON configs (see configs/funnel-v*.json) and runtime state.

export type StepType = 'info' | 'single-select' | 'multi-select' | 'number' | 'result';

export type Operator = 'eq' | 'neq' | 'in' | 'not_in' | 'contains' | 'gt' | 'gte' | 'lt' | 'lte' | 'exists';

export interface LeafCondition {
  answer: string;
  operator: Operator;
  value?: unknown;
}

export type Condition =
  | LeafCondition
  | { all: Condition[] }
  | { any: Condition[] }
  | { not: Condition };

export interface StepContent {
  eyebrow?: string;
  title?: string;
  body?: string;
  helperText?: string;
  primaryActionLabel?: string;
  loadingTitle?: string;
  errorTitle?: string;
  retryLabel?: string;
}

export interface Option {
  value: string;
  label: string;
}

export interface StepInput {
  name: string;
  options?: Option[];
  min?: number;
  max?: number;
  step?: number;
  unit?: string;
}

export interface StepValidation {
  required?: boolean;
  minSelections?: number;
  maxSelections?: number;
  messages?: Record<string, string>;
}

export interface Step {
  id: string;
  type: StepType;
  content: StepContent;
  input?: StepInput;
  validation?: StepValidation;
  visibleWhen?: Condition;
  resultSource?: string;
}

export interface Cta {
  label: string;
  action: string;
}

export interface Result {
  id: string;
  title: string;
  summary: string;
  recommendations: string[];
  cta: Cta;
}

export interface Variant {
  weight: number;
  stepSequence: string[];
  stepOverrides: Record<string, Partial<Step> & { content?: Partial<StepContent> }>;
  resultOverrides: Record<string, Partial<Result>>;
}

export interface EventSpec {
  name: string;
  trigger?: string;
  properties: string[];
}

export interface FunnelConfig {
  schemaVersion: string;
  funnelId: string;
  version: number;
  status?: string;
  locale?: string;
  title: string;
  description?: string;
  releaseNote?: string;
  session: { ttlHours: number; persistAnswers?: boolean; pinVersion?: boolean; pinExperimentVariant?: boolean };
  progress: { countVisibleOnly: boolean; excludeTypes: StepType[] };
  experiment: {
    id: string;
    assignment: 'server';
    sticky: boolean;
    overrideQueryParam: string;
    variants: Record<string, Variant>;
  };
  steps: Record<string, Step>;
  resultRules: { resultId: string; when: Condition }[];
  defaultResultId: string;
  results: Record<string, Result>;
  events: {
    baseProperties: string[];
    allowed: EventSpec[];
    privacy: { storeRawAnswers: boolean; allowAnswerKinds: boolean };
  };
}

/** Config flattened for one variant: overrides applied, other variant stripped. Sent to the client. */
export interface ResolvedFunnel {
  funnelId: string;
  version: number;
  title: string;
  experimentId: string;
  variant: string;
  overrideQueryParam: string;
  sequence: string[];
  steps: Record<string, Step>;
  results: Record<string, Result>;
  resultRules: { resultId: string; when: Condition }[];
  defaultResultId: string;
  progress: FunnelConfig['progress'];
  allowedEvents: EventSpec[];
}

export type AnswerValue = string | number | string[];
export type Answers = Record<string, AnswerValue>;

/** Persisted per session. `history` is the stack of visited step ids; the last one is current. */
export interface FunnelState {
  answers: Answers;
  history: string[];
  rev: number;
  /** Result whose CTA was clicked; a different result after changed answers shows its own CTA again. */
  ctaResultId?: string;
}

export const EVENT_NAMES_CORE = [
  'session_started',
  'step_viewed',
  'answer_submitted',
  'step_completed',
  'back_clicked',
  'result_viewed',
  'cta_clicked',
] as const;
