/**
 * `blocks` against a real PostgreSQL 17. See `pages.pgdb.test.ts` for why this
 * suite skips without `TEST_DATABASE_URL`.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { eq, sql } from 'drizzle-orm';
import { getTableConfig } from 'drizzle-orm/pg-core';
import { isCheckViolation, isForeignKeyViolation, sqlColumnName, uuidv7 } from '@oxyhq/db';
import { BLOCK_TYPES as MODEL_BLOCK_TYPES } from '../models/block.js';
import { openPgdb, PGDB_ADMIN_URL, type Pgdb } from '../db/__tests__/pgdb-harness.js';
import { blocks, BLOCK_TYPES, pages } from '../db/schema/pages.js';
import { workspaces } from '../db/schema/workspaces.js';
import { createPage, deletePageTree } from './pages.js';
import {
  createBlock,
  deleteBlockTree,
  duplicateBlocksToPage,
  findBlockById,
  findBlocksByIds,
  listBlocksForPage,
  listBlocksForPageByOrder,
  nextBlockOrder,
  reorderBlocks,
  updateBlock,
} from './blocks.js';

describe.skipIf(!PGDB_ADMIN_URL)('blocks repository (real database)', () => {
  let pgdb: Pgdb;
  let workspaceId: string;
  let pageId: string;

  beforeAll(async () => {
    pgdb = await openPgdb();
    const [workspace] = await pgdb.db
      .insert(workspaces)
      .values({ name: 'blocks-repo', ownerId: 'user-owner' })
      .returning();
    if (!workspace) throw new Error('fixture workspace was not created');
    workspaceId = workspace.id;
    const page = await createPage(pgdb.db, { workspaceId, ownerId: 'user-owner', order: 0 });
    pageId = page.id;
  });

  afterAll(async () => {
    await pgdb?.close();
  });

  /** A page of its own, so a test that lists or reorders owns everything it counts. */
  async function seedPage() {
    const page = await createPage(pgdb.db, { workspaceId, ownerId: 'user-owner', order: 0 });
    return page.id;
  }

  describe('schema', () => {
    /**
     * Writers of `blocks`, from a repo-wide census: `routes/blocks.ts:485`
     * (create), `routes/blocks.ts:526-563` (patch), `routes/blocks.ts:654-661`
     * (reorder, `order` only) and `routes/pages.ts:572-580` (duplicate).
     */
    const WRITER_FIELDS = ['pageId', 'parentBlockId', 'type', 'content', 'order'] as const;

    it('declares a column for every field a route writes, and no column without one', () => {
      const declared = getTableConfig(blocks).columns.map((column) => column.name);
      expect(WRITER_FIELDS.length).toBe(5);
      for (const field of WRITER_FIELDS) expect(declared).toContain(field);
      expect(new Set(declared)).toEqual(
        new Set([...WRITER_FIELDS, 'id', 'createdAt', 'updatedAt']),
      );
    });

    it('created exactly the columns it declares', async () => {
      const rows = await pgdb.db.execute<{ column_name: string }>(sql`
        select column_name from information_schema.columns
        where table_schema = 'public' and table_name = 'blocks'
      `);
      const live = new Set(rows.map((row) => row.column_name));
      const config = getTableConfig(blocks);
      expect(config.columns.length).toBe(8);
      for (const column of config.columns) expect(live).toContain(sqlColumnName(column));
      expect(live.size).toBe(config.columns.length);
    });

    it('carries every ported index', async () => {
      const rows = await pgdb.db.execute<{ indexname: string }>(sql`
        select indexname from pg_indexes where schemaname = 'public' and tablename = 'blocks'
      `);
      expect(new Set(rows.map((row) => row.indexname))).toEqual(
        new Set(['blocks_pkey', 'blocks_page_parent_order_idx', 'blocks_parent_block_idx']),
      );
    });

    it('resolves the self-reference on parentBlockId in the catalogue', async () => {
      const rows = await pgdb.db.execute<{ def: string }>(sql`
        select pg_get_constraintdef(oid) as def from pg_constraint
        where conname = 'blocks_parent_block_id_blocks_id_fk'
      `);
      expect(rows).toHaveLength(1);
      expect(rows[0]?.def).toContain('FOREIGN KEY (parent_block_id) REFERENCES blocks(id)');
      expect(rows[0]?.def).toContain('ON DELETE CASCADE');
    });

    /**
     * A drift gate, not a tautology: `BLOCK_TYPES` is declared in the schema
     * module so drizzle-kit never has to load mongoose, which means two lists
     * exist for as long as the Mongoose model does. This assertion retires with
     * `src/models/block.ts`; when that file goes, delete this test rather than
     * relaxing it.
     */
    it('keeps the schema block-type list identical to the model it replaces', () => {
      expect(BLOCK_TYPES.length).toBe(32);
      expect(MODEL_BLOCK_TYPES.length).toBe(32);
      expect([...BLOCK_TYPES]).toEqual([...MODEL_BLOCK_TYPES]);
    });

    it('refuses a block type outside the list', async () => {
      await expect(
        pgdb.db.insert(blocks).values({ pageId, type: 'not_a_block' as never, content: {}, order: 0 }),
      ).rejects.toSatisfy(isCheckViolation);
    });

    it('refuses a block on a page that does not exist', async () => {
      await expect(
        createBlock(pgdb.db, { pageId: uuidv7(), type: 'paragraph', content: {}, order: 0 }),
      ).rejects.toSatisfy(isForeignKeyViolation);
    });
  });

  describe('createBlock', () => {
    it('round-trips content and applies the Mongoose defaults', async () => {
      const content = { text: 'hello', segments: [{ text: 'hello', bold: true }], color: 'blue' };
      const block = await createBlock(pgdb.db, { pageId, type: 'paragraph', content, order: 2 });
      expect(block.parentBlockId).toBeNull();
      expect(block.order).toBe(2);
      expect(block.content).toEqual(content);

      const read = await findBlockById(pgdb.db, block.id);
      expect(read).toEqual(block);
      expect(await findBlockById(pgdb.db, uuidv7())).toBeUndefined();

      await deleteBlockTree(pgdb.db, block.id);
    });
  });

  describe('listBlocksForPage', () => {
    /**
     * The MongoDB→Postgres null-ordering divergence, pinned. BSON orders Null
     * before ObjectId, so `sort({ parentBlockId: 1 })` listed top-level blocks
     * FIRST; Postgres ASC is NULLS LAST by default and would list them last.
     * Dropping `nulls first` from the repository moves both roots to the end of
     * this array.
     */
    it('lists top-level blocks before nested ones, then by order', async () => {
      const page = await seedPage();
      const rootA = await createBlock(pgdb.db, { pageId: page, type: 'toggle', content: {}, order: 0 });
      const rootB = await createBlock(pgdb.db, { pageId: page, type: 'paragraph', content: {}, order: 1 });
      const childSecond = await createBlock(pgdb.db, {
        pageId: page,
        parentBlockId: rootA.id,
        type: 'paragraph',
        content: {},
        order: 1,
      });
      const childFirst = await createBlock(pgdb.db, {
        pageId: page,
        parentBlockId: rootA.id,
        type: 'paragraph',
        content: {},
        order: 0,
      });

      const listed = await listBlocksForPage(pgdb.db, page);
      expect(listed.map((block) => block.id)).toEqual([
        rootA.id,
        rootB.id,
        childFirst.id,
        childSecond.id,
      ]);

      await deletePageTree(pgdb.db, page);
    });

    it('orders by order alone for the export and the shared-page read', async () => {
      const page = await seedPage();
      const first = await createBlock(pgdb.db, { pageId: page, type: 'heading_1', content: {}, order: 0 });
      const nested = await createBlock(pgdb.db, {
        pageId: page,
        parentBlockId: first.id,
        type: 'paragraph',
        content: {},
        order: 1,
      });
      const last = await createBlock(pgdb.db, { pageId: page, type: 'paragraph', content: {}, order: 2 });

      expect((await listBlocksForPageByOrder(pgdb.db, page)).map((block) => block.id)).toEqual([
        first.id,
        nested.id,
        last.id,
      ]);

      await deletePageTree(pgdb.db, page);
    });

    it('is empty for a page with no blocks', async () => {
      const page = await seedPage();
      expect(await listBlocksForPage(pgdb.db, page)).toEqual([]);
      await deletePageTree(pgdb.db, page);
    });
  });

  describe('nextBlockOrder', () => {
    it('is 0 with no sibling, max+1 otherwise, and scoped to the parent block', async () => {
      const page = await seedPage();
      expect(await nextBlockOrder(pgdb.db, { pageId: page, parentBlockId: null })).toBe(0);

      const parent = await createBlock(pgdb.db, { pageId: page, type: 'toggle', content: {}, order: 3 });
      expect(await nextBlockOrder(pgdb.db, { pageId: page, parentBlockId: null })).toBe(4);
      expect(await nextBlockOrder(pgdb.db, { pageId: page, parentBlockId: parent.id })).toBe(0);

      await createBlock(pgdb.db, {
        pageId: page,
        parentBlockId: parent.id,
        type: 'paragraph',
        content: {},
        order: 1.5,
      });
      const next = await nextBlockOrder(pgdb.db, { pageId: page, parentBlockId: parent.id });
      expect(typeof next).toBe('number');
      expect(next).toBe(2.5);

      await deletePageTree(pgdb.db, page);
    });
  });

  describe('updateBlock', () => {
    it('writes only defined keys, replaces content whole, and un-nests on an explicit null', async () => {
      const page = await seedPage();
      const parent = await createBlock(pgdb.db, { pageId: page, type: 'toggle', content: {}, order: 0 });
      const child = await createBlock(pgdb.db, {
        pageId: page,
        parentBlockId: parent.id,
        type: 'paragraph',
        content: { text: 'before', checked: false },
        order: 0,
      });

      const retyped = await updateBlock(pgdb.db, child.id, { type: 'todo', order: undefined });
      expect(retyped?.type).toBe('todo');
      expect(retyped?.order).toBe(0);
      expect(retyped?.parentBlockId).toBe(parent.id);
      // `content` is a replacement, not a merge — the route re-normalises the
      // whole payload before it reaches here.
      const replaced = await updateBlock(pgdb.db, child.id, { content: { text: 'after' } });
      expect(replaced?.content).toEqual({ text: 'after' });

      const unnested = await updateBlock(pgdb.db, child.id, { parentBlockId: null });
      expect(unnested?.parentBlockId).toBeNull();

      expect(await updateBlock(pgdb.db, uuidv7(), { order: 1 })).toBeUndefined();
      await expect(updateBlock(pgdb.db, child.id, {})).rejects.toThrow(/no fields to write/u);

      await deletePageTree(pgdb.db, page);
    });
  });

  describe('deleteBlockTree', () => {
    it('removes the block and its descendants, counts them, and leaves siblings alone', async () => {
      const page = await seedPage();
      const root = await createBlock(pgdb.db, { pageId: page, type: 'toggle', content: {}, order: 0 });
      const child = await createBlock(pgdb.db, {
        pageId: page,
        parentBlockId: root.id,
        type: 'toggle',
        content: {},
        order: 0,
      });
      const grandchild = await createBlock(pgdb.db, {
        pageId: page,
        parentBlockId: child.id,
        type: 'paragraph',
        content: {},
        order: 0,
      });
      const sibling = await createBlock(pgdb.db, { pageId: page, type: 'paragraph', content: {}, order: 1 });

      expect(await deleteBlockTree(pgdb.db, root.id)).toBe(3);
      expect(await findBlockById(pgdb.db, child.id)).toBeUndefined();
      expect(await findBlockById(pgdb.db, grandchild.id)).toBeUndefined();
      expect(await findBlockById(pgdb.db, sibling.id)).toBeDefined();
      expect(await deleteBlockTree(pgdb.db, uuidv7())).toBe(0);

      await deletePageTree(pgdb.db, page);
    });

    it('terminates on a parent-block cycle', async () => {
      const page = await seedPage();
      const a = await createBlock(pgdb.db, { pageId: page, type: 'toggle', content: {}, order: 0 });
      const b = await createBlock(pgdb.db, {
        pageId: page,
        parentBlockId: a.id,
        type: 'toggle',
        content: {},
        order: 0,
      });
      await updateBlock(pgdb.db, a.id, { parentBlockId: b.id });

      expect(await deleteBlockTree(pgdb.db, a.id)).toBe(2);
      expect(await listBlocksForPage(pgdb.db, page)).toEqual([]);

      await deletePageTree(pgdb.db, page);
    });

    it('goes when its page goes', async () => {
      const page = await seedPage();
      const parent = await createBlock(pgdb.db, { pageId: page, type: 'toggle', content: {}, order: 0 });
      await createBlock(pgdb.db, {
        pageId: page,
        parentBlockId: parent.id,
        type: 'paragraph',
        content: {},
        order: 0,
      });

      await deletePageTree(pgdb.db, page);
      const survivors = await pgdb.db.select().from(blocks).where(eq(blocks.pageId, page));
      expect(survivors).toEqual([]);
    });
  });

  describe('findBlocksByIds', () => {
    it('returns the rows it is asked for, and [] for no ids', async () => {
      const page = await seedPage();
      const first = await createBlock(pgdb.db, { pageId: page, type: 'paragraph', content: {}, order: 0 });
      const second = await createBlock(pgdb.db, { pageId: page, type: 'paragraph', content: {}, order: 1 });

      const found = await findBlocksByIds(pgdb.db, [first.id, second.id, uuidv7()]);
      expect(found.map((block) => block.id).sort()).toEqual([first.id, second.id].sort());
      expect(await findBlocksByIds(pgdb.db, [])).toEqual([]);

      await deletePageTree(pgdb.db, page);
    });
  });

  describe('reorderBlocks', () => {
    it('assigns array position as order, and reports matched and modified as numbers', async () => {
      const page = await seedPage();
      const first = await createBlock(pgdb.db, { pageId: page, type: 'paragraph', content: {}, order: 0 });
      const second = await createBlock(pgdb.db, { pageId: page, type: 'paragraph', content: {}, order: 1 });
      const third = await createBlock(pgdb.db, { pageId: page, type: 'paragraph', content: {}, order: 2 });

      const reversed = await reorderBlocks(pgdb.db, page, [third.id, second.id, first.id]);
      // `count(*)` is bigint and postgres.js decodes it as a STRING while
      // drizzle types it `number`. Without the `::int`, this comparison is
      // `"3" === 3` and fails — which is the point of asserting the type.
      expect(typeof reversed.matched).toBe('number');
      expect(reversed).toEqual({ matched: 3, modified: 2 });
      expect((await listBlocksForPageByOrder(pgdb.db, page)).map((block) => block.id)).toEqual([
        third.id,
        second.id,
        first.id,
      ]);

      await deletePageTree(pgdb.db, page);
    });

    it('matches every submitted row but modifies none when nothing moves', async () => {
      const page = await seedPage();
      const first = await createBlock(pgdb.db, { pageId: page, type: 'paragraph', content: {}, order: 0 });
      const second = await createBlock(pgdb.db, { pageId: page, type: 'paragraph', content: {}, order: 1 });

      const before = await findBlockById(pgdb.db, first.id);
      await new Promise((resolve) => setTimeout(resolve, 5));
      const settled = await reorderBlocks(pgdb.db, page, [first.id, second.id]);
      expect(settled).toEqual({ matched: 2, modified: 0 });

      // A row that did not move keeps its `updatedAt`. Mongoose stamped one on
      // every operation of a bulkWrite; this port does not rewrite a row it did
      // not change.
      const after = await findBlockById(pgdb.db, first.id);
      expect(after?.updatedAt.getTime()).toBe(before?.updatedAt.getTime());

      await deletePageTree(pgdb.db, page);
    });

    it('stamps updatedAt on the rows that did move', async () => {
      const page = await seedPage();
      const first = await createBlock(pgdb.db, { pageId: page, type: 'paragraph', content: {}, order: 0 });
      const second = await createBlock(pgdb.db, { pageId: page, type: 'paragraph', content: {}, order: 1 });

      await new Promise((resolve) => setTimeout(resolve, 5));
      await reorderBlocks(pgdb.db, page, [second.id, first.id]);
      const moved = await findBlockById(pgdb.db, first.id);
      expect(moved?.updatedAt.getTime()).toBeGreaterThan(first.updatedAt.getTime());

      await deletePageTree(pgdb.db, page);
    });

    it('refuses to touch a block on another page, and answers 0/0 for no ids', async () => {
      const page = await seedPage();
      const otherPage = await seedPage();
      const mine = await createBlock(pgdb.db, { pageId: page, type: 'paragraph', content: {}, order: 0 });
      const theirs = await createBlock(pgdb.db, {
        pageId: otherPage,
        type: 'paragraph',
        content: {},
        order: 5,
      });

      const result = await reorderBlocks(pgdb.db, page, [mine.id, theirs.id]);
      expect(result.matched).toBe(1);
      expect((await findBlockById(pgdb.db, theirs.id))?.order).toBe(5);
      expect(await reorderBlocks(pgdb.db, page, [])).toEqual({ matched: 0, modified: 0 });

      await deletePageTree(pgdb.db, page);
      await deletePageTree(pgdb.db, otherPage);
    });
  });

  describe('duplicateBlocksToPage', () => {
    /**
     * The insert is one statement and the copies reference each other through
     * `parentBlockId`, so this asserts what a self-referencing foreign key
     * actually does rather than what the declaration says: referential checks
     * fire at statement end, not per row.
     */
    it('copies the whole tree and rewires parent pointers within the copy', async () => {
      const source = await seedPage();
      const target = await seedPage();
      const root = await createBlock(pgdb.db, { pageId: source, type: 'toggle', content: { text: 'r' }, order: 0 });
      const child = await createBlock(pgdb.db, {
        pageId: source,
        parentBlockId: root.id,
        type: 'paragraph',
        content: { text: 'c' },
        order: 0,
      });
      const grandchild = await createBlock(pgdb.db, {
        pageId: source,
        parentBlockId: child.id,
        type: 'paragraph',
        content: { text: 'g' },
        order: 0,
      });

      expect(await duplicateBlocksToPage(pgdb.db, source, target)).toBe(3);

      const copies = await listBlocksForPage(pgdb.db, target);
      expect(copies).toHaveLength(3);
      const byText = new Map(copies.map((block) => [String(block.content.text), block]));
      expect(byText.get('r')?.parentBlockId).toBeNull();
      expect(byText.get('c')?.parentBlockId).toBe(byText.get('r')?.id);
      expect(byText.get('g')?.parentBlockId).toBe(byText.get('c')?.id);
      // New ids, not the source's.
      for (const copy of copies) {
        expect([root.id, child.id, grandchild.id]).not.toContain(copy.id);
      }
      // The source is untouched.
      expect(await listBlocksForPage(pgdb.db, source)).toHaveLength(3);

      await deletePageTree(pgdb.db, source);
      await deletePageTree(pgdb.db, target);
    });

    it('is 0 for a page with no blocks', async () => {
      const source = await seedPage();
      const target = await seedPage();
      expect(await duplicateBlocksToPage(pgdb.db, source, target)).toBe(0);
      await deletePageTree(pgdb.db, source);
      await deletePageTree(pgdb.db, target);
    });
  });

  it('leaves the shared fixture page usable throughout', async () => {
    const [page] = await pgdb.db.select().from(pages).where(eq(pages.id, pageId));
    expect(page?.workspaceId).toBe(workspaceId);
  });
});
