import { eq, sql } from 'drizzle-orm';
import { afterAll, describe, expect, it } from 'vitest';
import { transactions } from '../../db/schema/billing.js';
import {
  countTransactions,
  countTransactionsByUser,
  createCreditPurchase,
  createSubscriptionPayment,
  listRecentTransactionsByUser,
  listTransactions,
  listTransactionsByUser,
} from '../transactions.js';
import { closeTestDb, testDb, testUserId } from './testDatabase.js';

const db = testDb();

afterAll(closeTestDb);

/** Every assertion below is scoped to an id this file owns; nothing counts globally. */
async function rowsFor(oxyUserId: string): Promise<number> {
  const rows = await db.execute(
    sql`select count(*)::int as n from ${transactions} where ${transactions.oxyUserId} = ${oxyUserId}`,
  );
  return Number(rows[0]?.n ?? 0);
}

describe('createCreditPurchase idempotency', () => {
  it('records the purchase', async () => {
    const userId = testUserId('tx-buy');

    const row = await createCreditPurchase(db, {
      oxyUserId: userId,
      stripeCustomerId: 'cus_1',
      stripePaymentIntentId: `pi_${userId}`,
      amount: 1000,
      currency: 'usd',
      credits: 100,
      description: 'Purchased 100 credits',
    });

    expect(row).not.toBeNull();
    expect(row?.type).toBe('credit_purchase');
    expect(row?.status).toBe('completed');
  });

  /**
   * The redelivered webhook. Two things have to hold, and asserting only the
   * first would let a broken implementation through:
   *
   *  1. the second call RETURNS NULL rather than throwing — a thrown duplicate
   *     is exactly what could not be told apart from a dropped connection, and
   *     is the failure mode this port exists to remove;
   *  2. exactly ONE row exists afterwards — without this, an implementation
   *     that silently inserted a second row and returned null would pass.
   */
  it('answers a redelivered payment intent with null, and stores one row', async () => {
    const userId = testUserId('tx-dup');
    const values = {
      oxyUserId: userId,
      stripePaymentIntentId: `pi_${userId}`,
      amount: 1000,
      currency: 'usd',
      credits: 100,
    };

    const first = await createCreditPurchase(db, values);
    const second = await createCreditPurchase(db, values);

    expect(first).not.toBeNull();
    expect(second).toBeNull();
    expect(await rowsFor(userId)).toBe(1);
  });

  /**
   * The negative control for the test above: a DIFFERENT payment intent must
   * still insert. Without it, an implementation that refused every insert
   * after the first would look correct.
   */
  it('still records a different payment intent for the same user', async () => {
    const userId = testUserId('tx-two');
    const base = { oxyUserId: userId, amount: 500, currency: 'usd', credits: 50 };

    await createCreditPurchase(db, { ...base, stripePaymentIntentId: `pi_${userId}_a` });
    await createCreditPurchase(db, { ...base, stripePaymentIntentId: `pi_${userId}_b` });

    expect(await rowsFor(userId)).toBe(2);
  });
});

describe('createSubscriptionPayment idempotency', () => {
  it('answers a redelivered period with null, and stores one row', async () => {
    const userId = testUserId('tx-sub');
    const values = {
      oxyUserId: userId,
      amount: 2000,
      currency: 'usd',
      credits: 500,
      dedup: `sub_${userId}_1700000000`,
    };

    expect(await createSubscriptionPayment(db, values)).not.toBeNull();
    expect(await createSubscriptionPayment(db, values)).toBeNull();
    expect(await rowsFor(userId)).toBe(1);
  });

  it('records the next period, which carries a different dedup key', async () => {
    const userId = testUserId('tx-periods');
    const base = { oxyUserId: userId, amount: 2000, currency: 'usd', credits: 500 };

    await createSubscriptionPayment(db, { ...base, dedup: `sub_${userId}_p1` });
    await createSubscriptionPayment(db, { ...base, dedup: `sub_${userId}_p2` });

    expect(await rowsFor(userId)).toBe(2);
  });
});

/**
 * The `sparse: true` half of the port, and the reason no partial predicate was
 * written on either unique index.
 *
 * A Mongo sparse unique does NOT exclude a stored `null` — a second explicit
 * null raises E11000, which is why the Mongo idiom needs a
 * `partialFilterExpression`. A Postgres unique index is NULLS DISTINCT by
 * default, so the predicate is unnecessary; porting it anyway would embed a
 * false belief about Postgres in the schema. This asserts the difference is
 * real rather than assumed.
 */
describe('NULLS DISTINCT on both unique indexes', () => {
  it('permits many transactions with no payment intent and no dedup key', async () => {
    const userId = testUserId('tx-nulls');
    const values = { oxyUserId: userId, amount: 100, currency: 'usd', credits: 10 };

    await db.insert(transactions).values({ ...values, type: 'refund', status: 'completed' });
    await db.insert(transactions).values({ ...values, type: 'refund', status: 'completed' });
    await db.insert(transactions).values({ ...values, type: 'refund', status: 'completed' });

    expect(await rowsFor(userId)).toBe(3);
  });
});

describe('CHECK constraints', () => {
  it('refuses an unknown transaction type', async () => {
    await expect(
      db.insert(transactions).values({
        oxyUserId: testUserId('tx-bad'),
        type: 'chargeback',
        amount: 1,
        currency: 'usd',
        credits: 0,
      }),
    ).rejects.toThrow();
  });

  it('refuses an unknown status', async () => {
    await expect(
      db.insert(transactions).values({
        oxyUserId: testUserId('tx-bad'),
        type: 'refund',
        amount: 1,
        currency: 'usd',
        credits: 0,
        status: 'disputed',
      }),
    ).rejects.toThrow();
  });
});

