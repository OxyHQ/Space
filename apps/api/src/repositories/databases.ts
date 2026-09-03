import { and, asc, count, desc, eq, ne } from 'drizzle-orm';
import type { PgUpdateSetSource } from 'drizzle-orm/pg-core';
import type { StationDatabase } from '../db/client.js';
import {
  databases,
  databaseViews,
  type DatabaseSchema,
  type DatabaseViewType,
  type FilterGroup,
  type ViewConfig,
  type ViewGroupBy,
  type ViewSort,
} from '../db/schema/databases.js';

/**
 * Every query `src/routes/databases.ts` performs against the `databases` and
 * `database_views` tables, as typed functions.
 *
 * ## What is deliberately NOT here
 *
 * A database ROW is a page (`pages.databaseId`), so five of the queries in
 * `routes/databases.ts` are page/block queries and belong to the pages
 * repository, not this one:
 *
 *   - `:955`      `Page.find({ databaseId, archived: false })`
 *   - `:1051`     `Page.findOne({ databaseId }).sort({ order: -1 })`
 *   - `:1057`     `Page.create({ …, databaseId, properties })`
 *   - `:906-909`  `Page.updateMany({ databaseId }, { $unset: { ['properties.' + id]: '' } })`
 *   - `:765-771`  `Page.find({ databaseId }).select('_id')` → `Block.deleteMany`
 *                 → `Page.deleteMany`
 *
 * The hard-delete path (`:760-776`) is a genuine cross-domain coupling: pages,
 * blocks, database_views and databases are removed together, so at cutover
 * those four deletes must share ONE transaction and the two halves of the port
 * must switch together. Every function here takes a {@link StationHandle}
 * precisely so the caller can pass that transaction in.
 *
 * ## Filtering and sorting of rows stays in JS
 *
 * `routes/databases.ts:955-983` loads every row of a database and then applies
 * `evaluateFilter` and `compareBySorts` in memory. That is unchanged by this
 * port: `src/lib/databases/*` are pure functions over already-parsed values.
 * Pushing the filter engine into SQL is a different change with a different
 * risk profile, and preserving today's behaviour is the goal here.
 */

/**
 * A pool handle or a transaction handle — anything a repository function can
 * run on.
 *
 * Derived from `StationDatabase['transaction']` rather than spelled as
 * `PgTransaction<…>`, so it cannot drift from whatever `createDatabase()`
 * actually hands back.
 */
export type StationTransaction = Parameters<
  Parameters<StationDatabase['transaction']>[0]
>[0];
export type StationHandle = StationDatabase | StationTransaction;

/** The `databases` row as the rest of the application sees it. */
export interface DatabaseRecord {
  id: string;
  workspaceId: string;
  name: string;
  icon: string | null;
  cover: string | null;
  ownerId: string;
  propertiesSchema: DatabaseSchema;
  isInline: boolean;
  parentPageId: string | null;
  archived: boolean;
  createdAt: Date;
  updatedAt: Date;
}

export interface DatabaseViewRecord {
  id: string;
  databaseId: string;
  name: string;
  type: DatabaseViewType;
  isDefault: boolean;
  filters: FilterGroup;
  sorts: ViewSort[];
  groupBy: ViewGroupBy | null;
  hiddenProperties: string[];
  frozenProperties: string[];
  pageSize: number;
  config: ViewConfig;
  order: number;
  createdAt: Date;
  updatedAt: Date;
}

type DatabaseRow = typeof databases.$inferSelect;
type DatabaseViewRow = typeof databaseViews.$inferSelect;

