import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import {
  closeTestDb,
  getTestDb,
  seedWorkspace,
  type TestDatabase,
} from '../db/__tests__/testDatabase.js';
import { databaseViews, databases, type DatabaseSchema } from '../db/schema/databases.js';
import {
  countViews,
  deleteDatabase,
  deleteDatabaseView,
  deleteViewsByDatabase,
  demoteOtherDefaultViews,
  findDatabaseById,
  findDatabaseWorkspaceId,
  findDefaultView,
  findFirstViewByOrder,
  findViewById,
  insertDatabase,
  insertDatabaseView,
  listDatabasesByWorkspace,
  listViewsByDatabase,
  nextViewOrder,
  updateDatabase,
  updateDatabaseView,
  writeDatabaseSchema,
  type InsertDatabaseInput,
  type InsertDatabaseViewInput,
  type StationHandle,
} from './databases.js';

/**
 * Every assertion here is scoped to a workspace or database this file created.
 * The suite shares one Postgres with every other `*.pgdb.test.ts`, so an
 * unscoped aggregate reads a sibling file's rows and fails for a reason that
 * has nothing to do with this code.
 */

let db: TestDatabase;
/** This file's own workspace. Nothing outside it is ever counted. */
let workspaceId: string;
/** A second workspace, so "filtered by workspace" is a claim with a control. */
let otherWorkspaceId: string;

const SCHEMA: DatabaseSchema = {
  properties: [
    { id: 'name', name: 'Name', type: 'text' },
    {
      id: 'status',
      name: 'Status',
      type: 'status',
      config: { options: [{ id: 'o1', name: 'Todo', color: 'gray' }] },
    },
  ],
};

function databaseInput(overrides: Partial<InsertDatabaseInput> = {}): InsertDatabaseInput {
  return {
    workspaceId,
    name: 'Untitled',
    icon: null,
    cover: null,
    ownerId: 'user-1',
    propertiesSchema: SCHEMA,
    isInline: false,
    parentPageId: null,
    archived: false,
    ...overrides,
  };
}

function viewInput(
  databaseId: string,
  overrides: Partial<InsertDatabaseViewInput> = {},
): InsertDatabaseViewInput {
  return {
    databaseId,
    name: 'All',
    type: 'table',
    isDefault: true,
    filters: { kind: 'group', combinator: 'and', filters: [] },
    sorts: [],
    groupBy: null,
    hiddenProperties: [],
    frozenProperties: [],
    pageSize: 50,
    config: {},
    order: 0,
    ...overrides,
  };
}

beforeAll(async () => {
  db = await getTestDb();
  workspaceId = await seedWorkspace(db, 'repo-databases');
  otherWorkspaceId = await seedWorkspace(db, 'repo-databases-other');
});

afterAll(async () => {
  await closeTestDb();
});

describe('insertDatabase', () => {
  it('round-trips every field the route writes', async () => {
    const record = await insertDatabase(
      db,
      databaseInput({
        name: 'Tasks',
        icon: '📋',
        cover: 'https://example.test/c.png',
        isInline: true,
        parentPageId: 'page-abc',
      }),
    );

    expect(record.workspaceId).toBe(workspaceId);
    expect(record.name).toBe('Tasks');
    expect(record.icon).toBe('📋');
    expect(record.cover).toBe('https://example.test/c.png');
    expect(record.ownerId).toBe('user-1');
    expect(record.isInline).toBe(true);
    expect(record.parentPageId).toBe('page-abc');
    expect(record.archived).toBe(false);
    // Deep equality on the jsonb, including the nested option list — a
    // shallow check would pass on a config that was silently dropped.
    expect(record.propertiesSchema).toEqual(SCHEMA);

    const read = await findDatabaseById(db, record.id);
    expect(read).toEqual(record);
  });

  it('stamps archivedAt when created archived', async () => {
    const record = await insertDatabase(db, databaseInput({ archived: true }));
    expect(record.archived).toBe(true);
  });
});

