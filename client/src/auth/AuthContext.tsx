import { createContext, useCallback, useContext, useMemo, type ReactNode } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import type { AuthUser, ChangePasswordRequest, LoginRequest } from '@judging/shared';
import { api, ApiError } from '../api/client';

export const ME_QUERY_KEY = ['auth', 'me'] as const;

interface AuthContextValue {
  user: AuthUser | null;
  loading: boolean;
  login: (input: LoginRequest) => Promise<AuthUser>;
  logout: () => Promise<void>;
  changePassword: (input: ChangePasswordRequest) => Promise<AuthUser>;
}

const AuthContext = createContext<AuthContextValue | null>(null);

let sessionEndedNotice = false;

/** True once after a session expired or was ended by the server; reading it clears it. */
export function takeSessionEndedNotice(): boolean {
  const value = sessionEndedNotice;
  sessionEndedNotice = false;
  return value;
}

/** Called for any API 401: remembers whether an existing session ended. */
export function noteUnauthenticated(error: unknown) {
  if (error instanceof ApiError && error.status === 401 && error.code === 'SESSION_EXPIRED') {
    sessionEndedNotice = true;
  }
}

/** Returns the signed-in user, or null when there is no valid session. */
export async function fetchMe(): Promise<AuthUser | null> {
  try {
    const { user } = await api<{ user: AuthUser }>('/api/auth/me');
    return user;
  } catch (error) {
    if (error instanceof ApiError && error.status === 401) {
      noteUnauthenticated(error);
      return null;
    }
    throw error;
  }
}

export function AuthProvider({ children }: { children: ReactNode }) {
  const queryClient = useQueryClient();
  const me = useQuery({
    queryKey: ME_QUERY_KEY,
    queryFn: fetchMe,
    // Re-check now and then so an ended session is noticed even on an idle page.
    refetchInterval: 60_000,
    refetchOnWindowFocus: true,
    retry: false,
  });

  const login = useCallback(
    async (input: LoginRequest) => {
      const { user } = await api<{ user: AuthUser }>('/api/auth/login', {
        method: 'POST',
        body: input,
      });
      queryClient.setQueryData(ME_QUERY_KEY, user);
      return user;
    },
    [queryClient],
  );

  const logout = useCallback(async () => {
    try {
      await api('/api/auth/logout', { method: 'POST' });
    } finally {
      // Mark the user as signed out first, then drop every other cached answer.
      // (queryClient.clear() would detach the screen from the sign-in state and
      // briefly show the previous user.)
      queryClient.setQueryData(ME_QUERY_KEY, null);
      queryClient.removeQueries({ predicate: (query) => query.queryKey[0] !== ME_QUERY_KEY[0] });
    }
  }, [queryClient]);

  const changePassword = useCallback(
    async (input: ChangePasswordRequest) => {
      const { user } = await api<{ user: AuthUser }>('/api/auth/change-password', {
        method: 'POST',
        body: input,
      });
      queryClient.setQueryData(ME_QUERY_KEY, user);
      return user;
    },
    [queryClient],
  );

  const value = useMemo<AuthContextValue>(
    () => ({ user: me.data ?? null, loading: me.isPending, login, logout, changePassword }),
    [me.data, me.isPending, login, logout, changePassword],
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthContextValue {
  const value = useContext(AuthContext);
  if (!value) throw new Error('useAuth must be used inside <AuthProvider>');
  return value;
}