function toDatabaseRecord(row: DatabaseRow): DatabaseRecord {
  return {
    id: row.id,
    workspaceId: row.workspaceId,
    name: row.name,
    icon: row.icon,
    cover: row.cover,
    ownerId: row.ownerId,
    propertiesSchema: row.propertiesSchema,
    isInline: row.isInline,
    parentPageId: row.parentPageId,
    archived: row.archived,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

function toViewRecord(row: DatabaseViewRow): DatabaseViewRecord {
  return {
    id: row.id,
    databaseId: row.databaseId,
    name: row.name,
    type: row.type,
    isDefault: row.isDefault,
    filters: row.filters,
    sorts: row.sorts,
    groupBy: row.groupBy,
    hiddenProperties: row.hiddenProperties,
    frozenProperties: row.frozenProperties,
    pageSize: row.pageSize,
    config: row.config,
    order: row.order,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

// ---------------------------------------------------------------------------
// Databases
// ---------------------------------------------------------------------------

/**
 * `GET /databases?workspaceId=` — `routes/databases.ts:575-582`.
 *
 * `id` is a third sort key that Mongo's `sort({ updatedAt: -1 })` did not
 * have. Two databases touched in the same millisecond came back in an
 * arbitrary order there; porting that arbitrariness is not an option, so the
 * order is made total. It is stable rather than meaningful — a uuid v7 is not
 * monotonic within a millisecond.
 */
export async function listDatabasesByWorkspace(
  handle: StationHandle,
  input: { workspaceId: string; includeArchived: boolean },
): Promise<DatabaseRecord[]> {
  const where = input.includeArchived
    ? eq(databases.workspaceId, input.workspaceId)
    : and(eq(databases.workspaceId, input.workspaceId), eq(databases.archived, false));

  const rows = await handle
    .select()
    .from(databases)
    .where(where)
    .orderBy(desc(databases.updatedAt), asc(databases.id));

  return rows.map(toDatabaseRecord);
}

/** `Database.findById(id)` — `routes/databases.ts:599, 720, 752, 798, 840, 887, 929, 1024`. */
export async function findDatabaseById(
  handle: StationHandle,
  id: string,
): Promise<DatabaseRecord | null> {
  const [row] = await handle.select().from(databases).where(eq(databases.id, id)).limit(1);
  return row ? toDatabaseRecord(row) : null;
}

/**
 * `Database.findById(id).select('workspaceId')` — `routes/databases.ts:1102,
 * 1126, 1186, 1252`. The four view routes need nothing but the workspace id to
 * run the membership check.
 */
export async function findDatabaseWorkspaceId(
  handle: StationHandle,
  id: string,
): Promise<{ id: string; workspaceId: string } | null> {
  const [row] = await handle
    .select({ id: databases.id, workspaceId: databases.workspaceId })
    .from(databases)
    .where(eq(databases.id, id))
    .limit(1);
  return row ?? null;
}

export interface InsertDatabaseInput {
  workspaceId: string;
  name: string;
  icon: string | null;
  cover: string | null;
  ownerId: string;
  propertiesSchema: DatabaseSchema;
  isInline: boolean;
  parentPageId: string | null;
  archived: boolean;
}

/** `Database.create({...})` — `routes/databases.ts:679-691`. */
export async function insertDatabase(
  handle: StationHandle,
  input: InsertDatabaseInput,
): Promise<DatabaseRecord> {
  const [row] = await handle
    .insert(databases)
    .values({
      workspaceId: input.workspaceId,
      name: input.name,
      icon: input.icon,
      cover: input.cover,
      ownerId: input.ownerId,
      propertiesSchema: input.propertiesSchema,
      isInline: input.isInline,
      parentPageId: input.parentPageId,
      archived: input.archived,
    })
    .returning();
  return toDatabaseRecord(row);
}

export interface UpdateDatabaseInput {
  name?: string;
  icon?: string | null;
  cover?: string | null;
  archived?: boolean;
}

/**
 * `PATCH /databases/:id` — `routes/databases.ts:728-732`.
 *
 * The SET clause is built from DEFINED keys only. `icon` and `cover` are
 * explicitly nullable in the request schema, so `null` must be written and
 * `undefined` must not: in Mongo `$set: { icon: undefined }` is a no-op, while
 * the same statement in Postgres writes NULL and erases the value.
 *
 * A patch that sets nothing reads the row back rather than issuing an empty
 * UPDATE — which matches Mongoose, where `save()` with no modified path writes
 * nothing at all.
 *
 * Note that `updatedAt` moves on any UPDATE that reaches the database,
 * including one writing a field its current value — Mongoose's `save()`
 * skipped the write entirely in that case. That difference is general to this
 * port rather than particular to any one field.
 */
export async function updateDatabase(
  handle: StationHandle,
  id: string,
  patch: UpdateDatabaseInput,
): Promise<DatabaseRecord | null> {
  const values: PgUpdateSetSource<typeof databases> = {};
  if (patch.name !== undefined) values.name = patch.name;
  if (patch.icon !== undefined) values.icon = patch.icon;
  if (patch.cover !== undefined) values.cover = patch.cover;
  if (patch.archived !== undefined) values.archived = patch.archived;

  if (Object.keys(values).length === 0) return findDatabaseById(handle, id);

  const [row] = await handle
    .update(databases)
    .set(values)
    .where(eq(databases.id, id))
    .returning();
  return row ? toDatabaseRecord(row) : null;
}

/**
 * The one write behind all three property routes — add
 * (`routes/databases.ts:818-821`), update (`:865-868`) and delete
 * (`:899-903`). Each mutates `propertiesSchema` in memory, calls
 * `markModified('propertiesSchema')` and saves the whole sub-document, so a
 * whole-value write is the faithful port rather than a simplification.
 */
export async function writeDatabaseSchema(
  handle: StationHandle,
  id: string,
  propertiesSchema: DatabaseSchema,
): Promise<DatabaseRecord | null> {
  const [row] = await handle
    .update(databases)
    .set({ propertiesSchema })
    .where(eq(databases.id, id))
    .returning();
  return row ? toDatabaseRecord(row) : null;
}

/**
 * `Database.deleteOne({ _id })` — `routes/databases.ts:774`.
 *
 * Returns whether a row was removed, read off the driver's row count. Mongo
 * reported `deletedCount`; the caller consumes neither, but "did this exist"
 * is the only useful answer a delete can give.
 *
 * `database_views` rows go with it through `ON DELETE CASCADE`. The route also
 * deletes them explicitly first, which stays correct.
 */
export async function deleteDatabase(handle: StationHandle, id: string): Promise<boolean> {
  const deleted = await handle.delete(databases).where(eq(databases.id, id)).returning({
    id: databases.id,
  });
  return deleted.length > 0;
}

// ---------------------------------------------------------------------------
// Views
// ---------------------------------------------------------------------------

/**
 * The view ordering used everywhere views are listed —
 * `routes/databases.ts:607-609, 695-697, 1110-1112` and the fallback promotion
 * at `:1276-1277`.
 *
 * `id` is a tiebreaker Mongo's `sort({ order: 1, createdAt: 1 })` did not
 * have. It matters more here than for databases: `created_at` defaults to
 * `date_trunc('milliseconds', now())`, so the two views a request creates back
 * to back routinely share a timestamp, and a uuid v7 is not monotonic within a
 * millisecond. Stable, not meaningful — but a list that reshuffles between two
 * identical requests is worse.
 */
const VIEW_ORDER = [asc(databaseViews.order), asc(databaseViews.createdAt), asc(databaseViews.id)];

/** `DatabaseView.find({ databaseId }).sort({ order: 1, createdAt: 1 })`. */
export async function listViewsByDatabase(
  handle: StationHandle,
  databaseId: string,
): Promise<DatabaseViewRecord[]> {
  const rows = await handle
    .select()
    .from(databaseViews)
    .where(eq(databaseViews.databaseId, databaseId))
    .orderBy(...VIEW_ORDER);
  return rows.map(toViewRecord);
}

/**
 * `DatabaseView.findById(viewId)` — `routes/databases.ts:940, 1194, 1260`.
 *
 * Every caller immediately checks the view belongs to the database it was
 * reached through, so `databaseId` is a parameter rather than a follow-up
 * comparison: a mismatch returns null instead of a row the caller must
 * remember to reject.
 */
export async function findViewById(
  handle: StationHandle,
  viewId: string,
  databaseId: string,
): Promise<DatabaseViewRecord | null> {
  const [row] = await handle
    .select()
    .from(databaseViews)
    .where(and(eq(databaseViews.id, viewId), eq(databaseViews.databaseId, databaseId)))
    .limit(1);
  return row ? toViewRecord(row) : null;
}

/**
 * `DatabaseView.findOne({ databaseId, isDefault: true })` —
 * `routes/databases.ts:946-949`.
 *
 * Mongo returned an arbitrary one of several defaults, and several ARE
 * reachable today: `POST /:id/views` (`:1149-1167`) honours `isDefault: true`
 * without demoting the existing default, unlike the PATCH route (`:1206-1213`).
 * Rather than port the arbitrariness this returns the first in the view
 * ordering, so the same database always resolves to the same default.
 */
export async function findDefaultView(
  handle: StationHandle,
  databaseId: string,
): Promise<DatabaseViewRecord | null> {
  const [row] = await handle
    .select()
    .from(databaseViews)
    .where(and(eq(databaseViews.databaseId, databaseId), eq(databaseViews.isDefault, true)))
    .orderBy(...VIEW_ORDER)
    .limit(1);
  return row ? toViewRecord(row) : null;
}

/**
 * `DatabaseView.findOne({ databaseId }).sort({ order: 1, createdAt: 1 })` —
 * `routes/databases.ts:1276-1277`, the view promoted to default after the
 * current default is deleted.
 */
export async function findFirstViewByOrder(
  handle: StationHandle,
  databaseId: string,
): Promise<DatabaseViewRecord | null> {
  const [row] = await handle
    .select()
    .from(databaseViews)
    .where(eq(databaseViews.databaseId, databaseId))
    .orderBy(...VIEW_ORDER)
    .limit(1);
  return row ? toViewRecord(row) : null;
}

/**
 * `DatabaseView.findOne({ databaseId }).sort({ order: -1 }).select('order')`
 * then `last ? last.order + 1 : 0` — `routes/databases.ts:1134-1139`.
 *
 * `order` is `double precision` for this arithmetic: postgres.js decodes
 * `bigint`/`int8` as a STRING while drizzle types it `number`, so on an `int8`
 * column `last.order + 1` would be string concatenation.
 */
export async function nextViewOrder(
  handle: StationHandle,
  databaseId: string,
): Promise<number> {
  const [row] = await handle
    .select({ order: databaseViews.order })
    .from(databaseViews)
    .where(eq(databaseViews.databaseId, databaseId))
    .orderBy(desc(databaseViews.order))
    .limit(1);
  return row ? row.order + 1 : 0;
}

export interface InsertDatabaseViewInput {
  databaseId: string;
  name: string;
  type: DatabaseViewType;
  isDefault: boolean;
  filters: FilterGroup;
  sorts: ViewSort[];
  groupBy: ViewGroupBy | null;
  hiddenProperties: string[];
  frozenProperties: string[];
  pageSize: number;
  config: ViewConfig;
  order: number;
}

/**
 * `DatabaseView.create({...})` — `routes/databases.ts:1149-1167`, and the
 * default view every new database gets at `:520-533`.
 */
export async function insertDatabaseView(
  handle: StationHandle,
  input: InsertDatabaseViewInput,
): Promise<DatabaseViewRecord> {
  const [row] = await handle.insert(databaseViews).values(input).returning();
  return toViewRecord(row);
}

export interface UpdateDatabaseViewInput {
  name?: string;
  type?: DatabaseViewType;
  isDefault?: boolean;
  filters?: FilterGroup;
  sorts?: ViewSort[];
  groupBy?: ViewGroupBy | null;
  hiddenProperties?: string[];
  frozenProperties?: string[];
  pageSize?: number;
  config?: ViewConfig;
  order?: number;
}

/**
 * `PATCH /databases/:id/views/:viewId` — `routes/databases.ts:1200-1234`.
 *
 * Same defined-keys-only rule as {@link updateDatabase}, and it bites harder
 * here: `groupBy` is legitimately `null`, so `undefined` and `null` cannot be
 * collapsed.
 */
export async function updateDatabaseView(
  handle: StationHandle,
  viewId: string,
  patch: UpdateDatabaseViewInput,
): Promise<DatabaseViewRecord | null> {
  const values: PgUpdateSetSource<typeof databaseViews> = {};
  if (patch.name !== undefined) values.name = patch.name;
  if (patch.type !== undefined) values.type = patch.type;
  if (patch.isDefault !== undefined) values.isDefault = patch.isDefault;
  if (patch.filters !== undefined) values.filters = patch.filters;
  if (patch.sorts !== undefined) values.sorts = patch.sorts;
  if (patch.groupBy !== undefined) values.groupBy = patch.groupBy;
  if (patch.hiddenProperties !== undefined) values.hiddenProperties = patch.hiddenProperties;
  if (patch.frozenProperties !== undefined) values.frozenProperties = patch.frozenProperties;
  if (patch.pageSize !== undefined) values.pageSize = patch.pageSize;
  if (patch.config !== undefined) values.config = patch.config;
  if (patch.order !== undefined) values.order = patch.order;

  if (Object.keys(values).length === 0) {
    const [row] = await handle
      .select()
      .from(databaseViews)
      .where(eq(databaseViews.id, viewId))
      .limit(1);
    return row ? toViewRecord(row) : null;
  }

  const [row] = await handle
    .update(databaseViews)
    .set(values)
    .where(eq(databaseViews.id, viewId))
    .returning();
  return row ? toViewRecord(row) : null;
}

/**
 * `DatabaseView.updateMany({ databaseId, _id: { $ne }, isDefault: true },
 * { $set: { isDefault: false } })` — `routes/databases.ts:1206-1213`.
 *
 * Returns the number of views demoted. Mongo reported both `matchedCount` and
 * `modifiedCount` and the route consumed neither; the two agree here anyway,
 * because `isDefault: true` is in the predicate, so every matched row is
 * changed.
 */
export async function demoteOtherDefaultViews(
  handle: StationHandle,
  databaseId: string,
  keepViewId: string,
): Promise<number> {
  const demoted = await handle
    .update(databaseViews)
    .set({ isDefault: false })
    .where(
      and(
        eq(databaseViews.databaseId, databaseId),
        ne(databaseViews.id, keepViewId),
        eq(databaseViews.isDefault, true),
      ),
    )
    .returning({ id: databaseViews.id });
  return demoted.length;
}

/**
 * `DatabaseView.countDocuments({ databaseId })` — `routes/databases.ts:1268`,
 * which refuses to delete the last view.
 *
 * `count()` is drizzle's helper rather than a hand-written `count(*)`: the
 * latter comes back from postgres.js as a STRING, because `count(*)` is
 * `bigint`, while the column would still be typed `number`.
 */
export async function countViews(handle: StationHandle, databaseId: string): Promise<number> {
  const [row] = await handle
    .select({ total: count() })
    .from(databaseViews)
    .where(eq(databaseViews.databaseId, databaseId));
  return row.total;
}

/** `DatabaseView.deleteOne({ _id })` — `routes/databases.ts:1274`. */
export async function deleteDatabaseView(
  handle: StationHandle,
  viewId: string,
): Promise<boolean> {
  const deleted = await handle
    .delete(databaseViews)
    .where(eq(databaseViews.id, viewId))
    .returning({ id: databaseViews.id });
  return deleted.length > 0;
}

/**
 * `DatabaseView.deleteMany({ databaseId })` — `routes/databases.ts:773`, part
 * of the hard-delete cascade. Returns how many were removed.
 */
export async function deleteViewsByDatabase(
  handle: StationHandle,
  databaseId: string,
): Promise<number> {
  const deleted = await handle
    .delete(databaseViews)
    .where(eq(databaseViews.databaseId, databaseId))
    .returning({ id: databaseViews.id });
  return deleted.length;
}
