import { eq } from 'drizzle-orm';
import { afterAll, describe, expect, it } from 'vitest';
import { SUBSCRIPTION_STATUSES, subscriptions } from '../../db/schema/billing.js';
import {
  countSubscriptions,
  findLiveSubscription,
  findNewestLiveSubscription,
  listLiveSubscriptions,
  listSubscriptionsByUser,
  setCancelAtPeriodEnd,
  updateSubscriptionPlan,
  updateSubscriptionStatus,
  upsertSubscriptionFromStripe,
} from '../subscriptions.js';
import { closeTestDb, testDb, testUserId } from './testDatabase.js';

const db = testDb();

afterAll(closeTestDb);

function stripeValues(userId: string, overrides: Record<string, unknown> = {}) {
  return {
    oxyUserId: userId,
    stripeCustomerId: `cus_${userId}`,
    stripeSubscriptionId: `sub_${userId}`,
    stripePriceId: 'price_1',
    status: 'active',
    currentPeriodStart: new Date(Date.now() - 86_400_000),
    currentPeriodEnd: new Date(Date.now() + 86_400_000 * 29),
    cancelAtPeriodEnd: false,
    planId: 'pro',
    billingPeriod: 'monthly',
    planPlanId: 'pro',
    planName: 'Pro',
    planProduct: 'clarity',
    planCreditsPerMonth: 5000,
    planPrice: 2000,
    planCurrency: 'usd',
    planBillingPeriod: 'monthly',
    ...overrides,
  };
}

describe('upsertSubscriptionFromStripe', () => {
  it('inserts on first delivery', async () => {
    const userId = testUserId('sub-new');

    const row = await upsertSubscriptionFromStripe(db, stripeValues(userId));

    expect(row.status).toBe('active');
    expect(row.planName).toBe('Pro');
    expect(row.planCreditsPerMonth).toBe(5000);
  });

  /**
   * The redelivery. The row is UPDATED in place — same id — and `createdAt`
   * survives. A conflict clause that reset `createdAt` would make every
   * subscription look newly created on each webhook, and `getUserTier` sorts
   * on exactly that column.
   */
  it('updates in place on redelivery, preserving id and createdAt', async () => {
    const userId = testUserId('sub-redeliver');

    const first = await upsertSubscriptionFromStripe(db, stripeValues(userId));
    const second = await upsertSubscriptionFromStripe(
      db,
      stripeValues(userId, { status: 'past_due', planPrice: 2500 }),
    );

    expect(second.id).toBe(first.id);
    expect(second.createdAt.getTime()).toBe(first.createdAt.getTime());
    expect(second.status).toBe('past_due');
    expect(second.planPrice).toBe(2500);

    const all = await db
      .select()
      .from(subscriptions)
      .where(eq(subscriptions.oxyUserId, userId));
    expect(all).toHaveLength(1);
  });

  /**
   * The column names in the conflict-update set must be the SQL identifiers.
   * Interpolating a drizzle column object into an `excluded.` reference emits
   * the JavaScript property name, so `excluded.currentPeriodEnd` becomes
   * `excluded.currentperiodend` and fails with 42703 — which is why the set
   * clause is built from bound values instead. This asserts a camelCase column
   * really does round-trip through the update branch.
   */
  it('updates camelCase columns through the conflict branch', async () => {
    const userId = testUserId('sub-camel');
    const laterEnd = new Date(Date.now() + 86_400_000 * 60);

    await upsertSubscriptionFromStripe(db, stripeValues(userId));
    const updated = await upsertSubscriptionFromStripe(
      db,
      stripeValues(userId, { currentPeriodEnd: laterEnd, cancelAtPeriodEnd: true }),
    );

    expect(updated.currentPeriodEnd.getTime()).toBe(laterEnd.getTime());
    expect(updated.cancelAtPeriodEnd).toBe(true);
  });
});

