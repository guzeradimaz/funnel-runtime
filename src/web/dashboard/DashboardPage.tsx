import { useCallback, useEffect, useState } from 'react';
import { api, ApiError } from '../api';
import { TokenGate } from '../admin/TokenGate';

interface Rates {
  started: number;
  reachedResult: number;
  ctaClicked: number;
  resultRate: number;
  ctr: number;
  ctaPerStart: number;
}

interface StepRow {
  stepId: string;
  type: string;
  conditional: boolean;
  viewed: number;
  completed: number;
  reachRate: number;
  stepConversion: number | null;
  dropOff: number;
  dropRate: number;
}

interface Analytics {
  campaigns: string[];
  versionsWithData: number[];
  totals: Rates & { sessions: number; events: number; repeatedViews: number; qaSessionsExcluded: number };
  variants: (Rates & {
    variant: string;
    backClickedSessions: number;
    steps: { started: number; noStepViewed: number; rows: StepRow[] } | null;
    results: Record<string, { sessions: number; cta: number }>;
    extraEvents: Record<string, number>;
  })[];
  abTest: null | { metric: string; a: number; b: number; liftAbs: number; liftRel: number | null; z: number; pValue: number };
  versions: { version: number; total: Rates; variants: Record<string, Rates> }[];
}

const pct = (x: number | null | undefined, digits = 1) => (x === null || x === undefined ? '—' : `${(x * 100).toFixed(digits)}%`);

export function DashboardPage() {
  const params = new URLSearchParams(location.search);
  const [version, setVersion] = useState<string>(params.get('version') ?? '');
  const [campaign, setCampaign] = useState<string>(params.get('campaign') ?? '');
  const [data, setData] = useState<Analytics | null>(null);
  const [error, setError] = useState<ApiError | null>(null);
  const [activeVersion, setActiveVersion] = useState<number | null>(null);

  const load = useCallback(async () => {
    try {
      setError(null);
      let v = version;
      if (!v && activeVersion === null) {
        const funnels = await api<{ funnels: string[] }>('/api/admin/funnels');
        const info = await api<{ activeVersion: number | null }>(`/api/admin/funnels/${funnels.funnels[0]}/versions`);
        setActiveVersion(info.activeVersion);
        if (info.activeVersion) {
          v = String(info.activeVersion);
          setVersion(v);
          return; // effect re-runs with the version set
        }
      }
      const q = new URLSearchParams();
      if (v && v !== 'all') q.set('version', v);
      if (campaign) q.set('campaign', campaign);
      setData(await api<Analytics>(`/api/admin/analytics?${q}`));
      history.replaceState(null, '', `?${new URLSearchParams({ version: v, ...(campaign ? { campaign } : {}) })}`);
    } catch (e) {
      setError(e as ApiError);
    }
  }, [version, campaign, activeVersion]);

  useEffect(() => {
    void load();
  }, [load]);

  if (error?.status === 401) return <TokenGate onSaved={load} />;

  return (
    <div className="page wide">
      <div className="row between wrap">
        <h1>Аналитика воронки</h1>
        <div className="row gap wrap">
          <label className="field">
            Версия
            <select value={version} onChange={(e) => setVersion(e.target.value)}>
              <option value="all">Все версии</option>
              {(data?.versionsWithData ?? []).concat(activeVersion && !data?.versionsWithData.includes(activeVersion) ? [activeVersion] : []).map((v) => (
                <option key={v} value={v}>
                  v{v}
                  {v === activeVersion ? ' (активная)' : ''}
                </option>
              ))}
            </select>
          </label>
          <label className="field">
            UTM campaign
            <select value={campaign} onChange={(e) => setCampaign(e.target.value)}>
              <option value="">Все кампании</option>
              {(data?.campaigns ?? []).map((c) => (
                <option key={c} value={c}>
                  {c}
                </option>
              ))}
            </select>
          </label>
          <button className="btn" onClick={() => void load()}>
            Обновить
          </button>
        </div>
      </div>
      {error && <p className="error">{error.message}</p>}
      {data && <DashboardBody data={data} allVersions={version === 'all'} />}
    </div>
  );
}

