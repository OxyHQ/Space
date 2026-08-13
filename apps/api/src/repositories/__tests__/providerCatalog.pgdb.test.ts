/**
 * The provider-routing catalogue against a real PostgreSQL 17:
 * `model_configs`, `clarity_models`, `clarity_model_provider_mappings`,
 * `plans`, `features`, `plan_features` and `credit_packages`.
 *
 * Every slug is minted by this file, and every listing assertion is filtered to
 * the rows it created — nothing truncates between runs, so a fixed slug would
 * read the previous run's rows and quietly change what each count means.
 */

import { randomBytes } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { closeTestDb, getTestDb, type TestDatabase } from '../../db/__tests__/testDatabase.js';
import { clarityModelProviderMappings, clarityModels, plans } from '../../db/schema/providers.js';
import * as clarity from '../clarity-models.js';
import * as creditPackages from '../credit-packages.js';
import * as features from '../features.js';
import * as models from '../model-configs.js';
import * as planFeatures from '../plan-features.js';
import * as plansRepo from '../plans.js';

let db: TestDatabase;

/** A slug no other test and no previous run can produce. Lowercase by construction. */
function slug(label: string): string {
  return `pc-${label}-${randomBytes(6).toString('hex')}`;
}

async function makeModelConfig(overrides: Record<string, unknown> = {}) {
  return models.createModel(db, {
    provider: 'openai',
    modelId: slug('model'),
    displayName: 'A model',
    limitMaxContextTokens: 8192,
    limitMaxOutputTokens: 4096,
    pricingTier: 'paid',
    pricingCostPer1MInput: 1,
    pricingCostPer1MOutput: 2,
    pricingAverageLatencyMs: 1500,
    ...overrides,
  });
}

async function makeClarityModel(overrides: Record<string, unknown> = {}) {
  return clarity.createModel(db, {
    clarityModelId: slug('clarity'),
    displayName: 'Clarity Test',
    tier: 'v1',
    ...overrides,
  });
}

beforeAll(async () => {
  db = await getTestDb();
});

afterAll(closeTestDb);

describe('slugs keep the Mongoose lowercase setter’s behaviour', () => {
  /**
   * The setter normalised on WRITE. Here the CHECK makes that structural, so a
   * writer that forgets gets a loud constraint violation instead of a row that
   * is stored but invisible to every `lower()` lookup.
   */
  it('rejects a mixed-case slug written around the repository', async () => {
    await expect(
      db.insert(plans).values({ planId: 'PC-MixedCase', name: 'x', product: 'clarity' }),
    ).rejects.toThrow();
  });

  it('normalises on create, so a mixed-case slug is stored lowercased', async () => {
    const raw = slug('Create').toUpperCase();
    const created = await plansRepo.createPlan(db, {
      planId: raw,
      name: 'Upper',
      product: 'clarity',
    });

    expect(created.planId).toBe(raw.toLowerCase());
  });

  /**
   * The setter also normalised QUERY values — `findOne({ planId: 'Pro' })`
   * matches the stored `pro` today. That half survives by normalising the
   * parameter.
   */
  it('finds a slug however the caller cases it', async () => {
    const id = slug('lookup');
    await plansRepo.createPlan(db, { planId: id, name: 'Lookup', product: 'clarity' });

    expect((await plansRepo.findBySlug(db, id.toUpperCase()))?.planId).toBe(id);
    expect((await features.findBySlug(db, id.toUpperCase()))).toBeNull();
  });

  it('applies the same rule to every slug table', async () => {
    const featureId = slug('feat');
    const packageId = slug('pkg');
    const clarityId = slug('cm');

    await features.createFeature(db, {
      featureId: featureId.toUpperCase(),
      label: 'F',
      category: 'core',
    });
    await creditPackages.createPackage(db, {
      packageId: packageId.toUpperCase(),
      name: 'P',
      credits: 100,
      price: 500,
    });
    await makeClarityModel({ clarityModelId: clarityId.toUpperCase() });

    expect((await features.findBySlug(db, featureId))?.featureId).toBe(featureId);
    expect((await creditPackages.findBySlug(db, packageId))?.packageId).toBe(packageId);
    expect((await clarity.findBySlug(db, clarityId))?.clarityModelId).toBe(clarityId);
  });

  it('refuses a duplicate slug', async () => {
    const id = slug('dupe');
    await plansRepo.createPlan(db, { planId: id, name: 'A', product: 'clarity' });

    await expect(
      plansRepo.createPlan(db, { planId: id.toUpperCase(), name: 'B', product: 'clarity' }),
    ).rejects.toThrow();
  });
});

