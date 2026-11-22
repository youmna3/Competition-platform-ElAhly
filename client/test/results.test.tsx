import { afterEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter, Route, Routes } from 'react-router';
import type {
  AdminOverview,
  AuthUser,
  DashboardResponse,
  JudgeLeaderboardResponse,
  RankedTeam,
  ResultsResponse,
  TeamResult,
} from '@judging/shared';
import { AuthProvider } from '../src/auth/AuthContext';
import { RequireAuth } from '../src/auth/RequireAuth';
import { AppLayout } from '../src/components/AppLayout';
import { ToastProvider } from '../src/components/Toast';
import { AdminDashboardPage } from '../src/pages/admin/AdminDashboardPage';
import { LeaderboardPage } from '../src/pages/admin/results/LeaderboardPage';
import { CompetitionLeaderboardPage } from '../src/pages/judge/CompetitionLeaderboardPage';

const adminUser: AuthUser = {
  id: 1,
  email: 'youmna54@gmail.com',
  fullName: 'Youmna Admin',
  role: 'admin',
  mustChangePassword: false,
};
const judgeUser: AuthUser = { ...adminUser, id: 2, fullName: 'Judge One', role: 'judge' };

function team(code: string, extra: Partial<TeamResult> = {}): TeamResult {
  return {
    teamId: Number(code.slice(-1)),
    teamCode: code,
    name: `Team ${code}`,
    projectName: `Project ${code}`,
    status: 'ready',
    assignedJudges: 2,
    submitted: 2,
    pending: 0,
    versions: [1],
    provisionalAverage: null,
    reasons: [],
    judges: [
      {
        judgeId: 2,
        fullName: 'Judge One',
        role: 'judge',
        accountStatus: 'active',
        evaluationId: 1,
        status: 'submitted',
        reopened: false,
        score: 80,
        rubricVersionNo: 1,
      },
    ],
    ...extra,
  };
}
const ranked = (code: string, rank: number, score: number): RankedTeam => ({
  ...team(code),
  rank,
  score,
  rubricVersionNo: 1,
});

const results: ResultsResponse = {
  computedAt: '2026-11-22T10:00:00.000Z',
  publishedVersionNo: 1,
  official: {
    available: true,
    unavailableReason: null,
    rubricVersionNo: 1,
    teams: [ranked('AHL-1', 1, 85), ranked('AHL-2', 1, 85), ranked('AHL-3', 3, 80.3333333)],
  },
  provisional: [],
  notRanked: [
    team('AHL-4', {
      status: 'in_progress',
      submitted: 1,
      pending: 1,
      provisionalAverage: 72.5,
      reasons: ['1 of 2 judges submitted.', 'Waiting for Judge Two.'],
    }),
    team('AHL-5', {
      status: 'blocked',
      reasons: [
        'Judge Two is assigned but disabled. Reactivate the account or remove the assignment.',
      ],
    }),
  ],
  versionWarnings: [],
  totals: { activeTeams: 5, ready: 3, blocked: 1, inProgress: 1, notStarted: 0, unassigned: 0 },
};

interface Call {
  url: string;
}

