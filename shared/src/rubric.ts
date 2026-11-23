/**
 * Versioned rubric types, scoring and validation rules. Shared by the server (which enforces and recomputes)
 * and the browser (which shows the same results and messages live).
 *
 * Legacy format 1 retains exactly 4 Actual sections × 2 required criteria.
 * Format 2 permits 1–10 Actual/Bonus sections with two 1–5 star criteria each.
 * Format 3 permits 1-10 equal questions per section. Actual weights total 100;
 * optional Bonus uses explicitly configured points.
 *
 *   section rating = sum of star ratings / question count
 *   section score  = section rating / 5 × section weight
 *   combined score = Actual section sum + awarded Bonus, without a cap at 100
 */

/** Rubric states shown to admins. Mirrors the database view v_rubric_status. */
export type RubricState = 'not_configured' | 'draft_only' | 'published' | 'published_with_draft';

export const RUBRIC_STATE_LABELS: Record<RubricState, string> = {
  not_configured: 'Not configured',
  draft_only: 'Draft (not published)',
  published: 'Published',
  published_with_draft: 'Published, with unpublished changes',
};

export const RUBRIC_SHAPE = {
  sections: 4,
  criteriaPerSection: 2,
  minStars: 1,
  maxStars: 5,
  totalWeight: 100,
  maxScore: 100,
} as const;

export type ScoringFormat = 1 | 2 | 3 | 4;
export const POINTS_FORMAT = 4;
export const POINTS_LIMITS = { sections: 10, criteriaPerSection: 10, maxPoints: 100 } as const;
export const isPointsRubric = (r: { scoringFormat?: number | null }) =>
  r.scoringFormat === POINTS_FORMAT;

export const RUBRIC_LIMITS = {
  title: 200,
  description: 5000,
  instructions: 10000,
  sectionTitle: 200,
  sectionDescription: 2000,
  criterionTitle: 300,
  criterionDescription: 2000,
  guidelines: 4000,
} as const;

// ---------------------------------------------------------------------------
// Shapes
// ---------------------------------------------------------------------------

export interface RubricCriterionInput {
  id?: number;
  title: string;
  description: string;
  /** What judges should look for, optional. */
  guidelines: string;
  /** Points rubrics (scoring format 4) only: the criterion's maximum, 1–100 whole points. */
  maxPoints?: number | null;
}

export interface RubricSectionInput {
  id?: number;
  type?: 'actual' | 'bonus';
  maxBonusPoints?: number | null;
  title: string;
  description: string;
  /** Whole-number percentage of the final score, 1–100; null until the admin sets it. */
  weightPercent: number | null;
  criteria: RubricCriterionInput[];
}

/** Versioned configuration; array order defines section and question order. */
export interface RubricContent {
  /**
   * Absent/1: legacy four-section stars. 2: Actual + optional Bonus stars.
   * 3: 1–10 equal star questions per section. 4: numeric points (0 to each
   * criterion's maximum; a section's points are the sum of its criteria).
   */
  scoringFormat?: ScoringFormat;
  title: string;
  description: string;
  instructions: string;
  sections: RubricSectionInput[];
}

export interface RubricCriterion extends RubricCriterionInput {
  id: number;
}

export interface RubricSection extends Omit<RubricSectionInput, 'criteria'> {
  id: number;
  criteria: RubricCriterion[];
}

export type RubricVersionStatus = 'draft' | 'published' | 'retired';

/** A stored version, as the API returns it. */
export interface RubricVersion extends Omit<RubricContent, 'sections'> {
  id: number;
  versionNo: number;
  status: RubricVersionStatus;
  /** Increases on every save; a save must name the revision it started from. */
  revision: number;
  createdAt: string;
  updatedAt: string;
  updatedByEmail: string | null;
  publishedAt: string | null;
  publishedByEmail: string | null;
  sections: RubricSection[];
}

export interface RubricEvaluationCounts {
  total: number;
  submitted: number;
  /** Evaluations on the currently published version. */
  onPublished: number;
  submittedOnPublished: number;
  /** Version numbers that have submitted evaluations, ascending. */
  submittedVersions: number[];
}

