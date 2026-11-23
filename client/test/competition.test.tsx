import { afterEach, expect, it, vi } from 'vitest';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { CompetitionSettings } from '../src/pages/admin/CompetitionSettings';
import { RESET_PHRASE } from '@judging/shared';

const auth = vi.hoisted(() => ({ email: 'youmna54@gmail.com' }));
vi.mock('../src/auth/AuthContext', () => ({
  useAuth: () => ({ user: { email: auth.email, role: 'admin' } }),
}));
afterEach(() => {
  vi.unstubAllGlobals();
  results = { official: { teams: [] }, provisional: [], notRanked: [] };
  auth.email = 'youmna54@gmail.com';
});
const team = (teamCode: string, assignedJudges: number) => ({
  teamId: Number(teamCode.slice(-1)),
  teamCode,
  name: teamCode,
  projectName: teamCode,
  assignedJudges,
});
let results: unknown = {
  official: { teams: [] },
  provisional: [],
  notRanked: [],
};
function setup(state = 'preparation', enabled = false) {
  const writes: { path: string; body: Record<string, unknown> }[] = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (path: string, init?: RequestInit) => {
      const body = init?.body ? JSON.parse(String(init.body)) : null;
      if (body) writes.push({ path, body });
      const preview = {
        token: 'a'.repeat(64),
        expiresAt: new Date(Date.now() + 600000).toISOString(),
        counts: { teams: 3, users: 4, evaluations: 9 },
        preservedEmail: auth.email,
        backup: { name: 'fixture.sql', bytes: 10000, sha256: 'b'.repeat(64) },
      };
      if (path.startsWith('/api/admin/results'))
        return new Response(JSON.stringify(results), {
          headers: { 'Content-Type': 'application/json' },
        });
      const data = path.endsWith('/preview')
        ? preview
        : path.endsWith('/execute')
          ? {
              error: {
                code: 'RESET_REFUSED',
                message: 'Data changed after preview. No data was deleted.',
              },
            }
          : {
              state,
              rowVersion: 7,
              lockedRubricVersionNo: 3,
              lockedRubricVersionId: 33,
              resetExecutionEnabled: enabled,
            };
      return new Response(JSON.stringify(data), {
        status: path.endsWith('/execute') ? 409 : 200,
        headers: { 'Content-Type': 'application/json' },
      });
    }),
  );
  render(
    <QueryClientProvider
      client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}
    >
      <CompetitionSettings />
    </QueryClientProvider>,
  );
  return writes;
}
it('requires confirmation and sends the captured lifecycle version', async () => {
  const writes = setup();
  await userEvent.click(await screen.findByRole('button', { name: 'Start competition' }));
  expect(writes).toHaveLength(0);
  await userEvent.click(screen.getByRole('button', { name: 'Confirm start' }));
  await waitFor(() =>
    expect(writes).toContainEqual({
      path: '/api/admin/competition/transition',
      body: { target: 'judging_open', rowVersion: 7, confirmed: true },
    }),
  );
});
it('shows locked rubric while open, and no transition controls after closing', async () => {
  setup('closed');
  await screen.findByText('Closed — final results');
  expect(screen.queryByRole('button', { name: 'Start competition' })).not.toBeInTheDocument();
  expect(screen.queryByRole('button', { name: 'Close competition' })).not.toBeInTheDocument();
});
it('hides the reset controls from other administrators', async () => {
  auth.email = 'another@example.com';
  setup();
  await screen.findByText('Preparation');
  expect(screen.queryByText('Danger Zone')).not.toBeInTheDocument();
});
it('allows a verified backup preview while execution remains disabled', async () => {
  const writes = setup();
  await screen.findByText('Preparation');
  await userEvent.type(
    screen.getByLabelText('Current password for backup and preview'),
    'Fixture password',
  );
  await userEvent.click(screen.getByRole('button', { name: 'Create backup and deletion preview' }));
  await screen.findByText('Review deletion preview');
  expect(writes[0]).toEqual({
    path: '/api/admin/competition/reset/preview',
    body: { password: 'Fixture password' },
  });
  expect(screen.getByRole('button', { name: 'Reset Competition…' })).toBeDisabled();
  expect(screen.getByLabelText('Verify current password again')).toHaveValue('');
  expect(screen.getByText(/fixture.sql/)).toHaveTextContent('b'.repeat(64));
});
it('requires the exact phrase, a second password entry and final confirmation; preserves the preview on conflict', async () => {
  const writes = setup('preparation', true);
  await screen.findByText('Preparation');
  await userEvent.type(
    screen.getByLabelText('Current password for backup and preview'),
    'Fixture password',
  );
  await userEvent.click(screen.getByRole('button', { name: 'Create backup and deletion preview' }));
  await screen.findByText('Review deletion preview');
  const button = screen.getByRole('button', { name: 'Reset Competition…' });
  expect(button).toBeDisabled();
  await userEvent.type(screen.getByLabelText('Verify current password again'), 'Fixture password');
  await userEvent.type(screen.getByLabelText(`Type ${RESET_PHRASE}`), RESET_PHRASE);
  expect(button).toBeEnabled();
  await userEvent.click(button);
  expect(writes).toHaveLength(1);
  const modal = screen.getByRole('dialog');
  await userEvent.click(within(modal).getByRole('button', { name: 'Confirm permanent reset' }));
  await within(modal).findByText('Data changed after preview. No data was deleted.');
  expect(writes[1]?.body).toMatchObject({
    token: 'a'.repeat(64),
    password: 'Fixture password',
    phrase: RESET_PHRASE,
    confirmed: true,
  });
  expect(screen.getByText('Review deletion preview')).toBeInTheDocument();
});

it('warns about active teams with fewer than three judges without blocking the start', async () => {
  results = {
    official: { teams: [team('T-1', 3)] },
    provisional: [],
    notRanked: [team('T-2', 2), team('T-3', 0)],
  };
  setup();
  expect(await screen.findByText('2 active teams have fewer than 3 judges')).toBeInTheDocument();
  expect(screen.getByText(/T-2 \(2\), T-3 \(0\)/)).toBeInTheDocument();
  expect(screen.getByRole('button', { name: 'Start competition' })).toBeEnabled();
});
