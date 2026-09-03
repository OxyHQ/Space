/**
 * Every query the routes run against `blocks`.
 *
 * Called by `routes/blocks.ts`, `routes/pages.ts` and `routes/share-links.ts`.
 * Each function names its route-level use.
 */

import { and, asc, eq, inArray, isNull, sql } from 'drizzle-orm';
import { qualified, sqlColumnName, uuidv7 } from '@oxyhq/db';
import type { PgHandle } from '../db/client.js';
import { blocks, type BlockContent, type BlockType } from '../db/schema/pages.js';

export type BlockRow = typeof blocks.$inferSelect;

/**
 * `GET /api/pages/:pageId/blocks` — `routes/blocks.ts:426`, sorted
 * `{ parentBlockId: 1, order: 1, createdAt: 1 }`.
 *
 * `NULLS FIRST` is required and is not a stylistic choice. MongoDB's BSON type
 * ordering puts Null before ObjectId, so an ascending sort on `parentBlockId`
 * listed the page's top-level blocks first; Postgres orders ASC `NULLS LAST` by
 * default, which would put every top-level block at the END of the response.
 * The client nests by `parentBlockId` and does not re-sort, so the difference
 * is visible in the editor.
 *
 * `id` is appended as a final tiebreak — `created_at` is millisecond-precision,
 * so blocks created in the same millisecond at the same order tied and the
 * resulting sequence was the storage engine's to choose.
 */
export async function listBlocksForPage(db: PgHandle, pageId: string): Promise<BlockRow[]> {
  return db
    .select()
    .from(blocks)
    .where(eq(blocks.pageId, pageId))
    .orderBy(
      sql`${blocks.parentBlockId} asc nulls first`,
      asc(blocks.order),
      asc(blocks.createdAt),
      asc(blocks.id),
    );
}

/**
 * `GET /api/pages/:id/export` (`routes/pages.ts:745`) and the public shared-page
 * read (`routes/share-links.ts:322`), both sorted `{ order: 1 }` alone.
 *
 * Same tiebreak argument as above, and it bites harder here: the export renders
 * markdown, so an unstable order produces a different document on each request.
 */
export async function listBlocksForPageByOrder(db: PgHandle, pageId: string): Promise<BlockRow[]> {
  return db
    .select()
    .from(blocks)
    .where(eq(blocks.pageId, pageId))
    .orderBy(asc(blocks.order), asc(blocks.createdAt), asc(blocks.id));
}

/**
 * `routes/blocks.ts:511` (the PATCH target), and the parent-block existence
 * checks at `routes/blocks.ts:456,534` and `routes/comments.ts:421,475,499`,
 * which project `.select('pageId')`. As in `pages.ts`, the projection is not
 * preserved: it is a transfer-size choice on a single-row primary-key lookup.
 */
export async function findBlockById(db: PgHandle, id: string): Promise<BlockRow | undefined> {
  const [row] = await db.select().from(blocks).where(eq(blocks.id, id)).limit(1);
  return row;
}

/**
 * `POST /api/pages/:pageId/blocks/reorder` — `routes/blocks.ts:638`, which loads
 * the submitted ids to check they all exist and all belong to the page.
 *
 * The empty-input early return is a saved round trip, not a guard:
 * `inArray(col, [])` renders as the literal `false`.
 */
export async function findBlocksByIds(db: PgHandle, ids: readonly string[]): Promise<BlockRow[]> {
  if (ids.length === 0) return [];
  return db
    .select()
    .from(blocks)
    .where(inArray(blocks.id, [...ids]));
}

/**
 * The order a new sibling takes within `(pageId, parentBlockId)` —
 * `routes/blocks.ts:478-482`. See `pagesRepository.nextSiblingOrder` for why
 * `max()` is safe to read as a `number` here while `count(*)` is not.
 */
export async function nextBlockOrder(
  db: PgHandle,
  scope: { pageId: string; parentBlockId: string | null },
): Promise<number> {
  const [row] = await db
    .select({ maxOrder: sql<number | null>`max(${blocks.order})` })
    .from(blocks)
    .where(
      and(
        eq(blocks.pageId, scope.pageId),
        scope.parentBlockId === null
          ? isNull(blocks.parentBlockId)
          : eq(blocks.parentBlockId, scope.parentBlockId),
      ),
    );
  const maxOrder = row?.maxOrder;
  return maxOrder === null || maxOrder === undefined ? 0 : maxOrder + 1;
}

export interface CreateBlockInput {
  pageId: string;
  parentBlockId?: string | null;
  type: BlockType;
  content: BlockContent;
  order: number;
}