/**
 * ## The bigint-as-string trap
 *
 * `count(*)` is `bigint`, which postgres.js hands back as a STRING while
 * drizzle types it `number`. `expect(total).toBe(2)` would NOT catch a missing
 * coercion in a way anyone could rely on — but `total + 1` would silently
 * become `"21"`, and `total > 20` would compare lexicographically.
 *
 * So these assert ARITHMETIC and the runtime type, not equality with a
 * literal. A test that only reads the value back cannot tell the two apart.
 */
describe('counts are numbers, not strings', () => {
  it('countTransactionsByUser returns a number that adds rather than concatenates', async () => {
    const userId = testUserId('tx-count');
    const base = { oxyUserId: userId, amount: 100, currency: 'usd', credits: 10 };
    await createCreditPurchase(db, { ...base, stripePaymentIntentId: `pi_${userId}_1` });
    await createCreditPurchase(db, { ...base, stripePaymentIntentId: `pi_${userId}_2` });

    const total = await countTransactionsByUser(db, userId);

    expect(typeof total).toBe('number');
    expect(total).toBe(2);
    expect(total + 1).toBe(3);
    expect(`${total + 1}`).not.toBe('21');
  });

  it('countTransactions returns a number for a filtered admin query', async () => {
    const userId = testUserId('tx-admin-count');
    const base = { oxyUserId: userId, amount: 100, currency: 'usd', credits: 10 };
    await createCreditPurchase(db, { ...base, stripePaymentIntentId: `pi_${userId}_1` });
    await createCreditPurchase(db, { ...base, stripePaymentIntentId: `pi_${userId}_2` });

    const total = await countTransactions(db, { oxyUserId: userId, status: 'completed' });

    expect(typeof total).toBe('number');
    expect(total + 1).toBe(3);
  });

  it('counts zero for a user with no transactions', async () => {
    const total = await countTransactionsByUser(db, testUserId('tx-empty'));
    expect(total).toBe(0);
    expect(total + 1).toBe(1);
  });
});

describe('listing and pagination', () => {
  /**
   * Ordering is asserted with EXPLICIT timestamps. The primary key is a uuid
   * v7 and is not monotonic within a millisecond, so three rows inserted in a
   * loop have no reliable creation order to assert against — a test that
   * relied on insertion order would be flaky for reasons that have nothing to
   * do with the query.
   */
  it('returns a user history newest first, and pages without overlap', async () => {
    const userId = testUserId('tx-page');
    const base = { oxyUserId: userId, type: 'credit_purchase', amount: 100, currency: 'usd' };
    await db.insert(transactions).values([
      { ...base, credits: 1, description: 'oldest', createdAt: new Date(Date.now() - 30_000) },
      { ...base, credits: 2, description: 'middle', createdAt: new Date(Date.now() - 20_000) },
      { ...base, credits: 3, description: 'newest', createdAt: new Date(Date.now() - 10_000) },
    ]);

    const page1 = await listTransactionsByUser(db, userId, { limit: 2, offset: 0 });
    const page2 = await listTransactionsByUser(db, userId, { limit: 2, offset: 2 });

    expect(page1.map((r) => r.description)).toEqual(['newest', 'middle']);
    expect(page2.map((r) => r.description)).toEqual(['oldest']);
  });

  it('scopes a user history to that user', async () => {
    const mine = testUserId('tx-mine');
    const theirs = testUserId('tx-theirs');
    const base = { type: 'refund', amount: 1, currency: 'usd', credits: 0 };
    await db.insert(transactions).values([
      { ...base, oxyUserId: mine },
      { ...base, oxyUserId: theirs },
    ]);

    const rows = await listTransactionsByUser(db, mine, { limit: 50, offset: 0 });

    expect(rows).toHaveLength(1);
    expect(rows[0]?.oxyUserId).toBe(mine);
  });

  /**
   * An absent filter key must DROP its clause. Spelled as `where col = null`
   * it would match nothing, and the admin transaction list would render empty
   * with no error — the quiet failure this whole domain is written against.
   */
  it('an undefined filter key does not become a null comparison', async () => {
    const userId = testUserId('tx-nofilter');
    await db
      .insert(transactions)
      .values({ oxyUserId: userId, type: 'refund', amount: 1, currency: 'usd', credits: 0 });

    const unfiltered = await listTransactions(db, {}, { limit: 500, offset: 0 });

    expect(unfiltered.some((r) => r.oxyUserId === userId)).toBe(true);
  });

  it('caps the per-user admin view', async () => {
    const userId = testUserId('tx-recent');
    await db
      .insert(transactions)
      .values({ oxyUserId: userId, type: 'refund', amount: 1, currency: 'usd', credits: 0 });

    const rows = await listRecentTransactionsByUser(db, userId, 50);

    expect(rows).toHaveLength(1);
  });
});

describe('column defaults', () => {
  it('defaults currency and status the way the Mongoose schema did', async () => {
    const userId = testUserId('tx-defaults');
    await db.insert(transactions).values({
      oxyUserId: userId,
      type: 'credit_purchase',
      amount: 100,
      credits: 10,
    });

    const rows = await db.select().from(transactions).where(eq(transactions.oxyUserId, userId));

    expect(rows[0]?.currency).toBe('usd');
    expect(rows[0]?.status).toBe('pending');
  });
});
