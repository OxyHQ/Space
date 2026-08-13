/**
 * Virtual Clarity models and their provider mappings — every query
 * `internal/providers/routes/clarity-models.ts`, `routes/plans.ts`,
 * `lib/broadcast-helpers.ts` and `lib/seed-model-configs.ts` perform against the
 * `ClarityModel` model.
 *
 * ## Two document methods are not here, because nothing calls them
 *
 * `getAvailableProviders` and `getNextProvider` (`clarity-model.ts:209` and
 * `:216`) have zero call sites — `getNextProvider` calls the first, and nothing
 * calls `getNextProvider`. The live fallback path routes off the in-code
 * `TIER_MODEL_MAPPINGS` table in `lib/clarity-models.ts`, not off these
 * documents. {@link listActiveMappings} is here anyway because the child table
 * needs an accessor and it is the shape those methods would have used, but it
 * has no caller in the source and the rewiring should not invent one.
 */

import { and, asc, eq, inArray } from 'drizzle-orm';
import { type PgHandle, requireTransaction } from './handle.js';
import { clarityModelProviderMappings, clarityModels } from '../db/schema/providers.js';

export type ClarityModelRow = typeof clarityModels.$inferSelect;
export type NewClarityModel = typeof clarityModels.$inferInsert;
export type ProviderMappingRow = typeof clarityModelProviderMappings.$inferSelect;

/** One provider mapping as a caller supplies it, before it gets a position. */
export interface ProviderMappingInput {
  readonly modelConfigId: string;
  readonly provider: string;
  readonly modelId: string;
  readonly priority: number;
  readonly qualityScore: number;
  readonly isActive?: boolean;
}

/**
 * The Mongoose `lowercase: true` setter, ported.
 *
 * It normalises on write AND on query values, so
 * `findOne({ clarityModelId: 'Clarity-V1' })` matches the stored `clarity-v1`
 * today. Normalising the PARAMETER reproduces the query half; the column needs
 * no `lower()` because a CHECK guarantees every stored value already is its own
 * `lower()`, which keeps this an index scan on the plain unique.
 */
function matchesSlug(value: string) {
  return eq(clarityModels.clarityModelId, value.toLowerCase());
}

/** `routes/clarity-models.ts:33` — the admin listing, optionally filtered. */
export async function listModels(
  db: PgHandle,
  filter: { tier?: string; isActive?: boolean } = {},
): Promise<ClarityModelRow[]> {
  const conditions = [];
  if (filter.tier !== undefined) conditions.push(eq(clarityModels.tier, filter.tier));
  if (filter.isActive !== undefined) conditions.push(eq(clarityModels.isActive, filter.isActive));

  return db
    .select()
    .from(clarityModels)
    .where(conditions.length > 0 ? and(...conditions) : undefined)
    .orderBy(asc(clarityModels.tier), asc(clarityModels.clarityModelId));
}

/** `routes/clarity-models.ts:58` and `:107`, `seed-model-configs.ts:193`. */
export async function findBySlug(
  db: PgHandle,
  clarityModelId: string,
): Promise<ClarityModelRow | null> {
  const [row] = await db.select().from(clarityModels).where(matchesSlug(clarityModelId));
  return row ?? null;
}

/**
 * `routes/plans.ts:118` and `:188` — which of these ids name a real Clarity
 * model?
 *
 * ## The source query matches nothing, and this one does
 *
 * Both call sites filter on `{ modelId: { $in: [...] } }` and project
 * `'modelId'`. `ClarityModel` has no `modelId` field — the slug is
 * `clarityModelId`. In Mongo a filter on an absent path matches no documents,
 * so `validModels` is always empty, every supplied id lands in `invalid`, and
 * `POST`/`PATCH /v1/plans` reject EVERY non-empty `modelIds` array with
 * `INVALID_MODEL_IDS`. That is a live bug the port must not carry forward:
 * reproducing it would mean writing a predicate against a column that does not
 * exist, which will not even compile here.
 *
 * So this matches on `clarityModelId`, which is what both call sites plainly
 * meant, and the rewiring commit inherits a validation that starts working. It
 * is named in the port report because a route going from "always rejects" to
 * "accepts valid input" is a behaviour change, even though it is the intended
 * behaviour.
 */
