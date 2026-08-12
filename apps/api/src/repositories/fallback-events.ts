/**
 * Fallback events and the analytics `internal/providers/routes/fallback-stats.ts`
 * builds from them.
 *
 * ## Where the Mongo pipelines were arbitrary, this file chose
 *
 * Four of the five reads are `$group`s whose `$sort` does not fully order the
 * result, and one (`mostFailedProviders`) reduces an unordered `$push` with
 * `$arrayElemAt: 0`. Postgres has no equivalent of "whichever document the
 * group ended on", so each is resolved explicitly and the choice is recorded at
 * the query. Every ordering here is total: a `$limit` over a partial order
 * silently changes which rows survive between two identical calls.
 *
 * ## Everything is a CTE, and that is not a style preference
 *
 * Interpolating a drizzle column into a hand-written `sql` template renders it
 * BARE when its table is not in that statement's own `FROM` — so
 * `where ${attempts.eventId} = ${events.id}` inside a correlated subquery emits
 * `where "event_id" = "id"`, both resolve against the SUBQUERY's table, the
 * predicate compares two of its own columns, and the query returns a plausible
 * wrong answer with no error at all. Named CTEs sidestep it entirely: drizzle
 * qualifies a CTE column as `"cte"."column"` on its own.
 */

import { and, asc, count, desc, eq, gte, inArray, sql } from 'drizzle-orm';
import type { PgHandle } from './handle.js';
import { fallbackEventAttempts, fallbackEvents } from '../db/schema/providers.js';

/** One attempt within a fallback event, in the order the engine made them. */
export interface FallbackAttemptInput {
  readonly provider: string;
  readonly model: string;
  readonly error: string;
  readonly reason: string;
  readonly latencyMs: number;
}

export interface FallbackEventInput {
  readonly timestamp?: Date;
  readonly clarityModel: string;
  readonly attempts: readonly FallbackAttemptInput[];
  readonly finalProvider: string | null;
  readonly finalModel: string | null;
  readonly success: boolean;
  readonly totalLatencyMs: number;
}

/**
 * `fallback-engine.ts:373` — record one event and its attempts.
 *
 * The parent and its children are one fact, so they go in one transaction: a
 * Mongo insert of a document with an embedded array is atomic and two
 * statements are not. An event with a truncated attempt list is worse than no
 * event, because the analytics read it as a shorter fallback chain than the one
 * that actually happened.
 */
export async function recordEvent(db: PgHandle, event: FallbackEventInput): Promise<string> {
  return db.transaction(async (tx) => {
    const [row] = await tx
      .insert(fallbackEvents)
      .values({
        timestamp: event.timestamp,
        clarityModel: event.clarityModel,
        finalProvider: event.finalProvider,
        finalModel: event.finalModel,
        success: event.success,
        totalLatencyMs: event.totalLatencyMs,
      })
      .returning({ id: fallbackEvents.id });

    if (event.attempts.length > 0) {
      await tx.insert(fallbackEventAttempts).values(
        event.attempts.map((attempt, position) => ({
          eventId: row.id,
          position,
          provider: attempt.provider,
          model: attempt.model,
          error: attempt.error,
          reason: attempt.reason,
          latencyMs: attempt.latencyMs,
        })),
      );
    }

    return row.id;
  });
}

/**
 * Events in the window with their attempt count.
 *
 * A LEFT JOIN rather than a correlated subquery, and `count(attempt.id)` rather
 * than `count(*)`: an event with no attempts must contribute a 0 to the
 * average, and both an inner join and a `count(*)` over the joined row would
 * turn "half the requests needed no fallback at all" into "the average chain is
 * longer than it is".
 */
function eventsWithAttemptCount(db: PgHandle, since: Date) {
  return db.$with('events_with_attempts').as(
    db
      .select({
        id: fallbackEvents.id,
        clarityModel: fallbackEvents.clarityModel,
        success: fallbackEvents.success,
        totalLatencyMs: fallbackEvents.totalLatencyMs,
        attempts: sql<number>`count(${fallbackEventAttempts.id})::int`.as('attempts'),
      })
      .from(fallbackEvents)
      .leftJoin(fallbackEventAttempts, eq(fallbackEventAttempts.eventId, fallbackEvents.id))
      .where(gte(fallbackEvents.timestamp, since))
      .groupBy(
        fallbackEvents.id,
        fallbackEvents.clarityModel,
        fallbackEvents.success,
        fallbackEvents.totalLatencyMs,
      ),
  );
}

