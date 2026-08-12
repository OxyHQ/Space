/**
 * `fallback_events` and `fallback_event_attempts` against a real PostgreSQL 17.
 *
 * ## Scoping
 *
 * Four of the five reads aggregate over a TIME WINDOW rather than over a key,
 * so they cannot be scoped by a filter. Instead every fixture carries a
 * `clarityModel`, `provider` and `reason` value minted by this file, and each
 * assertion reads only the group belonging to its own values. The two truly
 * ungroupable reads (`summary`, `countSince`) are asserted as DELTAS.
 *
 * `provider` and `reason` on the child table carry no CHECK — the Mongo
 * sub-document declares no enum — which is what makes per-test unique values
 * possible at all.
 *
 * Fixture instants are relative to `now`, and none is older than two days:
 * `fallback_events` is a registered expiry target at 30 days, and a fixture
 * older than that would be deleted out from under this file by the sweep in
 * `providerExpiry.pgdb.test.ts`.
 */

import { randomBytes } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { closeTestDb, getTestDb, type TestDatabase } from '../../db/__tests__/testDatabase.js';
import { fallbackEventAttempts, fallbackEvents } from '../../db/schema/providers.js';
import * as events from '../fallback-events.js';

let db: TestDatabase;

/** A value no other test and no previous run can produce. */
function own(label: string): string {
  return `fb-${label}-${randomBytes(6).toString('hex')}`;
}

function minutesAgo(minutes: number): Date {
  return new Date(Date.now() - minutes * 60_000);
}

const SINCE = () => new Date(Date.now() - 24 * 3_600_000);

function attempt(overrides: Partial<events.FallbackAttemptInput> = {}) {
  return {
    provider: own('p'),
    model: own('m'),
    error: 'boom',
    reason: own('r'),
    latencyMs: 100,
    ...overrides,
  };
}

beforeAll(async () => {
  db = await getTestDb();
});

afterAll(closeTestDb);

describe('recording an event', () => {
  it('stores the attempts in the order the engine made them', async () => {
    const clarityModel = own('order');
    const first = attempt({ reason: 'timeout' });
    const second = attempt({ reason: 'rate_limit' });
    const third = attempt({ reason: 'auth' });

    const id = await events.recordEvent(db, {
      clarityModel,
      attempts: [first, second, third],
      finalProvider: null,
      finalModel: null,
      success: false,
      totalLatencyMs: 900,
    });

    const stored = await db
      .select()
      .from(fallbackEventAttempts)
      .where(eq(fallbackEventAttempts.eventId, id))
      .orderBy(fallbackEventAttempts.position);

    expect(stored.map((row) => row.position)).toEqual([0, 1, 2]);
    expect(stored.map((row) => row.reason)).toEqual(['timeout', 'rate_limit', 'auth']);
  });

  it('stores an event with no attempts at all', async () => {
    const id = await events.recordEvent(db, {
      clarityModel: own('empty'),
      attempts: [],
      finalProvider: 'x',
      finalModel: 'y',
      success: true,
      totalLatencyMs: 10,
    });

    const stored = await db
      .select()
      .from(fallbackEventAttempts)
      .where(eq(fallbackEventAttempts.eventId, id));
    expect(stored).toHaveLength(0);
  });

  /**
   * The parent and its children are one fact. A cascade is what makes deleting
   * the parent — which the expiry sweep does — leave no orphaned attempts
   * behind, and it is why the attempts table needs no registry entry of its
   * own.
   */
  it('removes an event’s attempts with the event', async () => {
    const id = await events.recordEvent(db, {
      clarityModel: own('cascade'),
      attempts: [attempt(), attempt()],
      finalProvider: null,
      finalModel: null,
      success: false,
      totalLatencyMs: 100,
    });

    const before = await db
      .select()
      .from(fallbackEventAttempts)
      .where(eq(fallbackEventAttempts.eventId, id));
    expect(before).toHaveLength(2);

    await db.delete(fallbackEvents).where(eq(fallbackEvents.id, id));

    const after = await db
      .select()
      .from(fallbackEventAttempts)
      .where(eq(fallbackEventAttempts.eventId, id));
    expect(after).toHaveLength(0);
  });
});

