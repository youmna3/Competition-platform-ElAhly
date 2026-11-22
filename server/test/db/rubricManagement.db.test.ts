/**
 * Phase 5: Rubric Management through the real API and a real (scratch) MySQL
 * database. Drafts, editing, validation, publishing, versions, history,
 * access control, administrators as judges, audit and concurrency.
 */
import bcrypt from 'bcryptjs';
import mysql, { type Pool, type RowDataPacket } from 'mysql2/promise';
import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { RubricContent, RubricVersion } from '@judging/shared';
import {
  dropDatabase,
  expectRefused,
  freshTestDatabase,
  scalar,
  TEST_DB,
  testTarget,
} from './helpers.js';
import { makeTestApp, signIn } from './appHelpers.js';

const ADMIN = { email: 'youmna54@gmail.com', password: 'Admin-Password-2026!' };
const ADMIN2 = { email: 'second.admin@example.com', password: 'Admin-Password-2026!' };
const JUDGE = { email: 'judge@example.com', password: 'Judge-Password-2026!' };

let pool: Pool;
let app: ReturnType<typeof makeTestApp>;
let admin: Awaited<ReturnType<typeof signIn>>;
let adminId: number;
let judgeId: number;

async function insertUser(
  email: string,
  fullName: string,
  role: 'admin' | 'judge',
  password: string,
) {
  const [r] = await pool.query(
    'INSERT INTO users (email, full_name, password_hash, role, must_change_password) VALUES (?, ?, ?, ?, FALSE)',
    [email, fullName, bcrypt.hashSync(password, 4), role],
  );
  return (r as { insertId: number }).insertId;
}

/** A complete, publishable rubric. Nothing about it is assumed by the app. */
function validContent(
  overrides: Partial<RubricContent> = {},
  weights: (number | null)[] = [30, 30, 20, 20],
): RubricContent {
  const names = ['Idea', 'Execution', 'Presentation', 'Teamwork'];
  return {
    title: 'Final judging rubric',
    description: 'Used for every team.',
    instructions: 'Rate each criterion from 1 to 5 stars.',
    sections: names.map((name, i) => ({
      title: name,
      description: `About ${name.toLowerCase()}`,
      weightPercent: weights[i] ?? null,
      criteria: [
        { title: `${name} A`, description: 'What it means', guidelines: '5 = outstanding' },
        { title: `${name} B`, description: '', guidelines: '' },
      ],
    })),
    ...overrides,
  };
}

async function state() {
  const res = await admin.get('/api/admin/rubric');
  expect(res.status).toBe(200);
  return res.body as {
    state: string;
    published: RubricVersion | null;
    draft: RubricVersion | null;
    evaluations: { onPublished: number; submittedVersions: number[] };
  };
}

async function startDraft() {
  const res = await admin.post('/api/admin/rubric/draft').send({});
  expect(res.status, JSON.stringify(res.body)).toBe(201);
  return res.body.draft as RubricVersion;
}

async function saveContent(revision: number, content: RubricContent) {
  return admin.put('/api/admin/rubric/draft').send({ revision, content });
}

async function publishContent(content = validContent()) {
  const draft = (await state()).draft ?? (await startDraft());
  const saved = await saveContent(draft.revision, content);
  expect(saved.status, JSON.stringify(saved.body)).toBe(200);
  const res = await admin
    .post('/api/admin/rubric/draft/publish')
    .send({ revision: saved.body.draft.revision });
  expect(res.status, JSON.stringify(res.body)).toBe(200);
  return res.body.published as RubricVersion;
}

/** Latest audit details for an action (MariaDB returns JSON columns as text). */
async function auditDetails(action: string) {
  const [rows] = await pool.query<RowDataPacket[]>(
    'SELECT details FROM audit_log WHERE action = ? ORDER BY id DESC LIMIT 1',
    [action],
  );
  const d = rows[0]?.details;
  return typeof d === 'string' ? JSON.parse(d) : d;
}