describe('listDatabasesByWorkspace', () => {
  it('returns only this workspace, and excludes archived unless asked', async () => {
    const scope = await seedWorkspace(db, 'repo-list-scope');
    const live = await insertDatabase(db, databaseInput({ workspaceId: scope, name: 'live' }));
    const archived = await insertDatabase(
      db,
      databaseInput({ workspaceId: scope, name: 'archived', archived: true }),
    );
    // Control for the workspace filter: an identically-named row next door.
    await insertDatabase(db, databaseInput({ workspaceId: otherWorkspaceId, name: 'live' }));

    const visible = await listDatabasesByWorkspace(db, {
      workspaceId: scope,
      includeArchived: false,
    });
    expect(visible.map((d) => d.id)).toEqual([live.id]);

    const all = await listDatabasesByWorkspace(db, {
      workspaceId: scope,
      includeArchived: true,
    });
    expect(new Set(all.map((d) => d.id))).toEqual(new Set([live.id, archived.id]));
  });

  it('sorts by updatedAt descending', async () => {
    const scope = await seedWorkspace(db, 'repo-list-order');
    const first = await insertDatabase(db, databaseInput({ workspaceId: scope, name: 'first' }));
    const second = await insertDatabase(db, databaseInput({ workspaceId: scope, name: 'second' }));

    // Explicit timestamps: a uuid v7 is NOT monotonic within a millisecond, so
    // insertion order is not a property this schema has.
    await db
      .update(databases)
      .set({ updatedAt: new Date('2026-01-01T00:00:00.000Z') })
      .where(eq(databases.id, first.id));
    await db
      .update(databases)
      .set({ updatedAt: new Date('2026-06-01T00:00:00.000Z') })
      .where(eq(databases.id, second.id));

    const rows = await listDatabasesByWorkspace(db, {
      workspaceId: scope,
      includeArchived: false,
    });
    expect(rows.map((d) => d.name)).toEqual(['second', 'first']);
  });

  it('is empty for a workspace with no databases', async () => {
    const empty = await seedWorkspace(db, 'repo-list-empty');
    expect(
      await listDatabasesByWorkspace(db, { workspaceId: empty, includeArchived: true }),
    ).toEqual([]);
  });
});

describe('findDatabaseById / findDatabaseWorkspaceId', () => {
  it('returns null for an id that does not exist', async () => {
    expect(await findDatabaseById(db, 'no-such-database')).toBeNull();
    expect(await findDatabaseWorkspaceId(db, 'no-such-database')).toBeNull();
  });

  it('returns just the id and workspace id for the membership check', async () => {
    const record = await insertDatabase(db, databaseInput());
    expect(await findDatabaseWorkspaceId(db, record.id)).toEqual({
      id: record.id,
      workspaceId,
    });
  });
});

describe('updateDatabase', () => {
  /**
   * The `$set: { x: undefined }` divergence: a no-op in Mongo, a NULL write in
   * Postgres. `icon` and `cover` are nullable in the request schema, so
   * `undefined` and `null` are two different instructions and collapsing them
   * silently erases a value.
   */
  it('leaves an omitted nullable field alone and writes an explicit null', async () => {
    const record = await insertDatabase(db, databaseInput({ icon: '📋', cover: 'c.png' }));

    const renamed = await updateDatabase(db, record.id, { name: 'Renamed' });
    expect(renamed?.name).toBe('Renamed');
    expect(renamed?.icon).toBe('📋');
    expect(renamed?.cover).toBe('c.png');

    const cleared = await updateDatabase(db, record.id, { icon: null });
    expect(cleared?.icon).toBeNull();
    expect(cleared?.cover).toBe('c.png');
    expect(cleared?.name).toBe('Renamed');
  });

  it('archives, un-archives, and keeps the original archive instant', async () => {
    const record = await insertDatabase(db, databaseInput());

    const archived = await updateDatabase(db, record.id, { archived: true });
    expect(archived?.archived).toBe(true);
    const [stamped] = await db
      .select({ archivedAt: databases.archivedAt })
      .from(databases)
      .where(eq(databases.id, record.id));

    const again = await updateDatabase(db, record.id, { archived: true });
    expect(again?.archived).toBe(true);
    const [restamped] = await db
      .select({ archivedAt: databases.archivedAt })
      .from(databases)
      .where(eq(databases.id, record.id));
    expect(restamped.archivedAt?.getTime()).toBe(stamped.archivedAt?.getTime());

    const restored = await updateDatabase(db, record.id, { archived: false });
    expect(restored?.archived).toBe(false);
    const [cleared] = await db
      .select({ archivedAt: databases.archivedAt })
      .from(databases)
      .where(eq(databases.id, record.id));
    expect(cleared.archivedAt).toBeNull();
  });

  it('writes nothing at all for a patch with no defined keys', async () => {
    const record = await insertDatabase(db, databaseInput());
    const unchanged = await updateDatabase(db, record.id, { name: undefined });
    expect(unchanged).toEqual(record);
    // Mongoose's `save()` with no modified path does not write, so `updatedAt`
    // must not move either.
    expect(unchanged?.updatedAt.getTime()).toBe(record.updatedAt.getTime());
  });

  it('returns null for an id that does not exist', async () => {
    expect(await updateDatabase(db, 'no-such-database', { name: 'x' })).toBeNull();
  });
});

