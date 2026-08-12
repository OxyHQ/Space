import { defineConfig } from 'vitest/config';

/**
 * The runner for `*.pgdb.test.ts` — the suites that talk to a real Postgres.
 *
 * A separate config rather than a flag on the default one, so that "which job
 * ran the real-database tests" has a single answer. `STATION_TEST_DATABASE_URL`
 * must name a database whose schema is current; `src/db/__tests__/testDatabase.ts`
 * refuses to invent one.
 */
export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    include: ['src/**/*.pgdb.test.ts'],
    // These files share one database and scope their writes to owned ids; the
    // expiry sweep is the exception and says so at its own assertions.
    testTimeout: 30000,
  },
});
