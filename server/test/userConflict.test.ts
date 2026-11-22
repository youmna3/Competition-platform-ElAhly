import { describe, expect, it, vi } from 'vitest';
import type { Pool } from 'mysql2/promise';
import { updateUser } from '../src/users/service.js';

describe('concurrent administrator account changes', () => {
  it.each(['ER_LOCK_DEADLOCK', 'ER_LOCK_WAIT_TIMEOUT'])(
    'rolls back %s and returns a conflict rather than HTTP 500',
    async (code) => {
      const conn = {
        beginTransaction: vi.fn(),
        query: vi.fn().mockRejectedValue(Object.assign(new Error('Concurrent update'), { code })),
        rollback: vi.fn().mockResolvedValue(undefined),
        release: vi.fn(),
      };
      const pool = { getConnection: vi.fn().mockResolvedValue(conn) } as unknown as Pool;
      await expect(
        updateUser(pool, { id: 1, email: 'admin@example.com' }, 2, { status: 'disabled' }),
      ).rejects.toMatchObject({ status: 409, code: 'USER_CONFLICT' });
      expect(conn.rollback).toHaveBeenCalledOnce();
      expect(conn.release).toHaveBeenCalledOnce();
    },
  );
});
