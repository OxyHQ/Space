/**
 * One-time credit packages — every query
 * `internal/providers/routes/credit-packages.ts`, `lib/broadcast-helpers.ts`,
 * `lib/seed-credit-packages.ts` and `lib/gateway-client.ts` (via `await import`
 * at line 470) perform against the `CreditPackage` model.
 */

import { asc, eq, sql } from 'drizzle-orm';
import type { StationDatabase } from '../db/client.js';
import { creditPackages } from '../db/schema/providers.js';

export type CreditPackageRow = typeof creditPackages.$inferSelect;
export type NewCreditPackage = typeof creditPackages.$inferInsert;

/** See the note on `clarity-models.ts`'s `matchesSlug` — the `lowercase` setter ported. */
function matchesSlug(value: string) {
  return sql`lower(${creditPackages.packageId}) = lower(${value})`;
}

/**
 * `routes/credit-packages.ts:24`, `lib/broadcast-helpers.ts:64`,
 * `lib/gateway-client.ts:473`.
 *
 * `sortOrder` is not unique, so `packageId` breaks the tie.
 */
export async function listPackages(
  db: StationDatabase,
  filter: { isActive?: boolean } = {},
): Promise<CreditPackageRow[]> {
  return db
    .select()
    .from(creditPackages)
    .where(filter.isActive !== undefined ? eq(creditPackages.isActive, filter.isActive) : undefined)
    .orderBy(asc(creditPackages.sortOrder), asc(creditPackages.packageId));
}

/** `routes/credit-packages.ts:48` and `:104`. */
export async function findBySlug(
  db: StationDatabase,
  packageId: string,
): Promise<CreditPackageRow | null> {
  const [row] = await db.select().from(creditPackages).where(matchesSlug(packageId));
  return row ?? null;
}

/** `routes/credit-packages.ts:113`. */
export async function createPackage(
  db: StationDatabase,
  values: NewCreditPackage,
): Promise<CreditPackageRow> {
  const [row] = await db.insert(creditPackages).values(values).returning();
  return row;
}

/** `routes/credit-packages.ts:166`. `undefined` never reaches the SET clause. */
export async function patchPackage(
  db: StationDatabase,
  packageId: string,
  patch: Partial<Omit<NewCreditPackage, 'id' | 'packageId' | 'createdAt'>>,
): Promise<CreditPackageRow | null> {
  if (Object.values(patch).every((value) => value === undefined)) {
    return findBySlug(db, packageId);
  }
  const [row] = await db
    .update(creditPackages)
    .set(patch)
    .where(matchesSlug(packageId))
    .returning();
  return row ?? null;
}

/** `routes/credit-packages.ts:204`. */
export async function deletePackage(
  db: StationDatabase,
  packageId: string,
): Promise<CreditPackageRow | null> {
  const [row] = await db.delete(creditPackages).where(matchesSlug(packageId)).returning();
  return row ?? null;
}

/** `seed-credit-packages.ts:35` — pure `$setOnInsert`. See `plans.ts`'s `seedPlan` for why. */
export async function seedPackage(
  db: StationDatabase,
  values: NewCreditPackage,
): Promise<boolean> {
  const inserted = await db
    .insert(creditPackages)
    .values(values)
    .onConflictDoNothing({ target: sql`lower(${creditPackages.packageId})` })
    .returning({ id: creditPackages.id });
  return inserted.length > 0;
}
