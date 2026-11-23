import { Router, type Request, type Response } from 'express';
import type { Pool } from 'mysql2/promise';
import { z } from 'zod';
import { RUBRIC_LIMITS as L } from '@judging/shared';
import type { Actor } from '../teams/service.js';
import {
  createDraft,
  discardDraft,
  getAdminRubric,
  loadOfficialRubric,
  publishDraft,
  saveDraft,
  loadVersion,
} from './service.js';

// Shape only. The friendly, field-by-field rules (including the fixed 4 x 2
// shape and the 100% total) live in validateRubric (shared), which the service
// runs on every save and publish.
const text = (max: number) => z.string().max(max * 2);

const criterion = z
  .object({
    id: z.number().int().positive().optional(),
    title: text(L.criterionTitle),
    description: text(L.criterionDescription),
    guidelines: text(L.guidelines),
    maxPoints: z.number().finite().nullable().optional(),
  })
  .strict();

const section = z
  .object({
    id: z.number().int().positive().optional(),
    type: z.enum(['actual', 'bonus']).optional(),
    maxBonusPoints: z.number().finite().nullable().optional(),
    title: text(L.sectionTitle),
    description: text(L.sectionDescription),
    weightPercent: z.number().finite().nullable(),
    criteria: z.array(criterion).max(10),
  })
  .strict();

const content = z
  .object({
    scoringFormat: z.union([z.literal(1), z.literal(2), z.literal(3), z.literal(4)]).optional(),
    title: text(L.title),
    description: text(L.description),
    instructions: text(L.instructions),
    sections: z.array(section).max(10),
  })
  .strict();

const revision = z.number().int().min(0).max(4_294_967_295);
const saveSchema = z.object({ revision, content }).strict();
const discardSchema = z.object({ revision }).strict();
const publishSchema = z
  .object({ revision, confirmExistingEvaluations: z.boolean().optional().default(false) })
  .strict();

function invalidShape(res: Response, error: z.ZodError) {
  const first = error.issues[0];
  res.status(400).json({
    error: {
      code: 'VALIDATION_ERROR',
      message: first
        ? `The rubric data is not valid (${first.path.join('.') || 'body'}: ${first.message}).`
        : 'The rubric data is not valid.',
    },
  });
}

const actorOf = (req: Request): Actor => ({ id: req.user!.id, email: req.user!.email, ip: req.ip });

/** /api/admin/rubric — mounted inside the admin router (administrators only). */
export function rubricAdminRouter(pool: Pool): Router {
  const router = Router();

  router.get('/', async (_req, res) => {
    res.json(await getAdminRubric(pool));
  });

  router.post('/draft', async (req, res) => {
    const parsed = z
      .object({ sourceVersionId: z.number().int().positive().optional() })
      .strict()
      .safeParse(req.body ?? {});
    if (!parsed.success) return invalidShape(res, parsed.error);
    res.status(201).json(await createDraft(pool, actorOf(req), parsed.data.sourceVersionId));
  });

  // Fills the draft with the official 2026 points rubric. Never publishes.
  router.post('/draft/official', async (req, res) => {
    const parsed = z
      .object({ replaceDraft: z.boolean().optional().default(false) })
      .strict()
      .safeParse(req.body ?? {});
    if (!parsed.success) return invalidShape(res, parsed.error);
    res.json(await loadOfficialRubric(pool, actorOf(req), parsed.data.replaceDraft));
  });

  router.get('/versions/:id', async (req, res) => {
    const id = z.coerce.number().int().positive().safeParse(req.params.id);
    if (!id.success) return invalidShape(res, id.error);
    const version = await loadVersion(pool, id.data);
    if (!version)
      return res
        .status(404)
        .json({ error: { code: 'NOT_FOUND', message: 'Rubric version not found.' } });
    res.json({ version });
  });

  router.put('/draft', async (req, res) => {
    const parsed = saveSchema.safeParse(req.body);
    if (!parsed.success) return invalidShape(res, parsed.error);
    const draft = await saveDraft(pool, actorOf(req), parsed.data.revision, parsed.data.content);
    res.json({ draft });
  });

  router.delete('/draft', async (req, res) => {
    const parsed = discardSchema.safeParse(req.body ?? {});
    if (!parsed.success) return invalidShape(res, parsed.error);
    res.json(await discardDraft(pool, actorOf(req), parsed.data.revision));
  });

  router.post('/draft/publish', async (req, res) => {
    const parsed = publishSchema.safeParse(req.body ?? {});
    if (!parsed.success) return invalidShape(res, parsed.error);
    res.json(
      await publishDraft(
        pool,
        actorOf(req),
        parsed.data.revision,
        parsed.data.confirmExistingEvaluations,
      ),
    );
  });

  return router;
}
