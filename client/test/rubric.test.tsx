import { afterEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter, Route, Routes } from 'react-router';
import {
  defaultRubricContent,
  type AdminRubricResponse,
  type AuthUser,
  type RubricContent,
  type RubricVersion,
} from '@judging/shared';
import { AuthProvider } from '../src/auth/AuthContext';
import { RequireAuth } from '../src/auth/RequireAuth';
import { AppLayout } from '../src/components/AppLayout';
import { ToastProvider } from '../src/components/Toast';
import { RubricManagementPage } from '../src/pages/admin/rubric/RubricManagementPage';
import { ViewRubricPage } from '../src/pages/rubric/ViewRubricPage';

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

function complete(weights: number[] = [30, 30, 20, 20]): RubricContent {
  const names = ['Idea', 'Execution', 'Presentation', 'Teamwork'];
  return {
    title: 'Final rubric',
    description: '',
    instructions: 'Rate fairly.',
    sections: names.map((name, i) => ({
      title: name,
      description: '',
      weightPercent: weights[i]!,
      criteria: [
        {
          title: `${name} A`,
          description: 'What it means',
          guidelines: i === 0 ? 'Look for prior art' : '',
        },
        { title: `${name} B`, description: '', guidelines: '' },
      ],
    })),
  };
}

let nextId = 100;
function version(content: RubricContent, extra: Partial<RubricVersion> = {}): RubricVersion {
  return {
    ...content,
    sections: content.sections.map((s) => ({
      ...s,
      id: nextId++,
      criteria: s.criteria.map((c) => ({ ...c, id: nextId++ })),
    })),
    id: nextId++,
    versionNo: 1,
    status: 'draft',
    revision: 2,
    createdAt: '2026-11-22T10:00:00.000Z',
    updatedAt: '2026-11-22T10:00:00.000Z',
    updatedByEmail: adminUser.email,
    publishedAt: null,
    publishedByEmail: null,
    ...extra,
  };
}

