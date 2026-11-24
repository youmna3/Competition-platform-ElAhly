import { afterEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter, Route, Routes } from 'react-router';
import type {
  AssignableUser,
  AuthUser,
  ImportPreview,
  JudgeAssignment,
  TeamSummary,
} from '@judging/shared';
import { AuthProvider } from '../src/auth/AuthContext';
import { RequireAuth } from '../src/auth/RequireAuth';
import { AppLayout } from '../src/components/AppLayout';
import { ToastProvider } from '../src/components/Toast';
import { TeamsPage } from '../src/pages/admin/teams/TeamsPage';
import { TeamDetailsPage } from '../src/pages/admin/teams/TeamDetailsPage';
import { TeamImportPage } from '../src/pages/admin/teams/TeamImportPage';
import { JudgeTeamsPage } from '../src/pages/judge/JudgeTeamsPage';
import { TeamFormDialog } from '../src/pages/admin/teams/dialogs';
import { TeamResources } from '../src/components/TeamResources';

const adminUser: AuthUser = {
  id: 1,
  email: 'youmna54@gmail.com',
  fullName: 'Youmna Admin',
  role: 'admin',
  mustChangePassword: false,
};
const judgeUser: AuthUser = {
  ...adminUser,
  id: 2,
  email: 'judge@example.com',
  fullName: 'Judge One',
  role: 'judge',
};

const team = (id: number, teamCode: string, extra: Partial<TeamSummary> = {}): TeamSummary => ({
  id,
  teamCode,
  name: `Team ${teamCode}`,
  projectName: `Project ${teamCode}`,
  status: 'active',
  createdAt: '2026-11-22T10:00:00.000Z',
  archivedAt: null,
  assignedJudges: 0,
  submittedEvaluations: 0,
  draftEvaluations: 0,
  mixedVersions: false,
  ...extra,
});
const teams = [
  team(1, 'AHL-001', { assignedJudges: 2, submittedEvaluations: 1 }),
  team(2, 'AHL-002'),
];
const assignable: AssignableUser[] = [
  { id: 2, email: 'judge@example.com', fullName: 'Judge One', role: 'judge', assignedTeams: 1 },
  { id: 3, email: 'judge2@example.com', fullName: 'Judge Two', role: 'judge', assignedTeams: 0 },
];

interface Call {
  url: string;
  method: string;
  body: unknown;
}

function mockApi(
  me: AuthUser,
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
      const { status, body } =
        overrides(call) ??
        (call.url === '/api/auth/me'
          ? { status: 200, body: { user: me } }
          : call.url.startsWith('/api/admin/teams?')
            ? { status: 200, body: { teams, total: teams.length, page: 1, pageSize: 25 } }
            : call.url === '/api/admin/assignable-users'
              ? { status: 200, body: { users: assignable } }
              : { status: 404, body: { error: { code: 'NOT_FOUND', message: 'nope' } } });
      return new Response(status === 204 ? null : JSON.stringify(body), {
        status,
        headers: { 'Content-Type': 'application/json' },
      });
    }),
  );
  return calls;
}

function renderAt(path: string) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <MemoryRouter initialEntries={[path]}>
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
                  path="/admin/teams"
                  element={
                    <RequireAuth roles={['admin']}>
                      <TeamsPage />
                    </RequireAuth>
                  }
                />
                <Route
                  path="/admin/teams/import"
                  element={
                    <RequireAuth roles={['admin']}>
                      <TeamImportPage />
                    </RequireAuth>
                  }
                />
                <Route
                  path="/judge"
                  element={
                    <RequireAuth roles={['judge', 'admin']}>
                      <JudgeTeamsPage />
                    </RequireAuth>
                  }
                />
                <Route path="/admin/teams/:id" element={<TeamDetailsPage />} />
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

