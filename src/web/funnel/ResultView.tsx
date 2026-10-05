import type { Result } from '../../shared/types';

export function ResultView(props: { result: Result; expanded: boolean; onCta: () => void }) {
  const { result, expanded, onCta } = props;
  return (
    <section className="step step-result">
      <p className="eyebrow">Your recommendation</p>
      <h1>{result.title}</h1>
      <p className="lead">{result.summary}</p>
      {expanded ? (
        <ol className="recommendations">
          {result.recommendations.map((r) => (
            <li key={r}>{r}</li>
          ))}
        </ol>
      ) : (
        <button className="btn primary wide" onClick={onCta}>
          {result.cta.label}
        </button>
      )}
    </section>
  );
}
