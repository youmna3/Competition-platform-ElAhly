import { Router } from 'express';
import rateLimit from 'express-rate-limit';
import type { Pool } from 'mysql2/promise';
import { z } from 'zod';
import { RESET_ADMIN_EMAIL } from '@judging/shared';
import { competitionStatus, transitionCompetition } from './service.js';
import type { CompetitionReset } from './reset.js';
import { RuleError } from '../errors.js';

export function competitionRouter(pool: Pool, maintenance?: CompetitionReset) {
  const router = Router();
  router.get('/', async (_req, res) =>
    res.json({
      ...(await competitionStatus(pool)),
      resetExecutionEnabled: maintenance?.executionEnabled ?? false,
      maintenanceAvailable: !!maintenance,
    }),
  );
  router.post('/transition', async (req, res) => {
    const parsed = z
      .object({
        target: z.enum(['judging_open', 'closed']),
        rowVersion: z.number().int().positive(),
        confirmed: z.literal(true),
      })
      .strict()
      .safeParse(req.body);
    if (!parsed.success)
      throw new RuleError(
        400,
        'VALIDATION_ERROR',
        'A valid transition, current version and confirmation are required.',
      );
    res.json(
      await transitionCompetition(pool, req.user!, parsed.data.target, parsed.data.rowVersion),
    );
  });
  router.use(
    '/reset',
    rateLimit({
      windowMs: 15 * 60_000,
      limit: 5,
      standardHeaders: 'draft-8',
      legacyHeaders: false,
    }),
    (req, _res, next) => {
      if (req.user?.role !== 'admin' || req.user.email.toLowerCase() !== RESET_ADMIN_EMAIL)
        throw new RuleError(
          403,
          'FORBIDDEN',
          'Only the authorized reset administrator may request a reset.',
        );
      if (!maintenance)
        throw new RuleError(
          503,
          'MAINTENANCE_UNAVAILABLE',
          'Maintenance configuration is unavailable.',
        );
      next();
    },
  );
  router.post('/reset/preview', async (req, res) => {
    const parsed = z
      .object({ password: z.string().min(1).max(72) })
      .strict()
      .safeParse(req.body);
    if (!parsed.success)
      throw new RuleError(400, 'VALIDATION_ERROR', 'Enter your current password.');
    res.json(await maintenance!.prepare(req.user!, req.sessionID, parsed.data.password));
  });
  router.post('/reset/execute', async (req, res) => {
    const parsed = z
      .object({
        token: z.string().regex(/^[a-f0-9]{64}$/),
        password: z.string().min(1).max(72),
        phrase: z.string(),
        confirmed: z.literal(true),
      })
      .strict()
      .safeParse(req.body);
    if (!parsed.success)
      throw new RuleError(
        400,
        'VALIDATION_ERROR',
        'Reset requires a preview, password, exact phrase and final confirmation.',
      );
    const result = await maintenance!.execute(req.user!, req.sessionID, parsed.data);
    await new Promise<void>((resolve, reject) =>
      req.session.destroy((err) => (err ? reject(err) : resolve())),
    );
    res.json(result);
  });
  return router;
}
