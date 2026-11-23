import express from 'express';
import request from 'supertest';
import { expect, it, vi } from 'vitest';
import { healthRouter } from '../src/routes/health.js';
import { requireAuth, requireRole } from '../src/auth/middleware.js';

it('denies guests and judges before running detailed health diagnostics', async () => {
  const check = vi.fn(async () => ({
    status: 'ok' as const,
    database: 'private_database',
    serverVersion: 'private_version',
    latencyMs: 1,
  }));
  const app = express();
  // Test identity injection only; production obtains identity from its session middleware.
  app.use((req, _res, next) => {
    const role = req.header('x-test-role');
    if (role === 'admin' || role === 'judge')
      req.user = {
        id: 1,
        email: 'fixture@example.com',
        fullName: 'Fixture',
        role,
        mustChangePassword: false,
      };
    next();
  });
  app.use(
    '/api/admin/health',
    requireAuth,
    requireRole('admin'),
    healthRouter({ checkDatabase: check, environment: 'test', version: 'fixture', detailed: true }),
  );
  expect((await request(app).get('/api/admin/health')).status).toBe(401);
  expect((await request(app).get('/api/admin/health').set('x-test-role', 'judge')).status).toBe(
    403,
  );
  expect(check).not.toHaveBeenCalled();
  const admin = await request(app).get('/api/admin/health').set('x-test-role', 'admin');
  expect(admin.status).toBe(200);
  expect(admin.body.database.database).toBe('private_database');
  expect(check).toHaveBeenCalledOnce();
});
