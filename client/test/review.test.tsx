import { afterEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter, Route, Routes } from 'react-router';
import type {
  AdminEvaluationDetail,
  AdminEvaluationsResponse,
  AuthUser,
  EvaluationDetail,
  EvaluationEvent,
  JudgeAssignment,
  JudgeProgressRow,
  RubricVersion,
} from '@judging/shared';
import { AuthProvider } from '../src/auth/AuthContext';
import { RequireAuth } from '../src/auth/RequireAuth';
import { AppLayout } from '../src/components/AppLayout';
import { ToastProvider } from '../src/components/Toast';
import { EvaluationsPage } from '../src/pages/admin/evaluations/EvaluationsPage';
import { EvaluationReviewPage } from '../src/pages/admin/evaluations/EvaluationReviewPage';
import { JudgeProgressPage } from '../src/pages/admin/evaluations/JudgeProgressPage';
import { EvaluationPage } from '../src/pages/judge/EvaluationPage';
import { JudgeTeamsPage } from '../src/pages/judge/JudgeTeamsPage';

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

function rubric(weights = [35, 25, 25, 15]): RubricVersion {
  let id = 100;
  return {
    id: 1,
    versionNo: 1,
    status: 'published',
    revision: 3,
    title: 'Final rubric',
    description: '',
    instructions: '',
    createdAt: '2026-11-22T10:00:00.000Z',
    updatedAt: '2026-11-22T10:00:00.000Z',
    updatedByEmail: null,
    publishedAt: '2026-11-22T10:00:00.000Z',
    publishedByEmail: null,
    sections: ['Idea', 'Execution', 'Presentation', 'Teamwork'].map((name, i) => ({
      id: ++id,
      title: name,
      description: '',
      weightPercent: weights[i]!,
      criteria: [
        { id: ++id, title: `${name} A`, description: '', guidelines: '' },
        { id: ++id, title: `${name} B`, description: '', guidelines: '' },
      ],
    })),
  };
}

function evaluation(
  r: RubricVersion,
  stars: number[],
  extra: Partial<EvaluationDetail> = {},
): EvaluationDetail {
  return {
    id: 7,
    teamId: 1,
    judgeId: 2,
    rubricVersionId: 1,
    rubricVersionNo: 1,
    status: 'submitted',
    rowVersion: 9,
    totalScore: 69.5,
    ratedCount: 8,
    requiredCount: 8,
    submittedAt: '2026-11-22T12:00:00.000Z',
    createdAt: '2026-11-22T10:00:00.000Z',
    updatedAt: '2026-11-22T12:00:00.000Z',
    reopenedCount: 0,
    reopenedAt: null,
    reopenReason: null,
    reopenNoticePending: false,
    overallNotes: 'Strong overall',
    ratings: r.sections
      .flatMap((s) => s.criteria)
      .map((c, i) => ({
        criterionId: c.id,
        rating: stars[i] ?? null,
        note: i === 0 ? 'Original idea' : '',
      })),
    sectionNotes: r.sections.map((s) => ({ sectionId: s.id, note: '' })),
    ...extra,
  };
}

function detail(
  extra: Partial<AdminEvaluationDetail> = {},
  ev: Partial<EvaluationDetail> = {},
): AdminEvaluationDetail {
  const r = rubric();
  return {
    team: {
      id: 1,
      teamCode: 'AHL-001',
      name: 'Falcons',
      projectName: 'Irrigation',
      status: 'active',
    },
    judge: {
      id: 2,
      fullName: 'Judge One',
      email: 'judge@example.com',
      role: 'judge',
      accountStatus: 'active',
    },
    judgeAssigned: true,
    rubric: r,
    publishedVersionNo: 1,
    evaluation: evaluation(r, [3, 4, 5, 5, 2, 3, 1, 4], ev),
    sectionScores: [24.5, 25, 12.5, 7.5],
    lastSavedAt: '2026-11-22T11:59:00.000Z',
    saveCount: 12,
    reopen: null,
    canReopen: true,
    reopenBlockedReason: null,
    ...extra,
  };
}

const events: EvaluationEvent[] = [
  {
    id: 1,
    event: 'started',
    actorEmail: 'judge@example.com',
    actorName: 'Judge One',
    createdAt: '2026-11-22T10:00:00.000Z',
    rubricVersionNo: 1,
    ratedCount: 0,
    totalScore: null,
    previousScore: null,
    reason: null,
    snapshot: null,
  },
  {
    id: 2,
    event: 'submitted',
    actorEmail: 'judge@example.com',
    actorName: 'Judge One',
    createdAt: '2026-11-22T12:00:00.000Z',
    rubricVersionNo: 1,
    ratedCount: 8,
    totalScore: 69.5,
    previousScore: null,
    reason: null,
    snapshot: {
      totalScore: 69.5,
      sections: [{ sectionId: 101, title: 'Idea', weightPercent: 35, score: 24.5, note: '' }],
      ratings: [
        { criterionId: 102, sectionId: 101, title: 'Idea A', rating: 3, note: 'Original idea' },
      ],
      overallNotes: 'Strong overall',
    },
  },
];

