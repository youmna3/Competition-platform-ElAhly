/**
 * npm run db:create — creates the empty application database (utf8mb4) if it
 * does not exist yet. It creates no tables; the schema arrives in Phase 1.
 */
import mysql from 'mysql2/promise';
import { ConfigError, loadToolConfig } from '../src/config.js';
import { describeDatabaseError } from '../src/db/pool.js';
import { databaseSsl } from '../src/db/tls.js';

async function main() {
  const config = loadToolConfig();
  const { host, port, database } = config.db;
  const { user, password } = config.dbAdmin;
  console.log(`Connecting to MySQL at ${host}:${port} as "${user}"…`);

  let connection;
  try {
    // Connect without selecting a database, because it may not exist yet.
    connection = await mysql.createConnection({
      host,
      port,
      user,
      password,
      ssl: databaseSsl(config.db),
      connectTimeout: 5_000,
    });
  } catch (error) {
    const { code, message, hint } = describeDatabaseError(error, config.db);
    console.error(`FAIL  ${code}: ${message}\nFix: ${hint}`);
    return 1;
  }

  try {
    // DB_NAME is validated by config.ts to [A-Za-z0-9_] so identifier quoting is safe.
    const [result] = await connection.query(
      `CREATE DATABASE IF NOT EXISTS \`${database}\` CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci`,
    );
    const created = (result as { warningStatus?: number }).warningStatus === 0;
    console.log(
      created ? `OK  created database "${database}"` : `OK  database "${database}" already exists`,
    );
    return 0;
  } catch (error) {
    const { code, message, hint } = describeDatabaseError(error, config.db);
    console.error(`FAIL  ${code}: ${message}\nFix: ${hint}`);
    return 1;
  } finally {
    await connection.end();
  }
}

main()
  .then((code) => process.exit(code))
  .catch((error: unknown) => {
    console.error(error instanceof ConfigError ? error.message : error);
    process.exit(1);
  });
