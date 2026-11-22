import { Router, type Request } from 'express';
import rateLimit from 'express-rate-limit';
import type { Pool } from 'mysql2/promise';
import { z } from 'zod';
import { AUTH_ERRORS, PASSWORD_MAX_LENGTH } from '@judging/shared';
import { writeAudit } from '../audit.js';
import type { AuthConfig } from '../config.js';
import { cookieOptions, requireAuth, SESSION_COOKIE } from './middleware.js';
import { attemptLogin, changePassword } from './service.js';

const loginSchema = z
  .object({
    email: z.string().trim().min(3).max(254),
    password: z.string().min(1).max(PASSWORD_MAX_LENGTH),
  })
  .strict();

const changeSchema = z
  .object({
    currentPassword: z.string().min(1).max(PASSWORD_MAX_LENGTH),
    newPassword: z.string().min(1).max(PASSWORD_MAX_LENGTH),
  })
  .strict();

function tooMany(minutes: number) {
  return {
    error: {
      code: AUTH_ERRORS.TOO_MANY_ATTEMPTS,
      message: `Too many attempts from this device. Please wait ${minutes} minutes and try again.`,
    },
  };
}

function regenerate(req: Request): Promise<void> {
  return new Promise((resolve, reject) =>
    req.session.regenerate((err) => (err ? reject(err) : resolve())),
  );
}

function save(req: Request): Promise<void> {
  return new Promise((resolve, reject) =>
    req.session.save((err) => (err ? reject(err) : resolve())),
  );
}

export function authRouter(pool: Pool, auth: AuthConfig): Router {
  const router = Router();

  // Per-IP limit on failed sign-ins (the per-account lockout is in the service).
  const loginLimiter = rateLimit({
    windowMs: 15 * 60_000,
    limit: auth.loginRateLimit,
    skipSuccessfulRequests: true,
    standardHeaders: 'draft-8',
    legacyHeaders: false,
    handler: (_req, res) => res.status(429).json(tooMany(15)),
  });
  const changeLimiter = rateLimit({
    windowMs: 15 * 60_000,
    limit: 10,
    skipSuccessfulRequests: true,
    standardHeaders: 'draft-8',
    legacyHeaders: false,
    handler: (_req, res) => res.status(429).json(tooMany(15)),
  });

  router.post('/login', loginLimiter, async (req, res, next) => {
    try {
      const parsed = loginSchema.safeParse(req.body);
      if (!parsed.success) {
        res.status(400).json({
          error: { code: 'VALIDATION_ERROR', message: 'Enter your e-mail and password.' },
        });
        return;
      }
      const result = await attemptLogin(
        pool,
        { ...parsed.data, ip: req.ip },
        { lockoutThreshold: auth.lockoutThreshold, lockoutMinutes: auth.lockoutMinutes },
      );
      if (!result.ok) {
        if (result.reason === 'locked') {
          const minutes = Math.max(1, Math.ceil(result.retryAfterSeconds / 60));
          res.set('Retry-After', String(result.retryAfterSeconds));
          res.status(423).json({
            error: {
              code: AUTH_ERRORS.ACCOUNT_LOCKED,
              message: `Too many failed sign-in attempts. This account is locked for ${minutes} minute${minutes === 1 ? '' : 's'}.`,
            },
          });
        } else if (result.reason === 'disabled') {
          res.status(403).json({
            error: {
              code: AUTH_ERRORS.ACCOUNT_DISABLED,
              message: 'This account has been disabled. Contact the competition administrator.',
            },
          });
        } else {
          res.status(401).json({
            error: {
              code: AUTH_ERRORS.INVALID_CREDENTIALS,
              message: 'Incorrect e-mail or password.',
            },
          });
        }
        return;
      }
      // New session id on sign-in (prevents session fixation).
      await regenerate(req);
      req.session.userId = result.user.id;
      req.session.epoch = result.epoch;
      req.session.createdAt = Date.now();
      req.session.lastSeen = req.session.createdAt;
      await save(req);
      res.json({ user: result.user });
    } catch (error) {
      next(error);
    }
  });

  router.get('/me', requireAuth, (req, res) => {
    res.json({ user: req.user });
  });

  router.post('/logout', async (req, res, next) => {
    try {
      if (req.user) {
        await writeAudit(pool, {
          actorId: req.user.id,
          actorEmail: req.user.email,
          action: 'auth.logout',
          entityType: 'user',
          entityId: req.user.id,
          ipAddress: req.ip,
        });
      }
      await new Promise<void>((resolve) =>
        req.session ? req.session.destroy(() => resolve()) : resolve(),
      );
      res.clearCookie(SESSION_COOKIE, cookieOptions(auth));
      res.status(204).end();
    } catch (error) {
      next(error);
    }
  });

  router.post('/change-password', changeLimiter, requireAuth, async (req, res, next) => {
    try {
      const parsed = changeSchema.safeParse(req.body);
      if (!parsed.success) {
        res.status(400).json({
          error: { code: 'VALIDATION_ERROR', message: 'Enter your current and new password.' },
        });
        return;
      }
      const user = req.user!;
      const result = await changePassword(pool, { userId: user.id, ...parsed.data, ip: req.ip });
      if (!result.ok) {
        if (result.reason === 'current_incorrect') {
          res.status(400).json({
            error: {
              code: AUTH_ERRORS.CURRENT_PASSWORD_INCORRECT,
              message: 'Your current password is incorrect.',
            },
          });
        } else {
          res.status(400).json({
            error: {
              code: AUTH_ERRORS.WEAK_PASSWORD,
              message: `The new password ${result.problems.join(', ')}.`,
            },
            problems: result.problems,
          });
        }
        return;
      }
      // Keep this browser signed in on a fresh session; all others are ended by the new epoch.
      await regenerate(req);
      req.session.userId = user.id;
      req.session.epoch = result.epoch;
      req.session.createdAt = Date.now();
      req.session.lastSeen = req.session.createdAt;
      await save(req);
      res.json({ user: { ...user, mustChangePassword: false } });
    } catch (error) {
      next(error);
    }
  });

  return router;
}