/** `POST /api/pages/:pageId/blocks` — `routes/blocks.ts:485`. */
export async function createBlock(db: PgHandle, input: CreateBlockInput): Promise<BlockRow> {
  const [row] = await db
    .insert(blocks)
    .values({
      pageId: input.pageId,
      parentBlockId: input.parentBlockId ?? null,
      type: input.type,
      content: input.content,
      order: input.order,
    })
    .returning();
  if (!row) throw new Error('createBlock inserted no row');
  return row;
}

export interface UpdateBlockInput {
  parentBlockId?: string | null;
  type?: BlockType;
  /** Always a full replacement — the route re-normalises the whole payload. */
  content?: BlockContent;
  order?: number;
}

/**
 * `PATCH /api/blocks/:id` — `routes/blocks.ts:526-563`.
 *
 * Defined keys only, and `undefined` is distinct from `null`: `parentBlockId`
 * is nullable and an explicit `null` un-nests the block. See
 * `pagesRepository.updatePage` for what these guards do and do not buy —
 * drizzle drops `undefined` from `.set()` on its own, so the observable part
 * they pin is the all-undefined patch reaching the explicit error below.
 *
 * `content` is a replacement rather than a merge, unlike `pages.properties` —
 * the route runs the incoming payload back through `normalizeContent` and
 * persists the result whole (`routes/blocks.ts:551-557`).
 */
export async function updateBlock(
  db: PgHandle,
  id: string,
  patch: UpdateBlockInput,
): Promise<BlockRow | undefined> {
  const values: Record<string, unknown> = {};
  if (patch.parentBlockId !== undefined) values.parentBlockId = patch.parentBlockId;
  if (patch.type !== undefined) values.type = patch.type;
  if (patch.content !== undefined) values.content = patch.content;
  if (patch.order !== undefined) values.order = patch.order;

  if (Object.keys(values).length === 0) {
    throw new Error('updateBlock was given no fields to write');
  }

  const [row] = await db.update(blocks).set(values).where(eq(blocks.id, id)).returning();
  return row;
}

/**
 * `DELETE /api/blocks/:id` — `routes/blocks.ts:596-600`, which BFS-collects
 * descendants through `parentBlockId` and answers with the size of the set.
 *
 * The recursive set is deleted explicitly even though `blocks.parentBlockId`
 * cascades, because a cascade reports no count and the route returns one. One
 * statement, so the cascade only ever has to cover a child inserted after this
 * statement's snapshot. `CYCLE` guards the recursion the same way it does for
 * pages: `PATCH /api/blocks/:id` rejects only a block made its own parent
 * (`routes/blocks.ts:530`), so a longer loop is reachable.
 */
export async function deleteBlockTree(db: PgHandle, rootId: string): Promise<number> {
  const rows = await db.execute(sql`
    with recursive tree as (
      select ${blocks.id} from ${blocks} where ${blocks.id} = ${rootId}
      union all
      select child.${sql.identifier(sqlColumnName(blocks.id))}
      from ${blocks} child
      join tree on child.${sql.identifier(sqlColumnName(blocks.parentBlockId))} = tree.${sql.identifier(sqlColumnName(blocks.id))}
    ) cycle ${sql.identifier(sqlColumnName(blocks.id))} set is_cycle using cycle_path,
    deleted as (
      delete from ${blocks}
      where ${blocks.id} in (select ${sql.identifier(sqlColumnName(blocks.id))} from tree)
      returning ${blocks.id}
    )
    select count(*)::int as deleted_count from deleted
  `);
  // Loud rather than 0: `count(*)` without the `::int` decodes as a string, and
  // a silent fallback would report "deleted nothing" for a statement that
  // deleted a subtree.
  const deleted = rows[0]?.deleted_count;
  if (typeof deleted !== 'number') {
    throw new Error(`deleteBlockTree read a non-numeric count: ${typeof deleted}`);
  }
  return deleted;
}

export interface ReorderResult {
  /** Rows on the page whose id was submitted. Postgres `rowCount` semantics. */
  matched: number;
  /**
   * Rows whose `order` actually changed.
   *
   * This is NARROWER than the number the Mongo route reported, and the
   * difference is deliberate. Mongoose stamps `updatedAt` onto every operation
   * of a `bulkWrite`, so `Block.bulkWrite` (`routes/blocks.ts:661`) rewrote
   * every matched document and its `modifiedCount` equalled `matchedCount`
   * whether or not any block moved. Reporting that number here would mean
   * rewriting rows that did not move purely to keep a count company, and
   * bumping their `updatedAt` — signal a collab layer reads. Nothing consumes
   * either field: the single caller discards the response body
   * (`apps/app/lib/hooks/use-blocks.ts:164`).
   */
  modified: number;
}

