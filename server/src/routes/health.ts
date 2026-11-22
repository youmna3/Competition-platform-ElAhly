import { Router } from 'express';
import type { DatabaseHealth, HealthResponse } from '@judging/shared';
import { APP_NAME } from '@judging/shared';

export interface HealthDeps {
  checkDatabase: () => Promise<DatabaseHealth>;
  environment: string;
  version: string;
}

export function healthRouter({ checkDatabase, environment, version }: HealthDeps): Router {
  const router = Router();

  router.get('/', async (_req, res) => {
    const database = await checkDatabase();
    const body: HealthResponse = {
      status: database.status === 'ok' ? 'ok' : 'degraded',
      app: {
        name: APP_NAME,
        version,
        environment,
        uptimeSeconds: Math.round(process.uptime()),
      },
      database,
      time: new Date().toISOString(),
    };
    res.set('Cache-Control', 'no-store');
    res.status(database.status === 'ok' ? 200 : 503).json(body);
  });

  return router;
}
