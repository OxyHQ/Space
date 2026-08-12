/**
 * Subscription plans — every query `internal/providers/routes/plans.ts`,
 * `routes/plan-features.ts`, `lib/broadcast-helpers.ts`, `lib/seed-plans.ts`
 * and `lib/gateway-client.ts` (via `await import`) perform against the `Plan`
 * model.
 *
 * `gateway-client.ts` reaches this model through `await import(...)` at lines
 * 462 and 498, which no static import census sees. Both are covered here:
 * {@link listPlans} and {@link patchPlan}.
 */

import { and, asc, eq } from 'drizzle-orm';
import type { PgHandle } from './handle.js';
import { plans } from '../db/schema/providers.js';

export type PlanRow = typeof plans.$inferSelect;
export type NewPlan = typeof plans.$inferInsert;

/** See `clarity-models.ts`'s `matchesSlug` — the `lowercase: true` setter, ported. */
function matchesSlug(value: string) {
  return eq(plans.planId, value.toLowerCase());
}

/**
 * `routes/plans.ts:26`, `routes/plan-features.ts:41`,
 * `lib/broadcast-helpers.ts:55`, `lib/gateway-client.ts:462`.
 *
 * `sortOrder` is not unique within a product, so `planId` breaks the tie.
 */
export async function listPlans(
  db: PgHandle,
  filter: { product?: string; isActive?: boolean } = {},
): Promise<PlanRow[]> {
  const conditions = [];
  if (filter.product !== undefined) conditions.push(eq(plans.product, filter.product));
  if (filter.isActive !== undefined) conditions.push(eq(plans.isActive, filter.isActive));

  return db
    .select()
    .from(plans)
    .where(conditions.length > 0 ? and(...conditions) : undefined)
    .orderBy(asc(plans.product), asc(plans.sortOrder), asc(plans.planId));
}

/** `routes/plans.ts:50` and `:108`. */
export async function findBySlug(db: PgHandle, planId: string): Promise<PlanRow | null> {
  const [row] = await db.select().from(plans).where(matchesSlug(planId));
  return row ?? null;
}

/** `routes/plans.ts:130`. */
export async function createPlan(db: PgHandle, values: NewPlan): Promise<PlanRow> {
  const [row] = await db.insert(plans)
    .values({ ...values, planId: values.planId.toLowerCase() })
    .returning();
  return row;
}

/**
 * `routes/plans.ts:200` and `lib/gateway-client.ts:498`.
 *
 * `gateway-client.updatePlan` exists to persist auto-created Stripe price ids,
 * so it patches two or three columns out of twenty. `undefined` never reaches
 * the SET clause, which is what keeps that from blanking the other seventeen.
 */
export async function patchPlan(
  db: PgHandle,
  planId: string,
  patch: Partial<Omit<NewPlan, 'id' | 'planId' | 'createdAt'>>,
): Promise<PlanRow | null> {
  if (Object.values(patch).every((value) => value === undefined)) {
    return findBySlug(db, planId);
  }
  const [row] = await db.update(plans).set(patch).where(matchesSlug(planId)).returning();
  return row ?? null;
}

/** `routes/plans.ts:238`. */
export async function deletePlan(db: PgHandle, planId: string): Promise<PlanRow | null> {
  const [row] = await db.delete(plans).where(matchesSlug(planId)).returning();
  return row ?? null;
}

/**
 * `seed-plans.ts:165` — insert a plan only if it does not exist.
 *
 * Pure `$setOnInsert`, so this is `ON CONFLICT DO NOTHING`. That also removes
 * the source's `isDuplicateKeyError` catch, which on Postgres would be worse
 * than useless: an exception cannot tell a duplicate from a dropped connection,
 * so a naive port would answer "already seeded" to an infrastructure failure.
 * With `DO NOTHING RETURNING`, an empty result IS the answer and a real failure
 * still propagates.
 */
export async function seedPlan(db: PgHandle, values: NewPlan): Promise<boolean> {
  const inserted = await db
    .insert(plans)
    .values({ ...values, planId: values.planId.toLowerCase() })
    .onConflictDoNothing({ target: plans.planId })
    .returning({ id: plans.id });
  return inserted.length > 0;
}
