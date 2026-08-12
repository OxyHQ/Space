/**
 * The plan-to-feature junction — every query
 * `internal/providers/routes/plan-features.ts`, `lib/broadcast-helpers.ts`,
 * `lib/seed-features.ts` and `lib/gateway-client.ts` (via `await import` at
 * line 488) perform against the `PlanFeature` model.
 *
 * `planId` and `featureId` are plain strings with no foreign keys, matching the
 * source — see the note on the table itself for why adding them would be
 * inventing an invariant rather than making one structural.
 */

import { and, asc, eq, getTableColumns, sql } from 'drizzle-orm';
import type { StationDatabase } from '../db/client.js';
import { planFeatures } from '../db/schema/providers.js';

export type PlanFeatureRow = typeof planFeatures.$inferSelect;
export type NewPlanFeature = typeof planFeatures.$inferInsert;

/** One mapping as the matrix editor and the seed both supply it. */
export interface PlanFeatureUpsert {
  readonly planId: string;
  readonly featureId: string;
  readonly enabled?: boolean;
  readonly limitValue?: number | null;
  readonly displayLabel?: string | null;
  readonly displayDescription?: string | null;
}

/** `routes/plan-features.ts:25` and `:42`, `lib/gateway-client.ts:491`. */
export async function listMappings(
  db: StationDatabase,
  filter: { planId?: string } = {},
): Promise<PlanFeatureRow[]> {
  return db
    .select()
    .from(planFeatures)
    .where(filter.planId !== undefined ? eq(planFeatures.planId, filter.planId) : undefined)
    .orderBy(asc(planFeatures.planId), asc(planFeatures.featureId));
}

/** One mapping, for a caller that wants to read back what it just wrote. */
export async function findMapping(
  db: StationDatabase,
  planId: string,
  featureId: string,
): Promise<PlanFeatureRow | null> {
  const [row] = await db
    .select()
    .from(planFeatures)
    .where(and(eq(planFeatures.planId, planId), eq(planFeatures.featureId, featureId)));
  return row ?? null;
}

/**
 * `routes/plan-features.ts:74` — `PUT /:planId/:featureId`.
 *
 * ## This is the sharpest `$set: { x: undefined }` case in the domain
 *
 * The route destructures four fields off `req.body` and puts all four into
 * `$set`, so a request that mentions only `enabled` sends
 * `{ enabled: true, limitValue: undefined, displayLabel: undefined,
 * displayDescription: undefined }`. Mongoose strips undefined from updates, so
 * the other three keep their stored values. The same statement in Postgres
 * writes three NULLs and ERASES a feature's limit and its display overrides —
 * silently, with a 200, and the matrix editor would show them blank on the next
 * load.
 *
 * `undefined` is filtered out of the SET clause here (drizzle's `mapUpdateSet`,
 * pinned by a test). An explicit `null` still clears, because that is a caller
 * saying "remove the override" and Mongo does the same.
 *
 * On INSERT the distinction disappears — an absent column takes its default,
 * which for all three is NULL — so only the conflict branch needs the care.
 */
export async function upsertMapping(
  db: StationDatabase,
  mapping: PlanFeatureUpsert,
): Promise<PlanFeatureRow> {
  const { row } = await upsertOne(db, mapping);
  return row;
}

/**
 * One upsert, reporting whether it inserted.
 *
 * `RETURNING (xmax = 0)` is the only way to tell an inserted row from an
 * updated one inside a single statement, and it is the direct equivalent of
 * Mongo's `upsertedCount`.
 */
async function upsertOne(
  db: StationDatabase,
  mapping: PlanFeatureUpsert,
): Promise<{ row: PlanFeatureRow; inserted: boolean }> {
  const update: Partial<NewPlanFeature> = {
    enabled: mapping.enabled ?? true,
    limitValue: mapping.limitValue,
    displayLabel: mapping.displayLabel,
    displayDescription: mapping.displayDescription,
  };

  const [row] = await db
    .insert(planFeatures)
    .values({ planId: mapping.planId, featureId: mapping.featureId, ...update })
    .onConflictDoUpdate({
      target: [planFeatures.planId, planFeatures.featureId],
      set: update,
    })
    .returning({ ...getTableColumns(planFeatures), inserted: sql<boolean>`(xmax = 0)` });

  const { inserted, ...rest } = row;
  return { row: rest, inserted };
}

/**
 * `routes/plan-features.ts:122` — the matrix editor's "Save All".
 *
 * ## Deliberately N statements in one transaction, not one batched statement
 *
 * The obvious port is a multi-row `INSERT ... ON CONFLICT DO UPDATE SET
 * limit_value = excluded.limit_value`, and it is WRONG in the direction that
 * loses data. Inside `excluded`, a field the caller omitted and a field the
 * caller explicitly cleared are the same NULL — so the batched form erases
 * every limit and display override the editor did not resend, exactly the
 * behaviour {@link upsertMapping}'s note exists to prevent. Per-row upserts keep
 * the distinction, because drizzle drops an `undefined` from the SET clause and
 * keeps an explicit `null`.
 *
 * The transaction is what replaces Mongo's `bulkWrite` batch: a half-applied
 * matrix is a pricing page that disagrees with itself, and the single
 * `upserted`/`modified` pair the editor displays would be a lie about a partial
 * write.
 */
export async function bulkUpsertMappings(
  db: StationDatabase,
  mappings: readonly PlanFeatureUpsert[],
): Promise<{ upserted: number; modified: number; total: number }> {
  if (mappings.length === 0) return { upserted: 0, modified: 0, total: 0 };

  return db.transaction(async (tx) => {
    let upserted = 0;
    for (const mapping of mappings) {
      const { inserted } = await upsertOne(tx, mapping);
      if (inserted) upserted += 1;
    }
    return { upserted, modified: mappings.length - upserted, total: mappings.length };
  });
}

/**
 * `seed-features.ts:283` — the seed's `$setOnInsert`-only bulk upsert.
 *
 * Separate from {@link bulkUpsertMappings} because the seed must NOT overwrite a
 * mapping an operator has since edited: its update document contains only
 * `$setOnInsert`, so an existing row is left exactly as it is. That is
 * `ON CONFLICT DO NOTHING`, and collapsing the two would quietly revert every
 * hand-made change on the next boot.
 */
export async function seedMappings(
  db: StationDatabase,
  mappings: readonly PlanFeatureUpsert[],
): Promise<number> {
  if (mappings.length === 0) return 0;

  const inserted = await db
    .insert(planFeatures)
    .values(
      mappings.map((mapping) => ({
        planId: mapping.planId,
        featureId: mapping.featureId,
        enabled: mapping.enabled ?? true,
        limitValue: mapping.limitValue,
        displayLabel: mapping.displayLabel,
        displayDescription: mapping.displayDescription,
      })),
    )
    .onConflictDoNothing({ target: [planFeatures.planId, planFeatures.featureId] })
    .returning({ id: planFeatures.id });
  return inserted.length;
}

/** `routes/plan-features.ts:144`. */
export async function deleteMapping(
  db: StationDatabase,
  planId: string,
  featureId: string,
): Promise<PlanFeatureRow | null> {
  const [row] = await db
    .delete(planFeatures)
    .where(and(eq(planFeatures.planId, planId), eq(planFeatures.featureId, featureId)))
    .returning();
  return row ?? null;
}
