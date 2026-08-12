/**
 * Real-database harness for the `*.pgdb.test.ts` suites.
 *
 * These tests run against a real Postgres server because every divergence this
 * port had to decide — an `ON CONFLICT` upsert, a CHECK that rejects only
 * FALSE, `count(*)` arriving as a string, a `$set` key that must not become
 * NULL — is invisible to a mock. A mock would agree with whatever the
 * repository does.
 *
 * The schema is DERIVED from the drizzle table objects rather than hand-written
 * here. Hand-written DDL is a second copy of the schema that drifts silently:
 * it stays green while the tables it describes stop matching the ones
 * production creates, so the suite would keep passing against a schema nobody
 * ships. `drizzle-kit`'s own generator, given `DATABASE_CASING` — the same
 * value `drizzle.config.ts` passes — produces exactly the DDL a migration
 * would.
 */

import { generateDrizzleJson, generateMigration } from 'drizzle-kit/api';
import { DATABASE_CASING } from '@oxyhq/db';
import postgres from 'postgres';
import { getDb, closeDb, type StationDatabase } from '../../db/client.js';
import * as schema from '../../db/schema/index.js';

/**
 * The server this agent was given. Its maintenance database — never a target
 * for the schema, only the place `CREATE DATABASE` is issued from.
 */
const ADMIN_URL = process.env.PGDB_ADMIN_URL ?? 'postgres://station:station@127.0.0.1:5439/postgres';

/** This domain's own database, kept separate from every sibling port's. */
const TEST_DATABASE = 'station_ai_chat';

export const TEST_DATABASE_URL = ADMIN_URL.replace(/\/[^/]*$/, `/${TEST_DATABASE}`);

/**
 * An arbitrary but fixed key for the advisory lock that serialises schema
 * creation. Test FILES run in parallel and each calls `setupPgDatabase`, so
 * without it two of them race between "do the tables exist" and "create them"
 * and the loser fails with 42P07.
 */
const SCHEMA_LOCK_KEY = 728_140_301;

/** Tables this harness is responsible for creating. */
const EXPECTED_TABLES = ['conversations', 'messages', 'workspaces', 'workspace_members'] as const;

async function ensureDatabaseExists(): Promise<void> {
  const admin = postgres(ADMIN_URL, { max: 1 });
  try {
    const existing = await admin`select 1 from pg_database where datname = ${TEST_DATABASE}`;
    if (existing.length === 0) {
      // `CREATE DATABASE` cannot be parameterised or run in a transaction.
      await admin.unsafe(`create database "${TEST_DATABASE}"`);
    }
  } catch (error) {
    // 42P04 — another test file created it between the check and the create.
    // Any other error is real and must not be swallowed.
    if ((error as { code?: string }).code !== '42P04') throw error;
  } finally {
    await admin.end();
  }
}

async function ensureSchemaApplied(): Promise<void> {
  const client = postgres(TEST_DATABASE_URL, { max: 1 });
  try {
    await client`select pg_advisory_lock(${SCHEMA_LOCK_KEY})`;
    try {
      const present = await client`
        select tablename from pg_tables
        where schemaname = 'public' and tablename = any(${client.array([...EXPECTED_TABLES])})
      `;
      if (present.length === EXPECTED_TABLES.length) return;

      const empty = generateDrizzleJson({}, undefined, undefined, DATABASE_CASING);
      const current = generateDrizzleJson(
        schema as unknown as Record<string, unknown>,
        undefined,
        undefined,
        DATABASE_CASING,
      );
      const statements = await generateMigration(empty, current);

      /**
       * A generator that loaded nothing exits happily and emits nothing, which
       * is indistinguishable from "there was nothing to do". So the DDL is
       * refused rather than partially applied when the schema did not load.
       *
       * The test is a SUBSET check plus a floor, not an equality against
       * `EXPECTED_TABLES`. Equality was correct when this harness was the only
       * thing in the schema and became wrong the moment a sibling domain
       * landed: the module now renders every table in the service, so the
       * count went 4 -> 34 and the guard refused the CORRECT schema, taking
       * two files and 46 assertions down with it — silently, because a suite
       * that fails to load reports `Tests 0 failed`, not a red assertion.
       *
       * The floor is what actually catches a partial load: zero rendered
       * tables is exactly what a schema module that threw on import produces.
       * The subset check catches the narrower case where the module loaded but
       * this harness's own tables are missing from it.
       */
      const created = statements.filter((s) => s.startsWith('CREATE TABLE'));
      if (created.length === 0) {
        throw new Error(
          'Schema generation produced no CREATE TABLE statements at all. The schema module did not load; refusing to apply an empty schema.',
        );
      }
      const missing = EXPECTED_TABLES.filter(
        (table) => !created.some((statement) => statement.includes(`"${table}"`)),
      );
      if (missing.length > 0) {
        throw new Error(
          `Schema generation rendered ${created.length} tables but not ${missing.join(', ')}, which this harness's tests require. Refusing to apply a partial schema.`,
        );
      }

      for (const statement of statements) {
        await client.unsafe(statement);
      }
    } finally {
      await client`select pg_advisory_unlock(${SCHEMA_LOCK_KEY})`;
    }
  } finally {
    await client.end();
  }
}

/**
 * Create the database and schema if absent, point `DATABASE_URL` at it, and
 * return the handle `getDb()` hands the repositories.
 *
 * Deliberately returns the handle from `getDb()` rather than a separately
 * constructed one: the repositories fall back to `getDb()` when no handle is
 * passed, so this exercises the same client construction — schema, casing and
 * all — that the service uses, instead of a parallel one that could differ.
 */
export async function setupPgDatabase(): Promise<StationDatabase> {
  await ensureDatabaseExists();
  await ensureSchemaApplied();
  process.env.DATABASE_URL = TEST_DATABASE_URL;
  return getDb();
}

export async function teardownPgDatabase(): Promise<void> {
  await closeDb();
}

/**
 * A prefix no other test file uses, so that every fixture row this file writes
 * is one it owns.
 *
 * Every aggregate in these suites — a count, a list, a delete's row count — is
 * filtered to ids carrying this prefix. Unscoped aggregates against a shared
 * database are the single most reliable way to write a test that passes alone
 * and fails the moment a sibling file seeds a row, and the failure names
 * nothing about its cause. Sharing one database is exactly the condition that
 * makes it happen.
 */
export function scopedIds(fileTag: string): {
  user: (name: string) => string;
  conversation: (name: string) => string;
} {
  const prefix = `${fileTag}-${process.pid}-${Date.now().toString(36)}`;
  return {
    user: (name) => `u-${prefix}-${name}`,
    conversation: (name) => `c-${prefix}-${name}`,
  };
}
