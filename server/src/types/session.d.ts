import 'express-session';
import type { AuthUser } from '@judging/shared';

declare module 'express-session' {
  interface SessionData {
    userId: number;
    /** users.session_epoch when the session was created; a mismatch ends the session. */
    epoch: number;
    /** Epoch milliseconds of sign-in, for the absolute session limit. */
    createdAt: number;
    /** Epoch milliseconds of the last request, for the idle timeout. */
    lastSeen: number;
  }
}

declare global {
  namespace Express {
    interface Request {
      /** Set by loadUser for a valid, active session. */
      user?: AuthUser;
      /** Why a presented session was rejected, if it was. */
      authEnded?: 'SESSION_EXPIRED' | 'NOT_AUTHENTICATED';
    }
  }
}

export {};
