import { Router, type Request, type Response } from 'express';
import type { Pool } from 'mysql2/promise';
import { z } from 'zod';
import { REOPEN_REASON } from '@judging/shared';
import type { Actor } from '../teams/service.js';
import {
  getAdminEvaluation,
  getEvaluationHistory,
  judgeProgress,
  listTeamEvaluations,
  reopenEvaluation,
} from './service.js';

const id = z.coerce.number().int().positive().max(4_294_967_295);

const listSchema = z
  .object({
    search: z.string().trim().max(100).optional(),
    teamStatus: z.enum(['active', 'archived', 'all']).default('active'),
    teamId: id.optional(),
    judgeId: id.optional(),
    status: z.enum(['not_started', 'draft', 'submitted']).optional(),
    version: z.coerce.number().int().min(1).max(100_000).optional(),
    completion: z
      .enum(['complete', 'incomplete', 'not_started', 'no_judges', 'mixed_versions', 'ready'])
      .optional(),
    sort: z
      .enum(['teamCode', 'name', 'submitted', 'pending', 'average', 'lastSubmitted'])
      .default('teamCode'),
    dir: z.enum(['asc', 'desc']).default('asc'),
    page: z.coerce.number().int().min(1).max(100_000).default(1),
    pageSize: z.coerce.number().int().min(1).max(100).default(25),
  })
  .strict();

const progressSchema = z
  .object({
    search: z.string().trim().max(100).optional(),
    judgeId: id.optional(),
    completion: z.enum(['complete', 'incomplete', 'not_started', 'no_teams']).optional(),
  })
  .strict();

const reopenSchema = z
  .object({ reason: z.string().max(REOPEN_REASON.max * 2, 'The reason is too long.') })
  .strict();

function invalid(res: Response, error: z.ZodError) {
  const first = error.issues[0];
  res.status(400).json({
    error: {
      code: 'VALIDATION_ERROR',
      message: first
        ? `${first.path.join('.') || 'request'}: ${first.message}`
        : 'The request is not valid.',
    },
  });
}

const actorOf = (req: Request): Actor => ({ id: req.user!.id, email: req.user!.email, ip: req.ip });

/** Mounted inside the admin router: administrators only. */
export function reviewRouter(pool: Pool): Router {
  const router = Router();

  router.get('/evaluations', async (req, res) => {
    const parsed = listSchema.safeParse(req.query);
    if (!parsed.success) return invalid(res, parsed.error);
    res.json(
      await listTeamEvaluations(pool, { ...parsed.data, search: parsed.data.search || undefined }),
    );
  });

  router.get('/evaluations/:id', async (req, res) => {
    const evaluationId = id.safeParse(req.params.id);
    if (!evaluationId.success) return invalid(res, evaluationId.error);
    res.json(await getAdminEvaluation(pool, evaluationId.data));
  });

  router.get('/evaluations/:id/history', async (req, res) => {
    const evaluationId = id.safeParse(req.params.id);
    if (!evaluationId.success) return invalid(res, evaluationId.error);
    res.json({ events: await getEvaluationHistory(pool, evaluationId.data) });
  });

  router.post('/evaluations/:id/reopen', async (req, res) => {
    const evaluationId = id.safeParse(req.params.id);
    if (!evaluationId.success) return invalid(res, evaluationId.error);
    const parsed = reopenSchema.safeParse(req.body ?? {});
    if (!parsed.success) return invalid(res, parsed.error);
    res.json(await reopenEvaluation(pool, actorOf(req), evaluationId.data, parsed.data.reason));
  });

  router.get('/judge-progress', async (req, res) => {
    const parsed = progressSchema.safeParse(req.query);
    if (!parsed.success) return invalid(res, parsed.error);
    res.json({
      judges: await judgeProgress(pool, {
        ...parsed.data,
        search: parsed.data.search || undefined,
      }),
    });
  });

  return router;
}