describe('patching never erases what the caller did not mention', () => {
  /**
   * The `$set: { x: undefined }` hazard, on the catalogue tables. Mongoose
   * strips undefined; a naive Postgres translation writes NULL.
   */
  it('a plan patch leaves untouched columns alone', async () => {
    const id = slug('patch-plan');
    await plansRepo.createPlan(db, {
      planId: id,
      name: 'Original',
      product: 'clarity',
      monthlyPrice: 900,
      description: 'keep me',
      modelIds: ['a', 'b'],
    });

    const after = await plansRepo.patchPlan(db, id, { name: 'Renamed' });

    expect(after?.name).toBe('Renamed');
    expect(after?.monthlyPrice).toBe(900);
    expect(after?.description).toBe('keep me');
    expect(after?.modelIds).toEqual(['a', 'b']);
  });

  it('a model-config patch leaves the pricing block alone', async () => {
    const config = await makeModelConfig({ notes: 'operator note' });

    const after = await models.patchModel(db, config.provider, config.modelId, {
      displayName: 'Renamed',
    });

    expect(after?.displayName).toBe('Renamed');
    expect(after?.pricingCostPer1MInput).toBe(1);
    expect(after?.notes).toBe('operator note');
  });

  it('an explicit null still clears', async () => {
    const id = slug('clear');
    await plansRepo.createPlan(db, {
      planId: id,
      name: 'X',
      product: 'clarity',
      description: 'temporary',
    });

    expect((await plansRepo.patchPlan(db, id, { description: null }))?.description).toBeNull();
  });

  it('an all-undefined patch is a no-op rather than an error', async () => {
    const id = slug('noop');
    await plansRepo.createPlan(db, { planId: id, name: 'Keep', product: 'clarity' });

    expect((await plansRepo.patchPlan(db, id, { name: undefined }))?.name).toBe('Keep');
  });
});

