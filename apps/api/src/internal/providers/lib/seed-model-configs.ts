/**
 * Seed the `model_configs` table from TIER_MODEL_MAPPINGS
 *
 * Populates it with all provider models from the hardcoded tier mappings.
 * Uses upsert for idempotency. Also resets any open circuit breakers on startup.
 */

import { getDb } from '../../../db/client.js';
import { findByProviderModel, seedModel } from '../../../repositories/model-configs.js';
import {
  patchModel as patchClarityModel,
  replaceProviderMappings,
  seedModel as seedClarityModel,
  type ProviderMappingInput,
} from '../../../repositories/clarity-models.js';
import { resetOpenCircuits } from '../../../repositories/provider-healths.js';
import { resetCooldowns } from '../../../repositories/provider-keys.js';
import { TIER_MODEL_MAPPINGS, CLARITY_MODELS, type ModelCapabilities } from './clarity-models.js';
import { log } from '../../../lib/logger.js';

// Human-readable display names for common models
const MODEL_DISPLAY_NAMES: Record<string, string> = {
  'gemini-2.5-flash': 'Gemini 2.5 Flash',
  'gemini-2.5-pro': 'Gemini 2.5 Pro',
  'gemini-3-flash-preview': 'Gemini 3 Flash Preview',
  'gemini-3-pro-preview': 'Gemini 3 Pro Preview',
  'gpt-4o': 'GPT-4o',
  'gpt-4o-mini': 'GPT-4o Mini',
  'gpt-4o-realtime-preview': 'GPT-4o Realtime Preview',
  'o1': 'OpenAI O1',
  'claude-sonnet-4-20250514': 'Claude Sonnet 4',
  'claude-opus-4-20241120': 'Claude Opus 4',
  'deepseek-chat': 'DeepSeek Chat',
  'deepseek-reasoner': 'DeepSeek Reasoner',
  'llama-3.3-70b-versatile': 'Llama 3.3 70B Versatile',
  'whisper-large-v3-turbo': 'Whisper Large V3 Turbo',
  'whisper-large-v3': 'Whisper Large V3',
  'whisper-1': 'Whisper 1',
  '@cf/meta/llama-3.2-11b-vision-instruct': 'Llama 3.2 11B Vision (CF)',
  'grok-realtime': 'Grok Realtime',
};

function getDisplayName(provider: string, modelId: string): string {
  if (MODEL_DISPLAY_NAMES[modelId]) return MODEL_DISPLAY_NAMES[modelId];
  // Auto-generate from modelId
  return modelId
    .replace(/[-_]/g, ' ')
    .replace(/\b\w/g, (c) => c.toUpperCase());
}

