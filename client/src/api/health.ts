import type { HealthResponse } from '@judging/shared';

export class ApiUnreachableError extends Error {
  constructor(message = 'The API server is not responding') {
    super(message);
    this.name = 'ApiUnreachableError';
  }
}

/**
 * Fetches administrator-only GET /api/admin/health. A 503 still carries a full health report (database
 * down), so it is returned as data. Only a missing or non-JSON response is an error.
 */
export async function fetchHealth(signal?: AbortSignal): Promise<HealthResponse> {
  let response: Response;
  try {
    response = await fetch('/api/admin/health', {
      signal,
      credentials: 'same-origin',
      headers: { Accept: 'application/json' },
    });
  } catch {
    throw new ApiUnreachableError();
  }
  const isJson = response.headers.get('content-type')?.includes('application/json');
  if (!isJson || (response.status !== 200 && response.status !== 503)) {
    throw new ApiUnreachableError(`The API server answered with HTTP ${response.status}`);
  }
  return (await response.json()) as HealthResponse;
}