describe('plan-feature mappings', () => {
  /**
   * THE SHARPEST CASE IN THE DOMAIN.
   *
   * `PUT /v1/plan-features/:planId/:featureId` destructures four fields off
   * `req.body` and puts all four into `$set`, so a request mentioning only
   * `enabled` sends three `undefined`s. Mongoose strips them; Postgres would
   * write three NULLs and erase a feature's limit and both display overrides —
   * silently, with a 200.
   */
  it('an upsert that mentions only `enabled` preserves the limit and the labels', async () => {
    const planId = slug('pf-plan');
    const featureId = slug('pf-feature');

    await planFeatures.upsertMapping(db, {
      planId,
      featureId,
      enabled: true,
      limitValue: 500,
      displayLabel: 'Five hundred',
      displayDescription: 'per month',
    });

    const after = await planFeatures.upsertMapping(db, { planId, featureId, enabled: false });

    expect(after.enabled).toBe(false);
    expect(after.limitValue).toBe(500);
    expect(after.displayLabel).toBe('Five hundred');
    expect(after.displayDescription).toBe('per month');
  });

  it('an explicit null clears an override', async () => {
    const planId = slug('pf-clear-plan');
    const featureId = slug('pf-clear-feature');

    await planFeatures.upsertMapping(db, { planId, featureId, limitValue: 10 });
    const after = await planFeatures.upsertMapping(db, { planId, featureId, limitValue: null });

    expect(after.limitValue).toBeNull();
  });

  /**
   * The bulk path has the same requirement, and it is why it is N statements in
   * a transaction rather than one batched `INSERT ... ON CONFLICT DO UPDATE SET
   * limit_value = excluded.limit_value`: inside `excluded`, an omitted field
   * and an explicitly-cleared field are the same NULL.
   */
  it('the bulk save preserves fields the editor did not resend', async () => {
    const planId = slug('bulk-plan');
    const first = slug('bulk-a');
    const second = slug('bulk-b');

    await planFeatures.upsertMapping(db, {
      planId,
      featureId: first,
      limitValue: 42,
      displayLabel: 'keep me',
    });

    const result = await planFeatures.bulkUpsertMappings(db, [
      { planId, featureId: first, enabled: false },
      { planId, featureId: second, enabled: true, limitValue: 7 },
    ]);

    expect(result).toEqual({ upserted: 1, modified: 1, total: 2 });

    const kept = await planFeatures.findMapping(db, planId, first);
    expect(kept?.enabled).toBe(false);
    expect(kept?.limitValue).toBe(42);
    expect(kept?.displayLabel).toBe('keep me');

    expect((await planFeatures.findMapping(db, planId, second))?.limitValue).toBe(7);
  });

  /**
   * The seed's update document is `$setOnInsert` only, so re-running it must
   * NOT overwrite a mapping an operator has since edited. Collapsing it into
   * the bulk upsert would silently revert every hand-made change on the next
   * boot.
   */
  it('the seed leaves an existing mapping exactly as it is', async () => {
    const planId = slug('seed-plan');
    const featureId = slug('seed-feature');

    await planFeatures.upsertMapping(db, { planId, featureId, enabled: false, limitValue: 3 });

    const inserted = await planFeatures.seedMappings(db, [
      { planId, featureId, enabled: true, limitValue: 999 },
      { planId, featureId: slug('seed-new'), enabled: true },
    ]);

    expect(inserted).toBe(1);
    const untouched = await planFeatures.findMapping(db, planId, featureId);
    expect(untouched?.enabled).toBe(false);
    expect(untouched?.limitValue).toBe(3);
  });

  it('lists a plan’s mappings and deletes one', async () => {
    const planId = slug('list-plan');
    await planFeatures.upsertMapping(db, { planId, featureId: slug('a') });
    const doomed = slug('b');
    await planFeatures.upsertMapping(db, { planId, featureId: doomed });

    expect(await planFeatures.listMappings(db, { planId })).toHaveLength(2);

    expect(await planFeatures.deleteMapping(db, planId, doomed)).not.toBeNull();
    expect(await planFeatures.listMappings(db, { planId })).toHaveLength(1);
    expect(await planFeatures.deleteMapping(db, planId, doomed)).toBeNull();
  });
});

