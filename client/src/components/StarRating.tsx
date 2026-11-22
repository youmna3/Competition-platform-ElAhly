import { useRef, type KeyboardEvent } from 'react';

const STARS = [1, 2, 3, 4, 5] as const;

function Star({ filled, size }: { filled: boolean; size: number }) {
  return (
    <svg
      viewBox="0 0 24 24"
      width={size}
      height={size}
      aria-hidden
      className={filled ? 'text-ahly-gold' : 'text-black/25'}
    >
      <path
        d="M12 2.8l2.85 5.78 6.38.93-4.62 4.5 1.09 6.35L12 17.36 6.3 20.36l1.09-6.35-4.62-4.5 6.38-.93L12 2.8z"
        fill={filled ? 'currentColor' : 'none'}
        stroke="currentColor"
        strokeWidth={1.6}
        strokeLinejoin="round"
      />
    </svg>
  );
}

/**
 * Five-star rating. Read-only by default (a preview of the 1–5 star scale);
 * pass onChange to make it an accessible radio group (arrow keys work).
 */
export function StarRating({
  label,
  value = null,
  onChange,
  size = 22,
}: {
  label: string;
  value?: number | null;
  onChange?: (value: number) => void;
  size?: number;
}) {
  const refs = useRef<(HTMLButtonElement | null)[]>([]);

  if (!onChange) {
    return (
      <span
        role="img"
        aria-label={value ? `${label}: ${value} of 5 stars` : `${label}: rated from 1 to 5 stars`}
        className="inline-flex items-center gap-0.5"
      >
        {STARS.map((n) => (
          <Star key={n} filled={value != null && n <= value} size={size} />
        ))}
      </span>
    );
  }

  function onKeyDown(e: KeyboardEvent, n: number) {
    const next =
      e.key === 'ArrowRight' || e.key === 'ArrowUp'
        ? Math.min(5, n + 1)
        : e.key === 'ArrowLeft' || e.key === 'ArrowDown'
          ? Math.max(1, n - 1)
          : null;
    if (next == null) return;
    e.preventDefault();
    onChange!(next);
    refs.current[next - 1]?.focus();
  }

  return (
    <span role="radiogroup" aria-label={label} className="inline-flex items-center gap-0.5">
      {STARS.map((n) => (
        <button
          key={n}
          ref={(el) => {
            refs.current[n - 1] = el;
          }}
          type="button"
          role="radio"
          aria-checked={value === n}
          aria-label={`${n} star${n === 1 ? '' : 's'}`}
          tabIndex={value === n || (value == null && n === 1) ? 0 : -1}
          onClick={() => onChange(n)}
          onKeyDown={(e) => onKeyDown(e, n)}
          className="rounded-md p-0.5 transition hover:scale-110 focus-visible:outline-2 focus-visible:outline-ischool-blue"
        >
          <Star filled={value != null && n <= value} size={size} />
        </button>
      ))}
    </span>
  );
}
