import { resolve } from 'node:path';
import { APP_NAME } from '@judging/shared';
import { ConfigError, loadConfig, loadToolConfig } from './config.js';
import { checkDatabase, createPool } from './db/pool.js';
import { createApp } from './app.js';
import { MySqlSessionStore } from './auth/sessionStore.js';

function start() {
  // `npm start` passes --production so no OS-specific env syntax is needed on Windows.
  if (process.argv.includes('--production') && !process.env.NODE_ENV) {
    process.env.NODE_ENV = 'production';
  }
  let config;
  try {
    config = loadConfig();
  } catch (error) {
    if (error instanceof ConfigError) {
      console.error(`[api] ${error.message}`);
      console.error('[api] Fix server/.env (copy it from server/.env.example) and try again.');
      process.exit(1);
    }
    throw error;
  }

  if (!config.auth.sessionSecret) {
    console.error(
      '[api] SESSION_SECRET is missing from server/.env, so sign-in cannot be enabled.',
    );
    console.error(
      '[api] Run this once in the project folder, then start again:  npm run auth:secret',
    );
    process.exit(1);
  }

  const pool = createPool(config.db);
  const store = new MySqlSessionStore(pool, config.auth.maxSessionMs);
  const cleanup = setInterval(() => {
    store
      .clearExpired()
      .catch((error: unknown) => console.warn('[api] session cleanup failed:', error));
  }, 15 * 60_000);
  cleanup.unref();

  const tools = loadToolConfig();
  const app = createApp({
    maintenance: {
      server: { host: config.db.host, port: config.db.port, ...tools.dbAdmin },
      database: config.db.database,
      backupDir: tools.backupDir,
      binDir: tools.mysqlBinDir,
      executionEnabled: process.env.COMPETITION_RESET_ENABLED === 'true',
    },
    auth: { pool, config: config.auth, store },
    checkDatabase: () => checkDatabase(pool, config.db, { includeHint: !config.isProduction }),
    environment: config.env,
    version: process.env.npm_package_version ?? '0.1.0',
    logRequests: !config.isProduction,
    clientDistDir: config.isProduction ? resolve(process.cwd(), '../client/dist') : undefined,
  });

  const server = app.listen(config.port, config.host, () => {
    const shownHost = config.host.includes(':') ? `[${config.host}]` : config.host;
    console.log(`[api] ${APP_NAME} API (${config.env})`);
    console.log(`[api] listening on http://${shownHost}:${config.port}`);
    console.log(`[api] health check: http://${shownHost}:${config.port}/api/health`);
    void checkDatabase(pool, config.db, { includeHint: true }).then((db) => {
      if (db.status === 'ok') {
        console.log(
          `[api] database ${db.database} connected (${db.serverVersion}, ${db.latencyMs} ms)`,
        );
      } else {
        console.warn(`[api] database NOT connected: ${db.code} — ${db.hint ?? db.message}`);
      }
    });
  });

  server.on('error', (error: NodeJS.ErrnoException) => {
    if (error.code === 'EADDRINUSE') {
      console.error(
        `[api] Port ${config.port} is already in use. Close the other program or change PORT in server/.env.`,
      );
    } else {
      console.error('[api] server error:', error);
    }
    process.exit(1);
  });

  let shuttingDown = false;
  const shutdown = (signal: string) => {
    if (shuttingDown) return;
    shuttingDown = true;
    console.log(`[api] ${signal} received, shutting down…`);
    server.close(() => {
      void pool.end().finally(() => process.exit(0));
    });
    setTimeout(() => process.exit(1), 5_000).unref();
  };
  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
}

start();
