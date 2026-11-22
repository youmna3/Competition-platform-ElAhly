import type { Pool, PoolConnection, ResultSetHeader, RowDataPacket } from 'mysql2/promise';
import {
  TEAM_ERRORS,
  type AssignableUser,
  type BulkAssignResponse,
  type EvaluationProgress,
  type TeamDetails,
  type TeamSortField,
  type TeamStatus,
  type TeamSummary,
} from '@judging/shared';
import { writeAudit } from '../audit.js';
import { RuleError } from '../errors.js';
import type { ValidTeamInput } from './validation.js';

export interface Actor {
  id: number;
  email: string;
  ip?: string;
}

type Db = Pool | PoolConnection;

export async function inTransaction<T>(
  pool: Pool,
  work: (conn: PoolConnection) => Promise<T>,
): Promise<T> {
  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();
    const result = await work(conn);
    await conn.commit();
    return result;
  } catch (error) {
    await conn.rollback().catch(() => {});
    throw error;
  } finally {
    conn.release();
  }
}

const iso = (d: Date | null | undefined) => (d ? new Date(d).toISOString() : null);
const notFound = () =>
  new RuleError(404, TEAM_ERRORS.TEAM_NOT_FOUND, 'This team no longer exists.');
const codeTaken = (code: string) =>
  new RuleError(
    409,
    TEAM_ERRORS.TEAM_CODE_TAKEN,
    `Team ID "${code}" is already used by another team.`,
  );
const isDuplicate = (e: unknown) => (e as { code?: string })?.code === 'ER_DUP_ENTRY';

// ---------------------------------------------------------------------------
// Listing and details
// ---------------------------------------------------------------------------

const PROGRESS_COUNTS = `
  (SELECT COUNT(*) FROM team_judges tj WHERE tj.team_id = t.id) AS assigned_judges,
  (SELECT COUNT(*) FROM team_judges tj JOIN evaluations e ON e.team_id = tj.team_id AND e.judge_id = tj.judge_id
     WHERE tj.team_id = t.id AND e.status = 'submitted') AS submitted_evaluations,
  (SELECT COUNT(*) FROM team_judges tj JOIN evaluations e ON e.team_id = tj.team_id AND e.judge_id = tj.judge_id
     WHERE tj.team_id = t.id AND e.status = 'draft') AS draft_evaluations,
  (SELECT COUNT(DISTINCT e.rubric_version_id) FROM team_judges tj JOIN evaluations e ON e.team_id = tj.team_id AND e.judge_id = tj.judge_id
     WHERE tj.team_id = t.id) > 1 AS mixed_versions`;

function toSummary(r: RowDataPacket): TeamSummary {
  return {
    id: Number(r.id),
    teamCode: String(r.team_code),
    name: String(r.name),
    projectName: String(r.project_name),
    status: r.status as TeamStatus,
    createdAt: iso(r.created_at) as string,
    archivedAt: iso(r.archived_at),
    assignedJudges: Number(r.assigned_judges ?? 0),
    submittedEvaluations: Number(r.submitted_evaluations ?? 0),
    draftEvaluations: Number(r.draft_evaluations ?? 0),
    mixedVersions: Boolean(Number(r.mixed_versions ?? 0)),
  };
}

const SORT_COLUMNS: Record<TeamSortField, string> = {
  teamCode: 't.team_code',
  name: 't.name',
  projectName: 't.project_name',
  createdAt: 't.created_at',
  assignedJudges: 'assigned_judges',
  progress: 'submitted_evaluations / NULLIF(assigned_judges, 0)',
};

export interface ListTeamsQuery {
  search?: string;
  status?: TeamStatus;
  sort: TeamSortField;
  dir: 'asc' | 'desc';
  page: number;
  pageSize: number;
}

