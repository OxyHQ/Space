/**
 * API-key usage — the per-request metering table behind credit history, the
 * anomaly detector and the admin usage dashboard.
 *
 * ## Two Mongo-to-Postgres traps live in this file, both silent
 *
 * **1. Integer division.** Mongo's `$divide` is always floating point, so
 * `$ceil: { $divide: ['$tokensUsed', 1000] }` on 1500 tokens is `ceil(1.5)` =
 * 2. Postgres division of two integers is INTEGER division, so the direct
 * transcription `ceil(tokens_used / 1000)` is `ceil(1)` = 1. Every partial
 * thousand of tokens silently stops being billed, the query still returns
 * plausible numbers, and no test that uses round thousands can tell. The cast
 * to `numeric` in {@link CREDITS_SPENT} is the fix and is load-bearing.
 *
 * **2. `sum()` and `count()` return `bigint`/`numeric`, which postgres.js
 * decodes as a STRING** while drizzle types the column `number`. `total + 1`
 * then concatenates and `total > limit` compares lexicographically, both
 * without any error. Every aggregate below is coerced with `Number(...)` at
 * this boundary, and `apiKeyUsage.pgdb.test.ts` proves the coercion by
 * asserting arithmetic rather than equality — a test that reads the value back
 * and compares it to a literal passes either way.
 */

import { and, desc, eq, gte, lt, sql } from 'drizzle-orm';
import type { StationDatabase } from '../db/client.js';
import { apiKeyUsage } from '../db/schema/billing.js';

export type ApiKeyUsageRow = typeof apiKeyUsage.$inferSelect;

/**
 * Credits attributed to one usage row, as `routes/credits.ts:57-65` and
 * `lib/credit-anomaly.ts:63-71` both spell it: the recorded credit charge when
 * there is one, otherwise a token-derived estimate with a floor of 1.
 *
 * `::numeric` is the whole point — see the file header. `greatest` is `$max`
 * over a two-element array, and the floor of 1 means a row with a single token
 * still costs a credit.
 */
const CREDITS_SPENT = sql`case
  when ${apiKeyUsage.creditsUsed} > 0 then ${apiKeyUsage.creditsUsed}
  else greatest(ceil(${apiKeyUsage.tokensUsed}::numeric / 1000), 1)
end`;

/**
 * The day bucket, as `$dateToString: { format: '%Y-%m-%d', date: '$timestamp' }`
 * produced it.
 *
 * `at time zone 'UTC'` is explicit because Mongo's `$dateToString` defaults to
 * UTC while Postgres would render a `timestamptz` in the SESSION's `TimeZone`.
 * Left implicit, the same data would bucket into different days depending on
 * which server ran the query, and the boundary rows would move — a usage chart
 * that disagrees with itself between deployments.
 */
const USAGE_DAY = sql`to_char(${apiKeyUsage.timestamp} at time zone 'UTC', 'YYYY-MM-DD')`;

/** Rows that represent real spend — the `$or` guard both aggregations share. */
const HAS_SPEND = sql`(${apiKeyUsage.creditsUsed} > 0 or ${apiKeyUsage.tokensUsed} > 0)`;

/** `ApiKeyUsage.create(usageRecord)` — `middleware/api-key-rate-limit.ts:260`. */
export async function recordApiKeyUsage(
  db: StationDatabase,
  values: typeof apiKeyUsage.$inferInsert,
): Promise<ApiKeyUsageRow> {
  const rows = await db.insert(apiKeyUsage).values(values).returning();
  if (!rows[0]) throw new Error('api_key_usage insert returned no row');
  return rows[0];
}

/**
 * `routes/credits.ts:41` — daily credit spend for one user over a window.
 *
 * Returns only days that HAVE usage, exactly as the `$group` did; the caller
 * fills the gaps with zeroes (`routes/credits.ts:71-79`), and that is left
 * with the caller so this stays a faithful port of the query rather than
 * quietly absorbing presentation logic.
 */