interface Call {
  url: string;
  method: string;
  body: unknown;
}

function mockApi(
  me: AuthUser,
  handler: (call: Call) => { status: number; body?: unknown } | undefined,
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
      const { status, body } = (call.url === '/api/auth/me'
        ? { status: 200, body: { user: me } }
        : handler(call)) ?? {
        status: 404,
        body: { error: { code: 'NOT_FOUND', message: 'nope' } },
      };
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
                  path="/admin/evaluations"
                  element={
                    <RequireAuth roles={['admin']}>
                      <EvaluationsPage />
                    </RequireAuth>
                  }
                />
                <Route
                  path="/admin/evaluations/progress"
                  element={
                    <RequireAuth roles={['admin']}>
                      <JudgeProgressPage />
                    </RequireAuth>
                  }
                />
                <Route
                  path="/admin/evaluations/:id"
                  element={
                    <RequireAuth roles={['admin']}>
                      <EvaluationReviewPage />
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
                <Route
                  path="/judge/teams/:teamId"
                  element={
                    <RequireAuth roles={['judge', 'admin']}>
                      <EvaluationPage />
                    </RequireAuth>
                  }
                />
              </Route>
              <Route path="/login" element={<p>Sign-in page</p>} />
            </Routes>
          </ToastProvider>
        </AuthProvider>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

afterEach(() => vi.unstubAllGlobals());

const listResponse: AdminEvaluationsResponse = {
  total: 1,
  page: 1,
  pageSize: 20,
  versionsInUse: [1, 2],
  judges: [
    { id: 2, fullName: 'Judge One', role: 'judge' },
    { id: 3, fullName: 'Judge Two', role: 'judge' },
  ],
  teams: [
    {
      teamId: 1,
      teamCode: 'AHL-001',
      name: 'Falcons',
      projectName: 'Irrigation',
      teamStatus: 'active',
      assignedJudges: 3,
      submitted: 2,
      pending: 1,
      completion: 'in_progress',
      provisionalAverage: 80,
      versions: [1, 2],
      mixedVersions: true,
      readyForResults: false,
      lastSubmittedAt: '2026-11-22T12:00:00.000Z',
      judges: [
        {
          judgeId: 2,
          fullName: 'Judge One',
          email: 'judge@example.com',
          role: 'judge',
          accountStatus: 'active',
          evaluationId: 7,
          status: 'submitted',
          ratedCount: 8,
          totalScore: 100,
          rubricVersionNo: 1,
          submittedAt: '2026-11-22T12:00:00.000Z',
          updatedAt: null,
          reopenedCount: 1,
        },
        {
          judgeId: 3,
          fullName: 'Judge Two',
          email: 'judge2@example.com',
          role: 'judge',
          accountStatus: 'active',
          evaluationId: 8,
          status: 'submitted',
          ratedCount: 8,
          totalScore: 60,
          rubricVersionNo: 2,
          submittedAt: '2026-11-22T11:00:00.000Z',
          updatedAt: null,
          reopenedCount: 0,
        },
        {
          judgeId: 1,
          fullName: 'Youmna Admin',
          email: 'youmna54@gmail.com',
          role: 'admin',
          accountStatus: 'active',
          evaluationId: 9,
          status: 'draft',
          ratedCount: 3,
          totalScore: null,
          rubricVersionNo: 2,
          submittedAt: null,
          updatedAt: null,
          reopenedCount: 0,
        },
      ],
    },
  ],
};

describe('Evaluations list', () => {
  it('is in the admin navigation and shows judges, scores, counts, averages and version warnings', async () => {
    mockApi(adminUser, (c) =>
      c.url.startsWith('/api/admin/evaluations?') ? { status: 200, body: listResponse } : undefined,
    );
    renderAt('/admin/evaluations');
    expect(await screen.findByRole('link', { name: 'Evaluations' })).toBeInTheDocument();
    expect(
      (await screen.findAllByRole('link', { name: 'Review Judge One’s evaluation' }))[0],
    ).toHaveAttribute('href', '/admin/evaluations/7');
    expect(screen.getAllByText('100.00').length).toBeGreaterThan(0);
    expect(screen.getAllByText('3/8').length).toBeGreaterThan(0);
    expect(screen.getAllByText('80.00').length).toBeGreaterThan(0);
    expect(screen.getAllByText('Mixed rubric versions').length).toBeGreaterThan(0);
    expect(screen.getAllByText('Reopened ×1').length).toBeGreaterThan(0);
    expect(screen.getByText('not comparable')).toBeInTheDocument();
  });

  it('sends filters to the server', async () => {
    const calls = mockApi(adminUser, (c) =>
      c.url.startsWith('/api/admin/evaluations?') ? { status: 200, body: listResponse } : undefined,
    );
    renderAt('/admin/evaluations');
    await screen.findAllByText('100.00');
    await userEvent.selectOptions(screen.getByLabelText('Judge'), '3');
    await userEvent.selectOptions(screen.getByLabelText('Evaluation status'), 'draft');
    await userEvent.selectOptions(screen.getByLabelText('Rubric version'), '2');
    await userEvent.selectOptions(screen.getByLabelText('Team completion'), 'mixed_versions');
    await waitFor(() => {
      const last = calls.filter((c) => c.url.startsWith('/api/admin/evaluations?')).at(-1)!.url;
      expect(last).toContain('judgeId=3');
      expect(last).toContain('status=draft');
      expect(last).toContain('version=2');
      expect(last).toContain('completion=mixed_versions');
    });
  });
});

describe('Evaluation review', () => {
  it('shows the evaluation read-only with weights, section scores, final score and history', async () => {
    mockApi(adminUser, (c) =>
      c.url === '/api/admin/evaluations/7'
        ? { status: 200, body: detail() }
        : c.url === '/api/admin/evaluations/7/history'
          ? { status: 200, body: { events } }
          : undefined,
    );
    renderAt('/admin/evaluations/7');
    expect(await screen.findByRole('heading', { name: 'Judge One → AHL-001' })).toBeInTheDocument();
    expect(screen.queryByRole('radiogroup')).not.toBeInTheDocument();
    expect(screen.queryByRole('textbox')).not.toBeInTheDocument();
    expect(screen.getAllByText('69.50').length).toBeGreaterThan(0);
    expect(screen.getAllByText('24.50').length).toBeGreaterThan(0);
    expect(screen.getByText('Original idea')).toBeInTheDocument();
    expect(screen.getByText('Strong overall')).toBeInTheDocument();
    expect(screen.getByText(/12 saves/)).toBeInTheDocument();
    expect(await screen.findByText('Evaluation started')).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Show what was submitted' }));
    expect(screen.getByText('Idea A: 3★')).toBeInTheDocument();
  });

  it('reopens only with a reason of at least five characters, after confirmation', async () => {
    const after = detail(
      {
        canReopen: false,
        reopen: {
          at: '2026-11-22T13:00:00.000Z',
          byEmail: 'youmna54@gmail.com',
          reason: 'typo fix',
          count: 1,
        },
      },
      { status: 'draft', submittedAt: null },
    );
    let reopened = false;
    const calls = mockApi(adminUser, (c) => {
      if (c.url === '/api/admin/evaluations/7')
        return { status: 200, body: reopened ? after : detail() };
      if (c.url === '/api/admin/evaluations/7/history') return { status: 200, body: { events } };
      if (c.url === '/api/admin/evaluations/7/reopen') {
        reopened = true;
        return { status: 200, body: after };
      }
      return undefined;
    });
    renderAt('/admin/evaluations/7');
    await userEvent.click(await screen.findByRole('button', { name: 'Reopen…' }));
    const dialog = await screen.findByRole('dialog');
    const confirm = within(dialog).getByRole('button', { name: 'Reopen evaluation' });
    expect(confirm).toBeDisabled();
    expect(within(dialog).queryByText('This is your own evaluation')).not.toBeInTheDocument();
    await userEvent.type(within(dialog).getByLabelText('Reason (required)'), 'typo');
    expect(confirm).toBeDisabled();
    await userEvent.type(within(dialog).getByLabelText('Reason (required)'), ' fix  ');
    expect(confirm).toBeEnabled();
    await userEvent.click(confirm);
    await waitFor(() =>
      expect(calls.find((c) => c.url.endsWith('/reopen'))?.body).toEqual({ reason: 'typo fix' }),
    );
    expect(
      await screen.findByText('Reopened, waiting for the judge to resubmit'),
    ).toBeInTheDocument();
  });

  it('warns an administrator reopening their own evaluation, and explains when reopening is blocked', async () => {
    mockApi(adminUser, (c) =>
      c.url === '/api/admin/evaluations/7'
        ? {
            status: 200,
            body: detail({
              judge: {
                id: 1,
                fullName: 'Youmna Admin',
                email: 'youmna54@gmail.com',
                role: 'admin',
                accountStatus: 'active',
              },
            }),
          }
        : c.url === '/api/admin/evaluations/8'
          ? {
              status: 200,
              body: detail({
                judgeAssigned: false,
                canReopen: false,
                reopenBlockedReason: 'The judge is no longer assigned to this team.',
              }),
            }
          : c.url.endsWith('/history')
            ? { status: 200, body: { events } }
            : undefined,
    );
    const { unmount } = renderAt('/admin/evaluations/7');
    await userEvent.click(await screen.findByRole('button', { name: 'Reopen…' }));
    expect(await screen.findByText('This is your own evaluation')).toBeInTheDocument();
    unmount();
    renderAt('/admin/evaluations/8');
    expect(await screen.findByRole('button', { name: 'Reopen…' })).toBeDisabled();
    expect(screen.getByText('The judge is no longer assigned to this team.')).toBeInTheDocument();
  });
});

describe('Judge progress', () => {
  it('lists every judge, including admins who judge, with completion and filters', async () => {
    const rows: JudgeProgressRow[] = [
      {
        judgeId: 2,
        fullName: 'Judge One',
        email: 'judge@example.com',
        role: 'judge',
        accountStatus: 'active',
        assignedTeams: 4,
        notStarted: 1,
        draft: 1,
        submitted: 2,
        completionPercent: 50,
        lastSubmittedAt: '2026-11-22T12:00:00.000Z',
        otherEvaluations: 1,
      },
      {
        judgeId: 1,
        fullName: 'Youmna Admin',
        email: 'youmna54@gmail.com',
        role: 'admin',
        accountStatus: 'active',
        assignedTeams: 1,
        notStarted: 0,
        draft: 0,
        submitted: 1,
        completionPercent: 100,
        lastSubmittedAt: null,
        otherEvaluations: 0,
      },
    ];
    const calls = mockApi(adminUser, (c) =>
      c.url.startsWith('/api/admin/judge-progress')
        ? { status: 200, body: { judges: rows } }
        : undefined,
    );
    renderAt('/admin/evaluations/progress');
    expect(
      (await screen.findAllByRole('link', { name: 'Show Judge One’s teams' }))[0],
    ).toHaveAttribute('href', '/admin/evaluations?judgeId=2');
    expect(
      screen.getAllByRole('progressbar', { name: 'Judge One: 50% submitted' }).length,
    ).toBeGreaterThan(0);
    expect(screen.getAllByText('Admin').length).toBeGreaterThan(0);
    await userEvent.selectOptions(screen.getByLabelText('Completion'), 'incomplete');
    await waitFor(() => expect(calls.at(-1)!.url).toContain('completion=incomplete'));
  });
});

describe('Judge notice after reopening', () => {
  it('tells the judge on My Teams and on the evaluation, and acknowledges it', async () => {
    const r = rubric();
    const reopened = evaluation(r, [5, 5, 5, 5, 5, 5, 5, 5], {
      status: 'draft',
      submittedAt: null,
      reopenedCount: 1,
      reopenedAt: '2026-11-22T13:00:00.000Z',
      reopenReason: 'Wrong team scored',
      reopenNoticePending: true,
    });
    const assignments: JudgeAssignment[] = [
      {
        teamId: 1,
        teamCode: 'AHL-001',
        teamName: 'Falcons',
        projectName: 'Irrigation',
        assignedAt: '2026-11-22T10:00:00.000Z',
        evaluationStatus: 'draft',
        ratedCount: 8,
        requiredCount: 8,
        totalScore: null,
        submittedAt: null,
        rubricVersionNo: 1,
        outdatedVersion: false,
        reopenNotice: true,
        reopenReason: 'Wrong team scored',
      },
    ];
    const calls = mockApi(judgeUser, (c) =>
      c.url === '/api/judge/assignments'
        ? { status: 200, body: { assignments } }
        : c.url === '/api/judge/rubric'
          ? { status: 200, body: { rubric: r } }
          : c.url === '/api/judge/teams/1/evaluation'
            ? {
                status: 200,
                body: {
                  team: {
                    id: 1,
                    teamCode: 'AHL-001',
                    name: 'Falcons',
                    projectName: 'Irrigation',
                    status: 'active',
                  },
                  rubric: r,
                  publishedVersionNo: 1,
                  evaluation: reopened,
                  canEdit: true,
                  readOnlyReason: null,
                },
              }
            : c.url.endsWith('/acknowledge-reopen')
              ? { status: 204 }
              : undefined,
    );
    const { unmount } = renderAt('/judge');
    expect(
      await screen.findByText('An administrator reopened your evaluation'),
    ).toBeInTheDocument();
    expect(screen.getByText(/Wrong team scored/)).toBeInTheDocument();
    unmount();
    renderAt('/judge/teams/1');
    expect(
      await screen.findByText('An administrator reopened this evaluation'),
    ).toBeInTheDocument();
    await waitFor(() =>
      expect(
        calls.some(
          (c) => c.url === '/api/judge/evaluations/7/acknowledge-reopen' && c.method === 'POST',
        ),
      ).toBe(true),
    );
    expect(screen.getAllByRole('radiogroup')).toHaveLength(8);
  });
});
