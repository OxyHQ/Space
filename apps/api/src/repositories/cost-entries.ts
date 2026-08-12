/**
 * The per-request cost ledger — every query `src/lib/cost-tracker.ts` performs
 * against the `CostEntry` model it declares inline at line 65.
 *
 * ## `actualProvider` and `actualModelId` are internal-only
 *
 * `cost-tracker.ts:303` says so, and it is the whole reason the ledger stores
 * BOTH the Clarity model the caller asked for and the provider model that
 * served it. Nothing here returns the internal pair on a per-user path:
 * {@link listForUser} and {@link listRecentForUser} exist for a user's own
 * dashboard and project the Clarity-facing columns only. {@link listGlobal} is
 * the admin roll-up and returns everything, matching
 * `getGlobalCostStats`'s own split between `costByClarityModel` (safe) and
 * `costByActualProvider` (internal). A user-facing error path that quotes any
 * of it goes through `sanitizeMessage()` from `src/lib/errors/sanitize.ts`.
 */

import { and, asc, desc, eq, gte, lte, sql } from 'drizzle-orm';
import type { PgHandle } from './handle.js';
import { costEntries } from '../db/schema/providers.js';

export type CostEntryRow = typeof costEntries.$inferSelect;
export type NewCostEntry = typeof costEntries.$inferInsert;

/**
 * The columns a per-user read may return. Everything except the provider that
 * actually served the request.
 */
const USER_FACING_COLUMNS = {
  id: costEntries.id,
  userId: costEntries.userId,
  sessionId: costEntries.sessionId,
  clarityModelId: costEntries.clarityModelId,
  inputTokens: costEntries.inputTokens,
  outputTokens: costEntries.outputTokens,
  totalTokens: costEntries.totalTokens,
  costUSD: costEntries.costUSD,
  savedFromCache: costEntries.savedFromCache,
  timestamp: costEntries.timestamp,
} as const;

/** `cost-tracker.ts:125`. */
export async function recordCost(db: PgHandle, values: NewCostEntry): Promise<void> {
  await db.insert(costEntries).values(values);
}

function inWindow(from?: Date, to?: Date) {
  const conditions = [];
  if (from) conditions.push(gte(costEntries.timestamp, from));
  if (to) conditions.push(lte(costEntries.timestamp, to));
  return conditions;
}

/**
 * `cost-tracker.ts:165` — every entry for one user in a window.
 *
 * ## Deliberately rows, not an aggregate
 *
 * `getUserCostSummary` loops these rows and calls `calculateCost(...)` on the
 * cached ones, which reads pricing from an in-code table
 * (`model-capabilities-data.ts`) that the database knows nothing about. Turning
 * the whole summary into SQL would mean re-implementing that pricing table in
 * two places, and a test written against the re-implementation would measure
 * the re-implementation. The pure sums the caller also computes are cheap
 * either way.
 *
 * This is an unbounded scan, exactly as the source is. Making it a keyset page
 * would change what the summary covers, so it stays a scan and the cost is
 * flagged rather than quietly altered.
 */
export async function listForUser(db: PgHandle, userId: string, from?: Date, to?: Date) {
  return db
    .select(USER_FACING_COLUMNS)
    .from(costEntries)
    .where(and(eq(costEntries.userId, userId), ...inWindow(from, to)))
    .orderBy(asc(costEntries.timestamp), asc(costEntries.id));
}

/**
 * `cost-tracker.ts:265` — every entry in a window, for the admin roll-up.
 *
 * Returns `actualProvider` and `actualModelId`: `getGlobalCostStats` groups by
 * them into `costByActualProvider`, which its own comment marks INTERNAL ONLY.
 * This is the only read here that exposes them.
 */
export async function listGlobal(
  db: PgHandle,
  from?: Date,
  to?: Date,
): Promise<CostEntryRow[]> {
  const conditions = inWindow(from, to);
  return db
    .select()
    .from(costEntries)
    .where(conditions.length > 0 ? and(...conditions) : undefined)
    .orderBy(asc(costEntries.timestamp), asc(costEntries.id));
}

/**
 * `cost-tracker.ts:342` — the biggest spenders in a window.
 *
 * The source sorts by `totalSpent` descending and takes `limit`; ties are
 * settled by whatever order the group produced, so two identical calls could
 * return a different last row. `userId` is added as a second sort key.
 *
 * `sum(costUSD)` is over a `double precision` column and decodes as a number,
 * but `sum(totalTokens)` is over a `bigint` and comes back from postgres.js as
 * a STRING while drizzle types it `number` — the caller adds these to other
 * numbers, so both sums and the request count are cast.
 */
export async function topUsersByCost(db: PgHandle, limit = 10, from?: Date, to?: Date) {
  const conditions = inWindow(from, to);
  return db
    .select({
      userId: costEntries.userId,
      totalSpent: sql<number>`coalesce(sum(${costEntries.costUSD}), 0)::double precision`,
      totalTokens: sql<number>`coalesce(sum(${costEntries.totalTokens}), 0)::double precision`,
      totalRequests: sql<number>`count(*)::int`,
    })
    .from(costEntries)
    .where(conditions.length > 0 ? and(...conditions) : undefined)
    .groupBy(costEntries.userId)
    .orderBy(sql`coalesce(sum(${costEntries.costUSD}), 0) desc`, asc(costEntries.userId))
    .limit(limit);
}

/**
 * `cost-tracker.ts:382` — cost per 1k tokens, per Clarity model.
 *
 * The source's `$cond` guard against a zero token total is kept as a
 * `nullif`/`coalesce` pair: a model whose entries all recorded zero tokens
 * reports 0, not a division error and not a null. Ties on the ascending sort
 * are broken by `clarityModelId`.
 *
 * Groups by the Clarity model only. The provider that served each request is
 * not read here at all — this is the figure the admin panel shows next to a
 * user-visible model name.
 */
export async function modelEfficiency(db: PgHandle) {
  return db
    .select({
      clarityModelId: costEntries.clarityModelId,
      totalCost: sql<number>`coalesce(sum(${costEntries.costUSD}), 0)::double precision`,
      totalRequests: sql<number>`count(*)::int`,
      avgCostPer1kTokens: sql<number>`coalesce(
        sum(${costEntries.costUSD}) / nullif(sum(${costEntries.totalTokens}), 0) * 1000,
        0
      )::double precision`,
    })
    .from(costEntries)
    .groupBy(costEntries.clarityModelId)
    .orderBy(
      sql`coalesce(sum(${costEntries.costUSD}) / nullif(sum(${costEntries.totalTokens}), 0) * 1000, 0) asc`,
      asc(costEntries.clarityModelId),
    );
}

/**
 * `cost-tracker.ts:471` — the ten most recent entries for a user's dashboard.
 *
 * `timestamp desc` alone is not a total order — two entries recorded in the
 * same millisecond would swap between calls — so `id` breaks the tie. The
 * uuid v7 primary key is NOT monotonic within a millisecond, so `id` is a
 * tiebreak here and never a proxy for creation order.
 */
export async function listRecentForUser(db: PgHandle, userId: string, limit = 10) {
  return db
    .select(USER_FACING_COLUMNS)
    .from(costEntries)
    .where(eq(costEntries.userId, userId))
    .orderBy(desc(costEntries.timestamp), desc(costEntries.id))
    .limit(limit);
}
