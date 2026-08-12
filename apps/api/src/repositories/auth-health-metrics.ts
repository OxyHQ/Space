/**
 * Hourly auth success/failure buckets — every query `src/lib/auth-health.ts`
 * performs against the `AuthHealthMetric` model it declares inline at line 56.
 */

import { and, asc, eq, gte, sql } from 'drizzle-orm';
import type { PgHandle } from './handle.js';
import { authHealthMetrics } from '../db/schema/providers.js';

/** `auth-health.ts:101` truncates to this before storing. */
const FAILURE_REASON_MAX = 500;

/** `auth-health.ts:137` — under this many requests a method is healthy by default. */
const MIN_REQUESTS_FOR_HEALTH = 10;

/** `auth-health.ts:137` — at or above the floor, this is the success rate a method must hold. */
const HEALTHY_SUCCESS_RATE = 0.8;

/** One row of `getAuthHealthStats`, before the caller's rounding. */
export interface AuthHealthSummaryRow {
  readonly method: string;
  readonly totalSuccesses: number;
  readonly totalFailures: number;
  readonly successRate: number;
  readonly lastFailure: Date | null;
  readonly lastFailureReason: string | null;
  readonly isHealthy: boolean;
}

/**
 * `auth-health.ts:77` — increment the success counter for a method's current
 * hour, creating the bucket if it is the first request of the hour.
 *
 * `hour` is the bucket instant the caller floored (`getBucketedHour`, in LOCAL
 * time); it stays the caller's decision, because moving the flooring into SQL
 * would change which bucket a row lands in for any deployment whose server
 * timezone is not the one the source assumed.
 */
export async function recordSuccess(
  db: PgHandle,
  method: string,
  hour: Date,
): Promise<void> {
  await db
    .insert(authHealthMetrics)
    .values({ method, hour, successes: 1 })
    .onConflictDoUpdate({
      target: [authHealthMetrics.method, authHealthMetrics.hour],
      set: { successes: sql`${authHealthMetrics.successes} + 1` },
    });
}

/**
 * `auth-health.ts:95` — increment the failure counter and stamp the reason.
 *
 * ## An absent reason must not erase the stored one
 *
 * The source spreads `...(reason ? { lastFailureReason: ... } : {})` into
 * `$set`, so calling this without a reason leaves the previous reason in place.
 * Written naively in Postgres — `set last_failure_reason = $2` with `$2` null —
 * it would ERASE it, and the admin dashboard would show a failure with no
 * cause. `coalesce` keeps the source's behaviour: a new reason replaces, a
 * missing one preserves.
 */
export async function recordFailure(
  db: PgHandle,
  method: string,
  hour: Date,
  reason: string | undefined,
  failedAt: Date = new Date(),
): Promise<void> {
  const truncated = reason ? reason.substring(0, FAILURE_REASON_MAX) : null;

  await db
    .insert(authHealthMetrics)
    .values({
      method,
      hour,
      failures: 1,
      lastFailure: failedAt,
      lastFailureReason: truncated,
    })
    .onConflictDoUpdate({
      target: [authHealthMetrics.method, authHealthMetrics.hour],
      set: {
        failures: sql`${authHealthMetrics.failures} + 1`,
        lastFailure: failedAt,
        lastFailureReason: sql`coalesce(${truncated}, ${authHealthMetrics.lastFailureReason})`,
      },
    });
}

/**
 * `auth-health.ts:119` — per-method health over a window.
 *
 * ## `$last` had no defined meaning, so this picks one
 *
 * The source's `$group` takes `{ $last: '$lastFailureReason' }` with NO
 * preceding `$sort`, so it returns whichever bucket the group happened to end
 * on — a value that can change between two identical calls and that Postgres
 * cannot reproduce. The reason is displayed beside `max(lastFailure)`, so this
 * returns the reason belonging to THAT bucket: the most recent failure's own
 * cause, which is the only reading under which the two fields agree.
 *
 * ## `NULLS LAST` is the load-bearing word in this query
 *
 * `lastFailure` is null for every bucket that only ever saw successes. Under a
 * plain `order by last_failure desc` a NULL sorts FIRST in Postgres, so a
 * method with one failure and fifty clean hours would report its reason as
 * null — the failure would be visible in `totalFailures` and its cause would
 * silently vanish. `nulls last` is what makes the window pick a bucket that
 * actually failed. A test asserts exactly this, because removing the two words
 * breaks nothing else.
 *
 * Both counters are `int8` sums, which postgres.js decodes as STRINGS; they are
 * cast, because the caller divides them.
 */
export async function summaryByMethod(
  db: PgHandle,
  since: Date,
): Promise<AuthHealthSummaryRow[]> {
  const rows = await db
    .select({
      method: authHealthMetrics.method,
      totalSuccesses: sql<number>`coalesce(sum(${authHealthMetrics.successes}), 0)::double precision`,
      totalFailures: sql<number>`coalesce(sum(${authHealthMetrics.failures}), 0)::double precision`,
      /**
       * Epoch MILLISECONDS, not a timestamp, and reassembled into a `Date`
       * below.
       *
       * drizzle's `mode: 'date'` decoding is applied by the RESULT MAPPER from
       * the COLUMN, so it does not reach a value produced by a `sql`
       * expression: `max(last_failure)` comes back as the raw string
       * `2026-08-12 11:47:00.978+00`, typed `Date` by the `sql<Date>`
       * annotation and never checked at runtime. Measured — the first run of
       * this file failed on it. `extract(epoch ...)` returns `numeric`, which
       * postgres.js decodes as a STRING for the same family of reasons, so the
       * cast to `double precision` is the load-bearing half of this expression.
       */
      lastFailureMs: sql<number | null>`(extract(epoch from max(${authHealthMetrics.lastFailure})) * 1000)::double precision`,
      lastFailureReason: sql<string | null>`(
        array_agg(${authHealthMetrics.lastFailureReason} order by ${authHealthMetrics.lastFailure} desc nulls last, ${authHealthMetrics.hour} desc)
      )[1]`,
    })
    .from(authHealthMetrics)
    .where(gte(authHealthMetrics.hour, since))
    .groupBy(authHealthMetrics.method)
    .orderBy(asc(authHealthMetrics.method));

  return rows.map((row) => {
    const total = row.totalSuccesses + row.totalFailures;
    const successRate = total > 0 ? row.totalSuccesses / total : 1;
    return {
      method: row.method,
      totalSuccesses: row.totalSuccesses,
      totalFailures: row.totalFailures,
      successRate,
      lastFailure: row.lastFailureMs === null ? null : new Date(row.lastFailureMs),
      lastFailureReason: row.lastFailureReason,
      isHealthy: total < MIN_REQUESTS_FOR_HEALTH || successRate >= HEALTHY_SUCCESS_RATE,
    };
  });
}

/** One bucket, for a caller that wants to read back what it just wrote. */
export async function findBucket(db: PgHandle, method: string, hour: Date) {
  const [row] = await db
    .select()
    .from(authHealthMetrics)
    .where(and(eq(authHealthMetrics.method, method), eq(authHealthMetrics.hour, hour)));
  return row ?? null;
}