export async function findExistingSlugs(
  db: PgHandle,
  slugs: readonly string[],
): Promise<string[]> {
  if (slugs.length === 0) return [];
  const rows = await db
    .select({ clarityModelId: clarityModels.clarityModelId })
    .from(clarityModels)
    .where(
      inArray(
        clarityModels.clarityModelId,
        slugs.map((slug) => slug.toLowerCase()),
      ),
    );
  return rows.map((row) => row.clarityModelId);
}

/**
 * `routes/clarity-models.ts:139`.
 *
 * The slug is lowercased here rather than trusted from the caller: that is the
 * WRITE half of the `lowercase: true` setter, and without it a mixed-case
 * `clarityModelId` violates the table's CHECK. The route happens to lowercase
 * it too; relying on that would leave every other writer to remember.
 */
export async function createModel(
  db: PgHandle,
  values: NewClarityModel,
): Promise<ClarityModelRow> {
  const [row] = await db
    .insert(clarityModels)
    .values({ ...values, clarityModelId: values.clarityModelId.toLowerCase() })
    .returning();
  return row;
}

/**
 * `routes/clarity-models.ts:213` — patch a Clarity model.
 *
 * Takes only the model's OWN columns. `providerMappings` is not part of this
 * type on purpose: the source's `$set` carries the array, and treating it as
 * one more patchable field is exactly what would produce a bare DELETE +
 * INSERT with no transaction. Callers that change both do so inside one
 * transaction, patching here and calling
 * {@link replaceProviderMappings} there.
 *
 * `undefined` values never reach the SET clause — drizzle's `mapUpdateSet`
 * filters them, which is what makes this behave like Mongoose's update rather
 * than erasing every field the caller did not mention. An explicit `null` still
 * clears, which is a caller saying so.
 */
export async function patchModel(
  db: PgHandle,
  clarityModelId: string,
  patch: Partial<Omit<NewClarityModel, 'id' | 'clarityModelId' | 'createdAt'>>,
): Promise<ClarityModelRow | null> {
  if (Object.values(patch).every((value) => value === undefined)) {
    return findBySlug(db, clarityModelId);
  }
  const [row] = await db
    .update(clarityModels)
    .set(patch)
    .where(matchesSlug(clarityModelId))
    .returning();
  return row ?? null;
}

/** `routes/clarity-models.ts:251`. Mappings go with it — the child FK cascades. */
export async function deleteModel(
  db: PgHandle,
  clarityModelId: string,
): Promise<ClarityModelRow | null> {
  const [row] = await db.delete(clarityModels).where(matchesSlug(clarityModelId)).returning();
  return row ?? null;
}

/** `seed-model-configs.ts:193` — the `$setOnInsert` half of the seed's upsert. */
export async function seedModel(
  db: PgHandle,
  values: NewClarityModel,
): Promise<{ inserted: boolean; id: string }> {
  const [inserted] = await db
    .insert(clarityModels)
    .values({ ...values, clarityModelId: values.clarityModelId.toLowerCase() })
    .onConflictDoNothing({ target: clarityModels.clarityModelId })
    .returning({ id: clarityModels.id });

  if (inserted) return { inserted: true, id: inserted.id };

  const existing = await findBySlug(db, values.clarityModelId);
  if (!existing) {
    throw new Error(`clarity model ${values.clarityModelId} vanished after a conflicting insert`);
  }
  return { inserted: false, id: existing.id };
}

/** The mappings of one Clarity model, in the source array's order. */
export async function listProviderMappings(
  db: PgHandle,
  clarityModelRowId: string,
): Promise<ProviderMappingRow[]> {
  return db
    .select()
    .from(clarityModelProviderMappings)
    .where(eq(clarityModelProviderMappings.clarityModelId, clarityModelRowId))
    .orderBy(asc(clarityModelProviderMappings.position));
}

/**
 * `routes/clarity-models.ts:33` — mappings for a whole page of Clarity models.
 *
 * `GET /v1/clarity-models` returned Mongo DOCUMENTS, so every row in that list
 * carried its embedded `providerMappings` array. Once the array is a child
 * table the list endpoint has to fetch them, and doing that per model is an
 * N+1 the source did not have. One `inArray` keeps it at two round trips.
 *
 * Ordered by model then position so the caller can bucket in one pass, and so
 * each model's mappings arrive in the order the source array had — `position`
 * is what preserves it, and without the sort the fallback chain would come back
 * in whatever order the scan produced.
 */