describe('writeDatabaseSchema', () => {
  it('replaces the whole property list', async () => {
    const record = await insertDatabase(db, databaseInput());
    const next: DatabaseSchema = {
      properties: [{ id: 'name', name: 'Name', type: 'text' }],
    };
    const written = await writeDatabaseSchema(db, record.id, next);
    expect(written?.propertiesSchema).toEqual(next);

    const emptied = await writeDatabaseSchema(db, record.id, { properties: [] });
    expect(emptied?.propertiesSchema).toEqual({ properties: [] });
  });
});

describe('deleteDatabase', () => {
  it('reports whether a row was removed and takes its views with it', async () => {
    const record = await insertDatabase(db, databaseInput());
    await insertDatabaseView(db, viewInput(record.id));

    expect(await deleteDatabase(db, record.id)).toBe(true);
    expect(await deleteDatabase(db, record.id)).toBe(false);
    expect(await listViewsByDatabase(db, record.id)).toEqual([]);
  });
});

describe('view ordering', () => {
  it('lists by order, then createdAt, and is stable when both tie', async () => {
    const record = await insertDatabase(db, databaseInput());
    const shared = new Date('2026-03-03T03:03:03.000Z');
    const ids: string[] = [];
    for (let index = 0; index < 5; index += 1) {
      const view = await insertDatabaseView(db, viewInput(record.id, { name: `v${index}` }));
      await db
        .update(databaseViews)
        .set({ createdAt: shared })
        .where(eq(databaseViews.id, view.id));
      ids.push(view.id);
    }

    const first = await listViewsByDatabase(db, record.id);
    const second = await listViewsByDatabase(db, record.id);
    expect(first.map((v) => v.id)).toEqual(second.map((v) => v.id));
    expect(new Set(first.map((v) => v.id))).toEqual(new Set(ids));
    // The tiebreak is the id, so the order is the sorted id order — not the
    // insertion order, which a uuid v7 does not encode within a millisecond.
    expect(first.map((v) => v.id)).toEqual([...ids].sort());
  });

  it('orders by `order` ahead of createdAt', async () => {
    const record = await insertDatabase(db, databaseInput());
    const last = await insertDatabaseView(db, viewInput(record.id, { name: 'last', order: 9 }));
    const middle = await insertDatabaseView(db, viewInput(record.id, { name: 'mid', order: 5 }));
    const firstView = await insertDatabaseView(
      db,
      viewInput(record.id, { name: 'first', order: 1 }),
    );

    const rows = await listViewsByDatabase(db, record.id);
    expect(rows.map((v) => v.id)).toEqual([firstView.id, middle.id, last.id]);
  });
});

