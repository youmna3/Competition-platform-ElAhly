import type { RequestHandler } from 'express';
import session from 'express-session';
import type { Pool } from 'mysql2/promise';
import { AUTH_ERRORS, type UserRole } from '@judging/shared';
import type { AuthConfig } from '../config.js';
import { loadSessionUser } from './service.js';
import { MySqlSessionStore } from './sessionStore.js';

export const SESSION_COOKIE = 'jp.sid';

export function cookieOptions(auth: AuthConfig) {
  return {
    httpOnly: true,
    sameSite: 'strict' as const,
    secure: auth.cookieSecure,
    path: '/',
  };
}

/** Server-side sessions in MySQL with a signed, httpOnly, SameSite=Strict cookie. */
export function sessionMiddleware(auth: AuthConfig, store: MySqlSessionStore): RequestHandler {
  if (!auth.sessionSecret) throw new Error('SESSION_SECRET is required to enable sign-in');
  return session({
    name: SESSION_COOKIE,
    secret: auth.sessionSecret,
    store,
    resave: false,
    saveUninitialized: false, // no cookie until someone signs in
    // The cookie lasts until the absolute limit; the idle timeout is enforced on
    // the server (loadUser), so an idle session is reported as "ended" instead
    // of silently disappearing from the browser.
    rolling: false,
    unset: 'destroy',
    // +10 minutes of grace so an ended session can still be reported as ended.
    cookie: { ...cookieOptions(auth), maxAge: auth.maxSessionMs + 10 * 60_000 },
  });
}

function hasSessionCookie(cookieHeader: string | undefined): boolean {
  return (
    !!cookieHeader && cookieHeader.split(';').some((c) => c.trim().startsWith(`${SESSION_COOKIE}=`))
  );
}

/**
 * Resolves req.user from the session on every request. The user row is read
 * fresh each time, so a disabled account, a password reset or a role change
 * takes effect immediately. Sessions past the absolute limit are ended.
 */
export function loadUser(pool: Pool, auth: AuthConfig): RequestHandler {
  return async (req, res, next) => {
    try {
      const s = req.session;
      if (!s?.userId) {
        // A cookie was sent but no session matched: it expired or was ended.
        if (hasSessionCookie(req.headers.cookie)) req.authEnded = AUTH_ERRORS.SESSION_EXPIRED;
        return next();
      }
      const now = Date.now();
      const tooOld = !s.createdAt || now - s.createdAt > auth.maxSessionMs;
      const idle = now - (s.lastSeen ?? s.createdAt ?? 0) > auth.idleTimeoutMs;
      const user = tooOld || idle ? null : await loadSessionUser(pool, s.userId, s.epoch ?? -1);
      if (!user) {
        req.authEnded = AUTH_ERRORS.SESSION_EXPIRED;
        await new Promise<void>((resolve) => s.destroy(() => resolve()));
        res.clearCookie(SESSION_COOKIE, cookieOptions(auth));
        return next();
      }
      req.user = user;
      // Record activity (throttled so most requests don't write to the database).
      if (now - (s.lastSeen ?? 0) > Math.min(15_000, auth.idleTimeoutMs / 4)) s.lastSeen = now;
      next();
    } catch (error) {
      next(error);
    }
  };
}

const PASSWORD_CHANGE_ALLOWED = new Set([
  '/api/auth/me',
  '/api/auth/logout',
  '/api/auth/change-password',
]);

/** 401 without a valid session; 403 until a required password change is done. */
export const requireAuth: RequestHandler = (req, res, next) => {
  if (!req.user) {
    const code = req.authEnded ?? AUTH_ERRORS.NOT_AUTHENTICATED;
    res.status(401).json({
      error: {
        code,
        message:
          code === AUTH_ERRORS.SESSION_EXPIRED
            ? 'Your session has ended. Please sign in again.'
            : 'Please sign in.',
      },
    });
    return;
  }
  if (req.user.mustChangePassword && !PASSWORD_CHANGE_ALLOWED.has(req.baseUrl + req.path)) {
    res.status(403).json({
      error: {
        code: AUTH_ERRORS.PASSWORD_CHANGE_REQUIRED,
        message: 'You must change your password before continuing.',
      },
    });
    return;
  }
  next();
};

/** Server-side role check. Use after requireAuth. */
export function requireRole(...roles: UserRole[]): RequestHandler {
  return (req, res, next) => {
    if (!req.user || !roles.includes(req.user.role)) {
      res.status(403).json({
        error: { code: AUTH_ERRORS.FORBIDDEN, message: 'You do not have access to this.' },
      });
      return;
    }
    next();
  };
}

/**
 * CSRF defence in depth (on top of SameSite=Strict cookies): state-changing
 * requests from a browser must come from this same origin.
 */
export const sameOriginOnly: RequestHandler = (req, res, next) => {
  if (req.method === 'GET' || req.method === 'HEAD' || req.method === 'OPTIONS') return next();
  const fetchSite = req.get('sec-fetch-site');
  const origin = req.get('origin');
  let originHost: string | null;
  try {
    originHost = origin ? new URL(origin).host : null;
  } catch {
    originHost = 'invalid';
  }
  if (fetchSite === 'cross-site' || (originHost !== null && originHost !== req.get('host'))) {
    res.status(403).json({
      error: {
        code: AUTH_ERRORS.ORIGIN_MISMATCH,
        message: 'This request did not come from the judging platform.',
      },
    });
    return;
  }
  next();
};
