import type { Pool, PoolConnection, RowDataPacket } from 'mysql2/promise';
import type { CompetitionStatus } from '@judging/shared';
import { RuleError } from '../errors.js';
import { inTransaction, type Actor } from '../teams/service.js';
import { writeAudit } from '../audit.js';
import { loadVersion } from '../rubric/service.js';
import { contentOf, validateRubric } from '@judging/shared';

export async function competitionStatus(db: Pool | PoolConnection): Promise<CompetitionStatus> {
  const [rows] = await db.query<RowDataPacket[]>(
    `SELECT c.*,v.version_no FROM competition c LEFT JOIN rubric_versions v ON v.id=c.locked_rubric_version_id WHERE c.id=1`,
  );
  const r = rows[0];
  if (!r)
    throw new RuleError(503, 'COMPETITION_UNAVAILABLE', 'Competition settings are unavailable.');
  return {
    state: r.state,
    rowVersion: Number(r.row_version),
    lockedRubricVersionId:
      r.locked_rubric_version_id == null ? null : Number(r.locked_rubric_version_id),
    lockedRubricVersionNo: r.version_no == null ? null : Number(r.version_no),
    startedAt: r.started_at ? new Date(r.started_at).toISOString() : null,
    closedAt: r.closed_at ? new Date(r.closed_at).toISOString() : null,
  };
}

export async function requireCompetitionState(
  db: PoolConnection,
  expected: 'preparation' | 'judging_open',
) {
  const c = await competitionStatus(db);
  if (c.state !== expected)
    throw new RuleError(
      409,
      'COMPETITION_LOCKED',
      expected === 'preparation'
        ? 'Rubric management is available only during Preparation. The competition rubric is locked.'
        : c.state === 'closed'
          ? 'The competition is Closed. Evaluations and final results are read-only.'
          : 'Judging has not opened. An administrator must start the competition first.',
    );
  return c;
}

export function transitionCompetition(
  pool: Pool,
  actor: Actor,
  target: 'judging_open' | 'closed',
  rowVersion: number,
) {
  return inTransaction(pool, async (conn) => {
    const c = await requireCompetitionState(
      conn,
      target === 'judging_open' ? 'preparation' : 'judging_open',
    );
    if (c.rowVersion !== rowVersion)
      throw new RuleError(
        409,
        'COMPETITION_CONFLICT',
        'Competition settings changed. Reload before continuing.',
      );
    let versionId = c.lockedRubricVersionId;
    if (target === 'judging_open') {
      const [rows] = await conn.query<RowDataPacket[]>(
        'SELECT published_version_id,draft_version_id FROM rubric WHERE id=1 FOR UPDATE',
      );
      versionId =
        rows[0]?.published_version_id == null ? null : Number(rows[0].published_version_id);
      const rubric = versionId == null ? null : await loadVersion(conn, versionId);
      if (
        !rubric ||
        rubric.status !== 'published' ||
        validateRubric(contentOf(rubric)).publish.length ||
        rows[0]?.draft_version_id != null
      )
        throw new RuleError(
          409,
          'COMPETITION_NOT_READY',
          'Publish a valid rubric and publish or discard any pending draft before starting.',
        );
      const [problems] = await conn.query<RowDataPacket[]>(
        `SELECT t.id FROM teams t WHERE t.status='active' AND (NOT EXISTS (
          SELECT 1 FROM team_judges tj JOIN users u ON u.id=tj.judge_id AND u.status='active' WHERE tj.team_id=t.id)
          OR EXISTS (SELECT 1 FROM evaluations e JOIN team_judges tj ON tj.team_id=e.team_id AND tj.judge_id=e.judge_id
            WHERE e.team_id=t.id AND e.rubric_version_id<>?)) LIMIT 1`,
        [versionId],
      );
      const [teams] = await conn.query<RowDataPacket[]>(
        "SELECT id FROM teams WHERE status='active' LIMIT 1",
      );
      if (!teams.length || problems.length)
        throw new RuleError(
          409,
          'COMPETITION_NOT_READY',
          'Add an active team, assign at least one active judge to each active team, and resolve evaluations using other rubric versions.',
        );
    }
    await conn.query(
      `UPDATE competition SET state=?,locked_rubric_version_id=?,row_version=row_version+1,
      started_at=IF(?='judging_open',NOW(3),started_at),closed_at=IF(?='closed',NOW(3),closed_at) WHERE id=1`,
      [target, versionId, target, target],
    );
    await writeAudit(conn, {
      actorId: actor.id,
      actorEmail: actor.email,
      action: `competition.${target}`,
      entityType: 'competition',
      entityId: 1,
      ipAddress: actor.ip,
      details: { rubric_version_id: versionId },
    });
    return competitionStatus(conn);
  });
}