describe('nextViewOrder', () => {
  it('starts at 0 and increments', async () => {
    const record = await insertDatabase(db, databaseInput());
    expect(await nextViewOrder(db, record.id)).toBe(0);

    await insertDatabaseView(db, viewInput(record.id, { order: 0 }));
    const next = await nextViewOrder(db, record.id);
    // `postgres.js` decodes int8 as a STRING while drizzle types it `number`,
    // which would make this `"01"` rather than 1. `order` is float8 for that
    // reason, and asserting the TYPE is what would catch a change back.
    expect(next).toBe(1);
    expect(typeof next).toBe('number');
  });

  it('keeps a fractional order fractional', async () => {
    // `createViewSchema.order` is `z.number().finite()`, not `.int()`, so the
    // API accepts 1.5 today. An integer column would round it silently.
    const record = await insertDatabase(db, databaseInput());
    const view = await insertDatabaseView(db, viewInput(record.id, { order: 1.5 }));
    expect(view.order).toBe(1.5);
    expect(await nextViewOrder(db, record.id)).toBe(2.5);
  });

  it('is scoped to one database', async () => {
    const mine = await insertDatabase(db, databaseInput());
    const theirs = await insertDatabase(db, databaseInput());
    await insertDatabaseView(db, viewInput(theirs.id, { order: 41 }));
    expect(await nextViewOrder(db, mine.id)).toBe(0);
  });
});

describe('insertDatabaseView', () => {
  it('round-trips every field the route writes', async () => {
    const record = await insertDatabase(db, databaseInput());
    const view = await insertDatabaseView(
      db,
      viewInput(record.id, {
        name: 'Board',
        type: 'board',
        isDefault: false,
        filters: {
          kind: 'group',
          combinator: 'or',
          filters: [
            { kind: 'condition', propertyId: 'status', operator: 'equals', value: 'o1' },
          ],
        },
        sorts: [{ propertyId: 'name', direction: 'desc' }],
        groupBy: { propertyId: 'status' },
        hiddenProperties: ['a', 'b'],
        frozenProperties: ['name'],
        pageSize: 25,
        config: { coverSource: 'property', coverPropertyId: 'cover', fit: 'contain' },
        order: 3,
      }),
    );

    expect(view.name).toBe('Board');
    expect(view.type).toBe('board');
    expect(view.isDefault).toBe(false);
    expect(view.filters.filters).toHaveLength(1);
    expect(view.sorts).toEqual([{ propertyId: 'name', direction: 'desc' }]);
    expect(view.groupBy).toEqual({ propertyId: 'status' });
    expect(view.hiddenProperties).toEqual(['a', 'b']);
    expect(view.frozenProperties).toEqual(['name']);
    expect(view.pageSize).toBe(25);
    expect(view.config).toEqual({
      coverSource: 'property',
      coverPropertyId: 'cover',
      fit: 'contain',
    });
    expect(view.order).toBe(3);

    expect(await findViewById(db, view.id, record.id)).toEqual(view);
  });

  it('stores an empty string array as empty, not null', async () => {
    const record = await insertDatabase(db, databaseInput());
    const view = await insertDatabaseView(
      db,
      viewInput(record.id, { hiddenProperties: [], frozenProperties: [] }),
    );
    expect(view.hiddenProperties).toEqual([]);
    expect(view.frozenProperties).toEqual([]);
  });
});

describe('findViewById', () => {
  it('refuses a view that belongs to another database', async () => {
    const mine = await insertDatabase(db, databaseInput());
    const theirs = await insertDatabase(db, databaseInput());
    const view = await insertDatabaseView(db, viewInput(theirs.id));

    // Positive control: the same call against the right database finds it, so
    // the null below is the ownership check and not a broken lookup.
    expect(await findViewById(db, view.id, theirs.id)).not.toBeNull();
    expect(await findViewById(db, view.id, mine.id)).toBeNull();
  });
});

