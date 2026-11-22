import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter, Route, Routes } from 'react-router';
import type {
  AuthUser,
  EvaluationDetail,
  JudgeAssignment,
  JudgeEvaluationResponse,
  RubricVersion,
} from '@judging/shared';
import { AuthProvider } from '../src/auth/AuthContext';
import { RequireAuth } from '../src/auth/RequireAuth';
import { AppLayout } from '../src/components/AppLayout';
import { ToastProvider } from '../src/components/Toast';
import { EvaluationPage } from '../src/pages/judge/EvaluationPage';
import { JudgeTeamsPage } from '../src/pages/judge/JudgeTeamsPage';

const judgeUser: AuthUser = {
  id: 2,
  email: 'judge@example.com',
  fullName: 'Judge One',
  role: 'judge',
  mustChangePassword: false,
};
const adminUser: AuthUser = {
  ...judgeUser,
  id: 1,
  email: 'youmna54@gmail.com',
  fullName: 'Youmna',
  role: 'admin',
};

function rubric(weights = [30, 30, 20, 20], versionNo = 1): RubricVersion {
  let id = versionNo * 100;
  return {
    id: versionNo,
    versionNo,
    status: 'published',
    revision: 3,
    title: 'Final rubric',
    description: '',
    instructions: 'Rate fairly.',
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
        {
          id: ++id,
          title: `${name} A`,
          description: '',
          guidelines: i === 0 ? 'Look for prior art' : '',
        },
        { id: ++id, title: `${name} B`, description: '', guidelines: '' },
      ],
    })),
  };
}

function evaluation(
  r: RubricVersion,
  stars: (number | null)[] = [],
  extra: Partial<EvaluationDetail> = {},
): EvaluationDetail {
  const criteria = r.sections.flatMap((s) => s.criteria);
  return {
    id: 7,
    teamId: 1,
    judgeId: 2,
    rubricVersionId: r.id,
    rubricVersionNo: r.versionNo,
    status: 'draft',
    rowVersion: 1,
    totalScore: 0,
    ratedCount: stars.filter((s) => s != null).length,
    requiredCount: 8,
    submittedAt: null,
    createdAt: '2026-11-22T10:00:00.000Z',
    updatedAt: '2026-11-22T10:00:00.000Z',
    reopenedCount: 0,
    reopenedAt: null,
    reopenReason: null,
    reopenNoticePending: false,
    overallNotes: '',
    ratings: criteria.map((c, i) => ({ criterionId: c.id, rating: stars[i] ?? null, note: '' })),
    sectionNotes: r.sections.map((s) => ({ sectionId: s.id, note: '' })),
    ...extra,
  };
}

const team = {
  id: 1,
  teamCode: 'AHL-001',
  name: 'Falcons',
  projectName: 'Smart Irrigation',
  status: 'active' as const,
};