function mockApi(me: AuthUser, handler: (url: string) => unknown) {
  const calls: Call[] = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      calls.push({ url });
      const body = url === '/api/auth/me' ? { user: me } : handler(url);
      return new Response(
        JSON.stringify(body ?? { error: { code: 'NOT_FOUND', message: 'nope' } }),
        { status: body ? 200 : 404, headers: { 'Content-Type': 'application/json' } },
      );
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
                  path="/admin"
                  element={
                    <RequireAuth roles={['admin']}>
                      <AdminDashboardPage />
                    </RequireAuth>
                  }
                />
                <Route
                  path="/admin/leaderboard"
                  element={
                    <RequireAuth roles={['admin']}>
                      <LeaderboardPage />
                    </RequireAuth>
                  }
                />
                <Route path="/judge" element={<p>Judge home</p>} />
                <Route path="/leaderboard" element={<CompetitionLeaderboardPage />} />
              </Route>
            </Routes>
          </ToastProvider>
        </AuthProvider>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

afterEach(() => vi.unstubAllGlobals());

describe('leaderboard', () => {
  it('shows the official ranking with shared ranks, two decimals and tie markers', async () => {
    mockApi(adminUser, (url) => (url.startsWith('/api/admin/results') ? results : undefined));
    renderAt('/admin/leaderboard');
    const table = await screen.findByRole('table', { name: 'Official ranking' });
    const rows = within(table).getAllByRole('row').slice(1);
    expect(rows.map((r) => within(r).getAllByRole('cell')[0]!.textContent)).toEqual([
      '1Tied',
      '1Tied',
      '3',
    ]);
    expect(within(rows[2]!).getByText('80.33')).toBeInTheDocument();
    expect(within(rows[0]!).getByText('85.00')).toBeInTheDocument();
    expect(screen.getByText(/administrators only · not public/)).toBeInTheDocument();
  });

  it('lists unranked teams separately with a labelled provisional average and the reason', async () => {
    mockApi(adminUser, (url) => (url.startsWith('/api/admin/results') ? results : undefined));
    renderAt('/admin/leaderboard');
    const section = (await screen.findByRole('heading', { name: /Not ranked yet \(2\)/ })).closest(
      'section',
    )!;
    expect(within(section).getByText('72.50')).toBeInTheDocument();
    expect(within(section).getAllByText(/Provisional average \(not official\)/)).toHaveLength(2);
    expect(within(section).getByText('Waiting for Judge Two.')).toBeInTheDocument();
    expect(within(section).getByText(/assigned but disabled/)).toBeInTheDocument();
    expect(within(section).getByText('Blocked')).toBeInTheDocument();
  });

  it('explains when no official ranking exists and shows provisional groups by version', async () => {
    const mixed: ResultsResponse = {
      ...results,
      official: {
        available: false,
        unavailableReason:
          'Ready teams were scored with different rubric versions (v1: AHL-1; v2: AHL-2).',
        rubricVersionNo: null,
        teams: [],
      },
      provisional: [
        { rubricVersionNo: 1, teams: [ranked('AHL-1', 1, 85)] },
        { rubricVersionNo: 2, teams: [{ ...ranked('AHL-2', 1, 90), rubricVersionNo: 2 }] },
      ],
    };
    mockApi(adminUser, (url) => (url.startsWith('/api/admin/results') ? mixed : undefined));
    renderAt('/admin/leaderboard');
    expect(
      await screen.findByText(/different rubric versions \(v1: AHL-1; v2: AHL-2\)/),
    ).toBeInTheDocument();
    expect(screen.queryByRole('table', { name: 'Official ranking' })).not.toBeInTheDocument();
    expect(
      screen.getByRole('table', { name: /Provisional ranking, rubric version 2/ }),
    ).toBeInTheDocument();
    expect(screen.getAllByText(/Provisional average \/ 100/).length).toBeGreaterThan(0);
  });

  it('sends search and sort to the server and refreshes on demand', async () => {
    const calls = mockApi(adminUser, (url) =>
      url.startsWith('/api/admin/results') ? results : undefined,
    );
    const user = userEvent.setup();
    renderAt('/admin/leaderboard');
    await screen.findByRole('table', { name: 'Official ranking' });
    await user.click(screen.getByRole('button', { name: 'Sort by Team' }));
    await waitFor(() =>
      expect(calls.some((c) => c.url.includes('sort=name') && c.url.includes('dir=asc'))).toBe(
        true,
      ),
    );
    await user.type(screen.getByLabelText('Search'), 'solar');
    await waitFor(() => expect(calls.some((c) => c.url.includes('search=solar'))).toBe(true));
    const before = calls.length;
    await user.click(screen.getByRole('button', { name: 'Refresh' }));
    await waitFor(() => expect(calls.length).toBeGreaterThan(before));
  });

  it('shows an empty state with no active teams', async () => {
    mockApi(adminUser, (url) =>
      url.startsWith('/api/admin/results')
        ? {
            ...results,
            official: { ...results.official, teams: [], available: false },
            notRanked: [],
            totals: {
              activeTeams: 0,
              ready: 0,
              blocked: 0,
              inProgress: 0,
              notStarted: 0,
              unassigned: 0,
            },
          }
        : undefined,
    );
    renderAt('/admin/leaderboard');
    expect(await screen.findByText('No active teams yet')).toBeInTheDocument();
  });

  it('keeps judges out of detailed admin results but offers the read-only leaderboard', async () => {
    const calls = mockApi(judgeUser, () => results);
    renderAt('/admin/leaderboard');
    expect(await screen.findByText('Judge home')).toBeInTheDocument();
    expect(calls.some((c) => c.url.startsWith('/api/admin/results'))).toBe(false);
    expect(screen.getByRole('link', { name: 'Leaderboard' })).toHaveAttribute(
      'href',
      '/leaderboard',
    );
  });
});

describe('authenticated competition leaderboard', () => {
  const summary: JudgeLeaderboardResponse = {
    computedAt: results.computedAt,
    official: {
      ...results.official,
      teams: results.official.teams.map(
        ({ teamId, teamCode, name, projectName, rank, score, rubricVersionNo }) => ({
          teamId,
          teamCode,
          name,
          projectName,
          rank,
          score,
          rubricVersionNo,
        }),
      ),
    },
    notRanked: [
      {
        teamId: 5,
        teamCode: 'AHL-5',
        name: 'Pending team',
        projectName: 'Water',
        status: 'blocked',
      },
    ],
    versionWarnings: [],
    totalTeams: 4,
  };

  it('lets judges open results directly without requesting admin details or showing admin actions', async () => {
    const calls = mockApi(judgeUser, (url) =>
      url.startsWith('/api/judge/leaderboard') ? summary : undefined,
    );
    renderAt('/leaderboard');
    const table = await screen.findByRole('table', { name: 'Official ranking' });
    expect(within(table).getAllByRole('row')).toHaveLength(4);
    expect(within(table).getAllByText('Tied')).toHaveLength(2);
    expect(within(table).getByText('80.33')).toBeInTheDocument();
    expect(screen.queryByText('Judge One:')).not.toBeInTheDocument();
    expect(screen.queryByRole('link', { name: 'Detailed results' })).not.toBeInTheDocument();
    expect(screen.queryByRole('link', { name: 'Team AHL-1' })).not.toBeInTheDocument();
    expect(screen.queryByText(/Provisional average/)).not.toBeInTheDocument();
    expect(calls.some((c) => c.url.startsWith('/api/admin/'))).toBe(false);
    expect(screen.getByRole('link', { name: 'Leaderboard' })).toHaveAttribute(
      'aria-current',
      'page',
    );
  });

  it('supports judge search, score sorting and refresh', async () => {
    const calls = mockApi(judgeUser, (url) =>
      url.startsWith('/api/judge/leaderboard') ? summary : undefined,
    );
    const user = userEvent.setup();
    renderAt('/leaderboard');
    await screen.findByRole('table', { name: 'Official ranking' });
    await user.click(screen.getByRole('button', { name: 'Sort by Final average' }));
    await waitFor(() => expect(calls.some((c) => c.url.includes('sort=score'))).toBe(true));
    await user.type(screen.getByLabelText('Search'), 'solar');
    await waitFor(() => expect(calls.some((c) => c.url.includes('search=solar'))).toBe(true));
    await waitFor(() => expect(screen.getByRole('button', { name: 'Refresh' })).toBeEnabled());
    const before = calls.length;
    await user.click(screen.getByRole('button', { name: 'Refresh' }));
    await waitFor(() => expect(calls.length).toBeGreaterThan(before));
    expect(calls.some((c) => c.url.startsWith('/api/admin/'))).toBe(false);
  });

  it('shows a rubric conflict without presenting provisional teams as official', async () => {
    mockApi(judgeUser, (url) =>
      url.startsWith('/api/judge/leaderboard')
        ? {
            ...summary,
            official: {
              available: false,
              teams: [],
              rubricVersionNo: null,
              unavailableReason: 'Teams use different rubric versions.',
            },
            notRanked: [{ ...summary.notRanked[0]!, status: 'version_conflict' }],
          }
        : undefined,
    );
    renderAt('/leaderboard');
    expect(await screen.findByText('Teams use different rubric versions.')).toBeInTheDocument();
    expect(screen.getByText('Rubric version conflict')).toBeInTheDocument();
    expect(screen.queryByRole('table', { name: 'Official ranking' })).not.toBeInTheDocument();
    expect(screen.queryByText('85.00')).not.toBeInTheDocument();
  });

  it('provides a retry action on an API error', async () => {
    mockApi(judgeUser, () => undefined);
    renderAt('/leaderboard');
    expect(await screen.findByRole('alert')).toHaveTextContent('Could not load the leaderboard');
    expect(screen.getByRole('button', { name: 'Try again' })).toBeEnabled();
  });
});

describe('dashboard', () => {
  const overview: AdminOverview = {
    rubricState: 'published',
    publishedRubricVersion: 1,
    activeJudges: 3,
    activeAdmins: 2,
    activeTeams: 5,
    archivedTeams: 1,
    submittedEvaluations: 7,
  };
  const dashboard: DashboardResponse = {
    computedAt: '2026-11-22T10:00:00.000Z',
    teams: { active: 5, archived: 1 },
    accounts: { judges: 3, administrators: 2, participatingJudges: 4 },
    evaluations: {
      required: 10,
      submitted: 7,
      draft: 2,
      notStarted: 1,
      pending: 3,
      completionPercent: 70,
      averageSubmittedScore: 78.456,
      judgesWithPending: 2,
      teamsWaiting: 1,
    },
    teamStatus: { unassigned: 0, not_started: 0, in_progress: 1, ready: 3, blocked: 1 },
    judges: [
      {
        judgeId: 2,
        fullName: 'Judge One',
        role: 'judge',
        accountStatus: 'active',
        assigned: 4,
        submitted: 2,
        draft: 1,
        pending: 2,
      },
      {
        judgeId: 1,
        fullName: 'Youmna Admin',
        role: 'admin',
        accountStatus: 'active',
        assigned: 1,
        submitted: 1,
        draft: 0,
        pending: 0,
      },
    ],
    topTeams: results.official.teams,
    officialAvailable: true,
    officialUnavailableReason: null,
  };

  it('shows real figures, charts and the top teams', async () => {
    mockApi(adminUser, (url) =>
      url === '/api/admin/overview'
        ? overview
        : url === '/api/admin/dashboard'
          ? dashboard
          : undefined,
    );
    renderAt('/admin');
    expect(await screen.findByText('70%')).toBeInTheDocument();
    expect(screen.getByText('7 of 10 evaluations submitted')).toBeInTheDocument();
    expect(screen.getByText('78.46')).toBeInTheDocument();
    expect(screen.getByText(/Descriptive only/)).toBeInTheDocument();
    expect(
      screen.getByRole('table', { name: 'Evaluations: submitted vs pending' }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole('img', { name: 'Judge One: 2 of 4 submitted, 1 in draft' }),
    ).toBeInTheDocument();
    expect(screen.getAllByText('85.00')).toHaveLength(2);
  });

  it('hides top teams when no comparable official ranking exists', async () => {
    mockApi(adminUser, (url) =>
      url === '/api/admin/overview'
        ? overview
        : url === '/api/admin/dashboard'
          ? {
              ...dashboard,
              topTeams: [],
              officialAvailable: false,
              officialUnavailableReason: 'Ready teams were scored with different rubric versions.',
            }
          : undefined,
    );
    renderAt('/admin');
    expect(
      await screen.findByText('Ready teams were scored with different rubric versions.'),
    ).toBeInTheDocument();
    expect(screen.queryByText('85.00')).not.toBeInTheDocument();
  });
});
