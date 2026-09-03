/**
 * Every query the routes run against `pages`.
 *
 * `routes/pages.ts`, `routes/databases.ts` and `routes/workspaces.ts` call this
 * repository. Each function below names its route-level use so a function
 * nobody calls remains visible as one.
 *
 * Where Mongo and Postgres disagree, the divergence is stated at the function
 * that carries it. The schema-level decisions (the `parentId` referential
 * action above all) live in `../db/schema/pages.ts`.
 */

import { and, asc, eq, inArray, isNull, sql } from 'drizzle-orm';
import { sqlColumnName } from '@oxyhq/db';
import type { PgHandle } from '../db/client.js';
import { pages, type PageProperties } from '../db/schema/pages.js';

export type PageRow = typeof pages.$inferSelect;

/**
 * Ancestors are read with a narrow projection because the breadcrumb response
 * is `{id, title, icon}` and nothing else (`routes/pages.ts:612`).
 */
export interface PageCrumb {
  id: string;
  title: string;
  icon: string | null;
}

/**
 * Depth bound of the breadcrumb walk, matching `routes/pages.ts:616`
 * (`while (cursor && depth < 32)`), which appends at depths 0..31 and so
 * returns at most 32 entries.
 */
export const BREADCRUMB_MAX_DEPTH = 32;

export interface ListPagesFilter {
  workspaceId: string;
  /**
   * `undefined` — every depth (the query parameter was absent).
   * `null` — root pages only.
   * A string — children of that page.
   *
   * The three-way split is load-bearing: `?parentId=root` and `?parentId=null`
   * both mean root (`routes/pages.ts:216-221`), and a root filter must compile
   * to `parent_id IS NULL`. `eq(pages.parentId, null)` would render `= NULL`,
   * which matches nothing and returns an empty list with no error.
   */
  parentId?: string | null;
  /**
   * `undefined` — archived and active together (`?includeArchived=true`).
   * `true` — the trash view (`?archivedOnly=true`).
   * `false` — the default listing.
   */
  archived?: boolean;
  /** `?favoritedOnly=true`. Adds `favorited = true`; never `favorited = false`. */
  favoritedOnly?: boolean;
}

/**
 * `GET /api/pages` — `routes/pages.ts:233`.
 *
 * Mongo sorted `{ order: 1, createdAt: 1 }`. `id` is appended as a final
 * tiebreak: `created_at` is stored at millisecond precision, so two pages
 * created in the same millisecond at the same order tied, and the resulting
 * sequence was whatever the storage engine returned. Porting that
 * arbitrariness is not an option — the client renders this list in order.
 */
export async function listPages(db: PgHandle, filter: ListPagesFilter): Promise<PageRow[]> {
  const predicates = [eq(pages.workspaceId, filter.workspaceId)];
  if (filter.parentId !== undefined) {
    predicates.push(filter.parentId === null ? isNull(pages.parentId) : eq(pages.parentId, filter.parentId));
  }
  if (filter.archived !== undefined) predicates.push(eq(pages.archived, filter.archived));
  if (filter.favoritedOnly) predicates.push(eq(pages.favorited, true));

  return db
    .select()
    .from(pages)
    .where(and(...predicates))
    .orderBy(asc(pages.order), asc(pages.createdAt), asc(pages.id));
}

/**
 * `GET /api/pages/:id` — `routes/pages.ts:253`, and the workspace-resolution
 * lookup every `:id` route performs before checking membership
 * (`routes/pages.ts:301,372,459,525,601,736`, `routes/blocks.ts:417,446,517,587,628`,
 * `routes/comments.ts:371,427,461`, `routes/share-links.ts:73,260,316`,
 * `routes/databases.ts:653`).
 *
 * Those call sites project (`.select('workspaceId')`, `.select('workspaceId title')`,
 * `.select('workspaceId parentId title icon')`). The projections are not
 * preserved: they are a transfer-size optimisation on a single-row primary-key
 * lookup of fourteen small columns, not a semantic difference, and one function
 * is fewer things to keep in step than four.
 */
export async function findPageById(db: PgHandle, id: string): Promise<PageRow | undefined> {
  const [row] = await db.select().from(pages).where(eq(pages.id, id)).limit(1);
  return row;
}

export interface FindPagesByIdsFilter {
  /** `routes/comments.ts:177` scopes the lookup to the mentioning workspace. */
  workspaceId?: string;
  /** `lib/databases/rollups.ts:45` reads only live rows. */
  archived?: boolean;
}

/**
 * `routes/comments.ts:177` (verifying mentioned pages belong to the workspace)
 * and `lib/databases/rollups.ts:45` (loading a relation's target rows).
 *
 * The empty-input early return is a saved round trip, not a guard:
 * `inArray(col, [])` renders as the literal `false`, so the query would
 * correctly return nothing anyway.
 */
