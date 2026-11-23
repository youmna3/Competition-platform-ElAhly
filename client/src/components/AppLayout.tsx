import { useState } from 'react';
import { NavLink, Outlet, useNavigate } from 'react-router';
import { ROLE_LABELS } from '@judging/shared';
import { useAuth } from '../auth/AuthContext';

export function BrandMark() {
  return (
    <div className="flex items-center gap-3 sm:gap-4">
      <img
        src="/brand/ischool-logo.svg"
        alt="iSchool"
        width={125}
        height={36}
        className="h-7 w-auto sm:h-9"
      />
      <span aria-hidden className="text-xl font-light text-ahly-gold sm:text-2xl">
        ×
      </span>
      <img
        src="/brand/al-ahly-logo.png"
        alt="Al Ahly Club"
        width={34}
        height={56}
        className="h-12 w-auto sm:h-14"
      />
    </div>
  );
}

const navClass = ({ isActive }: { isActive: boolean }) =>
  `inline-flex min-h-11 items-center whitespace-nowrap rounded-xl px-4 py-2 text-sm font-semibold transition ${
    isActive
      ? 'bg-ischool-blue-soft text-ischool-blue-dark ring-1 ring-inset ring-ischool-blue/20'
      : 'text-muted hover:bg-ischool-blue-soft hover:text-ischool-blue-dark'
  }`;

export function AppLayout() {
  const { user, logout } = useAuth();
  const navigate = useNavigate();
  const [signingOut, setSigningOut] = useState(false);
  const restricted = user?.mustChangePassword ?? true;

  async function signOut() {
    setSigningOut(true);
    try {
      await logout();
    } finally {
      navigate('/login', { replace: true });
    }
  }

  return (
    <div className="flex min-h-screen flex-col">
      <a
        href="#main-content"
        className="sr-only focus:not-sr-only focus:fixed focus:left-4 focus:top-4 focus:z-50 focus:rounded-xl focus:bg-ischool-blue focus:px-4 focus:py-3 focus:text-white"
      >
        Skip to content
      </a>
      <header className="sticky top-0 z-30 border-b border-black/5 bg-white/95 backdrop-blur">
        <div className="brand-stripe h-1" aria-hidden />
        <div className="mx-auto flex w-full max-w-6xl items-center justify-between gap-4 px-4 py-2 sm:px-6">
          <BrandMark />
          {user && (
            <div className="flex items-center gap-3">
              <div className="hidden text-right leading-tight sm:block">
                <p className="max-w-[220px] truncate text-sm font-semibold">{user.fullName}</p>
                <p className="text-xs text-muted">{ROLE_LABELS[user.role]}</p>
              </div>
              <button
                type="button"
                onClick={signOut}
                disabled={signingOut}
                className="secondary-link disabled:opacity-60"
              >
                {signingOut ? 'Signing out…' : 'Sign out'}
              </button>
            </div>
          )}
        </div>
        {user && !restricted && (
          <nav
            aria-label="Main"
            className="mx-auto flex w-full max-w-6xl gap-1 overflow-x-auto px-4 pb-2 sm:px-6"
          >
            {user.role === 'admin' && (
              <>
                <NavLink to="/admin" end className={navClass}>
                  Dashboard
                </NavLink>
                <NavLink to="/admin/users" className={navClass}>
                  Users
                </NavLink>
                <NavLink to="/admin/reports" className={navClass}>
                  Reports
                </NavLink>
                <NavLink to="/admin/teams" className={navClass}>
                  Teams
                </NavLink>
                <NavLink to="/admin/evaluations" className={navClass}>
                  Evaluations
                </NavLink>
                <NavLink to="/admin/leaderboard" className={navClass}>
                  Leaderboard
                </NavLink>
                <NavLink to="/admin/rubric" className={navClass}>
                  Rubric
                </NavLink>
                <NavLink to="/judge" className={navClass}>
                  My teams
                </NavLink>
                <NavLink to="/admin/status" className={navClass}>
                  System status
                </NavLink>
              </>
            )}
            {user.role === 'judge' && (
              <>
                <NavLink to="/judge" className={navClass}>
                  My teams
                </NavLink>
                <NavLink to="/rubric" className={navClass}>
                  Rubric
                </NavLink>
                <NavLink to="/leaderboard" className={navClass}>
                  Leaderboard
                </NavLink>
              </>
            )}
            <NavLink to="/change-password" className={navClass}>
              Change password
            </NavLink>
          </nav>
        )}
      </header>

      <main
        id="main-content"
        tabIndex={-1}
        className="mx-auto w-full max-w-6xl flex-1 px-4 py-8 sm:px-6 sm:py-10"
      >
        <Outlet />
      </main>

      <footer className="border-t border-black/5 bg-white">
        <div className="mx-auto flex w-full max-w-6xl flex-col items-center justify-between gap-2 px-4 py-4 text-xs text-muted sm:flex-row sm:px-6">
          <span>iSchool × Al Ahly Club Judging Platform</span>
          <span>Runs locally — no data leaves this computer</span>
        </div>
      </footer>
    </div>
  );
}
