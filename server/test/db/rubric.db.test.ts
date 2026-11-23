import type { Connection, RowDataPacket } from 'mysql2/promise';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import {
  addCriterion,
  addSection,
  connectTest,
  createDraft,
  createPublishableDraft,
  dropDatabase,
  expectRefused,
  freshTestDatabase,
  publish,
  rubricState,
  scalar,
  TEST_DB,
} from './helpers.js';

let conn: Connection | undefined;

beforeEach(async () => {
  await conn?.end();
  await freshTestDatabase();
  conn = await connectTest();
});

afterAll(async () => {
  await conn?.end();
  await dropDatabase(TEST_DB);
});

const c = () => conn as Connection;

/** A valid draft in the fixed shape: 4 sections × 2 criteria, weights 25 each. */
const validDraft = (versionNo = 1, weights?: number[]) =>
  createPublishableDraft(c(), { versionNo, weights });

describe('exactly one rubric', () => {
  it('refuses a second rubric row and refuses deleting the rubric', async () => {
    await expectRefused(
      c().query('INSERT INTO rubric (id) VALUES (2)'),
      /chk_rubric_single|CONSTRAINT/i,
    );
    await expectRefused(c().query('INSERT INTO rubric (id) VALUES (1)'), /ER_DUP_ENTRY/);
    await expectRefused(c().query('DELETE FROM rubric'), /cannot be deleted/);
  });

  it('refuses version numbers that repeat and versions that do not start as drafts', async () => {
    await createDraft(c(), { versionNo: 1 });
    await expectRefused(
      c().query('INSERT INTO rubric_versions (version_no) VALUES (1)'),
      /ER_DUP_ENTRY/,
    );
    await expectRefused(
      c().query(
        "INSERT INTO rubric_versions (version_no, status, published_at) VALUES (2, 'published', NOW())",
      ),
      /must start as drafts/,
    );
  });
});

describe('editing a draft', () => {
  it('moves from "Not configured" to "Draft" when the admin starts one', async () => {
    expect(await rubricState(c())).toBe('not_configured');
    await createDraft(c(), { versionNo: 1 });
    expect(await rubricState(c())).toBe('draft_only');
  });

  it('allows adding, editing, reordering and removing sections and criteria', async () => {
    const version = await createDraft(c(), { versionNo: 1 });
    const s1 = await addSection(c(), version, { position: 1, title: 'First' });
    const s2 = await addSection(c(), version, { position: 2, title: 'Second' });
    await addCriterion(c(), version, s1, { position: 1 });
    await addCriterion(c(), version, s1, { position: 2 });

    await c().query(
      "UPDATE rubric_sections SET title = 'Renamed', description = 'How to judge it' WHERE id = ?",
      [s1],
    );
    await c().query(
      'UPDATE rubric_criteria SET max_score = 20, weight = 2.5, is_required = FALSE WHERE section_id = ? AND position = 2',
      [s1],
    );

    // Reorder (swap positions) inside one transaction, as the service will.
    await c().beginTransaction();
    await c().query(
      'UPDATE rubric_sections SET position = position + 1000 WHERE rubric_version_id = ?',
      [version],
    );
    await c().query('UPDATE rubric_sections SET position = 1 WHERE id = ?', [s2]);
    await c().query('UPDATE rubric_sections SET position = 2 WHERE id = ?', [s1]);
    await c().commit();
    const [order] = await c().query<RowDataPacket[]>(
      'SELECT id FROM rubric_sections WHERE rubric_version_id = ? ORDER BY position',
      [version],
    );
    expect(order.map((r) => r.id)).toEqual([s2, s1]);

    // Removing a section removes its criteria.
    await c().query('DELETE FROM rubric_sections WHERE id = ?', [s1]);
    expect(
      await scalar<number>(
        c(),
        'SELECT COUNT(*) FROM rubric_criteria WHERE rubric_version_id = ?',
        [version],
      ),
    ).toBe(0);
  });

  it('stores judging instructions, a scale with labels, bonus settings and a target total', async () => {
    const version = await createDraft(c(), { versionNo: 1 });
    await c().query(
      `UPDATE rubric_versions SET instructions = 'Read every row before scoring.', scale_min = 1, scale_max = 4,
         bonus_policy = 'add_to_total', bonus_cap = 5, total_target = 40 WHERE id = ?`,
      [version],
    );
    await c().query(
      "INSERT INTO rubric_scale_levels (rubric_version_id, value, label) VALUES (?, 1, 'Label one'), (?, 4, 'Label four')",
      [version, version],
    );
    expect(
      await scalar<number>(
        c(),
        'SELECT COUNT(*) FROM rubric_scale_levels WHERE rubric_version_id = ?',
        [version],
      ),
    ).toBe(2);
  });

  it('validates criterion scoring rules', async () => {
    const version = await createDraft(c(), { versionNo: 1 });
    const section = await addSection(c(), version, { position: 1 });
    await expectRefused(
      addCriterion(c(), version, section, { position: 1, min: 5, max: 5 }),
      /chk_rc_range|CONSTRAINT/i,
    );
    await expectRefused(
      addCriterion(c(), version, section, { position: 1, min: -1, max: 5 }),
      /chk_rc_range|CONSTRAINT/i,
    );
    await expectRefused(
      addCriterion(c(), version, section, { position: 1, weight: 0 }),
      /chk_rc_weight|CONSTRAINT/i,
    );
    await addCriterion(c(), version, section, { position: 1 });
    await expectRefused(addCriterion(c(), version, section, { position: 1 }), /ER_DUP_ENTRY/);
  });

  it('validates rubric-level settings', async () => {
    const version = await createDraft(c(), { versionNo: 1 });
    await expectRefused(
      c().query('UPDATE rubric_versions SET scale_min = 5, scale_max = 1 WHERE id = ?', [version]),
      /chk_rv_scale|CONSTRAINT/i,
    );
    await expectRefused(
      c().query('UPDATE rubric_versions SET scale_min = 1 WHERE id = ?', [version]),
      /chk_rv_scale_pair|CONSTRAINT/i,
    );
    await expectRefused(
      c().query('UPDATE rubric_versions SET bonus_cap = 0 WHERE id = ?', [version]),
      /chk_rv_bonus_cap|CONSTRAINT/i,
    );
  });

  it('refuses a criterion whose section belongs to a different version', async () => {
    // Only one draft can exist at a time, so the other version is a published one.
    const { version, section } = await validDraft(1);
    await publish(c(), version);
    const other = await createDraft(c(), { versionNo: 2 });
    await expectRefused(addCriterion(c(), other, section, { position: 5 }), /ER_NO_REFERENCED_ROW/);
  });
});

