import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    include: ['test/**/*.test.ts'],
    // Real-database tests need XAMPP MySQL running; they run with `npm run test:db`.
    exclude: ['test/**/*.db.test.ts', '**/node_modules/**'],
  },
});