/** GET /api/admin/rubric */
export interface AdminRubricResponse {
  versions?: RubricVersion[];
  state: RubricState;
  published: RubricVersion | null;
  draft: RubricVersion | null;
  evaluations: RubricEvaluationCounts;
}

/** GET /api/judge/rubric (judges and admins) */
export interface PublishedRubricResponse {
  rubric: RubricVersion | null;
}

export interface SaveRubricDraftRequest {
  revision: number;
  content: RubricContent;
}

export interface PublishRubricRequest {
  revision: number;
  /** Needed when evaluations already exist on the published version. */
  confirmExistingEvaluations?: boolean;
}

export interface PublishRubricResponse {
  versionNo: number;
  published: RubricVersion;
}

export const RUBRIC_ERRORS = {
  NO_DRAFT: 'NO_DRAFT',
  DRAFT_EXISTS: 'DRAFT_EXISTS',
  REVISION_CONFLICT: 'REVISION_CONFLICT',
  RUBRIC_INVALID: 'RUBRIC_INVALID',
  EVALUATIONS_EXIST: 'EVALUATIONS_EXIST',
} as const;

/**
 * A starter rubric: four sections with two placeholder questions each and no
 * weights. Nothing about the competition's criteria is invented.
 */
export function defaultRubricContent(): RubricContent {
  return {
    title: '',
    description: '',
    instructions: '',
    sections: Array.from({ length: RUBRIC_SHAPE.sections }, (_, i) => ({
      title: `Section ${i + 1}`,
      description: '',
      weightPercent: null,
      criteria: Array.from({ length: RUBRIC_SHAPE.criteriaPerSection }, (_, j) => ({
        title: `Criterion ${j + 1}`,
        description: '',
        guidelines: '',
      })),
    })),
  };
}

/** The editable content of a stored version (ids dropped). */
export function contentOf(version: RubricVersion): RubricContent {
  return {
    scoringFormat: version.scoringFormat ?? 1,
    title: version.title,
    description: version.description,
    instructions: version.instructions,
    sections: version.sections.map(({ criteria, ...s }) => ({
      ...s,
      criteria: criteria.map((c) => ({ ...c })),
    })),
  };
}

// ---------------------------------------------------------------------------
// Scoring (the server recomputes with these same functions)
// ---------------------------------------------------------------------------

export const isStarRating = (n: unknown): n is number =>
  typeof n === 'number' &&
  Number.isInteger(n) &&
  n >= RUBRIC_SHAPE.minStars &&
  n <= RUBRIC_SHAPE.maxStars;

/** A whole number of points from 0 to `max`. */
export const isPointScore = (n: unknown, max: number): n is number =>
  typeof n === 'number' && Number.isInteger(n) && n >= 0 && n <= max;

/**
 * The criterion maxima of a points section, or null for a star section. A
 * section is points-based when every criterion carries a numeric maxPoints.
 */
export function pointMaxima(s: { criteria?: readonly unknown[] }): number[] | null {
  const list = s.criteria;
  if (!list || list.length === 0) return null;
  const maxima = list.map((c) =>
    c != null &&
    typeof c === 'object' &&
    typeof (c as { maxPoints?: unknown }).maxPoints === 'number'
      ? (c as { maxPoints: number }).maxPoints
      : null,
  );
  return maxima.every((m) => m != null && m > 0) ? (maxima as number[]) : null;
}

/** Valid input for one criterion: points 0..max for points criteria, otherwise 1–5 stars. */
export function isValidRating(criterion: { maxPoints?: number | null }, value: unknown) {
  return typeof criterion.maxPoints === 'number'
    ? isPointScore(value, criterion.maxPoints)
    : isStarRating(value);
}

/** Points of a points section: the sum of its criterion maxima. */
export const sectionPoints = (s: { criteria: readonly { maxPoints?: number | null }[] }) =>
  s.criteria.reduce((sum, c) => sum + (c.maxPoints ?? 0), 0);

