/**
 * npm run db:restore-check — the restore drill. Takes a fresh backup, restores it
 * into a scratch database, and proves the copy is identical (row counts and
 * per-table checksums, triggers and views). The live database is not touched.
 */
import { basename } from 'node:path';
import mysql from 'mysql2/promise';
import { loadToolConfig } from '../src/config.js';
import {
  backupDatabase,
  compareFingerprints,
  fingerprintDatabase,
  restoreDatabase,
} from '../src/db/backup.js';
import { adminServer, runScript } from './lib/cli.js';

runScript(async () => {
  const config = loadToolConfig();
  const server = adminServer(config);
  const live = config.db.database;
  const scratch = `${live}_restore_check`.slice(0, 64);

  const backup = await backupDatabase(server, live, {
    dir: config.backupDir,
    binDir: config.mysqlBinDir,
  });
  console.log(`OK  backup written: ${basename(backup.file)}`);
  const before = await fingerprintDatabase(server, live);

  try {
    await restoreDatabase(server, backup.file, scratch, { binDir: config.mysqlBinDir });
    console.log(`OK  restored into scratch database "${scratch}"`);
    const after = await fingerprintDatabase(server, scratch);
    const problems = compareFingerprints(before, after);
    if (problems.length) {
      console.error('FAIL  the restored copy differs from the live database:');
      for (const p of problems) console.error(`      - ${p}`);
      return 1;
    }
    const tables = Object.keys(after.tables).length;
    const rows = Object.values(after.tables).reduce((n, t) => n + t.rows, 0);
    console.log(
      `OK  identical: ${tables} tables, ${rows} rows, ${after.triggers.length} triggers, ${after.views.length} views`,
    );
    console.log('    Backups are restorable.');
    return 0;
  } finally {
    const conn = await mysql.createConnection({ ...server, connectTimeout: 5_000 });
    await conn.query(`DROP DATABASE IF EXISTS \`${scratch}\``).finally(() => conn.end());
  }
});
