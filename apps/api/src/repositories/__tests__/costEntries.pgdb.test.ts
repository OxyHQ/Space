import { afterAll, describe, expect, it } from 'vitest';
import { costEntries } from '../../db/schema/billing.js';
import {
  listCostEntries,
  listRecentCostEntriesByUser,
  modelEfficiency,
  recordCostEntry,
  topUsersByCost,
} from '../costEntries.js';
import { closeTestDb, testDb, testUserId } from './testDatabase.js';

const db = testDb();

afterAll(closeTestDb);

async function entry(
  userId: string,
  overrides: Partial<typeof costEntries.$inferInsert> = {},
): Promise<void> {
  await recordCostEntry(db, {
    userId,
    clarityModelId: 'clarity-v1',
    actualProvider: 'internal',
    actualModelId: 'internal-model',
    inputTokens: 100,
    outputTokens: 200,
    totalTokens: 300,
    costUsd: 0.0015,
    timestamp: new Date(Date.now() - 60_000),
    ...overrides,
  });
}

describe('recordCostEntry', () => {
  it('stores a fractional dollar cost without rounding it away', async () => {
    const userId = testUserId('cost-write');
    await entry(userId, { costUsd: 0.000125 });

    const rows = await listCostEntries(db, { userId });

    expect(rows).toHaveLength(1);
    expect(rows[0]?.costUsd).toBeCloseTo(0.000125, 9);
    expect(rows[0]?.savedFromCache).toBe(false);
  });

  /**
   * `costUsd` is `double precision`, so postgres.js hands it back as a NUMBER
   * rather than the string a `numeric` column would produce. The distinction
   * matters because the caller's aggregation loop adds these values directly:
   * a string would concatenate silently.
   */
  it('reads cost back as a number', async () => {
    const userId = testUserId('cost-type');
    await entry(userId, { costUsd: 1.5 });

    const rows = await listCostEntries(db, { userId });

    expect(typeof rows[0]?.costUsd).toBe('number');
    expect((rows[0]?.costUsd ?? 0) + 1).toBe(2.5);
  });
});

describe('listCostEntries date bounds', () => {
  /**
   * The source builds `{ $gte: startDate, $lte: endDate }` — CLOSED at both
   * ends. A row landing exactly on the upper bound must be included; `lt`
   * would silently drop it and the total would be quietly short.
   */
  it('includes a row sitting exactly on the upper bound', async () => {
    const userId = testUserId('cost-bounds');
    const at = new Date(Date.now() - 30_000);
    await entry(userId, { timestamp: at });

    const included = await listCostEntries(db, {
      userId,
      startDate: new Date(at.getTime() - 1000),
      endDate: at,
    });

    expect(included).toHaveLength(1);
  });

  it('excludes a row outside the window', async () => {
    const userId = testUserId('cost-outside');
    await entry(userId, { timestamp: new Date(Date.now() - 86_400_000) });

    const rows = await listCostEntries(db, {
      userId,
      startDate: new Date(Date.now() - 3600_000),
    });

    expect(rows).toHaveLength(0);
  });

  it('scopes to the requested user', async () => {
    const mine = testUserId('cost-mine');
    const theirs = testUserId('cost-theirs');
    await entry(mine);
    await entry(theirs);

    expect(await listCostEntries(db, { userId: mine })).toHaveLength(1);
  });
});

describe('topUsersByCost', () => {
  it('sums cost per user and returns numbers throughout', async () => {
    const userId = testUserId('cost-top');
    await entry(userId, { costUsd: 1.25, totalTokens: 100 });
    await entry(userId, { costUsd: 2.25, totalTokens: 200 });

    const rows = await topUsersByCost(db, { limit: 500 });
    const mine = rows.find((r) => r.userId === userId);

    expect(mine).toBeDefined();
    expect(mine?.totalSpent).toBeCloseTo(3.5, 9);
    expect(typeof mine?.totalTokens).toBe('number');
    // `sum(total_tokens)` is bigint and arrives as a string uncoerced.
    expect((mine?.totalTokens ?? 0) + 1).toBe(301);
    expect((mine?.totalRequests ?? 0) + 1).toBe(3);
  });
});

describe('modelEfficiency', () => {
  /**
   * The `case when sum(total_tokens) > 0` guard reproduces the source's
   * `$cond`. It is not decorative: Postgres raises `division_by_zero` (22012),
   * so a model whose rows all carry zero tokens would fail the whole request
   * instead of returning the 0 the source returns.
   */
  it('returns zero rather than raising for a model with no tokens', async () => {
    const modelId = `zero-tokens-${testUserId('m')}`;
    await entry(testUserId('cost-zero'), {
      clarityModelId: modelId,
      inputTokens: 0,
      outputTokens: 0,
      totalTokens: 0,
      costUsd: 0,
    });

    const rows = await modelEfficiency(db);
    const mine = rows.find((r) => r.clarityModelId === modelId);

    expect(mine?.avgCostPer1kTokens).toBe(0);
  });

  it('computes cost per thousand tokens', async () => {
    const modelId = `eff-${testUserId('m')}`;
    await entry(testUserId('cost-eff'), {
      clarityModelId: modelId,
      totalTokens: 2000,
      costUsd: 4,
    });

    const rows = await modelEfficiency(db);
    const mine = rows.find((r) => r.clarityModelId === modelId);

    // 4 USD over 2000 tokens = 2 USD per 1000 tokens.
    expect(mine?.avgCostPer1kTokens).toBeCloseTo(2, 9);
    expect(typeof mine?.totalRequests).toBe('number');
  });
});

describe('listRecentCostEntriesByUser', () => {
  it('returns the newest entries first, by explicit timestamp', async () => {
    const userId = testUserId('cost-recent');
    await entry(userId, { sessionId: 'older', timestamp: new Date(Date.now() - 40_000) });
    await entry(userId, { sessionId: 'newer', timestamp: new Date(Date.now() - 10_000) });

    const rows = await listRecentCostEntriesByUser(db, userId, 10);

    expect(rows.map((r) => r.sessionId)).toEqual(['newer', 'older']);
  });

  it('caps the result', async () => {
    const userId = testUserId('cost-cap');
    await entry(userId);
    await entry(userId);
    await entry(userId);

    expect(await listRecentCostEntriesByUser(db, userId, 2)).toHaveLength(2);
  });
});
