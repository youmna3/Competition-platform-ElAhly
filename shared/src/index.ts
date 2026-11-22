/** Shared constants and types used by both the API server and the web client. */

export const APP_NAME = 'iSchool × Al Ahly Judging Platform';
export const APP_SHORT_NAME = 'Judging Platform';

/** Database part of the health report. */
export type DatabaseHealth =
  | {
      status: 'ok';
      /** e.g. "10.4.32-MariaDB" (XAMPP) or "8.0.36" (MySQL). */
      serverVersion: string;
      database: string;
      latencyMs: number;
    }
  | {
      status: 'error';
      /** Driver error code such as ECONNREFUSED or ER_BAD_DB_ERROR. */
      code: string;
      message: string;
      /** Plain-language fix. Only included outside production. */
      hint?: string;
    };

/** Response body of GET /api/health. */
export interface HealthResponse {
  status: 'ok' | 'degraded';
  app: {
    name: string;
    version: string;
    environment: string;
    uptimeSeconds: number;
  };
  database: DatabaseHealth;
  time: string;
}

/** Error body returned by every API error. */
export interface ApiErrorBody {
  error: {
    code: string;
    message: string;
  };
}

export * from './password.js';
export * from './rubric.js';
export * from './auth.js';
export * from './users.js';
export * from './teams.js';
export * from './evaluations.js';