/**
 * `POST /api/pages/:pageId/blocks/reorder` — `routes/blocks.ts:654-667`.
 *
 * The route assigns each block its index in the submitted array. It validates
 * every input up front and says why: "Without MongoDB transactions (which
 * require a replica set and aren't assumed available), the inputs are fully
 * validated up-front to minimize the chance of a partial-write outcome"
 * (`routes/blocks.ts:613-617`). Postgres has the transaction, so the count and
 * the write happen inside one — the partial-write outcome the route could only
 * make unlikely is now impossible.
 *
 * Both counts are read with an explicit `::int`. `count(*)` is `bigint`, which
 * postgres.js decodes as a STRING while drizzle types it `number`; without the
 * cast, `matched === blockIds.length` compares a string to a number and is
 * false for every non-empty input.
 */
export async function reorderBlocks(
  db: PgHandle,
  pageId: string,
  blockIds: readonly string[],
): Promise<ReorderResult> {
  if (blockIds.length === 0) return { matched: 0, modified: 0 };

  const targets = sql.join(
    blockIds.map((id, index) => sql`(${id}::text, ${index}::double precision)`),
    sql`, `,
  );
  // `updatedAt` is maintained by the application, and `$onUpdate` only fires
  // through the query builder — a hand-written UPDATE has to stamp it. Bound as
  // an ISO string with an explicit cast rather than as a `Date`: postgres.js
  // fails to serialise a bare `Date` into a statement built this way.
  const now = new Date().toISOString();

  return db.transaction(async (tx) => {
    const [matchedRow] = await tx
      .select({ total: sql<number>`count(*)::int` })
      .from(blocks)
      .where(and(eq(blocks.pageId, pageId), inArray(blocks.id, [...blockIds])));

    const moved = await tx.execute(sql`
      update ${blocks}
      set ${sql.identifier(sqlColumnName(blocks.order))} = target.ord,
          ${sql.identifier(sqlColumnName(blocks.updatedAt))} = ${now}::timestamptz
      from (values ${targets}) as target(id, ord)
      where ${qualified(blocks.id)} = target.id
        and ${qualified(blocks.pageId)} = ${pageId}
        and ${qualified(blocks.order)} is distinct from target.ord
      returning ${qualified(blocks.id)}
    `);

    return { matched: matchedRow?.total ?? 0, modified: moved.length };
  });
}

/**
 * `POST /api/pages/:id/duplicate` — `routes/pages.ts:563-580`, which copies
 * every block of the source page onto the new page, minting ids up front so
 * `parentBlockId` can be rewired in a single insert.
 *
 * Ids are minted here for the same reason: Postgres 17 has no native `uuidv7()`,
 * so `generatedId()` produces them in the application and a pure-SQL
 * `INSERT ... SELECT` could not rewire the parent pointers.
 *
 * A block whose `parentBlockId` names a block outside the source page becomes a
 * root block of the copy, matching the route's `idMap.get(...) ?? null`. That
 * cannot happen through the routes, which reject a cross-page parent
 * (`routes/blocks.ts:461,539`), and it is preserved rather than tightened
 * because tightening it would turn an unreachable case into a failed request.
 *
 * The insert is one statement, so the `parentBlockId` self-reference resolves
 * against rows created by that same statement — referential checks fire at
 * statement end, not per row (asserted in `blocks.pgdb.test.ts`, because a
 * self-referencing foreign key is exactly the construct worth checking against
 * the server rather than the declaration).
 */
export async function duplicateBlocksToPage(
  db: PgHandle,
  sourcePageId: string,
  targetPageId: string,
): Promise<number> {
  const source = await db.select().from(blocks).where(eq(blocks.pageId, sourcePageId));
  if (source.length === 0) return 0;

  const idMap = new Map(source.map((block) => [block.id, uuidv7()]));
  const copies = source.map((block) => {
    const id = idMap.get(block.id);
    if (id === undefined) throw new Error('duplicateBlocksToPage lost an id while rewiring');
    return {
      id,
      pageId: targetPageId,
      parentBlockId: block.parentBlockId ? (idMap.get(block.parentBlockId) ?? null) : null,
      type: block.type,
      content: block.content,
      order: block.order,
    };
  });

  await db.insert(blocks).values(copies);
  return copies.length;
}
