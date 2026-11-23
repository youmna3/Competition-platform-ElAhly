import type { Pool, PoolConnection, ResultSetHeader, RowDataPacket } from 'mysql2/promise';
import {
  RUBRIC_ERRORS,
  RUBRIC_SHAPE,
  contentOf,
  defaultRubricContent,
  totalWeight,
  validateRubric,
  type AdminRubricResponse,
  type RubricContent,
  type RubricEvaluationCounts,
  type RubricState,
  type RubricVersion,
  type RubricVersionStatus,
} from '@judging/shared';
import { writeAudit } from '../audit.js';
import { RuleError } from '../errors.js';
import { inTransaction, type Actor } from '../teams/service.js';

type Db = Pool | PoolConnection;

const iso = (d: Date | null | undefined) => (d ? new Date(d).toISOString() : null);
const num = (v: unknown) => (v == null ? null : Number(v));

// ---------------------------------------------------------------------------
// Reading
// ---------------------------------------------------------------------------

export async function loadVersion(db: Db, id: number): Promise<RubricVersion | null> {
  const [rows] = await db.query<RowDataPacket[]>(
    `SELECT v.*, ub.email AS updated_by_email, pb.email AS published_by_email
     FROM rubric_versions v
     LEFT JOIN users ub ON ub.id = v.updated_by
     LEFT JOIN users pb ON pb.id = v.published_by
     WHERE v.id = ?`,
    [id],
  );
  const v = rows[0];
  if (!v) return null;
  const [sections] = await db.query<RowDataPacket[]>(
    `SELECT id, title, description, weight_percent, is_bonus, max_bonus_points FROM rubric_sections
     WHERE rubric_version_id = ? ORDER BY position`,
    [id],
  );
  const [criteria] = await db.query<RowDataPacket[]>(
    `SELECT id, section_id, title, description, guidelines
     FROM rubric_criteria WHERE rubric_version_id = ? ORDER BY section_id, position`,
    [id],
  );
  return {
    id: Number(v.id),
    scoringFormat: Number(v.scoring_format) === 2 ? 2 : 1,
    versionNo: Number(v.version_no),
    status: v.status as RubricVersionStatus,
    revision: Number(v.revision),
    title: String(v.title),
    description: String(v.description ?? ''),
    instructions: String(v.instructions ?? ''),
    createdAt: iso(v.created_at)!,
    updatedAt: iso(v.updated_at)!,
    updatedByEmail: v.updated_by_email ?? null,
    publishedAt: iso(v.published_at),
    publishedByEmail: v.published_by_email ?? null,
    sections: sections.map((s) => ({
      id: Number(s.id),
      type: s.is_bonus ? 'bonus' : 'actual',
      maxBonusPoints: num(s.max_bonus_points),
      title: String(s.title),
      description: String(s.description ?? ''),
      weightPercent: num(s.weight_percent),
      criteria: criteria
        .filter((c) => Number(c.section_id) === Number(s.id))
        .map((c) => ({
          id: Number(c.id),
          title: String(c.title),
          description: String(c.description ?? ''),
          guidelines: String(c.guidelines ?? ''),
        })),
    })),
  };
}

interface Pointers {
  publishedId: number | null;
  draftId: number | null;
}

async function pointers(db: Db, lock = false): Promise<Pointers> {
  const [rows] = await db.query<RowDataPacket[]>(
    `SELECT published_version_id, draft_version_id FROM rubric WHERE id = 1${lock ? ' FOR UPDATE' : ''}`,
  );
  const r = rows[0];
  if (!r) throw new Error('The rubric row is missing; run npm run db:migrate.');
  return { publishedId: num(r.published_version_id), draftId: num(r.draft_version_id) };
}

function stateOf({ publishedId, draftId }: Pointers): RubricState {
  if (publishedId == null) return draftId == null ? 'not_configured' : 'draft_only';
  return draftId == null ? 'published' : 'published_with_draft';
}

