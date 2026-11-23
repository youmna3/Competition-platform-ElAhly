/**
 * Versioned rubric types, scoring, the scoring formula and
 * the validation rules. Shared by the server (which enforces and recomputes)
 * and the browser (which shows the same results and messages live).
 *
 * Legacy format 1 retains exactly 4 Actual sections × 2 required criteria.
 * Format 2 permits 1–10 Actual/Bonus sections with two 1–5 star criteria each.
 * Actual weights total 100; optional Bonus uses explicitly configured points.
 *
 *   section rating = (rating 1 + rating 2) / 2
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

/** Everything the admin configures. Always 4 sections of 2 criteria, in order. */
export interface RubricContent {
  /** Absent/1: immutable legacy four-section scoring. 2: dynamic Actual + optional Bonus. */
  scoringFormat?: 1 | 2;
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
 * A brand-new rubric: the fixed shape with neutral placeholder names and no
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

/** Sum of the section weights that are set. */
export function totalWeight(sections: ScoringSection[]): number {
  return sections.reduce((sum, s) => sum + (s.type === 'bonus' ? 0 : (s.weightPercent ?? 0)), 0);
}

export type ScoringSection = Pick<RubricSectionInput, 'weightPercent' | 'type' | 'maxBonusPoints'>;
export const sectionMaximum = (s: ScoringSection) =>
  s.type === 'bonus' ? (s.maxBonusPoints ?? 0) : (s.weightPercent ?? 0);
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
  /** Out of 100; null until every criterion is rated. */
  total: number | null;
}

/**
 * Scores one evaluation. `ratings[i][j]` is the star rating (1–5) for
 * criterion j of section i, or null if it isn't rated yet.
 */
export function scoreEvaluation(
  sections: ScoringSection[],
  ratings: (number | null)[][],
): ScoreBreakdown {
  const result = sections.map((s, i) => {
    const r = ratings[i] ?? [];
    const weightPercent = sectionMaximum(s);
    if (s.type === 'bonus' && r.length === 2 && r.every((v) => v == null))
      return { rating: null, score: 0, weightPercent };
    const complete = r.length === RUBRIC_SHAPE.criteriaPerSection && r.every(isStarRating);
    return complete
      ? {
          rating: sectionRating(r as number[]),
          score: sectionScore(r as number[], weightPercent),
          weightPercent,
        }
      : { rating: null, score: null, weightPercent };
  });
  const total = result.every((s) => s.score != null)
    ? Math.round(result.reduce((sum, s) => sum + (s.score ?? 0), 0) * 1000) / 1000
    : null;
  const sumType = (bonus: boolean) =>
    Math.round(
      result.reduce(
        (sum, s, i) => sum + ((sections[i]?.type === 'bonus') === bonus ? (s.score ?? 0) : 0),
        0,
      ) * 1000,
    ) / 1000;
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
  if (rubric.scoringFormat === 2 && (rubric.sections.length < 1 || rubric.sections.length > 10))
    save.push({ path: 'sections', message: 'Use between 1 and 10 sections.' });
  if (!rubric.sections.some((s) => s.type !== 'bonus'))
    publish.push({ path: 'weights', message: 'At least one Actual section is required.' });
  let weightValuesOk = true;
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
    if (s.type === 'bonus') {
      if (rubric.scoringFormat !== 2)
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
    if (s.criteria.length !== RUBRIC_SHAPE.criteriaPerSection) {
      save.push({
        path: `${path}.criteria`,
        message: `${name} must have exactly ${RUBRIC_SHAPE.criteriaPerSection} criteria.`,
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
    });
  });

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
