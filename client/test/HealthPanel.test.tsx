import { afterEach, describe, expect, it, vi } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { HealthResponse } from '@judging/shared';
import { HealthPanel } from '../src/components/HealthPanel';

function renderPanel() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <HealthPanel refreshMs={60_000} />
    </QueryClientProvider>,
  );
}

function mockFetch(status: number, body: unknown) {
  vi.stubGlobal(
    'fetch',
    vi.fn(
      async () =>
        new Response(JSON.stringify(body), {
          status,
          headers: { 'Content-Type': 'application/json' },
        }),
    ),
  );
}

const app = {
  name: 'iSchool × Al Ahly Judging Platform',
  version: '0.1.0',
  environment: 'development',
  uptimeSeconds: 5,
};

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('HealthPanel', () => {
  it('shows both services connected when the API and database are healthy', async () => {
    const body: HealthResponse = {
      status: 'ok',
      app,
      database: {
        status: 'ok',
        serverVersion: '10.4.32-MariaDB',
        database: 'judging_platform',
        latencyMs: 2,
      },
      time: new Date().toISOString(),
    };
    mockFetch(200, body);
    renderPanel();

    const db = await screen.findByRole('region', { name: 'XAMPP MySQL database' });
    expect(await within(db).findByText('Response time')).toBeInTheDocument();
    expect(screen.queryByText('judging_platform')).not.toBeInTheDocument();
    expect(screen.queryByText('10.4.32-MariaDB')).not.toBeInTheDocument();
    expect(within(db).getByText('Connected')).toBeInTheDocument();
    expect(
      within(screen.getByRole('region', { name: 'API server' })).getByText('Connected'),
    ).toBeInTheDocument();
  });

  it('shows the database hint when MySQL is down (HTTP 503)', async () => {
    const body: HealthResponse = {
      status: 'degraded',
      app,
      database: {
        status: 'error',
        code: 'ECONNREFUSED',
        message: 'connect ECONNREFUSED 127.0.0.1:3306',
        hint: 'Nothing is listening on 127.0.0.1:3306. Start MySQL in the XAMPP Control Panel.',
      },
      time: new Date().toISOString(),
    };
    mockFetch(503, body);
    renderPanel();

    const db = await screen.findByRole('region', { name: 'XAMPP MySQL database' });
    expect(await within(db).findByText(/Database unavailable/)).toBeInTheDocument();
    expect(screen.queryByText(/127.0.0.1:3306/)).not.toBeInTheDocument();
    expect(within(db).getByText('Not connected')).toBeInTheDocument();
    // The API itself answered, so it is shown as connected.
    expect(
      within(screen.getByRole('region', { name: 'API server' })).getByText('Connected'),
    ).toBeInTheDocument();
  });

  it('explains how to start the API when it is not running', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => Promise.reject(new TypeError('Failed to fetch'))),
    );
    renderPanel();

    const api = await screen.findByRole('region', { name: 'API server' });
    expect(await within(api).findByText(/not responding/)).toBeInTheDocument();
    expect(within(api).getByText('npm run dev')).toBeInTheDocument();
  });
});
