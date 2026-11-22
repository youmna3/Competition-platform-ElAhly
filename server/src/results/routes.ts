import { Router, type Response } from 'express';
import type { Pool } from 'mysql2/promise';
import { z } from 'zod';
import { LEADERBOARD_SORTS, RESULTS_SORTS } from '@judging/shared';
import { requireAuth, requireRole } from '../auth/middleware.js';
import { getDashboard, getJudgeLeaderboard, getResults } from './service.js';

const resultsSchema = z
  .object({
    search: z.string().trim().max(100).optional(),
    sort: z.enum(RESULTS_SORTS).default('rank'),
    dir: z.enum(['asc', 'desc']).default('asc'),
  })
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

/** Mounted under /api/admin (administrators only). Read-only. */
export function resultsRouter(pool: Pool): Router {
  const router = Router();

  router.get('/results', async (req, res) => {
    const parsed = resultsSchema.safeParse(req.query);
    if (!parsed.success) return invalid(res, parsed.error);
    const q = parsed.data;
    res.set('Cache-Control', 'no-store');
    res.json(await getResults(pool, q));
  });

  router.get('/dashboard', async (_req, res) => {
    res.set('Cache-Control', 'no-store');
    res.json(await getDashboard(pool));
  });

  return router;
}

/** Authenticated judges and admins; no mutation or detail endpoints. */
export function judgeLeaderboardRouter(pool: Pool): Router {
  const router = Router();
  router.use(requireAuth, requireRole('admin', 'judge'));
  router.get('/leaderboard', async (req, res) => {
    const parsed = resultsSchema
      .extend({ sort: z.enum(LEADERBOARD_SORTS).default('rank') })
      .safeParse(req.query);
    if (!parsed.success) return invalid(res, parsed.error);
    res.set('Cache-Control', 'no-store');
    res.json(await getJudgeLeaderboard(pool, parsed.data));
  });
  return router;
}