describe('the summary card', () => {
  /**
   * `avgAttempts` must count an event with NO attempts as a 0.
   *
   * An inner join, or a `count(*)` over the joined row, would drop it or count
   * it as 1 — turning "half the requests needed no fallback at all" into "the
   * average chain is longer than it is". Asserted as a DELTA because this is
   * the one read that groups by nothing.
   */
  it('counts an event with no attempts as zero attempts, not as one', async () => {
    const before = await events.summary(db, SINCE());

    await events.recordEvent(db, {
      clarityModel: own('sum-none'),
      attempts: [],
      finalProvider: 'p',
      finalModel: 'm',
      success: true,
      totalLatencyMs: 5,
    });
    await events.recordEvent(db, {
      clarityModel: own('sum-two'),
      attempts: [attempt(), attempt()],
      finalProvider: null,
      finalModel: null,
      success: false,
      totalLatencyMs: 50,
    });

    const after = await events.summary(db, SINCE());

    expect(after.totalEvents).toBe(before.totalEvents + 2);
    expect(after.successCount).toBe(before.successCount + 1);
    expect(after.failureCount).toBe(before.failureCount + 1);

    // The sum of attempts moved by exactly 2 across 2 new events, which is only
    // true if the empty one contributed 0.
    const beforeTotal = (before.avgAttempts ?? 0) * before.totalEvents;
    const afterTotal = (after.avgAttempts ?? 0) * after.totalEvents;
    expect(afterTotal - beforeTotal).toBeCloseTo(2, 6);
  });

  /** Every aggregate is cast, because the caller divides `failureCount` by `totalEvents`. */
  it('returns counts as numbers that survive division', async () => {
    const row = await events.summary(db, SINCE());

    expect(typeof row.totalEvents).toBe('number');
    expect(typeof row.failureCount).toBe('number');
    expect(row.totalEvents).toBeGreaterThan(0);
    const rate = (row.failureCount / row.totalEvents) * 100;
    expect(Number.isFinite(rate)).toBe(true);
  });

  it('reports nulls rather than zeroes for averages over an empty window', async () => {
    const row = await events.summary(db, new Date(Date.now() + 3_600_000));

    expect(row.totalEvents).toBe(0);
    expect(row.avgAttempts).toBeNull();
    expect(row.maxAttempts).toBeNull();
  });
});

describe('top failure reasons', () => {
  it('counts attempts by reason and averages their latency', async () => {
    const common = own('common-reason');
    const rare = own('rare-reason');

    await events.recordEvent(db, {
      clarityModel: own('reasons'),
      attempts: [
        attempt({ reason: common, latencyMs: 100 }),
        attempt({ reason: common, latencyMs: 300 }),
        attempt({ reason: rare, latencyMs: 50 }),
      ],
      finalProvider: null,
      finalModel: null,
      success: false,
      totalLatencyMs: 450,
    });

    const rows = await events.topFailureReasons(db, SINCE(), 1000);
    const commonRow = rows.find((row) => row.reason === common);
    const rareRow = rows.find((row) => row.reason === rare);

    expect(commonRow?.count).toBe(2);
    expect(commonRow?.avgLatencyMs).toBeCloseTo(200, 6);
    expect(rareRow?.count).toBe(1);
  });

  it('excludes attempts whose event falls outside the window', async () => {
    const reason = own('windowed');

    await events.recordEvent(db, {
      clarityModel: own('old'),
      timestamp: new Date(Date.now() - 2 * 86_400_000),
      attempts: [attempt({ reason })],
      finalProvider: null,
      finalModel: null,
      success: false,
      totalLatencyMs: 1,
    });

    const inWindow = await events.topFailureReasons(db, SINCE(), 1000);
    expect(inWindow.map((row) => row.reason)).not.toContain(reason);

    // Positive control: widen the window and the same row appears, so the
    // absence above is a filter working rather than a query reading nothing.
    const wider = await events.topFailureReasons(db, new Date(Date.now() - 3 * 86_400_000), 1000);
    expect(wider.map((row) => row.reason)).toContain(reason);
  });
});

