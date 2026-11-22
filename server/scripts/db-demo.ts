/**
 * npm run db:demo — builds (or rebuilds) the separate Phase 8 DEMO database
 * with fictional teams, judges and evaluations covering every results case.
 *
 * Safety:
 * - Only ever touches "<DB_NAME>_demo" (or DEMO_DB_NAME, which must end in
 *   "_demo"). It refuses to run if that equals the real DB_NAME.
 * - An existing database is dropped only if it carries this script's marker
 *   table, so nothing that this script did not create can be deleted.
 * - The real database, server/.env and its credentials are never changed.
 *   The demo uses its own database account, "judging_demo", limited to the
 *   demo database, and writes its settings to server/.env.demo.
 */
import { randomBytes } from 'node:crypto';
import { writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import mysql from 'mysql2/promise';
import { formatScore, TEAM_RESULT_STATUS_LABELS } from '@judging/shared';
import { loadToolConfig } from '../src/config.js';
import { createAppUser } from '../src/db/appUser.js';
import { migrate } from '../src/db/migrate.js';
import { getDashboard, getResults } from '../src/results/service.js';
import { DEMO_EXPECTED, seedPhase8Demo } from './lib/demoSeed.js';
import { adminServer, adminTarget, printSecretBox, runScript } from './lib/cli.js';

const MARKER = 'zz_phase8_demo_marker';
const DEMO_DB_USER = 'judging_demo';
const DEMO_ENV_FILE = resolve(import.meta.dirname, '..', '.env.demo');

const readable = (bytes: number) =>
  randomBytes(bytes)
    .toString('base64')
    .replace(/[^A-Za-z0-9]/g, '')
    .slice(0, bytes);

runScript(async () => {
  const config = loadToolConfig();
  if (config.isProduction) {
    console.error('FAIL  db:demo is a development tool and is disabled when NODE_ENV=production.');
    return 1;
  }
  const realDb = config.db.database;
  if (realDb.endsWith('_demo')) {
    console.error(
      `FAIL  DB_NAME is "${realDb}". Run db:demo from a normal shell, not the demo one.`,
    );
    return 1;
  }
  const demoDb = (process.env.DEMO_DB_NAME ?? `${realDb}_demo`).slice(0, 64);
  if (!/^[A-Za-z0-9_]{1,64}$/.test(demoDb) || !demoDb.endsWith('_demo') || demoDb === realDb) {
    console.error(
      `FAIL  Refusing to use "${demoDb}" as the demo database (must end in _demo and differ from DB_NAME).`,
    );
    return 1;
  }

  const conn = await mysql.createConnection({ ...adminServer(config), connectTimeout: 5_000 });
  try {
    const [exists] = await conn.query(
      'SELECT 1 FROM information_schema.SCHEMATA WHERE SCHEMA_NAME = ?',
      [demoDb],
    );
    if ((exists as unknown[]).length) {
      const [marker] = await conn.query(
        'SELECT 1 FROM information_schema.TABLES WHERE TABLE_SCHEMA = ? AND TABLE_NAME = ?',
        [demoDb, MARKER],
      );
      if (!(marker as unknown[]).length) {
        console.error(
          `FAIL  A database named "${demoDb}" already exists but was not created by db:demo. Nothing was changed.\n` +
            'Set DEMO_DB_NAME to another name ending in _demo, or remove that database yourself.',
        );
        return 1;
      }
      await conn.query(`DROP DATABASE \`${demoDb}\``);
      console.log(`OK  removed the previous demo database "${demoDb}"`);
    }
    await conn.query(
      `CREATE DATABASE \`${demoDb}\` CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci`,
    );
    await conn.query(
      `CREATE TABLE \`${demoDb}\`.\`${MARKER}\` (created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP, note VARCHAR(200) NOT NULL)`,
    );
    await conn.query(
      `INSERT INTO \`${demoDb}\`.\`${MARKER}\` (note) VALUES ('Created by npm run db:demo. Demo data only.')`,
    );
  } finally {
    await conn.end();
  }
  console.log(`OK  created demo database "${demoDb}" (the real database "${realDb}" is untouched)`);

  const target = adminTarget(config, demoDb);
  const result = await migrate(target, { log: () => {} });
  console.log(`OK  applied ${result.applied.length} migration(s) to the demo database`);

  const loginPassword = `Demo-${readable(6)}-${readable(6)}`;
  const pool = mysql.createPool({ ...target, connectionLimit: 4 });
  try {
    await seedPhase8Demo(pool, loginPassword);
    console.log('OK  seeded demo teams, judges and evaluations');

    const dbPassword = readable(24);
    const grantConn = await mysql.createConnection({
      ...adminServer(config),
      connectTimeout: 5_000,
    });
    try {
      await createAppUser(grantConn, {
        user: DEMO_DB_USER,
        password: dbPassword,
        database: demoDb,
      });
    } finally {
      await grantConn.end();
    }
    writeFileSync(
      DEMO_ENV_FILE,
      [
        '# Written by npm run db:demo. DEMO ONLY: points the app at the separate demo database.',
        '# Delete this file at any time; run npm run db:demo again to recreate it.',
        `DB_NAME=${demoDb}`,
        `DB_USER=${DEMO_DB_USER}`,
        `DB_PASSWORD=${dbPassword}`,
        `DEMO_LOGIN_PASSWORD=${loginPassword}`,
        '',
      ].join('\n'),
      { mode: 0o600 },
    );
    console.log(
      `OK  demo database account "${DEMO_DB_USER}" can use "${demoDb}" only; settings in server/.env.demo`,
    );

    const results = await getResults(pool, { sort: 'rank', dir: 'asc' });
    const dash = await getDashboard(pool);
    console.log('\nOfficial ranking (rubric v1):');
    for (const t of results.official.teams) {
      console.log(
        `  #${t.rank}  ${t.teamCode}  ${t.name.padEnd(8)} ${formatScore(t.score).padStart(6)}`,
      );
    }
    console.log('\nNot ranked:');
    for (const t of [...results.notRanked].sort((a, b) => a.teamCode.localeCompare(b.teamCode))) {
      console.log(
        `  ${t.teamCode}  ${TEAM_RESULT_STATUS_LABELS[t.status].padEnd(18)} provisional ${t.provisionalAverage == null ? '—' : formatScore(t.provisionalAverage)}`,
      );
    }
    console.log(
      `\nDashboard: ${dash.evaluations.submitted}/${dash.evaluations.required} submitted, ${dash.evaluations.draft} drafts, ` +
        `${dash.teamStatus.ready} ready, ${dash.teamStatus.blocked} blocked.`,
    );
    const matches =
      JSON.stringify(results.official.teams.map((t) => [t.teamCode, t.rank])) ===
      JSON.stringify(DEMO_EXPECTED.official.map(([c, r]) => [c, r]));
    console.log(
      matches
        ? 'OK  matches the documented expected results'
        : 'WARN  differs from the documented expected results',
    );

    printSecretBox([
      'DEMO ACCOUNTS (fictional, demo database only)',
      'demo.admin@demo.local (administrator)',
      'amina@ / bassem@ / carla@ / emad@demo.local (judges); dina@ is disabled',
      `Password for all of them: ${loginPassword}`,
      'Start the app on the demo database with:  npm run demo:dev',
    ]);
  } finally {
    await pool.end();
  }
  return 0;
});