const auditActions = async () => {
  const [rows] = await pool.query('SELECT action FROM audit_log ORDER BY id');
  return (rows as { action: string }[]).map((r) => r.action);
};

/** The content part of a version, for comparing with what was saved. */
const strip = (v: RubricVersion) => ({
  title: v.title,
  description: v.description,
  instructions: v.instructions,
  sections: v.sections.map(({ id: _i, criteria, ...s }) => ({
    ...s,
    criteria: criteria.map(({ id: _c, ...c }) => c),
  })),
});

beforeAll(async () => {
  await freshTestDatabase();
  pool = mysql.createPool({ ...testTarget, connectionLimit: 10 });
  app = makeTestApp(pool);
});

beforeEach(async () => {
  // TRUNCATE bypasses the history-protecting triggers. Test cleanup only.
  await pool.query('SET FOREIGN_KEY_CHECKS = 0');
  for (const t of [
    'evaluation_section_notes',
    'evaluation_scores',
    'evaluations',
    'team_judges',
    'teams',
    'rubric_scale_levels',
    'rubric_criteria',
    'rubric_sections',
    'rubric_versions',
    'sessions',
    'users',
    'audit_log',
  ]) {
    await pool.query(`TRUNCATE TABLE ${t}`);
  }
  await pool.query('SET FOREIGN_KEY_CHECKS = 1');
  // The rubric row's update trigger refuses unpublishing; reset it directly for each test.
  await pool.query('DROP TRIGGER IF EXISTS trg_rubric_before_update');
  await pool.query(
    'UPDATE rubric SET published_version_id = NULL, draft_version_id = NULL WHERE id = 1',
  );
  await pool.query(`CREATE TRIGGER trg_rubric_before_update BEFORE UPDATE ON rubric FOR EACH ROW
    BEGIN
      IF NEW.published_version_id IS NOT NULL
         AND (SELECT status FROM rubric_versions WHERE id = NEW.published_version_id) <> 'published' THEN
        SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'The active rubric must point at a published version';
      END IF;
      IF NEW.draft_version_id IS NOT NULL
         AND (SELECT status FROM rubric_versions WHERE id = NEW.draft_version_id) <> 'draft' THEN
        SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'The rubric draft must point at a draft version';
      END IF;
      IF OLD.published_version_id IS NOT NULL AND NEW.published_version_id IS NULL THEN
        SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'A published rubric cannot be unpublished';
      END IF;
    END`);
  adminId = await insertUser(ADMIN.email, 'Youmna Admin', 'admin', ADMIN.password);
  await insertUser(ADMIN2.email, 'Second Admin', 'admin', ADMIN2.password);
  judgeId = await insertUser(JUDGE.email, 'Judge One', 'judge', JUDGE.password);
  admin = await signIn(app, ADMIN.email, ADMIN.password);
});

afterAll(async () => {
  await pool.end();
  await dropDatabase(TEST_DB);
});

describe('access control', () => {
  const adminEndpoints = [
    ['get', '/api/admin/rubric'],
    ['post', '/api/admin/rubric/draft'],
    ['put', '/api/admin/rubric/draft'],
    ['delete', '/api/admin/rubric/draft'],
    ['post', '/api/admin/rubric/draft/publish'],
  ] as const;

  it('requires a session for every rubric endpoint', async () => {
    for (const [method, path] of [...adminEndpoints, ['get', '/api/judge/rubric'] as const]) {
      expect((await request(app)[method](path).send({})).status, `${method} ${path}`).toBe(401);
    }
  });

  it('refuses every management endpoint to judges, who can only read the published rubric', async () => {
    await publishContent();
    const judge = await signIn(app, JUDGE.email, JUDGE.password);
    for (const [method, path] of adminEndpoints) {
      const res = await judge[method](path).send({ revision: 1, content: validContent() });
      expect(res.status, `${method} ${path}`).toBe(403);
    }
    expect(await scalar<number>(pool, 'SELECT COUNT(*) FROM rubric_versions')).toBe(1);
    const view = await judge.get('/api/judge/rubric');
    expect(view.status).toBe(200);
    expect(view.body.rubric.title).toBe('Final judging rubric');
  });
});

