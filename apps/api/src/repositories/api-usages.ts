/**
 * Per-request usage rows and the rate-limit window check.
 *
 * Two call sites: `key-manager.ts:308` writes a row per request, and
 * `key-manager.ts:203` reads four rolling windows out of them to decide whether
 * a key has spent its quota.
 */

import { and, eq, gte, sql } from 'drizzle-orm';
import type { StationDatabase } from '../db/client.js';
import { apiUsages } from '../db/schema/providers.js';

/** Request and token totals for one rolling window. */
export interface UsageWindow {
  readonly count: number;
  readonly tokens: number;
}

/** The four windows `isKeyRateLimited` compares against a key's configured limits. */
export interface UsageWindows {
  readonly second: UsageWindow;
  readonly minute: UsageWindow;
  readonly hour: UsageWindow;
  readonly day: UsageWindow;
}

/** `key-manager.ts:308`. */
export async function recordUsage(
  db: StationDatabase,
  values: {
    keyId: string;
    provider: string;
    modelId: string;
    tokens: number;
    timestamp?: Date;
  },
): Promise<void> {
  await db.insert(apiUsages).values(values);
}

/**
 * `key-manager.ts:203` — the `$facet` rate-limit check, as one query.
 *
 * ## Every aggregate is cast, and that is load-bearing
 *
 * postgres.js decodes `bigint`/`int8` as a STRING, including the result of
 * `count()` and of `sum()` over a bigint column, while drizzle types both
 * `number`. Left alone, `second.tokens + tokens > rl.tps` in the caller becomes
 * STRING CONCATENATION — `"0" + 500 > 100` is `"0500" > 100`, which coerces
 * back to a number and happens to give the right answer often enough that a
 * test performing the operation once cannot see it. So the counts are cast to
 * `int` and the token sums to `double precision`, both of which postgres.js
 * hands back as real JavaScript numbers. `apiUsages.tokens` is a `bigint`
 * column, so this is not hypothetical.
 *
 * `int` for the counts rather than `bigint`: an `int8` cast would decode as a
 * string again, and a single key logging more than two billion requests inside
 * one day is not a state this table can reach.
 *
 * ## The source's conditional facets are not reproduced
 *
 * Mongo builds only the facet stages a key's configured limits require. All
 * four are computed here unconditionally: it is the same single index scan, the
 * numbers are identical, and a caller that ignores three of them is cheaper
 * than four code paths that can disagree.
 *
 * The outer window is the day, exactly as in the source — `dayStats` has no
 * `$match` of its own and inherits `timestamp >= oneDayAgo` from the pipeline's
 * `$match` stage.
 */
export async function usageWindowsForKey(
  db: StationDatabase,
  keyId: string,
  now: Date = new Date(),
): Promise<UsageWindows> {
  // ISO strings with an explicit cast, never a bare `Date`. A `Date`
  // interpolated into a drizzle `sql` template has no column to take its
  // encoder from and fails at SERIALISATION in the driver — `gte(column, date)`
  // below is fine for exactly the opposite reason: it has one.
  const oneSecondAgo = sql`${new Date(now.getTime() - 1000).toISOString()}::timestamptz`;
  const oneMinuteAgo = sql`${new Date(now.getTime() - 60_000).toISOString()}::timestamptz`;
  const oneHourAgo = sql`${new Date(now.getTime() - 3_600_000).toISOString()}::timestamptz`;
  const oneDayAgo = new Date(now.getTime() - 86_400_000);

  const [row] = await db
    .select({
      secondCount: sql<number>`count(*) filter (where ${apiUsages.timestamp} >= ${oneSecondAgo})::int`,
      secondTokens: sql<number>`coalesce(sum(${apiUsages.tokens}) filter (where ${apiUsages.timestamp} >= ${oneSecondAgo}), 0)::double precision`,
      minuteCount: sql<number>`count(*) filter (where ${apiUsages.timestamp} >= ${oneMinuteAgo})::int`,
      minuteTokens: sql<number>`coalesce(sum(${apiUsages.tokens}) filter (where ${apiUsages.timestamp} >= ${oneMinuteAgo}), 0)::double precision`,
      hourCount: sql<number>`count(*) filter (where ${apiUsages.timestamp} >= ${oneHourAgo})::int`,
      hourTokens: sql<number>`coalesce(sum(${apiUsages.tokens}) filter (where ${apiUsages.timestamp} >= ${oneHourAgo}), 0)::double precision`,
      dayCount: sql<number>`count(*)::int`,
      dayTokens: sql<number>`coalesce(sum(${apiUsages.tokens}), 0)::double precision`,
    })
    .from(apiUsages)
    .where(and(eq(apiUsages.keyId, keyId), gte(apiUsages.timestamp, oneDayAgo)));

  return {
    second: { count: row.secondCount, tokens: row.secondTokens },
    minute: { count: row.minuteCount, tokens: row.minuteTokens },
    hour: { count: row.hourCount, tokens: row.hourTokens },
    day: { count: row.dayCount, tokens: row.dayTokens },
  };
}
