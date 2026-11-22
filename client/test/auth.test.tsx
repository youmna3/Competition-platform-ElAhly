import { afterEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter, Route, Routes, useLocation } from 'react-router';
import type { AuthUser } from '@judging/shared';
import { AuthProvider } from '../src/auth/AuthContext';
import { RequireAuth } from '../src/auth/RequireAuth';
import { LoginPage } from '../src/pages/auth/LoginPage';
import { ChangePasswordPage } from '../src/pages/auth/ChangePasswordPage';

const admin: AuthUser = {
  id: 1,
  email: 'youmna54@gmail.com',
  fullName: 'Administrator',
  role: 'admin',
  mustChangePassword: false,
};
const judge: AuthUser = {
  id: 2,
  email: 'judge@example.com',
  fullName: 'Judge One',
  role: 'judge',
  mustChangePassword: false,
};

type Handler = (url: string, init?: RequestInit) => { status: number; body?: unknown };

function json(status: number, body?: unknown) {
  return new Response(body === undefined ? null : JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

function mockApi(handler: Handler) {
  const fn = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const { status, body } = handler(String(input), init);
    return json(status, body);
  });
  vi.stubGlobal('fetch', fn);
  return fn;
}

function Where() {
  const location = useLocation();
  return <p data-testid="where">{location.pathname}</p>;
}

function renderAt(path: string) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <MemoryRouter initialEntries={[path]}>
        <AuthProvider>
          <Routes>
            <Route path="/login" element={<LoginPage />} />
            <Route
              path="/change-password"
              element={
                <RequireAuth>
                  <ChangePasswordPage />
                </RequireAuth>
              }
            />
            <Route
              path="/admin"
              element={
                <RequireAuth roles={['admin']}>
                  <Where />
                </RequireAuth>
              }
            />
            <Route
              path="/judge"
              element={
                <RequireAuth roles={['judge', 'admin']}>
                  <Where />
                </RequireAuth>
              }
            />
          </Routes>
          <Where />
        </AuthProvider>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