describe('not configured', () => {
  it('starts with no rubric and tells judges nothing is published', async () => {
    const s = await state();
    expect(s).toMatchObject({ state: 'not_configured', published: null, draft: null });
    const judge = await signIn(app, JUDGE.email, JUDGE.password);
    expect((await judge.get('/api/judge/rubric')).body).toEqual({ rubric: null });
  });
});

describe('drafts', () => {
  it('creates a draft in the fixed shape: 4 sections of 2 criteria, neutral names, no weights', async () => {
    const draft = await startDraft();
    expect(draft).toMatchObject({ versionNo: 1, status: 'draft', title: '' });
    expect(
      draft.sections.map((s) => [s.title, s.weightPercent, s.criteria.map((c) => c.title)]),
    ).toEqual([
      ['Section 1', null, ['Criterion 1', 'Criterion 2']],
      ['Section 2', null, ['Criterion 1', 'Criterion 2']],
      ['Section 3', null, ['Criterion 1', 'Criterion 2']],
      ['Section 4', null, ['Criterion 1', 'Criterion 2']],
    ]);
    expect((await state()).state).toBe('draft_only');
    const again = await admin.post('/api/admin/rubric/draft').send({});
    expect(again.status).toBe(409);
    expect(again.body.error.code).toBe('DRAFT_EXISTS');
    expect(await auditActions()).toContain('rubric.draft_created');
  });

  it('saves titles, descriptions, guidelines, instructions and section weights', async () => {
    const draft = await startDraft();
    const content = validContent();
    const res = await saveContent(draft.revision, content);
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body.draft.revision).toBe(draft.revision + 1);
    expect(strip(res.body.draft)).toEqual(content);
    expect(strip((await state()).draft!)).toEqual(content);
    expect(await auditDetails('rubric.draft_saved')).toMatchObject({
      weight_total: 100,
      sections: [
        { title: 'Idea', weight_percent: 30 },
        { title: 'Execution', weight_percent: 30 },
        { title: 'Presentation', weight_percent: 20 },
        { title: 'Teamwork', weight_percent: 20 },
      ],
    });
  });

  it('stores every criterion as a required 1-5 star rating weighted by its section', async () => {
    const draft = await startDraft();
    await saveContent(draft.revision, validContent({}, [35, 25, 25, 15]));
    const [rows] = await pool.query<RowDataPacket[]>(
      `SELECT s.weight_percent, c.min_score, c.max_score, c.weight, c.is_required
       FROM rubric_criteria c JOIN rubric_sections s ON s.id = c.section_id ORDER BY s.position, c.position`,
    );
    expect(
      rows.map((r) => [
        r.weight_percent,
        r.min_score,
        r.max_score,
        Number(r.weight),
        r.is_required,
      ]),
    ).toEqual([
      [35, 1, 5, 3.5, 1],
      [35, 1, 5, 3.5, 1],
      [25, 1, 5, 2.5, 1],
      [25, 1, 5, 2.5, 1],
      [25, 1, 5, 2.5, 1],
      [25, 1, 5, 2.5, 1],
      [15, 1, 5, 1.5, 1],
      [15, 1, 5, 1.5, 1],
    ]);
  });

  it('keeps the shape fixed: no extra or missing sections or criteria', async () => {
    const draft = await startDraft();
    const five = validContent();
    five.sections.push({ ...five.sections[0]!, title: 'Extra' });
    const r1 = await saveContent(draft.revision, five);
    expect(r1.status).toBe(400);
    expect(r1.body.issues[0].message).toMatch(/exactly 4 sections/);

    const three = validContent();
    three.sections[1]!.criteria.push({ title: 'Third', description: '', guidelines: '' });
    const r2 = await saveContent(draft.revision, three);
    expect(r2.status).toBe(400);
    expect(r2.body.issues[0]).toEqual({
      path: 'sections.1.criteria',
      message: 'Section 2 “Execution” must have exactly 2 criteria.',
    });
    expect((await state()).draft!.revision).toBe(draft.revision);
  });

  it('refuses a save based on an old revision, so two editors never overwrite each other', async () => {
    const draft = await startDraft();
    await saveContent(draft.revision, validContent());
    const stale = await saveContent(draft.revision, validContent({ title: 'Overwrite' }));
    expect(stale.status).toBe(409);
    expect(stale.body.error.code).toBe('REVISION_CONFLICT');
    expect((await state()).draft!.title).toBe('Final judging rubric');
  });

  it('rejects invalid values with messages naming the exact field', async () => {
    const draft = await startDraft();
    const bad = validContent({}, [30, 0, 20.5, 20]);
    bad.sections[3]!.title = '  ';
    bad.sections[0]!.criteria[1]!.title = '';
    const res = await saveContent(draft.revision, bad);
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('RUBRIC_INVALID');
    expect(res.body.issues).toEqual(
      expect.arrayContaining([
        {
          path: 'sections.1.weightPercent',
          message: 'The weight of Section 2 “Execution” must be a whole number from 1 to 100.',
        },
        {
          path: 'sections.2.weightPercent',
          message: 'The weight of Section 3 “Presentation” must be a whole number from 1 to 100.',
        },
        { path: 'sections.3.title', message: 'Section 4 needs a title.' },
        {
          path: 'sections.0.criteria.1.title',
          message: 'Section 1 “Idea”, criterion 2 needs a title.',
        },
      ]),
    );
    expect((await state()).draft!.revision).toBe(draft.revision);
  });

  it('rejects unknown fields and wrong types, including any attempt to add bonus or score ranges', async () => {
    const draft = await startDraft();
    const bonus = validContent();
    (bonus as unknown as Record<string, unknown>).bonusEnabled = true;
    expect((await saveContent(draft.revision, bonus)).status).toBe(400);
    const range = validContent();
    (range.sections[0]!.criteria[0] as unknown as Record<string, unknown>).maxScore = 10;
    expect((await saveContent(draft.revision, range)).status).toBe(400);
    const text = validContent();
    (text.sections[0] as unknown as Record<string, unknown>).weightPercent = '30';
    expect((await saveContent(draft.revision, text)).status).toBe(400);
  });

  it('discards a draft without touching the published version', async () => {
    const published = await publishContent();
    const draft = await startDraft();
    await saveContent(draft.revision, validContent({ title: 'Changed' }));
    const current = (await state()).draft!;
    const res = await admin.delete('/api/admin/rubric/draft').send({ revision: current.revision });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ state: 'published', draft: null });
    expect(res.body.published.id).toBe(published.id);
    expect(res.body.published.title).toBe('Final judging rubric');
    expect(await auditActions()).toContain('rubric.draft_discarded');
  });
});

