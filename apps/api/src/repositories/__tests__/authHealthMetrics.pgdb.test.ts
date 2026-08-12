/**
 * `auth_health_metrics` against a real PostgreSQL 17.
 *
 * Every bucket is keyed by a `method` this file mints, and `summaryByMethod`
 * groups BY method — so every aggregate here is scoped by construction rather
 * than by a filter someone has to remember.
 */

import { randomBytes } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { closeTestDb, getTestDb, type TestDatabase } from '../../db/__tests__/testDatabase.js';
import * as metrics from '../auth-health-metrics.js';

let db: TestDatabase;

/** A method name no other test and no previous run can produce. */
function ownMethod(label: string): string {
  return `ahm-${label}-${randomBytes(6).toString('hex')}`;
}

/** An hour bucket relative to now — never an absolute date. */
function hoursAgo(hours: number): Date {
  const at = new Date(Date.now() - hours * 3_600_000);
  return new Date(at.getFullYear(), at.getMonth(), at.getDate(), at.getHours());
}

async function summaryFor(method: string) {
  const rows = await metrics.summaryByMethod(db, hoursAgo(24));
  return rows.find((row) => row.method === method);
}

beforeAll(async () => {
  db = await getTestDb();
});

afterAll(closeTestDb);

describe('bucket accumulation', () => {
  it('creates a bucket on the first request of the hour and increments after', async () => {
    const method = ownMethod('inc');
    const hour = hoursAgo(0);

    await metrics.recordSuccess(db, method, hour);
    await metrics.recordSuccess(db, method, hour);
    await metrics.recordFailure(db, method, hour, 'bad signature');

    const bucket = await metrics.findBucket(db, method, hour);
    expect(bucket?.successes).toBe(2);
    expect(bucket?.failures).toBe(1);
    expect(bucket?.lastFailureReason).toBe('bad signature');
  });

  it('keeps separate buckets per hour', async () => {
    const method = ownMethod('hours');
    await metrics.recordSuccess(db, method, hoursAgo(0));
    await metrics.recordSuccess(db, method, hoursAgo(1));

    expect((await metrics.findBucket(db, method, hoursAgo(0)))?.successes).toBe(1);
    expect((await metrics.findBucket(db, method, hoursAgo(1)))?.successes).toBe(1);
  });

  /**
   * THE `$set: { x: undefined }` HAZARD, in the shape it takes here.
   *
   * The source spreads `...(reason ? { lastFailureReason } : {})` into `$set`,
   * so a failure recorded WITHOUT a reason leaves the previous reason in place.
   * Written naively — `set last_failure_reason = $2` with a null `$2` — it
   * would erase it, and the dashboard would show a failure with no cause. The
   * `coalesce` is what keeps the source's behaviour.
   */
  it('a failure with no reason preserves the reason already stored', async () => {
    const method = ownMethod('preserve');
    const hour = hoursAgo(0);

    await metrics.recordFailure(db, method, hour, 'token expired');
    await metrics.recordFailure(db, method, hour, undefined);

    const bucket = await metrics.findBucket(db, method, hour);
    expect(bucket?.failures).toBe(2);
    expect(bucket?.lastFailureReason).toBe('token expired');
  });

  it('a failure with a new reason replaces the old one', async () => {
    const method = ownMethod('replace');
    const hour = hoursAgo(0);

    await metrics.recordFailure(db, method, hour, 'token expired');
    await metrics.recordFailure(db, method, hour, 'signature mismatch');

    expect((await metrics.findBucket(db, method, hour))?.lastFailureReason).toBe(
      'signature mismatch',
    );
  });

  it('truncates a reason to 500 characters, as the source does', async () => {
    const method = ownMethod('truncate');
    const hour = hoursAgo(0);

    await metrics.recordFailure(db, method, hour, 'x'.repeat(900));

    expect((await metrics.findBucket(db, method, hour))?.lastFailureReason).toHaveLength(500);
  });
});

