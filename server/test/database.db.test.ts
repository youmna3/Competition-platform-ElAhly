/**
 * Real-database tests. They need XAMPP MySQL running and server/.env filled in.
 * Run with: npm run test:db
 */
import request from 'supertest';
import { afterAll, describe, expect, it } from 'vitest';
import { loadConfig } from '../src/config.js';
import { checkDatabase, createPool } from '../src/db/pool.js';
import { createApp } from '../src/app.js';

const config = loadConfig();
const pool = createPool(config.db);

afterAll(async () => {
  await pool.end();
});

describe('XAMPP MySQL connection', () => {
  it('connects with the settings in server/.env', async () => {
    const result = await checkDatabase(pool, config.db, { includeHint: true });
    if (result.status !== 'ok') {
      throw new Error(`Database not reachable: ${result.code} — ${result.hint}`);
    }
    expect(result.database).toBe(config.db.database);
    expect(result.serverVersion).toMatch(/\d+\.\d+/);
    expect(result.latencyMs).toBeGreaterThanOrEqual(0);
  });

  it('uses utf8mb4 for the application database', async () => {
    const [rows] = await pool.query(
      'SELECT DEFAULT_CHARACTER_SET_NAME AS charset FROM information_schema.SCHEMATA WHERE SCHEMA_NAME = ?',
      [config.db.database],
    );
    expect((rows as { charset: string }[])[0]?.charset).toBe('utf8mb4');
  });

  it('serves a healthy /api/health end to end', async () => {
    const app = createApp({
      checkDatabase: () => checkDatabase(pool, config.db, { includeHint: true }),
      environment: 'test',
      version: 'db-test',
    });
    const res = await request(app).get('/api/health');
    expect(res.status).toBe(200);
    expect(res.body.status).toBe('ok');
    expect(res.body.database).toBeUndefined();
    expect(res.body.app).toBeUndefined();
  });
});

describe('failure reporting against a real server', () => {
  it('reports wrong credentials as ER_ACCESS_DENIED_ERROR', async () => {
    const bad = { ...config.db, user: 'no_such_user_xyz', password: 'wrong' };
    const badPool = createPool(bad);
    try {
      const result = await checkDatabase(badPool, bad, { includeHint: true });
      expect(result).toMatchObject({ status: 'error', code: 'ER_ACCESS_DENIED_ERROR' });
    } finally {
      await badPool.end();
    }
  });

  it('reports a missing database as ER_BAD_DB_ERROR with the db:create hint', async () => {
    const bad = { ...config.db, database: 'judging_missing_db_xyz' };
    const badPool = createPool(bad);
    try {
      const result = await checkDatabase(badPool, bad, { includeHint: true });
      expect(result).toMatchObject({ status: 'error', code: 'ER_BAD_DB_ERROR' });
      if (result.status === 'error') expect(result.hint).toMatch(/db:create/);
    } finally {
      await badPool.end();
    }
  });

  it('reports a closed port as ECONNREFUSED and never includes the password', async () => {
    const bad = { ...config.db, port: 3999, password: 'super-secret-value' };
    const badPool = createPool(bad);
    try {
      const result = await checkDatabase(badPool, bad, { includeHint: true });
      expect(result).toMatchObject({ status: 'error', code: 'ECONNREFUSED' });
      expect(JSON.stringify(result)).not.toContain('super-secret-value');
    } finally {
      await badPool.end();
    }
  });
});
