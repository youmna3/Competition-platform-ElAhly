import { Router } from 'express';
import type { Pool } from 'mysql2/promise';
import { z } from 'zod';
import { REPORT_KINDS, type ReportFilters } from '@judging/shared';
import { buildReport } from './service.js';
import { encodeCsv, encodeXlsx } from './format.js';
const positive = z.coerce.number().int().positive().max(4_294_967_295).optional();
const schema = z
  .object({
    format: z.enum(['xlsx', 'csv']).default('xlsx'),
    sheet: z.string().max(31).optional(),
    teamId: positive,
    judgeId: positive,
    version: positive,
    status: z.enum(['draft', 'submitted']).optional(),
    from: z.iso.datetime().optional(),
    to: z.iso.datetime().optional(),
  })
  .strict()
  .refine((q) => !q.from || !q.to || q.from <= q.to, { message: 'From must be before To.' });
/** Mounted inside adminRouter, after requireAuth and requireRole('admin'). */
export function reportsRouter(pool: Pool) {
  const router = Router();
  let generating = false;
  router.get('/:kind', async (req, res) => {
    const kind = z.enum(REPORT_KINDS).safeParse(req.params.kind),
      parsed = schema.safeParse(req.query);
    if (!kind.success || !parsed.success)
      return res.status(400).json({
        error: {
          code: 'VALIDATION_ERROR',
          message: 'Choose a valid report, format and filters.',
        },
      });
    const { format, sheet, ...filters } = parsed.data;
    const applicable: Record<typeof kind.data, (keyof ReportFilters)[]> = {
      results: ['teamId', 'judgeId', 'version'],
      progress: ['teamId', 'judgeId'],
      evaluations: ['teamId', 'judgeId', 'version', 'status', 'from', 'to'],
      corrections: ['teamId', 'judgeId', 'version', 'from', 'to'],
      rubrics: ['version'],
    };
    if (
      Object.keys(filters).some(
        (key) => !applicable[kind.data].includes(key as keyof ReportFilters),
      )
    )
      return res.status(400).json({
        error: { code: 'VALIDATION_ERROR', message: 'A filter does not apply to this report.' },
      });
    if (generating)
      return res.status(429).json({
        error: {
          code: 'REPORT_BUSY',
          message: 'Another export is being generated. Try again shortly.',
        },
      });
    generating = true;
    try {
      const report = await buildReport(pool, kind.data, filters),
        buffer = format === 'xlsx' ? encodeXlsx(report) : encodeCsv(report, sheet);
      res.set({
        'Cache-Control': 'no-store',
        'Content-Disposition': `attachment; filename="ischool-${kind.data}-${report.generatedAt.slice(0, 10)}.${format}"`,
        'Content-Type':
          format === 'xlsx'
            ? 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
            : 'text/csv; charset=utf-8',
        'X-Content-Type-Options': 'nosniff',
      });
      res.send(buffer);
    } finally {
      generating = false;
    }
  });
  return router;
}