/**
 * `routes/fallback-stats.ts:42` — the summary card.
 *
 * Every aggregate is cast. postgres.js decodes `count()` and any `int8` sum as
 * a STRING while drizzle types them `number`; `totalEvents` and `failureCount`
 * are divided in the caller, so an uncast pair would do string arithmetic and
 * still often produce a believable percentage.
 */
export async function summary(db: PgHandle, since: Date) {
  const scoped = eventsWithAttemptCount(db, since);

  const [row] = await db
    .with(scoped)
    .select({
      totalEvents: sql<number>`count(*)::int`,
      successCount: sql<number>`count(*) filter (where ${scoped.success})::int`,
      failureCount: sql<number>`count(*) filter (where not ${scoped.success})::int`,
      avgTotalLatencyMs: sql<number | null>`avg(${scoped.totalLatencyMs})::double precision`,
      avgAttempts: sql<number | null>`avg(${scoped.attempts})::double precision`,
      maxAttempts: sql<number | null>`max(${scoped.attempts})::int`,
    })
    .from(scoped);

  return row;
}

/**
 * `routes/fallback-stats.ts:58` — the ten most common failure reasons.
 *
 * The source sorts by count descending and takes ten; ties are broken by
 * whatever order the group produced, so two identical calls could return
 * different tenth rows. `reason` is a second sort key to make the cut
 * deterministic.
 */
export async function topFailureReasons(db: PgHandle, since: Date, limit = 10) {
  return db
    .select({
      reason: fallbackEventAttempts.reason,
      count: sql<number>`count(*)::int`,
      avgLatencyMs: sql<number | null>`avg(${fallbackEventAttempts.latencyMs})::double precision`,
    })
    .from(fallbackEventAttempts)
    .innerJoin(fallbackEvents, eq(fallbackEventAttempts.eventId, fallbackEvents.id))
    .where(gte(fallbackEvents.timestamp, since))
    .groupBy(fallbackEventAttempts.reason)
    .orderBy(sql`count(*) desc`, asc(fallbackEventAttempts.reason))
    .limit(limit);
}

/**
 * `routes/fallback-stats.ts:81` — the providers that failed most.
 *
 * ## `topReason` is a chosen semantic, not a ported one
 *
 * The source `$push`es every reason for a provider into an array and reads
 * element 0. A `$group` with no preceding `$sort` has no defined push order, so
 * element 0 is whichever document the scan reached first — a value nobody can
 * rely on and that Postgres cannot reproduce. The field is NAMED `topReason`
 * and the admin panel reads it as one, so this returns the provider's MOST
 * FREQUENT reason, ties broken alphabetically. That is a deliberate change from
 * an arbitrary value to a meaningful one.
 *
 * `provider` is nullable — the Mongo sub-document declares no `required` on any
 * member — so the join between the two aggregations uses `is not distinct
 * from`, which matches NULL to NULL where `=` would drop that group entirely.
 */