export async function findPagesByIds(
  db: PgHandle,
  ids: readonly string[],
  filter: FindPagesByIdsFilter = {},
): Promise<PageRow[]> {
  if (ids.length === 0) return [];
  const predicates = [inArray(pages.id, [...ids])];
  if (filter.workspaceId !== undefined) predicates.push(eq(pages.workspaceId, filter.workspaceId));
  if (filter.archived !== undefined) predicates.push(eq(pages.archived, filter.archived));
  return db
    .select()
    .from(pages)
    .where(and(...predicates));
}

/**
 * The order a new sibling takes: `max(order) + 1`, or 0 when there is no
 * sibling — `routes/pages.ts:319-323` and `routes/pages.ts:545-549`, both of
 * which read the highest sibling and add one.
 *
 * `max()` over `double precision` comes back as a JavaScript `number` from
 * postgres.js (measured, not assumed — unlike `count(*)`, which is `bigint` and
 * arrives as a STRING, so every count in this file carries an explicit
 * `::int`). Over an empty set it is NULL, which is the "no sibling" case.
 */
export async function nextSiblingOrder(
  db: PgHandle,
  scope: { workspaceId: string; parentId: string | null },
): Promise<number> {
  const [row] = await db
    .select({ maxOrder: sql<number | null>`max(${pages.order})` })
    .from(pages)
    .where(
      and(
        eq(pages.workspaceId, scope.workspaceId),
        scope.parentId === null ? isNull(pages.parentId) : eq(pages.parentId, scope.parentId),
      ),
    );
  const maxOrder = row?.maxOrder;
  return maxOrder === null || maxOrder === undefined ? 0 : maxOrder + 1;
}

/** `routes/databases.ts:1051` — the same rule, scoped to a database's rows. */
export async function nextDatabaseRowOrder(db: PgHandle, databaseId: string): Promise<number> {
  const [row] = await db
    .select({ maxOrder: sql<number | null>`max(${pages.order})` })
    .from(pages)
    .where(eq(pages.databaseId, databaseId));
  const maxOrder = row?.maxOrder;
  return maxOrder === null || maxOrder === undefined ? 0 : maxOrder + 1;
}

export interface CreatePageInput {
  workspaceId: string;
  parentId?: string | null;
  title?: string;
  icon?: string | null;
  cover?: string | null;
  ownerId: string;
  archived?: boolean;
  order: number;
  /** Set only by `routes/databases.ts:1057`, which creates a database row. */
  databaseId?: string | null;
  /** Set only by `routes/databases.ts:1057`. Every other creator takes the `{}` default. */
  properties?: PageProperties;
}

/**
 * `POST /api/pages` (`routes/pages.ts:325`), `POST /api/pages/:id/duplicate`
 * (`routes/pages.ts:551`) and `POST /api/databases/:id/rows`
 * (`routes/databases.ts:1057`).
 *
 * `coverPosition` and `favorited` are absent from the input on purpose: no
 * creator sets them, including the duplicate route, which does not copy the
 * source page's cover offset. That is the existing behaviour and is preserved
 * rather than quietly fixed here.
 */
export async function createPage(db: PgHandle, input: CreatePageInput): Promise<PageRow> {
  const [row] = await db
    .insert(pages)
    .values({
      workspaceId: input.workspaceId,
      parentId: input.parentId ?? null,
      title: input.title ?? '',
      icon: input.icon ?? null,
      cover: input.cover ?? null,
      ownerId: input.ownerId,
      archived: input.archived ?? false,
      order: input.order,
      databaseId: input.databaseId ?? null,
      properties: input.properties ?? {},
    })
    .returning();
  if (!row) throw new Error('createPage inserted no row');
  return row;
}

export interface UpdatePageInput {
  parentId?: string | null;
  title?: string;
  icon?: string | null;
  cover?: string | null;
  coverPosition?: number;
  order?: number;
  archived?: boolean;
  favorited?: boolean;
  /**
   * Shallow top-level MERGE into the stored object, never a replacement.
   *
   * `PATCH /api/pages/:id` walks the submitted keys and calls `.set()` on the
   * page's existing property Map (`routes/pages.ts:413-424`), so keys it does
   * not mention survive. `properties || $1::jsonb` is that, exactly. Named
   * `mergeProperties` so a caller cannot read it as an assignment.
   */
  mergeProperties?: PageProperties;
}

