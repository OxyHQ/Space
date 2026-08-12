/**
 * Clarity Models API Routes (Admin Only)
 * Handles virtual Clarity model management with provider mappings
 */

import express, { Request, Response } from 'express';
import { getDb } from '../../../db/client.js';
import {
  createModel,
  deleteModel,
  findBySlug,
  listModels,
  listProviderMappings,
  listProviderMappingsForModels,
  patchModel,
  replaceProviderMappings,
  type ClarityModelRow,
  type ProviderMappingInput,
  type ProviderMappingRow,
} from '../../../repositories/clarity-models.js';
import { findByProviderModel } from '../../../repositories/model-configs.js';
import { broadcastClarityModelsUpdate } from '../lib/broadcast-helpers';
import { log } from '../../../lib/logger.js';

const router = express.Router();

// Valid tier names
const VALID_TIERS = [
  'lite', 'v1', 'v1-codea', 'v1-cowork', 'v1-browser',
  'v1-vision', 'v1-audio', 'v1-tts', 'v1-multimodal', 'v1-pro', 'v1-pro-max',
  'v1-voice', 'v1-voice-pro',
];

/**
 * The columns a client may set, spelled out.
 *
 * The source's PATCH spread `req.body` into `$set`, so a caller could write
 * `totalRequests`, `totalTokens` and `averageLatencyMs` — lifetime counters the
 * routing layer maintains. They are absent here: a client editing a model's
 * definition has no business rewriting its usage history, and the source's own
 * POST never accepted them either. That narrowing is named in the port report.
 *
 * `aggregatedCapabilities` was a sub-document and is now five `cap*` columns;
 * the wire shape is flat on both halves, for the reason spelled out in
 * `routes/models.ts`.
 */
function writableClarityModelFields(body: Record<string, unknown>) {
  return {
    displayName: body.displayName as string | undefined,
    tier: body.tier as string | undefined,
    description: body.description as string | null | undefined,
    features: body.features as string[] | undefined,
    creditMultiplier: body.creditMultiplier as number | undefined,
    isFreeTier: body.isFreeTier as boolean | undefined,

    capVision: body.capVision as boolean | undefined,
    capAudio: body.capAudio as boolean | undefined,
    capCodeExecution: body.capCodeExecution as boolean | undefined,
    capWebSearch: body.capWebSearch as boolean | undefined,
    capThinking: body.capThinking as boolean | undefined,

    isActive: body.isActive as boolean | undefined,
    isDeprecated: body.isDeprecated as boolean | undefined,
    isLegacy: body.isLegacy as boolean | undefined,
    deprecationDate: typeof body.deprecationDate === 'string'
      ? new Date(body.deprecationDate)
      : (body.deprecationDate as Date | null | undefined),
    replacementModelId: body.replacementModelId as string | null | undefined,

    notes: body.notes as string | null | undefined,
  };
}

/** What the source's embedded `providerMappings` array carried, per element. */
interface ProviderMappingBody {
  provider?: unknown;
  modelId?: unknown;
  priority?: unknown;
  qualityScore?: unknown;
  isActive?: unknown;
}

/**
 * The 400 body a mapping list earned, when it earned one.
 *
 * A `{ ok: true } | { ok: false }` union would be the obvious shape and does
 * not narrow here: this package compiles with `strict: false`, so a boolean
 * discriminant buys nothing. `failure` being present or absent is checked the
 * same way under either setting.
 */
interface ResolvedMappings {
  mappings: ProviderMappingInput[];
  failure?: { error: string; code: string };
}

/**
 * Resolve each supplied mapping to a real `model_configs` row.
 *
 * `clarity_model_provider_mappings.model_config_id` is a foreign key, so an
 * unresolvable mapping must be refused before the write rather than becoming a
 * 500. The source resolved the same lookup to fill `modelConfigId`; the only
 * change is that failing to resolve is now enforced by the database too.
 */
