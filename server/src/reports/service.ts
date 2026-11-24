import { teamResources, resourceValues } from '../teams/resources.js';
import type { Pool, PoolConnection, RowDataPacket } from 'mysql2/promise';
import {
  maximumScore,
  scoreEvaluation,
  type ReportFilters,
  type ReportKind,
  type ReportSheet,
  type ReportWorkbook,
  type ReportCell,
} from '@judging/shared';
import { RuleError } from '../errors.js';
import { loadEvaluation } from '../evaluations/service.js';
import { loadVersion, listVersions } from '../rubric/service.js';
import { getResults } from '../results/service.js';
import { snapshotChunks } from './format.js';

const LIMIT = 2500;
const large = () =>
  new RuleError(
    413,
    'REPORT_TOO_LARGE',
    'More than 2,500 records or 32 MB of notes match this report. Narrow the filters; no records were omitted.',
  );
const iso = (v: unknown) => (v == null ? null : new Date(v as string | Date).toISOString());
const sheet = (name: string, columns: string[]): ReportSheet => ({ name, columns, rows: [] });

function where(filters: ReportFilters, corrections = false) {
  const terms: string[] = [],
    values: unknown[] = [];
  for (const [key, col] of [
    ['teamId', 'e.team_id'],
    ['judgeId', 'e.judge_id'],
    ['version', 'v.version_no'],
    ['status', 'e.status'],
  ] as const)
    if (filters[key] != null) {
      terms.push(`${col}=?`);
      values.push(filters[key]);
    }
  if (filters.from) {
    terms.push(`${corrections ? 'ev.created_at' : 'e.submitted_at'} >= ?`);
    values.push(new Date(filters.from));
  }
  if (filters.to) {
    terms.push(`${corrections ? 'ev.created_at' : 'e.submitted_at'} <= ?`);
    values.push(new Date(filters.to));
  }
  return { sql: terms.length ? ' AND ' + terms.join(' AND ') : '', values };
}

async function appendTeamResources(conn: PoolConnection, sheets: ReportSheet[]) {
  const targets = sheets.filter((s) => s.columns.includes('Team ID'));
  const codes = [
    ...new Set(targets.flatMap((s) => s.rows.map((r) => String(r[s.columns.indexOf('Team ID')])))),
  ];
  if (!codes.length) {
    for (const s of targets)
      s.columns.push(
        'Student 1 Name',
        'Student 2 Name',
        'Student 3 Name',
        'Presentation Link',
        'Project Website Link',
      );
    return;
  }
  const [teams] = await conn.query<RowDataPacket[]>('SELECT * FROM teams WHERE team_code IN (?)', [
    codes,
  ]);
  const byCode = new Map(teams.map((t) => [String(t.team_code), resourceValues(teamResources(t))]));
  for (const s of targets) {
    const codeIndex = s.columns.indexOf('Team ID');
    s.columns.push(
      'Student 1 Name',
      'Student 2 Name',
      'Student 3 Name',
      'Presentation Link',
      'Project Website Link',
    );
    for (const row of s.rows)
      row.push(...(byCode.get(String(row[codeIndex])) ?? [null, null, null, null, null]));
  }
}

