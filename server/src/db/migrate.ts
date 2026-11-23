import { createHash } from 'node:crypto';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import mysql, { type Connection, type RowDataPacket } from 'mysql2/promise';
import type { SslOptions } from 'mysql2';

/** server/migrations, resolved from this file so it works from any working directory. */
export const MIGRATIONS_DIR = [
  new URL('../../migrations', import.meta.url),
  new URL('../../../migrations', import.meta.url),
]
  .map((url) => fileURLToPath(url))
  .find((path) => existsSync(path))!;

const FILE_PATTERN = /^(\d{3})_([a-z0-9_]+)\.sql$/;

export interface MigrationFile {
  version: number;
  name: string;
  path: string;
  checksum: string;
  sql: string;
}

export interface AppliedMigration {
  version: number;
  name: string;
  checksum: string;
  applied_at: Date;
}

export interface DbTarget {
  ssl?: SslOptions;
  host: string;
  port: number;
  user: string;
  password: string;
  database: string;
}

/** Preserve historical SQL bytes/checksums; normalize only MariaDB's generated-column alias. */
export function migrationSqlForServer(file: MigrationFile, serverVersion: string): string {
  if (/mariadb/i.test(serverVersion) || file.version !== 7) return file.sql;
  return file.sql.replace(
    /(ADD COLUMN (?:published_slot|draft_slot) TINYINT AS \(IF\(status = '(?:published|draft)', 1, NULL\)\)) PERSISTENT/g,
    '$1 STORED',
  );
}

/** Reads and validates migration files in version order. */
export function readMigrations(dir = MIGRATIONS_DIR): MigrationFile[] {
  const files = readdirSync(dir)
    .filter((f) => f.endsWith('.sql'))
    .sort();
  const seen = new Set<number>();
  return files.map((file) => {
    const match = FILE_PATTERN.exec(file);
    if (!match) throw new Error(`Bad migration file name "${file}" (expected 001_name.sql)`);
    const version = Number(match[1]);
    if (seen.has(version)) throw new Error(`Duplicate migration version ${version}`);
    seen.add(version);
    // Normalise line endings so a Windows checkout (CRLF) gives the same checksum.
    const sql = readFileSync(join(dir, file), 'utf8').replace(/\r\n/g, '\n');
    return {
      version,
      name: match[2] ?? file,
      path: join(dir, file),
      checksum: createHash('sha256').update(sql).digest('hex'),
      sql,
    };
  });
}

/** A dedicated connection: migrations need multi-statement queries, the app pool never allows them. */
export function migrationConnection(target: DbTarget): Promise<Connection> {
  return mysql.createConnection({
    ...target,
    multipleStatements: true,
    charset: 'utf8mb4_unicode_ci',
    connectTimeout: 5_000,
  });
}

async function ensureMigrationsTable(conn: Connection) {
  await conn.query(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      version      INT UNSIGNED NOT NULL PRIMARY KEY,
      name         VARCHAR(100) NOT NULL,
      checksum     CHAR(64) NOT NULL,
      applied_at   DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      execution_ms INT UNSIGNED NOT NULL
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`);
}

export async function appliedMigrations(conn: Connection): Promise<AppliedMigration[]> {
  await ensureMigrationsTable(conn);
  const [rows] = await conn.query<(RowDataPacket & AppliedMigration)[]>(
    'SELECT version, name, checksum, applied_at FROM schema_migrations ORDER BY version',
  );
  return rows;
}

export interface MigrateResult {
  applied: { version: number; name: string; ms: number }[];
  alreadyApplied: number;
}

/**
 * Applies pending migrations in order. Refuses to run if an already-applied
 * file was edited (checksum mismatch) or if the database has migrations this
 * code doesn't know about. A named lock prevents two runs at once.
 */
export async function migrate(
  target: DbTarget,
  {
    dir = MIGRATIONS_DIR,
    log = (_: string) => {},
  }: { dir?: string; log?: (line: string) => void } = {},
): Promise<MigrateResult> {
  const files = readMigrations(dir);
  const conn = await migrationConnection(target);
  try {
    const [[server]] = await conn.query<RowDataPacket[]>('SELECT VERSION() AS version');
    const [lockRows] = await conn.query<RowDataPacket[]>(
      "SELECT GET_LOCK('judging_migrations', 10) AS ok",
    );
    if (lockRows[0]?.ok !== 1)
      throw new Error('Another migration is running. Try again in a moment.');

    try {
      const applied = await appliedMigrations(conn);
      const byVersion = new Map(files.map((f) => [f.version, f]));
      for (const row of applied) {
        const file = byVersion.get(row.version);
        if (!file) {
          throw new Error(
            `The database has migration ${row.version} (${row.name}) but no matching file exists. ` +
              'Are you running an older copy of the project?',
          );
        }
        if (file.checksum !== row.checksum) {
          throw new Error(
            `Migration ${file.version}_${file.name}.sql was changed after it was applied. ` +
              'Never edit applied migrations; add a new one instead.',
          );
        }
      }

      const done = new Set(applied.map((a) => a.version));
      const result: MigrateResult = { applied: [], alreadyApplied: done.size };
      for (const file of files) {
        if (done.has(file.version)) continue;
        log(`Applying ${String(file.version).padStart(3, '0')}_${file.name}.sql …`);
        const started = performance.now();
        try {
          await conn.query(migrationSqlForServer(file, String(server!.version)));
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          throw new Error(
            `Migration ${file.version}_${file.name}.sql failed: ${message}\n` +
              'MySQL cannot roll back table changes, so the database may be partly migrated. ' +
              'Restore your latest backup (npm run db:restore) or, on a development machine, run npm run db:reset.',
            { cause: error },
          );
        }
        const ms = Math.round(performance.now() - started);
        await conn.query(
          'INSERT INTO schema_migrations (version, name, checksum, execution_ms) VALUES (?, ?, ?, ?)',
          [file.version, file.name, file.checksum, ms],
        );
        result.applied.push({ version: file.version, name: file.name, ms });
      }
      return result;
    } finally {
      await conn.query("SELECT RELEASE_LOCK('judging_migrations')");
    }
  } finally {
    await conn.end();
  }
}

/** Pending migration files for a status report. */
export async function migrationStatus(target: DbTarget, dir = MIGRATIONS_DIR) {
  const files = readMigrations(dir);
  const conn = await migrationConnection(target);
  try {
    const [exists] = await conn.query<RowDataPacket[]>(
      "SELECT 1 FROM information_schema.TABLES WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='schema_migrations'",
    );
    const applied = exists.length
      ? (
          await conn.query<(RowDataPacket & AppliedMigration)[]>(
            'SELECT version,name,checksum,applied_at FROM schema_migrations ORDER BY version',
          )
        )[0]
      : [];
    const done = new Map(applied.map((a) => [a.version, a]));
    return files.map((f) => ({
      version: f.version,
      name: f.name,
      appliedAt: done.get(f.version)?.applied_at ?? null,
      modified: done.has(f.version) && done.get(f.version)?.checksum !== f.checksum,
    }));
  } finally {
    await conn.end();
  }
}
