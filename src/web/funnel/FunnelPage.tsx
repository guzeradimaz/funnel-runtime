import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { AnswerValue, FunnelState, ResolvedFunnel, Step } from '../../shared/types';
import {
  answerKind,
  currentStepId,
  nextStepId,
  normalizeState,
  progress as computeProgress,
  resolveResultId,
  validateAnswer,
} from '../../shared/engine';
import { api, ApiError, safeGet, safeSet, type SessionView } from '../api';
import { Tracker } from '../tracker';
import { StepView } from './StepView';
import { ResultView } from './ResultView';

const SESSION_KEY = 'funnel:sessionId';
const stateKey = (sid: string) => `funnel:state:${sid}`;
const UTM = ['utm_source', 'utm_medium', 'utm_campaign', 'utm_content', 'utm_term'];

// One boot per page load: StrictMode runs effects twice in dev and must not create two sessions.
let bootPromise: Promise<SessionView> | null = null;
function bootSessionOnce(fresh = false) {
  if (fresh) safeSet(SESSION_KEY, null);
  if (fresh || !bootPromise) bootPromise = bootSession().catch((e) => {
    bootPromise = null;
    throw e;
  });
  return bootPromise;
}

async function bootSession(): Promise<SessionView> {
  const params = new URLSearchParams(location.search);
  const stored = safeGet(SESSION_KEY);
  if (stored) {
    try {
      const view = await api<SessionView>(`/api/sessions/${stored}`);
      // A valid QA override that disagrees with the pinned variant starts a fresh session instead of mutating this one.
      // Unknown override values are ignored, as the server ignores them.
      const override = params.get(view.funnel.overrideQueryParam)?.toUpperCase();
      if (!override || !view.variants.includes(override) || override === view.variant) return view;
    } catch (e) {
      if (!(e instanceof ApiError) || (e.status !== 404 && e.status !== 410)) throw e;
    }
  }
  const utm: Record<string, string> = {};
  for (const k of UTM) {
    const v = params.get(k);
    if (v) utm[k] = v;
  }
  const view = await api<SessionView>('/api/sessions', {
    method: 'POST',
    json: { utm, query: Object.fromEntries(params), clientTs: new Date().toISOString() },
  });
  safeSet(SESSION_KEY, view.sessionId);
  return view;
}

/** Picks the newer of server state and the local mirror (a write may not have reached the server before refresh). */
function pickState(view: SessionView): { state: FunnelState; pushLocal: boolean } {
  try {
    const local = JSON.parse(safeGet(stateKey(view.sessionId)) ?? 'null') as FunnelState | null;
    if (local && local.rev > view.state.rev) return { state: normalizeState(view.funnel, local), pushLocal: true };
  } catch {
    /* ignore corrupt mirror */
  }
  return { state: view.state, pushLocal: false };
}

/**
 * Makes sure the browser has one history entry per funnel step, so Back works after a restore
 * (e.g. the link was reopened in a new tab). On a plain reload the entries already exist.
 */
function syncBrowserHistory(depth: number) {
  if ((window.history.state as { depth?: number } | null)?.depth === depth) return;
  window.history.replaceState({ depth: 0 }, '');
  for (let d = 1; d <= depth; d++) window.history.pushState({ depth: d }, '');
}