describe('updateDatabaseView', () => {
  it('distinguishes an omitted groupBy from an explicit null', async () => {
    const record = await insertDatabase(db, databaseInput());
    const view = await insertDatabaseView(
      db,
      viewInput(record.id, { groupBy: { propertyId: 'status' } }),
    );

    const renamed = await updateDatabaseView(db, view.id, { name: 'Renamed' });
    expect(renamed?.groupBy).toEqual({ propertyId: 'status' });

    const ungrouped = await updateDatabaseView(db, view.id, { groupBy: null });
    expect(ungrouped?.groupBy).toBeNull();
    expect(ungrouped?.name).toBe('Renamed');
  });

  it('replaces sorts and array columns wholesale', async () => {
    const record = await insertDatabase(db, databaseInput());
    const view = await insertDatabaseView(
      db,
      viewInput(record.id, {
        sorts: [{ propertyId: 'name', direction: 'asc' }],
        hiddenProperties: ['a'],
      }),
    );
    const updated = await updateDatabaseView(db, view.id, {
      sorts: [],
      hiddenProperties: ['b', 'c'],
    });
    expect(updated?.sorts).toEqual([]);
    expect(updated?.hiddenProperties).toEqual(['b', 'c']);
  });

  it('returns null for a view that does not exist', async () => {
    expect(await updateDatabaseView(db, 'no-such-view', { name: 'x' })).toBeNull();
  });
});

describe('default views', () => {
  it('demotes every other default and reports how many', async () => {
    const record = await insertDatabase(db, databaseInput());
    const keep = await insertDatabaseView(db, viewInput(record.id, { isDefault: true, order: 0 }));
    const a = await insertDatabaseView(db, viewInput(record.id, { isDefault: true, order: 1 }));
    const b = await insertDatabaseView(db, viewInput(record.id, { isDefault: false, order: 2 }));

    // A default in a DIFFERENT database must survive — the control for the
    // `databaseId` predicate.
    const elsewhere = await insertDatabase(db, databaseInput());
    const untouched = await insertDatabaseView(db, viewInput(elsewhere.id, { isDefault: true }));

    expect(await demoteOtherDefaultViews(db, record.id, keep.id)).toBe(1);

    expect((await findViewById(db, keep.id, record.id))?.isDefault).toBe(true);
    expect((await findViewById(db, a.id, record.id))?.isDefault).toBe(false);
    expect((await findViewById(db, b.id, record.id))?.isDefault).toBe(false);
    expect((await findViewById(db, untouched.id, elsewhere.id))?.isDefault).toBe(true);
  });

  /**
   * Two defaults ARE reachable today — `POST /:id/views` honours
   * `isDefault: true` without demoting the existing default. Mongo's
   * `findOne` returned an arbitrary one of them; this returns the first in the
   * view ordering, every time.
   *
   * The ids are explicit and the two rows agree on `order` and `createdAt`, so
   * the ONLY thing that can decide the answer is the `id` tiebreak in the
   * ORDER BY. Written that way deliberately: with distinct `order` values the
   * test passes whether or not the ORDER BY is present, because the index on
   * `(database_id, "order", created_at)` hands back an already-sorted scan —
   * measured, by deleting the `.orderBy()` and watching the test stay green.
   * Inserting the LARGER id first is what makes heap order and sorted order
   * disagree, deterministically rather than half the time.
   */
  it('resolves a single default deterministically when several exist', async () => {
    const record = await insertDatabase(db, databaseInput());
    const sharedCreatedAt = new Date('2026-04-04T04:04:04.000Z');
    const values = {
      databaseId: record.id,
      isDefault: true,
      order: 5,
      createdAt: sharedCreatedAt,
    };
    await db.insert(databaseViews).values({ ...values, id: `${record.id}-zz` });
    await db.insert(databaseViews).values({ ...values, id: `${record.id}-aa` });

    expect((await findDefaultView(db, record.id))?.id).toBe(`${record.id}-aa`);
    expect((await findDefaultView(db, record.id))?.id).toBe(`${record.id}-aa`);
    // The same answer the documented ordering gives, so the two cannot drift.
    const listed = await listViewsByDatabase(db, record.id);
    expect(listed.find((v) => v.isDefault)?.id).toBe(`${record.id}-aa`);
  });

  it('returns null when no view is default', async () => {
    const record = await insertDatabase(db, databaseInput());
    await insertDatabaseView(db, viewInput(record.id, { isDefault: false }));
    expect(await findDefaultView(db, record.id)).toBeNull();
  });

  it('promotes the first view by order after the default is deleted', async () => {
    const record = await insertDatabase(db, databaseInput());
    const primary = await insertDatabaseView(
      db,
      viewInput(record.id, { isDefault: true, order: 0 }),
    );
    const fallback = await insertDatabaseView(
      db,
      viewInput(record.id, { isDefault: false, order: 1 }),
    );

    expect(await countViews(db, record.id)).toBe(2);
    expect(await deleteDatabaseView(db, primary.id)).toBe(true);
    expect((await findFirstViewByOrder(db, record.id))?.id).toBe(fallback.id);
    expect(await countViews(db, record.id)).toBe(1);
  });

  /**
   * Same construction as the deterministic-default test above, for the same
   * reason: distinct `order` values are sorted by the index whether or not the
   * query says to, so only the `id` tiebreak can prove the ORDER BY is there.
   */
  it('picks the promotion candidate by the id tiebreak when order and createdAt tie', async () => {
    const record = await insertDatabase(db, databaseInput());
    const values = {
      databaseId: record.id,
      order: 2,
      createdAt: new Date('2026-05-05T05:05:05.000Z'),
    };
    await db.insert(databaseViews).values({ ...values, id: `${record.id}-yy` });
    await db.insert(databaseViews).values({ ...values, id: `${record.id}-bb` });

    expect((await findFirstViewByOrder(db, record.id))?.id).toBe(`${record.id}-bb`);
  });
});

