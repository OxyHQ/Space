/**
 * The one Postgres handle for the service.
 *
 * `casing` is passed from `@oxyhq/db` — the same value `drizzle.config.ts`
 * gives drizzle-kit — so what the DDL CREATES and what these queries REFERENCE
 * are derived from one setting rather than two copies that can disagree.
 *
 * Opened lazily so importing a repository in a unit test does not open a
 * connection, and so the process can start and serve `/health/live` before the
 * database is reachable.
 */

import { createDatabase, type OxyDatabase } from '@oxyhq/db';
import * as schema from './schema/index.js';

export type StationDatabase = OxyDatabase<typeof schema>;

/**
 * What a repository function accepts: the pool handle, or the transaction
 * handle `db.transaction(cb)` hands its callback.
 *
 * Derived from `StationDatabase['transaction']` rather than written out as
 * `PgTransaction<PostgresJsQueryResultHKT, typeof schema, ...>`, so it cannot
 * drift from the handle it has to accept. It matters that both are accepted:
 * once a write and a read-back have to commit together, the caller opens one
 * transaction and passes it down — a repository typed to the pool alone
 * silently escapes the caller's transaction.
 */
export type PgHandle = StationDatabase | Parameters<Parameters<StationDatabase['transaction']>[0]>[0];

let handle: { db: StationDatabase; client: ReturnType<typeof createDatabase>['client'] } | null =
  null;

export function getDb(): StationDatabase {
  if (handle) return handle.db;

  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) {
    throw new Error('DATABASE_URL is required.');
  }

  handle = createDatabase({ databaseUrl, schema });
  return handle.db;
}

/**
 * True once a handle exists. Deliberately NOT a reachability check: readiness
 * has to run a real query against the store the service actually reads, or
 * "not connected" and "nothing to do" become the same silent outcome.
 */
export function isDbInitialised(): boolean {
  return handle !== null;
}

export async function closeDb(): Promise<void> {
  if (!handle) return;
  await handle.client.end();
  handle = null;
}
