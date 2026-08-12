/**
 * Real-database harness for `*.pgdb.test.ts`.
 *
 * Every `*.pgdb.test.ts` file gets its OWN throwaway database, created on the
 * server `TEST_DATABASE_URL` points at and dropped when the file finishes.
 * That is more isolation than a shared database with per-file id scoping, and
 * it removes a failure class rather than asking every future assertion to
 * remember it: vitest orders files by SIZE, so adding any test file anywhere
 * reshuffles the run, and an unscoped aggregate against a shared database then
 * fails on a branch that cannot have caused it.
 *
 * ## The schema is generated, never hand-written
 *
 * DDL comes from `drizzle-kit/api`'s `generateMigration`, given the real schema
 * module — the same machinery `drizzle-kit generate` uses, in process. A
 * hand-written CREATE TABLE in a test fixture is the exact shape of the bug
 * these tests exist to catch: a table that omits a column its writer writes
 * passes `tsc`, passes every read, and silently answers the wrong thing.
 *
 * `drizzle-kit generate` itself is NOT run: the journal under `src/drizzle` is
 * generated once, centrally, and two agents generating against it produces an
 * interleaved journal where one migration is silently skipped.
 */

import { generateDrizzleJson, generateMigration } from 'drizzle-kit/api';
import { createTestDatabase, dropTestDatabase } from '@oxyhq/db/testing';
import { createDatabase, DATABASE_CASING } from '@oxyhq/db';
import * as schema from '../schema/index.js';
import type { StationDatabase } from '../client.js';

/**
 * The server the throwaway database is created on. No default: inventing a
 * connection string would make "the suite ran" and "the suite found a server"
 * the same observation.
 *
 *   TEST_DATABASE_URL=postgres://station:station@127.0.0.1:5439/station_pages_blocks \
 *     bun run --filter @oxystation/api test
 */
export const PGDB_ADMIN_URL = process.env.TEST_DATABASE_URL ?? '';

/**
 * Tables the generated DDL must create. A floor, not an inventory: it exists so
 * that a schema module which fails to load — which makes `generateMigration`
 * return a short statement list rather than throw — cannot be mistaken for a
 * schema with nothing in it.
 */
const REQUIRED_TABLES = ['workspaces', 'workspace_members', 'pages', 'blocks'] as const;

export interface Pgdb {
  db: StationDatabase;
  /** Drops the throwaway database and closes the pool. */
  close: () => Promise<void>;
}

export async function openPgdb(): Promise<Pgdb> {
  const statements = await generateMigration(
    generateDrizzleJson({}),
    generateDrizzleJson(schema, undefined, undefined, DATABASE_CASING),
  );

  for (const table of REQUIRED_TABLES) {
    const created = statements.some((statement) =>
      statement.startsWith(`CREATE TABLE "${table}"`),
    );
    if (!created) {
      throw new Error(
        `pgdb harness generated no CREATE TABLE for "${table}". The schema module ` +
          `did not load, or the table is not reachable from src/db/schema/index.ts.`,
      );
    }
  }

  const databaseUrl = await createTestDatabase({
    adminUrl: PGDB_ADMIN_URL,
    migrate: async (url) => {
      const { client } = createDatabase({ databaseUrl: url, schema });
      try {
        for (const statement of statements) await client.unsafe(statement);
      } finally {
        await client.end();
      }
    },
  });

  const handle = createDatabase({ databaseUrl, schema });
  return {
    db: handle.db,
    close: async () => {
      await handle.client.end();
      await dropTestDatabase(databaseUrl);
    },
  };
}