/** Sum of the section weights that are set. */
export function totalWeight(sections: ScoringSection[]): number {
  return sections.reduce((sum, s) => sum + (s.type === 'bonus' ? 0 : (s.weightPercent ?? 0)), 0);
}

export type ScoringSection = Pick<
  RubricSectionInput,
  'weightPercent' | 'type' | 'maxBonusPoints'
> & { criteria?: readonly unknown[] };
export const sectionMaximum = (s: ScoringSection) => {
  const maxima = pointMaxima(s);
  if (maxima) return maxima.reduce((a, b) => a + b, 0);
  return s.type === 'bonus' ? (s.maxBonusPoints ?? 0) : (s.weightPercent ?? 0);
};
export const maximumScore = (sections: ScoringSection[]) =>
  100 + sections.reduce((sum, s) => sum + (s.type === 'bonus' ? (s.maxBonusPoints ?? 0) : 0), 0);

/** Average of a section's star ratings. */
export function sectionRating(ratings: readonly number[]): number {
  return ratings.reduce((a, b) => a + b, 0) / ratings.length;
}

/**
 * A section's contribution to the final score: rating / 5 × weight.
 * Computed from integers and divided once, so 4★ + 5★ at 30% is exactly 27.
 */
export function sectionScore(ratings: readonly number[], weightPercent: number): number {
  const sum = ratings.reduce((a, b) => a + b, 0);
  return (
    Math.round(((sum * weightPercent) / (ratings.length * RUBRIC_SHAPE.maxStars)) * 1000) / 1000
  );
}

export interface ScoreBreakdown {
  base: number | null;
  bonus: number | null;
  maximum: number;
  /** Per section, in order; rating and score are null while a rating is missing. */
  sections: { rating: number | null; score: number | null; weightPercent: number }[];
  /** Combined points; null until Actual and started Bonus sections are complete. */
  total: number | null;
}

/**
 * Scores one evaluation. `ratings[i][j]` is the value for criterion j of
 * section i (1–5 stars, or 0..max points for points sections), or null if it
 * isn't scored yet.
 */
export function scoreEvaluation(
  sections: ScoringSection[],
  ratings: (number | null)[][],
): ScoreBreakdown {
  const variable = sections.some((s) => s.criteria != null && s.criteria.length !== 2);
  const round = (n: number) => (variable ? n : Math.round(n * 1000) / 1000);
  const result = sections.map((s, i) => {
    const r = ratings[i] ?? [];
    const weightPercent = sectionMaximum(s);
    const maxima = pointMaxima(s);
    if (maxima) {
      // Points: the section is the plain sum of its criteria, complete once all are scored.
      const complete = r.length === maxima.length && r.every((v, j) => isPointScore(v, maxima[j]!));
      return complete
        ? {
            rating: null,
            score: (r as number[]).reduce((sum, v) => sum + v, 0),
            weightPercent,
          }
        : { rating: null, score: null, weightPercent };
    }
    const count = s.criteria?.length ?? 2;
    if (s.type === 'bonus' && count > 0 && r.length === count && r.every((v) => v == null))
      return { rating: null, score: 0, weightPercent };
    const complete = count >= 1 && count <= 10 && r.length === count && r.every(isStarRating);
    return complete
      ? {
          rating: sectionRating(r as number[]),
          score: round(
            (r.reduce<number>((sum, v) => sum + (v ?? 0), 0) * weightPercent) / (count * 5),
          ),
          weightPercent,
        }
      : { rating: null, score: null, weightPercent };
  });
  const total = result.every((s) => s.score != null)
    ? round(result.reduce((sum, s) => sum + (s.score ?? 0), 0))
    : null;
  const sumType = (bonus: boolean) =>
    round(
      result.reduce(
        (sum, s, i) => sum + ((sections[i]?.type === 'bonus') === bonus ? (s.score ?? 0) : 0),
        0,
      ),
    );
  return {
    sections: result,
    total,
    // Live subtotals include completed sections; only the combined total signals completeness.
    base: sumType(false),
    bonus: sumType(true),
    maximum: maximumScore(sections),
  };
}

