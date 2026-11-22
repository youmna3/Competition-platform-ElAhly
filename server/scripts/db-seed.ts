/** npm run db:seed — creates the first administrator (once) from server/.env. */
import mysql from 'mysql2/promise';
import { PASSWORD_POLICY_TEXT } from '@judging/shared';
import { loadToolConfig } from '../src/config.js';
import { seedInitialAdmin } from '../src/db/seed.js';
import { adminTarget, printSecretBox, runScript } from './lib/cli.js';

runScript(async () => {
  const config = loadToolConfig();
  const conn = await mysql.createConnection({ ...adminTarget(config), connectTimeout: 5_000 });
  try {
    const result = await seedInitialAdmin(conn, config.admin);
    if (!result.created) {
      console.log(`OK  administrator ${config.admin.email} already exists (unchanged)`);
      return 0;
    }
    console.log(
      `OK  created administrator ${config.admin.email} (must change password at first sign-in)`,
    );
    if (result.generatedPassword) {
      printSecretBox([
        'TEMPORARY ADMINISTRATOR PASSWORD (shown only once)',
        '',
        `E-mail:   ${config.admin.email}`,
        `Password: ${result.generatedPassword}`,
        '',
        'Store it somewhere safe now. It is not saved anywhere in plain text.',
        'You will be asked to replace it at first sign-in.',
        `New passwords: ${PASSWORD_POLICY_TEXT}`,
      ]);
    } else {
      console.log(
        '    Password taken from ADMIN_INITIAL_PASSWORD. Remove it from server/.env after first sign-in.',
      );
    }
    return 0;
  } finally {
    await conn.end();
  }
});