/**
 * `PATCH /api/pages/:id` — `routes/pages.ts:364-439` — and the soft delete at
 * `routes/pages.ts:485`, which is `{ archived: true }`.
 *
 * The SET clause is built from DEFINED keys only, and the distinction between
 * `undefined` and `null` is the whole point: `icon`, `cover` and `parentId` are
 * nullable and the route accepts an explicit `null` for each, so `undefined`
 * has to mean "leave it alone" while `null` means "write NULL". `$set: { x:
 * undefined }` was a no-op in Mongo and is an erasure in Postgres.
 *
 * Measured, so the comment does not overclaim: drizzle's own `.set()` ALREADY
 * drops `undefined` values, so removing these guards does not reintroduce the
 * erasure — the contract holds either way, and the behavioural assertion in
 * `pages.pgdb.test.ts` cannot tell the two apart. What the guards buy is that
 * the rule is stated in the file that depends on it rather than inherited from
 * a library detail, and that an all-undefined patch reaches the explicit error
 * below instead of drizzle's 'No values to set'. That last difference is the
 * one an assertion can see, and it is the one the suite pins.
 *
 * Returns `undefined` when no row has that id — the route already 404s on the
 * preceding `findById`, so this is the same answer arriving one query earlier.
 */
export async function updatePage(
  db: PgHandle,
  id: string,
  patch: UpdatePageInput,
): Promise<PageRow | undefined> {
  const values: Record<string, unknown> = {};
  if (patch.parentId !== undefined) values.parentId = patch.parentId;
  if (patch.title !== undefined) values.title = patch.title;
  if (patch.icon !== undefined) values.icon = patch.icon;
  if (patch.cover !== undefined) values.cover = patch.cover;
  if (patch.coverPosition !== undefined) values.coverPosition = patch.coverPosition;
  if (patch.order !== undefined) values.order = patch.order;
  if (patch.archived !== undefined) values.archived = patch.archived;
  if (patch.favorited !== undefined) values.favorited = patch.favorited;
  if (patch.mergeProperties !== undefined) {
    values.properties = sql`${pages.properties} || ${JSON.stringify(patch.mergeProperties)}::jsonb`;
  }

  if (Object.keys(values).length === 0) {
    throw new Error('updatePage was given no fields to write');
  }

  const [row] = await db.update(pages).set(values).where(eq(pages.id, id)).returning();
  return row;
}

/**
 * `DELETE /api/databases/:id/properties/:propertyId` — `routes/databases.ts:906`,
 * which drops one property from every row of a database.
 *
 * Returns the number of rows the statement matched. Postgres reports only
 * `rowCount`, which behaves like Mongo's `matchedCount`, not its
 * `modifiedCount`; the route consumes neither, so nothing turns on the
 * difference here.
 */
export async function removePropertyFromDatabaseRows(
  db: PgHandle,
  databaseId: string,
  propertyId: string,
): Promise<number> {
  const updated = await db
    .update(pages)
    .set({ properties: sql`${pages.properties} - ${propertyId}::text` })
    .where(eq(pages.databaseId, databaseId))
    .returning({ id: pages.id });
  return updated.length;
}

export interface ListDatabaseRowsFilter {
  /** `routes/databases.ts:955` reads live rows only; the hard delete at :765 reads all. */
  archived?: boolean;
}

/** `GET /api/databases/:id/rows` — `routes/databases.ts:955`. */
export async function listDatabaseRows(
  db: PgHandle,
  databaseId: string,
  filter: ListDatabaseRowsFilter = {},
): Promise<PageRow[]> {
  const predicates = [eq(pages.databaseId, databaseId)];
  if (filter.archived !== undefined) predicates.push(eq(pages.archived, filter.archived));
  return db
    .select()
    .from(pages)
    .where(and(...predicates));
}

/**
 * `DELETE /api/databases/:id?hard=true` — `routes/databases.ts:765-771`.
 *
 * The route's explicit `Block.deleteMany({ pageId: { $in: rowIds } })` has no
 * counterpart here: `blocks.pageId` cascades. Returns the number of rows
 * deleted, which is what the route counted (it counted ids collected, the same
 * number absent a concurrent write).
 */
export async function deleteDatabaseRows(db: PgHandle, databaseId: string): Promise<number> {
  const deleted = await db
    .delete(pages)
    .where(eq(pages.databaseId, databaseId))
    .returning({ id: pages.id });
  return deleted.length;
}

/**
 * `POST /api/workspaces/:workspaceId/trash/empty` — `routes/workspaces.ts:604-618`.
 *
 * This is the route the `pages.parentId` referential action is chosen for. A
 * live child of an archived page is NOT in the delete set, so under `ON DELETE
 * SET NULL` it survives with `parent_id = NULL` and becomes a root page of the
 * workspace. Under Mongo it survived with a `parentId` pointing at a row that
 * no longer existed. Under CASCADE it would be destroyed — see the schema.
 */
export async function deleteArchivedPages(db: PgHandle, workspaceId: string): Promise<number> {
  const deleted = await db
    .delete(pages)
    .where(and(eq(pages.workspaceId, workspaceId), eq(pages.archived, true)))
    .returning({ id: pages.id });
  return deleted.length;
}