describe('publishing', () => {
  it('refuses to publish without a title, leaving nothing half-published', async () => {
    const { version } = await validDraft(1);
    await c().query("UPDATE rubric_versions SET title = '' WHERE id = ?", [version]);
    await expectRefused(publish(c(), version), /needs a title/);
    expect(await rubricState(c())).toBe('draft_only');
    expect(await scalar(c(), 'SELECT status FROM rubric_versions WHERE id = ?', [version])).toBe(
      'draft',
    );
  });

  it('refuses anything but exactly 4 sections of exactly 2 criteria', async () => {
    const three = await validDraft(1, [40, 30, 30]);
    await expectRefused(publish(c(), three.version), /invalid section count/);
    await c().query('DELETE FROM rubric_versions WHERE id = ?', [three.version]);
    await c().query('UPDATE rubric SET draft_version_id = NULL');

    const { version, criteria, sections } = await validDraft(2);
    await c().query('DELETE FROM rubric_criteria WHERE id = ?', [criteria[1]]);
    await expectRefused(publish(c(), version), /valid question count/);
    await addCriterion(c(), version, sections[0]!, { position: 2, min: 1, max: 5, weight: 2.5 });
    await addCriterion(c(), version, sections[0]!, { position: 3, min: 1, max: 5, weight: 2.5 });
    await expectRefused(publish(c(), version), /valid question count/);
  });

  it('refuses missing weights and weights that do not total exactly 100%', async () => {
    const { version, sections } = await validDraft(1, [30, 30, 30, 10]);
    await c().query('UPDATE rubric_sections SET weight_percent = NULL WHERE id = ?', [sections[3]]);
    await expectRefused(publish(c(), version), /valid Actual\/Bonus limits/);
    await c().query('UPDATE rubric_sections SET weight_percent = 20 WHERE id = ?', [sections[3]]);
    await c().query('UPDATE rubric_criteria SET weight = 2 WHERE section_id = ?', [sections[3]]);
    await expectRefused(publish(c(), version), /total exactly 100%/);
    await expectRefused(
      c().query('UPDATE rubric_sections SET weight_percent = 0 WHERE id = ?', [sections[3]]),
      /chk_rs_weight_percent|CONSTRAINT/i,
    );
  });

  it('refuses criteria that are not required 1-5 star ratings weighted by their section', async () => {
    const { version, criteria } = await validDraft(1);
    await c().query('UPDATE rubric_criteria SET max_score = 10 WHERE id = ?', [criteria[0]]);
    await expectRefused(publish(c(), version), /invalid (star scale|score range)/);
    await c().query('UPDATE rubric_criteria SET max_score = 5, weight = 3 WHERE id = ?', [
      criteria[0],
    ]);
    await expectRefused(publish(c(), version), /invalid (star scale|score range)/);
    await c().query('UPDATE rubric_criteria SET weight = 2.5, is_required = FALSE WHERE id = ?', [
      criteria[0],
    ]);
    await expectRefused(publish(c(), version), /invalid (star scale|score range)/);
  });

  it('refuses bonus sections', async () => {
    const { version, sections } = await validDraft(1);
    await c().query('UPDATE rubric_sections SET is_bonus = TRUE WHERE id = ?', [sections[0]]);
    await expectRefused(publish(c(), version), /valid question count/);
  });

  it('publishes a valid draft with uneven weights and clears the draft pointer', async () => {
    const { version } = await validDraft(1, [35, 25, 25, 15]);
    await publish(c(), version);
    const [rows] = await c().query<RowDataPacket[]>('SELECT * FROM v_rubric_status');
    expect(rows[0]).toMatchObject({
      state: 'published',
      published_version_id: version,
      draft_version_id: null,
      published_version_no: 1,
    });
    // The Phase 1 scoring model gives a maximum of exactly 100.
    expect(
      Number(
        await scalar(
          c(),
          'SELECT SUM(max_score * weight) FROM rubric_criteria WHERE rubric_version_id = ?',
          [version],
        ),
      ),
    ).toBe(100);
  });
});

