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
function setup(
  state = 'preparation',
  enabled = false,
  { maintenanceAvailable = true, previewError = '' } = {},
) {
  const writes: { path: string; body: Record<string, unknown> }[] = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (path: string, init?: RequestInit) => {
      const body = init?.body ? JSON.parse(String(init.body)) : null;
      if (body) writes.push({ path, body });
      const preview = {
        token: 'a'.repeat(64),
        expiresAt: new Date(Date.now() + 600000).toISOString(),
        database: 'judging_platform',
        counts: { teams: 3, projects: 3, users: 4, evaluations: 9 },
        preservedAccounts: [
          { id: 1, email: 'youmna54@gmail.com', fullName: 'A', role: 'admin', status: 'active' },
          {
            id: 2,
            email: 'abdelrhman.elagan@ischooltech.com',
            fullName: 'B',
            role: 'admin',
            status: 'active',
          },
          {
            id: 3,
            email: 'nada.hussien@ischooltech.com',
            fullName: 'C',
            role: 'judge',
            status: 'active',
          },
        ],
        backup: {
          name: 'fixture.sql',
          bytes: 10000,
          sha256: 'b'.repeat(64),
          checksumVerified: true,
          restoreVerified: true,
          restored: { tables: 19, rows: 120, triggers: 30, routines: 1 },
        },
      };
      if (path.endsWith('/preview') && previewError)
        return new Response(
          JSON.stringify({ error: { code: 'RESET_REFUSED', message: previewError } }),
          { status: 409, headers: { 'Content-Type': 'application/json' } },
        );
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
              maintenanceAvailable,
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
  expect(screen.getByText(/fixture.sql/)).toBeInTheDocument();
  expect(screen.getByText(`SHA-256 ${'b'.repeat(64)}`)).toBeInTheDocument();
  expect(screen.getByText(/Restored into an isolated database/)).toHaveTextContent('19 tables');
  // Deletion total excludes the duplicated project count: 3 teams + 4 users + 9 evaluations.
  expect(screen.getByText('Total records').nextSibling).toHaveTextContent((16).toLocaleString());
  for (const [email, id] of [
    ['youmna54@gmail.com', '1'],
    ['abdelrhman.elagan@ischooltech.com', '2'],
    ['nada.hussien@ischooltech.com', '3'],
  ] as [string, string][]) {
    const row = screen.getByText(email).closest('tr')!;
    expect(within(row).getByText(id)).toBeInTheDocument();
    expect(within(row).getByText('Verified · kept unchanged')).toBeInTheDocument();
  }
  expect(screen.getByText(/Reset execution is disabled on this server/)).toBeInTheDocument();
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

it('always lists the three preserved accounts before any preview', async () => {
  setup();
  await screen.findByText('Preserved Accounts');
  for (const email of [
    'youmna54@gmail.com',
    'nada.hussien@ischooltech.com',
    'abdelrhman.elagan@ischooltech.com',
  ])
    expect(screen.getByText(email)).toBeInTheDocument();
  expect(screen.getAllByText('Checked at preview')).toHaveLength(3);
});

it('shows a clear error when a preserved account is missing', async () => {
  const message =
    'Reset blocked: this preserved account does not exist: nada.hussien@ischooltech.com. Create it first. No backup was taken and nothing was deleted.';
  setup('preparation', true, { previewError: message });
  await screen.findByText('Preparation');
  await userEvent.type(
    screen.getByLabelText('Current password for backup and preview'),
    'Fixture password',
  );
  await userEvent.click(screen.getByRole('button', { name: 'Create backup and deletion preview' }));
  expect(await screen.findByText(message)).toBeInTheDocument();
  expect(screen.queryByText('Review deletion preview')).not.toBeInTheDocument();
});

it('disables backup and preview when maintenance is off on the server', async () => {
  setup('preparation', false, { maintenanceAvailable: false });
  await screen.findByText('Maintenance is turned off on this server');
  expect(screen.getByLabelText('Current password for backup and preview')).toBeDisabled();
  expect(screen.getByRole('button', { name: 'Create backup and deletion preview' })).toBeDisabled();
});