async function resolveMappings(
  mappings: readonly ProviderMappingBody[],
): Promise<ResolvedMappings> {
  const db = getDb();
  const resolved: ProviderMappingInput[] = [];

  for (const mapping of mappings) {
    if (
      typeof mapping.provider !== 'string' ||
      typeof mapping.modelId !== 'string' ||
      mapping.priority === undefined
    ) {
      return {
        mappings: [],
        failure: {
          error: 'Each provider mapping requires provider, modelId, and priority',
          code: 'INVALID_REQUEST',
        },
      };
    }

    const modelConfig = await findByProviderModel(db, mapping.provider, mapping.modelId);
    if (!modelConfig) {
      return {
        mappings: [],
        failure: {
          error: `Provider model not found: ${mapping.provider}/${mapping.modelId}. Add it as a provider model first.`,
          code: 'PROVIDER_MODEL_NOT_FOUND',
        },
      };
    }

    resolved.push({
      modelConfigId: modelConfig.id,
      provider: mapping.provider,
      modelId: mapping.modelId,
      priority: mapping.priority as number,
      // The source read `qualityScore` off the mapping and the column is NOT
      // NULL; the provider model's own score is the value the seed uses for it.
      qualityScore: (mapping.qualityScore as number | undefined) ?? modelConfig.qualityScore ?? 0,
      isActive: mapping.isActive as boolean | undefined,
    });
  }

  return { mappings: resolved };
}

/** Reattach each model's mappings, which the source carried inside the document. */
function withMappings(models: ClarityModelRow[], mappings: ProviderMappingRow[]) {
  const byModel = new Map<string, ProviderMappingRow[]>();
  for (const mapping of mappings) {
    const bucket = byModel.get(mapping.clarityModelId);
    if (bucket) bucket.push(mapping);
    else byModel.set(mapping.clarityModelId, [mapping]);
  }
  return models.map((model) => ({ ...model, providerMappings: byModel.get(model.id) ?? [] }));
}

/**
 * GET /v1/clarity-models
 * List all Clarity virtual models
 */
router.get('/', async (req: Request, res: Response) => {
  try {
    const { tier, active } = req.query;

    const db = getDb();
    const models = await listModels(db, {
      tier: tier && typeof tier === 'string' ? tier : undefined,
      isActive: active !== undefined ? active === 'true' : undefined,
    });
    const mappings = await listProviderMappingsForModels(db, models.map((m) => m.id));

    res.json({
      success: true,
      count: models.length,
      data: withMappings(models, mappings),
    });
  } catch (error: unknown) {
    log.providers.error({ err: error }, 'Error listing Clarity models');
    res.status(500).json({
      success: false,
      error: 'An internal error occurred',
      code: 'INTERNAL_ERROR',
    });
  }
});

/**
 * GET /v1/clarity-models/:clarityModelId
 * Get specific Clarity model with its provider mappings
 */
router.get('/:clarityModelId', async (req: Request<{ clarityModelId: string }>, res: Response) => {
  try {
    const { clarityModelId } = req.params;

    const db = getDb();
    const model = await findBySlug(db, clarityModelId);

    if (!model) {
      return res.status(404).json({
        success: false,
        error: 'Clarity model not found',
        code: 'MODEL_NOT_FOUND',
      });
    }

    const providerMappings = await listProviderMappings(db, model.id);

    res.json({
      success: true,
      data: { ...model, providerMappings },
    });
  } catch (error: unknown) {
    log.providers.error({ err: error }, 'Error getting Clarity model');
    res.status(500).json({
      success: false,
      error: 'An internal error occurred',
      code: 'INTERNAL_ERROR',
    });
  }
});

/**
 * POST /v1/clarity-models
 * Create new Clarity virtual model
 */
router.post('/', async (req: Request, res: Response) => {
  try {
    const { clarityModelId, displayName, tier, providerMappings } = req.body;

    if (!clarityModelId || !displayName || !tier) {
      return res.status(400).json({
        success: false,
        error: 'clarityModelId, displayName, and tier are required',
        code: 'INVALID_REQUEST',
      });
    }

    if (!VALID_TIERS.includes(tier)) {
      return res.status(400).json({
        success: false,
        error: `tier must be one of: ${VALID_TIERS.join(', ')}`,
        code: 'INVALID_REQUEST',
      });
    }

    const db = getDb();

    // Check for duplicate
    const existing = await findBySlug(db, clarityModelId.toLowerCase());
    if (existing) {
      return res.status(409).json({
        success: false,
        error: 'Clarity model with this ID already exists',
        code: 'MODEL_ALREADY_EXISTS',
      });
    }

    // Validate provider mappings if provided
    let mappings: ProviderMappingInput[] = [];
    if (Array.isArray(providerMappings)) {
      const resolvedMappings = await resolveMappings(providerMappings);
      if (resolvedMappings.failure) {
        return res.status(400).json({ success: false, ...resolvedMappings.failure });
      }
      mappings = resolvedMappings.mappings;
    }

    // The model and its mappings were ONE atomic Mongo insert. Two statements
    // here, so they share a transaction — a model that exists with no providers
    // is a routing target the fallback engine resolves to nothing.
    const created = await db.transaction(async (tx) => {
      const model = await createModel(tx, {
        ...writableClarityModelFields(req.body),
        clarityModelId: clarityModelId.toLowerCase(),
        displayName,
        tier,
      });
      const rows = await replaceProviderMappings(tx, model.id, mappings);
      return { ...model, providerMappings: rows };
    });

    res.status(201).json({
      success: true,
      data: created,
    });

    broadcastClarityModelsUpdate();
  } catch (error: unknown) {
    log.providers.error({ err: error }, 'Error creating Clarity model');
    res.status(500).json({
      success: false,
      error: 'An internal error occurred',
      code: 'INTERNAL_ERROR',
    });
  }
});

