import { useState, type FormEvent } from 'react';
import { Navigate, useLocation, useNavigate } from 'react-router';
import { homePathForRole } from '@judging/shared';
import { ApiError } from '../../api/client';
import { takeSessionEndedNotice, useAuth } from '../../auth/AuthContext';
import { Alert, Button, PasswordField, TextField } from '../../components/ui';
import { FullPageSpinner } from '../../components/FullPageSpinner';

function BrandPanel() {
  return (
    <div className="relative hidden overflow-hidden bg-ink text-white lg:flex lg:w-[46%] lg:flex-col lg:justify-between lg:p-12">
      <div
        aria-hidden
        className="absolute inset-0 bg-gradient-to-br from-ahly-red/80 via-ahly-red-dark/40 to-transparent"
      />
      <div
        aria-hidden
        className="absolute -right-24 -bottom-24 h-96 w-96 rounded-full border-[40px] border-ahly-gold/15"
      />
      <div className="relative flex items-center gap-4 self-start rounded-2xl bg-white px-5 py-3 shadow-lg">
        <img
          src="/brand/ischool-logo.svg"
          alt="iSchool"
          width={125}
          height={36}
          className="h-9 w-auto"
        />
        <span aria-hidden className="text-2xl font-light text-ahly-gold">
          ×
        </span>
        <img
          src="/brand/al-ahly-logo.png"
          alt="Al Ahly Club"
          width={34}
          height={56}
          className="h-14 w-auto"
        />
      </div>
      <div className="relative max-w-md space-y-4">
        <p className="text-xs font-semibold uppercase tracking-[0.25em] text-ahly-gold">
          iSchool × Al Ahly Club
        </p>
        <h1 className="text-4xl leading-tight font-bold">Competition Judging Platform</h1>
        <p className="text-base text-white/75">
          Fair, consistent scoring for every team. Sign in with the account provided by the
          competition administrator.
        </p>
      </div>
      <p className="relative text-xs text-white/55">Runs locally — no data leaves this computer.</p>
    </div>
  );
}

export function LoginPage() {
  const { user, loading, login } = useAuth();
  const navigate = useNavigate();
  const location = useLocation();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [sessionEnded] = useState(() => takeSessionEndedNotice());

  if (loading) return <FullPageSpinner label="Checking your session…" />;
  if (user)
    return (
      <Navigate
        to={user.mustChangePassword ? '/change-password' : homePathForRole(user.role)}
        replace
      />
    );

  async function onSubmit(event: FormEvent) {
    event.preventDefault();
    setError(null);
    setSubmitting(true);
    try {
      const signedIn = await login({ email, password });
      const from = (location.state as { from?: string } | null)?.from;
      const target = signedIn.mustChangePassword
        ? '/change-password'
        : from && from !== '/' && from !== '/login'
          ? from
          : homePathForRole(signedIn.role);
      navigate(target, { replace: true });
    } catch (e) {
      setPassword('');
      setError(e instanceof ApiError ? e.message : 'Sign-in failed. Please try again.');
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div className="flex min-h-screen bg-surface">
      <BrandPanel />
      <main className="flex flex-1 flex-col">
        <div className="brand-stripe h-1 lg:hidden" aria-hidden />
        <div className="flex flex-1 items-center justify-center px-4 py-10 sm:px-8">
          <div className="w-full max-w-md space-y-8">
            {/* Compact brand header for phones and tablets */}
            <div className="flex flex-col items-center gap-4 text-center lg:hidden">
              <div className="flex items-center gap-3">
                <img
                  src="/brand/ischool-logo.svg"
                  alt="iSchool"
                  width={125}
                  height={36}
                  className="h-8 w-auto"
                />
                <span aria-hidden className="text-xl font-light text-ahly-gold">
                  ×
                </span>
                <img
                  src="/brand/al-ahly-logo.png"
                  alt="Al Ahly Club"
                  width={34}
                  height={56}
                  className="h-12 w-auto"
                />
              </div>
              <p className="text-sm font-semibold text-black/70">Competition Judging Platform</p>
            </div>

            <div className="rounded-3xl border border-black/5 bg-white p-6 shadow-xl shadow-black/5 sm:p-8">
              <h2 className="text-2xl font-bold">Sign in</h2>
              <p className="mt-1 text-sm text-black/60">
                Judges and administrators of the iSchool × Al Ahly competition.
              </p>

              <form className="mt-6 space-y-5" onSubmit={onSubmit} noValidate>
                {sessionEnded && !error && (
                  <Alert tone="info">Your session ended. Please sign in again.</Alert>
                )}
                {error && <Alert tone="error">{error}</Alert>}
                <TextField
                  label="E-mail"
                  type="email"
                  name="email"
                  autoComplete="username"
                  inputMode="email"
                  required
                  autoFocus
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                />
                <PasswordField
                  label="Password"
                  name="password"
                  autoComplete="current-password"
                  required
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                />
                <Button
                  type="submit"
                  className="w-full py-3"
                  disabled={submitting || !email || !password}
                >
                  {submitting ? 'Signing in…' : 'Sign in'}
                </Button>
              </form>

              <p className="mt-6 border-t border-black/5 pt-4 text-xs leading-relaxed text-black/55">
                Forgot your password or locked out? Ask the competition administrator to reset it.
                Accounts are created by the administrator; there is no public sign-up.
              </p>
            </div>
          </div>
        </div>
      </main>
    </div>
  );
}
