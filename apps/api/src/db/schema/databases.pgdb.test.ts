import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { sql } from 'drizzle-orm';
import { CHECK_VIOLATION, constraintNameOf, sqlStateOf } from '@oxyhq/db';
import type postgres from 'postgres';
import {
  closeTestDb,
  getTestClient,
  getTestDb,
  renderSchemaDdl,
  seedWorkspace,
  type TestDatabase,
} from '../__tests__/testDatabase.js';
import {
  DATABASE_PROPERTY_TYPES,
  DATABASE_VIEW_TYPES,
  SORT_DIRECTIONS,
  databaseViews,
  databases,
} from './databases.js';

/**
 * What the `databases` / `database_views` tables enforce, asserted against a
 * real server.
 *
 * Everything here is about a failure that CANNOT surface functionally: a CHECK
 * that admits what it exists to reject, a default that differs from Mongoose's,
 * an index that is simply absent. A route test would pass in every one of those
 * cases.
 */

let db: TestDatabase;
let client: postgres.Sql;
let workspaceId: string;

/**
 * Insert `properties_schema` as raw SQL text rather than through drizzle.
 *
 * The point of these cases is to hand the CHECK a document TypeScript would
 * refuse to build, so the value cannot go through a typed insert. It also
 * sidesteps a real trap: postgres.js infers a `jsonb` parameter's type from the
 * statement and then JSON-ENCODES a JS string, so a bound `'{"properties":[]}'`
 * arrives as the JSON scalar `"{\"properties\":[]}"` and every predicate reads
 * the comfortable way round. Literal SQL is what the constraint actually sees.
 */
async function insertRawSchema(document: string): Promise<void> {
  await client.unsafe(
    `insert into databases (id, workspace_id, owner_id, properties_schema)
     values (gen_random_uuid()::text, '${workspaceId}', 'owner', '${document}'::jsonb)`,
  );
}

async function insertRawSorts(document: string): Promise<void> {
  const [database] = await db
    .insert(databases)
    .values({ workspaceId, ownerId: 'owner' })
    .returning({ id: databases.id });
  await client.unsafe(
    `insert into database_views (id, database_id, sorts)
     values (gen_random_uuid()::text, '${database.id}', '${document}'::jsonb)`,
  );
}

async function violation(run: () => Promise<unknown>): Promise<string> {
  try {
    await run();
  } catch (error: unknown) {
    if (sqlStateOf(error) !== CHECK_VIOLATION) {
      throw new Error(
        `expected a CHECK violation, got SQLSTATE ${String(sqlStateOf(error))}: ${String(error)}`,
      );
    }
    return constraintNameOf(error) ?? '(unnamed)';
  }
  throw new Error('expected the write to be rejected, but it was accepted');
}

beforeAll(async () => {
  db = await getTestDb();
  client = await getTestClient();
  workspaceId = await seedWorkspace(db, 'schema-checks');
});

afterAll(async () => {
  await closeTestDb();
});

describe('databases_property_types', () => {
  it('accepts every value in DATABASE_PROPERTY_TYPES', async () => {
    // The positive control for the rejections below: if the CHECK rejected
    // everything, or the insert path were broken, this fails first.
    expect(DATABASE_PROPERTY_TYPES.length).toBe(19);
    for (const type of DATABASE_PROPERTY_TYPES) {
      await expect(
        insertRawSchema(`{"properties":[{"id":"p","name":"P","type":"${type}"}]}`),
      ).resolves.toBeUndefined();
    }
  });

  it('rejects a property type outside the list', async () => {
    expect(
      await violation(() =>
        insertRawSchema('{"properties":[{"id":"p","name":"P","type":"nope"}]}'),
      ),
    ).toBe('databases_property_types');
  });

  it('accepts an empty property list — the column default and a real state', async () => {
    await expect(insertRawSchema('{"properties":[]}')).resolves.toBeUndefined();
  });
});

describe('databases_properties_schema_shape', () => {
  /**
   * `jsonb_typeof(doc->'properties')` is NULL when the key is absent, and a
   * CHECK rejects only FALSE — so without the `coalesce` this document is
   * ACCEPTED. That is the whole reason the coalesce is there.
   */
  it('rejects a document with no properties key at all', async () => {
    expect(await violation(() => insertRawSchema('{}'))).toBe(
      'databases_properties_schema_shape',
    );
  });

  it('rejects properties that is not an array', async () => {
    expect(await violation(() => insertRawSchema('{"properties":"nope"}'))).toBe(
      'databases_properties_schema_shape',
    );
    expect(await violation(() => insertRawSchema('{"properties":null}'))).toBe(
      'databases_properties_schema_shape',
    );
  });

  /**
   * The enum check alone cannot see this: `$.properties[*].type` selects
   * nothing when there is no `type` key, so it reports no violation.
   */
  it('rejects a property with no type key', async () => {
    expect(
      await violation(() => insertRawSchema('{"properties":[{"id":"p","name":"P"}]}')),
    ).toBe('databases_properties_schema_shape');
  });

  it('rejects an empty or non-string id or name', async () => {
    for (const document of [
      '{"properties":[{"id":"","name":"P","type":"text"}]}',
      '{"properties":[{"id":7,"name":"P","type":"text"}]}',
      '{"properties":[{"id":"p","name":"","type":"text"}]}',
      '{"properties":[{"id":"p","type":"text"}]}',
    ]) {
      expect(await violation(() => insertRawSchema(document))).toBe(
        'databases_properties_schema_shape',
      );
    }
  });

  it('places no constraint on a property config — it was Schema.Types.Mixed', async () => {
    await expect(
      insertRawSchema(
        '{"properties":[{"id":"p","name":"P","type":"select","config":{"options":[{"id":"o","name":"O","color":"chartreuse"}],"nonsense":1}}]}',
      ),
    ).resolves.toBeUndefined();
  });
});