/**
 * PATCH /v1/clarity-models/:clarityModelId
 * Update Clarity model configuration
 */
router.patch('/:clarityModelId', async (req: Request<{ clarityModelId: string }>, res: Response) => {
  try {
    const { clarityModelId } = req.params;
    // `clarityModelId` is absent from the whitelist, which is what the source's
    // `delete updates.clarityModelId` achieved.
    const updates = writableClarityModelFields(req.body);
    const { providerMappings } = req.body;

    // Validate tier if being updated
    if (updates.tier && !VALID_TIERS.includes(updates.tier)) {
      return res.status(400).json({
        success: false,
        error: `tier must be one of: ${VALID_TIERS.join(', ')}`,
        code: 'INVALID_REQUEST',
      });
    }

    // Validate provider mappings if being updated
    let mappings: ProviderMappingInput[] | null = null;
    if (Array.isArray(providerMappings)) {
      const resolvedMappings = await resolveMappings(providerMappings);
      if (resolvedMappings.failure) {
        return res.status(400).json({ success: false, ...resolvedMappings.failure });
      }
      mappings = resolvedMappings.mappings;
    }

    const db = getDb();

    // The source set the whole array in one atomic `$set` alongside the other
    // fields. Here the patch and the replace are two statements over two
    // tables, so they share a transaction; `replaceProviderMappings` takes the
    // parent row's lock, because a transaction gives atomicity and not the
    // SERIALIZATION the single document used to give.
    const updated = await db.transaction(async (tx) => {
      const model = await patchModel(tx, clarityModelId, updates);
      if (!model) return null;

      const rows = mappings === null
        ? await listProviderMappings(tx, model.id)
        : await replaceProviderMappings(tx, model.id, mappings);

      return { ...model, providerMappings: rows };
    });

    if (!updated) {
      return res.status(404).json({
        success: false,
        error: 'Clarity model not found',
        code: 'MODEL_NOT_FOUND',
      });
    }

    res.json({
      success: true,
      data: updated,
    });

    broadcastClarityModelsUpdate();
  } catch (error: unknown) {
    log.providers.error({ err: error }, 'Error updating Clarity model');
    res.status(500).json({
      success: false,
      error: 'An internal error occurred',
      code: 'INTERNAL_ERROR',
    });
  }
});

/**
 * DELETE /v1/clarity-models/:clarityModelId
 * Delete Clarity virtual model
 */
router.delete('/:clarityModelId', async (req: Request<{ clarityModelId: string }>, res: Response) => {
  try {
    const { clarityModelId } = req.params;

    // The mappings go with it: `clarity_model_id` is `onDelete: 'cascade'`,
    // which is what deleting the document did to its embedded array.
    const model = await deleteModel(getDb(), clarityModelId);

    if (!model) {
      return res.status(404).json({
        success: false,
        error: 'Clarity model not found',
        code: 'MODEL_NOT_FOUND',
      });
    }

    res.json({
      success: true,
      message: 'Clarity model deleted successfully',
    });

    broadcastClarityModelsUpdate();
  } catch (error: unknown) {
    log.providers.error({ err: error }, 'Error deleting Clarity model');
    res.status(500).json({
      success: false,
      error: 'An internal error occurred',
      code: 'INTERNAL_ERROR',
    });
  }
});

export default router;