/**
 * ## `paused` — the value the Mongoose enum omits
 *
 * The webhook writes `status: stripeSubscription.status` through
 * `findOneAndUpdate`, which runs no validators, so the enum has never been
 * enforced on that path. Stripe's own union carries eight statuses; the
 * Mongoose enum lists seven.
 *
 * Had the CHECK been built from the Mongoose enum alone, a genuinely paused
 * subscription would be REFUSED — turning a routine webhook into a 500 and a
 * Stripe retry storm, for a status that stores fine today.
 */
describe('subscription status CHECK', () => {
  it('accepts every status Stripe can send, including paused', async () => {
    for (const status of SUBSCRIPTION_STATUSES) {
      const userId = testUserId(`sub-status-${status}`);
      const row = await upsertSubscriptionFromStripe(db, stripeValues(userId, { status }));
      expect(row.status).toBe(status);
    }
  });

  it('refuses a status outside the set', async () => {
    const userId = testUserId('sub-bad-status');
    await expect(
      upsertSubscriptionFromStripe(db, stripeValues(userId, { status: 'expired' })),
    ).rejects.toThrow();
  });
});

/**
 * The plan snapshot columns are NULLABLE on purpose. Mongoose marks `name`,
 * `creditsPerMonth` and `price` as `required`, but that validator is live only
 * on the `save()` path — the webhook upsert skips it, and there `price` is
 * `isAnnual ? plan.annualPrice : plan.monthlyPrice`, which is `undefined` for a
 * plan with no annual price.
 *
 * NOT NULL would throw inside a Stripe webhook, so a customer who has paid gets
 * no subscription row at all. This asserts that cannot happen.
 */
describe('a subscription with an incomplete plan snapshot', () => {
  it('is accepted rather than throwing inside the webhook', async () => {
    const userId = testUserId('sub-nullplan');

    const row = await upsertSubscriptionFromStripe(
      db,
      stripeValues(userId, {
        planName: null,
        planPrice: null,
        planCreditsPerMonth: null,
        planProduct: null,
        planBillingPeriod: null,
      }),
    );

    expect(row.planPrice).toBeNull();
    expect(row.planName).toBeNull();
  });

  /**
   * And the nullable CHECKs must admit NULL rather than rejecting it. A bare
   * `in (...)` against NULL is NULL, which a CHECK does not reject — this
   * pins the behaviour so a later reader does not "tighten" it into something
   * that refuses the legitimate absent case.
   */
  it('still refuses a non-null product outside the set', async () => {
    const userId = testUserId('sub-badproduct');
    await expect(
      upsertSubscriptionFromStripe(db, stripeValues(userId, { planProduct: 'nonsense' })),
    ).rejects.toThrow();
  });
});

describe('lookups', () => {
  it('finds a live subscription and ignores a canceled one', async () => {
    const userId = testUserId('sub-live');
    await upsertSubscriptionFromStripe(db, stripeValues(userId, { status: 'canceled' }));

    expect(await findLiveSubscription(db, userId)).toBeNull();

    await upsertSubscriptionFromStripe(db, stripeValues(userId, { status: 'trialing' }));

    expect((await findLiveSubscription(db, userId))?.status).toBe('trialing');
  });

  it('narrows by product', async () => {
    const userId = testUserId('sub-product');
    await upsertSubscriptionFromStripe(
      db,
      stripeValues(userId, {
        stripeSubscriptionId: `sub_${userId}_codea`,
        planProduct: 'codea',
      }),
    );

    expect(await findLiveSubscription(db, userId, 'clarity')).toBeNull();
    expect((await findLiveSubscription(db, userId, 'codea'))?.planProduct).toBe('codea');
  });

  /**
   * `getUserTier` takes the NEWEST live subscription. Asserted with EXPLICIT
   * timestamps: the primary key is a uuid v7 and is not monotonic within a
   * millisecond, so two rows written in a loop carry no reliable order.
   */
  it('returns the newest live subscription for tier resolution', async () => {
    const userId = testUserId('sub-newest');
    await db.insert(subscriptions).values([
      {
        ...stripeValues(userId, { stripeSubscriptionId: `sub_${userId}_old`, planName: 'Pro' }),
        createdAt: new Date(Date.now() - 90_000),
      },
      {
        ...stripeValues(userId, {
          stripeSubscriptionId: `sub_${userId}_new`,
          planName: 'Enterprise',
        }),
        createdAt: new Date(Date.now() - 10_000),
      },
    ]);

    expect((await findNewestLiveSubscription(db, userId))?.planName).toBe('Enterprise');
  });

  it('lists every live subscription for entitlement resolution', async () => {
    const userId = testUserId('sub-entitle');
    await db.insert(subscriptions).values([
      stripeValues(userId, { stripeSubscriptionId: `sub_${userId}_a`, planPlanId: 'pro' }),
      stripeValues(userId, {
        stripeSubscriptionId: `sub_${userId}_b`,
        planPlanId: 'codea',
        planProduct: 'codea',
      }),
      stripeValues(userId, { stripeSubscriptionId: `sub_${userId}_c`, status: 'canceled' }),
    ]);

    const live = await listLiveSubscriptions(db, userId);

    expect(live).toHaveLength(2);
    expect(live.map((s) => s.planPlanId).sort()).toEqual(['codea', 'pro']);
  });

  it('lists a user history including canceled subscriptions', async () => {
    const userId = testUserId('sub-history');
    await upsertSubscriptionFromStripe(db, stripeValues(userId, { status: 'canceled' }));

    expect(await listSubscriptionsByUser(db, userId)).toHaveLength(1);
  });
});