/**
 * `DELETE /api/pages/:id?hard=true` — `routes/pages.ts:476-481`, which BFS-walks
 * `parentId` (`collectDescendantPageIds`, `routes/pages.ts:500-514`), deletes
 * every block of the collected pages, then the pages, and answers with the size
 * of the collected set.
 *
 * One statement, for two reasons beyond speed. The page and its descendants
 * leave together or not at all, which the Mongo version could not promise
 * across two `deleteMany` calls. And because every descendant is inside the
 * same statement, the `ON DELETE SET NULL` action finds no surviving child to
 * detach — the referential action covers only a child that appeared after this
 * statement's snapshot, where it is strictly better than the 23503 a NO ACTION
 * reference would raise. Blocks go by cascade.
 *
 * `CYCLE` is not decoration. `PATCH /api/pages/:id` rejects only a page made
 * its own parent (`routes/pages.ts:368`), so A→B followed by reparenting A
 * under B is reachable and produces a cycle; the breadcrumb route's `seen` set
 * (`routes/pages.ts:613`) is the existing acknowledgement of it. Without the
 * clause the recursion does not terminate.
 */
export async function deletePageTree(db: PgHandle, rootId: string): Promise<number> {
  const rows = await db.execute(sql`
    with recursive tree as (
      select ${pages.id} from ${pages} where ${pages.id} = ${rootId}
      union all
      select child.${sql.identifier(sqlColumnName(pages.id))}
      from ${pages} child
      join tree on child.${sql.identifier(sqlColumnName(pages.parentId))} = tree.${sql.identifier(sqlColumnName(pages.id))}
    ) cycle ${sql.identifier(sqlColumnName(pages.id))} set is_cycle using cycle_path,
    deleted as (
      delete from ${pages}
      where ${pages.id} in (select ${sql.identifier(sqlColumnName(pages.id))} from tree)
      returning ${pages.id}
    )
    select count(*)::int as deleted_count from deleted
  `);
  // Loud rather than 0: `count(*)` without the `::int` decodes as a string, and
  // a silent fallback would report "deleted nothing" for a statement that
  // deleted a subtree.
  const deleted = rows[0]?.deleted_count;
  if (typeof deleted !== 'number') {
    throw new Error(`deletePageTree read a non-numeric count: ${typeof deleted}`);
  }
  return deleted;
}

/**
 * `GET /api/pages/:id/breadcrumb` — `routes/pages.ts:612-630`, which walks
 * `parentId` upward one query per level, `unshift`s each crumb, and stops on a
 * repeat or at depth 32.
 *
 * Returns root-first, page last, matching the `unshift`. Empty when no page has
 * that id — the route 404s before it reaches the walk.
 *
 * The depth predicate is `< BREADCRUMB_MAX_DEPTH - 1` because the recursive arm
 * produces the NEXT crumb: the loop it replaces appends at depths 0..31.
 *
 * `where not is_cycle` is not tidying. Postgres's `CYCLE` clause emits the
 * repeating row ONCE, flagged, before it stops recursing — measured, against a
 * real cycle — so without the predicate a looped ancestry comes back one crumb
 * longer than the route's, with a duplicate at the head. The route's `seen` set
 * breaks BEFORE appending the repeat (`routes/pages.ts:618`); this is that.
 */
export async function findPageAncestry(db: PgHandle, id: string): Promise<PageCrumb[]> {
  const rows = await db.execute(sql`
    with recursive chain as (
      select ${pages.id}, ${pages.parentId}, ${pages.title}, ${pages.icon}, 0 as depth
      from ${pages}
      where ${pages.id} = ${id}
      union all
      select parent.${sql.identifier(sqlColumnName(pages.id))},
             parent.${sql.identifier(sqlColumnName(pages.parentId))},
             parent.${sql.identifier(sqlColumnName(pages.title))},
             parent.${sql.identifier(sqlColumnName(pages.icon))},
             chain.depth + 1
      from ${pages} parent
      join chain on parent.${sql.identifier(sqlColumnName(pages.id))} = chain.${sql.identifier(sqlColumnName(pages.parentId))}
      where chain.depth < ${sql.raw(String(BREADCRUMB_MAX_DEPTH - 1))}
    ) cycle ${sql.identifier(sqlColumnName(pages.id))} set is_cycle using cycle_path
    select ${sql.identifier(sqlColumnName(pages.id))} as id,
           ${sql.identifier(sqlColumnName(pages.title))} as title,
           ${sql.identifier(sqlColumnName(pages.icon))} as icon
    from chain
    where not is_cycle
    order by depth desc
  `);
  return rows.map((row) => ({
    id: String(row.id),
    title: typeof row.title === 'string' ? row.title : '',
    icon: typeof row.icon === 'string' ? row.icon : null,
  }));
}
