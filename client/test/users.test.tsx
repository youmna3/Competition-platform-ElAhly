import { afterEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter, Route, Routes } from 'react-router';
import type { AuthUser, ManagedUser } from '@judging/shared';
import { AuthProvider } from '../src/auth/AuthContext';
import { RequireAuth } from '../src/auth/RequireAuth';
import { AppLayout } from '../src/components/AppLayout';
import { ToastProvider } from '../src/components/Toast';
import { UsersPage } from '../src/pages/admin/users/UsersPage';

const me: AuthUser = {
  id: 1,
  email: 'youmna54@gmail.com',
  fullName: 'Youmna Admin',
  role: 'admin',
  mustChangePassword: false,
};

const base = {
  mustChangePassword: false,
  isLocked: false,
  createdAt: '2026-11-22T10:00:00.000Z',
  assignedTeams: 0,
};
const users: ManagedUser[] = [
  {
    ...base,
    id: 1,
    email: me.email,
    fullName: 'Youmna Admin',
    role: 'admin',
    status: 'active',
    lastLoginAt: '2026-11-22T12:00:00.000Z',
  },
  {
    ...base,
    id: 2,
    email: 'judge@example.com',
    fullName: 'Judge One',
    role: 'judge',
    status: 'active',
    lastLoginAt: null,
    mustChangePassword: true,
  },
  {
    ...base,
    id: 3,
    email: 'old@example.com',
    fullName: 'Old Judge',
    role: 'judge',
    status: 'disabled',
    lastLoginAt: null,
  },
];

interface Call {
  url: string;
  method: string;
  body: unknown;
}

function mockApi(
  overrides: (call: Call) => { status: number; body?: unknown } | undefined = () => undefined,
) {
  const calls: Call[] = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const call = {
        url: String(input),
        method: init?.method ?? 'GET',
        body: init?.body ? JSON.parse(String(init.body)) : undefined,
      };
      calls.push(call);
      const custom = overrides(call);
      const { status, body } =
        custom ??
        (call.url === '/api/auth/me'
          ? { status: 200, body: { user: me } }
          : call.url.startsWith('/api/admin/users?')
            ? {
                status: 200,
                body: { users, total: users.length, page: 1, pageSize: 25, activeAdmins: 1 },
              }
            : { status: 404, body: { error: { code: 'NOT_FOUND', message: 'nope' } } });
      return new Response(JSON.stringify(body), {
        status,
        headers: { 'Content-Type': 'application/json' },
      });
    }),
  );
  return calls;
}

