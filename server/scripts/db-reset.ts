/**
 * npm run db:reset -- --yes — DEVELOPMENT ONLY. Deletes the database and builds
 * it again from the migrations (no data is kept). Refused in production.
 */
import mysql from 'mysql2/promise';
import { loadToolConfig } from '../src/config.js';
import { migrate } from '../src/db/migrate.js';
import { seedInitialAdmin } from '../src/db/seed.js';
import { adminServer, adminTarget, hasFlag, printSecretBox, runScript } from './lib/cli.js';

runScript(async () => {
  const config = loadToolConfig();
  if (config.isProduction) {
    console.error('FAIL  db:reset is disabled when NODE_ENV=production. Use db:restore instead.');
    return 1;
  }
  if (!hasFlag('--yes')) {
    console.error('This deletes ALL data in the database. Re-run with: npm run db:reset -- --yes');
    return 1;
  }
  const target = adminTarget(config);
  const conn = await mysql.createConnection({ ...adminServer(config), connectTimeout: 5_000 });
  try {
    await conn.query(`DROP DATABASE IF EXISTS \`${target.database}\``);
    await conn.query(
      `CREATE DATABASE \`${target.database}\` CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci`,
    );
  } finally {
    await conn.end();
  }
  console.log(`OK  recreated empty database "${target.database}"`);
  const result = await migrate(target, { log: (line) => console.log(line) });
  console.log(`OK  applied ${result.applied.length} migration(s)`);
  const seedConn = await mysql.createConnection({ ...target, connectTimeout: 5_000 });
  try {
    const seed = await seedInitialAdmin(seedConn, config.admin);
    if (seed.created && seed.generatedPassword) {
      printSecretBox([
        'TEMPORARY ADMINISTRATOR PASSWORD (shown only once)',
        `E-mail:   ${config.admin.email}`,
        `Password: ${seed.generatedPassword}`,
      ]);
    } else if (seed.created) {
      console.log(`OK  created administrator ${config.admin.email} with ADMIN_INITIAL_PASSWORD`);
    }
  } finally {
    await seedConn.end();
  }
  return 0;
});