function DashboardBody({ data, allVersions }: { data: Analytics; allVersions: boolean }) {
  const t = data.totals;
  return (
    <>
      <div className="tiles">
        <Tile label="Начали воронку" value={String(t.started)} hint="уникальные сессии с session_started" />
        <Tile label="Дошли до результата" value={pct(t.resultRate)} hint={`${t.reachedResult} сессий`} />
        <Tile label="CTR основного CTA" value={pct(t.ctr)} hint={`${t.ctaClicked} кликов / ${t.reachedResult} результатов`} />
        <Tile label="CTA / начавшие" value={pct(t.ctaPerStart)} hint="основная метрика эксперимента" primary />
      </div>

      {data.abTest && <AbCard ab={data.abTest} variants={data.variants} />}

      {allVersions ? (
        <p className="muted panel">
          Пошаговая воронка строится для одной версии: у версий разный набор и порядок шагов. Выберите версию выше.
        </p>
      ) : (
        <div className="grid-2">
          {data.variants.map((v) => (
            <section className="panel" key={v.variant}>
              <h2>
                Вариант {v.variant} <span className="muted small">· {v.started} сессий</span>
              </h2>
              {v.steps && <StepTable steps={v.steps} reached={v.reachedResult} />}
              <Results results={v.results} />
              <p className="muted small">
                Возвращались назад: {v.backClickedSessions} сессий
                {Object.entries(v.extraEvents).map(([k, n]) => ` · ${k}: ${n} сессий`)}
              </p>
            </section>
          ))}
        </div>
      )}

      <section className="panel">
        <h2>Сравнение версий</h2>
        <table className="table">
          <thead>
            <tr>
              <th>Версия</th>
              <th>Сегмент</th>
              <th className="num">Начали</th>
              <th className="num">Результат</th>
              <th className="num">CTR</th>
              <th className="num">CTA / начавшие</th>
            </tr>
          </thead>
          <tbody>
            {data.versions.flatMap((v) => [
              <tr key={`${v.version}-all`} className="group">
                <td>v{v.version}</td>
                <td>все</td>
                <RateCells r={v.total} />
              </tr>,
              ...Object.entries(v.variants).map(([name, r]) => (
                <tr key={`${v.version}-${name}`}>
                  <td />
                  <td>вариант {name}</td>
                  <RateCells r={r} />
                </tr>
              )),
            ])}
          </tbody>
        </table>
      </section>

      <p className="muted small">
        Событий в выборке: {t.events} · повторных step_viewed: {t.repeatedViews} · QA-сессий с ?variant= исключено:{' '}
        {t.qaSessionsExcluded}. Метрики считаются по уникальным сессиям; дубли
        отсекаются по event_id при приёме; порядок прихода событий не важен.
      </p>
    </>
  );
}

function RateCells({ r }: { r: Rates }) {
  return (
    <>
      <td className="num">{r.started}</td>
      <td className="num">
        {pct(r.resultRate)} <span className="muted small">({r.reachedResult})</span>
      </td>
      <td className="num">
        {pct(r.ctr)} <span className="muted small">({r.ctaClicked})</span>
      </td>
      <td className="num">
        <b>{pct(r.ctaPerStart)}</b>
      </td>
    </>
  );
}

function Tile(props: { label: string; value: string; hint?: string; primary?: boolean }) {
  return (
    <div className={`tile ${props.primary ? 'primary' : ''}`}>
      <p className="muted small">{props.label}</p>
      <p className="tile-value">{props.value}</p>
      {props.hint && <p className="muted small">{props.hint}</p>}
    </div>
  );
}