describe('team resource forms and judge display', () => {
  it('requires two names on create and submits the optional third and links', async () => {
    const submit = vi.fn(async () => {});
    render(<TeamFormDialog onSubmit={submit} onClose={() => {}} />);
    await userEvent.type(screen.getByLabelText(/Team ID/), 'NEW-1');
    await userEvent.type(screen.getByLabelText('Team name'), 'New team');
    await userEvent.type(screen.getByLabelText('Project name'), 'New project');
    expect(screen.getByRole('button', { name: 'Create team' })).toBeDisabled();
    await userEvent.type(screen.getByLabelText(/Student 1 full name/), 'Student A');
    expect(screen.getByRole('button', { name: 'Create team' })).toBeDisabled();
    await userEvent.type(screen.getByLabelText(/Student 2 full name/), 'Student B');
    await userEvent.type(screen.getByLabelText(/Student 3 full name/), 'Student C');
    await userEvent.type(screen.getByLabelText('Presentation Link'), 'https://example.com/slides');
    await userEvent.type(screen.getByLabelText('Project Website Link'), 'https://example.com');
    await userEvent.click(screen.getByRole('button', { name: 'Create team' }));
    expect(submit).toHaveBeenCalledWith({
      teamCode: 'NEW-1',
      name: 'New team',
      projectName: 'New project',
      studentNames: ['Student A', 'Student B', 'Student C'],
      presentationLink: 'https://example.com/slides',
      projectWebsiteLink: 'https://example.com',
    });
  });
  it('populates existing details and permits clearing an optional link', async () => {
    const submit = vi.fn(async () => {});
    render(
      <TeamFormDialog
        team={team(1, 'T-1', {
          studentNames: ['Student A', 'Student B'],
          presentationLink: 'https://example.com/slides',
          projectWebsiteLink: 'https://example.com',
        })}
        onSubmit={submit}
        onClose={() => {}}
      />,
    );
    expect(screen.getByLabelText(/Student 1 full name/)).toHaveValue('Student A');
    expect(screen.getByLabelText(/Student 2 full name/)).toHaveValue('Student B');
    expect(screen.getByLabelText('Presentation Link')).toHaveValue('https://example.com/slides');
    await userEvent.clear(screen.getByLabelText('Presentation Link'));
    await userEvent.click(screen.getByRole('button', { name: 'Save changes' }));
    expect(submit).toHaveBeenCalledWith(
      expect.objectContaining({
        studentNames: ['Student A', 'Student B'],
        presentationLink: null,
        projectWebsiteLink: 'https://example.com',
      }),
    );
  });
  it('shows students and safe external links while withholding unsafe schemes', () => {
    const { rerender } = render(
      <TeamResources
        team={{
          studentNames: ['Student A', 'Student B'],
          presentationLink: 'https://example.com/slides',
          projectWebsiteLink: 'https://example.com',
        }}
      />,
    );
    expect(screen.getByText('Student A')).toBeVisible();
    expect(screen.getByRole('link', { name: 'Open Presentation' })).toHaveAttribute(
      'rel',
      'noopener noreferrer',
    );
    expect(screen.getByRole('link', { name: 'Open Project Website' })).toHaveAttribute(
      'target',
      '_blank',
    );
    rerender(<TeamResources team={{ presentationLink: 'javascript:alert(1)' }} />);
    expect(screen.queryByRole('link')).not.toBeInTheDocument();
    expect(screen.getByText(/Student details have not been provided/)).toBeVisible();
  });
});