const notSignedIn = {
  status: 401,
  body: { error: { code: 'NOT_AUTHENTICATED', message: 'Please sign in.' } },
};

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('login page', () => {
  it('has no public registration and explains how to recover a password', async () => {
    mockApi(() => notSignedIn);
    renderAt('/login');
    expect(await screen.findByRole('heading', { name: 'Sign in' })).toBeInTheDocument();
    expect(
      screen.queryByText(/sign up|register|create account/i, { selector: 'a,button' }),
    ).toBeNull();
    expect(screen.getByText(/Ask the competition administrator to reset it/)).toBeInTheDocument();
  });

  it('shows the server message for wrong credentials and clears the password', async () => {
    mockApi((url) =>
      url.endsWith('/login')
        ? {
            status: 401,
            body: {
              error: { code: 'INVALID_CREDENTIALS', message: 'Incorrect e-mail or password.' },
            },
          }
        : notSignedIn,
    );
    renderAt('/login');
    const user = userEvent.setup();
    await user.type(await screen.findByLabelText('E-mail'), 'youmna54@gmail.com');
    await user.type(screen.getByLabelText('Password'), 'wrong-password');
    await user.click(screen.getByRole('button', { name: 'Sign in' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('Incorrect e-mail or password.');
    expect(screen.getByLabelText('Password')).toHaveValue('');
  });

  it('shows the lockout message', async () => {
    mockApi((url) =>
      url.endsWith('/login')
        ? {
            status: 423,
            body: {
              error: {
                code: 'ACCOUNT_LOCKED',
                message: 'Too many failed sign-in attempts. This account is locked for 15 minutes.',
              },
            },
          }
        : notSignedIn,
    );
    renderAt('/login');
    const user = userEvent.setup();
    await user.type(await screen.findByLabelText('E-mail'), 'a@b.co');
    await user.type(screen.getByLabelText('Password'), 'x');
    await user.click(screen.getByRole('button', { name: 'Sign in' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('locked for 15 minutes');
  });

  it.each([
    ['an admin', admin, '/admin'],
    ['a judge', judge, '/judge'],
    [
      'someone with a temporary password',
      { ...admin, mustChangePassword: true },
      '/change-password',
    ],
  ])('sends %s to the right page after signing in', async (_who, account, target) => {
    let signedIn = false;
    mockApi((url) => {
      if (url.endsWith('/login')) {
        signedIn = true;
        return { status: 200, body: { user: account } };
      }
      return signedIn ? { status: 200, body: { user: account } } : notSignedIn;
    });
    renderAt('/login');
    const user = userEvent.setup();
    await user.type(await screen.findByLabelText('E-mail'), account.email);
    await user.type(screen.getByLabelText('Password'), 'Correct-Password-1!');
    await user.click(screen.getByRole('button', { name: 'Sign in' }));
    await waitFor(() => expect(screen.getAllByTestId('where')[0]).toHaveTextContent(target));
  });
});

describe('route guards', () => {
  it('sends visitors without a session to the login page', async () => {
    mockApi(() => notSignedIn);
    renderAt('/admin');
    expect(await screen.findByRole('heading', { name: 'Sign in' })).toBeInTheDocument();
  });

  it('sends a judge who opens an admin page back to their own area', async () => {
    mockApi(() => ({ status: 200, body: { user: judge } }));
    renderAt('/admin');
    await waitFor(() => expect(screen.getAllByTestId('where')[0]).toHaveTextContent('/judge'));
  });

  it('forces a password change before anything else', async () => {
    mockApi(() => ({ status: 200, body: { user: { ...admin, mustChangePassword: true } } }));
    renderAt('/admin');
    expect(
      await screen.findByRole('heading', { name: 'Choose your own password' }),
    ).toBeInTheDocument();
  });

  it('shows a "session ended" notice when the server ended the session', async () => {
    mockApi(() => ({
      status: 401,
      body: { error: { code: 'SESSION_EXPIRED', message: 'Your session has ended.' } },
    }));
    renderAt('/admin');
    expect(
      await screen.findByText('Your session ended. Please sign in again.'),
    ).toBeInTheDocument();
  });
});

describe('change password page', () => {
  it('enables saving only when every rule is met', async () => {
    mockApi(() => ({ status: 200, body: { user: { ...admin, mustChangePassword: true } } }));
    renderAt('/change-password');
    const user = userEvent.setup();
    const save = await screen.findByRole('button', { name: 'Save new password' });
    await user.type(screen.getByLabelText('Temporary password'), 'Temp-Admin-Pass-2026!');
    await user.type(screen.getByLabelText('New password'), 'short');
    expect(save).toBeDisabled();
    await user.clear(screen.getByLabelText('New password'));
    await user.type(screen.getByLabelText('New password'), 'Brand-New-Secret-77#');
    await user.type(screen.getByLabelText('Confirm new password'), 'Brand-New-Secret-78#');
    expect(save).toBeDisabled();
    await user.clear(screen.getByLabelText('Confirm new password'));
    await user.type(screen.getByLabelText('Confirm new password'), 'Brand-New-Secret-77#');
    expect(save).toBeEnabled();
  });

  it('shows the server error when the current password is wrong', async () => {
    mockApi((url) =>
      url.endsWith('/change-password')
        ? {
            status: 400,
            body: {
              error: {
                code: 'CURRENT_PASSWORD_INCORRECT',
                message: 'Your current password is incorrect.',
              },
            },
          }
        : { status: 200, body: { user: { ...admin, mustChangePassword: true } } },
    );
    renderAt('/change-password');
    const user = userEvent.setup();
    await user.type(await screen.findByLabelText('Temporary password'), 'Wrong-Temp-1!');
    await user.type(screen.getByLabelText('New password'), 'Brand-New-Secret-77#');
    await user.type(screen.getByLabelText('Confirm new password'), 'Brand-New-Secret-77#');
    await user.click(screen.getByRole('button', { name: 'Save new password' }));
    expect(await screen.findByRole('alert')).toHaveTextContent(
      'Your current password is incorrect.',
    );
  });
});
