import { createHash, randomBytes } from 'node:crypto';
import { generateDrizzleJson, generateMigration } from 'drizzle-kit/api';
import { createDatabase, DATABASE_CASING, type OxyDatabase } from '@oxyhq/db';
import type postgres from 'postgres';
import * as schema from '../schema/index.js';

/**
 * A real Postgres for `*.pgdb.test.ts`.
 *
 * ## Why the DDL is generated rather than written here
 *
 * A hand-written `CREATE TABLE` in test setup is a re-implementation of the
 * thing under test: the suite would then assert properties of the copy, and a
 * column, default or CHECK missing from the real schema would stay green.
 * `generateMigration` is the same renderer `drizzle-kit generate` uses, driven
 * from `src/db/schema/index.ts` itself, so what these tests run against is what
 * the schema says — including anything the schema gets wrong.
 *
 * It is NOT `drizzle-kit generate`: nothing here writes to `src/drizzle` or its
 * journal. Two agents generating into one journal produces an interleaved
 * journal where a migration is silently skipped.
 *
 * `DATABASE_CASING` is passed explicitly. `generateDrizzleJson` takes it as its
 * FOURTH argument and defaults to no casing, which would create `workspaceid`
 * while every query references `workspace_id` — a whole suite failing with
 * `42703`, or worse, passing against columns nothing else uses.
 *
 * ## Why one shared database rather than one per file
 *
 * Every suite runs against a single database, so every assertion that
 * aggregates MUST be scoped to ids the file owns — `seedWorkspace()` exists to
 * make that the path of least resistance. An unscoped `count(*)` reads a
 * sibling file's rows and fails for a reason that has nothing to do with the
 * change being tested.
 *
 * The rebuild below DROPS those tables, which is why `vitest.pgdb.config.ts`
 * sets `fileParallelism: false`: under parallel workers the first run after a
 * schema edit can drop the tables out from under a sibling file that has
 * already seeded. Running these files through any other config reintroduces
 * that race.
 */

const ADMIN_URL_VARIABLE = 'STATION_TEST_DATABASE_URL';

/**
 * A fixed key for `pg_advisory_lock`, so concurrent vitest workers apply the
 * schema one at a time. Arbitrary, but must not collide with another
 * application's lock on the same server.
 */
const SCHEMA_LOCK_KEY = 4_120_250_812;

/** Where the fingerprint of the currently-applied DDL is recorded. */
const FINGERPRINT_TABLE = 'station_test_schema_fingerprint';

export function testDatabaseUrl(): string {
  const url = process.env[ADMIN_URL_VARIABLE];
  if (!url) {
    throw new Error(
      `${ADMIN_URL_VARIABLE} is required to run *.pgdb.test.ts. These are real-database ` +
        'tests; they are not skipped when it is unset, because a suite that silently ' +
        'skips reports exactly what a passing suite reports. Point it at a Postgres ' +
        'database this may DROP AND RECREATE every table in, e.g. ' +
        'postgres://station:station@127.0.0.1:5439/station_databases',
    );
  }
  return url;
}

/** Every statement `src/db/schema/index.ts` renders to, in order. */
export async function renderSchemaDdl(): Promise<string[]> {
  const empty = generateDrizzleJson({}, undefined, undefined, DATABASE_CASING);
  const current = generateDrizzleJson(schema, undefined, undefined, DATABASE_CASING);
  return generateMigration(empty, current);
}

/** The table names the schema declares, unqualified. */
export function schemaTableNames(): string[] {
  return Object.keys(
    generateDrizzleJson(schema, undefined, undefined, DATABASE_CASING).tables,
  ).map((qualified) => qualified.replace(/^public\./u, ''));
}

let applied: Promise<void> | null = null;

/**
 * Apply the schema, at most once per process and at most once per DDL change
 * across processes.
 *
 * The fingerprint is read INSIDE the advisory lock, which is what makes the
 * rebuild safe under parallel workers: a worker that blocks on the lock while
 * another rebuilds re-reads the fingerprint afterwards, sees a match, and drops
 * nothing out from under the rows that worker has already seeded.
 */