describe('publishing', () => {
  it('blocks publishing until the title and all weights are set and the weights total 100%', async () => {
    const draft = await startDraft();
    const publishRev = async (revision: number) =>
      admin.post('/api/admin/rubric/draft/publish').send({ revision });

    // The brand-new draft: no title, no weights.
    const r1 = await publishRev(draft.revision);
    expect(r1.status).toBe(400);
    expect(r1.body.error.code).toBe('RUBRIC_INVALID');
    expect(r1.body.issues.map((i: { path: string }) => i.path)).toEqual([
      'title',
      'sections.0.weightPercent',
      'sections.1.weightPercent',
      'sections.2.weightPercent',
      'sections.3.weightPercent',
    ]);

    // Weights total 110%.
    const saved = await saveContent(draft.revision, validContent({}, [35, 25, 25, 25]));
    expect(saved.status).toBe(200); // a draft may be incomplete
    const r2 = await publishRev(saved.body.draft.revision);
    expect(r2.status).toBe(400);
    expect(r2.body.issues).toEqual([
      { path: 'weights', message: 'The section weights total 110%. They must total exactly 100%.' },
    ]);
    expect((await state()).state).toBe('draft_only');
  });

  it('publishes a valid rubric, which judges can then read', async () => {
    const published = await publishContent(validContent({}, [35, 25, 25, 15]));
    expect(published).toMatchObject({
      versionNo: 1,
      status: 'published',
      publishedByEmail: ADMIN.email,
    });
    expect(await state()).toMatchObject({ state: 'published', draft: null });
    const judge = await signIn(app, JUDGE.email, JUDGE.password);
    const view = (await judge.get('/api/judge/rubric')).body.rubric as RubricVersion;
    expect(strip(view)).toEqual(validContent({}, [35, 25, 25, 15]));
    expect(await auditDetails('rubric.published')).toMatchObject({
      version_no: 1,
      previous_version_no: null,
      weight_total: 100,
    });
  });

  it('refuses publishing with a stale revision or when there is no draft', async () => {
    const draft = await startDraft();
    const saved = await saveContent(draft.revision, validContent());
    const stale = await admin
      .post('/api/admin/rubric/draft/publish')
      .send({ revision: draft.revision });
    expect(stale.status).toBe(409);
    await admin
      .post('/api/admin/rubric/draft/publish')
      .send({ revision: saved.body.draft.revision });
    const none = await admin
      .post('/api/admin/rubric/draft/publish')
      .send({ revision: saved.body.draft.revision });
    expect(none.status).toBe(409);
    expect(none.body.error.code).toBe('NO_DRAFT');
  });
});

