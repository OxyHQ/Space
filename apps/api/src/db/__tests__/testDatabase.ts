/**
 * The handle `*.pgdb.test.ts` files run against.
 *
 * There is NO default connection string. A pgdb suite that silently falls back
 * to a guessed server is worse than one that refuses to start: "the query
 * returned nothing" and "I connected somewhere empty" look identical, and the
 * first is a bug while the second is a misconfiguration.
 *
 * These files are excluded from the default `test` script and run under
 * `test:pgdb`, because a suite that needs a real Postgres cannot be green on a
 * runner that has none — and a job's presence says nothing about which tests it
 * ran, so the suite gets a runner that names it.
 */

import { randomBytes } from 'node:crypto';
import { createDatabase, type OxyDatabase } from '@oxyhq/db';
import * as schema from '../schema/index.js';

export type TestDatabase = OxyDatabase<typeof schema>;

/**
 * Open a handle on the database named by `STATION_TEST_DATABASE_URL`.
 *
 * The caller closes it with `client.end()` in `afterAll`; leaving it open hangs
 * vitest rather than failing it, which is a far worse symptom to debug.
 */
export function openTestDatabase(): { db: TestDatabase; close: () => Promise<void> } {
  const databaseUrl = process.env.STATION_TEST_DATABASE_URL;
  if (!databaseUrl) {
    throw new Error(
      'STATION_TEST_DATABASE_URL is required for *.pgdb.test.ts. Point it at a ' +
        'Postgres database whose schema is up to date (bunx drizzle-kit push).',
    );
  }
  const { db, client } = createDatabase({ databaseUrl, schema });
  return { db, close: () => client.end() };
}

/**
 * A prefix no other test file can produce, for every id and every user id a
 * file writes.
 *
 * Every `*.pgdb.test.ts` in this package shares ONE database, so an assertion
 * that aggregates over a whole table passes alone and fails beside a sibling —
 * and the pre-existing assertion is usually the bug the new file merely
 * reveals. Scoping to owned ids at the point of writing is what stops that,
 * and it is cheaper than discovering it later from a suite whose failures move
 * whenever someone adds an unrelated file.
 */
export function testScope(label: string): string {
  return `${label}-${randomBytes(8).toString('hex')}`;
}
