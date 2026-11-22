import { Router, type Request, type Response } from 'express';
import type { Pool } from 'mysql2/promise';
import { z } from 'zod';
import { TEAM_LIMITS } from '@judging/shared';
import { commitImport, previewImport } from './import.js';
import {
  bulkAssign,
  createTeam,
  getTeamDetails,
  listAssignableUsers,
  listTeams,
  removeAssignment,
  setTeamJudges,
  setTeamStatus,
  updateTeam,
  type Actor,
} from './service.js';
import { teamInputSchema, teamUpdateSchema } from './validation.js';

const id = z.coerce.number().int().positive().max(4_294_967_295);
const idList = (label: string, max: number) =>
  z
    .array(id, { message: `${label} must be a list of ids.` })
    .min(1, `Choose at least one ${label.toLowerCase().replace(/s$/, '')}.`)
    .max(max, `At most ${max} ${label.toLowerCase()} at a time.`);

const listSchema = z
  .object({
    search: z.string().trim().max(100).optional(),
    status: z.enum(['active', 'archived']).optional(),
    sort: z
      .enum(['teamCode', 'name', 'projectName', 'createdAt', 'assignedJudges', 'progress'])
      .default('teamCode'),
    dir: z.enum(['asc', 'desc']).default('asc'),
    page: z.coerce.number().int().min(1).max(100_000).default(1),
    pageSize: z.coerce.number().int().min(1).max(100).default(25),
  })
  .strict();

const archiveSchema = z
  .object({
    reason: z
      .string()
      .trim()
      .max(TEAM_LIMITS.reason, `The reason can be at most ${TEAM_LIMITS.reason} characters.`)
      .optional(),
  })
  .strict();
const setJudgesSchema = z.object({ judgeIds: z.array(id).max(200) }).strict();
const bulkSchema = z
  .object({ teamIds: idList('Teams', 500), judgeIds: idList('Judges', 100) })
  .strict();

const importRow = z
  .object({
    rowNumber: z.number().int().min(1).max(1_000_000),
    teamCode: z.string().max(1000).optional().default(''),
    name: z.string().max(1000).optional().default(''),
    projectName: z.string().max(1000).optional().default(''),
  })
  .strict();
const importSchema = z
  .object({
    rows: z
      .array(importRow)
      .max(TEAM_LIMITS.importRows, `A file can have at most ${TEAM_LIMITS.importRows} teams.`),
    confirmUpdates: z.boolean().optional().default(false),
  })
  .strict();

function invalid(res: Response, error: z.ZodError) {
  const first = error.issues[0];
  res.status(400).json({
    error: {
      code: 'VALIDATION_ERROR',
      message: first?.message ?? 'Some of the details are not valid.',
    },
    fields: Object.fromEntries(error.issues.map((i) => [i.path.join('.') || 'form', i.message])),
  });
}

const actorOf = (req: Request): Actor => ({ id: req.user!.id, email: req.user!.email, ip: req.ip });

/** /api/admin/teams, /api/admin/assignments, ... — mounted inside the admin router. */
export function teamsRouter(pool: Pool): Router {
  const router = Router();

  router.get('/assignable-users', async (_req, res) => {
    res.json({ users: await listAssignableUsers(pool) });
  });

  router.post('/assignments/bulk', async (req, res) => {
    const parsed = bulkSchema.safeParse(req.body);
    if (!parsed.success) return invalid(res, parsed.error);
    res.json(await bulkAssign(pool, actorOf(req), parsed.data.teamIds, parsed.data.judgeIds));
  });

  router.get('/teams', async (req, res) => {
    const parsed = listSchema.safeParse(req.query);
    if (!parsed.success) return invalid(res, parsed.error);
    res.json(await listTeams(pool, { ...parsed.data, search: parsed.data.search || undefined }));
  });

  router.post('/teams', async (req, res) => {
    const parsed = teamInputSchema.safeParse(req.body);
    if (!parsed.success) return invalid(res, parsed.error);
    res.status(201).json({ team: await createTeam(pool, actorOf(req), parsed.data) });
  });

  router.post('/teams/import/preview', async (req, res) => {
    const parsed = importSchema.safeParse(req.body);
    if (!parsed.success) return invalid(res, parsed.error);
    res.json(await previewImport(pool, parsed.data.rows));
  });

  router.post('/teams/import/commit', async (req, res) => {
    const parsed = importSchema.safeParse(req.body);
    if (!parsed.success) return invalid(res, parsed.error);
    res.json(await commitImport(pool, actorOf(req), parsed.data.rows, parsed.data.confirmUpdates));
  });

  router.get('/teams/:id', async (req, res) => {
    const teamId = id.safeParse(req.params.id);
    if (!teamId.success) return invalid(res, teamId.error);
    res.json({ team: await getTeamDetails(pool, teamId.data) });
  });

  router.patch('/teams/:id', async (req, res) => {
    const teamId = id.safeParse(req.params.id);
    if (!teamId.success) return invalid(res, teamId.error);
    const parsed = teamUpdateSchema.safeParse(req.body);
    if (!parsed.success) return invalid(res, parsed.error);
    res.json({ team: await updateTeam(pool, actorOf(req), teamId.data, parsed.data) });
  });

  router.post('/teams/:id/archive', async (req, res) => {
    const teamId = id.safeParse(req.params.id);
    if (!teamId.success) return invalid(res, teamId.error);
    const parsed = archiveSchema.safeParse(req.body ?? {});
    if (!parsed.success) return invalid(res, parsed.error);
    res.json({
      team: await setTeamStatus(pool, actorOf(req), teamId.data, 'archived', parsed.data.reason),
    });
  });

  router.post('/teams/:id/reactivate', async (req, res) => {
    const teamId = id.safeParse(req.params.id);
    if (!teamId.success) return invalid(res, teamId.error);
    res.json({ team: await setTeamStatus(pool, actorOf(req), teamId.data, 'active') });
  });

  router.put('/teams/:id/judges', async (req, res) => {
    const teamId = id.safeParse(req.params.id);
    if (!teamId.success) return invalid(res, teamId.error);
    const parsed = setJudgesSchema.safeParse(req.body);
    if (!parsed.success) return invalid(res, parsed.error);
    res.json(await setTeamJudges(pool, actorOf(req), teamId.data, parsed.data.judgeIds));
  });

  router.delete('/teams/:id/judges/:judgeId', async (req, res) => {
    const teamId = id.safeParse(req.params.id);
    const judgeId = id.safeParse(req.params.judgeId);
    if (!teamId.success) return invalid(res, teamId.error);
    if (!judgeId.success) return invalid(res, judgeId.error);
    await removeAssignment(pool, actorOf(req), teamId.data, judgeId.data);
    res.status(204).end();
  });

  return router;
}