describe('changes after publishing', () => {
  it('edits through a new draft while judges keep the published version, then switches', async () => {
    const v1 = await publishContent();
    const draft = await startDraft();
    expect(draft.versionNo).toBe(2);
    expect(strip(draft)).toEqual(strip(v1)); // a copy of what is published
    await saveContent(draft.revision, validContent({ title: 'Revised rubric' }));

    const judge = await signIn(app, JUDGE.email, JUDGE.password);
    expect((await judge.get('/api/judge/rubric')).body.rubric.title).toBe('Final judging rubric');
    expect((await state()).state).toBe('published_with_draft');

    const current = (await state()).draft!;
    const res = await admin
      .post('/api/admin/rubric/draft/publish')
      .send({ revision: current.revision });
    expect(res.status).toBe(200);
    expect((await judge.get('/api/judge/rubric')).body.rubric).toMatchObject({
      versionNo: 2,
      title: 'Revised rubric',
    });

    // Version 1 is kept, retired and unchanged.
    const [rows] = await pool.query<RowDataPacket[]>(
      'SELECT version_no, status, title FROM rubric_versions ORDER BY version_no',
    );
    expect(rows.map((r) => [r.version_no, r.status, r.title])).toEqual([
      [1, 'retired', 'Final judging rubric'],
      [2, 'published', 'Revised rubric'],
    ]);
    expect(
      await scalar<number>(
        pool,
        'SELECT COUNT(*) FROM rubric_criteria WHERE rubric_version_id = ?',
        [v1.id],
      ),
    ).toBe(8);
  });

  it('never lets a published or retired version change, even directly in the database', async () => {
    const v1 = await publishContent();
    await expectRefused(
      pool.query("UPDATE rubric_versions SET title = 'x' WHERE id = ?", [v1.id]),
      /read-only/,
    );
    await expectRefused(
      pool.query('UPDATE rubric_versions SET description = ? WHERE id = ?', ['x', v1.id]),
      /read-only/,
    );
    await expectRefused(
      pool.query('UPDATE rubric_sections SET weight_percent = 40 WHERE rubric_version_id = ?', [
        v1.id,
      ]),
      /read-only/,
    );
    await expectRefused(
      pool.query('UPDATE rubric_criteria SET guidelines = ? WHERE rubric_version_id = ?', [
        'x',
        v1.id,
      ]),
      /read-only/,
    );
    // A second published version can never exist.
    await expectRefused(
      pool.query(
        "INSERT INTO rubric_versions (version_no, title, status, published_at) VALUES (9, 't', 'published', NOW())",
      ),
      /must start as drafts/,
    );
  });

  it('protects evaluations: confirmation first, they stay on their version, scores unchanged', async () => {
    const v1 = await publishContent();
    const [teamInsert] = await pool.query(
      "INSERT INTO teams (team_code, name, project_name) VALUES ('AHL-1', 'Falcons', 'P')",
    );
    const teamId = (teamInsert as { insertId: number }).insertId;
    const [evalInsert] = await pool.query(
      'INSERT INTO evaluations (team_id, judge_id, rubric_version_id) VALUES (?, ?, ?)',
      [teamId, judgeId, v1.id],
    );
    const evaluationId = (evalInsert as { insertId: number }).insertId;
    const criterion = v1.sections[0]!.criteria[0]!;
    await pool.query(
      'INSERT INTO evaluation_scores (evaluation_id, rubric_version_id, criterion_id, score) VALUES (?, ?, ?, 4)',
      [evaluationId, v1.id, criterion.id],
    );
    await pool.query(
      "UPDATE evaluations SET status = 'submitted', submitted_at = NOW(), total_score = 8 WHERE id = ?",
      [evaluationId],
    );

    const draft = await startDraft();
    const changed = validContent({}, [10, 50, 20, 20]); // new weights
    const saved = await saveContent(draft.revision, changed);
    const refused = await admin
      .post('/api/admin/rubric/draft/publish')
      .send({ revision: saved.body.draft.revision });
    expect(refused.status).toBe(409);
    expect(refused.body.error.code).toBe('EVALUATIONS_EXIST');
    expect(refused.body.evaluations).toMatchObject({ onPublished: 1, submittedOnPublished: 1 });

    const ok = await admin
      .post('/api/admin/rubric/draft/publish')
      .send({ revision: saved.body.draft.revision, confirmExistingEvaluations: true });
    expect(ok.status).toBe(200);

    const [rows] = await pool.query<RowDataPacket[]>(
      'SELECT e.rubric_version_id, e.total_score, s.score FROM evaluations e JOIN evaluation_scores s ON s.evaluation_id = e.id WHERE e.id = ?',
      [evaluationId],
    );
    expect(rows[0]).toMatchObject({ rubric_version_id: v1.id, total_score: '8.000', score: 4 });
    // Version 1 keeps its original weights.
    const [crit] = await pool.query<RowDataPacket[]>(
      'SELECT c.weight, s.weight_percent FROM rubric_criteria c JOIN rubric_sections s ON s.id = c.section_id WHERE c.id = ?',
      [criterion.id],
    );
    expect([Number(crit[0]!.weight), crit[0]!.weight_percent]).toEqual([3, 30]);
    // New evaluations can only use the new version.
    await expectRefused(
      pool.query(
        'INSERT INTO evaluations (team_id, judge_id, rubric_version_id) VALUES (?, ?, ?)',
        [teamId, adminId, v1.id],
      ),
      /currently published rubric/,
    );
    expect(await auditDetails('rubric.published')).toMatchObject({
      version_no: 2,
      previous_version_no: 1,
      previous_weights: [30, 30, 20, 20],
      evaluations_on_previous: 1,
    });
  });

  it('reports which versions have submitted evaluations, so results are never silently mixed', async () => {
    const v1 = await publishContent();
    const [t] = await pool.query(
      "INSERT INTO teams (team_code, name, project_name) VALUES ('A', 'A', 'P'), ('B', 'B', 'P')",
    );
    const firstTeam = (t as { insertId: number }).insertId;
    const submit = async (team: number, version: RubricVersion) => {
      const [e] = await pool.query(
        'INSERT INTO evaluations (team_id, judge_id, rubric_version_id) VALUES (?, ?, ?)',
        [team, judgeId, version.id],
      );
      const id = (e as { insertId: number }).insertId;
      const required = version.sections.flatMap((s) => s.criteria).length; // all 8 are required
      await pool.query(
        "UPDATE evaluations SET status = 'submitted', submitted_at = NOW(), required_scored = ?, required_count = ? WHERE id = ?",
        [required, required, id],
      );
    };
    await submit(firstTeam, v1);
    const draft = await startDraft();
    await admin
      .post('/api/admin/rubric/draft/publish')
      .send({ revision: draft.revision, confirmExistingEvaluations: true });
    const v2 = (await state()).published!;
    await submit(firstTeam + 1, v2);
    expect((await state()).evaluations.submittedVersions).toEqual([1, 2]);
  });
});