describe('updates', () => {
  it('marks a subscription for cancellation at period end', async () => {
    const userId = testUserId('sub-cancel');
    const row = await upsertSubscriptionFromStripe(db, stripeValues(userId));

    const updated = await setCancelAtPeriodEnd(db, row.id, true);

    expect(updated?.cancelAtPeriodEnd).toBe(true);
  });

  it('updates status by stripe subscription id and returns the row', async () => {
    const userId = testUserId('sub-status-update');
    await upsertSubscriptionFromStripe(db, stripeValues(userId));

    const updated = await updateSubscriptionStatus(db, `sub_${userId}`, 'canceled');

    expect(updated?.status).toBe('canceled');
    // The caller reads `oxyUserId` off this result to invalidate a cache. The
    // update does not touch that column, so the before/after difference between
    // Mongoose's default and RETURNING does not reach the caller.
    expect(updated?.oxyUserId).toBe(userId);
  });

  /**
   * Mongo returned a null document for "no such subscription"; `RETURNING`
   * yields zero rows. Both mean not-found, and the caller's `sub?.oxyUserId`
   * guard works unchanged — but only if this returns null rather than throwing.
   */
  it('returns null when no subscription carries that stripe id', async () => {
    expect(await updateSubscriptionStatus(db, `sub_${testUserId('nope')}`, 'canceled')).toBeNull();
  });

  it('rewrites the whole plan snapshot in one statement', async () => {
    const userId = testUserId('sub-changeplan');
    const row = await upsertSubscriptionFromStripe(db, stripeValues(userId));

    const updated = await updateSubscriptionPlan(db, row.id, {
      planId: 'enterprise',
      billingPeriod: 'annual',
      cancelAtPeriodEnd: false,
      stripePriceId: 'price_enterprise_annual',
      planPlanId: 'enterprise',
      planName: 'Enterprise',
      planProduct: 'clarity',
      planCreditsPerMonth: 100000,
      planPrice: 120000,
      planCurrency: 'usd',
      planBillingPeriod: 'annual',
    });

    expect(updated?.planName).toBe('Enterprise');
    expect(updated?.planPrice).toBe(120000);
    expect(updated?.billingPeriod).toBe('annual');
  });
});

describe('counts are numbers, not strings', () => {
  it('countSubscriptions adds rather than concatenating', async () => {
    const userId = testUserId('sub-count');
    await db.insert(subscriptions).values([
      stripeValues(userId, { stripeSubscriptionId: `sub_${userId}_1` }),
      stripeValues(userId, { stripeSubscriptionId: `sub_${userId}_2` }),
    ]);

    const total = await countSubscriptions(db, { oxyUserId: userId });

    expect(typeof total).toBe('number');
    expect(total + 1).toBe(3);
  });
});
