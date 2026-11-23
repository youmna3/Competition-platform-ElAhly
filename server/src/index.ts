import { resolve } from 'node:path';
import { existsSync } from 'node:fs';
import { verifyProductionDatabase } from './production.js';
import { databaseSsl } from './db/tls.js';
import { APP_NAME } from '@judging/shared';
import { ConfigError, loadConfig, loadToolConfig } from './config.js';
import { checkDatabase, createPool } from './db/pool.js';
import { createApp } from './app.js';
import { MySqlSessionStore } from './auth/sessionStore.js';

async function start() {
  if (Number(process.versions.node.split('.')[0]) !== 24)
    throw new Error('Node.js 24 LTS is required.');
  // `npm start` passes --production so no OS-specific env syntax is needed on Windows.
  if (process.argv.includes('--production')) {
    process.env.NODE_ENV = 'production';
  }
  let config;
  try {
    config = loadConfig();
  } catch (error) {
    if (error instanceof ConfigError) {
      console.error(`[api] ${error.message}`);
      console.error('[api] Check the server environment configuration.');
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
  const clientDistDir = resolve(process.cwd(), '../client/dist');
  if (config.isProduction) {
    try {
      if (!existsSync(resolve(clientDistDir, 'index.html')))
        throw new Error('Production client build is missing.');
      await verifyProductionDatabase(pool);
    } catch (error) {
      await pool.end();
      throw error;
    }
  }
  const store = new MySqlSessionStore(pool, config.auth.maxSessionMs);
  const cleanup = setInterval(() => {
    store
      .clearExpired()
      .catch((error: unknown) => console.warn('[api] session cleanup failed:', error));
  }, 15 * 60_000);
  cleanup.unref();

  const tools = config.maintenance.enabled ? loadToolConfig() : undefined;
  const app = createApp({
    web: config.web,
    maintenance: tools
      ? {
          server: {
            host: config.db.host,
            port: config.db.port,
            ...tools.dbAdmin,
            ssl: databaseSsl(config.db),
          },
          database: config.db.database,
          backupDir: tools.backupDir,
          binDir: tools.mysqlBinDir,
          executionEnabled: config.maintenance.resetExecutionEnabled,
        }
      : undefined,
    auth: { pool, config: config.auth, store },
    checkDatabase: () => checkDatabase(pool, config.db, { includeHint: !config.isProduction }),
    environment: config.env,
    version: process.env.npm_package_version ?? '0.1.0',
    logRequests: !config.isProduction,
    clientDistDir: config.isProduction ? clientDistDir : undefined,
  });

  const server = app.listen(config.port, config.host, () => {
    const shownHost = config.host.includes(':') ? `[${config.host}]` : config.host;
    console.log(`[api] ${APP_NAME} API (${config.env})`);
    console.log(`[api] listening on http://${shownHost}:${config.port}`);
    console.log(`[api] health check: http://${shownHost}:${config.port}/api/health`);
    void checkDatabase(pool, config.db, { includeHint: !config.isProduction }).then((db) => {
      if (db.status === 'ok') {
        console.log(
          config.isProduction
            ? '[api] database connection ready'
            : `[api] database ${db.database} connected (${db.serverVersion}, ${db.latencyMs} ms)`,
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

start().catch((error) => {
  console.error('[api] Startup failed:', error instanceof Error ? error.message : 'Unknown error');
  process.exit(1);
});
