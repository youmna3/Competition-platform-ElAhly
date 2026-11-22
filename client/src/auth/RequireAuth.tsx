import type { ReactNode } from 'react';
import { Navigate, useLocation } from 'react-router';
import { homePathForRole, type UserRole } from '@judging/shared';
import { useAuth } from './AuthContext';
import { FullPageSpinner } from '../components/FullPageSpinner';

/**
 * Client-side guard for screens. The server enforces the same rules on every
 * API call; this only decides what to show.
 */
export function RequireAuth({ roles, children }: { roles?: UserRole[]; children: ReactNode }) {
  const { user, loading } = useAuth();
  const location = useLocation();

  if (loading) return <FullPageSpinner label="Checking your session…" />;
  if (!user) {
    return <Navigate to="/login" replace state={{ from: location.pathname + location.search }} />;
  }
  if (user.mustChangePassword && location.pathname !== '/change-password') {
    return <Navigate to="/change-password" replace />;
  }
  if (roles && !roles.includes(user.role)) {
    return <Navigate to={homePathForRole(user.role)} replace />;
  }
  return <>{children}</>;
}

/** Sends a signed-in user to their own home page. */
export function HomeRedirect() {
  const { user, loading } = useAuth();
  if (loading) return <FullPageSpinner label="Loading…" />;
  if (!user) return <Navigate to="/login" replace />;
  if (user.mustChangePassword) return <Navigate to="/change-password" replace />;
  return <Navigate to={homePathForRole(user.role)} replace />;
}