function AbCard({ ab, variants }: { ab: NonNullable<Analytics['abTest']>; variants: Analytics['variants'] }) {
  const a = variants.find((v) => v.variant === 'A')!;
  const b = variants.find((v) => v.variant === 'B')!;
  const significant = ab.pValue < 0.05;
  const minN = Math.min(a.started, b.started);
  return (
    <section className="panel ab">
      <h2>A/B: {ab.metric}</h2>
      <div className="ab-row">
        <div>
          <p className="muted small">A · {a.started} сессий</p>
          <p className="tile-value">{pct(ab.a)}</p>
        </div>
        <div>
          <p className="muted small">B · {b.started} сессий</p>
          <p className="tile-value">{pct(ab.b)}</p>
        </div>
        <div>
          <p className="muted small">Разница B − A</p>
          <p className={`tile-value ${ab.liftAbs >= 0 ? 'pos' : 'neg'}`}>
            {ab.liftAbs >= 0 ? '+' : ''}
            {(ab.liftAbs * 100).toFixed(1)} п.п.
          </p>
          <p className="muted small">{ab.liftRel !== null ? `${ab.liftRel >= 0 ? '+' : ''}${(ab.liftRel * 100).toFixed(0)}% отн.` : ''}</p>
        </div>
        <div>
          <p className="muted small">p-value (z-тест двух долей)</p>
          <p className="tile-value">{ab.pValue < 0.001 ? '<0.001' : ab.pValue.toFixed(3)}</p>
          <p className="muted small">
            {significant ? 'различие значимо на уровне 5%' : minN < 400 ? 'мало данных для вывода' : 'различие не значимо'}
          </p>
        </div>
      </div>
    </section>
  );
}

function StepTable({ steps, reached }: { steps: NonNullable<Analytics['variants'][number]['steps']>; reached: number }) {
  const sumDrop = steps.rows.reduce((s, r) => s + r.dropOff, 0);
  const balanced = steps.noStepViewed + sumDrop + reached === steps.started;
  return (
    <>
      <table className="table steps">
        <thead>
          <tr>
            <th>Шаг</th>
            <th className="num">Видели</th>
            <th className="num">Конверсия шага</th>
            <th className="num">Отвал</th>
          </tr>
        </thead>
        <tbody>
          {steps.rows.map((r) => (
            <tr key={r.stepId}>
              <td>
                <div className="step-name">
                  {r.stepId}
                  {r.conditional && <span className="badge">ветка</span>}
                </div>
                <div className="bar">
                  <div style={{ width: `${r.reachRate * 100}%` }} />
                </div>
              </td>
              <td className="num">
                {r.viewed} <span className="muted small">{pct(r.reachRate, 0)}</span>
              </td>
              <td className="num">{pct(r.stepConversion)}</td>
              <td className="num">
                {r.type === 'result' ? '—' : r.dropOff}{' '}
                {r.type !== 'result' && <span className="muted small">{pct(r.dropRate, 0)}</span>}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      <p className={`small ${balanced ? 'muted' : 'error'}`}>
        Сверка: {steps.noStepViewed} без просмотра шага + {sumDrop} отвалов + {reached} результатов = {steps.noStepViewed + sumDrop + reached}{' '}
        {balanced ? '=' : '≠'} {steps.started} начавших
      </p>
    </>
  );
}

function Results({ results }: { results: Record<string, { sessions: number; cta: number }> }) {
  const entries = Object.entries(results).sort((a, b) => b[1].sessions - a[1].sessions);
  if (!entries.length) return null;
  return (
    <table className="table compact">
      <thead>
        <tr>
          <th>Результат</th>
          <th className="num">Показан</th>
          <th className="num">CTR</th>
        </tr>
      </thead>
      <tbody>
        {entries.map(([id, r]) => (
          <tr key={id}>
            <td>{id}</td>
            <td className="num">{r.sessions}</td>
            <td className="num">{pct(r.sessions ? r.cta / r.sessions : 0)}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}
