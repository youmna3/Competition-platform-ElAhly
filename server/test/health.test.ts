import request from 'supertest';
import { describe, expect, it } from 'vitest';
import type { DatabaseHealth } from '@judging/shared';
import { createApp } from '../src/app.js';
import { describeDatabaseError } from '../src/db/pool.js';

function appWith(database: DatabaseHealth) {
  return createApp({
    checkDatabase: async () => database,
    environment: 'test',
    version: '0.1.0-test',
  });
}

describe('GET /api/health', () => {
  it('returns 200 and ok when the database answers', async () => {
    const res = await request(
      appWith({
        status: 'ok',
        serverVersion: '10.4.32-MariaDB',
        database: 'judging_platform',
        latencyMs: 1.2,
      }),
    ).get('/api/health');

    expect(res.status).toBe(200);
    expect(res.headers['cache-control']).toBe('no-store');
    expect(res.body.status).toBe('ok');
    expect(res.body.app).toBeUndefined();
    expect(res.body.database).toBeUndefined();
    expect(new Date(res.body.time).toString()).not.toBe('Invalid Date');
  });

  it('returns 503 and degraded when the database is unreachable', async () => {
    const res = await request(
      appWith({
        status: 'error',
        code: 'ECONNREFUSED',
        message: 'connect ECONNREFUSED',
        hint: 'Start MySQL',
      }),
    ).get('/api/health');

    expect(res.status).toBe(503);
    expect(res.body.status).toBe('degraded');
    expect(res.body.database).toBeUndefined();
    expect(JSON.stringify(res.body)).not.toContain('ECONNREFUSED');
  });

  it('sets security headers and hides the framework', async () => {
    const res = await request(
      appWith({ status: 'ok', serverVersion: 'x', database: 'y', latencyMs: 0 }),
    ).get('/api/health');

    expect(res.headers['x-powered-by']).toBeUndefined();
    const csp = String(res.headers['content-security-policy']);
    expect(csp).toContain("default-src 'self'");
    // Nothing may be loaded from other origins: no CDNs, web fonts or remote styles.
    expect(csp).not.toMatch(/https?:/);
    expect(res.headers['x-content-type-options']).toBe('nosniff');
  });
});

describe('API error handling', () => {
  const app = appWith({ status: 'ok', serverVersion: 'x', database: 'y', latencyMs: 0 });

  it('returns a JSON 404 for unknown API routes', async () => {
    const res = await request(app).get('/api/does-not-exist');
    expect(res.status).toBe(404);
    expect(res.body.error.code).toBe('NOT_FOUND');
  });

  it('returns 400 for malformed JSON without leaking details', async () => {
    const res = await request(app)
      .post('/api/anything')
      .set('Content-Type', 'application/json')
      .send('{"broken":');
    expect(res.status).toBe(400);
    expect(res.body).toEqual({
      error: { code: 'INVALID_JSON', message: 'Request body is not valid JSON' },
    });
  });

  it('rejects request bodies over 1 MB', async () => {
    const res = await request(app)
      .post('/api/anything')
      .set('Content-Type', 'application/json')
      .send(JSON.stringify({ big: 'x'.repeat(1_100_000) }));
    expect(res.status).toBe(413);
    expect(res.body.error.code).toBe('PAYLOAD_TOO_LARGE');
  });
});

describe('describeDatabaseError', () => {
  const db = { host: '127.0.0.1', port: 3306, user: 'root', database: 'judging_platform' };

  it.each([
    ['ECONNREFUSED', /XAMPP Control Panel/],
    ['ER_ACCESS_DENIED_ERROR', /DB_USER and DB_PASSWORD/],
    ['ER_BAD_DB_ERROR', /npm run db:create/],
  ])('gives a plain-language hint for %s', (code, hint) => {
    expect(describeDatabaseError({ code, message: 'x' }, db).hint).toMatch(hint);
  });

  it('falls back safely for unknown errors', () => {
    const result = describeDatabaseError(undefined, db);
    expect(result.code).toBe('UNKNOWN');
    expect(result.hint).toMatch(/XAMPP/);
  });
});
