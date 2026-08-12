import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    include: ['src/**/__tests__/**/*.test.ts', 'src/**/*.test.ts'],
    /**
     * `*.pgdb.test.ts` needs a real Postgres and runs under `test:pgdb`.
     *
     * Excluded here rather than made to skip itself: a suite that skips when
     * its database is absent reports the same green as one that ran, so the
     * only honest way to exclude it is to take it out of this runner and give
     * it a runner of its own that names it.
     */
    exclude: ['**/node_modules/**', '**/dist/**', 'src/**/*.pgdb.test.ts'],
    coverage: {
      provider: 'v8',
      include: ['src/**/*.ts'],
      exclude: ['src/**/__tests__/**', 'src/**/*.test.ts', 'src/index.ts'],
    },
    // Increase timeout for tests that mock MongoDB
    testTimeout: 10000,
  },
});
