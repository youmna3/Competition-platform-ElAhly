/**
 * npm run db:app-user — creates the least-privilege MySQL account the API uses
 * at runtime (default "judging_app"). Uses DB_APP_PASSWORD, or generates one.
 */
import mysql from 'mysql2/promise';
import { passwordProblems } from '@judging/shared';
import { loadToolConfig } from '../src/config.js';
import { createAppUser } from '../src/db/appUser.js';
import { generateTemporaryPassword } from '../src/db/seed.js';
import { adminTarget, printSecretBox, runScript } from './lib/cli.js';

runScript(async () => {
  const config = loadToolConfig();
  if (config.dbApp.user === config.dbAdmin.user) {
    console.error('FAIL  DB_APP_USER must differ from the admin account used for migrations.');
    return 1;
  }
  let password = config.dbApp.password;
  const generated = !password;
  if (password) {
    const problems = passwordProblems(password);
    if (problems.length) {
      console.error(`FAIL  DB_APP_PASSWORD is too weak: it ${problems.join(', ')}.`);
      return 1;
    }
  } else {
    // Avoid characters that need escaping in .env files.
    password = generateTemporaryPassword(24).replace(/[#=$\\"']/g, 'x');
    if (passwordProblems(password).length) password = `${password}A1!a`;
  }

  const conn = await mysql.createConnection({ ...adminTarget(config), connectTimeout: 5_000 });
  try {
    const { grants } = await createAppUser(conn, {
      user: config.dbApp.user,
      password,
      database: config.db.database,
    });
    console.log(`OK  MySQL account "${config.dbApp.user}" is ready with these permissions:`);
    for (const line of grants) console.log(`    ${line}`);
  } finally {
    await conn.end();
  }

  if (generated)
    printSecretBox([
      'NEW RUNTIME DATABASE PASSWORD (shown once; store privately)',
      `DB_USER=${config.dbApp.user}`,
      `DB_PASSWORD=${password}`,
    ]);
  console.log('Configure DB_USER and DB_PASSWORD through the protected runtime environment.');
  console.log('Keep DB_ADMIN_USER and DB_ADMIN_PASSWORD in the separate maintenance environment.');
  return 0;
});