export async function mostFailedProviders(db: PgHandle, since: Date, limit = 10) {
  const scoped = db.$with('scoped_attempts').as(
    db
      .select({
        provider: fallbackEventAttempts.provider,
        model: fallbackEventAttempts.model,
        reason: fallbackEventAttempts.reason,
      })
      .from(fallbackEventAttempts)
      .innerJoin(fallbackEvents, eq(fallbackEventAttempts.eventId, fallbackEvents.id))
      .where(gte(fallbackEvents.timestamp, since)),
  );

  const perProvider = db.$with('per_provider').as(
    db
      .select({
        provider: scoped.provider,
        failureCount: sql<number>`count(*)::int`.as('failure_count'),
        modelCount: sql<number>`count(distinct ${scoped.model})::int`.as('model_count'),
      })
      .from(scoped)
      .groupBy(scoped.provider),
  );

  const topReason = db.$with('top_reason').as(
    db
      .selectDistinctOn([scoped.provider], {
        provider: scoped.provider,
        reason: scoped.reason,
      })
      .from(scoped)
      .groupBy(scoped.provider, scoped.reason)
      .orderBy(asc(scoped.provider), sql`count(*) desc`, asc(scoped.reason)),
  );

  return db
    .with(scoped, perProvider, topReason)
    .select({
      provider: perProvider.provider,
      failureCount: perProvider.failureCount,
      modelCount: perProvider.modelCount,
      topReason: topReason.reason,
    })
    .from(perProvider)
    .leftJoin(topReason, sql`${topReason.provider} is not distinct from ${perProvider.provider}`)
    .orderBy(desc(perProvider.failureCount), asc(perProvider.provider))
    .limit(limit);
}

/**
 * `routes/fallback-stats.ts:106` — per-Clarity-model fallback rates.
 *
 * Same tie-break reasoning as {@link topFailureReasons}. The source's
 * `$max: ['$totalEvents', 1]` denominator guard is kept as `greatest(..., 1)`:
 * it is dead — a group always has at least one member — but reproducing it
 * costs nothing, while removing it would need an argument.
 */
export async function failuresByModel(db: PgHandle, since: Date, limit = 20) {
  const scoped = eventsWithAttemptCount(db, since);

  return db
    .with(scoped)
    .select({
      clarityModel: scoped.clarityModel,
      totalEvents: sql<number>`count(*)::int`,
      failures: sql<number>`count(*) filter (where not ${scoped.success})::int`,
      successes: sql<number>`count(*) filter (where ${scoped.success})::int`,
      avgAttempts: sql<number | null>`avg(${scoped.attempts})::double precision`,
      fallbackRate: sql<number>`(
        count(*) filter (where not ${scoped.success})::double precision
        / greatest(count(*), 1)::double precision * 100
      )`,
    })
    .from(scoped)
    .groupBy(scoped.clarityModel)
    .orderBy(sql`count(*) filter (where not ${scoped.success}) desc`, asc(scoped.clarityModel))
    .limit(limit);
}

/**
 * `routes/fallback-stats.ts:143` — the twenty most recent failures, with their
 * attempts.
 *
 * Two queries rather than a join, because the limit counts EVENTS. Applying
 * `limit(20)` to a joined one-to-many returns twenty ATTEMPT rows spread across
 * however many events happen to fit — the standard way a `limit` over a join
 * silently changes what it means.
 *
 * `timestamp desc` alone is not a total order; `id` breaks the ties.
 */
export async function recentFailures(db: PgHandle, since: Date, limit = 20) {
  const events = await db
    .select()
    .from(fallbackEvents)
    .where(and(gte(fallbackEvents.timestamp, since), eq(fallbackEvents.success, false)))
    .orderBy(desc(fallbackEvents.timestamp), desc(fallbackEvents.id))
    .limit(limit);

  // Guarded rather than relying on `inArray`, which renders an empty list as
  // the literal `false`: correct, but it would still cost a round trip.
  if (events.length === 0) return [];

  const attempts = await db
    .select()
    .from(fallbackEventAttempts)
    .where(
      inArray(
        fallbackEventAttempts.eventId,
        events.map((event) => event.id),
      ),
    )
    .orderBy(asc(fallbackEventAttempts.eventId), asc(fallbackEventAttempts.position));

  const byEvent = new Map<string, typeof attempts>();
  for (const attempt of attempts) {
    const bucket = byEvent.get(attempt.eventId);
    if (bucket) bucket.push(attempt);
    else byEvent.set(attempt.eventId, [attempt]);
  }

  return events.map((event) => ({ ...event, attempts: byEvent.get(event.id) ?? [] }));
}

/** Events in a window. A positive control for every aggregate above. */
export async function countSince(db: PgHandle, since: Date): Promise<number> {
  const [row] = await db
    .select({ value: count() })
    .from(fallbackEvents)
    .where(gte(fallbackEvents.timestamp, since));
  return row.value;
}
