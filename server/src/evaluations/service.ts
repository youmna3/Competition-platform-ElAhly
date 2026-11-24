import { teamResources } from '../teams/resources.js';
import { competitionStatus, requireCompetitionState } from '../competition/service.js';
import type { Pool, PoolConnection, ResultSetHeader, RowDataPacket } from 'mysql2/promise';
import {
  EVALUATION_ERRORS,
  EVALUATION_LIMITS,
  maximumScore,
  isPointsRubric,
  isValidRating,
  scoreEvaluation,
  type EvaluationDetail,
  type EvaluationInput,
  type EvaluationStatus,
  type JudgeEvaluationResponse,
  type RubricVersion,
  type SubmissionSnapshot,
  type SubmitEvaluationResponse,
  type TeamStatus,
} from '@judging/shared';
import { writeAudit } from '../audit.js';
import { RuleError } from '../errors.js';
import { loadVersion } from '../rubric/service.js';
import { inTransaction, type Actor } from '../teams/service.js';

type Db = Pool | PoolConnection;

const iso = (d: Date | null | undefined) => (d ? new Date(d).toISOString() : null);
const requiredCount = (r: RubricVersion) =>
  r.sections.filter((s) => s.type !== 'bonus').reduce((n, s) => n + s.criteria.length, 0);
export const missingRequiredRatings = (
  rubric: RubricVersion,
  ratings: Map<number, number | null>,
) =>
  rubric.sections.flatMap((s) => {
    const values = s.criteria.map((c) => ratings.get(c.id) ?? null);
    return s.type === 'bonus' && values.every((v) => v == null)
      ? []
      : s.criteria.filter((c) => ratings.get(c.id) == null).map((c) => c.id);
  });

const notFound = () =>
  new RuleError(404, EVALUATION_ERRORS.NOT_ASSIGNED, 'This team is not assigned to you.');
const archived = () =>
  new RuleError(
    409,
    EVALUATION_ERRORS.TEAM_ARCHIVED,
    'This team has been archived, so it can no longer be evaluated.',
  );
const locked = () =>
  new RuleError(
    409,
    EVALUATION_ERRORS.EVALUATION_LOCKED,
    'This evaluation has been submitted and is locked. Only an administrator can reopen it.',
  );

// ---------------------------------------------------------------------------
// Reading
// ---------------------------------------------------------------------------

interface TeamRow {
  id: number;
  team_code: string;
  name: string;
  project_name: string;
  status: TeamStatus;
}

async function teamFor(db: Db, judgeId: number, teamId: number, lock = false) {
  const [rows] = await db.query<RowDataPacket[]>(
    `SELECT t.*,
            EXISTS (SELECT 1 FROM team_judges tj WHERE tj.team_id = t.id AND tj.judge_id = ?) AS assigned
     FROM teams t WHERE t.id = ?${lock ? ' FOR UPDATE' : ''}`,
    [judgeId, teamId],
  );
  const row = rows[0];
  // Unassigned and missing teams look the same, so judges can't probe other teams.
  if (!row || !Number(row.assigned)) throw notFound();
  return row as unknown as TeamRow;
}

async function publishedVersionId(db: Db): Promise<number | null> {
  const [rows] = await db.query<RowDataPacket[]>(
    'SELECT published_version_id FROM rubric WHERE id = 1',
  );
  return rows[0]?.published_version_id == null ? null : Number(rows[0].published_version_id);
}

