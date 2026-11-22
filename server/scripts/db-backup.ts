/** npm run db:backup — consistent snapshot of the database into the backups folder. */
import { basename } from 'node:path';
import { loadToolConfig } from '../src/config.js';
import { backupDatabase } from '../src/db/backup.js';
import { adminServer, runScript } from './lib/cli.js';

runScript(async () => {
  const config = loadToolConfig();
  console.log(`Backing up "${config.db.database}" to ${config.backupDir} …`);
  const result = await backupDatabase(adminServer(config), config.db.database, {
    dir: config.backupDir,
    binDir: config.mysqlBinDir,
  });
  console.log(`OK  ${basename(result.file)} (${(result.bytes / 1024).toFixed(1)} KB)`);
  console.log(`    SHA-256 ${result.sha256}`);
  return 0;
});
