/**
 * npm run db:check — verifies the connection to XAMPP MySQL using server/.env.
 * Exit code 0 = connected, 1 = not connected.
 */
import { ConfigError, loadConfig } from '../src/config.js';
import { checkDatabase, createPool } from '../src/db/pool.js';

async function main() {
  const config = loadConfig();
  const { host, port, user, database } = config.db;
  console.log(`Checking MySQL at ${host}:${port} as "${user}", database "${database}"…`);

  const pool = createPool(config.db);
  try {
    const result = await checkDatabase(pool, config.db, { includeHint: true });
    if (result.status === 'ok') {
      console.log(
        `OK  connected to ${result.database} on ${result.serverVersion} (${result.latencyMs} ms)`,
      );
      return 0;
    }
    console.error(`FAIL  ${result.code}: ${result.message}`);
    if (result.hint) console.error(`Fix: ${result.hint}`);
    return 1;
  } finally {
    await pool.end();
  }
}

main()
  .then((code) => process.exit(code))
  .catch((error: unknown) => {
    console.error(error instanceof ConfigError ? error.message : error);
    process.exit(1);
  });
