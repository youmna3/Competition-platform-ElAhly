import { competitionStatus, requireCompetitionState } from '../competition/service.js';
import type { Pool, PoolConnection, RowDataPacket, ResultSetHeader } from 'mysql2/promise';
import {
  REOPEN_REASON,
  REVIEW_ERRORS,
  scoreEvaluation,
  type AdminEvaluationDetail,
  type AdminEvaluationJudge,
  type AdminEvaluationsResponse,
  type AdminTeamEvaluations,
  type CompletionFilter,
  type EvaluationEvent,
  type EvaluationListSort,
  type EvaluationProgress,
  type JudgeProgressRow,
  type SubmissionSnapshot,
  type TeamCompletion,
  type EvaluationInput,
} from '@judging/shared';
import { writeAudit } from '../audit.js';
import { RuleError } from '../errors.js';
import { checkInput, snapshotOf, loadEvaluation } from '../evaluations/service.js';
import { loadVersion } from '../rubric/service.js';
import { inTransaction, type Actor } from '../teams/service.js';

type Db = Pool | PoolConnection;
const iso = (d: Date | null | undefined) => (d ? new Date(d).toISOString() : null);
const round3 = (n: number) => Math.round(n * 1000) / 1000;
const notFound = () =>
  new RuleError(404, REVIEW_ERRORS.EVALUATION_NOT_FOUND, 'This evaluation does not exist.');

// ---------------------------------------------------------------------------
// The team-by-team list
// ---------------------------------------------------------------------------

export interface EvaluationListQuery {
  search?: string;
  teamStatus: 'active' | 'archived' | 'all';
  teamId?: number;
  judgeId?: number;
  status?: EvaluationProgress;
  version?: number;
  completion?: CompletionFilter;
  sort: EvaluationListSort;
  dir: 'asc' | 'desc';
  page: number;
  pageSize: number;
}

function summarise(team: RowDataPacket, judges: AdminEvaluationJudge[]): AdminTeamEvaluations {
  const submitted = judges.filter((j) => j.status === 'submitted');
  const versions = [
    ...new Set(judges.map((j) => j.rubricVersionNo).filter((v): v is number => v != null)),
  ].sort((a, b) => a - b);
  const submittedVersions = new Set(submitted.map((j) => j.rubricVersionNo));
  const completion: TeamCompletion =
    judges.length === 0
      ? 'no_judges'
      : submitted.length === judges.length
        ? 'complete'
        : judges.every((j) => j.status === 'not_started')
          ? 'not_started'
          : 'in_progress';
  const times = submitted
    .map((j) => (j.submittedAt ? Date.parse(j.submittedAt) : 0))
    .filter(Boolean);
  return {
    teamId: Number(team.id),
    teamCode: String(team.team_code),
    name: String(team.name),
    projectName: String(team.project_name),
    teamStatus: team.status,
    judges,
    assignedJudges: judges.length,
    submitted: submitted.length,
    pending: judges.length - submitted.length,
    completion,
    provisionalAverage: submitted.length
      ? (submitted.some((j) => j.scoringFormat === 3) ? (n: number) => n : round3)(
          submitted.reduce((sum, j) => sum + (j.totalScore ?? 0), 0) / submitted.length,
        )
      : null,
    versions,
    mixedVersions: versions.length > 1,
    readyForResults: completion === 'complete' && submittedVersions.size === 1,
    lastSubmittedAt: times.length ? new Date(Math.max(...times)).toISOString() : null,
  };
}

const COMPLETION_TEST: Record<CompletionFilter, (t: AdminTeamEvaluations) => boolean> = {
  complete: (t) => t.completion === 'complete',
  incomplete: (t) => t.assignedJudges > 0 && t.pending > 0,
  not_started: (t) => t.completion === 'not_started',
  no_judges: (t) => t.completion === 'no_judges',
  mixed_versions: (t) => t.mixedVersions,
  ready: (t) => t.readyForResults,
};

