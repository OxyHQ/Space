/**
 * `provider_healths` — the circuit breaker — against a real PostgreSQL 17.
 *
 * Every row is keyed by a `modelId` this file mints, so nothing here reads a
 * sibling file's rows. Two functions are unavoidably global (`resetAll`,
 * `resetOpenCircuits`, `sweepOpenCircuits`); this is the only file in the suite
 * that writes this table, and each of those is asserted on rows it owns plus a
 * delta, never on an absolute count.
 */

import { randomBytes } from 'node:crypto';
import { and, eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { closeTestDb, getTestDb, type TestDatabase } from '../../db/__tests__/testDatabase.js';
import { providerHealths } from '../../db/schema/providers.js';
import * as health from '../provider-healths.js';

const PROVIDER = 'ph-test-provider';
let db: TestDatabase;

/** A model id no other test and no previous run can produce. */
function ownModel(label: string): string {
  return `ph-${label}-${randomBytes(6).toString('hex')}`;
}

async function read(modelId: string) {
  const row = await health.findByProviderModel(db, PROVIDER, modelId);
  if (!row) throw new Error(`no health row for ${modelId}`);
  return row;
}

beforeAll(async () => {
  db = await getTestDb();
});

afterAll(closeTestDb);

describe('recording outcomes', () => {
  /**
   * The source branches on "does the row exist yet" and writes the same facts
   * either way. One upsert covers both, so the first call has to produce
   * exactly what the source's create branch produced.
   */
  it('creates the row on the first success', async () => {
    const modelId = ownModel('first-success');
    await health.recordSuccess(db, PROVIDER, modelId, 120);

    const row = await read(modelId);
    expect(row.successCount).toBe(1);
    expect(row.totalRequests).toBe(1);
    expect(row.successRate).toBe(100);
    expect(row.averageLatencyMs).toBe(120);
    expect(row.latencySamples).toEqual([120]);
    expect(row.consecutiveSuccesses).toBe(1);
    expect(row.circuitState).toBe('closed');
    expect(row.isHealthy).toBe(true);
    expect(row.lastSuccess).toBeInstanceOf(Date);
  });

  it('creates the row on the first failure, still healthy', async () => {
    const modelId = ownModel('first-failure');
    await health.recordFailure(db, PROVIDER, modelId, 'ECONNRESET');

    const row = await read(modelId);
    expect(row.failureCount).toBe(1);
    expect(row.totalRequests).toBe(1);
    expect(row.successRate).toBe(0);
    expect(row.consecutiveFailures).toBe(1);
    // A single failure never opens the circuit — `provider-health.ts:269`.
    expect(row.circuitState).toBe('closed');
    expect(row.isHealthy).toBe(true);
  });

  /**
   * Counters accumulate as NUMBERS. They are `bigint` columns, and postgres.js
   * decodes `int8` as a string — a success rate computed from two strings is
   * `NaN`, and `isHealthy` would then be false for every provider.
   */
  it('accumulates counters and recomputes the success rate', async () => {
    const modelId = ownModel('accumulate');
    await health.recordSuccess(db, PROVIDER, modelId, 100);
    await health.recordSuccess(db, PROVIDER, modelId, 200);
    await health.recordFailure(db, PROVIDER, modelId, 'ECONNRESET');

    const row = await read(modelId);
    expect(typeof row.totalRequests).toBe('number');
    expect(row.totalRequests).toBe(3);
    expect(row.successCount).toBe(2);
    expect(row.failureCount).toBe(1);
    expect(row.successRate).toBeCloseTo(66.6667, 3);
    expect(Number.isNaN(row.successRate)).toBe(false);
  });

  /**
   * The latency ring buffer. `array_append` then slice from `cardinality - 98`
   * keeps the LAST 100, and `averageLatencyMs` is the mean of that same trimmed
   * array — so the two can never disagree.
   */
  it('keeps the last 100 latency samples and averages exactly those', async () => {
    const modelId = ownModel('ring');
    for (let sample = 1; sample <= 105; sample += 1) {
      await health.recordSuccess(db, PROVIDER, modelId, sample);
    }

    const row = await read(modelId);
    expect(row.latencySamples).toHaveLength(100);
    expect(row.latencySamples[0]).toBe(6);
    expect(row.latencySamples[99]).toBe(105);

    const expected = row.latencySamples.reduce((sum, n) => sum + n, 0) / 100;
    expect(row.averageLatencyMs).toBeCloseTo(expected, 10);
    // The control that the trim really happened: the mean of 1..105 is 53.
    expect(row.averageLatencyMs).not.toBeCloseTo(53, 1);
  });

  it('holds exactly 100 at the boundary', async () => {
    const modelId = ownModel('ring-edge');
    for (let sample = 1; sample <= 100; sample += 1) {
      await health.recordSuccess(db, PROVIDER, modelId, sample);
    }

    const row = await read(modelId);
    expect(row.latencySamples).toHaveLength(100);
    expect(row.latencySamples[0]).toBe(1);
  });
});

describe('the circuit breaker', () => {
  it('opens after five consecutive real failures, and not before', async () => {
    const modelId = ownModel('open');

    for (let attempt = 0; attempt < 4; attempt += 1) {
      await health.recordFailure(db, PROVIDER, modelId, 'ECONNRESET');
    }
    expect((await read(modelId)).circuitState).toBe('closed');

    await health.recordFailure(db, PROVIDER, modelId, 'ECONNRESET');

    const row = await read(modelId);
    expect(row.circuitState).toBe('open');
    expect(row.circuitOpenedAt).toBeInstanceOf(Date);
    expect(row.isHealthy).toBe(false);
  });

  /**
   * The whole reason `recordFailure` takes an error CODE rather than a boolean:
   * a quota error means the provider works. Fifty of them must never open the
   * circuit, or a busy provider is taken out of rotation for being busy.
   */
  it('never opens the circuit on rate-limit failures, however many', async () => {
    const modelId = ownModel('rate-limited');

    for (let attempt = 0; attempt < 8; attempt += 1) {
      await health.recordFailure(db, PROVIDER, modelId, 'RESOURCE_EXHAUSTED');
    }

    const row = await read(modelId);
    expect(row.failureCount).toBe(8);
    expect(row.totalRequests).toBe(8);
    expect(row.consecutiveFailures).toBe(0);
    expect(row.circuitState).toBe('closed');
  });

  /**
   * The mixed case, which is where a boolean flag would have gone wrong: rate
   * limits interleaved with real failures must not reset the real streak, and
   * must not contribute to it either.
   */
  it('rate limits neither advance nor reset the real-failure streak', async () => {
    const modelId = ownModel('mixed');

    await health.recordFailure(db, PROVIDER, modelId, 'ECONNRESET');
    await health.recordFailure(db, PROVIDER, modelId, '429');
    await health.recordFailure(db, PROVIDER, modelId, 'ECONNRESET');

    const row = await read(modelId);
    expect(row.consecutiveFailures).toBe(2);
    expect(row.failureCount).toBe(3);
    expect(row.circuitState).toBe('closed');
  });

  it('closes a half-open circuit after two successes, and not after one', async () => {
    const modelId = ownModel('half-open');
    await db
      .insert(providerHealths)
      .values({
        provider: PROVIDER,
        modelId,
        circuitState: 'half-open',
        consecutiveSuccesses: 0,
        totalRequests: 0,
        successCount: 0,
        isHealthy: false,
        circuitOpenedAt: new Date(),
      });

    await health.recordSuccess(db, PROVIDER, modelId, 50);
    let row = await read(modelId);
    expect(row.circuitState).toBe('half-open');
    expect(row.halfOpenAttempts).toBe(1);

    await health.recordSuccess(db, PROVIDER, modelId, 50);
    row = await read(modelId);
    expect(row.circuitState).toBe('closed');
    expect(row.circuitOpenedAt).toBeNull();
    expect(row.halfOpenAttempts).toBe(0);
    expect(row.isHealthy).toBe(true);
  });

  it('re-opens a half-open circuit on a single real failure', async () => {
    const modelId = ownModel('reopen');
    await db.insert(providerHealths).values({
      provider: PROVIDER,
      modelId,
      circuitState: 'half-open',
      halfOpenAttempts: 2,
    });

    await health.recordFailure(db, PROVIDER, modelId, 'timeout');

    const row = await read(modelId);
    expect(row.circuitState).toBe('open');
    expect(row.halfOpenAttempts).toBe(0);
    expect(row.isHealthy).toBe(false);
  });

  /**
   * Above the metrics floor the success rate decides health, overriding the
   * circuit branch. Reproducing the source's ORDER matters: evaluating the two
   * the other way round gives a different answer for a provider that just
   * recovered but is still below 50% lifetime.
   */
  it('lets the success rate override health once the request floor is cleared', async () => {
    const modelId = ownModel('floor');
    for (let attempt = 0; attempt < 9; attempt += 1) {
      await health.recordFailure(db, PROVIDER, modelId, 'ECONNRESET');
    }
    // Nine failures: the circuit is open and health is already false.
    expect((await read(modelId)).isHealthy).toBe(false);

    await health.recordSuccess(db, PROVIDER, modelId, 10);

    // Ten requests, one success — 10%, still unhealthy, decided by the rate.
    const row = await read(modelId);
    expect(row.totalRequests).toBe(10);
    expect(row.successRate).toBeCloseTo(10, 6);
    expect(row.isHealthy).toBe(false);
  });
});

describe('transitions and resets', () => {
  /**
   * The elapsed check is in the PREDICATE, not in the caller. Between a read
   * and a write another request can re-open the circuit, and the source would
   * then re-admit traffic to a provider that had just failed again.
   */
  it('moves an open circuit to half-open only once the cooldown has elapsed', async () => {
    const modelId = ownModel('transition');
    await db.insert(providerHealths).values({
      provider: PROVIDER,
      modelId,
      circuitState: 'open',
      lastFailure: new Date(Date.now() - 30_000),
    });

    expect(await health.transitionToHalfOpen(db, PROVIDER, modelId)).toBe(false);
    expect((await read(modelId)).circuitState).toBe('open');

    await db
      .update(providerHealths)
      .set({ lastFailure: new Date(Date.now() - 120_000) })
      .where(and(eq(providerHealths.provider, PROVIDER), eq(providerHealths.modelId, modelId)));

    expect(await health.transitionToHalfOpen(db, PROVIDER, modelId)).toBe(true);
    const row = await read(modelId);
    expect(row.circuitState).toBe('half-open');
    expect(row.consecutiveSuccesses).toBe(0);
  });

  /**
   * The background monitor keys on `circuitOpenedAt` while
   * `transitionToHalfOpen` keys on `lastFailure` — an inconsistency in the
   * SOURCE (`provider-health.ts:331` against `:442`), reproduced rather than
   * quietly reconciled. A row with an old `circuitOpenedAt` and a recent
   * `lastFailure` is the case that tells them apart, and it is the reason this
   * assertion exists.
   */
  it('the sweep keys on circuitOpenedAt, not on lastFailure', async () => {
    const modelId = ownModel('sweep');
    await db.insert(providerHealths).values({
      provider: PROVIDER,
      modelId,
      circuitState: 'open',
      circuitOpenedAt: new Date(Date.now() - 120_000),
      lastFailure: new Date(),
    });

    expect(await health.transitionToHalfOpen(db, PROVIDER, modelId)).toBe(false);

    const swept = await health.sweepOpenCircuits(db);
    expect(swept).toBeGreaterThanOrEqual(1);
    expect((await read(modelId)).circuitState).toBe('half-open');
  });

  it('the sweep leaves a circuit inside its cooldown alone', async () => {
    const modelId = ownModel('sweep-fresh');
    await db.insert(providerHealths).values({
      provider: PROVIDER,
      modelId,
      circuitState: 'open',
      circuitOpenedAt: new Date(Date.now() - 5_000),
    });

    await health.sweepOpenCircuits(db);
    expect((await read(modelId)).circuitState).toBe('open');
  });

  it('resets one provider/model, creating it when absent', async () => {
    const modelId = ownModel('reset-one');

    await health.resetOne(db, PROVIDER, modelId);
    expect((await read(modelId)).circuitState).toBe('closed');

    await health.recordFailure(db, PROVIDER, modelId, 'boom');
    await health.resetOne(db, PROVIDER, modelId);

    const row = await read(modelId);
    expect(row.failureCount).toBe(0);
    expect(row.totalRequests).toBe(0);
    expect(row.successRate).toBe(100);
    expect(row.isHealthy).toBe(true);
  });

  /**
   * `resetOpenCircuits` must touch only circuits that are not closed —
   * `seed-model-configs.ts:250` reports the number to an operator as "reset open
   * circuit breakers", so sweeping closed ones would inflate it.
   */
  it('resets only circuits that are open or half-open', async () => {
    const open = ownModel('reset-open');
    const closed = ownModel('reset-closed');
    await db.insert(providerHealths).values([
      { provider: PROVIDER, modelId: open, circuitState: 'open', consecutiveFailures: 6 },
      { provider: PROVIDER, modelId: closed, circuitState: 'closed', consecutiveFailures: 2 },
    ]);

    const nonClosedBefore = (await health.listNonClosed(db)).length;
    const resetCount = await health.resetOpenCircuits(db);

    expect(resetCount).toBe(nonClosedBefore);
    expect((await read(open)).consecutiveFailures).toBe(0);
    // Untouched: it was already closed, so it keeps its counter.
    expect((await read(closed)).consecutiveFailures).toBe(2);
    expect(await health.listNonClosed(db)).toHaveLength(0);
  });

  /**
   * `routes/providers.ts:351` reports Mongo's `modifiedCount`. Postgres reports
   * matched rows, and the two agree here only because the update also stamps a
   * fresh `lastHealthCheck`, which differs on every row — so every matched row
   * is a modified row. Asserted as an equality against a count this file
   * measures, not against an absolute number.
   */
  it('resets every row and reports the number it touched', async () => {
    await health.resetOne(db, PROVIDER, ownModel('reset-all-a'));
    await health.resetOne(db, PROVIDER, ownModel('reset-all-b'));

    const total = (await health.listAll(db)).length;
    expect(total).toBeGreaterThanOrEqual(2);

    expect(await health.resetAll(db)).toBe(total);
  });

  it('initialises a row idempotently under a repeated first read', async () => {
    const modelId = ownModel('ensure');
    const first = await health.ensureExists(db, PROVIDER, modelId);
    const second = await health.ensureExists(db, PROVIDER, modelId);

    expect(second.id).toBe(first.id);
    expect(second.circuitState).toBe('closed');
  });

  it('refuses a second row for the same provider and model', async () => {
    const modelId = ownModel('unique');
    await db.insert(providerHealths).values({ provider: PROVIDER, modelId });

    await expect(
      db.insert(providerHealths).values({ provider: PROVIDER, modelId }),
    ).rejects.toThrow();
  });

  /**
   * `provider` carries NO check constraint, deliberately: the Mongoose schema
   * declares no enum for it, and converting a validator that never existed into
   * a live constraint would start rejecting rows the source accepts. The
   * control is that `circuitState`, which DOES have an enum in the source, is
   * still rejected — otherwise "the insert succeeded" would also be what a
   * database with no constraints at all reports.
   */
  it('accepts any provider string but still rejects an unknown circuit state', async () => {
    const modelId = ownModel('no-enum');
    await expect(
      db.insert(providerHealths).values({ provider: 'ph-unregistered-provider', modelId }),
    ).resolves.toBeDefined();

    await expect(
      db
        .insert(providerHealths)
        .values({ provider: PROVIDER, modelId: ownModel('bad-state'), circuitState: 'melted' }),
    ).rejects.toThrow();
  });
});