export async function loadEvaluation(db: Db, id: number): Promise<EvaluationDetail | null> {
  const [rows] = await db.query<RowDataPacket[]>(
    `SELECT e.*, v.version_no, (SELECT MAX(ev.created_at) FROM evaluation_events ev WHERE ev.evaluation_id=e.id AND ev.event='admin_corrected') AS admin_modified_at FROM evaluations e
     JOIN rubric_versions v ON v.id = e.rubric_version_id WHERE e.id = ?`,
    [id],
  );
  const e = rows[0];
  if (!e) return null;
  const [scores] = await db.query<RowDataPacket[]>(
    `SELECT c.id AS criterion_id, es.score, es.note
     FROM rubric_criteria c
     JOIN rubric_sections s ON s.id = c.section_id
     LEFT JOIN evaluation_scores es ON es.criterion_id = c.id AND es.evaluation_id = ?
     WHERE c.rubric_version_id = ?
     ORDER BY s.position, c.position`,
    [id, e.rubric_version_id],
  );
  const [notes] = await db.query<RowDataPacket[]>(
    `SELECT s.id AS section_id, n.note
     FROM rubric_sections s
     LEFT JOIN evaluation_section_notes n ON n.section_id = s.id AND n.evaluation_id = ?
     WHERE s.rubric_version_id = ?
     ORDER BY s.position`,
    [id, e.rubric_version_id],
  );
  return {
    id: Number(e.id),
    adminModifiedAt: iso(e.admin_modified_at),
    teamId: Number(e.team_id),
    judgeId: Number(e.judge_id),
    rubricVersionId: Number(e.rubric_version_id),
    rubricVersionNo: Number(e.version_no),
    status: e.status as EvaluationStatus,
    rowVersion: Number(e.row_version),
    totalScore: Number(e.total_score),
    baseScore: Number(e.core_score),
    bonusScore: Number(e.bonus_score),
    maximumScore: maximumScore((await loadVersion(db, Number(e.rubric_version_id)))!.sections),
    ratedCount: Number(e.required_scored),
    requiredCount: Number(e.required_count),
    submittedAt: iso(e.submitted_at),
    createdAt: iso(e.created_at)!,
    updatedAt: iso(e.updated_at)!,
    reopenedCount: Number(e.reopened_count ?? 0),
    reopenedAt: iso(e.reopened_at),
    reopenReason: e.reopen_reason == null ? null : String(e.reopen_reason),
    reopenNoticePending: Boolean(e.reopen_notice_pending),
    overallNotes: String(e.overall_notes ?? ''),
    ratings: scores.map((s) => ({
      criterionId: Number(s.criterion_id),
      rating: s.score == null ? null : Number(s.score),
      note: String(s.note ?? ''),
    })),
    sectionNotes: notes.map((n) => ({
      sectionId: Number(n.section_id),
      note: String(n.note ?? ''),
    })),
  };
}

async function evaluationIdFor(db: Db, teamId: number, judgeId: number) {
  const [rows] = await db.query<RowDataPacket[]>(
    'SELECT id FROM evaluations WHERE team_id = ? AND judge_id = ?',
    [teamId, judgeId],
  );
  return rows[0] ? Number(rows[0].id) : null;
}

/** What a judge (or an assigned administrator) sees for one of their teams. */
export async function getJudgeEvaluation(
  db: Db,
  judgeId: number,
  teamId: number,
): Promise<JudgeEvaluationResponse> {
  const team = await teamFor(db, judgeId, teamId);
  const publishedId = await publishedVersionId(db);
  const published = publishedId == null ? null : await loadVersion(db, publishedId);
  const evaluationId = await evaluationIdFor(db, teamId, judgeId);
  const evaluation = evaluationId == null ? null : await loadEvaluation(db, evaluationId);
  const rubric = evaluation ? await loadVersion(db, evaluation.rubricVersionId) : published;

  const lifecycle = await competitionStatus(db);
  let readOnlyReason: string | null =
    lifecycle.state === 'judging_open'
      ? null
      : lifecycle.state === 'closed'
        ? 'The competition is Closed. Final results are read-only.'
        : 'Judging has not opened. Please wait for the administrator to start the competition.';
  if (!readOnlyReason && evaluation?.status === 'submitted') {
    readOnlyReason = 'Submitted and locked. Only an administrator can reopen it.';
  } else if (team.status !== 'active') {
    readOnlyReason = 'This team has been archived, so it can no longer be evaluated.';
  } else if (!evaluation && !published) {
    readOnlyReason = 'The rubric hasn’t been published yet, so judging hasn’t started.';
  }
  return {
    team: {
      ...teamResources(team as unknown as Record<string, unknown>),
      id: Number(team.id),
      teamCode: String(team.team_code),
      name: String(team.name),
      projectName: String(team.project_name),
      status: team.status,
    },
    rubric,
    publishedVersionNo: published?.versionNo ?? null,
    evaluation,
    canEdit: readOnlyReason == null,
    readOnlyReason,
  };
}

// ---------------------------------------------------------------------------
// Scoring (never trusts the browser)
// ---------------------------------------------------------------------------

