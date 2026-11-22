import { cpSync, mkdtempSync, rmSync, writeFileSync, appendFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Connection, RowDataPacket } from 'mysql2/promise';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { MIGRATIONS_DIR, migrate, readMigrations } from '../../src/db/migrate.js';
import {
  connectTest,
  dropDatabase,
  freshTestDatabase,
  rubricState,
  scalar,
  TEST_DB,
  testTarget,
} from './helpers.js';

const EXPECTED_TABLES = [
  'audit_log',
  'evaluation_events',
  'evaluation_scores',
  'evaluation_section_notes',
  'evaluations',
  'governorates',
  'rubric',
  'rubric_criteria',
  'rubric_scale_levels',
  'rubric_sections',
  'rubric_versions',
  'schema_migrations',
  'sessions',
  'team_judges',
  'teams',
  'users',
];

let conn: Connection;

beforeAll(async () => {
  await freshTestDatabase();
  conn = await connectTest();
});

afterAll(async () => {
  await conn.end();
  await dropDatabase(TEST_DB);
});

describe('migrations', () => {
  it('creates exactly the expected tables, all InnoDB and utf8mb4', async () => {
    const [rows] = await conn.query<RowDataPacket[]>(
      `SELECT TABLE_NAME AS name, ENGINE AS engine, TABLE_COLLATION AS collation
       FROM information_schema.TABLES WHERE TABLE_SCHEMA = ? AND TABLE_TYPE = 'BASE TABLE'
       ORDER BY TABLE_NAME`,
      [TEST_DB],
    );
    expect(rows.map((r) => String(r.name)).sort()).toEqual(EXPECTED_TABLES);
    for (const row of rows) {
      expect(row.engine, String(row.name)).toBe('InnoDB');
      expect(String(row.collation), String(row.name)).toMatch(/^utf8mb4_/);
    }
  });

  it('records every migration with its checksum', async () => {
    const files = readMigrations();
    const [rows] = await conn.query<RowDataPacket[]>(
      'SELECT version, checksum FROM schema_migrations ORDER BY version',
    );
    expect(rows.map((r) => [r.version, r.checksum])).toEqual(
      files.map((f) => [f.version, f.checksum]),
    );
  });

  it('is a no-op when run again', async () => {
    const result = await migrate(testTarget);
    expect(result.applied).toEqual([]);
    expect(result.alreadyApplied).toBe(readMigrations().length);
  });

  it('refuses to run when an applied migration file was edited', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'migrations-'));
    try {
      cpSync(MIGRATIONS_DIR, dir, { recursive: true });
      appendFileSync(join(dir, '001_core.sql'), '\n-- edited later\n');
      await expect(migrate(testTarget, { dir })).rejects.toThrow(/changed after it was applied/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('gives the same checksum for Windows (CRLF) line endings', () => {
    const dir = mkdtempSync(join(tmpdir(), 'migrations-crlf-'));
    try {
      cpSync(MIGRATIONS_DIR, dir, { recursive: true });
      const original = readMigrations();
      for (const file of original)
        writeFileSync(
          join(dir, `${String(file.version).padStart(3, '0')}_${file.name}.sql`),
          file.sql.replace(/\n/g, '\r\n'),
        );
      expect(readMigrations(dir).map((f) => f.checksum)).toEqual(original.map((f) => f.checksum));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('refuses to run against a database that is newer than the code', async () => {
    await conn.query(
      "INSERT INTO schema_migrations (version, name, checksum, execution_ms) VALUES (999, 'future', REPEAT('0', 64), 0)",
    );
    try {
      await expect(migrate(testTarget)).rejects.toThrow(/no matching file/);
    } finally {
      await conn.query('DELETE FROM schema_migrations WHERE version = 999');
    }
  });

  it('rejects badly named migration files', () => {
    const dir = mkdtempSync(join(tmpdir(), 'migrations-bad-'));
    try {
      writeFileSync(join(dir, 'add-stuff.sql'), 'SELECT 1;');
      expect(() => readMigrations(dir)).toThrow(/Bad migration file name/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('single-competition structure', () => {
  it('has no organization, category, grade or level columns anywhere', async () => {
    const [rows] = await conn.query<RowDataPacket[]>(
      `SELECT CONCAT(TABLE_NAME, '.', COLUMN_NAME) AS col FROM information_schema.COLUMNS
       WHERE TABLE_SCHEMA = ? AND (COLUMN_NAME LIKE '%organization%' OR COLUMN_NAME LIKE '%category%'
         OR COLUMN_NAME LIKE '%grade%' OR COLUMN_NAME LIKE 'level%' OR COLUMN_NAME LIKE '%competition%')`,
      [TEST_DB],
    );
    expect(rows.map((r) => r.col)).toEqual([]);
  });
});

describe('initial rubric state', () => {
  it('starts as "Not configured" with no versions, sections, criteria or scale labels', async () => {
    expect(await rubricState(conn)).toBe('not_configured');
    expect(await scalar<number>(conn, 'SELECT COUNT(*) FROM rubric')).toBe(1);
    for (const table of [
      'rubric_versions',
      'rubric_sections',
      'rubric_criteria',
      'rubric_scale_levels',
    ]) {
      expect(await scalar<number>(conn, `SELECT COUNT(*) FROM ${table}`), table).toBe(0);
    }
  });

  it('seeds no teams, evaluations or governorates', async () => {
    for (const table of ['teams', 'evaluations', 'governorates', 'team_judges']) {
      expect(await scalar<number>(conn, `SELECT COUNT(*) FROM ${table}`), table).toBe(0);
    }
  });
});