function view(
  r: RubricVersion | null,
  e: EvaluationDetail | null,
  extra: Partial<JudgeEvaluationResponse> = {},
): JudgeEvaluationResponse {
  return {
    team,
    rubric: r,
    publishedVersionNo: r?.versionNo ?? null,
    evaluation: e,
    canEdit: e?.status !== 'submitted',
    readOnlyReason:
      e?.status === 'submitted'
        ? 'Submitted and locked. Only an administrator can reopen it.'
        : null,
    ...extra,
  };
}

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
      return new Response(JSON.stringify(body), {
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

/** Clicks n stars on the given criterion's star group. */
async function rate(groupIndex: number, stars: number) {
  const group = screen.getAllByRole('radiogroup')[groupIndex]!;
  await userEvent.click(
    within(group).getByRole('radio', { name: `${stars} star${stars === 1 ? '' : 's'}` }),
  );
}

beforeEach(() => window.localStorage.clear());
afterEach(() => vi.unstubAllGlobals());

describe('My Teams', () => {
  it('shows each team’s status, progress and the right action, for judges and admins alike', async () => {
    const base = {
      assignedAt: '2026-11-22T10:00:00.000Z',
      requiredCount: 8,
      submittedAt: null,
      rubricVersionNo: 1,
      outdatedVersion: false,
      reopenNotice: false,
      reopenReason: null,
    };
    const assignments: JudgeAssignment[] = [
      {
        ...base,
        teamId: 1,
        teamCode: 'AHL-001',
        teamName: 'Falcons',
        projectName: 'P',
        evaluationStatus: 'not_started',
        ratedCount: 0,
        totalScore: null,
        rubricVersionNo: null,
      },
      {
        ...base,
        teamId: 2,
        teamCode: 'AHL-002',
        teamName: 'Eagles',
        projectName: 'P',
        evaluationStatus: 'draft',
        ratedCount: 5,
        totalScore: null,
        outdatedVersion: true,
      },
      {
        ...base,
        teamId: 3,
        teamCode: 'AHL-003',
        teamName: 'Lions',
        projectName: 'P',
        evaluationStatus: 'submitted',
        ratedCount: 8,
        totalScore: 87.5,
        submittedAt: '2026-11-22T11:00:00.000Z',
      },
    ];
    mockApi(adminUser, (c) =>
      c.url === '/api/judge/assignments'
        ? { status: 200, body: { assignments } }
        : c.url === '/api/judge/rubric'
          ? { status: 200, body: { rubric: rubric() } }
          : undefined,
    );
    renderAt('/judge');
    expect(await screen.findByRole('link', { name: 'My teams' })).toBeInTheDocument();
    expect(
      (await screen.findAllByRole('link', { name: 'Start evaluation of Falcons' }))[0],
    ).toHaveAttribute('href', '/judge/teams/1');
    expect(
      screen.getAllByRole('link', { name: 'Continue evaluation of Eagles' }).length,
    ).toBeGreaterThan(0);
    expect(
      screen.getAllByRole('link', { name: 'View evaluation of Lions' }).length,
    ).toBeGreaterThan(0);
    expect(screen.getAllByText('5/8 rated').length).toBeGreaterThan(0);
    expect(screen.getAllByText('87.50').length).toBeGreaterThan(0);
    expect(screen.getAllByText('Older rubric v1').length).toBeGreaterThan(0);
  });
});

describe('Evaluation page', () => {
  it('shows read-only team details, then starts an evaluation', async () => {
    const r = rubric();
    const calls = mockApi(judgeUser, (c) =>
      c.method === 'GET'
        ? { status: 200, body: view(r, null) }
        : c.method === 'POST'
          ? { status: 201, body: { evaluation: evaluation(r) } }
          : undefined,
    );
    renderAt('/judge/teams/1');
    expect(await screen.findByText('Smart Irrigation')).toBeInTheDocument();
    expect(screen.getByText('AHL-001')).toBeInTheDocument();
    expect(screen.getByText('Look for prior art')).toBeInTheDocument();
    expect(screen.queryByRole('radiogroup')).not.toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Start evaluation' }));
    expect(await screen.findAllByRole('radiogroup')).toHaveLength(8);
    expect(
      calls.some((c) => c.method === 'POST' && c.url === '/api/judge/teams/1/evaluation'),
    ).toBe(true);
    expect(screen.queryByDisplayValue('Falcons')).not.toBeInTheDocument(); // team details are not editable
  });

  it('updates section and final scores instantly and autosaves', async () => {
    const r = rubric([30, 30, 20, 20]);
    const e = evaluation(r);
    const calls = mockApi(judgeUser, (c) => {
      if (c.method === 'GET') return { status: 200, body: view(r, e) };
      if (c.method === 'PUT') {
        const body = c.body as { ratings: { rating: number | null }[] };
        return {
          status: 200,
          body: {
            evaluation: evaluation(
              r,
              body.ratings.map((x) => x.rating),
              { rowVersion: 2 },
            ),
          },
        };
      }
      return undefined;
    });
    renderAt('/judge/teams/1');
    await screen.findAllByRole('radiogroup');
    await rate(0, 4);
    await rate(1, 5);
    // Section 1: (4+5)/10 × 30 = 27.00, shown as the section score and the running total.
    expect(screen.getAllByText('27.00')).toHaveLength(2);
    expect(screen.getByText('2/8 rated')).toBeInTheDocument();
    await waitFor(() => expect(calls.some((c) => c.method === 'PUT')).toBe(true), {
      timeout: 4000,
    });
    const put = calls.find((c) => c.method === 'PUT')!.body as {
      rowVersion: number;
      ratings: { rating: number | null }[];
    };
    expect(put.rowVersion).toBe(1);
    expect(put.ratings.slice(0, 2).map((x) => x.rating)).toEqual([4, 5]);
    expect(put).not.toHaveProperty('totalScore');
    expect(
      await screen.findByText('✓ All changes saved', {}, { timeout: 4000 }),
    ).toBeInTheDocument();
  });

  it('highlights missing criteria, confirms the final score, submits and locks', async () => {
    const r = rubric([35, 25, 25, 15]);
    const stars = [3, 4, 5, 5, 2, 3, 1, null];
    const e = evaluation(r, stars, { rowVersion: 4 });
    const calls = mockApi(judgeUser, (c) => {
      if (c.method === 'GET') return { status: 200, body: view(r, e) };
      if (c.method === 'PUT') {
        const body = c.body as { ratings: { rating: number | null }[] };
        return {
          status: 200,
          body: {
            evaluation: evaluation(
              r,
              body.ratings.map((x) => x.rating),
              { rowVersion: 5 },
            ),
          },
        };
      }
      if (c.url.endsWith('/submit')) {
        return {
          status: 200,
          body: {
            alreadySubmitted: false,
            evaluation: evaluation(r, [3, 4, 5, 5, 2, 3, 1, 4], {
              status: 'submitted',
              rowVersion: 6,
              totalScore: 69.5,
              submittedAt: '2026-11-22T12:00:00.000Z',
            }),
          },
        };
      }
      return undefined;
    });
    renderAt('/judge/teams/1');
    await screen.findAllByRole('radiogroup');
    await userEvent.click(screen.getByRole('button', { name: 'Submit…' }));
    expect(screen.getByText('Rate all 8 criteria before submitting')).toBeInTheDocument();
    expect(screen.getAllByText('Rating required')).toHaveLength(1);
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();

    await rate(7, 4);
    expect(screen.queryByText('Rating required')).not.toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Submit…' }));
    const dialog = await screen.findByRole('dialog', {
      name: 'Submit your evaluation of Falcons?',
    });
    expect(within(dialog).getByText('69.50 / 100')).toBeInTheDocument();
    const confirm = within(dialog).getByRole('button', { name: 'Submit evaluation' });
    await userEvent.click(confirm);
    await userEvent.click(confirm).catch(() => {}); // a double click must not submit twice

    expect(await screen.findByText('Submitted and locked')).toBeInTheDocument();
    expect(screen.getByText('69.50')).toBeInTheDocument();
    expect(screen.queryByRole('radiogroup')).not.toBeInTheDocument();
    expect(calls.filter((c) => c.url.endsWith('/submit'))).toHaveLength(1);
    const put = calls.filter((c) => c.method === 'PUT').at(-1)!.body as { rowVersion: number };
    expect(put.rowVersion).toBe(4); // the latest change was saved before submitting
    expect(calls.find((c) => c.url.endsWith('/submit'))!.body).toEqual({ rowVersion: 5 });
  });

  it('keeps the entered ratings when a save fails, and says so', async () => {
    const r = rubric();
    mockApi(judgeUser, (c) =>
      c.method === 'GET'
        ? { status: 200, body: view(r, evaluation(r)) }
        : c.method === 'PUT'
          ? {
              status: 400,
              body: { error: { code: 'EVALUATION_INVALID', message: 'Something is wrong.' } },
            }
          : undefined,
    );
    renderAt('/judge/teams/1');
    await screen.findAllByRole('radiogroup');
    await rate(0, 3);
    await userEvent.click(screen.getByRole('button', { name: 'Save' }));
    expect(await screen.findByText('Your changes are not saved yet')).toBeInTheDocument();
    expect(
      within(screen.getAllByRole('radiogroup')[0]!).getByRole('radio', { name: '3 stars' }),
    ).toHaveAttribute('aria-checked', 'true');
    // A copy is kept on this device too.
    expect(window.localStorage.getItem('ischool-ahly:evaluation-backup:7')).toContain('"rating":3');
  });

  it('stops on a conflict with another tab and lets the judge choose', async () => {
    const r = rubric();
    const server = evaluation(r, [5, 5], { rowVersion: 3 });
    mockApi(judgeUser, (c) =>
      c.method === 'GET'
        ? { status: 200, body: view(r, evaluation(r)) }
        : c.method === 'PUT'
          ? {
              status: 409,
              body: {
                error: { code: 'EVALUATION_CONFLICT', message: 'Changed elsewhere' },
                evaluation: server,
              },
            }
          : undefined,
    );
    renderAt('/judge/teams/1');
    await screen.findAllByRole('radiogroup');
    await rate(0, 1);
    await userEvent.click(screen.getByRole('button', { name: 'Save' }));
    expect(
      await screen.findByText('This evaluation was changed in another tab or window'),
    ).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Load the saved version' }));
    expect(
      within(screen.getAllByRole('radiogroup')[0]!).getByRole('radio', { name: '5 stars' }),
    ).toHaveAttribute('aria-checked', 'true');
    expect(screen.getByText('✓ All changes saved')).toBeInTheDocument();
  });

  it('offers to restore unsaved changes found on this device', async () => {
    const r = rubric();
    const e = evaluation(r);
    const backup = { ...e, ratings: e.ratings.map((x, i) => (i === 0 ? { ...x, rating: 2 } : x)) };
    window.localStorage.setItem(
      'ischool-ahly:evaluation-backup:7',
      JSON.stringify({
        rowVersion: 1,
        savedAt: '2026-11-22T10:05:00.000Z',
        input: { ratings: backup.ratings, sectionNotes: e.sectionNotes, overallNotes: '' },
      }),
    );
    mockApi(judgeUser, (c) =>
      c.method === 'GET'
        ? { status: 200, body: view(r, e) }
        : c.method === 'PUT'
          ? { status: 200, body: { evaluation: { ...backup, rowVersion: 2 } } }
          : undefined,
    );
    renderAt('/judge/teams/1');
    expect(
      await screen.findByText('Unsaved changes were found on this device'),
    ).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Restore them' }));
    expect(
      within(screen.getAllByRole('radiogroup')[0]!).getByRole('radio', { name: '2 stars' }),
    ).toHaveAttribute('aria-checked', 'true');
  });

  it('shows a submitted evaluation read-only with its score and time', async () => {
    const r = rubric();
    const e = evaluation(r, [5, 5, 5, 5, 5, 5, 5, 5], {
      status: 'submitted',
      totalScore: 100,
      submittedAt: '2026-11-22T12:00:00.000Z',
    });
    mockApi(judgeUser, (c) => (c.method === 'GET' ? { status: 200, body: view(r, e) } : undefined));
    renderAt('/judge/teams/1');
    expect(await screen.findByText('Submitted and locked')).toBeInTheDocument();
    expect(screen.getByText('100.00')).toBeInTheDocument();
    expect(screen.queryByRole('radiogroup')).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Submit…' })).not.toBeInTheDocument();
    expect(screen.getAllByRole('img', { name: /5 of 5 stars/ })).toHaveLength(8);
  });

  it('warns when the evaluation uses an older rubric version', async () => {
    const r = rubric([30, 30, 20, 20], 1);
    mockApi(judgeUser, (c) =>
      c.method === 'GET'
        ? { status: 200, body: view(r, evaluation(r), { publishedVersionNo: 2 }) }
        : undefined,
    );
    renderAt('/judge/teams/1');
    expect(
      await screen.findByText('This evaluation uses an older rubric version'),
    ).toBeInTheDocument();
  });
});