async function resultsSheets(conn: PoolConnection, filters: ReportFilters, progress: boolean) {
  const result = await getResults(conn, { sort: 'rank', dir: 'asc' });
  const ranked = new Map(result.official.teams.map((t) => [t.teamId, t.rank]));
  const provisional = result.provisional.flatMap((g) => g.teams);
  const all = [...result.official.teams, ...provisional, ...result.notRanked].filter(
    (t) =>
      (filters.teamId == null || t.teamId === filters.teamId) &&
      (filters.judgeId == null || t.judges.some((j) => j.judgeId === filters.judgeId)) &&
      (filters.version == null || t.versions.includes(filters.version)),
  );
  const rows = sheet(progress ? 'Team Progress' : 'Competition Results', [
    'Official rank',
    'Team database ID',
    'Team ID',
    'Team name',
    'Project',
    'Assigned judges',
    'Submitted',
    'Pending',
    'Completion percent',
    'Base average',
    'Bonus average',
    'Combined average',
    'Maximum possible',
    'Completion status',
    'Rubric versions',
    'Ranking eligibility',
    'Blocked reasons',
    'Reopened evaluations',
  ]);
  for (const t of all)
    rows.rows.push([
      ranked.get(t.teamId) ?? null,
      t.teamId,
      t.teamCode,
      t.name,
      t.projectName,
      t.judges.map((j) => `${j.fullName} [${j.judgeId}]`).join('; '),
      t.submitted,
      t.pending,
      t.assignedJudges ? (t.submitted / t.assignedJudges) * 100 : null,
      t.baseAverage ?? null,
      t.bonusAverage ?? null,
      t.provisionalAverage,
      t.maximumScore ?? null,
      t.status,
      t.versions.join('; '),
      ranked.has(t.teamId)
        ? 'Official'
        : t.status === 'ready'
          ? 'Provisional — incompatible rubric versions'
          : 'Unranked',
      t.reasons.join('; '),
      t.judges.filter((j) => j.reopened).length,
    ]);
  if (!progress) return [rows];
  // Archived teams and assignments remain visible for progress, never enter official ranks.
  const params: unknown[] = [];
  let condition = "t.status='archived'";
  if (filters.teamId) {
    condition += ' AND t.id=?';
    params.push(filters.teamId);
  }
  if (filters.judgeId) {
    condition +=
      ' AND EXISTS (SELECT 1 FROM team_judges tj WHERE tj.team_id=t.id AND tj.judge_id=?)';
    params.push(filters.judgeId);
  }
  const [archived] = await conn.query<RowDataPacket[]>(
    `SELECT t.id,t.team_code,t.name,t.project_name,u.id AS judge_id,u.full_name,e.status,e.reopened_count FROM teams t LEFT JOIN team_judges tj ON tj.team_id=t.id LEFT JOIN users u ON u.id=tj.judge_id LEFT JOIN evaluations e ON e.team_id=t.id AND e.judge_id=u.id WHERE ${condition} ORDER BY t.id,u.id`,
    params,
  );
  const archivedSheet = sheet('Archived Team Progress', [
    'Team database ID',
    'Team ID',
    'Team name',
    'Project',
    'Judge ID',
    'Judge name',
    'Evaluation status',
    'Reopened',
    'Ranking eligibility',
    'Assigned judge count',
    'Submitted count',
    'Pending count',
    'Completion percent',
  ]);
  const archivedCounts = new Map<number, { assigned: number; submitted: number }>();
  for (const r of archived) {
    const count = archivedCounts.get(Number(r.id)) ?? { assigned: 0, submitted: 0 };
    if (r.judge_id != null) {
      count.assigned++;
      if (r.status === 'submitted') count.submitted++;
    }
    archivedCounts.set(Number(r.id), count);
  }
  for (const r of archived)
    archivedSheet.rows.push([
      Number(r.id),
      r.team_code,
      r.name,
      r.project_name,
      r.judge_id == null ? null : Number(r.judge_id),
      r.full_name ?? null,
      r.status ?? 'not_started',
      Number(r.reopened_count ?? 0) > 0,
      'Historical — excluded',
      archivedCounts.get(Number(r.id))!.assigned,
      archivedCounts.get(Number(r.id))!.submitted,
      archivedCounts.get(Number(r.id))!.assigned - archivedCounts.get(Number(r.id))!.submitted,
      archivedCounts.get(Number(r.id))!.assigned
        ? (archivedCounts.get(Number(r.id))!.submitted /
            archivedCounts.get(Number(r.id))!.assigned) *
          100
        : null,
    ]);
  const workload = sheet('Judge Workload', [
    'Judge ID',
    'Judge name',
    'Active assignments',
    'Submitted',
    'Pending',
    'Reopened',
    'Completion percent',
  ]);
  const judges = new Map<
    number,
    { name: string; assigned: number; submitted: number; reopened: number }
  >();
  for (const t of all)
    for (const j of t.judges) {
      const n = judges.get(j.judgeId) ?? {
        name: j.fullName,
        assigned: 0,
        submitted: 0,
        reopened: 0,
      };
      n.assigned++;
      n.submitted += j.status === 'submitted' ? 1 : 0;
      n.reopened += j.reopened ? 1 : 0;
      judges.set(j.judgeId, n);
    }
  // Include accounts with zero current workload, including administrators who may judge.
  const [accounts] = await conn.query<RowDataPacket[]>(
    "SELECT id,full_name FROM users WHERE role IN ('judge','admin') ORDER BY full_name,id",
  );
  for (const r of accounts) {
    const id = Number(r.id);
    if (filters.judgeId != null && filters.judgeId !== id) continue;
    const j = judges.get(id) ?? { name: r.full_name, assigned: 0, submitted: 0, reopened: 0 };
    workload.rows.push([
      id,
      j.name,
      j.assigned,
      j.submitted,
      j.assigned - j.submitted,
      j.reopened,
      j.assigned ? (j.submitted / j.assigned) * 100 : null,
    ]);
  }
  return [rows, workload, archivedSheet];
}

