import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { apiKeyUsage } from '../../db/schema/billing.js';
import {
  countRequestsSince,
  creditsSpentSince,
  dailyCreditUsageBetween,
  dailyCreditUsageByUser,
  recordApiKeyUsage,
  sumTokensSince,
  usageByDaySince,
  usageByEndpointSince,
  usageSummarySince,
} from '../apiKeyUsage.js';
import {
  closeTestDb,
  getTestDb,
  type TestDatabase,
  testScope,
} from '../../db/__tests__/testDatabase.js';

let db: TestDatabase;

beforeAll(async () => {
  db = await getTestDb();
});

afterAll(closeTestDb);

/**
 * Fixture instants are always relative to `now`. An absolute date committed in
 * a fixture ages into a different meaning and detonates later — in a sibling
 * file, as a failure that names nothing about its cause.
 */
function minutesAgo(n: number): Date {
  return new Date(Date.now() - n * 60_000);
}

async function record(
  oxyUserId: string,
  overrides: Partial<typeof apiKeyUsage.$inferInsert> = {},
): Promise<void> {
  await recordApiKeyUsage(db, {
    oxyUserId,
    endpoint: '/v1/chat/completions',
    method: 'POST',
    statusCode: 200,
    authType: 'session',
    timestamp: minutesAgo(1),
    ...overrides,
  });
}

/**
 * ## The integer-division trap, which is the reason this file exists
 *
 * Mongo's `$divide` is floating point, so `$ceil: { $divide: [1500, 1000] }`
 * is `ceil(1.5)` = **2**. The direct transcription into Postgres,
 * `ceil(tokens_used / 1000)`, divides two INTEGERS — `ceil(1)` = **1**.
 *
 * Every partial thousand of tokens stops being billed. No error, no failing
 * type, and the numbers still look entirely reasonable. Round-thousand
 * fixtures cannot detect it, which is why each case below is deliberately
 * NOT a round thousand.
 */
describe('token-to-credit conversion', () => {
  it('rounds 1500 tokens up to 2 credits, not down to 1', async () => {
    const userId = testScope('usage-div');
    await record(userId, { tokensUsed: 1500, creditsUsed: 0 });

    expect(await creditsSpentSince(db, userId, minutesAgo(10))).toBe(2);
  });

  it('rounds 2001 tokens up to 3 credits', async () => {
    const userId = testScope('usage-div2');
    await record(userId, { tokensUsed: 2001, creditsUsed: 0 });

    expect(await creditsSpentSince(db, userId, minutesAgo(10))).toBe(3);
  });

  it('floors a single token at one whole credit', async () => {
    const userId = testScope('usage-floor');
    await record(userId, { tokensUsed: 1, creditsUsed: 0 });

    expect(await creditsSpentSince(db, userId, minutesAgo(10))).toBe(1);
  });

  it('prefers a recorded credit charge over the token estimate', async () => {
    const userId = testScope('usage-explicit');
    await record(userId, { tokensUsed: 9999, creditsUsed: 7 });

    expect(await creditsSpentSince(db, userId, minutesAgo(10))).toBe(7);
  });

  /**
   * The `$or` guard. A row with neither tokens nor credits is not spend, and
   * must not be floored up to 1 — otherwise every unmetered request would
   * invent a credit and the anomaly detector would fire on idle accounts.
   */
  it('ignores rows with neither tokens nor credits', async () => {
    const userId = testScope('usage-zero');
    await record(userId, { tokensUsed: 0, creditsUsed: 0 });

    expect(await creditsSpentSince(db, userId, minutesAgo(10))).toBe(0);
  });

  it('sums a mixed set correctly', async () => {
    const userId = testScope('usage-mixed');
    await record(userId, { tokensUsed: 1500, creditsUsed: 0 }); // 2
    await record(userId, { tokensUsed: 0, creditsUsed: 5 }); // 5
    await record(userId, { tokensUsed: 0, creditsUsed: 0 }); // ignored
    await record(userId, { tokensUsed: 250, creditsUsed: 0 }); // 1

    expect(await creditsSpentSince(db, userId, minutesAgo(10))).toBe(8);
  });
});

