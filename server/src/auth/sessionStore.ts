import session from 'express-session';
import type { Pool, ResultSetHeader, RowDataPacket } from 'mysql2/promise';

type Callback<T = void> = (err?: unknown, value?: T) => void;

/**
 * express-session store backed by the `sessions` table (created by migration
 * 001). Session data stays on the server; the browser only holds a signed,
 * random session id in an httpOnly cookie.
 *
 * Ending a session leaves a tombstone (expires = 0, data = NULL) instead of
 * deleting the row. A request that was already running when the user signed
 * out may still try to save the old session afterwards; the tombstone makes
 * sure that late save can never bring the session back. Tombstones are
 * removed by clearExpired().
 */
export class MySqlSessionStore extends session.Store {
  constructor(
    private readonly pool: Pool,
    private readonly fallbackTtlMs: number,
  ) {
    super();
  }

  private expiresAt(sess: session.SessionData): number {
    const cookieExpires = sess.cookie?.expires ? new Date(sess.cookie.expires).getTime() : NaN;
    const ms = Number.isFinite(cookieExpires) ? cookieExpires : Date.now() + this.fallbackTtlMs;
    return Math.floor(ms / 1000);
  }

  override get(sid: string, cb: Callback<session.SessionData | null>): void {
    this.pool
      .query<RowDataPacket[]>('SELECT data, expires FROM sessions WHERE session_id = ?', [sid])
      .then(([rows]) => {
        const row = rows[0];
        if (!row || row.data === null) return cb(null, null);
        if (Number(row.expires) * 1000 <= Date.now()) {
          return this.destroy(sid, () => cb(null, null));
        }
        try {
          cb(null, JSON.parse(String(row.data)) as session.SessionData);
        } catch {
          this.destroy(sid, () => cb(null, null));
        }
      })
      .catch((error: unknown) => cb(error));
  }

  override set(sid: string, sess: session.SessionData, cb?: Callback): void {
    this.pool
      .query(
        // An ended session (expires = 0) is never revived by a late save.
        `INSERT INTO sessions (session_id, expires, data) VALUES (?, ?, ?)
         ON DUPLICATE KEY UPDATE
           data = IF(expires = 0, data, VALUES(data)),
           expires = IF(expires = 0, 0, VALUES(expires))`,
        [sid, this.expiresAt(sess), JSON.stringify(sess)],
      )
      .then(() => cb?.())
      .catch((error: unknown) => cb?.(error));
  }

  override touch(sid: string, sess: session.SessionData, cb?: Callback): void {
    this.pool
      .query('UPDATE sessions SET expires = ? WHERE session_id = ? AND expires <> 0', [
        this.expiresAt(sess),
        sid,
      ])
      .then(() => cb?.())
      .catch((error: unknown) => cb?.(error));
  }

  override destroy(sid: string, cb?: Callback): void {
    this.pool
      .query('UPDATE sessions SET expires = 0, data = NULL WHERE session_id = ?', [sid])
      .then(() => cb?.())
      .catch((error: unknown) => cb?.(error));
  }

  /** Deletes expired sessions and tombstones; returns how many were removed. */
  async clearExpired(): Promise<number> {
    const [result] = await this.pool.query<ResultSetHeader>(
      'DELETE FROM sessions WHERE expires <= UNIX_TIMESTAMP()',
    );
    return result.affectedRows;
  }
}
