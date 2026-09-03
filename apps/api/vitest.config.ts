import { configDefaults, defineConfig } from 'vitest/config';

/**
 * `*.pgdb.test.ts` needs a real Postgres and is NOT part of the default run.
 *
 * Those files refuse to run without `STATION_TEST_DATABASE_URL` rather than
 * skipping, because a suite that silently skips reports exactly what a passing
 * suite reports — so they cannot simply be left in a run that has no database.
 * `bun run test:pgdb` is how they are run.
 *
 * THIS SPLIT MAKES THEM INERT UNTIL CI RUNS THAT SCRIPT. A mechanism can be
 * green and inert at once; `.github/workflows/ci.yml` needs a job with a
 * `postgres:17-alpine` service that runs `test:pgdb`, or the real-database
 * coverage exists and proves nothing.
 */
const PGDB_TESTS = '**/*.pgdb.test.ts';

export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    include: ['src/**/__tests__/**/*.test.ts', 'src/**/*.test.ts'],
    // `exclude` REPLACES vitest's defaults rather than adding to them, so the
    // defaults (node_modules, dist, ...) are spread back in explicitly.
    exclude: [...configDefaults.exclude, PGDB_TESTS],
    coverage: {
      provider: 'v8',
      include: ['src/**/*.ts'],
      exclude: ['src/**/__tests__/**', 'src/**/*.test.ts', 'src/index.ts'],
    },
    // Leave enough time for subprocess-backed boundary checks on slower CI runners.
    testTimeout: 10000,
  },
});