const noEvaluations = {
  total: 0,
  submitted: 0,
  onPublished: 0,
  submittedOnPublished: 0,
  submittedVersions: [],
};

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
                  path="/admin/rubric"
                  element={
                    <RequireAuth roles={['admin']}>
                      <RubricManagementPage />
                    </RequireAuth>
                  }
                />
                <Route
                  path="/rubric"
                  element={
                    <RequireAuth roles={['judge', 'admin']}>
                      <ViewRubricPage />
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

const draftResponse = (draft: RubricVersion) => ({
  status: 200,
  body: { state: 'draft_only', published: null, draft, evaluations: noEvaluations },
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('Rubric Management', () => {
  it('is in the admin navigation and starts a 4 × 2 draft from Not configured', async () => {
    const empty: AdminRubricResponse = {
      state: 'not_configured',
      published: null,
      draft: null,
      evaluations: noEvaluations,
    };
    const draft = version(defaultRubricContent());
    const calls = mockApi(adminUser, (c) =>
      c.url === '/api/admin/rubric'
        ? { status: 200, body: empty }
        : c.url === '/api/admin/rubric/draft' && c.method === 'POST'
          ? { status: 201, body: { ...empty, state: 'draft_only', draft } }
          : undefined,
    );
    renderAt('/admin/rubric');
    expect(await screen.findByRole('link', { name: 'Rubric' })).toBeInTheDocument();
    expect(await screen.findByText('The rubric is not configured yet')).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Start building the rubric' }));
    expect(await screen.findByText('2. Section weights')).toBeInTheDocument();
    expect(calls.some((c) => c.method === 'POST' && c.url === '/api/admin/rubric/draft')).toBe(
      true,
    );
    expect(screen.getAllByLabelText('Section title')).toHaveLength(4);
    expect(screen.getAllByLabelText('Criterion title')).toHaveLength(8);
    // Weights start blank, not pre-filled with equal percentages.
    expect(screen.getAllByText('0% / 100%')).toHaveLength(2);
    expect(screen.getAllByText('Weight not set')).toHaveLength(4);
    // Five-star previews for every criterion, and no way to add or remove sections.
    expect(screen.getAllByRole('img', { name: /rated from 1 to 5 stars/ })).toHaveLength(8);
    expect(screen.getAllByRole('button', { name: 'Add Question' })).toHaveLength(4);
  });

  it('shows the weight total live and blocks publishing until it is 100%', async () => {
    const draft = version(defaultRubricContent());
    const calls = mockApi(adminUser, (c) =>
      c.url === '/api/admin/rubric'
        ? draftResponse(draft)
        : c.url === '/api/admin/rubric/draft' && c.method === 'PUT'
          ? {
              status: 200,
              body: {
                draft: version((c.body as { content: RubricContent }).content, {
                  id: draft.id,
                  revision: 3,
                }),
              },
            }
          : undefined,
    );
    renderAt('/admin/rubric');
    await userEvent.type(await screen.findByLabelText('Rubric title'), 'Final rubric');
    const weights = screen
      .getAllByRole('textbox')
      .filter((el) => el.getAttribute('inputmode') === 'numeric');
    expect(weights).toHaveLength(4);
    for (const [i, w] of ['35', '25', '25', '25'].entries()) await userEvent.type(weights[i]!, w);
    expect(screen.getAllByText('110% / 100%')).toHaveLength(2);
    expect(screen.getByText(/10% too much/)).toBeInTheDocument();
    expect(
      screen.getByRole('button', {
        name: /The section weights total 110%. They must total exactly 100%./,
      }),
    ).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Publish…' })).toBeDisabled();

    await userEvent.clear(weights[3]!);
    await userEvent.type(weights[3]!, '15');
    expect(screen.getAllByText('100% / 100%')).toHaveLength(2);
    expect(screen.getByText('Ready to publish')).toBeInTheDocument();

    await userEvent.clear(screen.getAllByLabelText('Section title')[0]!);
    await userEvent.type(screen.getAllByLabelText('Section title')[0]!, 'Idea');
    await userEvent.click(screen.getByRole('button', { name: 'Save draft' }));
    await waitFor(() => expect(screen.getByText(/All changes saved/)).toBeInTheDocument());
    const put = calls.find((c) => c.method === 'PUT')!.body as {
      revision: number;
      content: RubricContent;
    };
    expect(put.revision).toBe(2);
    expect(put.content.sections.map((s) => [s.title, s.weightPercent])).toEqual([
      ['Idea', 35],
      ['Section 2', 25],
      ['Section 3', 25],
      ['Section 4', 15],
    ]);
    expect(put.content.sections[0]!.criteria).toHaveLength(2);
  });

  it('blocks saving when a title is emptied', async () => {
    mockApi(adminUser, (c) =>
      c.url === '/api/admin/rubric' ? draftResponse(version(complete())) : undefined,
    );
    renderAt('/admin/rubric');
    await userEvent.clear((await screen.findAllByLabelText('Criterion title'))[3]!);
    expect(
      screen.getByRole('button', { name: /Section 2 “Execution”, criterion 2 needs a title/ }),
    ).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Save draft' })).toBeDisabled();
  });

  it('lets the admin try the scoring in the preview', async () => {
    mockApi(adminUser, (c) =>
      c.url === '/api/admin/rubric' ? draftResponse(version(complete())) : undefined,
    );
    renderAt('/admin/rubric');
    await userEvent.click(await screen.findByRole('button', { name: 'Preview' }));
    const preview = await screen.findByRole('dialog', { name: 'Preview' });
    expect(within(preview).getByText(/Its section maximum remains 30 points/)).toBeInTheDocument();
    const groups = within(preview).getAllByRole('radiogroup');
    expect(groups).toHaveLength(8);
    await userEvent.click(within(groups[0]!).getByRole('radio', { name: '4 stars' }));
    await userEvent.click(within(groups[1]!).getByRole('radio', { name: '5 stars' }));
    expect(within(preview).getByText('27 / 30')).toBeInTheDocument();
    for (const g of groups.slice(2)) {
      await userEvent.click(within(g).getByRole('radio', { name: '5 stars' }));
    }
    expect(within(preview).getByText('97')).toBeInTheDocument(); // 27 + 30 + 20 + 20
  });

  it('warns about existing evaluations and weight changes before publishing', async () => {
    const published = version(complete(), {
      status: 'published',
      versionNo: 1,
      publishedAt: '2026-11-20T10:00:00.000Z',
    });
    const draft = version(complete([10, 50, 20, 20]), { versionNo: 2 });
    const calls = mockApi(adminUser, (c) =>
      c.url === '/api/admin/rubric'
        ? {
            status: 200,
            body: {
              state: 'published_with_draft',
              published,
              draft,
              evaluations: {
                ...noEvaluations,
                total: 2,
                onPublished: 2,
                submittedOnPublished: 1,
                submitted: 1,
                submittedVersions: [1],
              },
            },
          }
        : c.url === '/api/admin/rubric/draft/publish'
          ? { status: 200, body: { versionNo: 2, published: { ...draft, status: 'published' } } }
          : undefined,
    );
    renderAt('/admin/rubric');
    expect(await screen.findByText(/Judges are still using version 1/)).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Publish…' }));
    const dialog = await screen.findByRole('dialog', { name: 'Publish version 2?' });
    expect(within(dialog).getByText(/Idea 30% → 10%, Execution 30% → 50%/)).toBeInTheDocument();
    expect(within(dialog).getByText(/2 evaluations already use version 1/)).toBeInTheDocument();
    const confirm = within(dialog).getByRole('button', { name: 'Publish version 2' });
    expect(confirm).toBeDisabled();
    await userEvent.click(within(dialog).getByRole('checkbox'));
    await userEvent.click(confirm);
    await waitFor(() => {
      const post = calls.find((c) => c.url === '/api/admin/rubric/draft/publish');
      expect(post?.body).toEqual({ revision: 2, confirmExistingEvaluations: true });
    });
  });

  it('explains a revision conflict instead of overwriting', async () => {
    mockApi(adminUser, (c) =>
      c.url === '/api/admin/rubric'
        ? draftResponse(version(complete()))
        : c.method === 'PUT'
          ? { status: 409, body: { error: { code: 'REVISION_CONFLICT', message: 'changed' } } }
          : undefined,
    );
    renderAt('/admin/rubric');
    await userEvent.type(await screen.findByLabelText('Rubric title'), ' 2');
    await userEvent.click(screen.getByRole('button', { name: 'Save draft' }));
    expect(await screen.findByText('This draft was changed somewhere else')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Reload latest draft' })).toBeInTheDocument();
  });
});

describe('View Rubric', () => {
  it('tells judges when nothing is published yet', async () => {
    mockApi(judgeUser, (c) =>
      c.url === '/api/judge/rubric' ? { status: 200, body: { rubric: null } } : undefined,
    );
    renderAt('/rubric');
    expect(await screen.findByText('The rubric hasn’t been published yet')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Rubric' })).toBeInTheDocument();
  });

  it('shows the published rubric read-only: weights, stars, guidelines and instructions', async () => {
    const published = version(complete([35, 25, 25, 15]), {
      status: 'published',
      publishedAt: '2026-11-20T10:00:00.000Z',
    });
    mockApi(judgeUser, (c) =>
      c.url === '/api/judge/rubric' ? { status: 200, body: { rubric: published } } : undefined,
    );
    renderAt('/rubric');
    expect(await screen.findByRole('heading', { name: 'Final rubric' })).toBeInTheDocument();
    expect(screen.getByText('Rate fairly.')).toBeInTheDocument();
    expect(screen.getByText('Look for prior art')).toBeInTheDocument();
    expect(screen.getByText('35% of base')).toBeInTheDocument();
    expect(screen.getAllByRole('img', { name: /rated from 1 to 5 stars/ })).toHaveLength(8);
    expect(screen.queryByRole('radiogroup')).not.toBeInTheDocument();
    expect(screen.queryByRole('textbox')).not.toBeInTheDocument();
    expect(screen.queryByRole('link', { name: /Manage the rubric/ })).not.toBeInTheDocument();
  });

  it('keeps judges out of Rubric Management', async () => {
    mockApi(judgeUser, () => undefined);
    renderAt('/admin/rubric');
    expect(await screen.findByText('Judge area')).toBeInTheDocument();
  });
});
