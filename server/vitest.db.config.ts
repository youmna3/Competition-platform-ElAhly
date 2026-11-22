import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    include: ['test/**/*.db.test.ts'],
    testTimeout: 30_000,
    hookTimeout: 60_000,
    // The database tests share one scratch database, so they run one file at a time.
    fileParallelism: false,
  },
});
