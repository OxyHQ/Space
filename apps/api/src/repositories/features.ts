/**
 * Canonical feature definitions — every query
 * `internal/providers/routes/features.ts`, `routes/plan-features.ts`,
 * `lib/broadcast-helpers.ts`, `lib/seed-features.ts` and `lib/gateway-client.ts`
 * (via `await import` at line 480) perform against the `Feature` model.
 */

import { and, asc, eq } from 'drizzle-orm';
import type { PgHandle } from './handle.js';
import { features } from '../db/schema/providers.js';

export type FeatureRow = typeof features.$inferSelect;
export type NewFeature = typeof features.$inferInsert;

/** See `clarity-models.ts`'s `matchesSlug` — the `lowercase: true` setter, ported. */
function matchesSlug(value: string) {
  return eq(features.featureId, value.toLowerCase());
}

/**
 * `routes/features.ts:23`, `routes/plan-features.ts:40`,
 * `lib/broadcast-helpers.ts:73`, `lib/gateway-client.ts:481`.
 *
 * `sortOrder` is not unique within a category, so `featureId` breaks the tie.
 */
export async function listFeatures(
  db: PgHandle,
  filter: { category?: string; isActive?: boolean } = {},
): Promise<FeatureRow[]> {
  const conditions = [];
  if (filter.category !== undefined) conditions.push(eq(features.category, filter.category));
  if (filter.isActive !== undefined) conditions.push(eq(features.isActive, filter.isActive));

  return db
    .select()
    .from(features)
    .where(conditions.length > 0 ? and(...conditions) : undefined)
    .orderBy(asc(features.category), asc(features.sortOrder), asc(features.featureId));
}

/** `routes/features.ts:36` and `:61`. */
export async function findBySlug(
  db: PgHandle,
  featureId: string,
): Promise<FeatureRow | null> {
  const [row] = await db.select().from(features).where(matchesSlug(featureId));
  return row ?? null;
}

/** `routes/features.ts:66`. */
export async function createFeature(db: PgHandle, values: NewFeature): Promise<FeatureRow> {
  const [row] = await db.insert(features)
    .values({ ...values, featureId: values.featureId.toLowerCase() })
    .returning();
  return row;
}

/** `routes/features.ts:94`. `undefined` never reaches the SET clause. */
export async function patchFeature(
  db: PgHandle,
  featureId: string,
  patch: Partial<Omit<NewFeature, 'id' | 'featureId' | 'createdAt'>>,
): Promise<FeatureRow | null> {
  if (Object.values(patch).every((value) => value === undefined)) {
    return findBySlug(db, featureId);
  }
  const [row] = await db.update(features).set(patch).where(matchesSlug(featureId)).returning();
  return row ?? null;
}

/** `routes/features.ts:117`. */
export async function deleteFeature(
  db: PgHandle,
  featureId: string,
): Promise<FeatureRow | null> {
  const [row] = await db.delete(features).where(matchesSlug(featureId)).returning();
  return row ?? null;
}

/** `seed-features.ts:249` — pure `$setOnInsert`. See `plans.ts`'s `seedPlan` for why. */
export async function seedFeature(db: PgHandle, values: NewFeature): Promise<boolean> {
  const inserted = await db
    .insert(features)
    .values({ ...values, featureId: values.featureId.toLowerCase() })
    .onConflictDoNothing({ target: features.featureId })
    .returning({ id: features.id });
  return inserted.length > 0;
}