describe('database_views_type', () => {
  it('accepts every value in DATABASE_VIEW_TYPES and rejects anything else', async () => {
    const [database] = await db
      .insert(databases)
      .values({ workspaceId, ownerId: 'owner' })
      .returning({ id: databases.id });

    expect(DATABASE_VIEW_TYPES.length).toBe(6);
    for (const type of DATABASE_VIEW_TYPES) {
      await expect(
        db.insert(databaseViews).values({ databaseId: database.id, type }),
      ).resolves.toBeDefined();
    }

    expect(
      await violation(() =>
        client.unsafe(
          `insert into database_views (id, database_id, type)
           values (gen_random_uuid()::text, '${database.id}', 'spreadsheet')`,
        ),
      ),
    ).toBe('database_views_type');
  });
});

describe('database_views_sorts_shape', () => {
  it('accepts an empty sort list and every direction', async () => {
    await expect(insertRawSorts('[]')).resolves.toBeUndefined();
    for (const direction of SORT_DIRECTIONS) {
      await expect(
        insertRawSorts(`[{"propertyId":"p","direction":"${direction}"}]`),
      ).resolves.toBeUndefined();
    }
  });

  it('rejects a direction outside SORT_DIRECTIONS, a missing one, and a bad propertyId', async () => {
    for (const document of [
      '[{"propertyId":"p","direction":"sideways"}]',
      '[{"propertyId":"p"}]',
      '[{"propertyId":"","direction":"asc"}]',
      '{}',
    ]) {
      expect(await violation(() => insertRawSorts(document))).toBe(
        'database_views_sorts_shape',
      );
    }
  });

  it('places no constraint on filters, groupBy or config — all were Mixed', async () => {
    const [database] = await db
      .insert(databases)
      .values({ workspaceId, ownerId: 'owner' })
      .returning({ id: databases.id });
    await expect(
      client.unsafe(
        `insert into database_views (id, database_id, filters, group_by, config)
         values (gen_random_uuid()::text, '${database.id}', '"not a group"'::jsonb, '[1,2]'::jsonb, '"nope"'::jsonb)`,
      ),
    ).resolves.toBeDefined();
  });
});

describe('column defaults', () => {
  it('reproduces every Mongoose default', async () => {
    const [database] = await db
      .insert(databases)
      .values({ workspaceId, ownerId: 'owner-defaults' })
      .returning();

    expect(database.name).toBe('');
    expect(database.icon).toBeNull();
    expect(database.cover).toBeNull();
    expect(database.propertiesSchema).toEqual({ properties: [] });
    expect(database.isInline).toBe(false);
    expect(database.parentPageId).toBeNull();
    expect(database.archived).toBe(false);
    expect(database.createdAt).toBeInstanceOf(Date);
    expect(database.updatedAt).toBeInstanceOf(Date);

    const [view] = await db
      .insert(databaseViews)
      .values({ databaseId: database.id })
      .returning();

    expect(view.name).toBe('');
    expect(view.type).toBe('table');
    expect(view.isDefault).toBe(false);
    expect(view.filters).toEqual({ kind: 'group', combinator: 'and', filters: [] });
    expect(view.sorts).toEqual([]);
    expect(view.groupBy).toBeNull();
    expect(view.hiddenProperties).toEqual([]);
    expect(view.frozenProperties).toEqual([]);
    expect(view.pageSize).toBe(50);
    expect(view.config).toEqual({});
    expect(view.order).toBe(0);
  });

  it('stores timestamps at millisecond precision, so a Date round-trips exactly', async () => {
    const [row] = await db
      .insert(databases)
      .values({ workspaceId, ownerId: 'owner-precision' })
      .returning({ id: databases.id, createdAt: databases.createdAt });
    const [readBack] = await db
      .select({ createdAt: databases.createdAt })
      .from(databases)
      .where(sql`${databases.id} = ${row.id}`);
    expect(readBack.createdAt.getTime()).toBe(row.createdAt.getTime());
    // The claim is that the STORED value carries no microseconds — a JS Date
    // cannot represent them, so a plain `now()` default would make any keyset
    // cursor built from this read compare against a value smaller than its own
    // row. `getTime() % 1 === 0` is true of every Date and would prove nothing;
    // this reads the microsecond component out of Postgres itself.
    const [precision] = await client.unsafe<{ micros: string }[]>(
      `select date_part('microseconds', created_at)::text as micros
       from databases where id = '${row.id}'`,
    );
    expect(Number(precision.micros) % 1000).toBe(0);
  });
});