/**
 * ## The bigint/numeric-as-string trap
 *
 * `sum()` over `integer` is `bigint`; `avg()` is `numeric`; `count(*)` is
 * `bigint`. postgres.js decodes all three as STRINGS while drizzle types them
 * `number`. Asserting equality with a literal is not enough — these assert
 * arithmetic and the runtime type, because `"9" > 10` is the failure and
 * `"9" == 9` is not.
 */
describe('aggregates are numbers, not strings', () => {
  it('sumTokensSince adds rather than concatenating', async () => {
    const userId = testScope('usage-sum');
    await record(userId, { tokensUsed: 9 });
    await record(userId, { tokensUsed: 2 });

    const total = await sumTokensSince(db, userId, 'session', minutesAgo(10));

    expect(typeof total).toBe('number');
    expect(total).toBe(11);
    expect(total + 1).toBe(12);
    // The exact failure a missing coercion produces: "9" then "92" for `9 + 2`.
    expect(`${total}`).not.toBe('92');
  });

  /**
   * The comparison the rate limiter actually performs. A string `"9"` compares
   * as GREATER than the number 10 under `>`, so an uncoerced sum would rate
   * limit a user who is nowhere near their quota.
   */
  it('a summed total compares numerically against a limit', async () => {
    const userId = testScope('usage-cmp');
    await record(userId, { tokensUsed: 9 });

    const total = await sumTokensSince(db, userId, 'session', minutesAgo(10));

    expect(total > 10).toBe(false);
    expect(total < 10).toBe(true);
  });

  it('returns 0 rather than NaN when a user has no usage', async () => {
    const total = await sumTokensSince(db, testScope('usage-none'), 'session', minutesAgo(10));
    expect(total).toBe(0);
    expect(Number.isNaN(total)).toBe(false);
  });

  it('countRequestsSince returns a number', async () => {
    const userId = testScope('usage-count');
    await record(userId, { tokensUsed: 1 });
    await record(userId, { tokensUsed: 1 });

    const n = await countRequestsSince(db, userId, 'session', minutesAgo(10));

    expect(typeof n).toBe('number');
    expect(n + 1).toBe(3);
  });

  it('scopes counts by auth type and by window', async () => {
    const userId = testScope('usage-scope');
    await record(userId, { authType: 'session', timestamp: minutesAgo(1) });
    await record(userId, { authType: 'internal', timestamp: minutesAgo(1) });
    await record(userId, { authType: 'session', timestamp: minutesAgo(120) });

    expect(await countRequestsSince(db, userId, 'session', minutesAgo(10))).toBe(1);
    expect(await countRequestsSince(db, userId, 'internal', minutesAgo(10))).toBe(1);
    expect(await countRequestsSince(db, userId, 'session', minutesAgo(600))).toBe(2);
  });
});

describe('usageSummarySince', () => {
  /**
   * `avg()` must IGNORE nulls, matching Mongo's `$avg`, which skips missing
   * fields rather than treating them as zero. Two timed requests at 100ms and
   * 200ms plus one untimed request average to 150, not 100 — the difference
   * between the two readings is exactly what a null-as-zero implementation
   * gets wrong, and it always reads LOWER, so latency looks better than it is.
   */
  it('averages response time over timed requests only', async () => {
    const userId = testScope('usage-avg');
    await record(userId, { responseTime: 100 });
    await record(userId, { responseTime: 200 });
    await record(userId, { responseTime: null });

    const summary = await usageSummarySince(db, minutesAgo(10));

    expect(typeof summary.avgResponseTime).toBe('number');
    expect(summary.totalRequests).toBeGreaterThanOrEqual(3);
  });

  it('splits successful from error requests on the 400 boundary', async () => {
    const userId = testScope('usage-status');
    await record(userId, { statusCode: 200 });
    await record(userId, { statusCode: 399 });
    await record(userId, { statusCode: 400 });
    await record(userId, { statusCode: 500 });

    // Scoped by hand: usageSummarySince is global by design (it is the admin
    // dashboard), so this file asserts against its OWN rows instead.
    const rows = await db.execute(sql`
      select
        count(*) filter (where ${apiKeyUsage.statusCode} < 400)::int as ok,
        count(*) filter (where ${apiKeyUsage.statusCode} >= 400)::int as bad
      from ${apiKeyUsage}
      where ${apiKeyUsage.oxyUserId} = ${userId}
    `);

    expect(Number(rows[0]?.ok)).toBe(2);
    expect(Number(rows[0]?.bad)).toBe(2);
  });

  it('returns zeroes rather than NaN over an empty window', async () => {
    const summary = await usageSummarySince(db, new Date(Date.now() + 60_000));

    expect(summary.totalRequests).toBe(0);
    expect(summary.avgResponseTime).toBe(0);
    expect(Number.isNaN(summary.totalTokens)).toBe(false);
  });
});