function computeScores(rubric: RubricVersion, ratingOf: Map<number, number | null>) {
  const matrix = rubric.sections.map((s) => s.criteria.map((c) => ratingOf.get(c.id) ?? null));
  const breakdown = scoreEvaluation(rubric.sections, matrix);
  const partial = breakdown.sections.reduce((sum, s) => sum + (s.score ?? 0), 0);
  const ratedCount = rubric.sections.reduce(
    (n, s, i) => n + (s.type === 'bonus' ? 0 : matrix[i]!.filter((r) => r != null).length),
    0,
  );
  const base = breakdown.sections.reduce(
    (n, s, i) => n + (rubric.sections[i]!.type !== 'bonus' ? (s.score ?? 0) : 0),
    0,
  );
  const bonus = breakdown.sections.reduce(
    (n, s, i) => n + (rubric.sections[i]!.type === 'bonus' ? (s.score ?? 0) : 0),
    0,
  );
  // Points drafts show the running sum of every point entered so far.
  const enteredPoints = isPointsRubric(rubric)
    ? matrix.reduce((sum, row) => sum + row.reduce<number>((n, v) => n + (v ?? 0), 0), 0)
    : null;
  return {
    total:
      breakdown.total ??
      enteredPoints ??
      (rubric.scoringFormat === 3 ? partial : Math.round(partial * 1000) / 1000),
    base,
    bonus,
    complete: breakdown.total != null,
    ratedCount,
  };
}

/** Draft revisions are recorded at most this often, so autosave can't flood the history. */
const DRAFT_EVENT_INTERVAL_MINUTES = 10;

interface EventInput {
  evaluationId: number;
  event: 'started' | 'draft_saved' | 'submitted' | 'resubmitted';
  actor: Actor;
  rubricVersionId: number;
  rowVersion: number;
  ratedCount?: number;
  totalScore?: number | null;
  previousScore?: number | null;
  snapshot?: SubmissionSnapshot | null;
}

