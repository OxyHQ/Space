/**
 * `pages` against a real PostgreSQL 17.
 *
 * Skipped when `TEST_DATABASE_URL` is unset, which is what makes this file safe
 * in the default `bun run test`. A skipped suite is an inert suite, so the
 * `.pgdb.test.ts` suffix is the handle a CI job needs to require these by name
 * — a job's presence says nothing about which tests it ran.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { eq, sql } from 'drizzle-orm';
import { getTableConfig } from 'drizzle-orm/pg-core';
import { isCheckViolation, isForeignKeyViolation, sqlColumnName, uuidv7 } from '@oxyhq/db';
import { openPgdb, PGDB_ADMIN_URL, type Pgdb } from '../db/__tests__/pgdb-harness.js';
import { blocks, pages } from '../db/schema/pages.js';
import { workspaces } from '../db/schema/workspaces.js';
import {
  BREADCRUMB_MAX_DEPTH,
  createPage,
  deleteArchivedPages,
  deleteDatabaseRows,
  deletePageTree,
  findPageAncestry,
  findPageById,
  findPagesByIds,
  listDatabaseRows,
  listPages,
  nextDatabaseRowOrder,
  nextSiblingOrder,
  removePropertyFromDatabaseRows,
  updatePage,
} from './pages.js';

describe.skipIf(!PGDB_ADMIN_URL)('pages repository (real database)', () => {
  let pgdb: Pgdb;
  let workspaceId: string;

  beforeAll(async () => {
    pgdb = await openPgdb();
    const [workspace] = await pgdb.db
      .insert(workspaces)
      .values({ name: 'pages-repo', ownerId: 'user-owner' })
      .returning();
    if (!workspace) throw new Error('fixture workspace was not created');
    workspaceId = workspace.id;
  });

  afterAll(async () => {
    await pgdb?.close();
  });

  /** A page with only the fields a caller must supply. */
  async function seedPage(overrides: Partial<Parameters<typeof createPage>[1]> = {}) {
    return createPage(pgdb.db, {
      workspaceId,
      ownerId: 'user-owner',
      order: 0,
      ...overrides,
    });
  }

  describe('schema', () => {
    /**
     * Every field a route writes to `pages`, from a repo-wide census of writers:
     * `routes/pages.ts:325,551` (create), `routes/pages.ts:364-439` (patch),
     * `routes/pages.ts:485` (soft delete), `routes/databases.ts:1057` (database
     * row create) and `routes/databases.ts:906` (property unset).
     *
     * Asserted in BOTH directions. A `pgTable` can omit a column its writer
     * writes and every other gate stays green — `tsc` does not object because
     * the insert simply never mentions it, the table exists so no read errors,
     * and a route then groups by a column that is not there and returns an
     * empty list. The reverse assertion catches the opposite move: a column
     * added here with no writer behind it.
     */
    const WRITER_FIELDS = [
      'workspaceId',
      'parentId',
      'title',
      'icon',
      'cover',
      'coverPosition',
      'ownerId',
      'archived',
      'favorited',
      'order',
      'databaseId',
      'properties',
    ] as const;

    it('declares a column for every field a route writes, and no column without one', () => {
      // `column.name` is the TypeScript PROPERTY name, which is what a writer
      // spells. `sqlColumnName` is used below where the SQL identifier is what
      // matters — reading one for the other is the 42703 trap.
      const declared = getTableConfig(pages).columns.map((column) => column.name);
      expect(WRITER_FIELDS.length).toBe(12);
      for (const field of WRITER_FIELDS) expect(declared).toContain(field);
      expect(new Set(declared)).toEqual(
        new Set([...WRITER_FIELDS, 'id', 'createdAt', 'updatedAt']),
      );
    });

    it('created exactly the columns it declares', async () => {
      const rows = await pgdb.db.execute<{ column_name: string }>(sql`
        select column_name from information_schema.columns
        where table_schema = 'public' and table_name = 'pages'
      `);
      const live = new Set(rows.map((row) => row.column_name));
      const config = getTableConfig(pages);
      expect(config.columns.length).toBe(15);
      for (const column of config.columns) expect(live).toContain(sqlColumnName(column));
      expect(live.size).toBe(config.columns.length);
    });

    /**
     * An absent index is the one defect no functional test can detect — a
     * sequential scan returns exactly the right rows. So the index set is
     * asserted directly, by name.
     */
    it('carries every ported index', async () => {
      const rows = await pgdb.db.execute<{ indexname: string }>(sql`
        select indexname from pg_indexes where schemaname = 'public' and tablename = 'pages'
      `);
      const names = new Set(rows.map((row) => row.indexname));
      expect(names).toEqual(
        new Set([
          'pages_pkey',
          'pages_workspace_parent_order_idx',
          'pages_workspace_archived_idx',
          'pages_database_archived_created_idx',
          'pages_parent_idx',
          'pages_workspace_favorited_idx',
          'pages_properties_gin_idx',
        ]),
      );
    });

    it('resolves the self-reference on parentId in the catalogue, not just the declaration', async () => {
      const rows = await pgdb.db.execute<{ def: string }>(sql`
        select pg_get_constraintdef(oid) as def from pg_constraint
        where conname = 'pages_parent_id_pages_id_fk'
      `);
      expect(rows).toHaveLength(1);
      expect(rows[0]?.def).toContain('FOREIGN KEY (parent_id) REFERENCES pages(id)');
      expect(rows[0]?.def).toContain('ON DELETE SET NULL');
    });

    it('refuses a page in a workspace that does not exist', async () => {
      await expect(
        createPage(pgdb.db, { workspaceId: uuidv7(), ownerId: 'u', order: 0 }),
      ).rejects.toSatisfy(isForeignKeyViolation);
    });

    it('enforces the coverPosition bounds the Mongoose validator enforced', async () => {
      const withinBounds = await seedPage();
      await expect(updatePage(pgdb.db, withinBounds.id, { coverPosition: 0 })).resolves.toBeDefined();
      await expect(
        updatePage(pgdb.db, withinBounds.id, { coverPosition: 100 }),
      ).resolves.toBeDefined();
      await expect(
        updatePage(pgdb.db, withinBounds.id, { coverPosition: 101 }),
      ).rejects.toSatisfy(isCheckViolation);
      await expect(updatePage(pgdb.db, withinBounds.id, { coverPosition: -1 })).rejects.toSatisfy(
        isCheckViolation,
      );
      // `between` rejects NaN, which the Mongoose min/max pair did not.
      await expect(
        updatePage(pgdb.db, withinBounds.id, { coverPosition: Number.NaN }),
      ).rejects.toSatisfy(isCheckViolation);
      await deletePageTree(pgdb.db, withinBounds.id);
    });
  });

  describe('createPage', () => {
    it('applies the defaults the Mongoose schema applied', async () => {
      const page = await seedPage();
      expect(page.title).toBe('');
      expect(page.icon).toBeNull();
      expect(page.cover).toBeNull();
      expect(page.coverPosition).toBe(50);
      expect(page.archived).toBe(false);
      expect(page.favorited).toBe(false);
      expect(page.parentId).toBeNull();
      expect(page.databaseId).toBeNull();
      expect(page.properties).toEqual({});
      expect(page.createdAt).toBeInstanceOf(Date);

      const read = await findPageById(pgdb.db, page.id);
      expect(read).toEqual(page);
      await deletePageTree(pgdb.db, page.id);
    });

    it('round-trips a database row with typed properties', async () => {
      const databaseId = uuidv7();
      const properties = { name: { text: 'Row one' }, num: { number: 3.5 }, tags: { optionIds: ['a'] } };
      const row = await seedPage({ databaseId, properties, title: 'Row one' });
      const read = await findPageById(pgdb.db, row.id);
      expect(read?.properties).toEqual(properties);
      expect(read?.databaseId).toBe(databaseId);
      await deleteDatabaseRows(pgdb.db, databaseId);
    });

    it('answers undefined for an id nothing holds', async () => {
      expect(await findPageById(pgdb.db, uuidv7())).toBeUndefined();
    });
  });

  describe('listPages', () => {
    it('separates root pages from children, and orders by order then createdAt then id', async () => {
      const root = await seedPage({ title: 'root', order: 0 });
      const second = await seedPage({ title: 'second', order: 2 });
      const childB = await seedPage({ title: 'child-b', parentId: root.id, order: 1 });
      const childA = await seedPage({ title: 'child-a', parentId: root.id, order: 0 });

      // `parentId: null` must compile to `IS NULL`. `eq(col, null)` renders
      // `= NULL`, matches nothing, and returns [] with no error — this
      // assertion is the thing that tells those apart.
      const roots = await listPages(pgdb.db, { workspaceId, parentId: null });
      expect(roots.map((page) => page.id)).toEqual([root.id, second.id]);

      const children = await listPages(pgdb.db, { workspaceId, parentId: root.id });
      expect(children.map((page) => page.title)).toEqual(['child-a', 'child-b']);

      const everyDepth = await listPages(pgdb.db, { workspaceId });
      expect(everyDepth.map((page) => page.id).sort()).toEqual(
        [root.id, second.id, childA.id, childB.id].sort(),
      );

      await deletePageTree(pgdb.db, root.id);
      await deletePageTree(pgdb.db, second.id);
    });

    it('filters archived and favorited the way the query parameters do', async () => {
      const live = await seedPage({ title: 'live' });
      const trashed = await seedPage({ title: 'trashed' });
      const starred = await seedPage({ title: 'starred' });
      await updatePage(pgdb.db, trashed.id, { archived: true });
      await updatePage(pgdb.db, starred.id, { favorited: true });

      const active = await listPages(pgdb.db, { workspaceId, archived: false });
      expect(active.map((page) => page.title).sort()).toEqual(['live', 'starred']);

      const trash = await listPages(pgdb.db, { workspaceId, archived: true });
      expect(trash.map((page) => page.title)).toEqual(['trashed']);

      // `favoritedOnly` adds `favorited = true` and never `favorited = false`,
      // so an unstarred page is excluded rather than the filter being ignored.
      const favorites = await listPages(pgdb.db, { workspaceId, favoritedOnly: true });
      expect(favorites.map((page) => page.title)).toEqual(['starred']);

      const everything = await listPages(pgdb.db, { workspaceId });
      expect(everything).toHaveLength(3);

      for (const page of [live, trashed, starred]) await deletePageTree(pgdb.db, page.id);
    });
  });

  describe('findPagesByIds', () => {
    it('scopes by workspace and by archived, and returns [] for no ids', async () => {
      const mine = await seedPage({ title: 'mine' });
      const archived = await seedPage({ title: 'archived' });
      await updatePage(pgdb.db, archived.id, { archived: true });

      const [otherWorkspace] = await pgdb.db
        .insert(workspaces)
        .values({ name: 'other', ownerId: 'user-other' })
        .returning();
      if (!otherWorkspace) throw new Error('fixture workspace was not created');
      const theirs = await createPage(pgdb.db, {
        workspaceId: otherWorkspace.id,
        ownerId: 'user-other',
        order: 0,
      });

      const ids = [mine.id, archived.id, theirs.id];
      expect((await findPagesByIds(pgdb.db, ids, { workspaceId })).map((p) => p.id).sort()).toEqual(
        [mine.id, archived.id].sort(),
      );
      expect((await findPagesByIds(pgdb.db, ids, { archived: false })).map((p) => p.id).sort()).toEqual(
        [mine.id, theirs.id].sort(),
      );
      expect(await findPagesByIds(pgdb.db, [])).toEqual([]);

      await deletePageTree(pgdb.db, mine.id);
      await deletePageTree(pgdb.db, archived.id);
      await deletePageTree(pgdb.db, theirs.id);
      await pgdb.db.delete(workspaces).where(eq(workspaces.id, otherWorkspace.id));
    });
  });

  describe('nextSiblingOrder', () => {
    it('is 0 with no sibling, max+1 otherwise, and scoped to the parent', async () => {
      expect(await nextSiblingOrder(pgdb.db, { workspaceId, parentId: null })).toBe(0);

      const root = await seedPage({ order: 0 });
      const parent = await seedPage({ order: 7 });
      expect(await nextSiblingOrder(pgdb.db, { workspaceId, parentId: null })).toBe(8);
      expect(await nextSiblingOrder(pgdb.db, { workspaceId, parentId: parent.id })).toBe(0);

      await seedPage({ parentId: parent.id, order: 2.25 });
      const next = await nextSiblingOrder(pgdb.db, { workspaceId, parentId: parent.id });
      // A number, not a string. `max()` over `double precision` decodes as a
      // number while `count(*)` — bigint — decodes as a string; a repository
      // that confused the two would return "2.25" and `+ 1` would concatenate.
      expect(typeof next).toBe('number');
      expect(next).toBe(3.25);

      await deletePageTree(pgdb.db, root.id);
      await deletePageTree(pgdb.db, parent.id);
    });
  });

  describe('updatePage', () => {
    it('writes only defined keys, and treats null as a value rather than an omission', async () => {
      const page = await seedPage({ title: 'before', icon: 'star', cover: 'gradient' });

      const renamed = await updatePage(pgdb.db, page.id, { title: 'after', icon: undefined });
      expect(renamed?.title).toBe('after');
      // The Mongo hazard as a CONTRACT: `$set: { icon: undefined }` was a no-op
      // and the same statement in Postgres writes NULL, so `undefined` must not
      // erase. Measured caveat, so this is not read as more than it is: drizzle
      // drops undefined values from `.set()` on its own, so this assertion
      // holds with or without the repository's explicit guards. The guard is
      // pinned instead by the empty-patch assertion below, which asserts the
      // repository's OWN message.
      expect(renamed?.icon).toBe('star');
      expect(renamed?.cover).toBe('gradient');

      const cleared = await updatePage(pgdb.db, page.id, { icon: null });
      expect(cleared?.icon).toBeNull();
      expect(cleared?.title).toBe('after');

      await deletePageTree(pgdb.db, page.id);
    });

    it('bumps updatedAt and leaves createdAt alone', async () => {
      const page = await seedPage();
      await new Promise((resolve) => setTimeout(resolve, 5));
      const updated = await updatePage(pgdb.db, page.id, { title: 'touched' });
      expect(updated?.updatedAt.getTime()).toBeGreaterThan(page.updatedAt.getTime());
      expect(updated?.createdAt.getTime()).toBe(page.createdAt.getTime());
      await deletePageTree(pgdb.db, page.id);
    });

    it('merges properties rather than replacing them', async () => {
      const page = await seedPage({ properties: { a: { text: 'one' }, b: { number: 1 } } });
      const merged = await updatePage(pgdb.db, page.id, {
        mergeProperties: { b: { number: 2 }, c: { checked: true } },
      });
      expect(merged?.properties).toEqual({
        a: { text: 'one' },
        b: { number: 2 },
        c: { checked: true },
      });
      await deletePageTree(pgdb.db, page.id);
    });

    it('answers undefined for an unknown id and refuses an empty patch', async () => {
      expect(await updatePage(pgdb.db, uuidv7(), { title: 'nobody' })).toBeUndefined();
      const page = await seedPage();
      await expect(updatePage(pgdb.db, page.id, {})).rejects.toThrow(/no fields to write/u);
      await deletePageTree(pgdb.db, page.id);
    });
  });

  describe('deletePageTree', () => {
    it('removes the page, its descendants and their blocks, and counts the pages', async () => {
      const root = await seedPage({ title: 'root' });
      const child = await seedPage({ title: 'child', parentId: root.id });
      const grandchild = await seedPage({ title: 'grandchild', parentId: child.id });
      const bystander = await seedPage({ title: 'bystander' });
      const bystanderChild = await seedPage({ title: 'bystander-child', parentId: bystander.id });

      await pgdb.db.insert(blocks).values([
        { pageId: root.id, type: 'paragraph', content: { text: 'a' }, order: 0 },
        { pageId: grandchild.id, type: 'paragraph', content: { text: 'b' }, order: 0 },
        { pageId: bystander.id, type: 'paragraph', content: { text: 'c' }, order: 0 },
      ]);

      expect(await deletePageTree(pgdb.db, root.id)).toBe(3);
      expect(await findPageById(pgdb.db, root.id)).toBeUndefined();
      expect(await findPageById(pgdb.db, child.id)).toBeUndefined();
      expect(await findPageById(pgdb.db, grandchild.id)).toBeUndefined();

      const survivingBlocks = await pgdb.db.select().from(blocks);
      expect(survivingBlocks.map((block) => block.pageId)).toEqual([bystander.id]);

      // Every descendant is inside the same statement, so the ON DELETE SET
      // NULL action finds no surviving child to detach — a page outside the
      // tree keeps its parent pointer.
      const untouched = await findPageById(pgdb.db, bystanderChild.id);
      expect(untouched?.parentId).toBe(bystander.id);

      await deletePageTree(pgdb.db, bystander.id);
    });

    it('terminates on a parent cycle', async () => {
      const a = await seedPage({ title: 'a' });
      const b = await seedPage({ title: 'b', parentId: a.id });
      // Reachable through the routes: PATCH rejects only a page made its own
      // parent, so reparenting `a` under `b` closes the loop.
      await updatePage(pgdb.db, a.id, { parentId: b.id });

      expect(await deletePageTree(pgdb.db, a.id)).toBe(2);
      expect(await findPageById(pgdb.db, b.id)).toBeUndefined();
    });

    it('is 0 for an id nothing holds', async () => {
      expect(await deletePageTree(pgdb.db, uuidv7())).toBe(0);
    });
  });

  describe('deleteArchivedPages', () => {
    /**
     * The assertion the `ON DELETE SET NULL` decision exists for. Under CASCADE
     * this test fails by returning `undefined` for the live child; under NO
     * ACTION it fails with a foreign-key violation. Both are the failure the
     * choice was made to avoid.
     */
    it('keeps a live child of an archived page, detached rather than destroyed', async () => {
      const archivedParent = await seedPage({ title: 'archived-parent' });
      const liveChild = await seedPage({ title: 'live-child', parentId: archivedParent.id });
      const archivedChild = await seedPage({ title: 'archived-child', parentId: archivedParent.id });
      await updatePage(pgdb.db, archivedParent.id, { archived: true });
      await updatePage(pgdb.db, archivedChild.id, { archived: true });

      expect(await deleteArchivedPages(pgdb.db, workspaceId)).toBe(2);

      const survivor = await findPageById(pgdb.db, liveChild.id);
      expect(survivor).toBeDefined();
      expect(survivor?.parentId).toBeNull();
      expect(await findPageById(pgdb.db, archivedChild.id)).toBeUndefined();

      await deletePageTree(pgdb.db, liveChild.id);
    });
  });

  describe('findPageAncestry', () => {
    it('returns the chain root-first and stops at the depth bound', async () => {
      const root = await seedPage({ title: 'root', icon: 'home' });
      const middle = await seedPage({ title: 'middle', parentId: root.id });
      const leaf = await seedPage({ title: 'leaf', parentId: middle.id });

      expect(await findPageAncestry(pgdb.db, leaf.id)).toEqual([
        { id: root.id, title: 'root', icon: 'home' },
        { id: middle.id, title: 'middle', icon: null },
        { id: leaf.id, title: 'leaf', icon: null },
      ]);
      expect(await findPageAncestry(pgdb.db, root.id)).toEqual([
        { id: root.id, title: 'root', icon: 'home' },
      ]);
      expect(await findPageAncestry(pgdb.db, uuidv7())).toEqual([]);

      await deletePageTree(pgdb.db, root.id);
    });

    it('caps a chain deeper than the bound at exactly the bound', async () => {
      const created: string[] = [];
      let parentId: string | null = null;
      for (let depth = 0; depth < BREADCRUMB_MAX_DEPTH + 5; depth += 1) {
        const page: Awaited<ReturnType<typeof seedPage>> = await seedPage({
          title: `d${depth}`,
          parentId,
        });
        created.push(page.id);
        parentId = page.id;
      }
      const root = created.at(0);
      const deepest = created.at(-1);
      if (!root || !deepest) throw new Error('the deep chain fixture seeded nothing');

      const chain = await findPageAncestry(pgdb.db, deepest);
      expect(chain).toHaveLength(BREADCRUMB_MAX_DEPTH);
      expect(chain.at(-1)?.id).toBe(deepest);

      await deletePageTree(pgdb.db, root);
    });

    /**
     * Postgres's CYCLE clause emits the repeating row once, flagged, before it
     * stops — so without `where not is_cycle` this chain comes back as
     * [b, a, b] rather than [a, b]. The route's `seen` set breaks before
     * appending a repeat; dropping the predicate from the repository is what
     * this asserts against.
     */
    it('terminates on a parent cycle without repeating a crumb', async () => {
      const a = await seedPage({ title: 'cycle-a' });
      const b = await seedPage({ title: 'cycle-b', parentId: a.id });
      await updatePage(pgdb.db, a.id, { parentId: b.id });

      const chain = await findPageAncestry(pgdb.db, b.id);
      expect(chain.map((crumb) => crumb.title)).toEqual(['cycle-a', 'cycle-b']);
      expect(new Set(chain.map((crumb) => crumb.id)).size).toBe(chain.length);

      await deletePageTree(pgdb.db, a.id);
    });
  });

  describe('database rows', () => {
    it('lists, orders, unsets a property and deletes, scoped to one database', async () => {
      const databaseId = uuidv7();
      const otherDatabaseId = uuidv7();
      const first = await seedPage({ databaseId, order: 0, properties: { p1: { text: 'x' }, p2: { number: 1 } } });
      const second = await seedPage({ databaseId, order: 4, properties: { p1: { text: 'y' } } });
      const archivedRow = await seedPage({ databaseId, order: 9 });
      await updatePage(pgdb.db, archivedRow.id, { archived: true });
      const elsewhere = await seedPage({ databaseId: otherDatabaseId, order: 100 });

      expect((await listDatabaseRows(pgdb.db, databaseId)).length).toBe(3);
      expect(
        (await listDatabaseRows(pgdb.db, databaseId, { archived: false })).map((row) => row.id).sort(),
      ).toEqual([first.id, second.id].sort());

      const nextOrder = await nextDatabaseRowOrder(pgdb.db, databaseId);
      expect(typeof nextOrder).toBe('number');
      expect(nextOrder).toBe(10);

      const matched = await removePropertyFromDatabaseRows(pgdb.db, databaseId, 'p1');
      expect(matched).toBe(3);
      expect((await findPageById(pgdb.db, first.id))?.properties).toEqual({ p2: { number: 1 } });
      expect((await findPageById(pgdb.db, second.id))?.properties).toEqual({});
      // Scoped: the other database's row is untouched.
      expect(await nextDatabaseRowOrder(pgdb.db, otherDatabaseId)).toBe(101);

      expect(await deleteDatabaseRows(pgdb.db, databaseId)).toBe(3);
      expect(await listDatabaseRows(pgdb.db, databaseId)).toEqual([]);
      expect(await findPageById(pgdb.db, elsewhere.id)).toBeDefined();

      await deleteDatabaseRows(pgdb.db, otherDatabaseId);
    });
  });
});