export async function listProviderMappingsForModels(
  db: PgHandle,
  clarityModelRowIds: readonly string[],
): Promise<ProviderMappingRow[]> {
  if (clarityModelRowIds.length === 0) return [];
  return db
    .select()
    .from(clarityModelProviderMappings)
    .where(inArray(clarityModelProviderMappings.clarityModelId, [...clarityModelRowIds]))
    .orderBy(
      asc(clarityModelProviderMappings.clarityModelId),
      asc(clarityModelProviderMappings.position),
    );
}

/**
 * Active mappings by ascending priority — the shape `getAvailableProviders`
 * built in JavaScript (`clarity-model.ts:211`).
 *
 * `priority` is not unique within a model, so `position` breaks the tie:
 * `Array.prototype.sort` is stable and preserved the array order for equal
 * priorities, and a Postgres sort would not.
 *
 * Has no caller in the source — see the note at the top of this file.
 */
export async function listActiveMappings(
  db: PgHandle,
  clarityModelRowId: string,
): Promise<ProviderMappingRow[]> {
  return db
    .select()
    .from(clarityModelProviderMappings)
    .where(
      and(
        eq(clarityModelProviderMappings.clarityModelId, clarityModelRowId),
        eq(clarityModelProviderMappings.isActive, true),
      ),
    )
    .orderBy(asc(clarityModelProviderMappings.priority), asc(clarityModelProviderMappings.position));
}

/**
 * Replace a Clarity model's whole provider-mapping list.
 *
 * This is the port of one atomic Mongo `$set` of an embedded array
 * (`routes/clarity-models.ts:215`, `seed-model-configs.ts:205`), and it is the
 * one operation in this domain that a naive translation gets DANGEROUSLY wrong
 * in two separate ways.
 *
 * ### 1. The gap between DELETE and INSERT is a real state
 *
 * For the duration of it the Clarity model has NO providers. A router reading
 * it in that window finds nothing to route to and reports the model
 * unavailable — no error, no log line, and it resolves itself, which is the
 * worst possible combination to debug. Hence the required transaction.
 *
 * ### 2. A transaction gives atomicity, not SERIALIZATION
 *
 * The document replacement it replaces gave both. Under READ COMMITTED two
 * concurrent replaces each DELETE the rows they can see and INSERT their own,
 * and the result is the UNION of both lists — every test passes, because each
 * ran alone. The `SELECT ... FOR UPDATE` on the PARENT row is what restores the
 * serialization point the document used to be, and it must be the FIRST
 * statement and the only lock taken.
 *
 * `requireTransaction` is a runtime check, not a type: a signature makes `tsc`
 * ask the question, but somebody still has to open the transaction, and being
 * handed the pool by mistake is exactly the caller error that produces the two
 * failures above.
 */
export async function replaceProviderMappings(
  tx: PgHandle,
  clarityModelRowId: string,
  mappings: readonly ProviderMappingInput[],
): Promise<ProviderMappingRow[]> {
  const handle = requireTransaction(tx, 'replaceProviderMappings');

  const [locked] = await handle
    .select({ id: clarityModels.id })
    .from(clarityModels)
    .where(eq(clarityModels.id, clarityModelRowId))
    .for('update');

  if (!locked) {
    throw new Error(`clarity model ${clarityModelRowId} does not exist`);
  }

  await handle
    .delete(clarityModelProviderMappings)
    .where(eq(clarityModelProviderMappings.clarityModelId, clarityModelRowId));

  if (mappings.length === 0) return [];

  return handle
    .insert(clarityModelProviderMappings)
    .values(
      mappings.map((mapping, position) => ({
        clarityModelId: clarityModelRowId,
        modelConfigId: mapping.modelConfigId,
        provider: mapping.provider,
        modelId: mapping.modelId,
        priority: mapping.priority,
        qualityScore: mapping.qualityScore,
        isActive: mapping.isActive ?? true,
        position,
      })),
    )
    .returning();
}
