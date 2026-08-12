/**
 * `cost_entries` against a real PostgreSQL 17.
 *
 * This table was ported twice — the briefs for billing and for provider routing
 * both reached it, because `lib/cost-tracker.ts:65` declares the model inline
 * and the route that consumes it is `internal/providers/routes/usage.ts:125`.
 * The integration kept this domain's copy and removed billing's, along with
 * billing's suite; this file replaces that coverage.
 *
 * Every read here is scoped to a `userId` or `clarityModelId` this file mints,
 * because `topUsersByCost` and `modelEfficiency` aggregate over the whole table.
 */

import { randomBytes } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { closeTestDb, getTestDb, type TestDatabase } from '../../db/__tests__/testDatabase.js';
import * as costs from '../cost-entries.js';

let db: TestDatabase;

function own(label: string): string {
  return `ce-${label}-${randomBytes(6).toString('hex')}`;
}

async function record(overrides: Partial<costs.NewCostEntry> = {}) {
  await costs.recordCost(db, {
    userId: own('user'),
    clarityModelId: own('model'),
    actualProvider: 'openai',
    actualModelId: 'gpt-internal',
    inputTokens: 100,
    outputTokens: 100,
    totalTokens: 200,
    costUSD: 0.01,
    ...overrides,
  });
}

beforeAll(async () => {
  db = await getTestDb();
});

afterAll(closeTestDb);

describe('internal provider names stay internal', () => {
  /**
   * `cost-tracker.ts:303` marks `costByActualProvider` INTERNAL ONLY. The
   * per-user reads exist for a user's own dashboard, so neither may carry the
   * provider that actually served the request.
   *
   * The control matters as much as the assertion: `listGlobal` DOES return
   * them, which proves the columns are populated and that the absence above is
   * a projection rather than an empty table.
   */
  it('the per-user reads carry no provider identity, and the admin read does', async () => {
    const userId = own('user');
    await record({ userId, actualProvider: 'anthropic', actualModelId: 'claude-internal' });

    const forUser = await costs.listForUser(db, userId);
    const recent = await costs.listRecentForUser(db, userId);

    expect(forUser).toHaveLength(1);
    expect(forUser[0]).not.toHaveProperty('actualProvider');
    expect(forUser[0]).not.toHaveProperty('actualModelId');
    expect(recent[0]).not.toHaveProperty('actualProvider');
    expect(JSON.stringify(forUser)).not.toContain('anthropic');
    expect(JSON.stringify(recent)).not.toContain('claude-internal');

    // Control: the values really are stored, and the admin roll-up sees them.
    const global = (await costs.listGlobal(db)).filter((row) => row.userId === userId);
    expect(global[0]?.actualProvider).toBe('anthropic');
    expect(global[0]?.actualModelId).toBe('claude-internal');
  });

  /** The Clarity model the caller asked for IS safe to show, and must be. */
  it('the per-user reads keep the Clarity model id', async () => {
    const userId = own('user');
    const clarityModelId = own('clarity');
    await record({ userId, clarityModelId });

    expect((await costs.listForUser(db, userId))[0]?.clarityModelId).toBe(clarityModelId);
  });
});

describe('top users by cost', () => {
  /**
   * `sum(totalTokens)` is over a `bigint` column, and postgres.js decodes
   * `int8` as a STRING while drizzle types it `number`. The caller adds these
   * figures to others, so an uncast sum concatenates — `"400" + 100` is
   * `"400100"`, a number that looks like a number.
   */
  it('sums cost and tokens as numbers that survive arithmetic', async () => {
    const userId = own('top');
    await record({ userId, costUSD: 1.5, totalTokens: 400 });
    await record({ userId, costUSD: 2.25, totalTokens: 600 });

    const mine = (await costs.topUsersByCost(db, 1000)).find((row) => row.userId === userId);

    expect(typeof mine?.totalTokens).toBe('number');
    expect(typeof mine?.totalSpent).toBe('number');
    expect(mine?.totalRequests).toBe(2);
    expect(mine?.totalTokens).toBe(1000);
    expect(mine?.totalSpent).toBeCloseTo(3.75, 10);
    expect((mine?.totalTokens ?? 0) + 100).toBe(1100);
    expect(String((mine?.totalTokens ?? 0) + 100)).not.toBe('1000100');
  });

  it('restricts the sum to the window', async () => {
    const userId = own('windowed');
    await record({ userId, costUSD: 5, timestamp: new Date(Date.now() - 10 * 86_400_000) });
    await record({ userId, costUSD: 1, timestamp: new Date() });

    const from = new Date(Date.now() - 86_400_000);
    const inWindow = (await costs.topUsersByCost(db, 1000, from)).find(
      (row) => row.userId === userId,
    );
    expect(inWindow?.totalSpent).toBeCloseTo(1, 10);

    // Control: without the window both rows are counted, so the filter above is
    // doing something rather than reading nothing.
    const all = (await costs.topUsersByCost(db, 1000)).find((row) => row.userId === userId);
    expect(all?.totalSpent).toBeCloseTo(6, 10);
  });

  /**
   * The source sorts by spend descending and takes `limit`; ties were settled
   * by whatever order the group produced. `userId` is the tie-break that makes
   * the cut deterministic.
   */
  it('orders by spend descending, ties broken by user id', async () => {
    const prefix = own('tie');
    const first = `${prefix}-a`;
    const second = `${prefix}-b`;
    await record({ userId: first, costUSD: 1 });
    await record({ userId: second, costUSD: 1 });

    const rows = (await costs.topUsersByCost(db, 1000)).filter((row) =>
      row.userId.startsWith(prefix),
    );
    expect(rows.map((row) => row.userId)).toEqual([first, second]);
  });
});

