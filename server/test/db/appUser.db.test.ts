import { testMysql as mysql } from './helpers.js';
import { type Connection } from 'mysql2/promise';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createAppUser } from '../../src/db/appUser.js';
import {
  adminServer,
  config,
  connectTest,
  dropDatabase,
  expectRefused,
  freshTestDatabase,
  TEST_DB,
} from './helpers.js';

const APP_USER = `jt_${TEST_DB.slice(-28).replace(/[^a-zA-Z0-9_]/g, '_')}`;
const APP_PASSWORD = 'App-User-Test-Pass-1!';
let admin: Connection;
let app: Connection;
let accountOwned = false;

beforeAll(async () => {
  await freshTestDatabase();
  admin = await connectTest();
  if ([config.db.user, config.dbAdmin.user].includes(APP_USER))
    throw new Error('Refusing to alter a configured MySQL account');
  const [existing] = await admin.query('SELECT User FROM mysql.user WHERE User = ?', [APP_USER]);
  if ((existing as unknown[]).length)
    throw new Error('Refusing to replace a pre-existing MySQL test account');
  await createAppUser(admin, { user: APP_USER, password: APP_PASSWORD, database: TEST_DB });
  accountOwned = true;
  app = await mysql.createConnection({
    host: adminServer.host,
    port: adminServer.port,
    user: APP_USER,
    password: APP_PASSWORD,
    database: TEST_DB,
  });
});

afterAll(async () => {
  await app?.end();
  if (accountOwned)
    await admin.query(`DROP USER IF EXISTS '${APP_USER}'@'localhost', '${APP_USER}'@'127.0.0.1'`);
  await admin?.end();
  await dropDatabase(TEST_DB);
});

describe('least-privilege runtime account', () => {
  it('can read data and the rubric status view', async () => {
    const [rows] = await app.query('SELECT state FROM v_rubric_status');
    expect((rows as { state: string }[])[0]?.state).toBe('not_configured');
  });

  it('can write normal data and append to the audit log', async () => {
    await app.query(
      "INSERT INTO audit_log (action, entity_type, details) VALUES ('app.test', 'test', '{}')",
    );
    await app.query("INSERT INTO sessions (session_id, expires, data) VALUES ('s1', 1, '{}')");
    await app.query("DELETE FROM sessions WHERE session_id = 's1'");
  });

  it('cannot edit the audit log or delete evaluation history', async () => {
    await expectRefused(
      app.query("UPDATE audit_log SET action = 'x'"),
      /ER_TABLEACCESS_DENIED_ERROR|denied/i,
    );
    await expectRefused(app.query('DELETE FROM audit_log'), /ER_TABLEACCESS_DENIED_ERROR|denied/i);
    await expectRefused(
      app.query('DELETE FROM evaluations'),
      /ER_TABLEACCESS_DENIED_ERROR|denied/i,
    );
    await expectRefused(
      app.query('DELETE FROM evaluation_scores'),
      /ER_TABLEACCESS_DENIED_ERROR|denied/i,
    );
    await expectRefused(app.query('DELETE FROM users'), /ER_TABLEACCESS_DENIED_ERROR|denied/i);
  });

  it('cannot change the schema or migration history', async () => {
    await expectRefused(app.query('DROP TABLE teams'), /denied/i);
    await expectRefused(app.query('CREATE TABLE hacked (id INT)'), /denied/i);
    await expectRefused(app.query('ALTER TABLE users ADD COLUMN x INT'), /denied/i);
    await expectRefused(
      app.query(
        "INSERT INTO schema_migrations (version, name, checksum, execution_ms) VALUES (500, 'x', 'x', 0)",
      ),
      /denied/i,
    );
  });
});
