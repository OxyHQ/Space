/**
 * Concrete provider models — every query `internal/providers/routes/models.ts`,
 * `routes/clarity-models.ts`, `lib/broadcast-helpers.ts` and
 * `lib/seed-model-configs.ts` perform against the `ModelConfig` model.
 */

import { and, asc, eq, getTableColumns, sql } from 'drizzle-orm';
import type { StationDatabase } from '../db/client.js';
import { modelConfigs } from '../db/schema/providers.js';

export type ModelConfigRow = typeof modelConfigs.$inferSelect;
export type NewModelConfig = typeof modelConfigs.$inferInsert;

/**
 * `routes/models.ts:32` and `lib/broadcast-helpers.ts:34` — the admin listing.
 *
 * Both sort `{ provider: 1, priority: 1 }`. Unlike `ProviderKey`, `priority` IS
 * a real field here, so the sort ports directly — with `modelId` added as a
 * tiebreak, because `priority` is nullable and every model that has none would
 * otherwise come back in an arbitrary order within its provider.
 *
 * A null `priority` sorts LAST rather than first: ascending order puts NULLs
 * last in Postgres by default, and in Mongo a missing value sorts FIRST. That
 * difference is real and is chosen deliberately — a model with no priority is
 * one nobody ranked, and ranking it above every ranked model is the answer
 * nobody wants.
 */
export async function listModels(
  db: StationDatabase,
  filter: {
    provider?: string;
    clarityTier?: string;
    isActive?: boolean;
    isDeprecated?: boolean;
  } = {},
): Promise<ModelConfigRow[]> {
  const conditions = [];
  if (filter.provider !== undefined) conditions.push(eq(modelConfigs.provider, filter.provider));
  if (filter.clarityTier !== undefined) {
    conditions.push(eq(modelConfigs.clarityTier, filter.clarityTier));
  }
  if (filter.isActive !== undefined) conditions.push(eq(modelConfigs.isActive, filter.isActive));
  if (filter.isDeprecated !== undefined) {
    conditions.push(eq(modelConfigs.isDeprecated, filter.isDeprecated));
  }

  return db
    .select()
    .from(modelConfigs)
    .where(conditions.length > 0 ? and(...conditions) : undefined)
    .orderBy(asc(modelConfigs.provider), asc(modelConfigs.priority), asc(modelConfigs.modelId));
}

/** `routes/models.ts:57` — active, non-deprecated models for one Clarity tier. */
export async function listByTier(db: StationDatabase, tier: string): Promise<ModelConfigRow[]> {
  return db
    .select()
    .from(modelConfigs)
    .where(
      and(
        eq(modelConfigs.clarityTier, tier),
        eq(modelConfigs.isActive, true),
        eq(modelConfigs.isDeprecated, false),
      ),
    )
    .orderBy(asc(modelConfigs.priority), asc(modelConfigs.modelId));
}

/**
 * `routes/models.ts:87` and `:120`, `routes/clarity-models.ts:127` and `:200`,
 * `seed-model-configs.ts:170` — the compound-key lookup.
 *
 * No `lower()` here: `ModelConfig` declares no `lowercase` setter on either
 * half of its key, so the match is case-sensitive exactly as in Mongo. Applying
 * the slug treatment used elsewhere in this domain would silently start
 * matching `GPT-4O` to `gpt-4o`.
 */
export async function findByProviderModel(
  db: StationDatabase,
  provider: string,
  modelId: string,
): Promise<ModelConfigRow | null> {
  const [row] = await db
    .select()
    .from(modelConfigs)
    .where(and(eq(modelConfigs.provider, provider), eq(modelConfigs.modelId, modelId)));
  return row ?? null;
}

/**
 * `routes/models.ts:134`.
 *
 * The route passes `req.body` straight through — `ModelConfig.create(modelData)`
 * — which is mass assignment. This signature takes the table's insert type, so
 * `tsc` at least names the columns; narrowing what the ROUTE accepts is a
 * change to the route and belongs to the rewiring commit, not here.
 */
export async function createModel(
  db: StationDatabase,
  values: NewModelConfig,
): Promise<ModelConfigRow> {
  const [row] = await db.insert(modelConfigs).values(values).returning();
  return row;
}

/** `routes/models.ts:165`. `undefined` never reaches the SET clause. */
export async function patchModel(
  db: StationDatabase,
  provider: string,
  modelId: string,
  patch: Partial<Omit<NewModelConfig, 'id' | 'provider' | 'modelId' | 'createdAt'>>,
): Promise<ModelConfigRow | null> {
  if (Object.values(patch).every((value) => value === undefined)) {
    return findByProviderModel(db, provider, modelId);
  }
  const [row] = await db
    .update(modelConfigs)
    .set(patch)
    .where(and(eq(modelConfigs.provider, provider), eq(modelConfigs.modelId, modelId)))
    .returning();
  return row ?? null;
}

/**
 * `routes/models.ts:203`.
 *
 * Now fails with a foreign-key violation when a Clarity model still maps to
 * this provider model — see the note on `clarityModelProviderMappings`. In
 * Mongo the delete succeeded and left dangling references behind. The caller
 * has to unmap first; `isForeignKeyViolation` from `@oxyhq/db` is how the
 * rewiring turns that into a 409 rather than a 500.
 */
export async function deleteModel(
  db: StationDatabase,
  provider: string,
  modelId: string,
): Promise<ModelConfigRow | null> {
  const [row] = await db
    .delete(modelConfigs)
    .where(and(eq(modelConfigs.provider, provider), eq(modelConfigs.modelId, modelId)))
    .returning();
  return row ?? null;
}

/**
 * `seed-model-configs.ts:75` — the seed's upsert.
 *
 * ## `$setOnInsert` and `$set` are different halves and stay different
 *
 * The seed writes the capability/limit/pricing block ONLY on insert, and the
 * tier ranking on EVERY run, so re-running updates priorities without
 * clobbering a model whose pricing an operator has since corrected by hand.
 * Collapsing the two into one `onConflictDoUpdate` would silently reset those
 * corrections on the next boot.
 *
 * `ON CONFLICT ... DO UPDATE` rather than a catch: the source wraps the whole
 * thing in a `try` and swallows a duplicate-key error, which on Postgres would
 * be indistinguishable from a dropped connection — one failed statement also
 * aborts the entire transaction, so the recovery would not work at all.
 *
 * @returns `inserted` mirrors Mongo's `upsertedCount > 0`, which the seed
 *   reports as "seeded" versus "skipped". It comes from `RETURNING (xmax = 0)`,
 *   the only way to tell an inserted row from an updated one in a single
 *   statement.
 */
export async function seedModel(
  db: StationDatabase,
  onInsert: NewModelConfig,
  always: Required<Pick<NewModelConfig, 'clarityTier' | 'priority' | 'qualityScore'>>,
): Promise<{ inserted: boolean; row: ModelConfigRow }> {
  const [row] = await db
    .insert(modelConfigs)
    .values({ ...onInsert, ...always })
    .onConflictDoUpdate({
      target: [modelConfigs.provider, modelConfigs.modelId],
      set: always,
    })
    .returning({ ...getTableColumns(modelConfigs), inserted: sql<boolean>`(xmax = 0)` });

  const { inserted, ...rest } = row;
  return { inserted, row: rest };
}