describe('concurrency', () => {
  it('lets only one of two simultaneous publish attempts succeed', async () => {
    const draft = await startDraft();
    const saved = await saveContent(draft.revision, validContent());
    const second = await signIn(app, ADMIN2.email, ADMIN2.password);
    const body = { revision: saved.body.draft.revision };
    const results = await Promise.all([
      admin.post('/api/admin/rubric/draft/publish').send(body),
      second.post('/api/admin/rubric/draft/publish').send(body),
      admin.post('/api/admin/rubric/draft/publish').send(body),
    ]);
    const statuses = results.map((r) => r.status).sort();
    expect(statuses).toEqual([200, 409, 409]);
    expect(
      await scalar<number>(pool, "SELECT COUNT(*) FROM rubric_versions WHERE status = 'published'"),
    ).toBe(1);
    expect((await auditActions()).filter((a) => a === 'rubric.published')).toHaveLength(1);
  });

  it('creates only one draft when two admins start editing at once', async () => {
    const second = await signIn(app, ADMIN2.email, ADMIN2.password);
    const results = await Promise.all([
      admin.post('/api/admin/rubric/draft').send({}),
      second.post('/api/admin/rubric/draft').send({}),
    ]);
    expect(results.map((r) => r.status).sort()).toEqual([201, 409]);
    expect(await scalar<number>(pool, 'SELECT COUNT(*) FROM rubric_versions')).toBe(1);
  });

  it('accepts only one of two simultaneous saves from the same revision', async () => {
    const draft = await startDraft();
    const second = await signIn(app, ADMIN2.email, ADMIN2.password);
    const results = await Promise.all([
      admin
        .put('/api/admin/rubric/draft')
        .send({ revision: draft.revision, content: validContent({ title: 'A' }) }),
      second
        .put('/api/admin/rubric/draft')
        .send({ revision: draft.revision, content: validContent({ title: 'B' }) }),
    ]);
    expect(results.map((r) => r.status).sort()).toEqual([200, 409]);
    const winner = results.find((r) => r.status === 200)!.body.draft.title;
    expect((await state()).draft!.title).toBe(winner);
  });
});

describe('administrators as judges', () => {
  it('can be assigned to teams, see them in My Teams and read the rubric like a judge', async () => {
    await publishContent();
    const [t] = await pool.query(
      "INSERT INTO teams (team_code, name, project_name) VALUES ('AHL-1', 'Falcons', 'P'), ('AHL-2', 'Eagles', 'Q')",
    );
    const firstTeam = (t as { insertId: number }).insertId;
    const assign = await admin
      .post('/api/admin/assignments/bulk')
      .send({ teamIds: [firstTeam], judgeIds: [adminId] });
    expect(assign.status).toBe(200);
    expect(assign.body.added).toBe(1);

    const mine = await admin.get('/api/judge/assignments');
    expect(mine.body.assignments.map((a: { teamCode: string }) => a.teamCode)).toEqual(['AHL-1']);
    const rubric = await admin.get('/api/judge/rubric');
    expect(rubric.body.rubric.versionNo).toBe(1);

    // Same rules as any judge: only the published version, no other teams.
    const judge = await signIn(app, JUDGE.email, JUDGE.password);
    expect((await judge.get('/api/judge/assignments')).body.assignments).toEqual([]);
  });
});