async function evaluationCounts(
  db: Db,
  publishedId: number | null,
): Promise<RubricEvaluationCounts> {
  const [[row]] = (await db.query(
    `SELECT COUNT(*) AS total,
            COALESCE(SUM(status = 'submitted'), 0) AS submitted,
            COALESCE(SUM(rubric_version_id <=> ?), 0) AS on_published,
            COALESCE(SUM(status = 'submitted' AND rubric_version_id <=> ?), 0) AS submitted_on_published
     FROM evaluations`,
    [publishedId, publishedId],
  )) as unknown as [RowDataPacket[]];
  const [versions] = await db.query<RowDataPacket[]>(
    `SELECT DISTINCT v.version_no FROM evaluations e
     JOIN rubric_versions v ON v.id = e.rubric_version_id
     WHERE e.status = 'submitted' ORDER BY v.version_no`,
  );
  return {
    total: Number(row?.total ?? 0),
    submitted: Number(row?.submitted ?? 0),
    onPublished: Number(row?.on_published ?? 0),
    submittedOnPublished: Number(row?.submitted_on_published ?? 0),
    submittedVersions: versions.map((v) => Number(v.version_no)),
  };
}

export async function getAdminRubric(db: Db): Promise<AdminRubricResponse> {
  const p = await pointers(db);
  return {
    state: stateOf(p),
    versions: await listVersions(db),
    published: p.publishedId == null ? null : await loadVersion(db, p.publishedId),
    draft: p.draftId == null ? null : await loadVersion(db, p.draftId),
    evaluations: await evaluationCounts(db, p.publishedId),
  };
}

export async function listVersions(db: Db): Promise<RubricVersion[]> {
  const [rows] = await db.query<RowDataPacket[]>(
    'SELECT id FROM rubric_versions ORDER BY version_no DESC',
  );
  const versions: RubricVersion[] = [];
  for (const row of rows) versions.push((await loadVersion(db, Number(row.id)))!);
  return versions;
}

/** The rubric judges score against, or null when nothing is published. */
export async function getPublishedRubric(db: Db): Promise<RubricVersion | null> {
  const { publishedId } = await pointers(db);
  return publishedId == null ? null : loadVersion(db, publishedId);
}

// ---------------------------------------------------------------------------
// Writing (drafts only: the database refuses changes to published versions)
// ---------------------------------------------------------------------------

const orNull = (s: string) => (s.trim() ? s : null);

async function writeVersionFields(
  conn: PoolConnection,
  id: number,
  c: RubricContent,
  actor: Actor,
) {
  // The fixed shape in Phase 1 terms: a 1-5 scale, no bonus, a maximum of 100.
  await conn.query(
    `UPDATE rubric_versions SET title = ?, description = ?, instructions = ?,
       scoring_format = ?, scale_min = ?, scale_max = ?, bonus_policy = ?, bonus_cap = NULL,
       total_target = ?, updated_by = ?, revision = revision + 1
     WHERE id = ? AND status = 'draft'`,
    [
      c.title.trim(),
      orNull(c.description),
      orNull(c.instructions),
      c.scoringFormat ?? 1,
      RUBRIC_SHAPE.minStars,
      RUBRIC_SHAPE.maxStars,
      c.scoringFormat === 2 ? 'add_to_total' : 'separate',
      RUBRIC_SHAPE.maxScore,
      actor.id,
      id,
    ],
  );
}

/**
 * Replaces the sections and criteria of a draft. Each criterion is a required
 * 1-5 star rating whose weight is its section's percentage / 10, so that
 * rating x weight summed over the section's two criteria is the section score.
 */
