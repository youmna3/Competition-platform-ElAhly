/**
 * Helpers for the real-database tests. Every test file gets a freshly migrated
 * scratch database (<DB_NAME>_test). The real database is never touched.
 */
import mysql, { type Connection, type ResultSetHeader, type RowDataPacket } from 'mysql2/promise';
import bcrypt from 'bcryptjs';
import { expect } from 'vitest';
import { loadToolConfig } from '../../src/config.js';
import { migrate, type DbTarget } from '../../src/db/migrate.js';

export const config = loadToolConfig();
export const TEST_DB = `${config.db.database}_test`.slice(0, 64);

export const adminServer = {
  host: config.db.host,
  port: config.db.port,
  user: config.dbAdmin.user,
  password: config.dbAdmin.password,
};

export const testTarget: DbTarget = { ...adminServer, database: TEST_DB };

export async function dropDatabase(name: string) {
  const conn = await mysql.createConnection(adminServer);
  try {
    await conn.query(`DROP DATABASE IF EXISTS \`${name}\``);
  } finally {
    await conn.end();
  }
}

/** Drops and recreates the scratch database, then applies all migrations. */
export async function freshTestDatabase(): Promise<DbTarget> {
  const conn = await mysql.createConnection(adminServer);
  try {
    await conn.query(`DROP DATABASE IF EXISTS \`${TEST_DB}\``);
    await conn.query(
      `CREATE DATABASE \`${TEST_DB}\` CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci`,
    );
  } finally {
    await conn.end();
  }
  await migrate(testTarget);
  return testTarget;
}

export function connectTest(): Promise<Connection> {
  return mysql.createConnection({ ...testTarget, charset: 'utf8mb4_unicode_ci' });
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
 * A draft in the competition's fixed shape (4 sections × 2 criteria, 1-5 stars,
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
