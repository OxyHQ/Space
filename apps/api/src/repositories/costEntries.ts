/**
 * Cost entries — the internal per-request record of what a completion cost
 * Oxy, as opposed to what it charged the user.
 *
 * The source model is declared INLINE inside `lib/cost-tracker.ts:65`
 * (`mongoose.model('CostEntry', CostEntrySchema)`), exported nowhere, and
 * reached only through that file's own functions — so the port needs no call
 * site edited anywhere. Of those functions, exactly one has a caller today:
 * `getGlobalCostStats`, from `internal/providers/routes/usage.ts:125`.
 * `recordCost` has none, which means this table currently has no writer at all.
 *
 * ## Why two of these return ROWS instead of an aggregate
 *
 * `getUserCostSummary` and `getGlobalCostStats` do not aggregate in Mongo —
 * they `find()` the whole matching set and loop in JavaScript, and the loop
 * calls `calculateCost()` and `estimateFreeTierSavings()`, which read a
 * hardcoded pricing table that does not exist in the database. Those totals
 * are therefore not expressible in SQL without moving the pricing table into
 * Postgres, which is a different change with different consequences.
 *
 * So {@link listCostEntries} hands back the same rows the source loaded and
 * the arithmetic stays where it is. The two aggregations that ARE pure
 * (`getTopUsersByCost`, `getModelEfficiency`) were already `$group` pipelines
 * and become `GROUP BY`.
 */

import { and, desc, eq, gte, lte, sql, type SQL } from 'drizzle-orm';
import type { StationDatabase } from '../db/client.js';
import { costEntries } from '../db/schema/billing.js';

export type CostEntryRow = typeof costEntries.$inferSelect;

/** `CostEntryModel.create({...})` — `lib/cost-tracker.ts:125`. */
export async function recordCostEntry(
  db: StationDatabase,
  values: typeof costEntries.$inferInsert,
): Promise<CostEntryRow> {
  const rows = await db.insert(costEntries).values(values).returning();
  if (!rows[0]) throw new Error('cost_entries insert returned no row');
  return rows[0];
}

/**
 * `CostEntryModel.find(query)` — `lib/cost-tracker.ts:165` (per user) and
 * `:265` (global).
 *
 * The date bounds are half-open at neither end: the source builds
 * `{ $gte: startDate, $lte: endDate }`, so `lte` is correct and `lt` would
 * silently drop a row landing exactly on the boundary.
 */
export async function listCostEntries(
  db: StationDatabase,
  filter: { userId?: string; startDate?: Date; endDate?: Date },
): Promise<CostEntryRow[]> {
  return db.select().from(costEntries).where(costEntryFilter(filter));
}

/**
 * `lib/cost-tracker.ts:471` — the ten most recent entries for a user.
 *
 * `id` breaks same-millisecond ties; the primary key is a uuid v7 and is not
 * monotonic within a millisecond, so `timestamp` alone leaves the order to
 * Postgres.
 */
export async function listRecentCostEntriesByUser(
  db: StationDatabase,
  userId: string,
  limit = 10,
): Promise<CostEntryRow[]> {
  return db
    .select()
    .from(costEntries)
    .where(eq(costEntries.userId, userId))
    .orderBy(desc(costEntries.timestamp), desc(costEntries.id))
    .limit(limit);
}

/**
 * `getTopUsersByCost` — `lib/cost-tracker.ts:342`.
 *
 * `sum(cost_usd)` is `double precision`, which postgres.js decodes as a
 * number; `sum(total_tokens)` over an `integer` column is `bigint` and
 * `count(*)` is too, and both of those arrive as STRINGS. Coerced here, which
 * is why the two are treated differently below rather than uniformly.
 *
 * `userId` joins the ordering because a tie on `totalSpent` — two users who
 * have each spent exactly zero, the common case on a quiet day — would
 * otherwise return a different "top N" on each call.
 */
export async function topUsersByCost(
  db: StationDatabase,
  options: { limit?: number; startDate?: Date; endDate?: Date } = {},
): Promise<{ userId: string; totalSpent: number; totalTokens: number; totalRequests: number }[]> {
  const rows = await db
    .select({
      userId: costEntries.userId,
      totalSpent: sql<number>`sum(${costEntries.costUsd})`,
      totalTokens: sql<string>`sum(${costEntries.totalTokens})`,
      totalRequests: sql<string>`count(*)`,
    })
    .from(costEntries)
    .where(costEntryFilter({ startDate: options.startDate, endDate: options.endDate }))
    .groupBy(costEntries.userId)
    .orderBy(desc(sql`sum(${costEntries.costUsd})`), costEntries.userId)
    .limit(options.limit ?? 10);

  return rows.map((r) => ({
    userId: r.userId,
    totalSpent: Number(r.totalSpent),
    totalTokens: Number(r.totalTokens),
    totalRequests: Number(r.totalRequests),
  }));
}

/**
 * `getModelEfficiency` — `lib/cost-tracker.ts:382`.
 *
 * The `case when ... > 0` reproduces the source's `$cond` guard, and it is not
 * optional: Mongo's `$divide` by zero raises, and Postgres's raises too
 * (`22012`), so removing the guard turns an empty-token model into a failed
 * request rather than the zero the source returns.
 */
export async function modelEfficiency(
  db: StationDatabase,
): Promise<
  { clarityModelId: string; avgCostPer1kTokens: number; totalRequests: number; totalCost: number }[]
> {
  const efficiency = sql<number>`case
    when sum(${costEntries.totalTokens}) > 0
      then (sum(${costEntries.costUsd}) / sum(${costEntries.totalTokens})) * 1000
    else 0
  end`;

  const rows = await db
    .select({
      clarityModelId: costEntries.clarityModelId,
      avgCostPer1kTokens: efficiency,
      totalRequests: sql<string>`count(*)`,
      totalCost: sql<number>`sum(${costEntries.costUsd})`,
    })
    .from(costEntries)
    .groupBy(costEntries.clarityModelId)
    .orderBy(efficiency, costEntries.clarityModelId);

  return rows.map((r) => ({
    clarityModelId: r.clarityModelId,
    avgCostPer1kTokens: Number(r.avgCostPer1kTokens),
    totalRequests: Number(r.totalRequests),
    totalCost: Number(r.totalCost),
  }));
}

/** See the note on `transactionFilter` — an absent key drops its clause entirely. */
function costEntryFilter(filter: {
  userId?: string;
  startDate?: Date;
  endDate?: Date;
}): SQL | undefined {
  const clauses: SQL[] = [];
  if (filter.userId !== undefined) clauses.push(eq(costEntries.userId, filter.userId));
  if (filter.startDate !== undefined) clauses.push(gte(costEntries.timestamp, filter.startDate));
  if (filter.endDate !== undefined) clauses.push(lte(costEntries.timestamp, filter.endDate));
  return clauses.length > 0 ? and(...clauses) : undefined;
}