describe('Teams page', () => {
  it.each(['/admin/teams', '/admin/teams/1'])(
    'saves resource-only edits through the page handler at %s',
    async (path) => {
      const resourceTeam = team(1, 'AHL-001', {
        studentNames: ['Student A', 'Student B'],
        presentationLink: 'https://example.com/slides',
        projectWebsiteLink: 'https://example.com',
      });
      const details = {
        ...resourceTeam,
        archiveReason: null,
        createdByEmail: null,
        provisionalAverage: null,
        readyForResults: false,
        lastUpdatedAt: null,
        assignments: [],
        pastEvaluations: [],
      };
      const calls = mockApi(adminUser, (c) =>
        c.url === '/api/admin/teams/1'
          ? { status: 200, body: { team: details } }
          : c.url.startsWith('/api/admin/teams?')
            ? { status: 200, body: { teams: [resourceTeam], total: 1, page: 1, pageSize: 25 } }
            : undefined,
      );
      renderAt(path);
      const edit = await screen.findAllByRole('button', { name: /^Edit/ });
      await userEvent.click(edit[0]!);
      const dialog = await screen.findByRole('dialog');
      await userEvent.type(within(dialog).getByLabelText(/Student 3 full name/), 'Student C');
      await userEvent.clear(within(dialog).getByLabelText('Presentation Link'));
      await userEvent.click(within(dialog).getByRole('button', { name: 'Save changes' }));
      await waitFor(() =>
        expect(
          calls.find((c) => c.url === '/api/admin/teams/1' && c.method === 'PATCH')?.body,
        ).toEqual({
          studentNames: ['Student A', 'Student B', 'Student C'],
          presentationLink: null,
        }),
      );
    },
  );
  it('appears in the administrator navigation and lists teams with progress', async () => {
    mockApi(adminUser);
    renderAt('/admin/teams');
    expect(await screen.findByRole('link', { name: 'Teams' })).toBeInTheDocument();
    expect((await screen.findAllByText('Team AHL-001')).length).toBeGreaterThan(0);
    expect(screen.getAllByText('1/2 submitted').length).toBeGreaterThan(0);
    expect(screen.queryByText(/governorate/i)).not.toBeInTheDocument();
  });

  it('sends the search to the server', async () => {
    const calls = mockApi(adminUser);
    renderAt('/admin/teams');
    await screen.findAllByText('Team AHL-001');
    await userEvent.type(screen.getByLabelText('Search'), 'falcons');
    await waitFor(() => expect(calls.some((c) => c.url.includes('search=falcons'))).toBe(true));
  });

  it('is not shown to judges', async () => {
    mockApi(judgeUser, (c) =>
      c.url === '/api/judge/assignments' ? { status: 200, body: { assignments: [] } } : undefined,
    );
    renderAt('/admin/teams');
    expect(await screen.findByText('My assigned teams')).toBeInTheDocument();
    expect(screen.queryByRole('link', { name: 'Teams' })).not.toBeInTheDocument();
  });

  it('bulk-assigns the chosen judges to the selected teams', async () => {
    const calls = mockApi(adminUser, (c) =>
      c.url === '/api/admin/assignments/bulk'
        ? { status: 200, body: { added: 3, alreadyAssigned: 1 } }
        : undefined,
    );
    renderAt('/admin/teams');
    await screen.findAllByText('Team AHL-001');
    await userEvent.click(screen.getAllByLabelText('Select AHL-001')[0]!);
    await userEvent.click(screen.getAllByLabelText('Select AHL-002')[0]!);
    const bar = screen.getByRole('region', { name: 'Bulk actions' });
    expect(within(bar).getByText('2 teams selected')).toBeInTheDocument();
    await userEvent.click(within(bar).getByRole('button', { name: 'Assign judges' }));

    const dialog = await screen.findByRole('dialog');
    await userEvent.click(await within(dialog).findByRole('checkbox', { name: /Judge One/ }));
    await userEvent.click(within(dialog).getByRole('checkbox', { name: /Judge Two/ }));
    await userEvent.click(within(dialog).getByRole('button', { name: 'Assign 2 judges' }));

    await waitFor(() => {
      const post = calls.find((c) => c.url === '/api/admin/assignments/bulk');
      expect(post?.body).toEqual({ teamIds: [1, 2], judgeIds: [2, 3] });
    });
  });
});

describe('Team import', () => {
  const csv =
    '﻿Team ID,Team Name,Project Name,Governorate\r\nAHL-001,Falcons,Irrigation,Cairo\r\nAHL-009,Lions,Recycling,\r\n';

  const preview: ImportPreview = {
    rows: [
      {
        rowNumber: 2,
        teamCode: 'AHL-001',
        action: 'update',
        errors: [],
        changes: { name: { from: 'Old', to: 'Falcons' } },
        warnings: [],
      },
      {
        rowNumber: 3,
        teamCode: 'AHL-009',
        action: 'create',
        errors: [],
        changes: {},
        warnings: [],
      },
    ],
    summary: { create: 1, update: 1, unchanged: 0, error: 0 },
  };

  it('previews the file, requires confirmation for updates, then imports', async () => {
    const calls = mockApi(adminUser, (c) =>
      c.url === '/api/admin/teams/import/preview'
        ? { status: 200, body: preview }
        : c.url === '/api/admin/teams/import/commit'
          ? { status: 200, body: { created: 1, updated: 1, unchanged: 0 } }
          : undefined,
    );
    renderAt('/admin/teams/import');
    const input = await screen.findByLabelText('Choose a team file (.xlsx or .csv)');
    await userEvent.upload(input, new File([csv], 'teams.csv', { type: 'text/csv' }));

    expect(await screen.findByText('3. Review and import')).toBeInTheDocument();
    const sent = calls.find((c) => c.url === '/api/admin/teams/import/preview')!.body as {
      rows: unknown[];
    };
    expect(sent.rows).toEqual([
      { rowNumber: 2, teamCode: 'AHL-001', name: 'Falcons', projectName: 'Irrigation' },
      { rowNumber: 3, teamCode: 'AHL-009', name: 'Lions', projectName: 'Recycling' },
    ]);
    expect(screen.getByText(/These columns are ignored: Governorate/)).toBeInTheDocument();

    const importButton = screen.getByRole('button', { name: 'Import 2 teams' });
    expect(importButton).toBeDisabled();
    await userEvent.click(screen.getByRole('checkbox', { name: /Update 1 existing team/ }));
    expect(importButton).toBeEnabled();
    await userEvent.click(importButton);

    expect(await screen.findByText('Import complete')).toBeInTheDocument();
    const commit = calls.find((c) => c.url === '/api/admin/teams/import/commit')!.body as {
      confirmUpdates: boolean;
    };
    expect(commit.confirmUpdates).toBe(true);
  });

  it('blocks the import while any row has an error', async () => {
    mockApi(adminUser, (c) =>
      c.url === '/api/admin/teams/import/preview'
        ? {
            status: 200,
            body: {
              rows: [
                {
                  rowNumber: 2,
                  teamCode: '',
                  action: 'error',
                  errors: ['Team ID is required.'],
                  changes: {},
                  warnings: [],
                },
              ],
              summary: { create: 0, update: 0, unchanged: 0, error: 1 },
            },
          }
        : undefined,
    );
    renderAt('/admin/teams/import');
    const input = await screen.findByLabelText('Choose a team file (.xlsx or .csv)');
    await userEvent.upload(
      input,
      new File(['Team ID,Team Name,Project Name\r\n,Falcons,P\r\n'], 'bad.csv', {
        type: 'text/csv',
      }),
    );
    expect(await screen.findByText('Team ID is required.')).toBeInTheDocument();
    expect(screen.getByText(/Nothing is imported while any row has an error/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Import 0 teams/ })).toBeDisabled();
  });
});