async function evaluationSheets(conn: PoolConnection, filters: ReportFilters) {
  const q = where(filters);
  const [ids] = await conn.query<RowDataPacket[]>(
    `SELECT e.id,t.team_code,t.name,t.status AS team_status,u.full_name,u.id AS judge_id,EXISTS(SELECT 1 FROM team_judges tj WHERE tj.team_id=e.team_id AND tj.judge_id=e.judge_id) AS assigned FROM evaluations e JOIN teams t ON t.id=e.team_id JOIN users u ON u.id=e.judge_id JOIN rubric_versions v ON v.id=e.rubric_version_id WHERE 1=1${q.sql} ORDER BY e.id LIMIT ${LIMIT + 1}`,
    q.values,
  );
  if (ids.length > LIMIT) throw large();
  if (ids.length) {
    const list = ids.map((r) => Number(r.id));
    const [[size]] = await conn.query<RowDataPacket[]>(
      `SELECT (SELECT COALESCE(SUM(OCTET_LENGTH(note)),0) FROM evaluation_scores WHERE evaluation_id IN (?))
        + (SELECT COALESCE(SUM(OCTET_LENGTH(note)),0) FROM evaluation_section_notes WHERE evaluation_id IN (?))
        + (SELECT COALESCE(SUM(OCTET_LENGTH(overall_notes)),0) FROM evaluations WHERE id IN (?)) AS bytes`,
      [list, list, list],
    );
    if (Number(size!.bytes) > 32 * 1024 * 1024) throw large();
  }
  const evaluations = sheet('Evaluations', [
    'Evaluation ID',
    'Team ID',
    'Team name',
    'Judge ID',
    'Judge name',
    'Status',
    'Rubric version',
    'Base score',
    'Bonus score',
    'Combined score',
    'Maximum possible',
    'Overall comments',
    'Submitted at (UTC)',
    'Last correction (UTC)',
    'Result context',
  ]);
  const sections = sheet('Sections', [
    'Evaluation ID',
    'Section ID',
    'Section',
    'Type',
    'Section points or Actual weight percent',
    'Maximum bonus',
    'Section score',
    'Section notes',
  ]);
  const criteria = sheet('Criteria', [
    'Evaluation ID',
    'Section ID',
    'Criterion ID',
    'Criterion',
    'Score (stars 1-5 or points; blank = unscored)',
    'Maximum (5 stars or criterion points)',
    'Criterion notes',
  ]);
  const rubricCache = new Map<number, NonNullable<Awaited<ReturnType<typeof loadVersion>>>>();
  for (const row of ids) {
    const e = (await loadEvaluation(conn, Number(row.id)))!;
    let rubric = rubricCache.get(e.rubricVersionId);
    if (!rubric) {
      rubric = (await loadVersion(conn, e.rubricVersionId))!;
      rubricCache.set(e.rubricVersionId, rubric);
    }
    const ratings = new Map(e.ratings.map((r) => [r.criterionId, r]));
    const scores = scoreEvaluation(
      rubric.sections,
      rubric.sections.map((s) => s.criteria.map((c) => ratings.get(c.id)?.rating ?? null)),
    );
    evaluations.rows.push([
      e.id,
      row.team_code,
      row.name,
      e.judgeId,
      row.full_name,
      e.status,
      e.rubricVersionNo,
      e.baseScore ?? 0,
      e.bonusScore ?? 0,
      e.totalScore,
      maximumScore(rubric.sections),
      e.overallNotes,
      e.submittedAt,
      e.adminModifiedAt ?? null,
      row.team_status === 'active' && row.assigned ? 'Current assignment' : 'Historical — excluded',
    ]);
    rubric.sections.forEach((s, i) => {
      sections.rows.push([
        e.id,
        s.id,
        s.title,
        s.type ?? 'actual',
        s.weightPercent,
        s.maxBonusPoints ?? null,
        scores.sections[i]?.score ?? null,
        e.sectionNotes.find((n) => n.sectionId === s.id)?.note ?? '',
      ]);
      for (const c of s.criteria) {
        const r = ratings.get(c.id);
        criteria.rows.push([
          e.id,
          s.id,
          c.id,
          c.title,
          r?.rating ?? null,
          c.maxPoints ?? 5,
          r?.note ?? '',
        ]);
      }
    });
  }
  return [evaluations, sections, criteria];
}