async function writeStructure(conn: PoolConnection, id: number, c: RubricContent) {
  const [oldSections] = await conn.query<RowDataPacket[]>(
    'SELECT id FROM rubric_sections WHERE rubric_version_id=?',
    [id],
  );
  const [oldCriteria] = await conn.query<RowDataPacket[]>(
    'SELECT id, section_id FROM rubric_criteria WHERE rubric_version_id=?',
    [id],
  );
  const sectionIds = new Set(oldSections.map((s) => Number(s.id)));
  const criterionSections = new Map(
    oldCriteria.map((cr) => [Number(cr.id), Number(cr.section_id)]),
  );
  const keptSections = new Set<number>();
  const keptCriteria = new Set<number>();
  // Reserve positions while retaining database IDs, including when earlier rows are removed.
  await conn.query('UPDATE rubric_sections SET position=position+1000 WHERE rubric_version_id=?', [
    id,
  ]);
  await conn.query('UPDATE rubric_criteria SET position=position+1000 WHERE rubric_version_id=?', [
    id,
  ]);
  for (const [i, section] of c.sections.entries()) {
    if (section.id != null && (!sectionIds.has(section.id) || keptSections.has(section.id)))
      throw invalid(
        [{ path: 'sections', message: 'Unknown or duplicate draft section ID.' }],
        false,
      );
    const bonus = section.type === 'bonus';
    const values = [
      i + 1,
      section.title.trim(),
      orNull(section.description),
      bonus,
      bonus ? null : section.weightPercent,
      bonus ? (section.maxBonusPoints ?? null) : null,
    ];
    let sectionId = section.id;
    if (sectionId != null) {
      await conn.query(
        'UPDATE rubric_sections SET position=?,title=?,description=?,is_bonus=?,weight_percent=?,max_bonus_points=? WHERE id=? AND rubric_version_id=?',
        [...values, sectionId, id],
      );
    } else {
      const [r] = await conn.query<ResultSetHeader>(
        'INSERT INTO rubric_sections (position,title,description,is_bonus,weight_percent,max_bonus_points,rubric_version_id) VALUES (?,?,?,?,?,?,?)',
        [...values, id],
      );
      sectionId = r.insertId;
    }
    keptSections.add(sectionId);
    for (const [j, cr] of section.criteria.entries()) {
      if (cr.id != null && (criterionSections.get(cr.id) !== sectionId || keptCriteria.has(cr.id)))
        throw invalid(
          [{ path: 'sections', message: 'Unknown, moved or duplicate draft criterion ID.' }],
          false,
        );
      const points = bonus ? section.maxBonusPoints : section.weightPercent;
      const fields = [
        j + 1,
        cr.title.trim(),
        orNull(cr.description),
        orNull(cr.guidelines),
        1,
        5,
        points == null ? 1 : points / 10,
        !bonus,
      ];
      if (cr.id != null) {
        await conn.query(
          'UPDATE rubric_criteria SET position=?,title=?,description=?,guidelines=?,min_score=?,max_score=?,weight=?,is_required=? WHERE id=?',
          [...fields, cr.id],
        );
        keptCriteria.add(cr.id);
      } else {
        const [r] = await conn.query<ResultSetHeader>(
          'INSERT INTO rubric_criteria (position,title,description,guidelines,min_score,max_score,weight,is_required,rubric_version_id,section_id) VALUES (?,?,?,?,?,?,?,?,?,?)',
          [...fields, id, sectionId],
        );
        keptCriteria.add(r.insertId);
      }
    }
  }
  for (const cr of oldCriteria)
    if (!keptCriteria.has(Number(cr.id)))
      await conn.query('DELETE FROM rubric_criteria WHERE id=? AND rubric_version_id=?', [
        cr.id,
        id,
      ]);
  for (const section of oldSections)
    if (!keptSections.has(Number(section.id)))
      await conn.query('DELETE FROM rubric_sections WHERE id=? AND rubric_version_id=?', [
        section.id,
        id,
      ]);
}

function summary(c: RubricContent) {
  return {
    sections: c.sections.map((s) => ({ title: s.title.trim(), weight_percent: s.weightPercent })),
    weight_total: totalWeight(c.sections),
  };
}

