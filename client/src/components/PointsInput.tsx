import { useId, type KeyboardEvent } from 'react';

/**
 * Whole-number points from 0 to `max`, with − / + steppers. Empty means "not
 * scored yet"; 0 is a real score. Arrow keys step, Home/End jump to 0/max, and
 * typed values above the maximum are capped at the maximum.
 */
export function PointsInput({
  label,
  value,
  max,
  onChange,
  invalid = false,
}: {
  label: string;
  value: number | null;
  max: number;
  onChange: (value: number | null) => void;
  invalid?: boolean;
}) {
  const id = useId();
  const set = (n: number | null) => onChange(n == null ? null : Math.max(0, Math.min(max, n)));
  function onKey(e: KeyboardEvent<HTMLInputElement>) {
    const steps: Record<string, number | 'min' | 'max'> = {
      ArrowUp: 1,
      ArrowRight: 1,
      ArrowDown: -1,
      ArrowLeft: -1,
      Home: 'min',
      End: 'max',
    };
    const step = steps[e.key];
    if (step == null) return;
    // Left/right keep normal caret movement while text is selected or being typed.
    if ((e.key === 'ArrowLeft' || e.key === 'ArrowRight') && value != null) return;
    e.preventDefault();
    if (step === 'min') set(0);
    else if (step === 'max') set(max);
    else set((value ?? (step > 0 ? -1 : 1)) + step);
  }
  const stepper =
    'inline-flex size-11 shrink-0 items-center justify-center rounded-xl border border-line bg-white text-lg font-semibold text-ischool-blue-dark transition hover:bg-ischool-blue-soft focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ischool-blue disabled:cursor-not-allowed disabled:opacity-40';
  return (
    <div className="flex items-center gap-2">
      <label htmlFor={id} className="sr-only">
        {label} (0 to {max} points)
      </label>
      <button
        type="button"
        className={stepper}
        aria-label={`Decrease ${label}`}
        disabled={value == null || value <= 0}
        onClick={() => set((value ?? 0) - 1)}
      >
        −
      </button>
      <div
        className={`flex h-12 items-center gap-1 rounded-xl border bg-white px-3 shadow-sm transition focus-within:border-ischool-blue focus-within:ring-4 focus-within:ring-ischool-blue/15 ${
          invalid ? 'border-ahly-red ring-2 ring-ahly-red/25' : 'border-line'
        }`}
      >
        <input
          id={id}
          type="text"
          inputMode="numeric"
          autoComplete="off"
          aria-invalid={invalid || undefined}
          aria-describedby={`${id}-max`}
          value={value == null ? '' : String(value)}
          onKeyDown={onKey}
          onChange={(e) => {
            const digits = e.target.value.replace(/\D/g, '').slice(0, 3);
            set(digits === '' ? null : Number(digits));
          }}
          onFocus={(e) => e.target.select()}
          className="w-10 bg-transparent text-center text-2xl font-bold text-ink tabular-nums outline-none placeholder:text-black/25"
        />
        <span id={`${id}-max`} className="text-sm font-semibold text-muted">
          / {max}
        </span>
      </div>
      <button
        type="button"
        className={stepper}
        aria-label={`Increase ${label}`}
        disabled={value != null && value >= max}
        onClick={() => set(value == null ? 0 : value + 1)}
      >
        +
      </button>
    </div>
  );
}

/** A read-only points value, e.g. "7 / 10". */
export function PointsValue({ value, max }: { value: number | null; max: number }) {
  return (
    <span className="inline-flex items-baseline gap-1 rounded-xl bg-ischool-blue-soft px-3 py-1.5 tabular-nums">
      <span className="text-xl font-bold text-ischool-blue-dark">{value ?? '–'}</span>
      <span className="text-sm font-semibold text-muted">/ {max}</span>
      <span className="sr-only">{value == null ? 'not scored' : 'points'}</span>
    </span>
  );
}

/** A thin progress bar for a value out of a maximum. */
export function MiniBar({
  value,
  max,
  label,
  tone = 'blue',
}: {
  value: number;
  max: number;
  label: string;
  tone?: 'blue' | 'green' | 'gold';
}) {
  const pct = max > 0 ? Math.min(100, (value / max) * 100) : 0;
  const color = { blue: 'bg-ischool-blue', green: 'bg-emerald-600', gold: 'bg-ahly-gold' }[tone];
  return (
    <div
      role="progressbar"
      aria-label={label}
      aria-valuemin={0}
      aria-valuemax={max}
      aria-valuenow={value}
      className="h-1.5 w-full overflow-hidden rounded-full bg-ischool-blue/10"
    >
      <div
        className={`h-full rounded-full ${color} transition-[width]`}
        style={{ width: `${pct}%` }}
      />
    </div>
  );
}
