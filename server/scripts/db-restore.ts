/**
 * npm run db:restore -- <backup.sql>   Replaces the database with a backup.
 * Verifies the checksum, asks you to type the database name, and takes a safety
 * backup of the current data first. Add --yes to skip the prompt (scripts only).
 */
import { basename, resolve } from 'node:path';
import { existsSync } from 'node:fs';
import { loadToolConfig } from '../src/config.js';
import { backupDatabase, restoreDatabase, verifyBackupChecksum } from '../src/db/backup.js';
import { adminServer, confirmByTyping, hasFlag, runScript } from './lib/cli.js';

runScript(async () => {
  const config = loadToolConfig();
  const fileArg = process.argv.slice(2).find((a) => !a.startsWith('--'));
  if (!fileArg) {
    console.error('Usage: npm run db:restore -- <path-to-backup.sql>');
    return 1;
  }
  // npm runs this from server/; resolve the path from where the user typed the command.
  const file = resolve(process.env.INIT_CWD ?? process.cwd(), fileArg);
  if (!existsSync(file)) {
    console.error(`FAIL  file not found: ${file}`);
    return 1;
  }
  await verifyBackupChecksum(file);
  console.log(`OK  checksum verified for ${basename(file)}`);

  const database = config.db.database;
  if (!hasFlag('--yes')) {
    const ok = await confirmByTyping(
      database,
      `This REPLACES all data in "${database}" with ${basename(file)}.\nStop the API (npm run dev / npm start) first.`,
    );
    if (!ok) {
      console.error('Cancelled. Nothing was changed.');
      return 1;
    }
  }

  const server = adminServer(config);
  const safety = await backupDatabase(server, database, {
    dir: config.backupDir,
    binDir: config.mysqlBinDir,
    label: 'pre-restore',
  });
  console.log(`OK  safety backup of current data: ${basename(safety.file)}`);

  await restoreDatabase(server, file, database, {
    binDir: config.mysqlBinDir,
    inPlace: hasFlag('--in-place'),
  });
  console.log(`OK  restored "${database}" from ${basename(file)}`);
  return 0;
});