export function FunnelPage() {
  const [view, setView] = useState<SessionView | null>(null);
  const [state, setState] = useState<FunnelState | null>(null);
  const [error, setError] = useState<string | null>(null);
  const tracker = useRef<Tracker | null>(null);
  const saveTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const start = useCallback(async (fresh = false) => {
    setError(null);
    try {
      const v = await bootSessionOnce(fresh);
      const { state: s, pushLocal } = pickState(v);
      tracker.current?.dispose();
      tracker.current = new Tracker({
        session_id: v.sessionId,
        funnel_version: v.version,
        variant: v.variant,
        ...v.utm,
      });
      setView(v);
      setState(s);
      if (pushLocal) void persistRemote(v.sessionId, s);
      syncBrowserHistory(s.history.length - 1);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }, []);

  useEffect(() => {
    void start();
    return () => tracker.current?.dispose();
  }, [start]);

  const persistRemote = async (sid: string, s: FunnelState) => {
    try {
      await api(`/api/sessions/${sid}/state`, { method: 'PUT', json: { state: s } });
    } catch {
      /* local mirror keeps the state; the next save or reload pushes it */
    }
  };

  const commit = useCallback(
    (next: FunnelState) => {
      if (!view) return;
      const s = { ...next, rev: next.rev + 1 };
      setState(s);
      safeSet(stateKey(view.sessionId), JSON.stringify(s));
      if (saveTimer.current) clearTimeout(saveTimer.current);
      saveTimer.current = setTimeout(() => void persistRemote(view.sessionId, s), 150);
    },
    [view],
  );

  const stateRef = useRef<FunnelState | null>(null);
  stateRef.current = state;

  const goBack = useCallback((toDepth: number) => {
    const s = stateRef.current;
    if (!view || !s || s.history.length < 2) return;
    const from = currentStepId(s);
    const history = s.history.slice(0, Math.max(1, toDepth + 1));
    tracker.current?.track('back_clicked', from, { destination_step_id: history[history.length - 1] });
    commit({ ...s, history });
  }, [view, commit]);

  // Every Back (in-app button or browser button) goes through popstate, so the funnel and browser history stay in step.
  // Forward pushes one entry per step; browser-forward (higher depth) is ignored: the next step needs a validated answer.
  useEffect(() => {
    const onPop = (e: PopStateEvent) => {
      const s = stateRef.current;
      if (!s) return;
      const depth = (e.state as { depth?: number } | null)?.depth ?? 0;
      const current = s.history.length - 1;
      if (depth < current) goBack(depth);
      // Browser-forward: return to the entry that matches the current step, so later Back presses still work.
      else if (depth > current) window.history.go(current - depth);
    };
    window.addEventListener('popstate', onPop);
    return () => window.removeEventListener('popstate', onPop);
  }, [goBack]);

  if (error)
    return (
      <div className="funnel-shell">
        <div className="card">
          <h1>Something went wrong</h1>
          <p className="muted">{error}</p>
          <button className="btn primary" onClick={() => void start()}>
            Try again
          </button>
        </div>
      </div>
    );
  if (!view || !state) return <div className="funnel-shell"><div className="loader" aria-label="Loading" /></div>;

  return (
    <FunnelRunner
      key={view.sessionId}
      view={view}
      state={state}
      tracker={tracker.current!}
      commit={commit}
      goBack={() => window.history.back()}
      restart={() => void start(true)}
    />
  );
}

function FunnelRunner(props: {
  view: SessionView;
  state: FunnelState;
  tracker: Tracker;
  commit: (s: FunnelState) => void;
  goBack: () => void;
  restart: () => void;
}) {
  const { view, state, tracker, commit } = props;
  const f: ResolvedFunnel = view.funnel;
  const stepId = currentStepId(state);
  const step: Step = f.steps[stepId];
  const prog = computeProgress(f, stepId, state.answers);
  const [draft, setDraft] = useState<AnswerValue | undefined>(undefined);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const resultId = useMemo(() => (step.type === 'result' ? resolveResultId(f, state.answers) : null), [f, step, state.answers]);

  // Reset the draft to the saved answer whenever the step changes (back navigation pre-fills the old answer).
  useEffect(() => {
    setDraft(step.input ? state.answers[step.input.name] : undefined);
    setErrorMsg(null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [stepId]);

  // step_viewed once per render of a step (guarded against StrictMode double effects).
  const lastViewed = useRef<string | null>(null);
  useEffect(() => {
    const key = `${state.history.length}:${stepId}`;
    if (lastViewed.current === key) return;
    lastViewed.current = key;
    tracker.track('step_viewed', stepId, {
      step_type: step.type,
      visible_step_index: prog.index,
      visible_step_count: prog.count,
    });
    if (step.type === 'result' && resultId) tracker.track('result_viewed', stepId, { result_id: resultId });
    window.scrollTo({ top: 0 });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [stepId, state.history.length]);

  const submit = () => {
    let answers = state.answers;
    if (step.input) {
      const err = validateAnswer(step, draft);
      if (err) {
        setErrorMsg(err);
        return;
      }
      answers = { ...answers, [step.input.name]: draft as AnswerValue };
      tracker.track('answer_submitted', stepId, { answer_kind: answerKind(step, draft as AnswerValue) });
    }
    const next = nextStepId(f, stepId, answers);
    if (!next) return;
    tracker.track('step_completed', stepId, { next_step_id: next });
    commit({ ...state, answers, history: [...state.history, next] });
    window.history.pushState({ depth: state.history.length }, '');
  };

  const onCta = () => {
    if (!resultId) return;
    const result = f.results[resultId];
    tracker.track('cta_clicked', stepId, { result_id: resultId, action: result.cta.action });
    if (f.allowedEvents.some((e) => e.name === 'recommendation_expanded'))
      tracker.track('recommendation_expanded', stepId, { result_id: resultId, action: result.cta.action, source: 'cta' });
    commit({ ...state, ctaResultId: resultId });
  };

  const canGoBack = state.history.length > 1;

  return (
    <div className="funnel-shell">
      <header className="funnel-top">
        {canGoBack ? (
          <button className="btn ghost back" onClick={props.goBack} aria-label="Back">
            ← Back
          </button>
        ) : (
          <span />
        )}
        {step.type !== 'info' && step.type !== 'result' && prog.count > 0 && (
          <span className="progress-label">
            {prog.index} / {prog.count}
          </span>
        )}
      </header>
      <div className="progress" aria-hidden>
        <div className="progress-bar" style={{ width: `${Math.round(prog.ratio * 100)}%` }} />
      </div>

      <main className="card" key={`${stepId}:${state.history.length}`}>
        {step.type === 'result' && resultId ? (
          <ResultView result={f.results[resultId]} expanded={state.ctaResultId === resultId} onCta={onCta} />
        ) : (
          <StepView step={step} value={draft} error={errorMsg} onChange={(v) => { setDraft(v); setErrorMsg(null); }} onSubmit={submit} />
        )}
      </main>

      <footer className="funnel-meta">
        <span>
          v{view.version} · variant {view.variant}
          {view.variantSource === 'override' ? ' (override)' : ''}
          {!view.isActiveVersion ? ' · pinned to an older version' : ''}
        </span>
        <button className="link" onClick={props.restart}>
          Start over
        </button>
      </footer>
    </div>
  );
}