async function correctionSheets(conn: PoolConnection, filters: ReportFilters) {
  const q = where(filters, true);
  const from = `FROM evaluation_events ev JOIN evaluations e ON e.id=ev.evaluation_id JOIN teams t ON t.id=e.team_id JOIN users j ON j.id=e.judge_id JOIN rubric_versions v ON v.id=e.rubric_version_id LEFT JOIN users a ON a.id=ev.actor_id WHERE ev.event='admin_corrected'${q.sql}`;
  const [[size]] = await conn.query<RowDataPacket[]>(
    `SELECT COUNT(*) AS n,COALESCE(SUM(OCTET_LENGTH(ev.snapshot)+OCTET_LENGTH(ev.previous_snapshot)),0) AS bytes ${from}`,
    q.values,
  );
  if (Number(size!.n) > LIMIT || Number(size!.bytes) > 32 * 1024 * 1024) throw large();
  const [events] = await conn.query<RowDataPacket[]>(
    `SELECT ev.id,ev.evaluation_id,t.team_code,t.name,j.id AS judge_id,j.full_name AS judge_name,a.full_name AS admin_name,ev.actor_id,ev.actor_email,ev.created_at,ev.reason,ev.previous_score,ev.total_score,ev.previous_snapshot,ev.snapshot,v.version_no ${from} ORDER BY ev.id`,
    q.values,
  );
  const history = sheet('Corrections', [
    'Event ID',
    'Evaluation ID',
    'Team ID',
    'Team',
    'Original judge ID',
    'Original judge',
    'Admin ID',
    'Administrator',
    'Administrator email',
    'Corrected at (UTC)',
    'Reason',
    'Previous combined',
    'Corrected combined',
    'Rubric version',
  ]);
  const snapshots = sheet('Immutable Snapshots', [
    'Event ID',
    'Evaluation ID',
    'Side',
    'Chunk (join in order)',
    'Snapshot JSON',
  ]);
  const details = sheet('Before After Details', [
    'Event ID',
    'Evaluation ID',
    'Side',
    'Field',
    'Stable ID',
    'Section ID',
    'Label',
    'Value',
    'Notes',
  ]);
  for (const r of events) {
    history.rows.push([
      Number(r.id),
      Number(r.evaluation_id),
      r.team_code,
      r.name,
      Number(r.judge_id),
      r.judge_name,
      r.actor_id == null ? null : Number(r.actor_id),
      r.admin_name ?? null,
      r.actor_email ?? null,
      iso(r.created_at),
      r.reason,
      Number(r.previous_score),
      Number(r.total_score),
      Number(r.version_no),
    ]);
    for (const [side, raw] of [
      ['Before', r.previous_snapshot],
      ['After', r.snapshot],
    ] as const) {
      if (raw == null) {
        snapshots.rows.push([
          Number(r.id),
          Number(r.evaluation_id),
          side,
          1,
          'Snapshot unavailable in original event',
        ]);
        continue;
      }
      const text = typeof raw === 'string' ? raw : JSON.stringify(raw);
      // Preserve every byte of snapshot JSON, even when larger than an Excel cell.
      for (const [index, chunk] of snapshotChunks(text).entries())
        snapshots.rows.push([Number(r.id), Number(r.evaluation_id), side, index + 1, chunk]);
      const snap = JSON.parse(text);
      const add = (
        field: string,
        id: ReportCell,
        sectionId: ReportCell,
        label: string,
        value: ReportCell,
        notes = '',
      ) =>
        details.rows.push([
          Number(r.id),
          Number(r.evaluation_id),
          side,
          field,
          id,
          sectionId,
          label,
          value,
          notes,
        ]);
      add('combined', null, null, 'Combined score', snap.totalScore);
      add('base', null, null, 'Base score', snap.baseScore ?? snap.totalScore);
      add('bonus', null, null, 'Bonus score', snap.bonusScore ?? 0);
      add('overall', null, null, 'Overall comments', null, snap.overallNotes ?? '');
      for (const s of snap.sections ?? [])
        add('section', s.sectionId, s.sectionId, s.title, s.score, s.note);
      for (const c of snap.ratings ?? [])
        add('criterion', c.criterionId, c.sectionId, c.title, c.rating, c.note);
    }
  }
  return [history, details, snapshots];
}

