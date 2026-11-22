import type React from 'react';
import type { ButtonHTMLAttributes, InputHTMLAttributes, ReactNode } from 'react';
import { useId, useState } from 'react';

export function Alert({
  tone,
  title,
  children,
}: {
  tone: 'error' | 'info' | 'success' | 'warning';
  title?: string;
  children?: ReactNode;
}) {
  const styles = {
    error: 'border-ahly-red/30 bg-red-50 text-ahly-red-dark',
    info: 'border-ischool-blue/25 bg-ischool-blue-soft text-ischool-blue-dark',
    success: 'border-emerald-600/25 bg-emerald-50 text-emerald-800',
    warning: 'border-ahly-gold/50 bg-ahly-gold-light/60 text-amber-900',
  }[tone];
  return (
    <div
      role={tone === 'error' ? 'alert' : 'status'}
      className={`rounded-xl border px-4 py-3 text-sm ${styles}`}
    >
      {title && <p className="font-semibold">{title}</p>}
      {children && <div className={title ? 'mt-1' : ''}>{children}</div>}
    </div>
  );
}

export function Button({
  variant = 'primary',
  className = '',
  ...props
}: ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: 'primary' | 'secondary' | 'ghost' | 'danger';
}) {
  const styles = {
    primary:
      'bg-ischool-blue text-white shadow-sm hover:bg-ischool-blue-dark focus-visible:outline-ischool-blue',
    secondary:
      'border border-line bg-white text-ischool-blue-dark hover:bg-ischool-blue-soft focus-visible:outline-ischool-blue',
    ghost:
      'text-muted hover:bg-ischool-blue-soft hover:text-ischool-blue-dark focus-visible:outline-ischool-blue',
    danger:
      'bg-ahly-red-dark text-white shadow-sm hover:bg-red-900 focus-visible:outline-ischool-blue',
  }[variant];
  return (
    <button
      className={`inline-flex min-h-11 items-center justify-center gap-2 rounded-xl px-5 py-2.5 text-sm font-semibold transition focus-visible:outline-2 focus-visible:outline-offset-2 disabled:cursor-not-allowed disabled:opacity-60 ${styles} ${className}`}
      {...props}
    />
  );
}

export function TextField({
  label,
  hint,
  error,
  ...props
}: InputHTMLAttributes<HTMLInputElement> & { label: string; hint?: string; error?: string }) {
  const id = useId();
  return (
    <div className="space-y-1.5">
      <label htmlFor={id} className="block text-sm font-medium text-ink">
        {label}
      </label>
      <input
        id={id}
        aria-invalid={error ? true : undefined}
        aria-describedby={error ? `${id}-error` : hint ? `${id}-hint` : undefined}
        className="block w-full rounded-xl border border-black/15 bg-white px-3.5 py-2.5 text-base shadow-sm outline-none transition placeholder:text-black/35 focus:border-ischool-blue focus:ring-4 focus:ring-ischool-blue/15 aria-[invalid=true]:border-ahly-red sm:text-sm"
        {...props}
      />
      {error ? (
        <p id={`${id}-error`} className="text-xs font-medium text-ahly-red-dark">
          {error}
        </p>
      ) : (
        hint && (
          <p id={`${id}-hint`} className="text-xs text-muted">
            {hint}
          </p>
        )
      )}
    </div>
  );
}

/** Password input with a show/hide toggle. */
export function PasswordField({
  label,
  ...props
}: InputHTMLAttributes<HTMLInputElement> & { label: string }) {
  const id = useId();
  const [visible, setVisible] = useState(false);
  return (
    <div className="space-y-1.5">
      <label htmlFor={id} className="block text-sm font-medium text-ink">
        {label}
      </label>
      <div className="relative">
        <input
          id={id}
          type={visible ? 'text' : 'password'}
          className="block w-full rounded-xl border border-black/15 bg-white py-2.5 pr-20 pl-3.5 text-base shadow-sm outline-none transition focus:border-ischool-blue focus:ring-4 focus:ring-ischool-blue/15 sm:text-sm"
          {...props}
        />
        <button
          type="button"
          onClick={() => setVisible((v) => !v)}
          aria-label={visible ? `Hide ${label.toLowerCase()}` : `Show ${label.toLowerCase()}`}
          aria-pressed={visible}
          className="absolute inset-y-1 right-1 rounded-lg px-3 text-xs font-semibold text-black/60 hover:bg-black/5 hover:text-ink focus-visible:outline-2 focus-visible:outline-ischool-blue"
        >
          {visible ? 'Hide' : 'Show'}
        </button>
      </div>
    </div>
  );
}

export function Card({ children, className = '' }: { children: ReactNode; className?: string }) {
  return (
    <div
      className={`min-w-0 rounded-2xl border border-line/80 bg-white p-5 shadow-card sm:p-6 ${className}`}
    >
      {children}
    </div>
  );
}

export function SelectField({
  label,
  children,
  ...props
}: React.SelectHTMLAttributes<HTMLSelectElement> & { label: string; children: ReactNode }) {
  const id = useId();
  return (
    <div className="space-y-1.5">
      <label htmlFor={id} className="block text-sm font-medium text-ink">
        {label}
      </label>
      <select
        id={id}
        className="block w-full rounded-xl border border-black/15 bg-white px-3 py-2.5 text-base shadow-sm outline-none focus:border-ischool-blue focus:ring-4 focus:ring-ischool-blue/15 sm:text-sm"
        {...props}
      >
        {children}
      </select>
    </div>
  );
}

export function Badge({
  tone = 'neutral',
  children,
}: {
  tone?: 'neutral' | 'red' | 'gold' | 'green' | 'blue' | 'gray';
  children: ReactNode;
}) {
  const styles = {
    neutral: 'bg-black/5 text-black/70',
    red: 'bg-red-50 text-ahly-red-dark ring-1 ring-inset ring-ahly-red/20',
    gold: 'bg-ahly-gold-light text-amber-900 ring-1 ring-inset ring-ahly-gold/40',
    green: 'bg-emerald-50 text-emerald-700 ring-1 ring-inset ring-emerald-600/20',
    blue: 'bg-ischool-blue-soft text-ischool-blue-dark ring-1 ring-inset ring-ischool-blue/20',
    gray: 'bg-black/5 text-muted ring-1 ring-inset ring-black/10',
  }[tone];
  return (
    <span
      className={`inline-flex items-center rounded-full px-2.5 py-0.5 text-xs font-semibold whitespace-nowrap ${styles}`}
    >
      {children}
    </span>
  );
}