export async function listTeamEvaluations(
  db: Db,
  q: EvaluationListQuery,
): Promise<AdminEvaluationsResponse> {
  const [teams] = await db.query<RowDataPacket[]>(
    `SELECT id, team_code, name, project_name, status FROM teams
     ${q.teamStatus === 'all' ? '' : 'WHERE status = ?'} ORDER BY team_code`,
    q.teamStatus === 'all' ? [] : [q.teamStatus],
  );
  const [rows] = await db.query<RowDataPacket[]>(
    `SELECT tj.team_id, u.id, u.full_name, u.email, u.role, u.status AS account_status,
            e.id AS evaluation_id, e.status, e.required_scored, e.total_score, e.submitted_at, e.updated_at,
            e.reopened_count, v.version_no, v.scoring_format
     FROM team_judges tj
     JOIN users u ON u.id = tj.judge_id
     LEFT JOIN evaluations e ON e.team_id = tj.team_id AND e.judge_id = tj.judge_id
     LEFT JOIN rubric_versions v ON v.id = e.rubric_version_id
     ORDER BY u.full_name, u.id`,
  );
  const byTeam = new Map<number, AdminEvaluationJudge[]>();
  for (const r of rows) {
    const list = byTeam.get(Number(r.team_id)) ?? [];
    list.push({
      ...(Number(r.scoring_format) === 3 ? { scoringFormat: 3 } : {}),
      judgeId: Number(r.id),
      fullName: String(r.full_name),
      email: String(r.email),
      role: r.role,
      accountStatus: r.account_status,
      evaluationId: r.evaluation_id == null ? null : Number(r.evaluation_id),
      status: (r.status ?? 'not_started') as EvaluationProgress,
      ratedCount: Number(r.required_scored ?? 0),
      totalScore: r.status === 'submitted' ? Number(r.total_score) : null,
      rubricVersionNo: r.version_no == null ? null : Number(r.version_no),
      submittedAt: iso(r.submitted_at),
      updatedAt: iso(r.updated_at),
      reopenedCount: Number(r.reopened_count ?? 0),
    });
    byTeam.set(Number(r.team_id), list);
  }

  const search = q.search?.trim().toLowerCase();
  let list = teams.map((t) => summarise(t, byTeam.get(Number(t.id)) ?? []));
  list = list.filter((t) => {
    if (q.teamId && t.teamId !== q.teamId) return false;
    if (q.judgeId && !t.judges.some((j) => j.judgeId === q.judgeId)) return false;
    if (
      q.status &&
      !t.judges.some((j) => j.status === q.status && (!q.judgeId || j.judgeId === q.judgeId))
    ) {
      return false;
    }
    if (q.version != null && !t.versions.includes(q.version)) return false;
    if (q.completion && !COMPLETION_TEST[q.completion](t)) return false;
    if (search) {
      const haystack = [
        t.teamCode,
        t.name,
        t.projectName,
        ...t.judges.flatMap((j) => [j.fullName, j.email]),
      ]
        .join('\n')
        .toLowerCase();
      if (!haystack.includes(search)) return false;
    }
    return true;
  });

  const value = (t: AdminTeamEvaluations): string | number => {
    switch (q.sort) {
      case 'name':
        return t.name.toLowerCase();
      case 'submitted':
        return t.submitted;
      case 'pending':
        return t.pending;
      case 'average':
        return t.provisionalAverage ?? -1;
      case 'lastSubmitted':
        return t.lastSubmittedAt ?? '';
      default:
        return t.teamCode.toLowerCase();
    }
  };
  const sign = q.dir === 'desc' ? -1 : 1;
  list.sort((a, b) => {
    const x = value(a);
    const y = value(b);
    if (x < y) return -sign;
    if (x > y) return sign;
    return a.teamCode.localeCompare(b.teamCode);
  });

  const [versions] = await db.query<RowDataPacket[]>(
    `SELECT DISTINCT v.version_no FROM evaluations e JOIN rubric_versions v ON v.id = e.rubric_version_id
     ORDER BY v.version_no`,
  );
  const [judges] = await db.query<RowDataPacket[]>(
    `SELECT id, full_name, role FROM users u
     WHERE role = 'judge' OR EXISTS (SELECT 1 FROM team_judges tj WHERE tj.judge_id = u.id)
     ORDER BY full_name`,
  );
  const start = (q.page - 1) * q.pageSize;
  return {
    teams: list.slice(start, start + q.pageSize),
    total: list.length,
    page: q.page,
    pageSize: q.pageSize,
    versionsInUse: versions.map((v) => Number(v.version_no)),
    judges: judges.map((j) => ({ id: Number(j.id), fullName: String(j.full_name), role: j.role })),
  };
}

// ---------------------------------------------------------------------------
// One evaluation, read-only, and its history
// ---------------------------------------------------------------------------