describe('provider mappings on a Clarity model', () => {
  /**
   * A transaction gives ATOMICITY; the Mongo document replacement it replaces
   * gave atomicity AND serialization. The runtime guard is what makes a caller
   * that reaches for the pool fail loudly instead of leaving the Clarity model
   * with no providers for the width of a DELETE.
   *
   * A signature alone would not do it: `tsc` accepts the pool handle here
   * because `PgHandle` covers both.
   */
  it('refuses to run outside a transaction', async () => {
    const model = await makeClarityModel();
    const config = await makeModelConfig();

    await expect(
      clarity.replaceProviderMappings(db, model.id, [
        {
          modelConfigId: config.id,
          provider: config.provider,
          modelId: config.modelId,
          priority: 1,
          qualityScore: 80,
        },
      ]),
    ).rejects.toThrow(/transaction/i);

    // Nothing was written — the guard runs before the DELETE.
    expect(await clarity.listProviderMappings(db, model.id)).toHaveLength(0);
  });

  it('replaces the whole list and preserves the caller’s order', async () => {
    const model = await makeClarityModel();
    const first = await makeModelConfig();
    const second = await makeModelConfig();
    const third = await makeModelConfig();

    await db.transaction(async (tx) => {
      await clarity.replaceProviderMappings(tx, model.id, [
        {
          modelConfigId: first.id,
          provider: first.provider,
          modelId: first.modelId,
          priority: 10,
          qualityScore: 50,
        },
        {
          modelConfigId: second.id,
          provider: second.provider,
          modelId: second.modelId,
          priority: 1,
          qualityScore: 90,
        },
      ]);
    });

    let stored = await clarity.listProviderMappings(db, model.id);
    expect(stored.map((row) => row.position)).toEqual([0, 1]);
    expect(stored.map((row) => row.modelConfigId)).toEqual([first.id, second.id]);

    await db.transaction(async (tx) => {
      await clarity.replaceProviderMappings(tx, model.id, [
        {
          modelConfigId: third.id,
          provider: third.provider,
          modelId: third.modelId,
          priority: 5,
          qualityScore: 70,
        },
      ]);
    });

    stored = await clarity.listProviderMappings(db, model.id);
    expect(stored).toHaveLength(1);
    expect(stored[0]?.modelConfigId).toBe(third.id);
  });

  it('replacing with an empty list clears the mappings', async () => {
    const model = await makeClarityModel();
    const config = await makeModelConfig();

    await db.transaction(async (tx) => {
      await clarity.replaceProviderMappings(tx, model.id, [
        {
          modelConfigId: config.id,
          provider: config.provider,
          modelId: config.modelId,
          priority: 1,
          qualityScore: 10,
        },
      ]);
    });
    await db.transaction(async (tx) => {
      await clarity.replaceProviderMappings(tx, model.id, []);
    });

    expect(await clarity.listProviderMappings(db, model.id)).toHaveLength(0);
  });

  /**
   * `getAvailableProviders()` filtered on `isActive` and sorted by priority in
   * JavaScript. `Array.prototype.sort` is stable, so equal priorities kept the
   * array order — `position` is what reproduces that, and a Postgres sort
   * without it is free to return either.
   */
  it('returns active mappings by priority, ties broken by array position', async () => {
    const model = await makeClarityModel();
    const a = await makeModelConfig();
    const b = await makeModelConfig();
    const c = await makeModelConfig();

    await db.transaction(async (tx) => {
      await clarity.replaceProviderMappings(tx, model.id, [
        { modelConfigId: a.id, provider: a.provider, modelId: a.modelId, priority: 5, qualityScore: 1 },
        { modelConfigId: b.id, provider: b.provider, modelId: b.modelId, priority: 5, qualityScore: 2 },
        {
          modelConfigId: c.id,
          provider: c.provider,
          modelId: c.modelId,
          priority: 1,
          qualityScore: 3,
          isActive: false,
        },
      ]);
    });

    const active = await clarity.listActiveMappings(db, model.id);
    expect(active.map((row) => row.modelConfigId)).toEqual([a.id, b.id]);
  });

  it('removes mappings with the Clarity model', async () => {
    const model = await makeClarityModel();
    const config = await makeModelConfig();
    await db.transaction(async (tx) => {
      await clarity.replaceProviderMappings(tx, model.id, [
        {
          modelConfigId: config.id,
          provider: config.provider,
          modelId: config.modelId,
          priority: 1,
          qualityScore: 1,
        },
      ]);
    });

    await clarity.deleteModel(db, model.clarityModelId);

    const remaining = await db
      .select()
      .from(clarityModelProviderMappings)
      .where(eq(clarityModelProviderMappings.clarityModelId, model.id));
    expect(remaining).toHaveLength(0);
  });

  /**
   * The deliberate tightening. In Mongo, deleting a `ModelConfig` left dangling
   * `modelConfigId` refs behind and nothing said so. `onDelete: 'restrict'`
   * makes that impossible — and it CHANGES `DELETE /v1/models/:provider/:modelId`
   * from a silent success into a foreign-key violation the rewiring has to turn
   * into a 409. Recorded in the port report; asserted here.
   */
  it('refuses to delete a provider model a Clarity model still maps to', async () => {
    const model = await makeClarityModel();
    const config = await makeModelConfig();
    await db.transaction(async (tx) => {
      await clarity.replaceProviderMappings(tx, model.id, [
        {
          modelConfigId: config.id,
          provider: config.provider,
          modelId: config.modelId,
          priority: 1,
          qualityScore: 1,
        },
      ]);
    });

    await expect(models.deleteModel(db, config.provider, config.modelId)).rejects.toThrow();

    // Control: an unmapped provider model still deletes, so the rejection above
    // is about the reference rather than about deletes being broken.
    const unmapped = await makeModelConfig();
    expect(await models.deleteModel(db, unmapped.provider, unmapped.modelId)).not.toBeNull();
  });
});

