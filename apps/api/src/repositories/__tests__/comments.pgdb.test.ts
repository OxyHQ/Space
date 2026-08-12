import { eq, sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { executeRows, isForeignKeyViolation } from '@oxyhq/db';
import { closeTestDb, getTestDb, type TestDatabase, testScope } from '../../db/__tests__/testDatabase.js';
import { comments } from '../../db/schema/collab.js';
import { blocks, pages } from '../../db/schema/pages.js';
import { workspaces } from '../../db/schema/workspaces.js';
import {
  type CommentContent,
  createComment,
  deleteComment,
  deleteCommentThread,
  findCommentById,
  findCommentsByIds,
  listCommentsByBlock,
  listCommentsByPage,
  listOpenThreadRoots,
  setCommentResolvedAt,
  updateCommentContent,
} from '../comments.js';

let db: TestDatabase;

/** Every id this file writes carries this prefix — see `testScope`. */
const scope = testScope('comments');
const workspaceId = `${scope}-ws`;
const pageId = `${scope}-page`;
const otherPageId = `${scope}-page2`;
const blockId = `${scope}-block`;
const authorId = `${scope}-author`;

function content(plainText: string): CommentContent {
  return {
    segments: [{ type: 'text', text: plainText }],
    plainText,
  };
}

/**
 * Pages and blocks are REAL rows now, not synthetic ids: `comments.pageId` and
 * `comments.blockId` carry foreign keys. A fixture that invented an id would
 * fail the insert, which is the constraint doing its job.
 */
async function seedPage(id: string): Promise<string> {
  await db
    .insert(pages)
    .values({ id, workspaceId, title: `${scope} page`, ownerId: authorId })
    .onConflictDoNothing();
  return id;
}

beforeAll(async () => {
  db = await getTestDb();
  await db
    .insert(workspaces)
    .values({ id: workspaceId, name: `${scope} workspace`, ownerId: authorId })
    .onConflictDoNothing();
  await seedPage(pageId);
  await seedPage(otherPageId);
  await db
    .insert(blocks)
    .values({ id: blockId, pageId, type: 'paragraph' })
    .onConflictDoNothing();
});

afterAll(async () => {
  // The workspace cascade takes the comments with it.
  await db.delete(workspaces).where(eq(workspaces.id, workspaceId));
  await closeTestDb();
});

async function newComment(overrides: Partial<Parameters<typeof createComment>[1]> = {}) {
  return createComment(db, {
    workspaceId,
    pageId,
    authorId,
    content: content('hello'),
    ...overrides,
  });
}

describe('comments repository', () => {
  it('round-trips content through the two flattened columns', async () => {
    const created = await newComment({
      content: {
        segments: [
          { type: 'text', text: 'hi ' },
          { type: 'mention', kind: 'user', id: authorId, originalText: '@nate' },
        ],
        plainText: 'hi @nate',
      },
    });

    expect(created.content.plainText).toBe('hi @nate');
    expect(created.content.segments).toHaveLength(2);

    const read = await findCommentById(db, created.id);
    expect(read?.content).toEqual({
      segments: [
        { type: 'text', text: 'hi ' },
        { type: 'mention', kind: 'user', id: authorId, originalText: '@nate' },
      ],
      plainText: 'hi @nate',
    });
  });

  /**
   * The flattening hazard, stated as an assertion rather than as a comment: a
   * caller reading the raw row gets `undefined` from `content`, and
   * `undefined?.plainText` in the mention fan-out would send an empty preview
   * with nothing erroring. This pins that only the repository's shape is the
   * one callers may use.
   */
  it('stores plain text in its own NOT NULL column, not inside the jsonb', async () => {
    const created = await newComment({ content: content('preview text') });
    const rows = await executeRows<{ content_plain_text: string; content_segments: unknown }>(
      db,
      sql`select content_plain_text, content_segments from comments where id = ${created.id}`,
    );
    expect(rows[0]?.content_plain_text).toBe('preview text');
    expect(rows[0]).not.toHaveProperty('content');
  });

  it('defaults blockId, parentCommentId, resolvedAt and editedAt to null', async () => {
    const created = await newComment();
    expect(created.blockId).toBeNull();
    expect(created.parentCommentId).toBeNull();
    expect(created.resolvedAt).toBeNull();
    expect(created.editedAt).toBeNull();
  });

  it('lists a page oldest-first and does not leak another page', async () => {
    const localPage = await seedPage(`${scope}-list-page`);
    const first = await newComment({
      pageId: localPage,
      content: content('first'),
    });
    const second = await newComment({
      pageId: localPage,
      content: content('second'),
    });
    await newComment({ pageId: otherPageId, content: content('elsewhere') });

    // Explicit timestamps: uuidv7 is not monotonic within a millisecond, so
    // creation order is not a property of the ids.
    await db
      .update(comments)
      .set({ createdAt: new Date('2026-01-01T00:00:00.000Z') })
      .where(eq(comments.id, first.id));
    await db
      .update(comments)
      .set({ createdAt: new Date('2026-01-02T00:00:00.000Z') })
      .where(eq(comments.id, second.id));

    const listed = await listCommentsByPage(db, localPage);
    expect(listed.map((c) => c.id)).toEqual([first.id, second.id]);
  });

  it('lists a block', async () => {
    const created = await newComment({ blockId, content: content('on a block') });
    await newComment({ content: content('page level') });

    const listed = await listCommentsByBlock(db, blockId);
    expect(listed.map((c) => c.id)).toEqual([created.id]);
  });

  it('stamps editedAt on a content update and leaves createdAt alone', async () => {
    const created = await newComment({ content: content('before') });
    const editedAt = new Date('2026-03-04T05:06:07.000Z');

    const updated = await updateCommentContent(db, created.id, content('after'), editedAt);

    expect(updated?.content.plainText).toBe('after');
    expect(updated?.editedAt).toEqual(editedAt);
    expect(updated?.createdAt).toEqual(created.createdAt);
    expect(updated?.updatedAt.getTime()).toBeGreaterThanOrEqual(created.updatedAt.getTime());
  });

  it('returns null when updating a comment that is not there', async () => {
    expect(await updateCommentContent(db, `${scope}-missing`, content('x'), new Date())).toBeNull();
  });

  it('resolves and reopens a thread', async () => {
    const created = await newComment();
    const at = new Date('2026-02-02T00:00:00.000Z');

    expect((await setCommentResolvedAt(db, created.id, at))?.resolvedAt).toEqual(at);
    expect((await setCommentResolvedAt(db, created.id, null))?.resolvedAt).toBeNull();
  });

  describe('deletes', () => {
    it('takes replies with the thread and reports the whole count', async () => {
      const root = await newComment({ content: content('root') });
      await newComment({ parentCommentId: root.id, content: content('reply one') });
      await newComment({ parentCommentId: root.id, content: content('reply two') });

      expect(await deleteCommentThread(db, root.id)).toBe(3);
      expect(await findCommentById(db, root.id)).toBeNull();
    });

    /**
     * The cascade is the schema's, not the query's. Deleting the parent row
     * through a bare statement must still take the replies, or the route's
     * "delete a reply" path could orphan rows the repository never sees.
     */
    it('the FK cascade removes replies even without the OR predicate', async () => {
      const root = await newComment({ content: content('root') });
      const reply = await newComment({ parentCommentId: root.id, content: content('reply') });

      await db.delete(comments).where(eq(comments.id, root.id));

      expect(await findCommentById(db, reply.id)).toBeNull();
    });

    it('deletes a single reply without touching its root', async () => {
      const root = await newComment({ content: content('root') });
      const reply = await newComment({ parentCommentId: root.id, content: content('reply') });

      expect(await deleteComment(db, reply.id)).toBe(1);
      expect(await findCommentById(db, root.id)).not.toBeNull();
    });

    it('reports zero for an id that is not there', async () => {
      expect(await deleteComment(db, `${scope}-nope`)).toBe(0);
      expect(await deleteCommentThread(db, `${scope}-nope`)).toBe(0);
    });

    /**
     * Deleting a PAGE takes its comments. Nothing in Mongo did this — all four
     * hard-delete paths touched only Block and Page — but an orphan was
     * unreachable through either list query, so collecting it changes nothing
     * observable.
     */
    it('deleting a page takes its comments', async () => {
      const doomedPage = await seedPage(`${scope}-doomed-page`);
      const doomed = await newComment({ pageId: doomedPage, content: content('goes away') });
      const survivor = await newComment({ content: content('different page') });

      await db.delete(pages).where(eq(pages.id, doomedPage));

      expect(await findCommentById(db, doomed.id)).toBeNull();
      expect(await findCommentById(db, survivor.id)).not.toBeNull();
    });

    /**
     * Deleting a BLOCK must NOT take its comments — the asymmetry with the page
     * cascade above is the point, and it is the difference between a correct
     * port and silent data loss on an everyday editing action.
     *
     * `DELETE /blocks/:id` removes a block while the page survives, and the
     * page comment list selects on `pageId`, so today the comment stays
     * visible. Under `cascade` it would vanish; under `set null` it stays
     * visible and simply stops carrying a dangling block id.
     */
    it('deleting a block keeps its comments and clears the anchor', async () => {
      const doomedBlockId = `${scope}-doomed-block`;
      await db.insert(blocks).values({ id: doomedBlockId, pageId, type: 'paragraph' });
      const anchored = await newComment({
        blockId: doomedBlockId,
        content: content('comment on a paragraph someone later deleted'),
      });

      await db.delete(blocks).where(eq(blocks.id, doomedBlockId));

      const after = await findCommentById(db, anchored.id);
      expect(after).not.toBeNull();
      expect(after?.blockId).toBeNull();
      expect(after?.content.plainText).toBe('comment on a paragraph someone later deleted');
      // Still returned by the page comment list, exactly as before the port.
      expect((await listCommentsByPage(db, pageId)).map((c) => c.id)).toContain(anchored.id);
    });
  });

  describe('open thread roots', () => {
    it('excludes resolved roots and replies', async () => {
      const localPage = await seedPage(`${scope}-roots-page`);
      const open = await newComment({ pageId: localPage, content: content('open') });
      const resolved = await newComment({ pageId: localPage, content: content('resolved') });
      await newComment({
        pageId: localPage,
        parentCommentId: open.id,
        content: content('reply'),
      });
      await setCommentResolvedAt(db, resolved.id, new Date());

      const roots = await listOpenThreadRoots(db, localPage);
      expect(roots.map((r) => r.id)).toEqual([open.id]);
    });
  });

  describe('findCommentsByIds', () => {
    it('returns nothing for an empty list without hitting the database', async () => {
      expect(await findCommentsByIds(db, [])).toEqual([]);
    });

    it('returns exactly the requested ids', async () => {
      const a = await newComment({ content: content('a') });
      const b = await newComment({ content: content('b') });
      await newComment({ content: content('c') });

      const found = await findCommentsByIds(db, [a.id, b.id]);
      expect(found.map((c) => c.id).sort()).toEqual([a.id, b.id].sort());
    });
  });

  describe('constraints', () => {
    /**
     * Named constraints, not a bare `rejects.toThrow()`. There are now three
     * foreign keys on this table, so an unnamed rejection would pass for the
     * wrong reason — a test asserting "the workspace FK holds" that is actually
     * satisfied by the page FK firing first tells you nothing about the
     * workspace FK at all.
     */
    it('refuses a comment whose workspace does not exist', async () => {
      await expect(
        createComment(db, {
          workspaceId: `${scope}-no-such-workspace`,
          pageId,
          authorId,
          content: content('orphan'),
        }),
      ).rejects.toSatisfy((error: unknown) =>
        isForeignKeyViolation(error, 'comments_workspace_id_workspaces_id_fk'),
      );
    });

    it('refuses a comment on a page that does not exist', async () => {
      await expect(
        createComment(db, {
          workspaceId,
          pageId: `${scope}-no-such-page`,
          authorId,
          content: content('orphan'),
        }),
      ).rejects.toSatisfy((error: unknown) =>
        isForeignKeyViolation(error, 'comments_page_id_pages_id_fk'),
      );
    });

    it('refuses a comment anchored to a block that does not exist', async () => {
      await expect(
        createComment(db, {
          workspaceId,
          pageId,
          blockId: `${scope}-no-such-block`,
          authorId,
          content: content('orphan'),
        }),
      ).rejects.toSatisfy((error: unknown) =>
        isForeignKeyViolation(error, 'comments_block_id_blocks_id_fk'),
      );
    });

    it('refuses non-array segments', async () => {
      await expect(
        executeRows(
          db,
          sql`insert into comments
                (id, workspace_id, page_id, author_id, content_segments, content_plain_text)
              values (${`${scope}-badseg`}, ${workspaceId}, ${pageId}, ${authorId},
                      '{"not":"an array"}'::jsonb, '')`,
        ),
      ).rejects.toThrow();
    });

    it('refuses a reply pointing at a comment that does not exist', async () => {
      await expect(
        createComment(db, {
          workspaceId,
          pageId,
          parentCommentId: `${scope}-ghost-parent`,
          authorId,
          content: content('orphan reply'),
        }),
      ).rejects.toThrow();
    });
  });
});