export async function dailyCreditUsageByUser(
  db: StationDatabase,
  oxyUserId: string,
  since: Date,
): Promise<{ date: string; used: number }[]> {
  const rows = await db
    .select({ date: sql<string>`${USAGE_DAY}`, used: sql<string>`sum(${CREDITS_SPENT})` })
    .from(apiKeyUsage)
    .where(and(eq(apiKeyUsage.oxyUserId, oxyUserId), gte(apiKeyUsage.timestamp, since), HAS_SPEND))
    .groupBy(USAGE_DAY)
    .orderBy(USAGE_DAY);
  return rows.map((r) => ({ date: r.date, used: Number(r.used) }));
}

/**
 * `lib/credit-anomaly.ts:75` — the seven days BEFORE today, per day.
 *
 * The window is half-open (`>= sevenDaysAgo`, `< todayStart`) because the
 * caller averages over exactly seven calendar days; letting today leak in
 * would inflate the baseline it is being compared against and suppress the
 * anomaly this exists to detect.
 */
export async function dailyCreditUsageBetween(
  db: StationDatabase,
  oxyUserId: string,
  since: Date,
  until: Date,
): Promise<{ date: string; used: number }[]> {
  const rows = await db
    .select({ date: sql<string>`${USAGE_DAY}`, used: sql<string>`sum(${CREDITS_SPENT})` })
    .from(apiKeyUsage)
    .where(
      and(
        eq(apiKeyUsage.oxyUserId, oxyUserId),
        gte(apiKeyUsage.timestamp, since),
        lt(apiKeyUsage.timestamp, until),
        HAS_SPEND,
      ),
    )
    .groupBy(USAGE_DAY);
  return rows.map((r) => ({ date: r.date, used: Number(r.used) }));
}

/**
 * `lib/credit-anomaly.ts:91` — today's total spend for one user.
 *
 * Returns 0 for a user with no usage. Mongo's `$group` produced NO DOCUMENT at
 * all in that case and the caller wrote `todayResult[0]?.used || 0`; a
 * Postgres `sum()` over an empty set returns a single row holding NULL, so the
 * zero is produced here instead. Both spellings say "no spend today", which is
 * the value the caller branches on.
 */
export async function creditsSpentSince(
  db: StationDatabase,
  oxyUserId: string,
  since: Date,
): Promise<number> {
  const rows = await db
    .select({ used: sql<string | null>`sum(${CREDITS_SPENT})` })
    .from(apiKeyUsage)
    .where(and(eq(apiKeyUsage.oxyUserId, oxyUserId), gte(apiKeyUsage.timestamp, since), HAS_SPEND));
  return Number(rows[0]?.used ?? 0);
}

/**
 * `middleware/api-key-rate-limit.ts:192` and `:197` —
 * `countDocuments({ oxyUserId, authType, timestamp: { $gte } })`.
 */
export async function countRequestsSince(
  db: StationDatabase,
  oxyUserId: string,
  authType: string,
  since: Date,
): Promise<number> {
  const rows = await db
    .select({ total: sql<string>`count(*)` })
    .from(apiKeyUsage)
    .where(
      and(
        eq(apiKeyUsage.oxyUserId, oxyUserId),
        eq(apiKeyUsage.authType, authType),
        gte(apiKeyUsage.timestamp, since),
      ),
    );
  return Number(rows[0]?.total ?? 0);
}

/**
 * `middleware/api-key-rate-limit.ts:202` and `:206` —
 * `$group: { _id: null, total: { $sum: '$tokensUsed' } }`.
 *
 * `sum()` over an `integer` column is `bigint`, so this is the exact shape the
 * file header warns about: without `Number(...)` the caller's
 * `tokensLastDay > limit` would compare `"9"` against `10` as strings and
 * decide 9 is larger.
 */
export async function sumTokensSince(
  db: StationDatabase,
  oxyUserId: string,
  authType: string,
  since: Date,
): Promise<number> {
  const rows = await db
    .select({ total: sql<string | null>`sum(${apiKeyUsage.tokensUsed})` })
    .from(apiKeyUsage)
    .where(
      and(
        eq(apiKeyUsage.oxyUserId, oxyUserId),
        eq(apiKeyUsage.authType, authType),
        gte(apiKeyUsage.timestamp, since),
      ),
    );
  return Number(rows[0]?.total ?? 0);
}