describe('published versions are read-only', () => {
  it('refuses any change to a published version, its sections, criteria or scale labels', async () => {
    const { version, section, criterion } = await validDraft(1);
    await c().query(
      "INSERT INTO rubric_scale_levels (rubric_version_id, value, label) VALUES (?, 1, 'One')",
      [version],
    );
    await publish(c(), version);

    await expectRefused(
      c().query("UPDATE rubric_versions SET title = 'Changed' WHERE id = ?", [version]),
      /read-only/,
    );
    await expectRefused(
      c().query('UPDATE rubric_criteria SET max_score = 99 WHERE id = ?', [criterion]),
      /read-only/,
    );
    await expectRefused(addCriterion(c(), version, section, { position: 2 }), /read-only/);
    await expectRefused(
      c().query('DELETE FROM rubric_criteria WHERE id = ?', [criterion]),
      /read-only/,
    );
    await expectRefused(
      c().query("UPDATE rubric_sections SET title = 'Changed' WHERE id = ?", [section]),
      /read-only/,
    );
    await expectRefused(
      c().query('DELETE FROM rubric_sections WHERE id = ?', [section]),
      /read-only/,
    );
    await expectRefused(addSection(c(), version, { position: 9 }), /read-only/);
    await expectRefused(
      c().query("UPDATE rubric_scale_levels SET label = 'X' WHERE rubric_version_id = ?", [
        version,
      ]),
      /read-only/,
    );
    await expectRefused(
      c().query('DELETE FROM rubric_versions WHERE id = ?', [version]),
      /Only a draft/,
    );
    await expectRefused(
      c().query('UPDATE rubric SET published_version_id = NULL'),
      /cannot be unpublished/,
    );
  });

  it('keeps the active rubric pointer on a published version', async () => {
    const { version } = await validDraft(1);
    await expectRefused(
      c().query('UPDATE rubric SET published_version_id = ?', [version]),
      /must point at a published version/,
    );
  });
});

describe('internal versioning', () => {
  it('edits happen on a new draft; publishing it retires the old version', async () => {
    const v1 = await validDraft(1);
    await publish(c(), v1.version);

    const v2 = await validDraft(2);
    expect(await rubricState(c())).toBe('published_with_draft');
    await c().query('UPDATE rubric_versions SET based_on_version_id = ? WHERE id = ?', [
      v1.version,
      v2.version,
    ]);
    await publish(c(), v2.version);

    const [rows] = await c().query<RowDataPacket[]>(
      'SELECT id, status FROM rubric_versions ORDER BY version_no',
    );
    expect(rows.map((r) => [r.id, r.status])).toEqual([
      [v1.version, 'retired'],
      [v2.version, 'published'],
    ]);
    expect(await rubricState(c())).toBe('published');
    await expectRefused(
      c().query("UPDATE rubric_versions SET title = 'x' WHERE id = ?", [v1.version]),
      /Retired rubric versions are read-only/,
    );
    // The old version's content is still intact.
    expect(
      await scalar<number>(
        c(),
        'SELECT COUNT(*) FROM rubric_criteria WHERE rubric_version_id = ?',
        [v1.version],
      ),
    ).toBe(8);
  });

  it('allows discarding an unpublished draft, which removes its content', async () => {
    const v1 = await validDraft(1);
    await publish(c(), v1.version);
    const v2 = await validDraft(2);
    await c().query('DELETE FROM rubric_versions WHERE id = ?', [v2.version]);
    expect(await rubricState(c())).toBe('published');
    expect(
      await scalar<number>(
        c(),
        'SELECT COUNT(*) FROM rubric_criteria WHERE rubric_version_id = ?',
        [v2.version],
      ),
    ).toBe(0);
  });

  it('refuses retiring a draft directly', async () => {
    const { version } = await validDraft(1);
    await expectRefused(
      c().query("UPDATE rubric_versions SET status = 'retired', retired_at = NOW() WHERE id = ?", [
        version,
      ]),
      /published or discarded/,
    );
  });
});