export async function getAdminEvaluation(db: Db, id: number): Promise<AdminEvaluationDetail> {
  const [rows] = await db.query<RowDataPacket[]>(
    `SELECT e.id, e.team_id, e.judge_id, e.save_count, e.last_saved_at, e.reopened_at, e.reopen_reason,
            e.reopened_count, rb.email AS reopened_by_email,
            t.team_code, t.name AS team_name, t.project_name, t.status AS team_status,
            u.full_name, u.email, u.role, u.status AS account_status,
            EXISTS (SELECT 1 FROM team_judges tj WHERE tj.team_id = e.team_id AND tj.judge_id = e.judge_id) AS assigned,
            (SELECT v.version_no FROM rubric r JOIN rubric_versions v ON v.id = r.published_version_id WHERE r.id = 1) AS published_no
     FROM evaluations e
     JOIN teams t ON t.id = e.team_id
     JOIN users u ON u.id = e.judge_id
     LEFT JOIN users rb ON rb.id = e.reopened_by
     WHERE e.id = ?`,
    [id],
  );
  const row = rows[0];
  if (!row) throw notFound();
  const evaluation = (await loadEvaluation(db, id))!;
  const rubric = (await loadVersion(db, evaluation.rubricVersionId))!;
  const byId = new Map(evaluation.ratings.map((r) => [r.criterionId, r.rating]));
  const breakdown = scoreEvaluation(
    rubric.sections,
    rubric.sections.map((s) => s.criteria.map((c) => byId.get(c.id) ?? null)),
  );
  const assigned = Boolean(Number(row.assigned));

  let reopenBlockedReason: string | null = null;
  if (evaluation.status !== 'submitted') {
    reopenBlockedReason = 'Only a submitted evaluation can be reopened.';
  } else if (!assigned) {
    reopenBlockedReason =
      'The judge is no longer assigned to this team. Assign them again before reopening, so they can edit it.';
  } else if (row.account_status !== 'active') {
    reopenBlockedReason =
      'The judge’s account is disabled, so they could not edit it. Reactivate it first.';
  } else if (row.team_status !== 'active') {
    reopenBlockedReason =
      'The team is archived, so it can no longer be evaluated. Reactivate it first.';
  }

  const lifecycle = await competitionStatus(db);
  if (lifecycle.state !== 'judging_open')
    reopenBlockedReason = 'Judging must be open to correct or reopen evaluations.';
  return {
    canCorrect: lifecycle.state === 'judging_open' && evaluation.status === 'submitted',
    team: {
      id: Number(row.team_id),
      teamCode: String(row.team_code),
      name: String(row.team_name),
      projectName: String(row.project_name),
      status: row.team_status,
    },
    judge: {
      id: Number(row.judge_id),
      fullName: String(row.full_name),
      email: String(row.email),
      role: row.role,
      accountStatus: row.account_status,
    },
    judgeAssigned: assigned,
    rubric,
    publishedVersionNo: row.published_no == null ? null : Number(row.published_no),
    evaluation,
    sectionScores: breakdown.sections.map((s) => s.score),
    lastSavedAt: iso(row.last_saved_at),
    saveCount: Number(row.save_count ?? 0),
    reopen: row.reopened_at
      ? {
          at: iso(row.reopened_at)!,
          byEmail: row.reopened_by_email ?? null,
          reason: String(row.reopen_reason ?? ''),
          count: Number(row.reopened_count ?? 0),
        }
      : null,
    canReopen: reopenBlockedReason == null,
    lastAdminCorrection:
      (await getEvaluationHistory(db, id))
        .filter((e) => e.event === 'admin_corrected')
        .map((e) => ({ at: e.createdAt, byEmail: e.actorEmail }))
        .at(-1) ?? null,
    reopenBlockedReason,
  };
}