async function applySchema(client: postgres.Sql): Promise<void> {
  const statements = await renderSchemaDdl();
  const fingerprint = createHash('sha256').update(statements.join('\n')).digest('hex');
  const tables = schemaTableNames();

  if (tables.length === 0) {
    throw new Error(
      'The schema rendered zero tables. `generateDrizzleJson` exits cleanly when a ' +
        'schema module fails to load, so an empty render is what a total load failure ' +
        'looks like — not an empty schema.',
    );
  }

  await client.unsafe(`select pg_advisory_lock(${SCHEMA_LOCK_KEY})`);
  try {
    await client.unsafe(
      `create table if not exists ${FINGERPRINT_TABLE} (fingerprint text not null)`,
    );
    const recorded = await client.unsafe(`select fingerprint from ${FINGERPRINT_TABLE} limit 1`);
    if (recorded[0]?.fingerprint === fingerprint) return;

    const quoted = tables.map((name) => `"${name}"`).join(', ');
    await client.unsafe(`drop table if exists ${quoted} cascade`);
    for (const statement of statements) {
      await client.unsafe(statement);
    }
    await client.unsafe(`delete from ${FINGERPRINT_TABLE}`);
    await client.unsafe(`insert into ${FINGERPRINT_TABLE} (fingerprint) values ($1)`, [
      fingerprint,
    ]);
  } finally {
    await client.unsafe(`select pg_advisory_unlock(${SCHEMA_LOCK_KEY})`);
  }
}

export type TestDatabase = OxyDatabase<typeof schema>;

let handle: { db: TestDatabase; client: postgres.Sql } | null = null;

/** The drizzle handle for this worker, with the schema applied. */
export async function getTestDb(): Promise<TestDatabase> {
  handle ??= createDatabase({
    databaseUrl: testDatabaseUrl(),
    schema,
    // `create table if not exists` emits a 42P07 NOTICE on every run after the
    // first. Silenced so a real warning is not lost in it.
    client: { max: 4, onnotice: () => {} },
  });
  applied ??= applySchema(handle.client);
  await applied;
  return handle.db;
}

/** The raw client, for the few assertions that must read catalogue tables. */
export async function getTestClient(): Promise<postgres.Sql> {
  await getTestDb();
  if (!handle) throw new Error('unreachable: getTestDb initialises the handle');
  return handle.client;
}

export async function closeTestDb(): Promise<void> {
  if (!handle) return;
  await handle.client.end({ timeout: 5 });
  handle = null;
  applied = null;
}

/**
 * A prefix no other test file can produce, for every id a file writes.
 *
 * Every `*.pgdb.test.ts` in this package shares ONE database, so an assertion
 * that aggregates over a whole table passes alone and fails beside a sibling —
 * and the pre-existing assertion is usually the bug the new file merely
 * reveals, so the fix is to scope it, never to rename the newcomer's fixtures.
 * Three collisions in one night in a sibling repo each looked like something
 * else: an unscoped sweep count, a duplicate key raised on a fixture, and a
 * `count(*)` that read 2 until another file seeded four more.
 *
 * Tables that hang off a foreign key can scope through {@link seedWorkspace}
 * instead; this is for the ones that do not, where there is no parent row to
 * make ownership structural.
 */
export function testScope(label: string): string {
  return `${label}-${randomBytes(8).toString('hex')}`;
}

/**
 * A workspace row for a test file to hang its own rows off, so every
 * aggregate can be scoped to ids the file owns.
 *
 * `databases.workspaceId` is a real foreign key, so this is not optional
 * bookkeeping — it is the only way to insert a database at all. The name and
 * owner go through {@link testScope} so that two files passing the same label
 * still cannot collide on an assertion that aggregates over `ownerId`.
 */
export async function seedWorkspace(db: TestDatabase, label: string): Promise<string> {
  const scope = testScope(label);
  const [row] = await db
    .insert(schema.workspaces)
    .values({ name: scope, ownerId: `owner-${scope}` })
    .returning({ id: schema.workspaces.id });
  return row.id;
}