export async function listTeams(pool: Pool, q: ListTeamsQuery) {
  const where: string[] = [];
  const params: unknown[] = [];
  if (q.search) {
    const like = `%${q.search.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
    where.push('(t.team_code LIKE ? OR t.name LIKE ? OR t.project_name LIKE ?)');
    params.push(like, like, like);
  }
  if (q.status) {
    where.push('t.status = ?');
    params.push(q.status);
  }
  const clause = where.length ? `WHERE ${where.join(' AND ')}` : '';
  const [[count]] = (await pool.query(
    `SELECT COUNT(*) AS n FROM teams t ${clause}`,
    params,
  )) as unknown as [{ n: number }[]];
  // Sort column comes from a fixed allow-list, never from the request directly.
  const order = `${SORT_COLUMNS[q.sort]} ${q.dir === 'desc' ? 'DESC' : 'ASC'}, t.team_code ASC, t.id ASC`;
  const [rows] = await pool.query<RowDataPacket[]>(
    `SELECT t.id, t.team_code, t.name, t.project_name, t.status, t.created_at, t.archived_at, ${PROGRESS_COUNTS}
     FROM teams t
     ${clause}
     ORDER BY ${order}
     LIMIT ? OFFSET ?`,
    [...params, q.pageSize, (q.page - 1) * q.pageSize],
  );
  return {
    teams: rows.map(toSummary),
    total: Number(count?.n ?? 0),
    page: q.page,
    pageSize: q.pageSize,
  };
}

export async function getTeamDetails(db: Db, id: number): Promise<TeamDetails> {
  const [teams] = await db.query<RowDataPacket[]>(
    `SELECT t.*, cu.email AS created_by_email, ${PROGRESS_COUNTS}
     FROM teams t
     LEFT JOIN users cu ON cu.id = t.created_by
     WHERE t.id = ?`,
    [id],
  );
  const team = teams[0];
  if (!team) throw notFound();

  const [assignments] = await db.query<RowDataPacket[]>(
    `SELECT u.id, u.full_name, u.email, u.role, u.status, tj.assigned_at, ab.email AS assigned_by_email,
            e.status AS evaluation_status, e.submitted_at, e.required_scored, e.total_score,
            e.id AS evaluation_id, e.updated_at AS evaluation_updated_at, e.rubric_version_id,
            v.version_no, (e.rubric_version_id <> r.published_version_id) AS outdated
     FROM team_judges tj
     JOIN users u ON u.id = tj.judge_id
     JOIN rubric r ON r.id = 1
     LEFT JOIN users ab ON ab.id = tj.assigned_by
     LEFT JOIN evaluations e ON e.team_id = tj.team_id AND e.judge_id = tj.judge_id
     LEFT JOIN rubric_versions v ON v.id = e.rubric_version_id
     WHERE tj.team_id = ?
     ORDER BY u.full_name, u.id`,
    [id],
  );
  const [past] = await db.query<RowDataPacket[]>(
    `SELECT u.id, u.full_name, u.email, e.status, e.submitted_at, e.total_score, v.version_no, e.id AS evaluation_id
     FROM evaluations e JOIN users u ON u.id = e.judge_id
     JOIN rubric_versions v ON v.id = e.rubric_version_id
     WHERE e.team_id = ?
       AND NOT EXISTS (SELECT 1 FROM team_judges tj WHERE tj.team_id = e.team_id AND tj.judge_id = e.judge_id)
     ORDER BY u.full_name`,
    [id],
  );

  // Section weights of every rubric version these evaluations use.
  const versionIds = [
    ...new Set(
      assignments
        .filter((a) => a.rubric_version_id != null)
        .map((a) => Number(a.rubric_version_id)),
    ),
  ];
  const weightsOf = new Map<number, number[]>();
  if (versionIds.length) {
    const [w] = await db.query<RowDataPacket[]>(
      'SELECT rubric_version_id, weight_percent FROM rubric_sections WHERE rubric_version_id IN (?) ORDER BY rubric_version_id, position',
      [versionIds],
    );
    for (const row of w) {
      const key = Number(row.rubric_version_id);
      weightsOf.set(key, [...(weightsOf.get(key) ?? []), Number(row.weight_percent)]);
    }
  }
  const submittedRows = assignments.filter((a) => a.evaluation_status === 'submitted');
  const submittedVersions = new Set(submittedRows.map((a) => Number(a.rubric_version_id)));
  const updates = assignments
    .map((a) => (a.evaluation_updated_at ? new Date(a.evaluation_updated_at).getTime() : 0))
    .filter(Boolean);

  return {
    ...toSummary(team),
    provisionalAverage: submittedRows.length
      ? Math.round(
          (submittedRows.reduce((sum, a) => sum + Number(a.total_score), 0) /
            submittedRows.length) *
            1000,
        ) / 1000
      : null,
    readyForResults:
      assignments.length > 0 &&
      submittedRows.length === assignments.length &&
      submittedVersions.size === 1,
    lastUpdatedAt: updates.length ? new Date(Math.max(...updates)).toISOString() : null,
    archiveReason: team.archive_reason ? String(team.archive_reason) : null,
    createdByEmail: team.created_by_email ? String(team.created_by_email) : null,
    assignments: assignments.map((a) => ({
      judgeId: Number(a.id),
      fullName: String(a.full_name),
      email: String(a.email),
      role: a.role,
      accountStatus: a.status,
      assignedAt: iso(a.assigned_at) as string,
      assignedByEmail: a.assigned_by_email ? String(a.assigned_by_email) : null,
      evaluationStatus: (a.evaluation_status ?? 'not_started') as EvaluationProgress,
      submittedAt: iso(a.submitted_at),
      ratedCount: Number(a.required_scored ?? 0),
      totalScore: a.evaluation_status === 'submitted' ? Number(a.total_score) : null,
      rubricVersionNo: a.version_no == null ? null : Number(a.version_no),
      outdatedVersion: Boolean(Number(a.outdated ?? 0)),
      evaluationId: a.evaluation_id == null ? null : Number(a.evaluation_id),
      weights:
        a.rubric_version_id == null ? null : (weightsOf.get(Number(a.rubric_version_id)) ?? null),
      updatedAt: iso(a.evaluation_updated_at),
    })),
    pastEvaluations: past.map((p) => ({
      judgeId: Number(p.id),
      fullName: String(p.full_name),
      email: String(p.email),
      evaluationStatus: p.status,
      submittedAt: iso(p.submitted_at),
      totalScore: p.status === 'submitted' ? Number(p.total_score) : null,
      rubricVersionNo: Number(p.version_no),
      evaluationId: Number(p.evaluation_id),
    })),
  };
}

// ---------------------------------------------------------------------------
// Create, edit, archive, reactivate (teams are never deleted)
// ---------------------------------------------------------------------------

export function createTeam(pool: Pool, actor: Actor, input: ValidTeamInput): Promise<TeamDetails> {
  return inTransaction(pool, async (conn) => {
    const [dupes] = await conn.query<RowDataPacket[]>(
      'SELECT id FROM teams WHERE team_code = ? FOR UPDATE',
      [input.teamCode],
    );
    if (dupes.length) throw codeTaken(input.teamCode);
    let insert: ResultSetHeader;
    try {
      [insert] = await conn.query<ResultSetHeader>(
        'INSERT INTO teams (team_code, name, project_name, created_by) VALUES (?, ?, ?, ?)',
        [input.teamCode, input.name, input.projectName, actor.id],
      );
    } catch (error) {
      if (isDuplicate(error)) throw codeTaken(input.teamCode);
      throw error;
    }
    await writeAudit(conn, {
      actorId: actor.id,
      actorEmail: actor.email,
      action: 'team.created',
      entityType: 'team',
      entityId: insert.insertId,
      ipAddress: actor.ip,
      details: { team_code: input.teamCode, name: input.name, project_name: input.projectName },
    });
    return getTeamDetails(conn, insert.insertId);
  });
}

export function updateTeam(
  pool: Pool,
  actor: Actor,
  id: number,
  input: Partial<ValidTeamInput>,
): Promise<TeamDetails> {
  return inTransaction(pool, async (conn) => {
    const [rows] = await conn.query<RowDataPacket[]>(
      'SELECT * FROM teams WHERE id = ? FOR UPDATE',
      [id],
    );
    const team = rows[0];
    if (!team) throw notFound();

    const next = {
      teamCode: input.teamCode ?? String(team.team_code),
      name: input.name ?? String(team.name),
      projectName: input.projectName ?? String(team.project_name),
    };
    const changes: Record<string, { from: string; to: string }> = {};
    if (next.teamCode !== team.team_code)
      changes.team_code = { from: team.team_code, to: next.teamCode };
    if (next.name !== team.name) changes.name = { from: team.name, to: next.name };
    if (next.projectName !== team.project_name)
      changes.project_name = { from: team.project_name, to: next.projectName };
    if (Object.keys(changes).length === 0) return getTeamDetails(conn, id);

    if (changes.team_code) {
      const [dupes] = await conn.query<RowDataPacket[]>(
        'SELECT id FROM teams WHERE team_code = ? AND id <> ? FOR UPDATE',
        [next.teamCode, id],
      );
      if (dupes.length) throw codeTaken(next.teamCode);
    }
    try {
      await conn.query('UPDATE teams SET team_code = ?, name = ?, project_name = ? WHERE id = ?', [
        next.teamCode,
        next.name,
        next.projectName,
        id,
      ]);
    } catch (error) {
      if (isDuplicate(error)) throw codeTaken(next.teamCode);
      throw error;
    }
    await writeAudit(conn, {
      actorId: actor.id,
      actorEmail: actor.email,
      action: 'team.updated',
      entityType: 'team',
      entityId: id,
      ipAddress: actor.ip,
      details: { team_code: next.teamCode, changes },
    });
    return getTeamDetails(conn, id);
  });
}

export function setTeamStatus(
  pool: Pool,
  actor: Actor,
  id: number,
  status: TeamStatus,
  reason?: string,
): Promise<TeamDetails> {
  return inTransaction(pool, async (conn) => {
    const [rows] = await conn.query<RowDataPacket[]>(
      'SELECT id, team_code, status FROM teams WHERE id = ? FOR UPDATE',
      [id],
    );
    const team = rows[0];
    if (!team) throw notFound();
    if (team.status === status) {
      throw new RuleError(
        409,
        'NO_CHANGE',
        status === 'archived' ? 'This team is already archived.' : 'This team is already active.',
      );
    }
    if (status === 'archived') {
      await conn.query(
        "UPDATE teams SET status = 'archived', archived_at = NOW(), archived_by = ?, archive_reason = ? WHERE id = ?",
        [actor.id, reason || null, id],
      );
    } else {
      await conn.query(
        "UPDATE teams SET status = 'active', archived_at = NULL, archived_by = NULL, archive_reason = NULL WHERE id = ?",
        [id],
      );
    }
    await writeAudit(conn, {
      actorId: actor.id,
      actorEmail: actor.email,
      action: status === 'archived' ? 'team.archived' : 'team.reactivated',
      entityType: 'team',
      entityId: id,
      ipAddress: actor.ip,
      details: {
        team_code: team.team_code,
        ...(status === 'archived' ? { reason: reason || null } : {}),
      },
    });
    return getTeamDetails(conn, id);
  });
}

// ---------------------------------------------------------------------------
// Assignments
// ---------------------------------------------------------------------------

export async function listAssignableUsers(pool: Pool): Promise<AssignableUser[]> {
  const [rows] = await pool.query<RowDataPacket[]>(
    `SELECT u.id, u.full_name, u.email, u.role,
       (SELECT COUNT(*) FROM team_judges tj JOIN teams t ON t.id = tj.team_id AND t.status = 'active'
         WHERE tj.judge_id = u.id) AS assigned_teams
     FROM users u WHERE u.status = 'active'
     ORDER BY u.role = 'judge' DESC, u.full_name, u.id`,
  );
  return rows.map((r) => ({
    id: Number(r.id),
    fullName: String(r.full_name),
    email: String(r.email),
    role: r.role,
    assignedTeams: Number(r.assigned_teams),
  }));
}

const unique = (ids: number[]) => [...new Set(ids)];

/**
 * Adds every (team, judge) pair that doesn't exist yet. Refuses the whole
 * request if any team is archived or missing, or any account is disabled or
 * missing. Existing pairs are skipped (a judge is never assigned twice).
 */
async function addAssignments(
  conn: PoolConnection,
  actor: Actor,
  teamIds: number[],
  judgeIds: number[],
): Promise<BulkAssignResponse> {
  const tIds = unique(teamIds);
  const jIds = unique(judgeIds);
  if (!tIds.length || !jIds.length) return { added: 0, alreadyAssigned: 0 };

  const [teams] = await conn.query<RowDataPacket[]>(
    'SELECT id, team_code, status FROM teams WHERE id IN (?) FOR UPDATE',
    [tIds],
  );
  if (teams.length !== tIds.length) throw notFound();
  const archived = teams.filter((t) => t.status !== 'active');
  if (archived.length) {
    throw new RuleError(
      409,
      TEAM_ERRORS.TEAM_ARCHIVED,
      `Archived teams cannot receive new assignments: ${archived.map((t) => t.team_code).join(', ')}.`,
    );
  }

  const [users] = await conn.query<RowDataPacket[]>(
    'SELECT id, email, full_name, status FROM users WHERE id IN (?) FOR UPDATE',
    [jIds],
  );
  if (users.length !== jIds.length) {
    throw new RuleError(
      404,
      TEAM_ERRORS.ACCOUNT_NOT_FOUND,
      'One of the selected accounts no longer exists.',
    );
  }
  const disabled = users.filter((u) => u.status !== 'active');
  if (disabled.length) {
    throw new RuleError(
      409,
      TEAM_ERRORS.ACCOUNT_DISABLED,
      `Disabled accounts cannot receive new assignments: ${disabled.map((u) => u.full_name).join(', ')}.`,
    );
  }

  const [existing] = await conn.query<RowDataPacket[]>(
    'SELECT team_id, judge_id FROM team_judges WHERE team_id IN (?) AND judge_id IN (?)',
    [tIds, jIds],
  );
  const have = new Set(existing.map((e) => `${e.team_id}:${e.judge_id}`));
  const pairs: [number, number, number][] = [];
  for (const t of tIds)
    for (const j of jIds) if (!have.has(`${t}:${j}`)) pairs.push([t, j, actor.id]);
  if (pairs.length) {
    await conn.query('INSERT INTO team_judges (team_id, judge_id, assigned_by) VALUES ?', [pairs]);
    const codeOf = new Map(teams.map((t) => [Number(t.id), String(t.team_code)]));
    const emailOf = new Map(users.map((u) => [Number(u.id), String(u.email)]));
    for (const [teamId, judgeId] of pairs) {
      await writeAudit(conn, {
        actorId: actor.id,
        actorEmail: actor.email,
        action: 'assignment.added',
        entityType: 'team',
        entityId: teamId,
        ipAddress: actor.ip,
        details: {
          team_code: codeOf.get(teamId),
          judge_id: judgeId,
          judge_email: emailOf.get(judgeId),
        },
      });
    }
  }
  return { added: pairs.length, alreadyAssigned: tIds.length * jIds.length - pairs.length };
}

async function removeAssignmentRow(
  conn: PoolConnection,
  actor: Actor,
  teamId: number,
  judgeId: number,
) {
  const [rows] = await conn.query<RowDataPacket[]>(
    `SELECT t.team_code, u.email, e.status AS evaluation_status
     FROM team_judges tj JOIN teams t ON t.id = tj.team_id JOIN users u ON u.id = tj.judge_id
     LEFT JOIN evaluations e ON e.team_id = tj.team_id AND e.judge_id = tj.judge_id
     WHERE tj.team_id = ? AND tj.judge_id = ? FOR UPDATE`,
    [teamId, judgeId],
  );
  const row = rows[0];
  if (!row)
    throw new RuleError(404, 'ASSIGNMENT_NOT_FOUND', 'This judge is not assigned to this team.');
  // Only the assignment row is removed. Any evaluation stays in the database.
  await conn.query('DELETE FROM team_judges WHERE team_id = ? AND judge_id = ?', [teamId, judgeId]);
  await writeAudit(conn, {
    actorId: actor.id,
    actorEmail: actor.email,
    action: 'assignment.removed',
    entityType: 'team',
    entityId: teamId,
    ipAddress: actor.ip,
    details: {
      team_code: row.team_code,
      judge_id: judgeId,
      judge_email: row.email,
      evaluation_kept: row.evaluation_status ?? null,
    },
  });
}

export function bulkAssign(pool: Pool, actor: Actor, teamIds: number[], judgeIds: number[]) {
  return inTransaction(pool, (conn) => addAssignments(conn, actor, teamIds, judgeIds));
}

export function removeAssignment(pool: Pool, actor: Actor, teamId: number, judgeId: number) {
  return inTransaction(pool, (conn) => removeAssignmentRow(conn, actor, teamId, judgeId));
}

/** Makes a team's judges exactly `judgeIds`: adds the new ones, removes the rest. */
export function setTeamJudges(pool: Pool, actor: Actor, teamId: number, judgeIds: number[]) {
  return inTransaction(pool, async (conn) => {
    const [teams] = await conn.query<RowDataPacket[]>(
      'SELECT id FROM teams WHERE id = ? FOR UPDATE',
      [teamId],
    );
    if (!teams[0]) throw notFound();
    const [current] = await conn.query<RowDataPacket[]>(
      'SELECT judge_id FROM team_judges WHERE team_id = ?',
      [teamId],
    );
    const have = new Set(current.map((c) => Number(c.judge_id)));
    const want = new Set(unique(judgeIds));
    const toAdd = [...want].filter((id) => !have.has(id));
    const toRemove = [...have].filter((id) => !want.has(id));
    const result = await addAssignments(conn, actor, [teamId], toAdd);
    for (const judgeId of toRemove) await removeAssignmentRow(conn, actor, teamId, judgeId);
    return { added: result.added, removed: toRemove.length };
  });
}
