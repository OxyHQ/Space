/**
 * Circuit-breaker state per provider/model — every query
 * `internal/providers/lib/provider-health.ts` performs, plus the two sites that
 * reach the model by BARE NAME STRING (`routes/providers.ts:342` and
 * `lib/seed-model-configs.ts:244`).
 *
 * ## Read-modify-write becomes one statement
 *
 * The source reads the document, mutates it in JavaScript and calls `save()`,
 * for both the success and the failure path. Two concurrent requests against
 * the same provider/model therefore lose one another's counters today, and a
 * crash between the read and the save loses the whole update. Each is one
 * `INSERT ... ON CONFLICT DO UPDATE` here, which also collapses the source's
 * explicit "does the row exist yet" branch — the two branches wrote the same
 * facts and differed only in whether they were expressed as increments.
 *
 * That is an existing invariant made structural (these are accumulating
 * counters and a state machine over them), not a new one.
 */

import { and, desc, eq, inArray, isNotNull, lte, sql } from 'drizzle-orm';
import type { StationDatabase } from '../db/client.js';
import { providerHealths } from '../db/schema/providers.js';

/**
 * `provider-health.ts:31`. Re-declared rather than imported: `CIRCUIT_CONFIG` is
 * module-private there, and the write logic these numbers govern now lives
 * here. The values must stay in step until the rewiring commit deletes the
 * original.
 */
const CIRCUIT = {
  failureThreshold: 5,
  successThreshold: 2,
  openDurationMs: 60_000,
  minRequestsForMetrics: 10,
  unhealthySuccessRateThreshold: 50,
} as const;

/** Latency samples retained per provider/model — `provider-health.ts:204`. */
const LATENCY_SAMPLE_LIMIT = 100;

/** The reset state shared by the three "clear the circuit breakers" paths. */
const RESET_VALUES = {
  successCount: 0,
  failureCount: 0,
  totalRequests: 0,
  successRate: 100,
  consecutiveFailures: 0,
  consecutiveSuccesses: 0,
  circuitState: 'closed',
  circuitOpenedAt: null,
  halfOpenAttempts: 0,
  isHealthy: true,
} as const;

export type ProviderHealthRow = typeof providerHealths.$inferSelect;

/** `provider-health.ts:119`. */
export async function findByProviderModel(
  db: StationDatabase,
  provider: string,
  modelId: string,
): Promise<ProviderHealthRow | null> {
  const [row] = await db
    .select()
    .from(providerHealths)
    .where(and(eq(providerHealths.provider, provider), eq(providerHealths.modelId, modelId)));
  return row ?? null;
}

/**
 * `provider-health.ts:123` — initialise a health row on first read.
 *
 * `onConflictDoNothing` on the unique, then read back: two requests racing to
 * initialise the same provider/model must not turn into a 23505 the caller sees
 * as a failure. `DO NOTHING RETURNING` yields no row when the conflict fires,
 * which is why the read-back is unconditional rather than a fallback.
 */
export async function ensureExists(
  db: StationDatabase,
  provider: string,
  modelId: string,
): Promise<ProviderHealthRow> {
  await db
    .insert(providerHealths)
    .values({ provider, modelId })
    .onConflictDoNothing({ target: [providerHealths.provider, providerHealths.modelId] });

  const row = await findByProviderModel(db, provider, modelId);
  if (!row) {
    throw new Error(`provider health row for ${provider}/${modelId} vanished after upsert`);
  }
  return row;
}