const invalid = (issues: { path: string; message: string }[], publishing: boolean) =>
  new RuleError(
    400,
    RUBRIC_ERRORS.RUBRIC_INVALID,
    publishing
      ? `The rubric can't be published yet: ${issues[0]!.message}${issues.length > 1 ? ` (and ${issues.length - 1} more)` : ''}`
      : `The draft can't be saved: ${issues[0]!.message}${issues.length > 1 ? ` (and ${issues.length - 1} more)` : ''}`,
    { issues },
  );

const noDraft = () =>
  new RuleError(
    409,
    RUBRIC_ERRORS.NO_DRAFT,
    'There is no draft to change. It may have just been published or discarded.',
  );

async function lockDraft(conn: PoolConnection, revision: number) {
  const p = await pointers(conn, true);
  if (p.draftId == null) throw noDraft();
  const [rows] = await conn.query<RowDataPacket[]>(
    'SELECT version_no, revision FROM rubric_versions WHERE id = ? FOR UPDATE',
    [p.draftId],
  );
  const row = rows[0]!;
  if (Number(row.revision) !== revision) {
    throw new RuleError(
      409,
      RUBRIC_ERRORS.REVISION_CONFLICT,
      'The draft was changed somewhere else (another window or administrator) after you opened it. Reload it to see the latest version.',
    );
  }
  return { ...p, draftId: p.draftId, versionNo: Number(row.version_no) };
}

/** Starts a draft: empty when nothing is published, otherwise a copy of the published version. */
export function createDraft(pool: Pool, actor: Actor, sourceVersionId?: number) {
  return inTransaction(pool, async (conn) => {
    const p = await pointers(conn, true);
    if (p.draftId != null) {
      throw new RuleError(
        409,
        RUBRIC_ERRORS.DRAFT_EXISTS,
        'A draft already exists. Open it to continue editing.',
      );
    }
    const [[next]] = (await conn.query(
      'SELECT COALESCE(MAX(version_no), 0) + 1 AS n FROM rubric_versions',
    )) as unknown as [RowDataPacket[]];
    const versionNo = Number(next!.n);
    const baseId = sourceVersionId ?? p.publishedId;
    const base = baseId == null ? null : await loadVersion(conn, baseId);
    if (sourceVersionId != null && (!base || base.status === 'draft'))
      throw new RuleError(
        400,
        RUBRIC_ERRORS.RUBRIC_INVALID,
        'Restore requires an existing published or historical version.',
      );
    const [inserted] = await conn.query<ResultSetHeader>(
      `INSERT INTO rubric_versions (version_no, title, based_on_version_id, created_by, updated_by)
       VALUES (?, '', ?, ?, ?)`,
      [versionNo, base?.id ?? null, actor.id, actor.id],
    );
    const content = base ? contentOf(base) : defaultRubricContent();
    // A restored version is a NEW editable format. Original versions and evaluations stay untouched.
    content.scoringFormat = 2;
    for (const section of content.sections) {
      delete section.id;
      for (const criterion of section.criteria) delete criterion.id;
    }
    await writeVersionFields(conn, inserted.insertId, content, actor);
    await writeStructure(conn, inserted.insertId, content);
    await conn.query('UPDATE rubric SET draft_version_id = ? WHERE id = 1', [inserted.insertId]);
    await writeAudit(conn, {
      actorId: actor.id,
      actorEmail: actor.email,
      action: 'rubric.draft_created',
      entityType: 'rubric',
      entityId: versionNo,
      ipAddress: actor.ip,
      details: { version_no: versionNo, based_on_version_no: base?.versionNo ?? null },
    });
    return getAdminRubric(conn);
  });
}

