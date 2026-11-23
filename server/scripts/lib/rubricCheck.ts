/**
 * Read-only rubric-version diagnostics. Runs inside a READ ONLY transaction:
 * nothing is inserted, updated or deleted.
 */
import type { Pool, RowDataPacket } from 'mysql2/promise';

export interface RubricCheckReport {
  competition: { state: string; lockedVersionNo: number | null } | null;
  publishedVersionNo: number | null;
  draftVersionNo: number | null;
  versions: { versionNo: number; status: string; scoringFormat: number; title: string }[];
  evaluationsByVersion: { versionNo: number; draft: number; submitted: number }[];
  /** Active teams whose currently assigned judges' evaluations use more than one version. */
  mixedTeams: { teamCode: string; name: string; versions: number[] }[];
  /** Assigned evaluations on active teams that do not use the locked/published version. */
  offVersion: { teamCode: string; judge: string; versionNo: number; status: string }[];
  problems: string[];
}

export async function rubricCheck(pool: Pool): Promise<RubricCheckReport> {
  const conn = await pool.getConnection();
  try {
    await conn.query('START TRANSACTION READ ONLY');
    try {
      const [[pointers]] = (await conn.query(
        `SELECT (SELECT version_no FROM rubric_versions WHERE id = r.published_version_id) AS published_no,
                (SELECT version_no FROM rubric_versions WHERE id = r.draft_version_id) AS draft_no
         FROM rubric r WHERE r.id = 1`,
      )) as unknown as [RowDataPacket[]];
      let competition: RubricCheckReport['competition'] = null;
      try {
        const [[c]] = (await conn.query(
          `SELECT c.state, v.version_no AS locked_no FROM competition c
           LEFT JOIN rubric_versions v ON v.id = c.locked_rubric_version_id WHERE c.id = 1`,
        )) as unknown as [RowDataPacket[]];
        if (c)
          competition = {
            state: String(c.state),
            lockedVersionNo: c.locked_no == null ? null : Number(c.locked_no),
          };
      } catch {
        competition = null; // lifecycle migration not applied
      }
      const [versions] = await conn.query<RowDataPacket[]>(
        'SELECT version_no, status, scoring_format, title FROM rubric_versions ORDER BY version_no',
      );
      const [byVersion] = await conn.query<RowDataPacket[]>(
        `SELECT v.version_no, SUM(e.status = 'draft') AS draft, SUM(e.status = 'submitted') AS submitted
         FROM evaluations e JOIN rubric_versions v ON v.id = e.rubric_version_id
         GROUP BY v.version_no ORDER BY v.version_no`,
      );
      const [assigned] = await conn.query<RowDataPacket[]>(
        `SELECT t.team_code, t.name, u.full_name, v.version_no, e.status
         FROM team_judges tj
         JOIN teams t ON t.id = tj.team_id AND t.status = 'active'
         JOIN users u ON u.id = tj.judge_id
         JOIN evaluations e ON e.team_id = tj.team_id AND e.judge_id = tj.judge_id
         JOIN rubric_versions v ON v.id = e.rubric_version_id
         ORDER BY t.team_code, u.full_name`,
      );

      const published = pointers?.published_no == null ? null : Number(pointers.published_no);
      const reference = competition?.lockedVersionNo ?? published;
      const teams = new Map<string, { name: string; versions: Set<number> }>();
      const offVersion: RubricCheckReport['offVersion'] = [];
      for (const r of assigned) {
        const code = String(r.team_code);
        const entry = teams.get(code) ?? { name: String(r.name), versions: new Set<number>() };
        entry.versions.add(Number(r.version_no));
        teams.set(code, entry);
        if (reference != null && Number(r.version_no) !== reference) {
          offVersion.push({
            teamCode: code,
            judge: String(r.full_name),
            versionNo: Number(r.version_no),
            status: String(r.status),
          });
        }
      }
      const mixedTeams = [...teams.entries()]
        .filter(([, t]) => t.versions.size > 1)
        .map(([teamCode, t]) => ({
          teamCode,
          name: t.name,
          versions: [...t.versions].sort((a, b) => a - b),
        }));

      const problems: string[] = [];
      if (mixedTeams.length)
        problems.push(
          `${mixedTeams.length} active team(s) have assigned evaluations on more than one rubric version; they are blocked from the official ranking.`,
        );
      if (offVersion.length && reference != null)
        problems.push(
          `${offVersion.length} assigned evaluation(s) do not use rubric v${reference} (the ${competition?.lockedVersionNo != null ? 'locked' : 'published'} version).`,
        );
      if (
        competition?.lockedVersionNo != null &&
        published != null &&
        competition.lockedVersionNo !== published
      )
        problems.push(
          `The competition is locked to v${competition.lockedVersionNo} but v${published} is published.`,
        );

      return {
        competition,
        publishedVersionNo: published,
        draftVersionNo: pointers?.draft_no == null ? null : Number(pointers.draft_no),
        versions: versions.map((v) => ({
          versionNo: Number(v.version_no),
          status: String(v.status),
          scoringFormat: Number(v.scoring_format ?? 1),
          title: String(v.title),
        })),
        evaluationsByVersion: byVersion.map((v) => ({
          versionNo: Number(v.version_no),
          draft: Number(v.draft ?? 0),
          submitted: Number(v.submitted ?? 0),
        })),
        mixedTeams,
        offVersion,
        problems,
      };
    } finally {
      await conn.query('ROLLBACK');
    }
  } finally {
    conn.release();
  }
}