describe('the seeds', () => {
  it('a plan seed inserts once and then reports nothing to do', async () => {
    const planId = slug('seed-once');

    expect(await plansRepo.seedPlan(db, { planId, name: 'A', product: 'clarity' })).toBe(true);
    expect(await plansRepo.seedPlan(db, { planId, name: 'B', product: 'clarity' })).toBe(false);

    // The second call must not have overwritten the first.
    expect((await plansRepo.findBySlug(db, planId))?.name).toBe('A');
  });

  /**
   * `seed-plans.ts` does NOT send a pure `$setOnInsert`: it carries
   * `$set: { modelIds }` as well, under the comment "Always sync modelIds from
   * seed (code-managed)". Every other column is admin-managed and written only
   * on insert.
   *
   * Read as pure `$setOnInsert` — which is how it first ported — this becomes
   * `ON CONFLICT DO NOTHING`, which passes the test above, passes every other
   * assertion in this file, and silently ends the code-managed half of the
   * seed's contract: a plan whose model list changed in the source would keep
   * serving the old list forever, with no error and no log line. So the sync is
   * asserted here, and the admin-managed columns are asserted UNCHANGED in the
   * same case — those are the two halves that must not be collapsed into one
   * `excluded`-based update.
   */
  it('a plan seed re-syncs modelIds on every run, and nothing else', async () => {
    const planId = slug('seed-resync');

    expect(
      await plansRepo.seedPlan(db, {
        planId,
        name: 'A',
        product: 'clarity',
        monthlyPrice: 10,
        modelIds: ['clarity-v1'],
      }),
    ).toBe(true);

    // Second run: a different model list, and different values for the columns
    // an operator is expected to have edited by hand.
    expect(
      await plansRepo.seedPlan(db, {
        planId,
        name: 'B',
        product: 'clarity',
        monthlyPrice: 999,
        modelIds: ['clarity-v1', 'clarity-pro'],
      }),
    ).toBe(false);

    const row = await plansRepo.findBySlug(db, planId);
    expect(row?.modelIds).toEqual(['clarity-v1', 'clarity-pro']);
    // The hand-editable columns survived.
    expect(row?.name).toBe('A');
    expect(row?.monthlyPrice).toBe(10);
  });

  /**
   * The other half of the branch: a caller that supplies no `modelIds` has
   * nothing to re-sync, and must not have the column reset to its default.
   */
  it('a plan seed with no modelIds leaves the stored list alone', async () => {
    const planId = slug('seed-nomodels');

    expect(
      await plansRepo.seedPlan(db, {
        planId,
        name: 'A',
        product: 'clarity',
        modelIds: ['clarity-v1'],
      }),
    ).toBe(true);

    expect(await plansRepo.seedPlan(db, { planId, name: 'B', product: 'clarity' })).toBe(false);

    expect((await plansRepo.findBySlug(db, planId))?.modelIds).toEqual(['clarity-v1']);
  });

  it('a feature seed and a package seed behave the same way', async () => {
    const featureId = slug('seed-feat');
    const packageId = slug('seed-pkg');

    expect(await features.seedFeature(db, { featureId, label: 'A', category: 'core' })).toBe(true);
    expect(await features.seedFeature(db, { featureId, label: 'B', category: 'core' })).toBe(false);
    expect((await features.findBySlug(db, featureId))?.label).toBe('A');

    expect(
      await creditPackages.seedPackage(db, { packageId, name: 'A', credits: 1, price: 0 }),
    ).toBe(true);
    expect(
      await creditPackages.seedPackage(db, { packageId, name: 'B', credits: 2, price: 0 }),
    ).toBe(false);
  });

  /**
   * `$setOnInsert` and `$set` are different halves of the model-config seed and
   * stay different: the pricing block is written only on insert, the tier
   * ranking on every run. Collapsing them would reset an operator's hand-fixed
   * pricing on the next boot.
   */
  it('a model-config seed updates the ranking but never the pricing', async () => {
    const modelId = slug('seed-model');
    const base = {
      provider: 'groq' as const,
      modelId,
      displayName: 'Seeded',
      limitMaxContextTokens: 8192,
      limitMaxOutputTokens: 4096,
      pricingTier: 'free' as const,
      pricingCostPer1MInput: 0,
      pricingCostPer1MOutput: 0,
      pricingAverageLatencyMs: 1000,
    };

    const first = await models.seedModel(db, base, {
      clarityTier: 'v1',
      priority: 10,
      qualityScore: 50,
    });
    expect(first.inserted).toBe(true);

    // An operator corrects the pricing by hand.
    await models.patchModel(db, 'groq', modelId, { pricingCostPer1MInput: 7 });

    const second = await models.seedModel(db, { ...base, pricingCostPer1MInput: 0 }, {
      clarityTier: 'v1-pro',
      priority: 3,
      qualityScore: 90,
    });

    expect(second.inserted).toBe(false);
    expect(second.row.clarityTier).toBe('v1-pro');
    expect(second.row.priority).toBe(3);
    // The hand-made correction survived.
    expect(second.row.pricingCostPer1MInput).toBe(7);
  });

  it('a clarity-model seed reports the existing id on a conflict', async () => {
    const clarityModelId = slug('seed-clarity');
    const first = await clarity.seedModel(db, {
      clarityModelId,
      displayName: 'A',
      tier: 'v1',
    });
    const second = await clarity.seedModel(db, {
      clarityModelId,
      displayName: 'B',
      tier: 'v1',
    });

    expect(first.inserted).toBe(true);
    expect(second.inserted).toBe(false);
    expect(second.id).toBe(first.id);
  });
});