/** Points for display: up to 2 decimals, no trailing zeros. */
export function formatPoints(value: number): string {
  return String(Math.round(value * 100) / 100);
}

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

export interface RubricIssue {
  /** Dotted path of the field, e.g. "sections.1.criteria.0.title". */
  path: string;
  message: string;
}

export interface RubricValidation {
  /** Problems that stop the draft from being saved at all. */
  save: RubricIssue[];
  /** Problems that stop the draft from being published. */
  publish: RubricIssue[];
}

const sectionName = (s: { title: string }, i: number) =>
  `Section ${i + 1}${s.title.trim() ? ` “${s.title.trim()}”` : ''}`;

function checkLength(
  issues: RubricIssue[],
  path: string,
  label: string,
  value: string,
  max: number,
) {
  if (value.length > max)
    issues.push({ path, message: `${label} can be at most ${max} characters.` });
}

/**
 * Checks a rubric. `save` issues make the content impossible to store;
 * `publish` issues are what is still needed before judges can use it.
 */
export function validateRubric(rubric: RubricContent): RubricValidation {
  const save: RubricIssue[] = [];
  const publish: RubricIssue[] = [];
  const L = RUBRIC_LIMITS;

  checkLength(save, 'title', 'The rubric title', rubric.title, L.title);
  checkLength(save, 'description', 'The description', rubric.description, L.description);
  checkLength(
    save,
    'instructions',
    'The judging instructions',
    rubric.instructions,
    L.instructions,
  );
  if (!rubric.title.trim()) publish.push({ path: 'title', message: 'Give the rubric a title.' });

  if ((rubric.scoringFormat ?? 1) === 1 && rubric.sections.length !== RUBRIC_SHAPE.sections) {
    save.push({
      path: 'sections',
      message: `The rubric must have exactly ${RUBRIC_SHAPE.sections} sections.`,
    });
  }
  if (
    (rubric.scoringFormat ?? 1) >= 2 &&
    (rubric.sections.length < 1 || rubric.sections.length > 10)
  )
    save.push({ path: 'sections', message: 'Use between 1 and 10 sections.' });
  if (!rubric.sections.some((s) => s.type !== 'bonus'))
    publish.push({ path: 'weights', message: 'At least one Actual section is required.' });
  const points = isPointsRubric(rubric);
  let weightValuesOk = true;
  let maximaComplete = true;
  rubric.sections.forEach((s, i) => {
    const path = `sections.${i}`;
    const name = sectionName(s, i);
    if (!s.title.trim())
      save.push({ path: `${path}.title`, message: `Section ${i + 1} needs a title.` });
    checkLength(save, `${path}.title`, `The title of ${name}`, s.title, L.sectionTitle);
    checkLength(
      save,
      `${path}.description`,
      `The description of ${name}`,
      s.description,
      L.sectionDescription,
    );
    if (points) {
      if (s.type === 'bonus')
        save.push({ path, message: `${name}: points rubrics have no bonus sections.` });
      if (s.maxBonusPoints != null)
        save.push({
          path: `${path}.maxBonusPoints`,
          message: 'Points rubrics have no bonus points.',
        });
    } else if (s.type === 'bonus') {
      if ((rubric.scoringFormat ?? 1) < 2)
        save.push({ path, message: 'Bonus sections require scoring format 2.' });
      if (s.weightPercent != null)
        save.push({
          path: `${path}.weightPercent`,
          message: 'Bonus sections cannot have an Actual weight.',
        });
      if (
        s.maxBonusPoints == null ||
        !Number.isInteger(s.maxBonusPoints) ||
        s.maxBonusPoints < 1 ||
        s.maxBonusPoints > 100
      )
        (s.maxBonusPoints == null ? publish : save).push({
          path: `${path}.maxBonusPoints`,
          message: 'Set a maximum bonus from 1 to 100 whole points.',
        });
    } else if (s.maxBonusPoints != null) {
      save.push({
        path: `${path}.maxBonusPoints`,
        message: 'Actual sections cannot have bonus points.',
      });
    } else if (s.weightPercent == null) {
      publish.push({ path: `${path}.weightPercent`, message: `Set the weight of ${name}.` });
    } else if (
      typeof s.weightPercent !== 'number' ||
      !Number.isInteger(s.weightPercent) ||
      s.weightPercent < 1 ||
      s.weightPercent > 100
    ) {
      weightValuesOk = false;
      save.push({
        path: `${path}.weightPercent`,
        message: `The weight of ${name} must be a whole number from 1 to 100.`,
      });
    }
    const variable = rubric.scoringFormat === 3 || points;
    if (
      variable
        ? s.criteria.length < 1 || s.criteria.length > 10
        : s.criteria.length !== RUBRIC_SHAPE.criteriaPerSection
    ) {
      save.push({
        path: `${path}.criteria`,
        message: variable
          ? `${name} must have 1 to 10 criteria.`
          : `${name} must have exactly ${RUBRIC_SHAPE.criteriaPerSection} criteria.`,
      });
    }
    s.criteria.forEach((c, j) => {
      const cpath = `${path}.criteria.${j}`;
      const cname = `${name}, criterion ${j + 1}`;
      if (!c.title.trim())
        save.push({ path: `${cpath}.title`, message: `${cname} needs a title.` });
      checkLength(save, `${cpath}.title`, `The title of ${cname}`, c.title, L.criterionTitle);
      checkLength(
        save,
        `${cpath}.description`,
        `The description of ${cname}`,
        c.description,
        L.criterionDescription,
      );
      checkLength(
        save,
        `${cpath}.guidelines`,
        `The guidelines of ${cname}`,
        c.guidelines,
        L.guidelines,
      );
      if (points) {
        if (c.maxPoints == null) {
          maximaComplete = false;
          save.push({
            path: `${cpath}.maxPoints`,
            message: `Set the maximum points of ${cname}.`,
          });
        } else if (
          typeof c.maxPoints !== 'number' ||
          !Number.isInteger(c.maxPoints) ||
          c.maxPoints < 1 ||
          c.maxPoints > POINTS_LIMITS.maxPoints
        ) {
          maximaComplete = false;
          save.push({
            path: `${cpath}.maxPoints`,
            message: `The maximum points of ${cname} must be a whole number from 1 to ${POINTS_LIMITS.maxPoints}.`,
          });
        }
      } else if (c.maxPoints != null) {
        save.push({
          path: `${cpath}.maxPoints`,
          message: 'Maximum points apply only to points rubrics.',
        });
      }
    });
    if (points) {
      const total = s.criteria.reduce((n, c) => n + (c.maxPoints ?? 0), 0);
      if (total > POINTS_LIMITS.maxPoints)
        save.push({
          path: `${path}.criteria`,
          message: `${name} totals ${total} points; a section can have at most ${POINTS_LIMITS.maxPoints}.`,
        });
    }
  });

  if (points) {
    const totalPoints = rubric.sections.reduce(
      (sum, sec) => sum + sec.criteria.reduce((n, c) => n + (c.maxPoints ?? 0), 0),
      0,
    );
    if (rubric.sections.length > 0 && maximaComplete && totalPoints !== RUBRIC_SHAPE.maxScore)
      publish.push({
        path: 'weights',
        message: `The criteria total ${totalPoints} points. They must total exactly ${RUBRIC_SHAPE.maxScore}.`,
      });
    return { save, publish };
  }

  const allSet =
    rubric.sections.length > 0 &&
    rubric.sections.every((s) => s.type === 'bonus' || s.weightPercent != null);
  const total = totalWeight(rubric.sections);
  if (allSet && weightValuesOk && total !== RUBRIC_SHAPE.totalWeight) {
    publish.push({
      path: 'weights',
      message: `The section weights total ${total}%. They must total exactly 100%.`,
    });
  }

  return { save, publish };
}
