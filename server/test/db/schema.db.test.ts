import type { Connection } from 'mysql2/promise';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  connectTest,
  createPublishableDraft,
  createTeam,
  createUser,
  dropDatabase,
  expectRefused,
  freshTestDatabase,
  publish,
  scalar,
  TEST_DB,
} from './helpers.js';

let conn: Connection;

beforeAll(async () => {
  await freshTestDatabase();
  conn = await connectTest();
});

afterAll(async () => {
  await conn.end();
  await dropDatabase(TEST_DB);
});

describe('users', () => {
  it('treats e-mail addresses case-insensitively', async () => {
    await createUser(conn, { email: 'judge.one@example.com' });
    await expectRefused(createUser(conn, { email: 'Judge.One@Example.com' }), /ER_DUP_ENTRY/);
  });

  it('refuses anything that is not a bcrypt hash as a password', async () => {
    await expectRefused(
      conn.query(
        "INSERT INTO users (email, full_name, password_hash) VALUES ('x@example.com', 'X', 'plain-text-password')",
      ),
      /chk_users_hash|CONSTRAINT/i,
    );
  });

  it('refuses invalid e-mails and empty names', async () => {
    const hash = '$2b$12$' + 'a'.repeat(53);
    await expectRefused(
      conn.query(
        "INSERT INTO users (email, full_name, password_hash) VALUES ('not-an-email', 'X', ?)",
        [hash],
      ),
      /chk_users_email|CONSTRAINT/i,
    );
    await expectRefused(
      conn.query(
        "INSERT INTO users (email, full_name, password_hash) VALUES ('y@example.com', '  ', ?)",
        [hash],
      ),
      /chk_users_name|CONSTRAINT/i,
    );
  });
});

describe('teams', () => {
  it('accepts legacy teams and two or three students while rejecting incomplete member rows', async () => {
    const id = await createTeam(conn, 'STUDENT-CHECK');
    await expectRefused(
      conn.query('UPDATE teams SET student_name_1=? WHERE id=?', ['Only student', id]),
      /chk_team_students|CONSTRAINT/i,
    );
    await conn.query(
      'UPDATE teams SET student_name_1=?,student_name_2=?,student_name_3=? WHERE id=?',
      ['First student', 'Second student', 'Third student', id],
    );
    await expectRefused(
      conn.query("UPDATE teams SET presentation_link='javascript:alert(1)' WHERE id=?", [id]),
      /chk_team_presentation_link|CONSTRAINT/i,
    );
    await conn.query('UPDATE teams SET student_name_3=NULL,presentation_link=? WHERE id=?', [
      'https://example.com/slides',
      id,
    ]);
    expect(await scalar(conn, 'SELECT student_name_3 FROM teams WHERE id=?', [id])).toBe(null);
  });
  it('keeps Team IDs unique across the competition, ignoring case', async () => {
    await createTeam(conn, 'AHL-001');
    await expectRefused(createTeam(conn, 'ahl-001'), /ER_DUP_ENTRY/);
  });

  it('requires archive details to match the status', async () => {
    const id = await createTeam(conn, 'AHL-ARCH');
    await expectRefused(
      conn.query("UPDATE teams SET status = 'archived' WHERE id = ?", [id]),
      /chk_teams_archive|CONSTRAINT/i,
    );
    await conn.query(
      "UPDATE teams SET status = 'archived', archived_at = NOW(), archive_reason = 'test' WHERE id = ?",
      [id],
    );
    expect(await scalar(conn, 'SELECT status FROM teams WHERE id = ?', [id])).toBe('archived');
    await expectRefused(
      conn.query("UPDATE teams SET status = 'active' WHERE id = ?", [id]),
      /chk_teams_archive|CONSTRAINT/i,
    );
  });

  it('never deletes a team, even one with no evaluations, and keeps its assignments', async () => {
    const team = await createTeam(conn, 'AHL-DEL');
    const judge = await createUser(conn, { email: 'del.judge@example.com' });
    await conn.query('INSERT INTO team_judges (team_id, judge_id) VALUES (?, ?)', [team, judge]);
    await expectRefused(
      conn.query('DELETE FROM teams WHERE id = ?', [team]),
      /Teams are never deleted/,
    );
    expect(
      await scalar<number>(conn, 'SELECT COUNT(*) FROM team_judges WHERE team_id = ?', [team]),
    ).toBe(1);
  });

  it('refuses to delete a team or judge that has evaluation history', async () => {
    const { version } = await createPublishableDraft(conn, { versionNo: 1 });
    await publish(conn, version);

    const team = await createTeam(conn, 'AHL-HIST');
    const judge = await createUser(conn, { email: 'hist.judge@example.com' });
    await conn.query(
      'INSERT INTO evaluations (team_id, judge_id, rubric_version_id) VALUES (?, ?, ?)',
      [team, judge, version],
    );

    await expectRefused(
      conn.query('DELETE FROM teams WHERE id = ?', [team]),
      /Teams are never deleted/,
    );
    await expectRefused(
      conn.query('DELETE FROM users WHERE id = ?', [judge]),
      /ER_ROW_IS_REFERENCED/,
    );
  });
});

describe('audit log', () => {
  it('accepts JSON details and refuses anything else', async () => {
    await conn.query(
      "INSERT INTO audit_log (action, entity_type, details) VALUES ('test.event', 'test', '{\"ok\":true}')",
    );
    await expectRefused(
      conn.query(
        "INSERT INTO audit_log (action, entity_type, details) VALUES ('test.event', 'test', 'not json')",
      ),
      /chk_audit_details_json|CONSTRAINT/i,
    );
  });

  it('is append-only: rows can never be edited or deleted', async () => {
    await expectRefused(conn.query("UPDATE audit_log SET action = 'tampered'"), /append-only/);
    await expectRefused(conn.query('DELETE FROM audit_log'), /append-only/);
  });
});
