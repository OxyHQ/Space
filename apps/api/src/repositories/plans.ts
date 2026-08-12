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

import { and, asc, eq, sql } from 'drizzle-orm';
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
 * `seed-plans.ts:165` — insert a plan, and re-sync the one field the seed owns.
 *
 * ## The seed's update is NOT pure `$setOnInsert`, and the difference matters
 *
 * It carries `$set: { modelIds }` as well, under the comment "Always sync
 * modelIds from seed (code-managed)" — every other column is admin-managed and
 * written only on insert. So this is `ON CONFLICT DO UPDATE` over exactly one
 * column, not `DO NOTHING`: the latter reads correctly, passes every test, and
 * silently ends the code-managed half of the seed's contract, so a plan whose
 * model list changes in the source would keep serving the old list forever.
 *
 * Nothing else may enter that `set` — `excluded` would carry the seed's
 * defaults for the seventeen columns an operator is expected to have edited by
 * hand, and re-running the seed would revert every one of them.
 *
 * `RETURNING (xmax = 0)` rather than an empty result, because `DO UPDATE`
 * always returns a row: it is the only way to tell an inserted row from an
 * updated one in a single statement, and it is what `upsertedCount` meant.
 *
 * Either way this removes the source's `isDuplicateKeyError` catch, which on
 * Postgres would be worse than useless: an exception cannot tell a duplicate
 * from a dropped connection, so a naive port would answer "already seeded" to
 * an infrastructure failure. Here no statement fails, so a real failure still
 * propagates.
 */
export async function seedPlan(db: PgHandle, values: NewPlan): Promise<boolean> {
  const [row] = await db
    .insert(plans)
    .values({ ...values, planId: values.planId.toLowerCase() })
    .onConflictDoUpdate({
      target: plans.planId,
      set: { modelIds: values.modelIds },
    })
    .returning({ inserted: sql<boolean>`(xmax = 0)` });
  return row.inserted;
}