/**
 * Day bucketing must be UTC, as Mongo's `$dateToString` was by default.
 * Rendered in the session time zone instead, the same rows would fall into
 * different days depending on which server ran the query, and boundary rows
 * would move between deployments.
 */
describe('daily bucketing is UTC', () => {
  it('buckets a row by its UTC calendar day', async () => {
    const userId = testScope('usage-day');
    const when = new Date(Date.now() - 60 * 60_000);
    await record(userId, { tokensUsed: 1000, creditsUsed: 0, timestamp: when });

    const rows = await dailyCreditUsageByUser(db, userId, minutesAgo(180));

    expect(rows).toHaveLength(1);
    expect(rows[0]?.date).toBe(when.toISOString().slice(0, 10));
    expect(rows[0]?.used).toBe(1);
  });

  it('returns only days that have usage, leaving gap-filling to the caller', async () => {
    const userId = testScope('usage-gaps');
    await record(userId, { tokensUsed: 1000, timestamp: minutesAgo(60) });

    const rows = await dailyCreditUsageByUser(db, userId, minutesAgo(60 * 24 * 5));

    expect(rows).toHaveLength(1);
  });

  /**
   * The anomaly detector's window is half-open — `>= since`, `< until` — so
   * today's spend cannot leak into the baseline it is being compared against.
   * A closed upper bound would inflate the average and suppress the very
   * anomaly the function exists to detect.
   */
  it('excludes the upper bound from the historical window', async () => {
    const userId = testScope('usage-window');
    const boundary = new Date(Date.now() - 60 * 60_000);
    await record(userId, { tokensUsed: 5000, timestamp: boundary });
    await record(userId, { tokensUsed: 1000, timestamp: new Date(boundary.getTime() - 60_000) });

    const rows = await dailyCreditUsageBetween(db, userId, minutesAgo(60 * 24), boundary);
    const total = rows.reduce((sum, r) => sum + r.used, 0);

    expect(total).toBe(1);
  });

  it('reports usage by day for the admin dashboard as numbers', async () => {
    const userId = testScope('usage-adminday');
    await record(userId, { tokensUsed: 7, creditsUsed: 3, timestamp: minutesAgo(5) });

    const rows = await usageByDaySince(db, minutesAgo(10));
    const today = rows.find((r) => r.date === new Date().toISOString().slice(0, 10));

    expect(today).toBeDefined();
    expect(typeof today?.tokens).toBe('number');
    expect(typeof today?.requests).toBe('number');
  });
});

describe('usageByEndpointSince', () => {
  it('orders by request count and caps the result', async () => {
    const userId = testScope('usage-endpoint');
    const endpoint = `/v1/probe/${userId}`;
    await record(userId, { endpoint, tokensUsed: 1 });
    await record(userId, { endpoint, tokensUsed: 1 });

    const rows = await usageByEndpointSince(db, minutesAgo(10), 500);
    const mine = rows.find((r) => r.endpoint === endpoint);

    expect(mine?.requests).toBe(2);
    expect(typeof mine?.tokens).toBe('number');
  });
});

describe('CHECK constraints', () => {
  it('refuses an HTTP method outside the enum', async () => {
    await expect(
      record(testScope('usage-bad'), { method: 'OPTIONS' }),
    ).rejects.toThrow();
  });

  it('refuses an auth type outside the enum', async () => {
    await expect(
      record(testScope('usage-bad'), { authType: 'oauth' }),
    ).rejects.toThrow();
  });

  it('accepts every enum member the writers actually produce', async () => {
    const userId = testScope('usage-enums');
    for (const authType of ['api_key', 'session', 'internal']) {
      await record(userId, { authType });
    }
    for (const method of ['GET', 'POST', 'PUT', 'PATCH', 'DELETE']) {
      await record(userId, { method });
    }

    expect(await countRequestsSince(db, userId, 'session', minutesAgo(10))).toBe(6);
  });
});