/**
 * `provider-health.ts:167` — record a successful request.
 *
 * ## The latency ring buffer
 *
 * `array_append` then slice from `cardinality - 98`: the appended array has one
 * more element than the stored one, so starting at `old - 98` keeps exactly the
 * last 100. `greatest(1, ...)` covers every shorter array, including the empty
 * one — `cardinality` of `'{}'` is 0, not NULL, so no coalesce is needed.
 * `averageLatencyMs` is the mean of that same trimmed array rather than an
 * incremental average, which is what the source computes and what makes the two
 * columns impossible to disagree.
 *
 * ## The circuit branch reproduces the source's ORDER, which matters
 *
 * `provider-health.ts` closes a half-open circuit (setting `isHealthy = true`)
 * and only THEN overwrites `isHealthy` from the success rate once the request
 * count clears the metrics floor. Evaluating those two in the other order gives
 * a different answer for a provider that just recovered but is still below 50%
 * lifetime, so the `case` here is nested in the same order.
 */
export async function recordSuccess(
  db: StationDatabase,
  provider: string,
  modelId: string,
  latencyMs: number,
  now: Date = new Date(),
): Promise<void> {
  const samples = sql`(array_append(${providerHealths.latencySamples}, ${latencyMs}::double precision))[greatest(1, cardinality(${providerHealths.latencySamples}) - ${sql.raw(String(LATENCY_SAMPLE_LIMIT - 2))}):]`;
  const newTotal = sql`(${providerHealths.totalRequests} + 1)`;
  const newSuccesses = sql`(${providerHealths.successCount} + 1)`;
  const newRate = sql`(${newSuccesses}::double precision / ${newTotal}::double precision * 100)`;
  const closing = sql`(${providerHealths.circuitState} = 'half-open' and ${providerHealths.consecutiveSuccesses} + 1 >= ${sql.raw(String(CIRCUIT.successThreshold))})`;
  const healthyAfterCircuit = sql`case when ${closing} then true else ${providerHealths.isHealthy} end`;

  await db
    .insert(providerHealths)
    .values({
      provider,
      modelId,
      successCount: 1,
      failureCount: 0,
      totalRequests: 1,
      successRate: 100,
      averageLatencyMs: latencyMs,
      latencySamples: [latencyMs],
      lastSuccess: now,
      consecutiveFailures: 0,
      consecutiveSuccesses: 1,
      circuitState: 'closed',
      isHealthy: true,
      lastHealthCheck: now,
    })
    .onConflictDoUpdate({
      target: [providerHealths.provider, providerHealths.modelId],
      set: {
        successCount: newSuccesses,
        totalRequests: newTotal,
        lastSuccess: now,
        consecutiveFailures: 0,
        consecutiveSuccesses: sql`${providerHealths.consecutiveSuccesses} + 1`,
        latencySamples: samples,
        averageLatencyMs: sql`(select avg(sample) from unnest(${samples}) as sample)::double precision`,
        successRate: newRate,
        circuitState: sql`case when ${closing} then 'closed' else ${providerHealths.circuitState} end`,
        circuitOpenedAt: sql`case when ${closing} then null else ${providerHealths.circuitOpenedAt} end`,
        halfOpenAttempts: sql`case
          when ${closing} then 0
          when ${providerHealths.circuitState} = 'half-open' then ${providerHealths.halfOpenAttempts} + 1
          else ${providerHealths.halfOpenAttempts}
        end`,
        isHealthy: sql`case
          when ${newTotal} >= ${sql.raw(String(CIRCUIT.minRequestsForMetrics))}
            then ${newRate} >= ${sql.raw(String(CIRCUIT.unhealthySuccessRateThreshold))}
          else ${healthyAfterCircuit}
        end`,
        lastHealthCheck: now,
      },
    });
}

/**
 * `provider-health.ts:243` — record a failed request.
 *
 * A rate-limit error code is transient: the provider works, the quota does not.
 * It counts toward `failureCount` and `totalRequests` but NOT toward
 * `consecutiveFailures`, so it can never open the circuit — which is the whole
 * reason the caller passes the code through instead of a boolean. The
 * classification is done in JavaScript from the source's own regex.
 *
 * `consecutiveSuccesses` is reset only for a real failure, matching
 * `provider-health.ts:277-281`: a rate-limited request must not undo progress
 * toward closing a half-open circuit.
 */
