import { appendFileSync, mkdtempSync, rmSync, truncateSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Connection } from 'mysql2/promise';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  backupDatabase,
  compareFingerprints,
  fingerprintDatabase,
  verifyBackupChecksum,
  verifyDumpComplete,
} from '../../src/db/backup.js';
import { seedInitialAdmin } from '../../src/db/seed.js';
import {
  adminServer,
  config,
  connectTest,
  createTeam,
  dropDatabase,
  freshTestDatabase,
  scalar,
  TEST_DB,
  RESTORE_DB,
  testMysql,
  restoreTestDatabase,
} from './helpers.js';

const SCRATCH = RESTORE_DB;
const dir = mkdtempSync(join(tmpdir(), 'judging-backups-'));
let conn: Connection;

beforeAll(async () => {
  await freshTestDatabase();
  conn = await connectTest();
  await seedInitialAdmin(conn, { email: 'youmna54@gmail.com', fullName: 'Administrator' });
  await createTeam(conn, 'AHL-ÄRABIC-الأهلي'); // non-ASCII must survive the round trip
});

afterAll(async () => {
  await conn.end();
  await dropDatabase(SCRATCH);
  await dropDatabase(TEST_DB);
  rmSync(dir, { recursive: true, force: true });
});

describe('backup and restore', () => {
  it('produces a complete, checksummed backup that restores to an identical copy', async () => {
    const backup = await backupDatabase(adminServer, TEST_DB, { dir, binDir: config.mysqlBinDir });
    expect(backup.bytes).toBeGreaterThan(1000);
    verifyDumpComplete(backup.file);
    await verifyBackupChecksum(backup.file);

    await restoreTestDatabase(backup.file, SCRATCH, { binDir: config.mysqlBinDir });
    const problems = compareFingerprints(
      await fingerprintDatabase(adminServer, TEST_DB),
      await fingerprintDatabase(adminServer, SCRATCH),
    );
    expect(problems).toEqual([]);

    // Triggers still protect the restored copy.
    const restored = await testMysql.createConnection({ ...adminServer, database: SCRATCH });
    try {
      await expect(restored.query('DELETE FROM audit_log')).rejects.toThrow(/append-only/);
      expect(
        await scalar(restored, "SELECT team_code FROM teams WHERE team_code LIKE 'AHL-%'"),
      ).toBe('AHL-ÄRABIC-الأهلي');
    } finally {
      await restored.end();
    }
  });

  it('refuses to restore a file that was changed after the backup, leaving the target untouched', async () => {
    const backup = await backupDatabase(adminServer, TEST_DB, { dir, binDir: config.mysqlBinDir });
    appendFileSync(backup.file, '\nDROP TABLE users;\n');
    await expect(verifyBackupChecksum(backup.file)).rejects.toThrow(/does not match its checksum/);
    await expect(
      restoreTestDatabase(backup.file, SCRATCH, { binDir: config.mysqlBinDir }),
    ).rejects.toThrow(/checksum/);
    // The scratch copy from the previous test is still there and intact.
    const fp = await fingerprintDatabase(adminServer, SCRATCH);
    expect(fp.tables.users?.rows).toBe(1);
  });

  it('detects a cut-off backup file', async () => {
    const backup = await backupDatabase(adminServer, TEST_DB, { dir, binDir: config.mysqlBinDir });
    truncateSync(backup.file, Math.floor(statSync(backup.file).size / 2));
    expect(() => verifyDumpComplete(backup.file)).toThrow(/incomplete/);
  });
});