export async function recordEvent(conn: PoolConnection, e: EventInput) {
  await conn.query(
    `INSERT INTO evaluation_events (evaluation_id, event, actor_id, actor_email, rubric_version_id, row_version,
       rated_count, total_score, previous_score, snapshot)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      e.evaluationId,
      e.event,
      e.actor.id,
      e.actor.email,
      e.rubricVersionId,
      e.rowVersion,
      e.ratedCount ?? 0,
      e.totalScore ?? null,
      e.previousScore ?? null,
      e.snapshot ? JSON.stringify(e.snapshot) : null,
    ],
  );
}

/** The immutable record of what was submitted: every rating and note, with the scores. */
export function snapshotOf(
  rubric: RubricVersion,
  evaluation: EvaluationDetail,
  total: number,
): SubmissionSnapshot {
  const byId = new Map(evaluation.ratings.map((r) => [r.criterionId, r]));
  const notes = new Map(evaluation.sectionNotes.map((n) => [n.sectionId, n.note]));
  const matrix = rubric.sections.map((s) => s.criteria.map((c) => byId.get(c.id)?.rating ?? null));
  const breakdown = scoreEvaluation(rubric.sections, matrix);
  return {
    totalScore: total,
    baseScore: breakdown.base ?? 0,
    bonusScore: breakdown.bonus ?? 0,
    maximumScore: breakdown.maximum,
    sections: rubric.sections.map((s, i) => ({
      sectionId: s.id,
      type: s.type ?? 'actual',
      maxBonusPoints: s.maxBonusPoints ?? null,
      title: s.title,
      weightPercent: s.weightPercent ?? 0,
      score: breakdown.sections[i]?.score ?? 0,
      note: notes.get(s.id) ?? '',
    })),
    ratings: rubric.sections.flatMap((s) =>
      s.criteria.map((c) => ({
        criterionId: c.id,
        sectionId: s.id,
        title: c.title,
        rating: byId.get(c.id)?.rating ?? null,
        ...(c.maxPoints != null ? { maxPoints: c.maxPoints } : {}),
        note: byId.get(c.id)?.note ?? '',
      })),
    ),
    overallNotes: evaluation.overallNotes,
  };
}

const invalidInput = (message: string) =>
  new RuleError(400, EVALUATION_ERRORS.EVALUATION_INVALID, message);

/** Checks a save against the evaluation's own rubric version. */
export function checkInput(rubric: RubricVersion, input: EvaluationInput) {
  const criteria = new Map(
    rubric.sections.flatMap((s, i) =>
      s.criteria.map(
        (c, j) => [c.id, `${s.title} – ${c.title || `criterion ${i + 1}.${j + 1}`}`] as const,
      ),
    ),
  );
  const maxPointsOf = new Map(
    rubric.sections.flatMap((s) =>
      s.criteria.map((c) => [c.id, c.maxPoints ?? undefined] as const),
    ),
  );
  const sections = new Set(rubric.sections.map((s) => s.id));
  const seen = new Set<number>();
  for (const r of input.ratings) {
    if (!criteria.has(r.criterionId))
      throw invalidInput('A rating refers to a criterion that is not in this rubric.');
    if (seen.has(r.criterionId)) throw invalidInput('A criterion was rated twice.');
    seen.add(r.criterionId);
    const max = maxPointsOf.get(r.criterionId);
    if (r.rating !== null && !isValidRating({ maxPoints: max }, r.rating)) {
      throw invalidInput(
        max != null
          ? `${criteria.get(r.criterionId)}: points must be a whole number from 0 to ${max}.`
          : `${criteria.get(r.criterionId)}: ratings must be whole stars from 1 to 5.`,
      );
    }
    if (r.note.length > EVALUATION_LIMITS.criterionNote) {
      throw invalidInput(
        `${criteria.get(r.criterionId)}: the note can be at most ${EVALUATION_LIMITS.criterionNote} characters.`,
      );
    }
  }
  const seenSections = new Set<number>();
  for (const n of input.sectionNotes) {
    if (!sections.has(n.sectionId) || seenSections.has(n.sectionId)) {
      throw invalidInput('A section note refers to a section that is not in this rubric.');
    }
    seenSections.add(n.sectionId);
    if (n.note.length > EVALUATION_LIMITS.sectionNote) {
      throw invalidInput(
        `Section notes can be at most ${EVALUATION_LIMITS.sectionNote} characters.`,
      );
    }
  }
  if (input.overallNotes.length > EVALUATION_LIMITS.overallNotes) {
    throw invalidInput(
      `Overall notes can be at most ${EVALUATION_LIMITS.overallNotes} characters.`,
    );
  }
}

// ---------------------------------------------------------------------------
// Writing
// ---------------------------------------------------------------------------

/** Starts (or reopens the existing) evaluation for an assigned team. Safe to repeat. */
export function startEvaluation(pool: Pool, actor: Actor, teamId: number) {
  return inTransaction(pool, async (conn) => {
    await requireCompetitionState(conn, 'judging_open');
    const team = await teamFor(conn, actor.id, teamId, true);
    const existing = await evaluationIdFor(conn, teamId, actor.id);
    if (existing != null) return (await loadEvaluation(conn, existing))!;
    if (team.status !== 'active') throw archived();
    const publishedId = (await competitionStatus(conn)).lockedRubricVersionId;
    if (publishedId == null) {
      throw new RuleError(
        409,
        EVALUATION_ERRORS.NO_RUBRIC,
        'The rubric hasn’t been published yet, so judging hasn’t started.',
      );
    }
    const rubric = (await loadVersion(conn, publishedId))!;
    let insert: ResultSetHeader;
    try {
      [insert] = await conn.query<ResultSetHeader>(
        'INSERT INTO evaluations (team_id, judge_id, rubric_version_id, required_count) VALUES (?, ?, ?, ?)',
        [teamId, actor.id, publishedId, requiredCount(rubric)],
      );
    } catch (e) {
      // Two tabs pressed Start at once: the unique key keeps a single evaluation.
      if ((e as { code?: string }).code === 'ER_DUP_ENTRY') {
        const id = await evaluationIdFor(pool, teamId, actor.id);
        if (id != null) return (await loadEvaluation(pool, id))!;
      }
      throw e;
    }
    const id = insert.insertId;
    await conn.query(
      'INSERT INTO evaluation_scores (evaluation_id, rubric_version_id, criterion_id, score) VALUES ?',
      [rubric.sections.flatMap((s) => s.criteria.map((c) => [id, publishedId, c.id, null]))],
    );
    await conn.query(
      'INSERT INTO evaluation_section_notes (evaluation_id, rubric_version_id, section_id) VALUES ?',
      [rubric.sections.map((s) => [id, publishedId, s.id])],
    );
    await recordEvent(conn, {
      evaluationId: id,
      event: 'started',
      actor,
      rubricVersionId: publishedId,
      rowVersion: 1,
    });
    await writeAudit(conn, {
      actorId: actor.id,
      actorEmail: actor.email,
      action: 'evaluation.started',
      entityType: 'evaluation',
      entityId: id,
      ipAddress: actor.ip,
      details: { team_id: teamId, team_code: team.team_code, rubric_version_no: rubric.versionNo },
    });
    return (await loadEvaluation(conn, id))!;
  });
}

/**
 * Locks the judge's own evaluation and checks they may still change it.
 * Administrators get no exceptions here: the same rules apply to everyone.
 */
async function lockOwn(conn: PoolConnection, actor: Actor, id: number, rowVersion: number | null) {
  const [rows] = await conn.query<RowDataPacket[]>(
    'SELECT id, team_id, judge_id, status, row_version, rubric_version_id FROM evaluations WHERE id = ? FOR UPDATE',
    [id],
  );
  const row = rows[0];
  if (!row || Number(row.judge_id) !== actor.id) {
    throw new RuleError(404, EVALUATION_ERRORS.NOT_ASSIGNED, 'This evaluation is not yours.');
  }
  const team = await teamFor(conn, actor.id, Number(row.team_id));
  return { row, team, staleVersion: rowVersion != null && Number(row.row_version) !== rowVersion };
}

async function conflict(conn: PoolConnection, id: number) {
  return new RuleError(
    409,
    EVALUATION_ERRORS.EVALUATION_CONFLICT,
    'This evaluation was saved from another tab or window after you opened it.',
    { evaluation: await loadEvaluation(conn, id) },
  );
}

/** Saves a draft (autosave or the Save button). Totals are recomputed here. */
export function saveEvaluation(
  pool: Pool,
  actor: Actor,
  id: number,
  rowVersion: number,
  input: EvaluationInput,
) {
  return inTransaction(pool, async (conn) => {
    await requireCompetitionState(conn, 'judging_open');
    const { row, team, staleVersion } = await lockOwn(conn, actor, id, rowVersion);
    if (row.status !== 'draft') throw locked();
    if (team.status !== 'active') throw archived();
    if (staleVersion) throw await conflict(conn, id);

    const versionId = Number(row.rubric_version_id);
    const rubric = (await loadVersion(conn, versionId))!;
    checkInput(rubric, input);

    // Ratings not sent keep their stored value.
    const current = (await loadEvaluation(conn, id))!;
    const ratingOf = new Map(current.ratings.map((r) => [r.criterionId, r.rating]));
    for (const r of input.ratings) ratingOf.set(r.criterionId, r.rating);
    const { total, base, bonus, ratedCount } = computeScores(rubric, ratingOf);

    if (input.ratings.length) {
      await conn.query(
        `INSERT INTO evaluation_scores (evaluation_id, rubric_version_id, criterion_id, score, note) VALUES ?
         ON DUPLICATE KEY UPDATE score = VALUES(score), note = VALUES(note)`,
        [input.ratings.map((r) => [id, versionId, r.criterionId, r.rating, r.note])],
      );
    }
    if (input.sectionNotes.length) {
      await conn.query(
        `INSERT INTO evaluation_section_notes (evaluation_id, rubric_version_id, section_id, note) VALUES ?
         ON DUPLICATE KEY UPDATE note = VALUES(note)`,
        [input.sectionNotes.map((n) => [id, versionId, n.sectionId, n.note])],
      );
    }
    await conn.query(
      `UPDATE evaluations SET core_score = ?, bonus_score = ?, total_score = ?, required_scored = ?,
         required_count = ?, overall_notes = ?, row_version = row_version + 1,
         save_count = save_count + 1, last_saved_at = NOW() WHERE id = ?`,
      [base, bonus, total, ratedCount, requiredCount(rubric), input.overallNotes || null, id],
    );
    // A draft revision in the history, at most every few minutes.
    const [recent] = await conn.query<RowDataPacket[]>(
      `SELECT 1 FROM evaluation_events WHERE evaluation_id = ? AND event IN ('draft_saved', 'started', 'reopened')
         AND created_at > NOW() - INTERVAL ? MINUTE LIMIT 1`,
      [id, DRAFT_EVENT_INTERVAL_MINUTES],
    );
    const saved = (await loadEvaluation(conn, id))!;
    if (!recent.length) {
      await recordEvent(conn, {
        evaluationId: id,
        event: 'draft_saved',
        actor,
        rubricVersionId: versionId,
        rowVersion: saved.rowVersion,
        ratedCount,
        totalScore: total,
      });
    }
    return saved;
  });
}

/**
 * Submits and locks. A repeated request for an already-submitted evaluation
 * returns it unchanged instead of submitting twice.
 */
export function submitEvaluation(
  pool: Pool,
  actor: Actor,
  id: number,
  rowVersion: number,
): Promise<SubmitEvaluationResponse> {
  return inTransaction(pool, async (conn) => {
    await requireCompetitionState(conn, 'judging_open');
    const { row, team, staleVersion } = await lockOwn(conn, actor, id, rowVersion);
    if (row.status === 'submitted') {
      return { evaluation: (await loadEvaluation(conn, id))!, alreadySubmitted: true };
    }
    if (team.status !== 'active') throw archived();
    if (staleVersion) throw await conflict(conn, id);

    const rubric = (await loadVersion(conn, Number(row.rubric_version_id)))!;
    const current = (await loadEvaluation(conn, id))!;
    const ratingOf = new Map(current.ratings.map((r) => [r.criterionId, r.rating]));
    const missing = missingRequiredRatings(rubric, ratingOf);
    if (missing.length) {
      throw new RuleError(
        400,
        EVALUATION_ERRORS.EVALUATION_INCOMPLETE,
        `Rate all ${requiredCount(rubric)} required criteria before submitting (${missing.length} still missing).`,
        { missingCriteria: missing },
      );
    }
    const { total, base, bonus, complete, ratedCount } = computeScores(rubric, ratingOf);
    if (!complete) throw new Error('Scoring incomplete after validation');

    await conn.query(
      `UPDATE evaluations SET status = 'submitted', submitted_at = NOW(), core_score = ?, bonus_score = ?,
         total_score = ?, required_scored = ?, required_count = ?, row_version = row_version + 1,
         reopen_notice_pending = FALSE
       WHERE id = ? AND status = 'draft'`,
      [base, bonus, total, ratedCount, requiredCount(rubric), id],
    );
    const resubmission = current.reopenedCount > 0;
    const [previous] = await conn.query<RowDataPacket[]>(
      `SELECT total_score FROM evaluation_events WHERE evaluation_id = ? AND event IN ('submitted', 'resubmitted', 'admin_corrected')
       ORDER BY id DESC LIMIT 1`,
      [id],
    );
    await recordEvent(conn, {
      evaluationId: id,
      event: resubmission ? 'resubmitted' : 'submitted',
      actor,
      rubricVersionId: Number(row.rubric_version_id),
      rowVersion: Number(row.row_version) + 1,
      ratedCount,
      totalScore: total,
      previousScore: previous[0]?.total_score == null ? null : Number(previous[0].total_score),
      snapshot: snapshotOf(rubric, current, total),
    });
    await writeAudit(conn, {
      actorId: actor.id,
      actorEmail: actor.email,
      action: resubmission ? 'evaluation.resubmitted' : 'evaluation.submitted',
      entityType: 'evaluation',
      entityId: id,
      ipAddress: actor.ip,
      details: {
        team_id: Number(team.id),
        team_code: team.team_code,
        rubric_version_no: rubric.versionNo,
        total_score: total,
      },
    });
    return { evaluation: (await loadEvaluation(conn, id))!, alreadySubmitted: false };
  });
}

/** The judge has seen that their evaluation was reopened (clears the notice). */
export async function acknowledgeReopen(pool: Pool, actor: Actor, id: number) {
  await inTransaction(pool, async (conn) => {
    await requireCompetitionState(conn, 'judging_open');
    await conn.query(
      `UPDATE evaluations SET reopen_notice_pending = FALSE
     WHERE id = ? AND judge_id = ? AND status = 'draft' AND reopen_notice_pending = TRUE`,
      [id, actor.id],
    );
  });
}