export async function recordFailure(
  db: StationDatabase,
  provider: string,
  modelId: string,
  errorCode: string | undefined,
  now: Date = new Date(),
): Promise<void> {
  const isRateLimit =
    errorCode != null && /rate.?limit|429|RESOURCE_EXHAUSTED|quota/i.test(errorCode);
  const increment = sql.raw(isRateLimit ? '0' : '1');

  const newTotal = sql`(${providerHealths.totalRequests} + 1)`;
  const newRate = sql`(${providerHealths.successCount}::double precision / ${newTotal}::double precision * 100)`;
  const newConsecutive = sql`(${providerHealths.consecutiveFailures} + ${increment})`;
  const opening = sql`(
    ${providerHealths.circuitState} = 'half-open'
    or (${providerHealths.circuitState} = 'closed' and ${newConsecutive} >= ${sql.raw(String(CIRCUIT.failureThreshold))})
  )`;

  await db
    .insert(providerHealths)
    .values({
      provider,
      modelId,
      successCount: 0,
      failureCount: 1,
      totalRequests: 1,
      successRate: 0,
      lastFailure: now,
      consecutiveFailures: isRateLimit ? 0 : 1,
      consecutiveSuccesses: 0,
      circuitState: 'closed',
      // A single failure never opens the circuit — `provider-health.ts:269`.
      isHealthy: true,
      lastHealthCheck: now,
    })
    .onConflictDoUpdate({
      target: [providerHealths.provider, providerHealths.modelId],
      set: {
        failureCount: sql`${providerHealths.failureCount} + 1`,
        totalRequests: newTotal,
        lastFailure: now,
        consecutiveFailures: newConsecutive,
        consecutiveSuccesses: sql`case when ${increment} = 1 then 0 else ${providerHealths.consecutiveSuccesses} end`,
        successRate: newRate,
        circuitState: sql`case when ${opening} then 'open' else ${providerHealths.circuitState} end`,
        circuitOpenedAt: sql`case when ${opening} then ${now.toISOString()}::timestamptz else ${providerHealths.circuitOpenedAt} end`,
        halfOpenAttempts: sql`case when ${providerHealths.circuitState} = 'half-open' then 0 else ${providerHealths.halfOpenAttempts} end`,
        isHealthy: sql`case
          when ${newTotal} >= ${sql.raw(String(CIRCUIT.minRequestsForMetrics))}
            then ${newRate} >= ${sql.raw(String(CIRCUIT.unhealthySuccessRateThreshold))}
          when ${opening} then false
          else ${providerHealths.isHealthy}
        end`,
        lastHealthCheck: now,
      },
    });
}

/**
 * `provider-health.ts:336` — let an open circuit try again.
 *
 * The source reads the row, decides the cooldown has elapsed, and writes
 * unconditionally. The elapsed check moves into the predicate so the decision
 * and the write are one statement: between the two round trips another request
 * can already have re-opened the circuit, and the source would then re-admit
 * traffic to a provider that just failed again.
 *
 * @returns `true` when this call performed the transition.
 */
export async function transitionToHalfOpen(
  db: StationDatabase,
  provider: string,
  modelId: string,
  now: Date = new Date(),
): Promise<boolean> {
  const openedBefore = new Date(now.getTime() - CIRCUIT.openDurationMs);
  const result = await db
    .update(providerHealths)
    .set({ circuitState: 'half-open', halfOpenAttempts: 0, consecutiveSuccesses: 0 })
    .where(
      and(
        eq(providerHealths.provider, provider),
        eq(providerHealths.modelId, modelId),
        eq(providerHealths.circuitState, 'open'),
        isNotNull(providerHealths.lastFailure),
        lte(providerHealths.lastFailure, openedBefore),
      ),
    );
  return result.count > 0;
}

