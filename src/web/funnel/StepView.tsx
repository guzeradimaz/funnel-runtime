import type { AnswerValue, Step } from '../../shared/types';

export function StepView(props: {
  step: Step;
  value: AnswerValue | undefined;
  error: string | null;
  onChange: (v: AnswerValue | undefined) => void;
  onSubmit: () => void;
}) {
  const { step, value, error, onChange, onSubmit } = props;
  const c = step.content;
  const label = step.type === 'info' ? c.primaryActionLabel ?? 'Continue' : 'Continue';
  const errorId = `${step.id}-error`;

  return (
    <form
      className={`step step-${step.type}`}
      onSubmit={(e) => {
        e.preventDefault();
        onSubmit();
      }}
      noValidate
    >
      {c.eyebrow && <p className="eyebrow">{c.eyebrow}</p>}
      <h1>{c.title}</h1>
      {c.body && <p className="lead">{c.body}</p>}
      {c.helperText && <p className="muted">{c.helperText}</p>}

      {step.type === 'single-select' && (
        <div className="options" role="radiogroup" aria-describedby={error ? errorId : undefined}>
          {step.input!.options!.map((o) => (
            <label key={o.value} className={`option ${value === o.value ? 'selected' : ''}`}>
              <input
                type="radio"
                name={step.input!.name}
                checked={value === o.value}
                onChange={() => onChange(o.value)}
              />
              <span>{o.label}</span>
            </label>
          ))}
        </div>
      )}

      {step.type === 'multi-select' && (
        <MultiSelect step={step} value={Array.isArray(value) ? value : []} onChange={onChange} errorId={error ? errorId : undefined} />
      )}

      {step.type === 'number' && (
        <div className="number-field">
          <input
            type="number"
            inputMode="numeric"
            autoFocus
            min={step.input?.min}
            max={step.input?.max}
            step={step.input?.step ?? 'any'}
            value={typeof value === 'number' ? value : ''}
            aria-invalid={Boolean(error)}
            aria-describedby={error ? errorId : undefined}
            onChange={(e) => onChange(e.target.value === '' ? undefined : Number(e.target.value))}
          />
          {step.input?.unit && <span className="unit">{step.input.unit}</span>}
        </div>
      )}

      {error && (
        <p className="error" id={errorId} role="alert">
          {error}
        </p>
      )}

      <button type="submit" className="btn primary wide">
        {label}
      </button>
    </form>
  );
}

function MultiSelect(props: { step: Step; value: string[]; onChange: (v: string[]) => void; errorId?: string }) {
  const { step, value, onChange } = props;
  const max = step.validation?.maxSelections;
  return (
    <div className="options" role="group" aria-describedby={props.errorId}>
      {step.input!.options!.map((o) => {
        const checked = value.includes(o.value);
        const disabled = !checked && max !== undefined && value.length >= max;
        return (
          <label key={o.value} className={`option ${checked ? 'selected' : ''} ${disabled ? 'disabled' : ''}`}>
            <input
              type="checkbox"
              checked={checked}
              disabled={disabled}
              onChange={() => onChange(checked ? value.filter((x) => x !== o.value) : [...value, o.value])}
            />
            <span>{o.label}</span>
          </label>
        );
      })}
      {max !== undefined && (
        <p className="muted small">
          {value.length} of {max} selected
        </p>
      )}
    </div>
  );
}