async function rubricSheets(conn: PoolConnection, filters: ReportFilters) {
  const versions = (await listVersions(conn)).filter(
    (v) => filters.version == null || v.versionNo === filters.version,
  );
  const [[pointer]] = await conn.query<RowDataPacket[]>(
    'SELECT published_version_id FROM rubric WHERE id=1',
  );
  const rows = sheet('Rubric History', [
    'Version',
    'Version ID',
    'Title',
    'Published at (UTC)',
    'Status',
    'Active for new evaluations',
    'Scoring format',
    'Section ID',
    'Section',
    'Type',
    'Section points or Actual weight percent',
    'Maximum bonus points',
    'Section description',
    'Criterion ID',
    'Criterion',
    'Criterion description',
    'Criterion maximum points (points rubrics)',
    'Guidelines',
    'Instructions',
  ]);
  for (const v of versions)
    for (const s of v.sections)
      for (const c of s.criteria)
        rows.rows.push([
          v.versionNo,
          v.id,
          v.title,
          v.publishedAt,
          v.status,
          v.id === Number(pointer?.published_version_id),
          v.scoringFormat ?? 1,
          s.id,
          s.title,
          s.type ?? 'actual',
          s.weightPercent,
          s.maxBonusPoints ?? null,
          s.description,
          c.id,
          c.title,
          c.description,
          c.maxPoints ?? null,
          c.guidelines,
          v.instructions,
        ]);
  const summary = sheet('Versions', [
    'Version',
    'Version ID',
    'Title',
    'Description',
    'Status',
    'Published at (UTC)',
    'Created at (UTC)',
    'Active for new evaluations',
  ]);
  for (const v of versions)
    summary.rows.push([
      v.versionNo,
      v.id,
      v.title,
      v.description,
      v.status,
      v.publishedAt,
      v.createdAt,
      v.id === Number(pointer?.published_version_id),
    ]);
  return [rows, summary];
}

export async function buildReport(
  pool: Pool,
  kind: ReportKind,
  filters: ReportFilters,
): Promise<ReportWorkbook> {
  const conn = await pool.getConnection();
  try {
    await conn.query('SET SESSION TRANSACTION ISOLATION LEVEL REPEATABLE READ');
    await conn.query('START TRANSACTION WITH CONSISTENT SNAPSHOT, READ ONLY');
    try {
      const [[count]] = await conn.query<RowDataPacket[]>('SELECT COUNT(*) AS n FROM teams');
      if (Number(count!.n) > 5000) throw large();
      const [[now]] = await conn.query<RowDataPacket[]>('SELECT NOW(3) AS generated_at');
      const sheets =
        kind === 'results' || kind === 'progress'
          ? await resultsSheets(conn, filters, kind === 'progress')
          : kind === 'evaluations'
            ? await evaluationSheets(conn, filters)
            : kind === 'corrections'
              ? await correctionSheets(conn, filters)
              : await rubricSheets(conn, filters);
      await appendTeamResources(conn, sheets);
      return { kind, generatedAt: iso(now!.generated_at)!, filters, sheets };
    } finally {
      await conn.query('COMMIT');
    }
  } finally {
    conn.release();
  }
}
