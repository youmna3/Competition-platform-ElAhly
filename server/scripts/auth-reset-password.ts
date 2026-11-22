/**
 * npm run auth:reset-password -- [email] [--enable] [--yes]
 *
 * Account recovery that works without e-mail: run it on the server computer
 * (it needs the database credentials in server/.env). It replaces the account's
 * password with a new temporary one shown once, forces a change at next
 * sign-in, ends all of the account's sessions and clears any lockout.
 * Defaults to ADMIN_EMAIL. --enable also re-activates a disabled account.
 */
import mysql from 'mysql2/promise';
import { loadToolConfig } from '../src/config.js';
import { resetPasswordToTemporary } from '../src/auth/service.js';
import { adminTarget, confirmByTyping, hasFlag, printSecretBox, runScript } from './lib/cli.js';

runScript(async () => {
  const config = loadToolConfig();
  const email = (process.argv.slice(2).find((a) => !a.startsWith('--')) ?? config.admin.email)
    .trim()
    .toLowerCase();

  if (!hasFlag('--yes')) {
    const ok = await confirmByTyping(
      email,
      `This replaces the password of ${email} with a new temporary password and signs that account out everywhere.`,
    );
    if (!ok) {
      console.error('Cancelled. Nothing was changed. (Use --yes when running without a terminal.)');
      return 1;
    }
  }

  const conn = await mysql.createConnection({ ...adminTarget(config), connectTimeout: 5_000 });
  try {
    const result = await resetPasswordToTemporary(conn, {
      email,
      actor: { id: null, email: 'server-cli' },
      enable: hasFlag('--enable'),
    });
    printSecretBox([
      'NEW TEMPORARY PASSWORD (shown only once)',
      '',
      `E-mail:   ${email}`,
      `Password: ${result.temporaryPassword}`,
      '',
      'All existing sessions for this account have ended.',
      'The password must be changed at the next sign-in.',
      'Do not paste this password into chats, tickets or shared logs.',
    ]);
    if (result.wasDisabled) {
      console.warn('NOTE  this account is disabled. Re-run with --enable to re-activate it.');
    }
    return 0;
  } finally {
    await conn.end();
  }
});
