/**
 * Reads and writes for `chat_analytics`.
 *
 * Every aggregate here casts its result explicitly. postgres.js decodes
 * `sum()` and `avg()` as STRINGS — `sum(integer)` is `bigint` and `avg()` is
 * `numeric` — while drizzle types them `number`, so `total + 1` would be
 * string concatenation and an average would arrive as `"12.5000000000000000"`.
 * The casts are not tidiness; without them the numbers reach the client
 * looking almost right.
 */

import { and, desc, eq, gte, sql } from 'drizzle-orm';
import { executeRows } from '@oxyhq/db';
import { chatAnalytics, type NewChatAnalytics } from '../db/schema/analytics.js';
import type { PgHandle } from '../db/client.js';

/** One row per completed chat. Written by the `analytics` afterChat hook. */
export async function recordChatAnalytics(
  db: PgHandle,
  values: NewChatAnalytics,
): Promise<void> {
  await db.insert(chatAnalytics).values(values);
}

export type UsageByDayRow = {
  day: string;
  conversations: number;
  totalTokens: number;
  avgLatency: number;
};

/**
 * `GET /analytics/usage` — one bucket per calendar day.
 *
 * `to_char(created_at, 'YYYY-MM-DD')` replaces Mongo's `$dateToString` with the
 * same format. Both bucket by the SERVER's notion of the day; that was true
 * before the port and is left alone deliberately, because changing it to the
 * caller's timezone would silently move rows between buckets.
 */
export async function usageByDay(
  db: PgHandle,
  oxyUserId: string,
  since: Date,
): Promise<UsageByDayRow[]> {
  return executeRows<UsageByDayRow>(
    db,
    sql`
      select
        to_char(${chatAnalytics.createdAt}, 'YYYY-MM-DD') as day,
        count(*)::int as conversations,
        coalesce(sum(${chatAnalytics.totalTokens}), 0)::int as "totalTokens",
        coalesce(avg(${chatAnalytics.latencyMs}), 0)::float8 as "avgLatency"
      from ${chatAnalytics}
      where ${chatAnalytics.oxyUserId} = ${oxyUserId}
        and ${chatAnalytics.createdAt} >= ${since.toISOString()}::timestamptz
      group by 1
      order by 1 asc
    `,
  );
}

export type ModelBreakdownRow = {
  modelId: string;
  count: number;
  totalTokens: number;
  avgLatency: number;
};

/**
 * `GET /analytics/models` — usage per model, busiest first.
 *
 * `coalesce(clarity_model_id, model)` is Mongo's `$ifNull` on the same two
 * fields: rows written before a request carried a Clarity id fall back to the
 * concrete provider model, which is what the route then resolves for a display
 * name.
 */
export async function modelBreakdown(
  db: PgHandle,
  oxyUserId: string,
  since: Date,
): Promise<ModelBreakdownRow[]> {
  return executeRows<ModelBreakdownRow>(
    db,
    sql`
      select
        coalesce(${chatAnalytics.clarityModelId}, ${chatAnalytics.model}) as "modelId",
        count(*)::int as count,
        coalesce(sum(${chatAnalytics.totalTokens}), 0)::int as "totalTokens",
        coalesce(avg(${chatAnalytics.latencyMs}), 0)::float8 as "avgLatency"
      from ${chatAnalytics}
      where ${chatAnalytics.oxyUserId} = ${oxyUserId}
        and ${chatAnalytics.createdAt} >= ${since.toISOString()}::timestamptz
      group by 1
      order by count desc, 1 asc
    `,
  );
}

export type CreditsByDayRow = {
  day: string;
  totalTokens: number;
  conversations: number;
};

/** `GET /analytics/credits` — token consumption per calendar day. */
export async function creditsByDay(
  db: PgHandle,
  oxyUserId: string,
  since: Date,
): Promise<CreditsByDayRow[]> {
  return executeRows<CreditsByDayRow>(
    db,
    sql`
      select
        to_char(${chatAnalytics.createdAt}, 'YYYY-MM-DD') as day,
        coalesce(sum(${chatAnalytics.totalTokens}), 0)::int as "totalTokens",
        count(*)::int as conversations
      from ${chatAnalytics}
      where ${chatAnalytics.oxyUserId} = ${oxyUserId}
        and ${chatAnalytics.createdAt} >= ${since.toISOString()}::timestamptz
      group by 1
      order by 1 asc
    `,
  );
}

/** The most recent rows for one user. Used by the realdb suite's fixtures. */
export async function listForUser(
  db: PgHandle,
  oxyUserId: string,
  limit = 50,
): Promise<(typeof chatAnalytics.$inferSelect)[]> {
  return db
    .select()
    .from(chatAnalytics)
    .where(eq(chatAnalytics.oxyUserId, oxyUserId))
    .orderBy(desc(chatAnalytics.createdAt))
    .limit(limit);
}

/** Rows for one user inside a window — the shape every aggregate above filters on. */
export async function countInWindow(
  db: PgHandle,
  oxyUserId: string,
  since: Date,
): Promise<number> {
  const [row] = await db
    .select({ total: sql<number>`count(*)::int` })
    .from(chatAnalytics)
    .where(
      and(eq(chatAnalytics.oxyUserId, oxyUserId), gte(chatAnalytics.createdAt, since)),
    );
  return row?.total ?? 0;
}
