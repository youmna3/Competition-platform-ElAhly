import { Router, type Request, type Response } from 'express';
import type { Pool } from 'mysql2/promise';
import { z } from 'zod';
import { EVALUATION_LIMITS as L } from '@judging/shared';
import type { Actor } from '../teams/service.js';
import {
  acknowledgeReopen,
  getJudgeEvaluation,
  saveEvaluation,
  startEvaluation,
  submitEvaluation,
} from './service.js';

const id = z.coerce.number().int().positive().max(4_294_967_295);
const rowVersion = z.number().int().min(0).max(4_294_967_295);

// Shape only; ratings, ids and lengths are checked against the rubric in the service.
export const saveSchema = z
  .object({
    rowVersion,
    ratings: z
      .array(
        z
          .object({
            criterionId: id,
            rating: z.number().nullable(),
            note: z.string().max(L.criterionNote * 2),
          })
          .strict(),
      )
      .max(20),
    sectionNotes: z
      .array(z.object({ sectionId: id, note: z.string().max(L.sectionNote * 2) }).strict())
      .max(10),
    overallNotes: z.string().max(L.overallNotes * 2),
  })
  .strict();

const submitSchema = z.object({ rowVersion }).strict();

function invalid(res: Response, error: z.ZodError) {
  const first = error.issues[0];
  res.status(400).json({
    error: {
      code: 'VALIDATION_ERROR',
      message: first
        ? `The evaluation data is not valid (${first.path.join('.') || 'body'}: ${first.message}).`
        : 'The evaluation data is not valid.',
    },
  });
}

const actorOf = (req: Request): Actor => ({ id: req.user!.id, email: req.user!.email, ip: req.ip });

/**
 * Mounted inside /api/judge (judges and administrators). Every route works on
 * the signed-in person's own evaluations of teams assigned to them.
 */
export function evaluationsRouter(pool: Pool): Router {
  const router = Router();

  router.get('/teams/:teamId/evaluation', async (req, res) => {
    const teamId = id.safeParse(req.params.teamId);
    if (!teamId.success) return invalid(res, teamId.error);
    res.json(await getJudgeEvaluation(pool, req.user!.id, teamId.data));
  });

  router.post('/teams/:teamId/evaluation', async (req, res) => {
    const teamId = id.safeParse(req.params.teamId);
    if (!teamId.success) return invalid(res, teamId.error);
    res.status(201).json({ evaluation: await startEvaluation(pool, actorOf(req), teamId.data) });
  });

  router.put('/evaluations/:id', async (req, res) => {
    const evaluationId = id.safeParse(req.params.id);
    if (!evaluationId.success) return invalid(res, evaluationId.error);
    const parsed = saveSchema.safeParse(req.body);
    if (!parsed.success) return invalid(res, parsed.error);
    const { rowVersion: version, ...input } = parsed.data;
    res.json({
      evaluation: await saveEvaluation(pool, actorOf(req), evaluationId.data, version, input),
    });
  });

  router.post('/evaluations/:id/submit', async (req, res) => {
    const evaluationId = id.safeParse(req.params.id);
    if (!evaluationId.success) return invalid(res, evaluationId.error);
    const parsed = submitSchema.safeParse(req.body);
    if (!parsed.success) return invalid(res, parsed.error);
    res.json(await submitEvaluation(pool, actorOf(req), evaluationId.data, parsed.data.rowVersion));
  });

  router.post('/evaluations/:id/acknowledge-reopen', async (req, res) => {
    const evaluationId = id.safeParse(req.params.id);
    if (!evaluationId.success) return invalid(res, evaluationId.error);
    await acknowledgeReopen(pool, actorOf(req), evaluationId.data);
    res.status(204).end();
  });

  return router;
}
