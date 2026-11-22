import type { Pool } from 'mysql2/promise';
import request from 'supertest';
import { createApp } from '../../src/app.js';
import { MySqlSessionStore } from '../../src/auth/sessionStore.js';
import type { AuthConfig } from '../../src/config.js';
import { TEST_DB } from './helpers.js';

export const testAuthConfig: AuthConfig = {
  sessionSecret: 'test-session-secret-0123456789abcdef0123456789abcdef',
  idleTimeoutMs: 60_000,
  maxSessionMs: 3_600_000,
  cookieSecure: false,
  loginRateLimit: 1000,
  lockoutThreshold: 5,
  lockoutMinutes: 15,
};

/** The real Express app wired to the scratch database. */
export function makeTestApp(pool: Pool, overrides: Partial<AuthConfig> = {}) {
  const config = { ...testAuthConfig, ...overrides };
  return createApp({
    checkDatabase: async () => ({
      status: 'ok',
      serverVersion: 'test',
      database: TEST_DB,
      latencyMs: 0,
    }),
    environment: 'test',
    version: 'test',
    auth: { pool, config, store: new MySqlSessionStore(pool, config.maxSessionMs) },
  });
}

export async function signIn(app: ReturnType<typeof makeTestApp>, email: string, password: string) {
  const agent = request.agent(app);
  const res = await agent.post('/api/auth/login').send({ email, password });
  if (res.status !== 200)
    throw new Error(`sign-in failed for ${email}: ${res.status} ${JSON.stringify(res.body)}`);
  return agent;
}