export async function getEvaluationHistory(db: Db, id: number): Promise<EvaluationEvent[]> {
  const [exists] = await db.query<RowDataPacket[]>('SELECT id FROM evaluations WHERE id = ?', [id]);
  if (!exists.length) throw notFound();
  const [rows] = await db.query<RowDataPacket[]>(
    `SELECT ev.*, v.version_no, u.full_name FROM evaluation_events ev
     JOIN rubric_versions v ON v.id = ev.rubric_version_id
     LEFT JOIN users u ON u.id = ev.actor_id
     WHERE ev.evaluation_id = ? ORDER BY ev.id`,
    [id],
  );
  return rows.map((r) => ({
    id: Number(r.id),
    event: r.event,
    actorEmail: r.actor_email ?? null,
    actorName: r.full_name ?? null,
    createdAt: iso(r.created_at)!,
    rubricVersionNo: Number(r.version_no),
    ratedCount: Number(r.rated_count),
    totalScore: r.total_score == null ? null : Number(r.total_score),
    previousScore: r.previous_score == null ? null : Number(r.previous_score),
    reason: r.reason ?? null,
    snapshot: r.snapshot ? (JSON.parse(String(r.snapshot)) as SubmissionSnapshot) : null,
    previousSnapshot: r.previous_snapshot
      ? (JSON.parse(String(r.previous_snapshot)) as SubmissionSnapshot)
      : null,
  }));
}

// ---------------------------------------------------------------------------
// Reopening
// ---------------------------------------------------------------------------

/**
 * Reopens a submitted evaluation for its own judge, in one transaction: the
 * status goes back to draft, the submitted snapshot stays in the history, and
 * the reason, administrator and time are recorded. Other evaluations are untouched.
 */