/**
 * `internal/providers/routes/usage.ts:46` — the admin summary across all users.
 *
 * `avg(response_time)` returns `numeric` (a STRING through the driver) and
 * ignores NULLs, matching Mongo's `$avg`, which skips missing fields rather
 * than treating them as zero. A user with no timed requests yields NULL, which
 * becomes 0 here — the same value the route's own fallback object supplies.
 */
export async function usageSummarySince(
  db: StationDatabase,
  since: Date,
): Promise<{
  totalRequests: number;
  totalTokens: number;
  totalCredits: number;
  avgResponseTime: number;
  successfulRequests: number;
  errorRequests: number;
}> {
  const rows = await db
    .select({
      totalRequests: sql<string>`count(*)`,
      totalTokens: sql<string | null>`sum(${apiKeyUsage.tokensUsed})`,
      totalCredits: sql<string | null>`sum(${apiKeyUsage.creditsUsed})`,
      avgResponseTime: sql<string | null>`avg(${apiKeyUsage.responseTime})`,
      successfulRequests: sql<string>`count(*) filter (where ${apiKeyUsage.statusCode} < 400)`,
      errorRequests: sql<string>`count(*) filter (where ${apiKeyUsage.statusCode} >= 400)`,
    })
    .from(apiKeyUsage)
    .where(gte(apiKeyUsage.timestamp, since));

  const row = rows[0];
  return {
    totalRequests: Number(row?.totalRequests ?? 0),
    totalTokens: Number(row?.totalTokens ?? 0),
    totalCredits: Number(row?.totalCredits ?? 0),
    avgResponseTime: Number(row?.avgResponseTime ?? 0),
    successfulRequests: Number(row?.successfulRequests ?? 0),
    errorRequests: Number(row?.errorRequests ?? 0),
  };
}

/** `internal/providers/routes/usage.ts:65` — admin usage bucketed by day. */
export async function usageByDaySince(
  db: StationDatabase,
  since: Date,
): Promise<{ date: string; requests: number; tokens: number; credits: number }[]> {
  const rows = await db
    .select({
      date: sql<string>`${USAGE_DAY}`,
      requests: sql<string>`count(*)`,
      tokens: sql<string | null>`sum(${apiKeyUsage.tokensUsed})`,
      credits: sql<string | null>`sum(${apiKeyUsage.creditsUsed})`,
    })
    .from(apiKeyUsage)
    .where(gte(apiKeyUsage.timestamp, since))
    .groupBy(USAGE_DAY)
    .orderBy(USAGE_DAY);

  return rows.map((r) => ({
    date: r.date,
    requests: Number(r.requests),
    tokens: Number(r.tokens ?? 0),
    credits: Number(r.credits ?? 0),
  }));
}

/**
 * `internal/providers/routes/usage.ts:78` — the ten busiest endpoints.
 *
 * `endpoint` is added to the ordering after `requests`: the source sorted on
 * request count alone, and ties among a long tail of once-called endpoints
 * would otherwise make the "top 10" a different ten on each call.
 */
export async function usageByEndpointSince(
  db: StationDatabase,
  since: Date,
  limit = 10,
): Promise<{ endpoint: string; requests: number; tokens: number }[]> {
  const rows = await db
    .select({
      endpoint: apiKeyUsage.endpoint,
      requests: sql<string>`count(*)`,
      tokens: sql<string | null>`sum(${apiKeyUsage.tokensUsed})`,
    })
    .from(apiKeyUsage)
    .where(gte(apiKeyUsage.timestamp, since))
    .groupBy(apiKeyUsage.endpoint)
    .orderBy(desc(sql`count(*)`), apiKeyUsage.endpoint)
    .limit(limit);

  return rows.map((r) => ({
    endpoint: r.endpoint,
    requests: Number(r.requests),
    tokens: Number(r.tokens ?? 0),
  }));
}
