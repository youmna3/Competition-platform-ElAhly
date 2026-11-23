/**
 * Helpers for the real-database tests. Every test file gets a freshly migrated
 * guarded, hashed scratch database. The real database is never mutated.
 */
import mysql, { type Connection, type ResultSetHeader, type RowDataPacket } from 'mysql2/promise';
import bcrypt from 'bcryptjs';
import { expect } from 'vitest';
import { loadToolConfig } from '../../src/config.js';
import { assertTestDatabase, testDatabaseNames } from '../databaseSafety.js';
import { restoreDatabase } from '../../src/db/backup.js';
import { migrate, type DbTarget } from '../../src/db/migrate.js';

export const config = loadToolConfig();
const names = testDatabaseNames(config.db.database);
export const TEST_DB = names.test;
export const RESTORE_DB = names.restore;
const owned = new Set<string>();
export function guardTestName(name: string) {
  assertTestDatabase(name, config.db.database, config.env);
}
guardTestName(TEST_DB);

export const adminServer = {
  host: config.db.host,
  port: config.db.port,
  user: config.dbAdmin.user,
  password: config.dbAdmin.password,
};

export const testTarget: DbTarget = { ...adminServer, database: TEST_DB };

/** Every query on a test connection is checked on that SAME physical connection. */
function guardedConnection<T extends Connection>(conn: T): T {
  return new Proxy(conn, {
    get(target, property) {
      if (property === 'query' || property === 'execute')
        return async (...args: unknown[]) => {
          const [[row]] = await target.query<RowDataPacket[]>('SELECT DATABASE() AS name');
          const name = String(row?.name ?? '');
          guardTestName(name);
          if (!owned.has(name)) throw new Error('Test database is not owned by this test process');
          const sql =
            typeof args[0] === 'string'
              ? args[0]
              : String((args[0] as { sql?: string })?.sql ?? '');
          if (/\b(?:USE|(?:DROP|CREATE)\s+(?:DATABASE|SCHEMA))\b/i.test(sql))
            throw new Error('Database switching/destruction must use guarded helpers');
          if (
            /^\s*(?:DELETE|UPDATE|INSERT|REPLACE|ALTER|DROP|CREATE|TRUNCATE|RENAME|GRANT|REVOKE)\b/i.test(
              sql,
            )
          ) {
            const targets = [
              ...sql.matchAll(
                /\b(?:FROM|INTO|UPDATE|TABLE|TRIGGER)\s+(?:IF\s+(?:NOT\s+)?EXISTS\s+)?`?([A-Za-z0-9_]+)`?\s*\./gi,
              ),
              ...sql.matchAll(
                /\b(?:BEFORE|AFTER)\s+(?:UPDATE|INSERT|DELETE)\s+ON\s+`?([A-Za-z0-9_]+)`?\s*\./gi,
              ),
              ...(/^\s*(?:GRANT|REVOKE)\b/i.test(sql)
                ? sql.matchAll(/\bON\s+`?([A-Za-z0-9_]+)`?\s*\./gi)
                : []),
            ];
            for (const match of targets) {
              guardTestName(match[1]!);
              if (match[1]!.toLowerCase() !== name.toLowerCase())
                throw new Error('Cross-database test mutation refused');
            }
          }
          return Reflect.apply(target[property], target, args);
        };
      const value = Reflect.get(target, property);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
}
async function claim(name: string) {
  guardTestName(name);
  if (owned.has(name)) return;
  const conn = await mysql.createConnection(adminServer);
  try {
    // CREATE without IF NOT EXISTS atomically claims a new database. An existing
    // name is refused, even when it happens to look like one of our test names.
    guardTestName(name);
    await conn.query(
      `CREATE DATABASE \`${name}\` CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci`,
    );
    owned.add(name);
  } finally {
    await conn.end();
  }
}
export const testMysql = {
  createPool(options: Parameters<typeof mysql.createPool>[0]) {
    if (typeof options === 'string') throw new Error('Explicit test database options required');
    guardTestName(String(options.database));
    const pool = mysql.createPool(options);
    return new Proxy(pool, {
      get(target, property) {
        if (property === 'getConnection')
          return async () => guardedConnection(await target.getConnection());
        if (property === 'query' || property === 'execute')
          return async (...args: unknown[]) => {
            const conn = guardedConnection(await target.getConnection());
            try {
              return await Reflect.apply(conn[property], conn, args);
            } finally {
              conn.release();
            }
          };
        const value = Reflect.get(target, property);
        return typeof value === 'function' ? value.bind(target) : value;
      },
    });
  },
  async createConnection(options: Parameters<typeof mysql.createConnection>[0]) {
    if (typeof options === 'string') throw new Error('Explicit test database options required');
    guardTestName(String(options.database));
    return guardedConnection(await mysql.createConnection(options));
  },
};
export async function dropDatabase(name: string) {
  guardTestName(name);
  if (!owned.has(name)) return; // Never remove another process's database.
  const conn = await mysql.createConnection(adminServer);
  try {
    guardTestName(name);
    await conn.query(`DROP DATABASE IF EXISTS \`${name}\``);
    owned.delete(name);
  } finally {
    await conn.end();
  }
}
export async function freshTestDatabase(): Promise<DbTarget> {
  await claim(TEST_DB);
  await dropDatabase(TEST_DB);
  await claim(TEST_DB);
  guardTestName(TEST_DB);
  await migrate(testTarget);
  return testTarget;
}
export function connectTest(): Promise<Connection> {
  return testMysql.createConnection({ ...testTarget, charset: 'utf8mb4_unicode_ci' });
}
export async function restoreTestDatabase(
  file: string,
  name: string,
  options: { binDir?: string; inPlace?: boolean },
) {
  await claim(name);
  guardTestName(name);
  await restoreDatabase(adminServer, file, name, options);
}

/** Asserts that a statement is refused, with a message or error code matching `pattern`. */
export async function expectRefused(promise: Promise<unknown>, pattern: RegExp) {
  let error: unknown;
  try {
    await promise;
  } catch (e) {
    error = e;
  }
  expect(error, `expected the database to refuse (${pattern})`).toBeDefined();
  const { message = '', code = '' } = error as { message?: string; code?: string };
  expect(`${code} ${message}`).toMatch(pattern);
}

export async function scalar<T = unknown>(
  conn: Connection,
  sql: string,
  params: unknown[] = [],
): Promise<T> {
  const [rows] = await conn.query<RowDataPacket[]>(sql, params);
  const row = rows[0];
  return (row ? Object.values(row)[0] : undefined) as T;
}

// ---------- fixtures (plain SQL; the real services arrive in later phases) ----------

const FIXTURE_HASH = bcrypt.hashSync('Fixture-Password-1!', 4);

export async function createUser(
  conn: Connection,
  { email, role = 'judge' }: { email: string; role?: 'admin' | 'judge' },
): Promise<number> {
  const [r] = await conn.query<ResultSetHeader>(
    'INSERT INTO users (email, full_name, password_hash, role) VALUES (?, ?, ?, ?)',
    [email, `Test ${role}`, FIXTURE_HASH, role],
  );
  return r.insertId;
}

export async function createTeam(conn: Connection, code: string): Promise<number> {
  const [r] = await conn.query<ResultSetHeader>(
    'INSERT INTO teams (team_code, name, project_name) VALUES (?, ?, ?)',
    [code, `Team ${code}`, `Project ${code}`],
  );
  return r.insertId;
}

export async function createDraft(
  conn: Connection,
  {
    versionNo,
    title = 'Test rubric',
    totalTarget = null,
  }: { versionNo: number; title?: string; totalTarget?: number | null },
): Promise<number> {
  const [r] = await conn.query<ResultSetHeader>(
    'INSERT INTO rubric_versions (version_no, title, total_target) VALUES (?, ?, ?)',
    [versionNo, title, totalTarget],
  );
  await conn.query('UPDATE rubric SET draft_version_id = ? WHERE id = 1', [r.insertId]);
  return r.insertId;
}

export async function addSection(
  conn: Connection,
  versionId: number,
  {
    position,
    title = `Section ${position}`,
    isBonus = false,
  }: { position: number; title?: string; isBonus?: boolean },
): Promise<number> {
  const [r] = await conn.query<ResultSetHeader>(
    'INSERT INTO rubric_sections (rubric_version_id, position, title, is_bonus) VALUES (?, ?, ?, ?)',
    [versionId, position, title, isBonus],
  );
  return r.insertId;
}

export async function addCriterion(
  conn: Connection,
  versionId: number,
  sectionId: number,
  {
    position,
    min = 0,
    max = 10,
    weight = 1,
    required = true,
  }: { position: number; min?: number; max?: number; weight?: number; required?: boolean },
): Promise<number> {
  const [r] = await conn.query<ResultSetHeader>(
    `INSERT INTO rubric_criteria
       (rubric_version_id, section_id, position, title, min_score, max_score, weight, is_required)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    [versionId, sectionId, position, `Criterion ${position}`, min, max, weight, required],
  );
  return r.insertId;
}

/**
 * A draft in the competition's fixed shape (4 sections Ã— 2 criteria, 1-5 stars,
 * criterion weight = section % / 10), ready to publish when the weights total 100.
 */
export async function createPublishableDraft(
  conn: Connection,
  {
    versionNo,
    title = 'Test rubric',
    weights = [25, 25, 25, 25],
  }: { versionNo: number; title?: string; weights?: number[] },
): Promise<{
  version: number;
  sections: number[];
  criteria: number[];
  criterion: number;
  section: number;
}> {
  const version = await createDraft(conn, { versionNo, title, totalTarget: 100 });
  await conn.query('UPDATE rubric_versions SET scale_min = 1, scale_max = 5 WHERE id = ?', [
    version,
  ]);
  const sections: number[] = [];
  const criteria: number[] = [];
  for (const [i, w] of weights.entries()) {
    const [r] = await conn.query<ResultSetHeader>(
      'INSERT INTO rubric_sections (rubric_version_id, position, title, weight_percent) VALUES (?, ?, ?, ?)',
      [version, i + 1, `Section ${i + 1}`, w],
    );
    sections.push(r.insertId);
    for (const position of [1, 2]) {
      criteria.push(
        await addCriterion(conn, version, r.insertId, { position, min: 1, max: 5, weight: w / 10 }),
      );
    }
  }
  return { version, sections, criteria, criterion: criteria[0]!, section: sections[0]! };
}

/** The publish transaction the Rubric Management service runs. */
export async function publish(conn: Connection, versionId: number) {
  await conn.beginTransaction();
  try {
    await conn.query(
      "UPDATE rubric_versions SET status = 'retired', retired_at = NOW() WHERE status = 'published'",
    );
    await conn.query(
      "UPDATE rubric_versions SET status = 'published', published_at = NOW() WHERE id = ?",
      [versionId],
    );
    await conn.query(
      'UPDATE rubric SET published_version_id = ?, draft_version_id = NULL WHERE id = 1',
      [versionId],
    );
    await conn.commit();
  } catch (error) {
    await conn.rollback();
    throw error;
  }
}

export async function rubricState(conn: Connection): Promise<string> {
  return scalar<string>(conn, 'SELECT state FROM v_rubric_status');
}