describe('columns', () => {
  /**
   * The writer-versus-columns diff, as a standing assertion.
   *
   * A `pgTable` can omit a column its writer writes with every other gate
   * green: `tsc` never mentions it (the insert simply does not name it), the
   * table exists so no read errors, and the symptom is a route returning an
   * empty list. The expected sets below are read off `IDatabase` /
   * `IDatabaseView` in the Mongoose models plus the two timestamp columns, so
   * they are an INDEPENDENT statement of the field list rather than a
   * restatement of the schema file.
   */
  it('databases has exactly the columns the Mongo document had', async () => {
    const rows = await client.unsafe<{ column_name: string }[]>(
      `select column_name from information_schema.columns
       where table_schema = 'public' and table_name = 'databases'`,
    );
    expect(new Set(rows.map((r) => r.column_name))).toEqual(
      new Set([
        'id',
        'workspace_id',
        'name',
        'icon',
        'cover',
        'owner_id',
        'properties_schema',
        'is_inline',
        'parent_page_id',
        'archived',
        'created_at',
        'updated_at',
      ]),
    );
  });

  it('database_views has exactly the columns the Mongo document had', async () => {
    const rows = await client.unsafe<{ column_name: string }[]>(
      `select column_name from information_schema.columns
       where table_schema = 'public' and table_name = 'database_views'`,
    );
    expect(new Set(rows.map((r) => r.column_name))).toEqual(
      new Set([
        'id',
        'database_id',
        'name',
        'type',
        'is_default',
        'filters',
        'sorts',
        'group_by',
        'hidden_properties',
        'frozen_properties',
        'page_size',
        'config',
        'order',
        'created_at',
        'updated_at',
      ]),
    );
  });
});

describe('indexes and foreign keys', () => {
  /**
   * An absent index is the one defect no functional test can detect — the rows
   * come back correct, by sequential scan.
   */
  it('creates every index the Mongo model declared', async () => {
    const rows = await client.unsafe<{ indexname: string }[]>(
      `select indexname from pg_indexes
       where schemaname = 'public' and tablename in ('databases', 'database_views')`,
    );
    const names = new Set(rows.map((r) => r.indexname));
    expect(names).toContain('databases_workspace_archived_updated_idx');
    expect(names).toContain('databases_parent_page_idx');
    expect(names).toContain('database_views_database_order_idx');
    // Floor: the primary keys are in this set too, so a query returning
    // nothing at all cannot read as "the indexes are present".
    expect(rows.length).toBeGreaterThanOrEqual(5);
  });

  /**
   * Verified against `pg_constraint` rather than the drizzle declaration: a
   * column-level reference has been silently dropped from both a generated
   * migration and its snapshot before.
   */
  it('declares the foreign keys, with ON DELETE CASCADE', async () => {
    const rows = await client.unsafe<{ conname: string; confdeltype: string }[]>(
      `select conname, confdeltype from pg_constraint
       where contype = 'f' and conrelid in ('databases'::regclass, 'database_views'::regclass)`,
    );
    const byName = new Map(rows.map((r) => [r.conname, r.confdeltype]));
    expect(byName.get('databases_workspace_id_workspaces_id_fk')).toBe('c');
    expect(byName.get('database_views_database_id_databases_id_fk')).toBe('c');
  });

  it('cascades a database delete to its views', async () => {
    const [database] = await db
      .insert(databases)
      .values({ workspaceId, ownerId: 'owner-cascade' })
      .returning({ id: databases.id });
    await db.insert(databaseViews).values({ databaseId: database.id });

    await db.delete(databases).where(sql`${databases.id} = ${database.id}`);

    const left = await db
      .select({ id: databaseViews.id })
      .from(databaseViews)
      .where(sql`${databaseViews.databaseId} = ${database.id}`);
    expect(left).toEqual([]);
  });
});

describe('generated DDL', () => {
  it('renders the CHECK constants as SQL literals, never bound parameters', async () => {
    const ddl = (await renderSchemaDdl()).join('\n');
    // A value interpolated into a `check()` becomes the literal `$1` in the
    // generated migration and fails at APPLY time.
    expect(ddl).not.toMatch(/\$\d/u);
    // Positive control: the constants really are in there, so the assertion
    // above is not passing over an empty render. The two are quoted
    // DIFFERENTLY — a property type is a string inside a jsonpath literal, a
    // view type is a SQL literal in an `in (...)` list — so asserting both
    // also pins which rendering each CHECK actually got.
    expect(ddl).toContain('@ == "last_edited_by"');
    expect(ddl).toContain("'timeline'");
  });
});