describe('most failed providers', () => {
  /**
   * `topReason` IS A CHOSEN SEMANTIC.
   *
   * The source `$push`es every reason into an unordered array and reads element
   * 0 — whichever document the scan reached first. This port returns the
   * provider's MOST FREQUENT reason, because the field is named `topReason` and
   * the admin panel reads it as one.
   *
   * The fixture makes the two readings disagree: the minority reason is
   * recorded FIRST, so "element 0" and "most frequent" are different answers.
   */
  it('reports each provider’s most frequent reason, not its first', async () => {
    const provider = own('provider');
    const minority = own('aaa-first-but-rare');
    const majority = own('zzz-later-but-common');

    await events.recordEvent(db, {
      clarityModel: own('top-reason'),
      attempts: [
        attempt({ provider, reason: minority }),
        attempt({ provider, reason: majority }),
        attempt({ provider, reason: majority }),
      ],
      finalProvider: null,
      finalModel: null,
      success: false,
      totalLatencyMs: 300,
    });

    const rows = await events.mostFailedProviders(db, SINCE(), 1000);
    const mine = rows.find((row) => row.provider === provider);

    expect(mine?.failureCount).toBe(3);
    expect(mine?.topReason).toBe(majority);
    // The alphabetical tie-break would also have picked the minority reason, so
    // this rules out both of the wrong answers at once.
    expect(mine?.topReason).not.toBe(minority);
  });

  /**
   * The correlated-subquery control. The first version of this query correlated
   * the top-reason lookup to the outer provider through a bare column
   * reference, which resolves against the SUBQUERY's own table — so every
   * provider would report the same globally-most-common reason. Two providers
   * with different reasons is what tells the two apart.
   */
  it('gives each provider its OWN top reason, not the global one', async () => {
    const providerA = own('pa');
    const providerB = own('pb');
    const reasonA = own('ra');
    const reasonB = own('rb');

    await events.recordEvent(db, {
      clarityModel: own('per-provider'),
      attempts: [
        attempt({ provider: providerA, reason: reasonA }),
        attempt({ provider: providerA, reason: reasonA }),
        attempt({ provider: providerB, reason: reasonB }),
      ],
      finalProvider: null,
      finalModel: null,
      success: false,
      totalLatencyMs: 300,
    });

    const rows = await events.mostFailedProviders(db, SINCE(), 1000);

    expect(rows.find((row) => row.provider === providerA)?.topReason).toBe(reasonA);
    expect(rows.find((row) => row.provider === providerB)?.topReason).toBe(reasonB);
  });

  it('counts distinct models per provider', async () => {
    const provider = own('models');
    const model = own('shared-model');

    await events.recordEvent(db, {
      clarityModel: own('model-count'),
      attempts: [
        attempt({ provider, model }),
        attempt({ provider, model }),
        attempt({ provider, model: own('other-model') }),
      ],
      finalProvider: null,
      finalModel: null,
      success: false,
      totalLatencyMs: 300,
    });

    const mine = (await events.mostFailedProviders(db, SINCE(), 1000)).find(
      (row) => row.provider === provider,
    );

    expect(mine?.failureCount).toBe(3);
    expect(mine?.modelCount).toBe(2);
  });
});