export async function seedModelConfigs(): Promise<{ seeded: number; skipped: number }> {
  const db = getDb();

  let seeded = 0;
  let skipped = 0;

  // Collect unique provider+modelId combinations across all tiers
  const seen = new Set<string>();

  for (const [tier, mappings] of Object.entries(TIER_MODEL_MAPPINGS)) {
    for (const mapping of mappings) {
      const uniqueKey = `${mapping.provider}:${mapping.modelId}`;

      const validProviders = [
        'openai', 'anthropic', 'google', 'groq', 'mistral',
        'deepseek', 'together', 'cerebras', 'cloudflare', 'openrouter', 'xai',
        'fireworks', 'hyperbolic', 'sambanova', 'novita', 'replicate', 'cohere', 'perplexity',
      ];
      if (!validProviders.includes(mapping.provider)) {
        log.seed.info({ provider: mapping.provider, modelId: mapping.modelId }, 'Skipping - provider not in schema enum');
        skipped++;
        continue;
      }

      const capabilities: Partial<ModelCapabilities> = mapping.capabilities || {};

      try {
        // The capability/limit/pricing block is written ONLY on insert and the
        // tier ranking on EVERY run, so re-running updates priorities without
        // clobbering pricing an operator has since corrected by hand. Both
        // halves stay separate; one `onConflictDoUpdate` over all of them would
        // silently revert those corrections on the next boot.
        //
        // The source also wrapped this in a duplicate-key catch, for "same
        // model in multiple tiers". `ON CONFLICT DO UPDATE` makes that case an
        // ordinary update, and on Postgres the catch could not have told a
        // duplicate from a dropped connection anyway — nor recovered, since one
        // failed statement aborts the whole transaction.
        const { inserted } = await seedModel(
          db,
          {
            provider: mapping.provider,
            modelId: mapping.modelId,
            displayName: getDisplayName(mapping.provider, mapping.modelId),
            capVision: capabilities.vision || false,
            capAudio: capabilities.audio || false,
            capCodeExecution: capabilities.codeExecution || false,
            capWebSearch: capabilities.webSearch || false,
            capComputerUse: capabilities.computerUse || false,
            capThinking: false,
            capStreaming: capabilities.streaming !== false,
            capFunctionCalling: capabilities.functionCalling !== false,
            capJsonMode: false,
            capPromptCaching: capabilities.promptCaching || false,
            limitMaxContextTokens: capabilities.maxContextTokens || 8192,
            limitMaxOutputTokens: capabilities.maxOutputTokens || 4096,
            pricingTier: mapping.pricingTier || 'freemium',
            pricingCostPer1MInput: mapping.costPer1MInput || 0,
            pricingCostPer1MOutput: mapping.costPer1MOutput || 0,
            pricingAverageLatencyMs: mapping.averageLatencyMs || 1500,
            isActive: true,
            isDeprecated: false,
            // Present in the insert too, so a first insert lands the ranking.
            clarityTier: tier,
            priority: mapping.priority,
            qualityScore: mapping.qualityScore,
          },
          {
            // Always update tier mapping info (allows re-running to update priorities)
            clarityTier: tier,
            priority: mapping.priority,
            qualityScore: mapping.qualityScore,
          },
        );

        if (inserted) {
          seeded++;
          if (!seen.has(uniqueKey)) {
            log.seed.info({ provider: mapping.provider, modelId: mapping.modelId, tier }, 'Created ModelConfig');
          }
        } else {
          if (!seen.has(uniqueKey)) {
            skipped++;
          }
        }

        seen.add(uniqueKey);
      } catch (error: unknown) {
        log.seed.error({ err: error, uniqueKey }, 'Error seeding ModelConfig');
      }
    }
  }

  log.seed.info({ seeded, skipped }, 'ModelConfig seeding complete');
  return { seeded, skipped };
}

/**
 * Seed the `clarity_models` table from CLARITY_MODELS and TIER_MODEL_MAPPINGS
 *
 * Creates virtual Clarity models (clarity-v1, clarity-fast, etc.) with their
 * provider mappings linked to `model_configs` rows.
 * Must run AFTER seedModelConfigs() so those references exist — and now that
 * `clarity_model_provider_mappings.model_config_id` is a real foreign key, the
 * ordering is enforced rather than merely intended.
 */