describe('the plan modelIds validation the source could never pass', () => {
  /**
   * `routes/plans.ts:118` filters `ClarityModel` on `{ modelId: { $in: [...] } }`.
   * `ClarityModel` has no `modelId` field — the slug is `clarityModelId` — so in
   * Mongo the filter matches nothing, every supplied id lands in `invalid`, and
   * the route rejects EVERY non-empty `modelIds` array.
   *
   * The port cannot reproduce that: a predicate against a column that does not
   * exist will not compile. So this matches on `clarityModelId`, which is what
   * both call sites meant, and the validation starts working.
   */
  it('resolves ids that exist and reports the ones that do not', async () => {
    const present = slug('valid-model');
    await makeClarityModel({ clarityModelId: present });
    const absent = slug('absent-model');

    const found = await clarity.findExistingSlugs(db, [present, absent]);

    expect(found).toEqual([present]);
    expect(found).not.toContain(absent);
  });

  it('matches however the caller cases the ids', async () => {
    const present = slug('cased-model');
    await makeClarityModel({ clarityModelId: present });

    expect(await clarity.findExistingSlugs(db, [present.toUpperCase()])).toEqual([present]);
  });

  /**
   * `inArray(col, [])` renders as the literal `false`, so the empty case is
   * short-circuited in JavaScript. Asserted so a later "simplification" that
   * removes the guard has something to fail.
   */
  it('returns nothing for an empty id list', async () => {
    expect(await clarity.findExistingSlugs(db, [])).toEqual([]);
  });
});