export function saveDraft(pool: Pool, actor: Actor, revision: number, content: RubricContent) {
  const { save } = validateRubric(content);
  if (save.length) throw invalid(save, false);
  return inTransaction(pool, async (conn) => {
    const { draftId, versionNo } = await lockDraft(conn, revision);
    await writeVersionFields(conn, draftId, content, actor);
    await writeStructure(conn, draftId, content);
    await writeAudit(conn, {
      actorId: actor.id,
      actorEmail: actor.email,
      action: 'rubric.draft_saved',
      entityType: 'rubric',
      entityId: versionNo,
      ipAddress: actor.ip,
      details: { version_no: versionNo, revision: revision + 1, ...summary(content) },
    });
    return (await loadVersion(conn, draftId))!;
  });
}

export function discardDraft(pool: Pool, actor: Actor, revision: number) {
  return inTransaction(pool, async (conn) => {
    const { draftId, versionNo } = await lockDraft(conn, revision);
    await conn.query('UPDATE rubric SET draft_version_id = NULL WHERE id = 1');
    // Drafts are never used by evaluations, so nothing else refers to them.
    await conn.query("DELETE FROM rubric_versions WHERE id = ? AND status = 'draft'", [draftId]);
    await writeAudit(conn, {
      actorId: actor.id,
      actorEmail: actor.email,
      action: 'rubric.draft_discarded',
      entityType: 'rubric',
      entityId: versionNo,
      ipAddress: actor.ip,
      details: { version_no: versionNo },
    });
    return getAdminRubric(conn);
  });
}

/**
 * Publishes the draft in one transaction: the previous version is retired
 * (kept, read-only, still linked to its evaluations) and the draft becomes the
 * version judges use. The rubric row lock serialises concurrent attempts.
 */
export function publishDraft(pool: Pool, actor: Actor, revision: number, confirmExisting: boolean) {
  return inTransaction(pool, async (conn) => {
    const { draftId, publishedId, versionNo } = await lockDraft(conn, revision);
    const draft = (await loadVersion(conn, draftId))!;
    const content = contentOf(draft);
    const { save, publish } = validateRubric(content);
    if (save.length || publish.length) throw invalid([...save, ...publish], true);

    const counts = await evaluationCounts(conn, publishedId);
    if (publishedId != null && counts.onPublished > 0 && !confirmExisting) {
      throw new RuleError(
        409,
        RUBRIC_ERRORS.EVALUATIONS_EXIST,
        `${counts.onPublished} evaluation${counts.onPublished === 1 ? ' uses' : 's use'} the current rubric. Confirm to publish the new version.`,
        { evaluations: counts },
      );
    }

    let previousNo: number | null = null;
    let previousWeights: (number | null)[] | null = null;
    if (publishedId != null) {
      const previous = (await loadVersion(conn, publishedId))!;
      previousNo = previous.versionNo;
      previousWeights = previous.sections.map((s) => s.weightPercent);
      await conn.query(
        "UPDATE rubric_versions SET status = 'retired', retired_at = NOW() WHERE id = ? AND status = 'published'",
        [publishedId],
      );
    }
    await conn.query(
      "UPDATE rubric_versions SET status = 'published', published_at = NOW(), published_by = ? WHERE id = ? AND status = 'draft'",
      [actor.id, draftId],
    );
    await conn.query(
      'UPDATE rubric SET published_version_id = ?, draft_version_id = NULL WHERE id = 1',
      [draftId],
    );
    await writeAudit(conn, {
      actorId: actor.id,
      actorEmail: actor.email,
      action: 'rubric.published',
      entityType: 'rubric',
      entityId: versionNo,
      ipAddress: actor.ip,
      details: {
        version_no: versionNo,
        previous_version_no: previousNo,
        previous_weights: previousWeights,
        evaluations_on_previous: counts.onPublished,
        submitted_on_previous: counts.submittedOnPublished,
        ...summary(content),
      },
    });
    return { versionNo, published: (await loadVersion(conn, draftId))! };
  });
}
