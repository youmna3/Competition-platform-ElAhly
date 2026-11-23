import { CompetitionReset, type MaintenanceOptions } from './competition/reset.js';
import { competitionStatus } from './competition/service.js';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import express, { type Express } from 'express';
import helmet from 'helmet';
import type { Pool } from 'mysql2/promise';
import type { DatabaseHealth } from '@judging/shared';
import type { AuthConfig, WebConfig } from './config.js';
import { transportSecurity } from './middleware/transport.js';
import {
  loadUser,
  sameOriginOnly,
  sessionMiddleware,
  requireAuth,
  requireRole,
} from './auth/middleware.js';
import { authRouter } from './auth/routes.js';
import type { MySqlSessionStore } from './auth/sessionStore.js';
import { healthRouter } from './routes/health.js';
import { adminRouter, judgeRouter } from './routes/protected.js';
import { apiNotFound, errorHandler, requestLogger } from './middleware/errors.js';

export interface AppOptions {
  web?: WebConfig;
  maintenance?: MaintenanceOptions;
  checkDatabase: () => Promise<DatabaseHealth>;
  environment: string;
  version: string;
  /** Log every request (development only). */
  logRequests?: boolean;
  /** Built client (client/dist). Served from the same origin when present. */
  clientDistDir?: string;
  /** Sign-in, sessions and protected routes. Omitted only in narrow unit tests. */
  auth?: { pool: Pool; config: AuthConfig; store: MySqlSessionStore };
}

export function createApp(options: AppOptions): Express {
  const app = express();

  app.disable('x-powered-by');
  app.set('trust proxy', options.web?.trustProxy.length ? options.web.trustProxy : false);
  app.use(
    helmet({
      contentSecurityPolicy: {
        useDefaults: true,
        directives: {
          // Everything is served locally: no CDNs, fonts or images from other origins.
          'default-src': ["'self'"],
          'img-src': ["'self'", 'data:'],
          'connect-src': ["'self'"],
          // Allows only the local origin to load fonts; no external font services.
          'font-src': ["'self'"],
          // Styles only from this origin (inline style attributes are used by React).
          'style-src': ["'self'", "'unsafe-inline'"],
          'upgrade-insecure-requests': options.web?.requireHttps ? [] : null,
        },
      },
      strictTransportSecurity: options.web?.requireHttps
        ? { maxAge: 31536000, includeSubDomains: false }
        : false,
    }),
  );
  if (options.logRequests) app.use(requestLogger);
  app.use(express.json({ limit: '1mb' }));

  // API responses are never cached, and writes must come from this origin.
  app.use('/api', (_req, res, next) => {
    res.set('Cache-Control', 'no-store');
    next();
  });
  if (options.web?.publicOrigin) app.use(transportSecurity(options.web));
  else app.use('/api', sameOriginOnly);

  app.use(
    '/api/health',
    healthRouter({
      checkDatabase: options.checkDatabase,
      environment: options.environment,
      version: options.version,
    }),
  );
  if (options.auth) {
    const { pool, config, store } = options.auth;
    app.use('/api', sessionMiddleware(config, store), loadUser(pool, config));
    app.use(
      '/api/admin/health',
      requireAuth,
      requireRole('admin'),
      healthRouter({
        checkDatabase: options.checkDatabase,
        environment: options.environment,
        version: options.version,
        detailed: true,
      }),
    );
    app.use('/api/auth', authRouter(pool, config));
    app.get('/api/competition', requireAuth, async (_req, res) =>
      res.json(await competitionStatus(pool)),
    );
    app.use(
      '/api/admin',
      adminRouter(
        pool,
        options.maintenance ? new CompetitionReset(options.maintenance) : undefined,
      ),
    );
    app.use('/api/judge', judgeRouter(pool));
  }
  app.use('/api', apiNotFound);

  // Serve the built React app (production / competition day).
  const dist = options.clientDistDir;
  if (dist && existsSync(join(dist, 'index.html'))) {
    app.use(express.static(dist, { index: false, maxAge: '1h' }));
    app.use((req, res, next) => {
      if (req.method !== 'GET' && req.method !== 'HEAD') return next();
      res.set('Cache-Control', 'no-cache');
      res.sendFile(join(dist, 'index.html'));
    });
  }

  app.use(errorHandler);
  return app;
}