describe('Judge "My teams"', () => {
  it('shows progress, clear actions and filters submitted teams from pending work', async () => {
    const assignments: JudgeAssignment[] = ['not_started', 'draft', 'submitted'].map(
      (status, i) => ({
        teamId: i + 1,
        teamCode: `AHL-${i + 1}`,
        teamName: `Assigned team ${i + 1}`,
        projectName: `Project ${i + 1}`,
        evaluationStatus: status as JudgeAssignment['evaluationStatus'],
        assignedAt: '2026-11-22T10:00:00.000Z',
        ratedCount: i * 4,
        requiredCount: 8,
        totalScore: i === 2 ? 85 : null,
        submittedAt: null,
        rubricVersionNo: 1,
        outdatedVersion: false,
        reopenNotice: false,
        reopenReason: null,
      }),
    );
    mockApi(judgeUser, (c) =>
      c.url === '/api/judge/assignments'
        ? { status: 200, body: { assignments } }
        : c.url === '/api/judge/rubric'
          ? { status: 200, body: { rubric: { versionNo: 1 } } }
          : undefined,
    );
    renderAt('/judge');
    expect(
      await screen.findByRole('link', { name: 'Start evaluation of Assigned team 1' }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole('link', { name: 'Continue evaluation of Assigned team 2' }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole('link', { name: 'View evaluation of Assigned team 3' }),
    ).toBeInTheDocument();
    expect(screen.getByRole('progressbar', { name: 'Evaluations submitted' })).toHaveAttribute(
      'aria-valuenow',
      '33',
    );
    await userEvent.click(screen.getByRole('button', { name: 'Needs evaluation (2)' }));
    expect(screen.queryByText('Assigned team 3')).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Needs evaluation (2)' })).toHaveAttribute(
      'aria-pressed',
      'true',
    );
    await userEvent.click(screen.getByRole('button', { name: 'Submitted (1)' }));
    expect(
      screen.getByRole('link', { name: 'View evaluation of Assigned team 3' }),
    ).toBeInTheDocument();
    expect(screen.queryByText('Assigned team 1')).not.toBeInTheDocument();
  });

  it('lists assigned teams and says judging waits for the rubric to be published', async () => {
    const assignments: JudgeAssignment[] = [
      {
        teamId: 1,
        teamCode: 'AHL-001',
        teamName: 'Falcons',
        projectName: 'Irrigation',
        evaluationStatus: 'not_started',
        assignedAt: '2026-11-22T10:00:00.000Z',
        ratedCount: 0,
        requiredCount: 8,
        totalScore: null,
        submittedAt: null,
        rubricVersionNo: null,
        outdatedVersion: false,
        reopenNotice: false,
        reopenReason: null,
      },
    ];
    mockApi(judgeUser, (c) =>
      c.url === '/api/judge/assignments'
        ? { status: 200, body: { assignments } }
        : c.url === '/api/judge/rubric'
          ? { status: 200, body: { rubric: null } }
          : undefined,
    );
    renderAt('/judge');
    expect((await screen.findAllByText('Falcons')).length).toBeGreaterThan(0);
    expect(screen.getAllByText('Not started').length).toBeGreaterThan(0);
    expect(await screen.findByText('Judging hasn’t started yet')).toBeInTheDocument();
    expect(screen.queryByRole('link', { name: /Start evaluation/ })).not.toBeInTheDocument();
  });
});