describe('the per-method summary', () => {
  /**
   * `NULLS LAST` IS THE LOAD-BEARING PART OF THIS QUERY.
   *
   * The source's `$last: '$lastFailureReason'` had no defined meaning — a
   * `$group` with no `$sort` returns whichever bucket it ended on — so this port
   * chose "the reason belonging to the most recent failure", which is the only
   * reading under which `lastFailure` and `lastFailureReason` describe the same
   * event.
   *
   * `lastFailure` is NULL for every bucket that only ever saw successes, and a
   * NULL sorts FIRST under a plain `order by ... desc` in Postgres. So without
   * `nulls last` this returns the reason from a bucket that never failed —
   * which is null — and a method with a real, visible failure count reports no
   * cause at all. Nothing else in the suite breaks if those two words are
   * deleted.
   *
   * The fixture is built to make that the difference: the failing bucket is
   * OLDER than the clean one, so a correct ordering has to skip the null.
   */
  it('reports the reason from the most recent failure, not from a bucket that never failed', async () => {
    const method = ownMethod('nulls-last');

    await metrics.recordFailure(db, method, hoursAgo(3), 'the real reason');
    // A newer bucket with successes only: `lastFailure` stays null.
    await metrics.recordSuccess(db, method, hoursAgo(1));
    await metrics.recordSuccess(db, method, hoursAgo(0));

    const row = await summaryFor(method);

    expect(row?.totalFailures).toBe(1);
    expect(row?.lastFailure).toBeInstanceOf(Date);
    expect(row?.lastFailureReason).toBe('the real reason');
  });

  /** Two failing buckets: the NEWER reason wins, which is the other half of the choice. */
  it('prefers the newer failure when several buckets failed', async () => {
    const method = ownMethod('newest');

    await metrics.recordFailure(db, method, hoursAgo(5), 'older cause');
    await metrics.recordFailure(db, method, hoursAgo(1), 'newer cause');

    expect((await summaryFor(method))?.lastFailureReason).toBe('newer cause');
  });

  /**
   * Both counters are `int8` sums and postgres.js decodes those as STRINGS
   * while drizzle types them `number`. The success rate divides them, so an
   * uncast pair yields `NaN` and every method reads unhealthy.
   */
  it('returns counters as numbers that survive division', async () => {
    const method = ownMethod('numbers');
    const hour = hoursAgo(0);

    for (let n = 0; n < 8; n += 1) await metrics.recordSuccess(db, method, hour);
    for (let n = 0; n < 2; n += 1) await metrics.recordFailure(db, method, hour, 'nope');

    const row = await summaryFor(method);

    expect(typeof row?.totalSuccesses).toBe('number');
    expect(typeof row?.totalFailures).toBe('number');
    expect(row?.totalSuccesses).toBe(8);
    expect(row?.totalFailures).toBe(2);
    expect(row?.successRate).toBeCloseTo(0.8, 10);
    expect(Number.isNaN(row?.successRate ?? Number.NaN)).toBe(false);
    // Ten requests at exactly 80% is the boundary the source calls healthy.
    expect(row?.isHealthy).toBe(true);
  });

  it('calls a method unhealthy below 80% once it clears the ten-request floor', async () => {
    const method = ownMethod('unhealthy');
    const hour = hoursAgo(0);

    for (let n = 0; n < 7; n += 1) await metrics.recordSuccess(db, method, hour);
    for (let n = 0; n < 3; n += 1) await metrics.recordFailure(db, method, hour, 'nope');

    const row = await summaryFor(method);
    expect(row?.successRate).toBeCloseTo(0.7, 10);
    expect(row?.isHealthy).toBe(false);
  });

  /**
   * Under the floor everything is healthy — that is the source's rule, and it
   * is what stops a single failure on a quiet method from paging someone.
   */
  it('calls a method healthy below the ten-request floor whatever its rate', async () => {
    const method = ownMethod('quiet');
    await metrics.recordFailure(db, ownMethod('unrelated'), hoursAgo(0), 'noise');
    await metrics.recordFailure(db, method, hoursAgo(0), 'the only request');

    const row = await summaryFor(method);
    expect(row?.totalFailures).toBe(1);
    expect(row?.successRate).toBe(0);
    expect(row?.isHealthy).toBe(true);
  });

  /**
   * A method whose buckets all fall outside the window must not appear at all.
   * The positive control beside it is a method inside the window, so "the list
   * was empty" cannot pass for "the filter worked".
   */
  it('excludes buckets outside the window', async () => {
    const outside = ownMethod('outside');
    const inside = ownMethod('inside');

    await metrics.recordSuccess(db, outside, hoursAgo(48));
    await metrics.recordSuccess(db, inside, hoursAgo(2));

    const rows = await metrics.summaryByMethod(db, hoursAgo(24));
    const methods = rows.map((row) => row.method);

    expect(methods).toContain(inside);
    expect(methods).not.toContain(outside);
  });

  it('sorts methods by name, as the source did', async () => {
    const rows = await metrics.summaryByMethod(db, hoursAgo(24));
    const methods = rows.map((row) => row.method);

    expect(methods).toEqual([...methods].sort());
    // Floor: an empty result would satisfy the assertion above vacuously.
    expect(methods.length).toBeGreaterThan(0);
  });
});
