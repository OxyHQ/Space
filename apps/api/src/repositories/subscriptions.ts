/**
 * Subscriptions — the Stripe subscription mirror, and the source of a user's
 * plan entitlements and rate-limit tier.
 */

import { and, desc, eq, inArray, sql, type SQL } from 'drizzle-orm';
import type { StationDatabase } from '../db/client.js';
import { subscriptions } from '../db/schema/billing.js';

export type SubscriptionRow = typeof subscriptions.$inferSelect;

/**
 * The statuses every "is this subscription live" query filters on —
 * `{ status: { $in: ['active', 'trialing'] } }`, repeated at
 * `routes/billing.ts:335`, `:384`, `:401`, `:435`,
 * `middleware/api-key-rate-limit.ts:81` and `lib/plan-access.ts:27`.
 *
 * Named once because six copies of a literal array is six places for a
 * seventh status to be forgotten.
 */
export const LIVE_SUBSCRIPTION_STATUSES = ['active', 'trialing'] as const;

/**
 * `routes/billing.ts:332` and `:389` — the user's live subscription,
 * optionally narrowed to one product.
 *
 * `product` filters on `planProduct`, which is the flattened `plan.product`
 * the Mongo query reached as `'plan.product'`.
 */
export async function findLiveSubscription(
  db: StationDatabase,
  oxyUserId: string,
  product?: string,
): Promise<SubscriptionRow | null> {
  const clauses: SQL[] = [
    eq(subscriptions.oxyUserId, oxyUserId),
    inArray(subscriptions.status, [...LIVE_SUBSCRIPTION_STATUSES]),
  ];
  if (product !== undefined) clauses.push(eq(subscriptions.planProduct, product));

  const rows = await db
    .select()
    .from(subscriptions)
    .where(and(...clauses))
    .limit(1);
  return rows[0] ?? null;
}

/**
 * `middleware/api-key-rate-limit.ts:79` — `getUserTier`'s lookup, which sorts
 * `{ createdAt: -1 }` and takes the newest.
 *
 * The sort is not decoration: a user with two live subscriptions gets the tier
 * of the most recent one, and dropping the ordering would hand back an
 * arbitrary row. `id` breaks same-millisecond ties for the reason given in
 * `transactions.ts`.
 */
export async function findNewestLiveSubscription(
  db: StationDatabase,
  oxyUserId: string,
): Promise<SubscriptionRow | null> {
  const rows = await db
    .select()
    .from(subscriptions)
    .where(
      and(
        eq(subscriptions.oxyUserId, oxyUserId),
        inArray(subscriptions.status, [...LIVE_SUBSCRIPTION_STATUSES]),
      ),
    )
    .orderBy(desc(subscriptions.createdAt), desc(subscriptions.id))
    .limit(1);
  return rows[0] ?? null;
}

/** `lib/plan-access.ts:25` — every live subscription, for entitlement resolution. */
export async function listLiveSubscriptions(
  db: StationDatabase,
  oxyUserId: string,
): Promise<SubscriptionRow[]> {
  return db
    .select()
    .from(subscriptions)
    .where(
      and(
        eq(subscriptions.oxyUserId, oxyUserId),
        inArray(subscriptions.status, [...LIVE_SUBSCRIPTION_STATUSES]),
      ),
    );
}

/**
 * `routes/billing.ts:695` — the Stripe webhook's upsert, keyed on
 * `stripeSubscriptionId`.
 *
 * `ON CONFLICT ... DO UPDATE` on the NAMED unique index, with the update set
 * built from the same bound values as the insert rather than from
 * `excluded.*`. Deliberate: interpolating a drizzle column object into an
 * `excluded.` reference emits the JavaScript PROPERTY name, so
 * `excluded.currentPeriodEnd` would become `excluded.currentperiodend` and
 * fail at runtime with 42703. Passing the values twice cannot get that wrong.
 *
 * `createdAt` is left out of the update set so the original creation time
 * survives a webhook redelivery; `updatedAt` is stamped explicitly because
 * drizzle's `$onUpdate` fires for `db.update()`, not for the update branch of
 * an insert.
 */
export async function upsertSubscriptionFromStripe(
  db: StationDatabase,
  values: {
    oxyUserId: string;
    stripeCustomerId: string;
    stripeSubscriptionId: string;
    stripePriceId: string;
    status: string;
    currentPeriodStart: Date;
    currentPeriodEnd: Date;
    cancelAtPeriodEnd: boolean;
    planId?: string | null;
    billingPeriod: string;
    planPlanId?: string | null;
    planName?: string | null;
    planProduct?: string | null;
    planCreditsPerMonth?: number | null;
    planPrice?: number | null;
    planCurrency?: string | null;
    planBillingPeriod?: string | null;
  },
): Promise<SubscriptionRow> {
  const rows = await db
    .insert(subscriptions)
    .values(values)
    .onConflictDoUpdate({
      target: subscriptions.stripeSubscriptionId,
      set: {
        oxyUserId: values.oxyUserId,
        stripeCustomerId: values.stripeCustomerId,
        stripePriceId: values.stripePriceId,
        status: values.status,
        currentPeriodStart: values.currentPeriodStart,
        currentPeriodEnd: values.currentPeriodEnd,
        cancelAtPeriodEnd: values.cancelAtPeriodEnd,
        planId: values.planId ?? null,
        billingPeriod: values.billingPeriod,
        planPlanId: values.planPlanId ?? null,
        planName: values.planName ?? null,
        planProduct: values.planProduct ?? null,
        planCreditsPerMonth: values.planCreditsPerMonth ?? null,
        planPrice: values.planPrice ?? null,
        planCurrency: values.planCurrency ?? null,
        planBillingPeriod: values.planBillingPeriod ?? null,
        updatedAt: new Date(),
      },
    })
    .returning();
  if (!rows[0]) {
    throw new Error(`subscription upsert returned no row for ${values.stripeSubscriptionId}`);
  }
  return rows[0];
}

