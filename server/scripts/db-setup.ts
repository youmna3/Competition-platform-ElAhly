/** npm run db:setup — one command for a new machine: create database, migrate, seed admin. */
import mysql from 'mysql2/promise';
import { loadToolConfig } from '../src/config.js';
import { migrate } from '../src/db/migrate.js';
import { seedInitialAdmin } from '../src/db/seed.js';
import { adminTarget, ensureDatabase, printSecretBox, runScript } from './lib/cli.js';

runScript(async () => {
  const config = loadToolConfig();
  const target = adminTarget(config);
  console.log(
    `Setting up "${target.database}" on ${target.host}:${target.port} as "${target.user}"…`,
  );

  const created = await ensureDatabase(config);
  console.log(
    created
      ? `OK  created database "${target.database}"`
      : `OK  database "${target.database}" exists`,
  );

  const result = await migrate(target, { log: (line) => console.log(line) });
  console.log(
    result.applied.length
      ? `OK  applied ${result.applied.length} migration(s)`
      : 'OK  schema already up to date',
  );

  const conn = await mysql.createConnection({ ...target, connectTimeout: 5_000 });
  try {
    const seed = await seedInitialAdmin(conn, config.admin);
    if (!seed.created) {
      console.log(`OK  administrator ${config.admin.email} already exists (unchanged)`);
    } else if (seed.generatedPassword) {
      console.log(`OK  created administrator ${config.admin.email}`);
      printSecretBox([
        'TEMPORARY ADMINISTRATOR PASSWORD (shown only once)',
        '',
        `E-mail:   ${config.admin.email}`,
        `Password: ${seed.generatedPassword}`,
        '',
        'Store it somewhere safe now. You must replace it at first sign-in.',
      ]);
    } else {
      console.log(`OK  created administrator ${config.admin.email} with ADMIN_INITIAL_PASSWORD`);
    }
    const [rows] = await conn.query('SELECT state FROM v_rubric_status');
    console.log(`OK  rubric state: ${(rows as { state: string }[])[0]?.state ?? 'unknown'}`);
  } finally {
    await conn.end();
  }
  return 0;
});