function renderUsers() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <MemoryRouter initialEntries={['/admin/users']}>
        <AuthProvider>
          <ToastProvider>
            <Routes>
              <Route
                element={
                  <RequireAuth>
                    <AppLayout />
                  </RequireAuth>
                }
              >
                <Route
                  path="/admin/users"
                  element={
                    <RequireAuth roles={['admin']}>
                      <UsersPage />
                    </RequireAuth>
                  }
                />
                <Route path="/judge" element={<p>Judge area</p>} />
                <Route path="/admin" element={<p>Admin dashboard</p>} />
              </Route>
              <Route path="/login" element={<p>Sign-in page</p>} />
            </Routes>
          </ToastProvider>
        </AuthProvider>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('Users page', () => {
  it('appears in the administrator navigation and lists every account', async () => {
    mockApi();
    renderUsers();
    expect(await screen.findByRole('link', { name: 'Users' })).toBeInTheDocument();
    const table = await screen.findByRole('table');
    expect(within(table).getByText('Judge One')).toBeInTheDocument();
    expect(within(table).getByText('old@example.com')).toBeInTheDocument();
    expect(within(table).getByText('Must change password')).toBeInTheDocument();
    expect(within(table).getAllByText('Never').length).toBeGreaterThan(0);
    expect(within(table).getByText('(you)')).toBeInTheDocument();
  });

  it('never offers to disable yourself or reset your own password here', async () => {
    mockApi();
    renderUsers();
    await screen.findByRole('table');
    expect(screen.queryByRole('button', { name: 'Disable Youmna Admin' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Reset password for Youmna Admin' })).toBeNull();
    expect(screen.getAllByRole('button', { name: 'Reactivate Old Judge' }).length).toBeGreaterThan(
      0,
    );
  });

  it('sends search and filters to the server', async () => {
    const calls = mockApi();
    renderUsers();
    await screen.findByRole('table');
    const user = userEvent.setup();
    await user.selectOptions(screen.getByLabelText('Role'), 'judge');
    await user.selectOptions(screen.getByLabelText('Status'), 'disabled');
    await user.type(screen.getByLabelText('Search'), 'old');
    await waitFor(() =>
      expect(
        calls.some(
          (c) =>
            c.url.includes('role=judge') &&
            c.url.includes('status=disabled') &&
            c.url.includes('search=old'),
        ),
      ).toBe(true),
    );
  });

  it('creates a judge and shows the temporary password once, behind an acknowledgement', async () => {
    const created: ManagedUser = {
      ...base,
      id: 9,
      email: 'mona@example.com',
      fullName: 'Mona Hassan',
      role: 'judge',
      status: 'active',
      lastLoginAt: null,
      mustChangePassword: true,
    };
    const calls = mockApi((c) =>
      c.method === 'POST' && c.url === '/api/admin/users'
        ? { status: 201, body: { user: created, temporaryPassword: 'Tmp-Pass-Shown-Once-1!' } }
        : undefined,
    );
    renderUsers();
    await screen.findByRole('table');
    const user = userEvent.setup();
    await user.click(screen.getByRole('button', { name: '+ Add user' }));
    const dialog = screen.getByRole('dialog', { name: 'Add a user' });
    await user.type(within(dialog).getByLabelText('Full name'), 'Mona Hassan');
    await user.type(within(dialog).getByLabelText('E-mail'), 'mona@example.com');
    await user.click(within(dialog).getByRole('button', { name: 'Create account' }));

    const shown = await screen.findByRole('dialog', { name: 'Account created' });
    expect(within(shown).getByTestId('temporary-password')).toHaveTextContent(
      'Tmp-Pass-Shown-Once-1!',
    );
    expect(calls.find((c) => c.method === 'POST')?.body).toEqual({
      fullName: 'Mona Hassan',
      email: 'mona@example.com',
      role: 'judge',
    });
    const done = within(shown).getByRole('button', { name: 'Done' });
    expect(done).toBeDisabled();
    await user.click(within(shown).getByLabelText('I have copied or written down this password.'));
    await user.click(done);
    expect(screen.queryByText('Tmp-Pass-Shown-Once-1!')).toBeNull();
    expect(await screen.findByText('Account created for Mona Hassan.')).toBeInTheDocument();
  });

  it('shows a duplicate e-mail error inside the dialog', async () => {
    mockApi((c) =>
      c.method === 'POST'
        ? {
            status: 409,
            body: {
              error: {
                code: 'EMAIL_TAKEN',
                message: 'An account with this e-mail address already exists.',
              },
            },
          }
        : undefined,
    );
    renderUsers();
    await screen.findByRole('table');
    const user = userEvent.setup();
    await user.click(screen.getByRole('button', { name: '+ Add user' }));
    const dialog = screen.getByRole('dialog', { name: 'Add a user' });
    await user.type(within(dialog).getByLabelText('Full name'), 'Copy Cat');
    await user.type(within(dialog).getByLabelText('E-mail'), 'judge@example.com');
    await user.click(within(dialog).getByRole('button', { name: 'Create account' }));
    expect(await within(dialog).findByRole('alert')).toHaveTextContent('already exists');
  });

  it('asks for confirmation before disabling, then disables', async () => {
    const calls = mockApi((c) =>
      c.method === 'PATCH'
        ? { status: 200, body: { user: { ...users[1], status: 'disabled' } } }
        : undefined,
    );
    renderUsers();
    await screen.findByRole('table');
    const user = userEvent.setup();
    await user.click(
      screen.getAllByRole('button', { name: 'Disable Judge One' })[0] as HTMLElement,
    );
    const confirm = screen.getByRole('dialog', { name: 'Disable Judge One?' });
    expect(within(confirm).getByText(/signed out immediately/)).toBeInTheDocument();
    expect(calls.some((c) => c.method === 'PATCH')).toBe(false);
    await user.click(within(confirm).getByRole('button', { name: 'Disable account' }));
    await waitFor(() =>
      expect(calls.find((c) => c.method === 'PATCH')).toMatchObject({
        url: '/api/admin/users/2',
        body: { status: 'disabled' },
      }),
    );
    expect(await screen.findByText('Judge One was disabled and signed out.')).toBeInTheDocument();
  });

  it('resets a password after confirmation and shows the new temporary password', async () => {
    mockApi((c) =>
      c.url === '/api/admin/users/2/reset-password'
        ? { status: 200, body: { user: users[1], temporaryPassword: 'New-Temp-Pass-22!' } }
        : undefined,
    );
    renderUsers();
    await screen.findByRole('table');
    const user = userEvent.setup();
    await user.click(
      screen.getAllByRole('button', { name: 'Reset password for Judge One' })[0] as HTMLElement,
    );
    await user.click(
      within(screen.getByRole('dialog')).getByRole('button', { name: 'Reset password' }),
    );
    const shown = await screen.findByRole('dialog', { name: 'Password reset' });
    expect(within(shown).getByTestId('temporary-password')).toHaveTextContent('New-Temp-Pass-22!');
  });

  it('locks the role of the last active administrator in the edit dialog', async () => {
    mockApi();
    renderUsers();
    await screen.findByRole('table');
    const user = userEvent.setup();
    await user.click(
      screen.getAllByRole('button', { name: 'Edit Youmna Admin' })[0] as HTMLElement,
    );
    const dialog = screen.getByRole('dialog');
    expect(within(dialog).getByLabelText('Role')).toBeDisabled();
    expect(within(dialog).getByText(/last active administrator/)).toBeInTheDocument();
  });

  it('signs out from the Users page and stays signed out', async () => {
    let signedIn = true;
    mockApi((c) => {
      if (c.url === '/api/auth/logout') {
        signedIn = false;
        return { status: 204 };
      }
      if (c.url === '/api/auth/me')
        return signedIn
          ? { status: 200, body: { user: me } }
          : {
              status: 401,
              body: { error: { code: 'NOT_AUTHENTICATED', message: 'Please sign in.' } },
            };
      if (!signedIn)
        return {
          status: 401,
          body: { error: { code: 'NOT_AUTHENTICATED', message: 'Please sign in.' } },
        };
      return undefined;
    });
    renderUsers();
    await screen.findByRole('table');
    await userEvent.setup().click(screen.getByRole('button', { name: 'Sign out' }));
    expect(await screen.findByText('Sign-in page')).toBeInTheDocument();
    await new Promise((r) => setTimeout(r, 300));
    expect(screen.queryByText('Admin dashboard')).toBeNull();
    expect(screen.getByText('Sign-in page')).toBeInTheDocument();
  });

  it('is not reachable for judges', async () => {
    mockApi((c) =>
      c.url === '/api/auth/me'
        ? { status: 200, body: { user: { ...me, role: 'judge' } } }
        : undefined,
    );
    renderUsers();
    expect(await screen.findByText('Judge area')).toBeInTheDocument();
    expect(screen.queryByRole('link', { name: 'Users' })).toBeNull();
  });
});
