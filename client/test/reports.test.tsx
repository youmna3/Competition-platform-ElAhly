import { afterEach, expect, it, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { ReportsPage } from '../src/pages/admin/reports/ReportsPage';
afterEach(() => vi.unstubAllGlobals());

it('downloads the selected normalized CSV sheet with filters, and clears inapplicable filters between reports', async () => {
  const user = userEvent.setup(),
    calls: string[] = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (path: string) => {
      calls.push(path);
      return new Response('report', { status: 200 });
    }),
  );
  vi.stubGlobal(
    'URL',
    Object.assign(URL, { createObjectURL: vi.fn(() => 'blob:report'), revokeObjectURL: vi.fn() }),
  );
  const click = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {});
  render(<ReportsPage />);
  await user.selectOptions(screen.getByLabelText('Report'), 'evaluations');
  await user.type(screen.getByLabelText('Team database ID (optional)'), '4');
  await user.selectOptions(screen.getByLabelText('Evaluation status'), 'submitted');
  await user.selectOptions(screen.getByLabelText('CSV sheet'), 'Criteria');
  await user.click(screen.getByRole('button', { name: 'Download CSV' }));
  await waitFor(() => expect(calls).toHaveLength(1));
  const url = new URL(calls[0]!, 'http://test');
  expect(url.pathname).toBe('/api/admin/reports/evaluations');
  expect(Object.fromEntries(url.searchParams)).toEqual({
    format: 'csv',
    teamId: '4',
    status: 'submitted',
    sheet: 'Criteria',
  });
  await user.selectOptions(screen.getByLabelText('Report'), 'rubrics');
  expect(screen.queryByLabelText('Team database ID (optional)')).not.toBeInTheDocument();
  await user.click(screen.getByRole('button', { name: 'Download Excel (.xlsx)' }));
  await waitFor(() => expect(calls[1]).toBe('/api/admin/reports/rubrics?format=xlsx'));
  click.mockRestore();
});

it('shows safe export-limit errors without losing filters', async () => {
  vi.stubGlobal(
    'fetch',
    vi.fn(
      async () =>
        new Response(
          JSON.stringify({ error: { message: 'Narrow the filters; no records omitted.' } }),
          { status: 413, headers: { 'Content-Type': 'application/json' } },
        ),
    ),
  );
  render(<ReportsPage />);
  await userEvent.click(screen.getByRole('button', { name: 'Download Excel (.xlsx)' }));
  expect(await screen.findByText('Narrow the filters; no records omitted.')).toBeInTheDocument();
});
