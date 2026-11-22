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
  `whitespace-nowrap rounded-full px-4 py-2 text-sm font-medium transition ${
    isActive ? 'bg-ahly-red text-white shadow-sm' : 'text-black/65 hover:bg-black/5 hover:text-ink'
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
      <header className="sticky top-0 z-30 border-b border-black/5 bg-white/95 backdrop-blur">
        <div className="brand-stripe h-1" aria-hidden />
        <div className="mx-auto flex w-full max-w-6xl items-center justify-between gap-4 px-4 py-2 sm:px-6">
          <BrandMark />
          {user && (
            <div className="flex items-center gap-3">
              <div className="hidden text-right leading-tight sm:block">
                <p className="max-w-[220px] truncate text-sm font-semibold">{user.fullName}</p>
                <p className="text-xs text-black/55">{ROLE_LABELS[user.role]}</p>
              </div>
              <button
                type="button"
                onClick={signOut}
                disabled={signingOut}
                className="rounded-full border border-black/15 px-4 py-2 text-sm font-semibold text-black/75 transition hover:bg-black/5 focus-visible:outline-2 focus-visible:outline-ischool-blue disabled:opacity-60"
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
                <NavLink to="/admin/teams" className={navClass}>
                  Teams
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
              <NavLink to="/judge" className={navClass}>
                My teams
              </NavLink>
            )}
            <NavLink to="/change-password" className={navClass}>
              Change password
            </NavLink>
          </nav>
        )}
      </header>

      <main className="mx-auto w-full max-w-6xl flex-1 px-4 py-8 sm:px-6 sm:py-10">
        <Outlet />
      </main>

      <footer className="border-t border-black/5 bg-white">
        <div className="mx-auto flex w-full max-w-6xl flex-col items-center justify-between gap-2 px-4 py-4 text-xs text-black/55 sm:flex-row sm:px-6">
          <span>iSchool × Al Ahly Club Judging Platform</span>
          <span>Runs locally — no data leaves this computer</span>
        </div>
      </footer>
    </div>
  );
}