describe('model efficiency', () => {
  it('computes cost per thousand tokens', async () => {
    const clarityModelId = own('efficient');
    await record({ clarityModelId, costUSD: 2, totalTokens: 1000 });
    await record({ clarityModelId, costUSD: 2, totalTokens: 1000 });

    const mine = (await costs.modelEfficiency(db)).find(
      (row) => row.clarityModelId === clarityModelId,
    );

    expect(mine?.totalRequests).toBe(2);
    expect(mine?.totalCost).toBeCloseTo(4, 10);
    expect(mine?.avgCostPer1kTokens).toBeCloseTo(2, 10);
  });

  /**
   * The source guards its division with a `$cond` on a zero token total. Here
   * that is `nullif`/`coalesce`: a model whose entries all recorded zero tokens
   * must report 0, not a division error and not a null the caller renders as
   * "NaN".
   */
  it('reports zero rather than dividing by zero tokens', async () => {
    const clarityModelId = own('zero-tokens');
    await record({ clarityModelId, costUSD: 1, totalTokens: 0 });

    const mine = (await costs.modelEfficiency(db)).find(
      (row) => row.clarityModelId === clarityModelId,
    );

    expect(mine?.avgCostPer1kTokens).toBe(0);
    expect(mine?.totalCost).toBeCloseTo(1, 10);
  });

  it('groups by the Clarity model, never by the provider that served it', async () => {
    const clarityModelId = own('grouped');
    await record({ clarityModelId, actualProvider: 'openai', costUSD: 1, totalTokens: 1000 });
    await record({ clarityModelId, actualProvider: 'groq', costUSD: 1, totalTokens: 1000 });

    const rows = (await costs.modelEfficiency(db)).filter(
      (row) => row.clarityModelId === clarityModelId,
    );

    expect(rows).toHaveLength(1);
    expect(rows[0]?.totalRequests).toBe(2);
    expect(JSON.stringify(rows)).not.toContain('groq');
  });
});

describe('listings', () => {
  it('returns a user’s entries oldest first, within the window', async () => {
    const userId = own('list');
    await record({ userId, costUSD: 1, timestamp: new Date(Date.now() - 3_000) });
    await record({ userId, costUSD: 2, timestamp: new Date(Date.now() - 1_000) });

    const rows = await costs.listForUser(db, userId);
    expect(rows.map((row) => row.costUSD)).toEqual([1, 2]);
  });

  /**
   * `timestamp desc` alone is not a total order. The uuid v7 primary key is NOT
   * monotonic within a millisecond, so `id` is a tie-break here and never a
   * proxy for creation order — which is why the fixture writes explicit
   * timestamps rather than relying on insertion order.
   */
  it('returns the most recent entries first, bounded by the limit', async () => {
    const userId = own('recent');
    for (let n = 0; n < 5; n += 1) {
      await record({ userId, costUSD: n, timestamp: new Date(Date.now() - (5 - n) * 1_000) });
    }

    const rows = await costs.listRecentForUser(db, userId, 3);
    expect(rows.map((row) => row.costUSD)).toEqual([4, 3, 2]);
  });

  it('returns nothing for a user with no entries', async () => {
    expect(await costs.listForUser(db, own('empty'))).toEqual([]);
    expect(await costs.listRecentForUser(db, own('empty'))).toEqual([]);
  });
});
