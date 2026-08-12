import { defineConfig } from 'vitest/config';

/**
 * The real-database run: `bun run test:pgdb`.
 *
 * `fileParallelism: false` is load-bearing, not tidiness. Every `*.pgdb.test.ts`
 * shares one database, and the schema is applied by whichever worker first sees
 * a fingerprint it does not recognise — which DROPS the tables. Under parallel
 * workers the first run after any schema edit can drop them out from under a
 * sibling file that has already seeded its rows, which surfaces as a failure in
 * a file that has nothing to do with the change. Measured: mutating one CHECK
 * turned a 1-failure run into a file that reported no tests at all, and the same
 * mutation under this config fails exactly the one assertion it should.
 *
 * Running the files in one worker also means the module-level "schema applied"
 * promise in `src/db/__tests__/testDatabase.ts` is shared, so the schema is
 * applied exactly once per run.
 */
export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    include: ['src/**/*.pgdb.test.ts'],
    fileParallelism: false,
    testTimeout: 30000,
  },
});
