import { useMemo, useState, type FormEvent } from 'react';
import { useNavigate } from 'react-router';
import { homePathForRole, PASSWORD_MIN_LENGTH } from '@judging/shared';
import { ApiError } from '../../api/client';
import { useAuth } from '../../auth/AuthContext';
import { Alert, Button, Card, PasswordField } from '../../components/ui';

interface Rule {
  label: string;
  ok: boolean;
}

export function ChangePasswordPage() {
  const { user, changePassword } = useAuth();
  const navigate = useNavigate();
  const [current, setCurrent] = useState('');
  const [next, setNext] = useState('');
  const [confirm, setConfirm] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const forced = user?.mustChangePassword ?? false;

  const rules: Rule[] = useMemo(() => {
    const local = user?.email.split('@')[0]?.toLowerCase() ?? '';
    return [
      {
        label: `At least ${PASSWORD_MIN_LENGTH} characters`,
        ok: next.length >= PASSWORD_MIN_LENGTH,
      },
      { label: 'An upper-case letter', ok: /[A-Z]/.test(next) },
      { label: 'A lower-case letter', ok: /[a-z]/.test(next) },
      { label: 'A number', ok: /\d/.test(next) },
      { label: 'A symbol (for example ! @ # -)', ok: /[^A-Za-z0-9]/.test(next) },
      {
        label: 'Does not contain your e-mail name',
        ok: next.length > 0 && !(local.length >= 4 && next.toLowerCase().includes(local)),
      },
      { label: 'Different from your current password', ok: next.length > 0 && next !== current },
      { label: 'Both new passwords match', ok: next.length > 0 && next === confirm },
    ];
  }, [next, confirm, current, user?.email]);

  const allOk = current.length > 0 && rules.every((r) => r.ok);

  async function onSubmit(event: FormEvent) {
    event.preventDefault();
    if (!allOk) return;
    setError(null);
    setSubmitting(true);
    try {
      const updated = await changePassword({ currentPassword: current, newPassword: next });
      navigate(homePathForRole(updated.role), { replace: true, state: { passwordChanged: true } });
    } catch (e) {
      setError(
        e instanceof ApiError ? e.message : 'The password could not be changed. Please try again.',
      );
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div className="mx-auto max-w-xl space-y-6">
      <div>
        <h1 className="text-2xl font-bold">
          {forced ? 'Choose your own password' : 'Change password'}
        </h1>
        <p className="mt-1 text-sm text-black/60">
          {forced
            ? 'You signed in with a temporary password. For security, choose a new one before continuing.'
            : 'After changing it, you will stay signed in here and be signed out on other devices.'}
        </p>
      </div>
      <Card>
        <form className="space-y-5" onSubmit={onSubmit} noValidate>
          {error && <Alert tone="error">{error}</Alert>}
          <PasswordField
            label={forced ? 'Temporary password' : 'Current password'}
            autoComplete="current-password"
            value={current}
            onChange={(e) => setCurrent(e.target.value)}
            required
          />
          <PasswordField
            label="New password"
            autoComplete="new-password"
            value={next}
            onChange={(e) => setNext(e.target.value)}
            required
          />
          <PasswordField
            label="Confirm new password"
            autoComplete="new-password"
            value={confirm}
            onChange={(e) => setConfirm(e.target.value)}
            required
          />
          <ul
            className="grid gap-1.5 rounded-xl bg-surface p-4 text-sm sm:grid-cols-2"
            aria-label="Password requirements"
          >
            {rules.map((rule) => (
              <li
                key={rule.label}
                className={`flex items-start gap-2 ${rule.ok ? 'text-emerald-700' : 'text-muted'}`}
              >
                <span aria-hidden className="mt-0.5 font-bold">
                  {rule.ok ? '✓' : '○'}
                </span>
                <span>
                  {rule.label}
                  <span className="sr-only">{rule.ok ? ' (met)' : ' (not met yet)'}</span>
                </span>
              </li>
            ))}
          </ul>
          <Button type="submit" className="w-full py-3" disabled={!allOk || submitting}>
            {submitting ? 'Saving…' : 'Save new password'}
          </Button>
        </form>
      </Card>
    </div>
  );
}