/** `provider-health.ts:369` — the monitoring dashboard listing. */
export async function listAll(db: StationDatabase): Promise<ProviderHealthRow[]> {
  return db
    .select()
    .from(providerHealths)
    .orderBy(desc(providerHealths.updatedAt), desc(providerHealths.id));
}

/**
 * `provider-health.ts:383` — reset one provider/model, creating it if absent.
 *
 * The source is `findOneAndUpdate(..., { upsert: true })`, which is an upsert
 * whose insert branch takes the filter plus the update — reproduced here as an
 * insert of the reset values on conflict with the same reset values.
 */
export async function resetOne(
  db: StationDatabase,
  provider: string,
  modelId: string,
  now: Date = new Date(),
): Promise<void> {
  await db
    .insert(providerHealths)
    .values({ provider, modelId, ...RESET_VALUES, lastHealthCheck: now })
    .onConflictDoUpdate({
      target: [providerHealths.provider, providerHealths.modelId],
      set: { ...RESET_VALUES, lastHealthCheck: now },
    });
}

/**
 * `routes/providers.ts:351` — reset every health record.
 *
 * ## `modifiedCount` and `rowCount` agree, and the reason is subtle
 *
 * Mongo reports documents actually CHANGED; Postgres reports rows MATCHED. They
 * would differ here — a row already in the reset state is matched but not
 * modified — except that the update also stamps `lastHealthCheck` with a fresh
 * `new Date()`, which differs from the stored value on every row. So every
 * matched document is a modified document and the two counts are equal. The
 * route reports this number to an operator as "records reset", so an inflated
 * count would have been invisible and wrong.
 *
 * This route also guards on `mongoose.models.ProviderHealth` being registered
 * and 500s when it is not — a guard with no meaning against a table. The
 * rewiring must drop it rather than translate it: "the model was not loaded"
 * and "there was nothing to reset" are the same silent outcome today.
 */
export async function resetAll(db: StationDatabase, now: Date = new Date()): Promise<number> {
  const result = await db.update(providerHealths).set({ ...RESET_VALUES, lastHealthCheck: now });
  return result.count;
}

/** `seed-model-configs.ts:250` — reset only the circuits that are not closed. */
export async function resetOpenCircuits(
  db: StationDatabase,
  now: Date = new Date(),
): Promise<number> {
  const result = await db
    .update(providerHealths)
    .set({
      circuitState: 'closed',
      circuitOpenedAt: null,
      halfOpenAttempts: 0,
      consecutiveFailures: 0,
      consecutiveSuccesses: 0,
      isHealthy: true,
      lastHealthCheck: now,
    })
    .where(inArray(providerHealths.circuitState, ['open', 'half-open']));
  return result.count;
}

/**
 * `provider-health.ts:434` — the five-minute background sweep.
 *
 * The source fetches every open and half-open circuit and saves each one whose
 * cooldown has elapsed. The whole loop is one statement: the fetch existed only
 * to evaluate a predicate the database can evaluate, and iterating it row by
 * row meant a circuit could be re-opened by a concurrent failure between the
 * read and its own save.
 *
 * @returns The number of circuits moved to half-open.
 */
export async function sweepOpenCircuits(
  db: StationDatabase,
  now: Date = new Date(),
): Promise<number> {
  const openedBefore = new Date(now.getTime() - CIRCUIT.openDurationMs);
  const result = await db
    .update(providerHealths)
    .set({ circuitState: 'half-open', halfOpenAttempts: 0 })
    .where(
      and(
        eq(providerHealths.circuitState, 'open'),
        isNotNull(providerHealths.circuitOpenedAt),
        lte(providerHealths.circuitOpenedAt, openedBefore),
      ),
    );
  return result.count;
}

/** Circuits currently not closed. A positive control for the sweeps above. */
export async function listNonClosed(db: StationDatabase): Promise<ProviderHealthRow[]> {
  return db
    .select()
    .from(providerHealths)
    .where(inArray(providerHealths.circuitState, ['open', 'half-open']));
}
