import type { Pool, PoolConnection, ResultSetHeader, RowDataPacket } from 'mysql2/promise';
import {
  TEAM_ERRORS,
  type ImportCommitResponse,
  type ImportPreview,
  type ImportRowInput,
  type ImportRowResult,
} from '@judging/shared';
import { writeAudit } from '../audit.js';
import { RuleError } from '../errors.js';
import { inTransaction, type Actor } from './service.js';
import { teamInputSchema } from './validation.js';

interface PlannedRow extends ImportRowResult {
  clean?: { teamCode: string; name: string; projectName: string };
  existingId?: number;
}

const fold = (s: string) => s.toLocaleLowerCase('en');

/**
 * Validates every row and works out what would happen: create, update,
 * unchanged or error. Used by both preview and commit, so the preview is
 * exactly what the import will do. With `lock`, matching teams are locked.
 */
async function buildPlan(db: Pool | PoolConnection, rows: ImportRowInput[], lock: boolean) {
  const planned: PlannedRow[] = rows.map((row) => {
    const parsed = teamInputSchema.safeParse({
      teamCode: row.teamCode ?? '',
      name: row.name ?? '',
      projectName: row.projectName ?? '',
    });
    return {
      rowNumber: row.rowNumber,
      teamCode: String(row.teamCode ?? '').trim(),
      action: parsed.success ? 'create' : 'error',
      errors: parsed.success ? [] : parsed.error.issues.map((i) => i.message),
      changes: {},
      warnings: [],
      clean: parsed.success ? parsed.data : undefined,
    };
  });

  // Duplicate Team IDs inside the file (case-insensitive, like the database).
  const byCode = new Map<string, PlannedRow[]>();
  for (const row of planned) {
    if (!row.clean) continue;
    const key = fold(row.clean.teamCode);
    byCode.set(key, [...(byCode.get(key) ?? []), row]);
  }
  for (const group of byCode.values()) {
    if (group.length < 2) continue;
    const lines = group.map((r) => r.rowNumber).join(', ');
    for (const row of group) {
      row.action = 'error';
      row.errors.push(
        `Team ID "${row.clean?.teamCode}" appears more than once in the file (rows ${lines}).`,
      );
    }
  }

  // Compare with teams already in the database.
  const codes = [...byCode.keys()];
  const existing = new Map<string, RowDataPacket>();
  if (codes.length) {
    const [found] = await db.query<RowDataPacket[]>(
      `SELECT id, team_code, name, project_name, status FROM teams
       WHERE team_code IN (?)${lock ? ' FOR UPDATE' : ''}`,
      [codes],
    );
    for (const t of found) existing.set(fold(String(t.team_code)), t);
  }

  for (const row of planned) {
    if (row.action === 'error' || !row.clean) continue;
    const clean = row.clean;
    const team = existing.get(fold(clean.teamCode));
    if (!team) continue; // create
    row.existingId = Number(team.id);
    if (clean.teamCode !== team.team_code) {
      row.warnings.push(
        `Matches existing Team ID "${team.team_code}" (letter case differs); the existing ID is kept.`,
      );
    }
    if (clean.name !== team.name) row.changes.name = { from: String(team.name), to: clean.name };
    if (clean.projectName !== team.project_name) {
      row.changes.project_name = { from: String(team.project_name), to: clean.projectName };
    }
    row.action = Object.keys(row.changes).length ? 'update' : 'unchanged';
    if (team.status === 'archived') {
      row.warnings.push(
        row.action === 'update'
          ? 'This team is archived. It will be updated and stay archived.'
          : 'This team is archived. Importing it does not reactivate it.',
      );
    }
  }

  const summary = { create: 0, update: 0, unchanged: 0, error: 0 };
  for (const row of planned) summary[row.action] += 1;
  return { planned, summary };
}

const publicRow = ({ clean: _clean, existingId: _id, ...row }: PlannedRow): ImportRowResult => row;

function checkSize(rows: ImportRowInput[]) {
  if (rows.length === 0)
    throw new RuleError(400, TEAM_ERRORS.IMPORT_INVALID, 'The file has no team rows.');
}

export async function previewImport(pool: Pool, rows: ImportRowInput[]): Promise<ImportPreview> {
  checkSize(rows);
  const plan = await buildPlan(pool, rows, false);
  return { rows: plan.planned.map(publicRow), summary: plan.summary };
}

/**
 * All-or-nothing import in one transaction. Refuses everything if any row is
 * invalid, and refuses to change existing teams unless confirmUpdates is true.
 */
export function commitImport(
  pool: Pool,
  actor: Actor,
  rows: ImportRowInput[],
  confirmUpdates: boolean,
): Promise<ImportCommitResponse> {
  checkSize(rows);
  return inTransaction(pool, async (conn) => {
    const plan = await buildPlan(conn, rows, true);
    if (plan.summary.error > 0) {
      throw new RuleError(
        400,
        TEAM_ERRORS.IMPORT_INVALID,
        `Nothing was imported: ${plan.summary.error} row${plan.summary.error === 1 ? ' has' : 's have'} errors.`,
        { preview: { rows: plan.planned.map(publicRow), summary: plan.summary } },
      );
    }
    if (plan.summary.update > 0 && !confirmUpdates) {
      throw new RuleError(
        409,
        TEAM_ERRORS.UPDATE_CONFIRMATION_REQUIRED,
        `${plan.summary.update} existing team${plan.summary.update === 1 ? '' : 's'} would be changed. Confirm the updates to continue.`,
        { preview: { rows: plan.planned.map(publicRow), summary: plan.summary } },
      );
    }

    for (const row of plan.planned) {
      const clean = row.clean!;
      if (row.action === 'create') {
        const [insert] = await conn.query<ResultSetHeader>(
          'INSERT INTO teams (team_code, name, project_name, created_by) VALUES (?, ?, ?, ?)',
          [clean.teamCode, clean.name, clean.projectName, actor.id],
        );
        await writeAudit(conn, {
          actorId: actor.id,
          actorEmail: actor.email,
          action: 'team.created',
          entityType: 'team',
          entityId: insert.insertId,
          ipAddress: actor.ip,
          details: { team_code: clean.teamCode, source: 'import', row: row.rowNumber },
        });
      } else if (row.action === 'update') {
        const sets: string[] = [];
        const params: unknown[] = [];
        if (row.changes.name) {
          sets.push('name = ?');
          params.push(clean.name);
        }
        if (row.changes.project_name) {
          sets.push('project_name = ?');
          params.push(clean.projectName);
        }
        await conn.query(`UPDATE teams SET ${sets.join(', ')} WHERE id = ?`, [
          ...params,
          row.existingId,
        ]);
        await writeAudit(conn, {
          actorId: actor.id,
          actorEmail: actor.email,
          action: 'team.updated',
          entityType: 'team',
          entityId: row.existingId,
          ipAddress: actor.ip,
          details: {
            team_code: row.teamCode,
            source: 'import',
            row: row.rowNumber,
            changes: row.changes,
          },
        });
      }
    }

    const result = {
      created: plan.summary.create,
      updated: plan.summary.update,
      unchanged: plan.summary.unchanged,
    };
    await writeAudit(conn, {
      actorId: actor.id,
      actorEmail: actor.email,
      action: 'team.import',
      entityType: 'team',
      ipAddress: actor.ip,
      details: { rows: rows.length, ...result },
    });
    return result;
  });
}