export function correctSubmission(
  pool: Pool,
  actor: Actor,
  id: number,
  rowVersion: number,
  input: EvaluationInput,
  reason: string,
) {
  return inTransaction(pool, async (conn) => {
    await requireCompetitionState(conn, 'judging_open');
    const [admins] = await conn.query<RowDataPacket[]>(
      'SELECT role, status FROM users WHERE id = ? FOR UPDATE',
      [actor.id],
    );
    if (admins[0]?.role !== 'admin' || admins[0]?.status !== 'active')
      throw new RuleError(403, 'FORBIDDEN', 'Only active administrators can correct submissions.');
    await conn.query('SELECT id FROM evaluations WHERE id = ? FOR UPDATE', [id]);
    const before = await loadEvaluation(conn, id);
    if (!before) throw notFound();
    if (before.status !== 'submitted')
      throw new RuleError(409, 'NOT_SUBMITTED', 'Only submitted evaluations can be corrected.');
    if (before.rowVersion !== rowVersion)
      throw new RuleError(
        409,
        'EVALUATION_CONFLICT',
        'This evaluation changed. Close the editor and refresh before trying again.',
      );
    if (reason.trim().length < REOPEN_REASON.min || reason.trim().length > REOPEN_REASON.max)
      throw new RuleError(
        400,
        'INVALID_REASON',
        'An editing reason of 5 to 500 characters is required.',
      );
    const rubric = (await loadVersion(conn, before.rubricVersionId))!;
    checkInput(rubric, input);
    if (
      input.ratings.length !== rubric.sections.reduce((n, s) => n + s.criteria.length, 0) ||
      input.sectionNotes.length !== rubric.sections.length
    )
      throw new RuleError(
        400,
        'EVALUATION_INVALID',
        'Send every criterion and section note from the original rubric.',
      );
    const ratings = new Map(input.ratings.map((r) => [r.criterionId, r.rating]));
    const breakdown = scoreEvaluation(
      rubric.sections,
      rubric.sections.map((s) => s.criteria.map((c) => ratings.get(c.id) ?? null)),
    );
    const total = breakdown.total;
    if (total == null)
      throw new RuleError(
        400,
        'EVALUATION_INVALID',
        'Rate all Actual criteria and complete any started Bonus section.',
      );
    const previous = snapshotOf(rubric, before, before.totalScore!);
    const after = snapshotOf(rubric, { ...before, ...input }, total);
    const [event] = await conn.query<ResultSetHeader>(
      `INSERT INTO evaluation_events (evaluation_id,event,actor_id,actor_email,rubric_version_id,row_version,rated_count,total_score,previous_score,reason,snapshot,previous_snapshot) VALUES (?, 'admin_corrected', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        id,
        actor.id,
        actor.email,
        before.rubricVersionId,
        rowVersion + 1,
        input.ratings.filter((r) => r.rating != null).length,
        total,
        before.totalScore,
        reason.trim(),
        JSON.stringify(after),
        JSON.stringify(previous),
      ],
    );
    try {
      await conn.query('SET @admin_correction_event = ?', [event.insertId]);
      for (const r of input.ratings)
        await conn.query(
          'UPDATE evaluation_scores SET score = ?, note = ? WHERE evaluation_id = ? AND criterion_id = ?',
          [r.rating, r.note, id, r.criterionId],
        );
      for (const n of input.sectionNotes)
        await conn.query(
          `INSERT INTO evaluation_section_notes (evaluation_id,rubric_version_id,section_id,note) VALUES (?,?,?,?) ON DUPLICATE KEY UPDATE note=VALUES(note)`,
          [id, before.rubricVersionId, n.sectionId, n.note],
        );
      await conn.query(
        `UPDATE evaluations SET core_score=?,bonus_score=?,total_score=?,overall_notes=?,row_version=row_version+1,last_saved_at=NOW(),save_count=save_count+1 WHERE id=?`,
        [breakdown.base, breakdown.bonus, total, input.overallNotes, id],
      );
      await writeAudit(conn, {
        actorId: actor.id,
        actorEmail: actor.email,
        action: 'evaluation.admin_corrected',
        entityType: 'evaluation',
        entityId: id,
        ipAddress: actor.ip,
        details: {
          reason: reason.trim(),
          previousScore: before.totalScore,
          totalScore: total,
          eventId: event.insertId,
          teamId: before.teamId,
          judgeId: before.judgeId,
          rubricVersionId: before.rubricVersionId,
        },
      });
      return await getAdminEvaluation(conn, id);
    } finally {
      await conn.query('SET @admin_correction_event = NULL');
    }
  });
}

export function reopenEvaluation(pool: Pool, actor: Actor, id: number, rawReason: string) {
  const reason = rawReason.trim();
  if (reason.length < REOPEN_REASON.min || reason.length > REOPEN_REASON.max) {
    throw new RuleError(
      400,
      REVIEW_ERRORS.INVALID_REASON,
      `Give a reason of ${REOPEN_REASON.min} to ${REOPEN_REASON.max} characters.`,
    );
  }
  return inTransaction(pool, async (conn) => {
    await requireCompetitionState(conn, 'judging_open');
    const [rows] = await conn.query<RowDataPacket[]>(
      `SELECT e.id, e.team_id, e.judge_id, e.status, e.total_score, e.required_scored, e.rubric_version_id, e.row_version,
              t.team_code, t.status AS team_status, u.email, u.status AS account_status,
              EXISTS (SELECT 1 FROM team_judges tj WHERE tj.team_id = e.team_id AND tj.judge_id = e.judge_id) AS assigned
       FROM evaluations e JOIN teams t ON t.id = e.team_id JOIN users u ON u.id = e.judge_id
       WHERE e.id = ? FOR UPDATE`,
      [id],
    );
    const row = rows[0];
    if (!row) throw notFound();
    if (row.status !== 'submitted') {
      throw new RuleError(
        409,
        REVIEW_ERRORS.NOT_SUBMITTED,
        'This evaluation is not submitted, so there is nothing to reopen. It may have just been reopened.',
      );
    }
    if (!Number(row.assigned)) {
      throw new RuleError(
        409,
        REVIEW_ERRORS.JUDGE_NOT_ASSIGNED,
        'The judge is no longer assigned to this team. Assign them again before reopening.',
      );
    }
    if (row.account_status !== 'active') {
      throw new RuleError(
        409,
        REVIEW_ERRORS.ACCOUNT_DISABLED,
        'The judge’s account is disabled. Reactivate it first.',
      );
    }
    if (row.team_status !== 'active') {
      throw new RuleError(
        409,
        REVIEW_ERRORS.TEAM_ARCHIVED,
        'The team is archived. Reactivate it first.',
      );
    }
    await conn.query(
      `UPDATE evaluations SET status = 'draft', submitted_at = NULL, reopened_count = reopened_count + 1,
         reopened_at = NOW(), reopened_by = ?, reopen_reason = ?, reopen_notice_pending = TRUE,
         row_version = row_version + 1
       WHERE id = ? AND status = 'submitted'`,
      [actor.id, reason, id],
    );
    const [v] = await conn.query<RowDataPacket[]>(
      'SELECT version_no FROM rubric_versions WHERE id = ?',
      [row.rubric_version_id],
    );
    await conn.query(
      `INSERT INTO evaluation_events (evaluation_id, event, actor_id, actor_email, rubric_version_id, row_version,
         rated_count, previous_score, reason)
       VALUES (?, 'reopened', ?, ?, ?, ?, ?, ?, ?)`,
      [
        id,
        actor.id,
        actor.email,
        row.rubric_version_id,
        Number(row.row_version) + 1,
        Number(row.required_scored),
        row.total_score,
        reason,
      ],
    );
    await writeAudit(conn, {
      actorId: actor.id,
      actorEmail: actor.email,
      action: 'evaluation.reopened',
      entityType: 'evaluation',
      entityId: id,
      ipAddress: actor.ip,
      details: {
        team_id: Number(row.team_id),
        team_code: row.team_code,
        judge_id: Number(row.judge_id),
        judge_email: row.email,
        reason,
        previous_score: Number(row.total_score),
        rubric_version_no: Number(v[0]?.version_no),
        own_evaluation: Number(row.judge_id) === actor.id,
      },
    });
    return getAdminEvaluation(conn, id);
  });
}

// ---------------------------------------------------------------------------
// Judge progress
// ---------------------------------------------------------------------------

export type ProgressFilter = 'complete' | 'incomplete' | 'not_started' | 'no_teams';

export async function judgeProgress(
  db: Db,
  q: { search?: string; completion?: ProgressFilter; judgeId?: number },
): Promise<JudgeProgressRow[]> {
  const [rows] = await db.query<RowDataPacket[]>(
    `SELECT u.id, u.full_name, u.email, u.role, u.status,
       (SELECT COUNT(*) FROM team_judges tj JOIN teams t ON t.id = tj.team_id AND t.status = 'active'
          WHERE tj.judge_id = u.id) AS assigned,
       (SELECT COUNT(*) FROM team_judges tj JOIN teams t ON t.id = tj.team_id AND t.status = 'active'
          JOIN evaluations e ON e.team_id = tj.team_id AND e.judge_id = tj.judge_id
          WHERE tj.judge_id = u.id AND e.status = 'draft') AS drafts,
       (SELECT COUNT(*) FROM team_judges tj JOIN teams t ON t.id = tj.team_id AND t.status = 'active'
          JOIN evaluations e ON e.team_id = tj.team_id AND e.judge_id = tj.judge_id
          WHERE tj.judge_id = u.id AND e.status = 'submitted') AS submitted,
       (SELECT COUNT(*) FROM evaluations e JOIN teams t ON t.id = e.team_id
          WHERE e.judge_id = u.id AND (t.status <> 'active'
            OR NOT EXISTS (SELECT 1 FROM team_judges tj WHERE tj.team_id = e.team_id AND tj.judge_id = e.judge_id))
       ) AS other_evaluations,
       (SELECT MAX(e.submitted_at) FROM evaluations e WHERE e.judge_id = u.id) AS last_submitted
     FROM users u
     WHERE u.role = 'judge'
        OR EXISTS (SELECT 1 FROM team_judges tj WHERE tj.judge_id = u.id)
        OR EXISTS (SELECT 1 FROM evaluations e WHERE e.judge_id = u.id)
     ORDER BY u.full_name, u.id`,
  );
  const search = q.search?.trim().toLowerCase();
  return rows
    .map((r) => {
      const assigned = Number(r.assigned);
      const submitted = Number(r.submitted);
      const draft = Number(r.drafts);
      return {
        judgeId: Number(r.id),
        fullName: String(r.full_name),
        email: String(r.email),
        role: r.role,
        accountStatus: r.status,
        assignedTeams: assigned,
        notStarted: assigned - submitted - draft,
        draft,
        submitted,
        completionPercent: assigned ? Math.round((submitted / assigned) * 1000) / 10 : null,
        lastSubmittedAt: iso(r.last_submitted),
        otherEvaluations: Number(r.other_evaluations),
      } satisfies JudgeProgressRow;
    })
    .filter((j) => {
      if (q.judgeId && j.judgeId !== q.judgeId) return false;
      if (search && !`${j.fullName}\n${j.email}`.toLowerCase().includes(search)) return false;
      switch (q.completion) {
        case 'complete':
          return j.assignedTeams > 0 && j.submitted === j.assignedTeams;
        case 'incomplete':
          return j.submitted < j.assignedTeams;
        case 'not_started':
          return j.assignedTeams > 0 && j.submitted === 0 && j.draft === 0;
        case 'no_teams':
          return j.assignedTeams === 0;
        default:
          return true;
      }
    });
}
