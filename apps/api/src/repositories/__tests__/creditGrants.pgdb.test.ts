/**
 * The credit grant, asserted by EXACT DELTA.
 *
 * This file exists because of a specific bug and is shaped by it. The
 * subscription renewal path once granted `creditsPerMonth` TWICE per delivery —
 * once inside the transaction beside its ledger row, once again on a line left
 * behind after it — and the whole suite stayed green, because every assertion
 * checked that a ledger row existed or that a balance had moved. "The balance
 * went up" passes just as happily on a double grant as on a correct one.
 *
 * So every assertion below is `after - before === exactly N`. Nothing here
 * asserts a direction.
 *
 * The dedup key is not what protects against this. It makes a REDELIVERED
 * webhook idempotent; it cannot see two grants inside one delivery. Only
 * counting the credits can.
 */

import { eq, sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { transactions, userCredits } from '../../db/schema/billing.js';
import { grantCreditPurchase, grantSubscriptionPeriod } from '../creditGrants.js';
import { getOrCreateUserCredits, DEFAULT_FREE_CREDITS } from '../userCredits.js';
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

/** The paid balance for one user. Scoped to an id this file owns. */
async function paidBalance(oxyUserId: string): Promise<number> {
  const rows = await db
    .select({ paid: userCredits.creditsPaid })
    .from(userCredits)
    .where(eq(userCredits.id, oxyUserId));
  return rows[0]?.paid ?? 0;
}

/** Ledger rows for one user. */
async function ledgerRows(oxyUserId: string): Promise<number> {
  const rows = await db.execute(
    sql`select count(*)::int as n from ${transactions} where ${transactions.oxyUserId} = ${oxyUserId}`,
  );
  return Number(rows[0]?.n ?? 0);
}

async function seedUser(label: string): Promise<string> {
  const userId = testScope(label);
  await getOrCreateUserCredits(db, userId);
  return userId;
}

describe('grantCreditPurchase', () => {
  it('grants the purchased credits exactly once', async () => {
    const userId = await seedUser('grant-buy');
    const before = await paidBalance(userId);

    const row = await grantCreditPurchase(db, {
      oxyUserId: userId,
      stripePaymentIntentId: `pi_${userId}`,
      amount: 1000,
      currency: 'usd',
      credits: 100,
    });

    expect(row).not.toBeNull();
    // EXACTLY 100. `toBeGreaterThan(before)` is the assertion that let a double
    // grant through on the sibling path.
    expect((await paidBalance(userId)) - before).toBe(100);
    expect(await ledgerRows(userId)).toBe(1);
  });

  it('grants nothing on a redelivered payment intent', async () => {
    const userId = await seedUser('grant-buy-dup');
    const values = {
      oxyUserId: userId,
      stripePaymentIntentId: `pi_${userId}`,
      amount: 1000,
      currency: 'usd',
      credits: 100,
    };

    const before = await paidBalance(userId);
    expect(await grantCreditPurchase(db, values)).not.toBeNull();
    const afterFirst = await paidBalance(userId);
    expect(await grantCreditPurchase(db, values)).toBeNull();
    const afterSecond = await paidBalance(userId);

    expect(afterFirst - before).toBe(100);
    // The redelivery moves the balance by ZERO — not "by less", not "not much".
    expect(afterSecond - afterFirst).toBe(0);
    expect(await ledgerRows(userId)).toBe(1);
  });

  it('leaves the free balance alone — a purchase is paid credit', async () => {
    const userId = await seedUser('grant-buy-free');

    await grantCreditPurchase(db, {
      oxyUserId: userId,
      stripePaymentIntentId: `pi_${userId}`,
      amount: 1000,
      currency: 'usd',
      credits: 100,
    });

    const rows = await db
      .select({ free: userCredits.creditsFree })
      .from(userCredits)
      .where(eq(userCredits.id, userId));
    expect(rows[0]?.free).toBe(DEFAULT_FREE_CREDITS);
  });
});

describe('grantSubscriptionPeriod', () => {
  /** The exact case the double grant broke. */
  it('grants one period of credits exactly once', async () => {
    const userId = await seedUser('grant-sub');
    const before = await paidBalance(userId);

    const row = await grantSubscriptionPeriod(db, {
      oxyUserId: userId,
      amount: 2000,
      currency: 'usd',
      credits: 500,
      dedup: `sub_${userId}_p1`,
    });

    expect(row).not.toBeNull();
    expect((await paidBalance(userId)) - before).toBe(500);
    expect(await ledgerRows(userId)).toBe(1);
  });

  it('grants nothing on a redelivered period', async () => {
    const userId = await seedUser('grant-sub-dup');
    const values = {
      oxyUserId: userId,
      amount: 2000,
      currency: 'usd',
      credits: 500,
      dedup: `sub_${userId}_p1`,
    };

    const before = await paidBalance(userId);
    expect(await grantSubscriptionPeriod(db, values)).not.toBeNull();
    const afterFirst = await paidBalance(userId);
    expect(await grantSubscriptionPeriod(db, values)).toBeNull();

    expect(afterFirst - before).toBe(500);
    expect((await paidBalance(userId)) - afterFirst).toBe(0);
    expect(await ledgerRows(userId)).toBe(1);
  });

  /**
   * The negative control for the test above: the NEXT period carries a
   * different dedup key and must grant again. Without it, an implementation
   * that refused every grant after the first would look correct.
   */
  it('grants the next period, which carries a different dedup key', async () => {
    const userId = await seedUser('grant-sub-two');
    const base = { oxyUserId: userId, amount: 2000, currency: 'usd', credits: 500 };
    const before = await paidBalance(userId);

    await grantSubscriptionPeriod(db, { ...base, dedup: `sub_${userId}_p1` });
    await grantSubscriptionPeriod(db, { ...base, dedup: `sub_${userId}_p2` });

    // Two periods, two grants, 1000 — and this figure is what tells a correct
    // implementation from one that grants twice per delivery: a doubling bug
    // reads 2000 here.
    expect((await paidBalance(userId)) - before).toBe(1000);
    expect(await ledgerRows(userId)).toBe(2);
  });
});

describe('the ledger row and the grant commit together', () => {
  /**
   * The grant is refused because the balance row is gone. The ledger row must
   * roll back with it, so Stripe's retry finds nothing and can re-run the
   * purchase rather than be told it was already processed.
   */
  it('rolls the ledger row back when the balance row has vanished', async () => {
    const userId = testScope('grant-vanished'); // deliberately NOT seeded
    const paymentIntent = `pi_${userId}`;

    await expect(
      grantCreditPurchase(db, {
        oxyUserId: userId,
        stripePaymentIntentId: paymentIntent,
        amount: 1000,
        currency: 'usd',
        credits: 100,
      }),
    ).rejects.toThrow(/vanished before the grant/u);

    expect(await ledgerRows(userId)).toBe(0);

    // And the retry, once the row exists, succeeds and grants exactly once.
    await getOrCreateUserCredits(db, userId);
    const before = await paidBalance(userId);
    const retry = await grantCreditPurchase(db, {
      oxyUserId: userId,
      stripePaymentIntentId: paymentIntent,
      amount: 1000,
      currency: 'usd',
      credits: 100,
    });

    expect(retry).not.toBeNull();
    expect((await paidBalance(userId)) - before).toBe(100);
    expect(await ledgerRows(userId)).toBe(1);
  });
});