describe('countViews', () => {
  it('counts only this database, as a number', async () => {
    const record = await insertDatabase(db, databaseInput());
    const other = await insertDatabase(db, databaseInput());
    await insertDatabaseView(db, viewInput(record.id));
    await insertDatabaseView(db, viewInput(record.id));
    await insertDatabaseView(db, viewInput(other.id));

    const total = await countViews(db, record.id);
    expect(total).toBe(2);
    // `count(*)` is bigint, which postgres.js decodes as a STRING. Without
    // drizzle's `count()` mapper this is `"2"` and `total <= 1` is false for
    // every count, so "cannot delete the last view" would stop firing.
    expect(typeof total).toBe('number');
    expect(await countViews(db, 'no-such-database')).toBe(0);
  });
});

describe('deleteViewsByDatabase', () => {
  it('removes only this database views and reports the count', async () => {
    const record = await insertDatabase(db, databaseInput());
    const other = await insertDatabase(db, databaseInput());
    await insertDatabaseView(db, viewInput(record.id));
    await insertDatabaseView(db, viewInput(record.id));
    await insertDatabaseView(db, viewInput(other.id));

    expect(await deleteViewsByDatabase(db, record.id)).toBe(2);
    expect(await countViews(db, record.id)).toBe(0);
    expect(await countViews(db, other.id)).toBe(1);
    expect(await deleteViewsByDatabase(db, record.id)).toBe(0);
  });
});

/**
 * The hard-delete route removes pages, blocks, views and the database
 * together, so at cutover those four have to share one transaction. That is
 * only possible if every function here accepts a transaction handle — a
 * property of the TYPES as much as the runtime, so it is asserted both ways.
 */
describe('transaction handles', () => {
  it('runs the delete cascade inside one transaction and rolls it back', async () => {
    const record = await insertDatabase(db, databaseInput());
    await insertDatabaseView(db, viewInput(record.id));

    await expect(
      db.transaction(async (tx) => {
        const handle: StationHandle = tx;
        expect(await deleteViewsByDatabase(handle, record.id)).toBe(1);
        expect(await deleteDatabase(handle, record.id)).toBe(true);
        throw new Error('roll back');
      }),
    ).rejects.toThrow('roll back');

    // Rolled back, so both are still there. If these functions had quietly
    // used a pool handle instead of `tx`, the writes would have committed and
    // this would read null.
    expect(await findDatabaseById(db, record.id)).not.toBeNull();
    expect(await countViews(db, record.id)).toBe(1);
  });

  it('commits the cascade when the transaction succeeds', async () => {
    const record = await insertDatabase(db, databaseInput());
    await insertDatabaseView(db, viewInput(record.id));

    await db.transaction(async (tx) => {
      await deleteViewsByDatabase(tx, record.id);
      await deleteDatabase(tx, record.id);
    });

    expect(await findDatabaseById(db, record.id)).toBeNull();
  });
});
