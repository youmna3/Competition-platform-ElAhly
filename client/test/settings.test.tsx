import { expect, it, vi, afterEach } from 'vitest';
import { render, screen, waitFor, within } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router';
import App from '../src/App';
import { AuthProvider } from '../src/auth/AuthContext';
import { ToastProvider } from '../src/components/Toast';

afterEach(() => vi.unstubAllGlobals());
function setup(role: 'admin' | 'judge', path: string) {
  const calls: string[] = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      calls.push(url);
      let data: unknown = { assignments: [] };
      if (url === '/api/auth/me')
        data = {
          user: {
            id: 1,
            email: 'fixture@example.com',
            fullName: 'Fixture',
            role,
            mustChangePassword: false,
          },
        };
      if (url === '/api/admin/health')
        data = {
          status: 'ok',
          app: { environment: 'private_config', version: 'private_version', uptimeSeconds: 3 },
          database: {
            status: 'ok',
            database: 'private_database',
            serverVersion: 'private_server',
            latencyMs: 1,
          },
          time: new Date().toISOString(),
        };
      return new Response(JSON.stringify(data), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    }),
  );
  render(
    <QueryClientProvider
      client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}
    >
      <MemoryRouter initialEntries={[path]}>
        <AuthProvider>
          <ToastProvider>
            <App />
          </ToastProvider>
        </AuthProvider>
      </MemoryRouter>
    </QueryClientProvider>,
  );
  return calls;
}
it('places the admin status action inside Settings, outside main navigation', async () => {
  setup('admin', '/admin/settings');
  expect(await screen.findByRole('heading', { name: 'Settings' })).toBeInTheDocument();
  const nav = screen.getByRole('navigation', { name: 'Main' });
  expect(within(nav).queryByRole('link', { name: /System status/i })).not.toBeInTheDocument();
  expect(within(nav).getByRole('link', { name: 'Settings' })).toBeInTheDocument();
  expect(screen.getByRole('link', { name: 'Open System Status' })).toHaveAttribute(
    'href',
    '/admin/settings/status',
  );
});
it.each(['/admin/settings', '/admin/settings/status', '/admin/status'])(
  'blocks judge direct access to %s without fetching health',
  async (path) => {
    const calls = setup('judge', path);
    await screen.findByRole('navigation', { name: 'Main' });
    await waitFor(() =>
      expect(calls.some((url) => url.startsWith('/api/judge/assignments'))).toBe(true),
    );
    expect(calls).not.toContain('/api/admin/health');
    expect(screen.queryByRole('link', { name: 'Settings' })).not.toBeInTheDocument();
    expect(
      screen.queryByText(/private_database|private_config|private_server/),
    ).not.toBeInTheDocument();
  },
);
it('shows availability to admins without rendering database names or configuration', async () => {
  setup('admin', '/admin/settings/status');
  await screen.findByText('Response time');
  expect(
    screen.queryByText(/private_database|private_config|private_version|private_server/),
  ).not.toBeInTheDocument();
});