describe('failures by Clarity model', () => {
  it('computes the fallback rate per model', async () => {
    const clarityModel = own('rates');

    await events.recordEvent(db, {
      clarityModel,
      attempts: [attempt()],
      finalProvider: null,
      finalModel: null,
      success: false,
      totalLatencyMs: 100,
    });
    await events.recordEvent(db, {
      clarityModel,
      attempts: [attempt(), attempt()],
      finalProvider: 'p',
      finalModel: 'm',
      success: true,
      totalLatencyMs: 200,
    });
    await events.recordEvent(db, {
      clarityModel,
      attempts: [],
      finalProvider: 'p',
      finalModel: 'm',
      success: true,
      totalLatencyMs: 10,
    });

    const mine = (await events.failuresByModel(db, SINCE(), 1000)).find(
      (row) => row.clarityModel === clarityModel,
    );

    expect(mine?.totalEvents).toBe(3);
    expect(mine?.failures).toBe(1);
    expect(mine?.successes).toBe(2);
    expect(mine?.fallbackRate).toBeCloseTo(33.3333, 3);
    // (1 + 2 + 0) / 3 — the zero-attempt event contributes a 0, not a 1.
    expect(mine?.avgAttempts).toBeCloseTo(1, 6);
  });
});

describe('recent failures', () => {
  /**
   * The limit counts EVENTS, not attempt rows. A join with the limit applied
   * afterwards returns twenty ATTEMPTS spread across however many events fit —
   * the standard way a `limit` over a one-to-many silently changes meaning.
   * Three events with three attempts each is what makes the two disagree.
   */
  it('limits events rather than attempt rows', async () => {
    const clarityModel = own('recent');

    /**
     * The window opens AFTER every row this file has written so far, so the
     * three events below are the only ones inside it. Filtering the result by
     * `clarityModel` is not enough here: the limit is applied by the DATABASE,
     * before any caller-side filter, so an unscoped window would let sibling
     * tests' newer events consume both slots — which is exactly how this
     * assertion failed the first time it was written.
     */
    const windowOpens = new Date(Date.now() + 1);
    for (let n = 0; n < 3; n += 1) {
      await events.recordEvent(db, {
        clarityModel,
        timestamp: new Date(windowOpens.getTime() + n * 1000),
        attempts: [attempt(), attempt(), attempt()],
        finalProvider: null,
        finalModel: null,
        success: false,
        totalLatencyMs: 300,
      });
    }

    const rows = await events.recentFailures(db, windowOpens, 2);

    // Two EVENTS, each carrying all three of its attempts. A join with the
    // limit applied afterwards would have returned two ATTEMPT rows instead.
    expect(rows).toHaveLength(2);
    expect(rows.every((row) => row.clarityModel === clarityModel)).toBe(true);
    for (const row of rows) {
      expect(row.attempts).toHaveLength(3);
    }
  });

  it('returns the newest first, with attempts in order', async () => {
    const clarityModel = own('recent-order');
    await events.recordEvent(db, {
      clarityModel,
      timestamp: minutesAgo(30),
      attempts: [attempt({ reason: 'older-first' })],
      finalProvider: null,
      finalModel: null,
      success: false,
      totalLatencyMs: 1,
    });
    await events.recordEvent(db, {
      clarityModel,
      timestamp: minutesAgo(1),
      attempts: [attempt({ reason: 'newer-first' }), attempt({ reason: 'newer-second' })],
      finalProvider: null,
      finalModel: null,
      success: false,
      totalLatencyMs: 2,
    });

    const rows = (await events.recentFailures(db, SINCE(), 100)).filter(
      (row) => row.clarityModel === clarityModel,
    );

    expect(rows[0]?.attempts.map((a) => a.reason)).toEqual(['newer-first', 'newer-second']);
    expect(rows[1]?.attempts.map((a) => a.reason)).toEqual(['older-first']);
  });

  it('excludes successful events', async () => {
    const clarityModel = own('recent-success');
    await events.recordEvent(db, {
      clarityModel,
      attempts: [attempt()],
      finalProvider: 'p',
      finalModel: 'm',
      success: true,
      totalLatencyMs: 1,
    });

    const rows = (await events.recentFailures(db, SINCE(), 100)).filter(
      (row) => row.clarityModel === clarityModel,
    );
    expect(rows).toHaveLength(0);
  });

  it('returns an empty list without a second query when nothing matched', async () => {
    const rows = await events.recentFailures(db, new Date(Date.now() + 3_600_000), 20);
    expect(rows).toEqual([]);
  });
});
