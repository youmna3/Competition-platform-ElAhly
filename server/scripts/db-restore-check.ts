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
import { scratchDatabaseName, assertScratchTarget } from '../src/db/scratchName.js';

runScript(async () => {
  const config = loadToolConfig();
  const server = adminServer(config);
  const live = config.db.database;
  const scratch = scratchDatabaseName(live, '_restore_check');
  let owned = false;

  const backup = await backupDatabase(server, live, {
    dir: config.backupDir,
    binDir: config.mysqlBinDir,
  });
  console.log(`OK  backup written: ${basename(backup.file)}`);
  const before = await fingerprintDatabase(server, live);

  try {
    assertScratchTarget(live, scratch, '_restore_check');
    const claim = await mysql.createConnection({ ...server, connectTimeout: 5000 });
    try {
      // Refuse pre-existing databases; never adopt or delete someone else's scratch copy.
      await claim.query(
        `CREATE DATABASE \`${scratch}\` CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci`,
      );
      owned = true;
    } finally {
      await claim.end();
    }
    assertScratchTarget(live, scratch, '_restore_check');
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
    assertScratchTarget(live, scratch, '_restore_check');
    if (owned) {
      const conn = await mysql.createConnection({ ...server, connectTimeout: 5_000 });
      await conn.query(`DROP DATABASE IF EXISTS \`${scratch}\``).finally(() => conn.end());
    }
  }
});
