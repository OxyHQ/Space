/**
 * The Postgres handle every `*.pgdb.test.ts` in this folder runs against.
 *
 * ## One database, many files, so EVERY aggregate must be scoped
 *
 * Vitest runs test files in parallel against this single database, and its
 * default sequencer orders files by SIZE — so adding any test file anywhere
 * reshuffles the run order and an unscoped assertion starts failing on a
 * branch that cannot possibly have caused it.
 *
 * The rule that follows is absolute: any assertion that COUNTS, SUMS or lists
 * must be scoped to ids the calling file owns. {@link testUserId} exists to
 * make that cheap — it mints an id carrying the file's own prefix and a random
 * suffix, so no two files and no two runs can collide.
 *
 * Fixture instants are written RELATIVE to `now` for the same class of reason:
 * a hardcoded absolute date in a committed fixture is a time bomb that
 * detonates later, in a sibling file, as a failure that names nothing about
 * its cause.
 */

import { createDatabase, type OxyDatabase } from '@oxyhq/db';
import * as schema from '../../db/schema/index.js';

export type TestDatabase = OxyDatabase<typeof schema>;

/**
 * The billing port's own database. Deliberately NOT the shared `postgres`
 * database on this server: sibling ports run their own suites against the same
 * Postgres instance, and a suite that truncates a table it does not own breaks
 * whichever agent happens to be mid-assertion.
 */
const TEST_DATABASE_URL =
  process.env.BILLING_TEST_DATABASE_URL ??
  'postgres://station:station@127.0.0.1:5439/station_billing';

let handle: { db: TestDatabase; client: ReturnType<typeof createDatabase>['client'] } | null = null;

export function testDb(): TestDatabase {
  if (!handle) handle = createDatabase({ databaseUrl: TEST_DATABASE_URL, schema });
  return handle.db;
}

export async function closeTestDb(): Promise<void> {
  if (!handle) return;
  await handle.client.end();
  handle = null;
}

/**
 * An Oxy-user-shaped id unique to one test file and one run.
 *
 * `prefix` should name the file. The random suffix is what makes a REPEAT run
 * safe: rows from a previous run are still in the database (nothing truncates
 * between runs), so a fixed id would make the second run read the first run's
 * rows and quietly change what every aggregate means.
 */
export function testUserId(prefix: string): string {
  return `${prefix}-${Math.random().toString(36).slice(2, 10)}-${Date.now().toString(36)}`;
}