describe('constraints the Mongoose validators genuinely enforced', () => {
  it('rejects an unknown provider on a model config', async () => {
    await expect(makeModelConfig({ provider: 'not-a-provider' })).rejects.toThrow();
  });

  it('rejects an unknown Clarity tier', async () => {
    await expect(makeClarityModel({ tier: 'v9-imaginary' })).rejects.toThrow();
  });

  it('rejects an unknown plan product', async () => {
    await expect(
      plansRepo.createPlan(db, { planId: slug('bad'), name: 'x', product: 'not-a-product' }),
    ).rejects.toThrow();
  });

  it('rejects a credit package below one credit', async () => {
    await expect(
      creditPackages.createPackage(db, {
        packageId: slug('zero'),
        name: 'x',
        credits: 0,
        price: 0,
      }),
    ).rejects.toThrow();
  });

  it('rejects a credit multiplier outside the source’s range', async () => {
    await expect(makeClarityModel({ creditMultiplier: 20 })).rejects.toThrow();
    await expect(makeClarityModel({ creditMultiplier: 0.05 })).rejects.toThrow();
    await expect(makeClarityModel({ creditMultiplier: 1.5 })).resolves.toBeDefined();
  });

  /**
   * `nullable` plus a CHECK is not the same as `not null` plus a CHECK. A model
   * config with no `clarityTier` must be storable — `null in (...)` is NULL,
   * which a CHECK accepts because it rejects only FALSE.
   */
  it('accepts a model config with no Clarity tier at all', async () => {
    const config = await makeModelConfig({ clarityTier: null });
    expect(config.clarityTier).toBeNull();
  });

  it('rejects a description longer than the Mongoose maxlength', async () => {
    await expect(makeClarityModel({ description: 'x'.repeat(1001) })).rejects.toThrow();
    await expect(makeClarityModel({ description: 'x'.repeat(1000) })).resolves.toBeDefined();
  });
});

describe('listings', () => {
  it('orders model configs by provider then priority, with nulls last', async () => {
    const provider = 'xai';
    const ranked = await makeModelConfig({ provider, priority: 1 });
    const lower = await makeModelConfig({ provider, priority: 50 });
    const unranked = await makeModelConfig({ provider, priority: null });

    const mine = new Set([ranked.id, lower.id, unranked.id]);
    const rows = (await models.listModels(db, { provider })).filter((row) => mine.has(row.id));

    expect(rows.map((row) => row.id)).toEqual([ranked.id, lower.id, unranked.id]);
  });

  it('lists a tier’s active, non-deprecated models', async () => {
    const clarityTier = 'v1-vision';
    const live = await makeModelConfig({ clarityTier, priority: 1 });
    const deprecated = await makeModelConfig({ clarityTier, isDeprecated: true });
    const inactive = await makeModelConfig({ clarityTier, isActive: false });

    const mine = new Set([live.id, deprecated.id, inactive.id]);
    const rows = (await models.listByTier(db, clarityTier)).filter((row) => mine.has(row.id));

    expect(rows.map((row) => row.id)).toEqual([live.id]);
  });

  it('filters Clarity models by tier and active state', async () => {
    const tier = 'v1-audio';
    const live = await makeClarityModel({ tier });
    const off = await makeClarityModel({ tier, isActive: false });

    const mine = new Set([live.id, off.id]);
    const rows = (await clarity.listModels(db, { tier, isActive: true })).filter((row) =>
      mine.has(row.id),
    );

    expect(rows.map((row) => row.id)).toEqual([live.id]);
  });

  it('stores and returns array columns', async () => {
    const model = await makeClarityModel({ features: ['fast', 'cheap'] });
    const stored = await db.select().from(clarityModels).where(eq(clarityModels.id, model.id));

    expect(stored[0]?.features).toEqual(['fast', 'cheap']);
    // The default is an empty array, never null.
    const bare = await makeClarityModel();
    expect(bare.features).toEqual([]);
  });

  it('returns null rather than throwing for slugs that do not exist', async () => {
    const missing = slug('missing');
    expect(await plansRepo.findBySlug(db, missing)).toBeNull();
    expect(await plansRepo.patchPlan(db, missing, { name: 'x' })).toBeNull();
    expect(await plansRepo.deletePlan(db, missing)).toBeNull();
    expect(await features.deleteFeature(db, missing)).toBeNull();
    expect(await creditPackages.deletePackage(db, missing)).toBeNull();
    expect(await clarity.deleteModel(db, missing)).toBeNull();
    expect(await models.findByProviderModel(db, 'openai', missing)).toBeNull();
  });
});
