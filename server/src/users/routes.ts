import { Router, type NextFunction, type Response } from 'express';
import type { Pool } from 'mysql2/promise';
import { z } from 'zod';
import {
  createUser,
  listUsers,
  resetUserPassword,
  updateUser,
  UserError,
  type Actor,
} from './service.js';

const fullName = z
  .string()
  .trim()
  .min(2, 'Enter the full name (at least 2 characters).')
  .max(200, 'The name is too long (200 characters at most).')
  .refine((v) => !/[\p{Cc}<>]/u.test(v), 'The name contains characters that are not allowed.');
const email = z
  .string()
  .trim()
  .toLowerCase()
  .max(254, 'The e-mail address is too long.')
  .pipe(z.email('Enter a valid e-mail address.'));
const role = z.enum(['admin', 'judge'], { message: 'Role must be Admin or Judge.' });
const status = z.enum(['active', 'disabled'], { message: 'Status must be Active or Disabled.' });

const createSchema = z.object({ fullName, email, role: role.default('judge') }).strict();
const updateSchema = z
  .object({
    fullName: fullName.optional(),
    email: email.optional(),
    role: role.optional(),
    status: status.optional(),
  })
  .strict()
  .refine((v) => Object.keys(v).length > 0, 'Nothing to change.');
const listSchema = z
  .object({
    search: z.string().trim().max(100).optional(),
    role: role.optional(),
    status: status.optional(),
    page: z.coerce.number().int().min(1).max(10_000).default(1),
    pageSize: z.coerce.number().int().min(1).max(100).default(50),
  })
  .strict();
const idSchema = z.coerce.number().int().positive().max(4_294_967_295);

function validationError(res: Response, error: z.ZodError) {
  const first = error.issues[0];
  res.status(400).json({
    error: {
      code: 'VALIDATION_ERROR',
      message: first?.message ?? 'Some of the details are not valid.',
    },
    fields: Object.fromEntries(error.issues.map((i) => [i.path.join('.') || 'form', i.message])),
  });
}

function handle(error: unknown, res: Response, next: NextFunction) {
  if (error instanceof UserError) {
    res.status(error.status).json({ error: { code: error.code, message: error.message } });
    return;
  }
  next(error);
}

/** /api/admin/users — mounted inside the admin router (sign-in + admin role required). */
export function usersRouter(pool: Pool): Router {
  const router = Router();
  const actorOf = (req: { user?: { id: number; email: string }; ip?: string }): Actor => ({
    id: req.user!.id,
    email: req.user!.email,
    ip: req.ip,
  });

  router.get('/', async (req, res, next) => {
    const parsed = listSchema.safeParse(req.query);
    if (!parsed.success) return validationError(res, parsed.error);
    try {
      res.json(await listUsers(pool, { ...parsed.data, search: parsed.data.search || undefined }));
    } catch (error) {
      handle(error, res, next);
    }
  });

  router.post('/', async (req, res, next) => {
    const parsed = createSchema.safeParse(req.body);
    if (!parsed.success) return validationError(res, parsed.error);
    try {
      res.status(201).json(await createUser(pool, actorOf(req), parsed.data));
    } catch (error) {
      handle(error, res, next);
    }
  });

  router.patch('/:id', async (req, res, next) => {
    const id = idSchema.safeParse(req.params.id);
    if (!id.success) return validationError(res, id.error);
    const parsed = updateSchema.safeParse(req.body);
    if (!parsed.success) return validationError(res, parsed.error);
    try {
      res.json({ user: await updateUser(pool, actorOf(req), id.data, parsed.data) });
    } catch (error) {
      handle(error, res, next);
    }
  });

  router.post('/:id/reset-password', async (req, res, next) => {
    const id = idSchema.safeParse(req.params.id);
    if (!id.success) return validationError(res, id.error);
    try {
      res.json(await resetUserPassword(pool, actorOf(req), id.data));
    } catch (error) {
      handle(error, res, next);
    }
  });

  return router;
}
