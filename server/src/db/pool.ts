import mysql, { type Pool, type RowDataPacket } from 'mysql2/promise';
import type { DatabaseHealth } from '@judging/shared';
import type { AppConfig } from '../config.js';

export function createPool(db: AppConfig['db']): Pool {
  return mysql.createPool({
    host: db.host,
    port: db.port,
    user: db.user,
    password: db.password,
    database: db.database,
    connectionLimit: db.connectionLimit,
    connectTimeout: 5_000,
    waitForConnections: true,
    charset: 'utf8mb4_unicode_ci',
    // API and MySQL run on the same computer: read DATETIME values in its local time,
    // matching NOW() and CURRENT_TIMESTAMP on the server.
    timezone: 'local',
    dateStrings: false,
    supportBigNumbers: true,
    // Never allow several statements in one query string.
    multipleStatements: false,
  });
}

interface DriverError {
  code?: string;
  message?: string;
}

/** Turns a driver error into a safe code + message + plain-language hint. */
export function describeDatabaseError(
  error: unknown,
  db: Pick<AppConfig['db'], 'host' | 'port' | 'user' | 'database'>,
): { code: string; message: string; hint: string } {
  const { code = 'UNKNOWN', message = 'Unknown database error' } = (error ?? {}) as DriverError;
  const hints: Record<string, string> = {
    ECONNREFUSED: `Nothing is listening on ${db.host}:${db.port}. Start MySQL in the XAMPP Control Panel.`,
    ETIMEDOUT: `Connection to ${db.host}:${db.port} timed out. Check that MySQL is running in XAMPP and DB_HOST/DB_PORT are correct.`,
    ENOTFOUND: `The host "${db.host}" could not be found. Use DB_HOST=127.0.0.1.`,
    ER_ACCESS_DENIED_ERROR: `MySQL rejected user "${db.user}". Check DB_USER and DB_PASSWORD in server/.env.`,
    ER_BAD_DB_ERROR: `Database "${db.database}" does not exist yet. Run: npm run db:create`,
    ER_DBACCESS_DENIED_ERROR: `User "${db.user}" may not use database "${db.database}". Check the user's grants.`,
    PROTOCOL_SEQUENCE_TIMEOUT: 'MySQL did not answer in time. Restart MySQL in XAMPP.',
  };
  return {
    code,
    // Driver messages for these codes contain no secrets; truncate defensively.
    message: message.slice(0, 300),
    hint: hints[code] ?? 'Check that MySQL is running in XAMPP and the DB_* values in server/.env.',
  };
}

/** Runs a trivial query and reports server version and round-trip time. */
export async function checkDatabase(
  pool: Pool,
  db: AppConfig['db'],
  { includeHint }: { includeHint: boolean },
): Promise<DatabaseHealth> {
  const started = performance.now();
  try {
    const [rows] = await pool.query<(RowDataPacket & { version?: string; db?: string | null })[]>({
      sql: 'SELECT VERSION() AS version, DATABASE() AS db',
      timeout: 5_000,
    });
    const row = rows[0];
    return {
      status: 'ok',
      serverVersion: String(row?.version ?? 'unknown'),
      database: String(row?.db ?? db.database),
      latencyMs: Math.round((performance.now() - started) * 10) / 10,
    };
  } catch (error) {
    const { code, message, hint } = describeDatabaseError(error, db);
    return includeHint
      ? { status: 'error', code, message, hint }
      : { status: 'error', code, message };
  }
}
