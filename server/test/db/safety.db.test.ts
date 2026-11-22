import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Connection } from 'mysql2/promise';
import {
  config,
  TEST_DB,
  testTarget,
  testMysql,
  connectTest,
  freshTestDatabase,
  dropDatabase,
  restoreTestDatabase,
} from './helpers.js';

let conn: Connection;
beforeAll(async () => {
  await freshTestDatabase();
  conn = await connectTest();
});
afterAll(async () => {
  await conn?.end();
  await dropDatabase(TEST_DB);
});

describe('destructive test operation guards', () => {
  it('rejects application database connections before connecting', async () => {
    expect(() => testMysql.createPool({ ...testTarget, database: config.db.database })).toThrow(
      /unsafe/,
    );
    await expect(
      testMysql.createConnection({ ...testTarget, database: config.db.database }),
    ).rejects.toThrow(/unsafe/);
  });
  it('rejects drops and restores aimed at application or foreign databases before SQL or file access', async () => {
    for (const name of [
      config.db.database,
      config.db.database.toUpperCase(),
      'mysql',
      'unrelated_test',
    ]) {
      await expect(dropDatabase(name)).rejects.toThrow(/unsafe/);
      await expect(restoreTestDatabase('file-that-does-not-exist.sql', name, {})).rejects.toThrow(
        /unsafe/,
      );
    }
  });
  it('blocks database switching and qualified cross-database mutations on a guarded connection', async () => {
    await expect(conn.query(`USE \`${config.db.database}\``)).rejects.toThrow(/guarded helpers/);
    await expect(conn.query(`DELETE FROM \`${config.db.database}\`.users`)).rejects.toThrow(
      /unsafe/,
    );
    await expect(conn.query(`DROP DATABASE \`${TEST_DB}\``)).rejects.toThrow(/guarded helpers/);
    const [rows] = await conn.query('SELECT DATABASE() AS name');
    expect((rows as { name: string }[])[0]?.name).toBe(TEST_DB);
  });
});