/**
 * `routes/billing.ts:744` (`status: 'canceled'`) and `:773`
 * (`status: 'past_due'`) — both `findOneAndUpdate` by Stripe subscription id.
 *
 * Mongoose's `findOneAndUpdate` defaults to returning the document BEFORE the
 * update, while `RETURNING` hands back the row after it. The one caller that
 * reads the result uses `sub?.oxyUserId` to invalidate a cache, and the update
 * does not touch `oxyUserId`, so the two spellings agree on the only field
 * consumed. Noted rather than assumed, because the difference would matter for
 * any field the update DOES write.
 *
 * Returns null when no subscription carries that id — the same "not found"
 * Mongo signalled with a null document.
 */
export async function updateSubscriptionStatus(
  db: StationDatabase,
  stripeSubscriptionId: string,
  status: string,
): Promise<SubscriptionRow | null> {
  const rows = await db
    .update(subscriptions)
    .set({ status })
    .where(eq(subscriptions.stripeSubscriptionId, stripeSubscriptionId))
    .returning();
  return rows[0] ?? null;
}

/** `routes/billing.ts:412` — `subscription.cancelAtPeriodEnd = true; save()`. */
export async function setCancelAtPeriodEnd(
  db: StationDatabase,
  id: string,
  cancelAtPeriodEnd: boolean,
): Promise<SubscriptionRow | null> {
  const rows = await db
    .update(subscriptions)
    .set({ cancelAtPeriodEnd })
    .where(eq(subscriptions.id, id))
    .returning();
  return rows[0] ?? null;
}

/**
 * `routes/billing.ts:500-513` — the change-plan write, which reassigns the
 * whole `plan` sub-document plus four top-level fields and then `save()`s.
 *
 * One `UPDATE`, because the source's `save()` was one document write: splitting
 * it would create a window where the row names the new plan at the old price.
 */
export async function updateSubscriptionPlan(
  db: StationDatabase,
  id: string,
  values: {
    planId: string;
    billingPeriod: string;
    cancelAtPeriodEnd: boolean;
    stripePriceId: string;
    planPlanId: string;
    planName: string;
    planProduct: string;
    planCreditsPerMonth: number;
    planPrice: number;
    planCurrency: string;
    planBillingPeriod: string;
  },
): Promise<SubscriptionRow | null> {
  const rows = await db
    .update(subscriptions)
    .set(values)
    .where(eq(subscriptions.id, id))
    .returning();
  return rows[0] ?? null;
}

/**
 * `billing-admin.ts:66` — the admin listing, filtered by an optional user,
 * status and/or PRODUCT.
 *
 * `product` filters `planProduct`, the flattened `'plan.product'` the admin
 * route's Mongo query reached. It was missing from this signature when the
 * repository was written; see the matching note in `transactions.ts` for why a
 * dropped filter clause is the dangerous direction.
 */
export async function listSubscriptions(
  db: StationDatabase,
  filter: SubscriptionFilter,
  options: { limit: number; offset: number },
): Promise<SubscriptionRow[]> {
  return db
    .select()
    .from(subscriptions)
    .where(subscriptionFilter(filter))
    .orderBy(desc(subscriptions.createdAt), desc(subscriptions.id))
    .limit(options.limit)
    .offset(options.offset);
}

/** Companion count — `billing-admin.ts:67`. `count(*)` is bigint; see below. */
export async function countSubscriptions(
  db: StationDatabase,
  filter: SubscriptionFilter,
): Promise<number> {
  const rows = await db
    .select({ total: sql<string>`count(*)` })
    .from(subscriptions)
    .where(subscriptionFilter(filter));
  return Number(rows[0]?.total ?? 0);
}

/** `billing-admin.ts:96` — every subscription a user has ever had, newest first. */
export async function listSubscriptionsByUser(
  db: StationDatabase,
  oxyUserId: string,
): Promise<SubscriptionRow[]> {
  return db
    .select()
    .from(subscriptions)
    .where(eq(subscriptions.oxyUserId, oxyUserId))
    .orderBy(desc(subscriptions.createdAt), desc(subscriptions.id));
}

export type SubscriptionFilter = { oxyUserId?: string; status?: string; product?: string };

/** See the note on `transactionFilter` — an absent key drops its clause. */
function subscriptionFilter(filter: SubscriptionFilter): SQL | undefined {
  const clauses: SQL[] = [];
  if (filter.oxyUserId !== undefined) clauses.push(eq(subscriptions.oxyUserId, filter.oxyUserId));
  if (filter.status !== undefined) clauses.push(eq(subscriptions.status, filter.status));
  if (filter.product !== undefined) clauses.push(eq(subscriptions.planProduct, filter.product));
  return clauses.length > 0 ? and(...clauses) : undefined;
}