export async function seedClarityModels(): Promise<{ seeded: number; skipped: number }> {
  const db = getDb();

  let seeded = 0;
  let skipped = 0;

  const validProviders = [
    'openai', 'anthropic', 'google', 'groq', 'mistral',
    'deepseek', 'together', 'cerebras', 'cloudflare', 'openrouter', 'xai',
  ];

  for (const [modelId, clarityModel] of Object.entries(CLARITY_MODELS)) {
    try {
      // Get tier mappings for this model's tier
      const tierMappings = TIER_MODEL_MAPPINGS[clarityModel.tier] || [];

      // Build provider mappings with model_configs references
      const providerMappings: ProviderMappingInput[] = [];
      for (const mapping of tierMappings) {
        if (!validProviders.includes(mapping.provider)) continue;

        const modelConfig = await findByProviderModel(db, mapping.provider, mapping.modelId);

        if (modelConfig) {
          providerMappings.push({
            modelConfigId: modelConfig.id,
            provider: mapping.provider,
            modelId: mapping.modelId,
            priority: mapping.priority,
            qualityScore: mapping.qualityScore,
            isActive: true,
          });
        }
      }

      // Determine aggregated capabilities from tier mappings
      const hasVision = tierMappings.some(m => m.capabilities?.vision);
      const hasAudio = tierMappings.some(m => m.capabilities?.audio);
      const hasCodeExecution = tierMappings.some(m => m.capabilities?.codeExecution);
      const hasWebSearch = tierMappings.some(m => m.capabilities?.webSearch);

      // One atomic Mongo upsert becomes three statements over two tables, so
      // they share a transaction. `replaceProviderMappings` is a DELETE
      // followed by an INSERT and the gap between them is a real state in
      // which the Clarity model has NO providers — it takes the parent row's
      // lock for that reason, because a transaction gives atomicity and not
      // the SERIALIZATION the single document used to give.
      const inserted = await db.transaction(async (tx) => {
        // Insert-only for the admin-managed columns.
        const seed = await seedClarityModel(tx, {
          clarityModelId: modelId,
          displayName: clarityModel.name,
          tier: clarityModel.tier,
          description: clarityModel.description,
          creditMultiplier: clarityModel.creditMultiplier,
          isFreeTier: clarityModel.creditMultiplier <= 1.0,
          isActive: true,
          isDeprecated: false,
        });

        // `aggregatedCapabilities` was in the source's `$set`, so it is
        // re-derived from the tier mappings on every run — flattened into the
        // five `cap*` columns.
        await patchClarityModel(tx, modelId, {
          capVision: hasVision,
          capAudio: hasAudio,
          capCodeExecution: hasCodeExecution,
          capWebSearch: hasWebSearch,
          capThinking: false,
        });

        await replaceProviderMappings(tx, seed.id, providerMappings);

        return seed.inserted;
      });

      if (inserted) {
        seeded++;
        log.seed.info({ modelId, tier: clarityModel.tier, providers: providerMappings.length }, 'Created ClarityModel');
      } else {
        skipped++;
      }
    } catch (error: unknown) {
      log.seed.error({ err: error, modelId }, 'Error seeding ClarityModel');
    }
  }

  log.seed.info({ seeded, skipped }, 'ClarityModel seeding complete');
  return { seeded, skipped };
}

/**
 * Reset all open circuit breakers to closed state
 */
export async function resetAllCircuitBreakers(): Promise<number> {
  // The source reached the model by BARE NAME STRING
  // (`mongoose.models.ProviderHealth`) and returned 0 when the registry had no
  // entry — logging "skipping" and reporting the same number as a genuinely
  // empty run. Against a table that guard has no meaning and is gone rather
  // than translated: "the model was not loaded" and "there was nothing to
  // reset" must not stay the same silent outcome.
  //
  // Every matched row changes at least one field (the predicate selects
  // non-closed circuits and the update closes them), so Postgres's row count
  // and Mongo's `modifiedCount` agree.
  const count = await resetOpenCircuits(getDb());

  if (count > 0) {
    log.seed.info({ count }, 'Reset open circuit breakers to closed');
  }

  return count;
}

/**
 * Reset all key cooldowns and consecutive failure counters.
 * Prevents stale lockouts from persisting across deploys.
 */
export async function resetAllKeyCooldowns(): Promise<number> {
  // The predicate selects rows with a non-null cooldown OR a positive failure
  // count and the update clears both, so every matched row changes and
  // Postgres's row count means what Mongo's `modifiedCount` meant.
  const count = await resetCooldowns(getDb());

  if (count > 0) {
    log.seed.info({ count }, 'Reset key cooldowns and failure counters');
  }

  return count;
}

/**
 * Run all seed operations on startup
 */
export async function runStartupSeed(): Promise<void> {
  try {
    log.seed.info('Running startup seed operations...');
    await seedModelConfigs();
    await seedClarityModels();
    const { seedPlans } = await import('./seed-plans.js');
    await seedPlans();
    const { seedCreditPackages } = await import('./seed-credit-packages.js');
    await seedCreditPackages();
    const { seedFeatures, seedPlanFeatures } = await import('./seed-features.js');
    await seedFeatures();
    await seedPlanFeatures();
    await resetAllCircuitBreakers();
    await resetAllKeyCooldowns();
    log.seed.info('Startup seed complete');
  } catch (error) {
    log.seed.error({ err: error }, 'Error during startup seed');
  }
}
