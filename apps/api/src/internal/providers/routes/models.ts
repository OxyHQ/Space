/**
 * Models API Routes
 * Handles model configuration management
 */

import express, { Request, Response } from 'express';
import { isForeignKeyViolation } from '@oxyhq/db';
import { getDb } from '../../../db/client.js';
import {
  createModel,
  deleteModel,
  findByProviderModel,
  listByTier,
  listModels,
  patchModel,
} from '../../../repositories/model-configs.js';
import { broadcastModelsUpdate } from '../lib/broadcast-helpers';
import { getErrorMessage, sanitizeMessage } from '../../../lib/errors/index.js';
import { log } from '../../../lib/logger.js';

const router = express.Router();

// Note: Service authentication is applied at mount point in index.ts

/**
 * The columns a client may set, spelled out.
 *
 * The source did `ModelConfig.create(req.body)` and `$set: req.body` — full
 * mass assignment. Against a table an unknown key is also a 500, so this names
 * the writable set once. `provider` and `modelId` are the compound key and are
 * taken from the path or the create body, never patched.
 *
 * ## The wire shape is FLAT, because the row is
 *
 * Mongo nested `capabilities`, `limits`, `pricing` and `defaultConfig` as
 * sub-documents; the table flattens all four into `cap*`, `limit*`, `pricing*`
 * and `default*` columns. Reads already return the flat row, so accepting the
 * nested shape here would leave the route reading one contract and writing
 * another — an asymmetry no caller could guess. Both halves are flat, and the
 * change is named in the port report.
 */
function writableModelFields(body: Record<string, unknown>) {
  return {
    displayName: body.displayName as string | undefined,
    clarityTier: body.clarityTier as string | null | undefined,
    priority: body.priority as number | null | undefined,
    qualityScore: body.qualityScore as number | null | undefined,

    capVision: body.capVision as boolean | undefined,
    capAudio: body.capAudio as boolean | undefined,
    capCodeExecution: body.capCodeExecution as boolean | undefined,
    capWebSearch: body.capWebSearch as boolean | undefined,
    capComputerUse: body.capComputerUse as boolean | undefined,
    capThinking: body.capThinking as boolean | undefined,
    capStreaming: body.capStreaming as boolean | undefined,
    capFunctionCalling: body.capFunctionCalling as boolean | undefined,
    capJsonMode: body.capJsonMode as boolean | undefined,
    capPromptCaching: body.capPromptCaching as boolean | undefined,

    limitMaxContextTokens: body.limitMaxContextTokens as number | undefined,
    limitMaxOutputTokens: body.limitMaxOutputTokens as number | undefined,
    limitMaxImages: body.limitMaxImages as number | null | undefined,
    limitMaxAudioSeconds: body.limitMaxAudioSeconds as number | null | undefined,

    pricingTier: body.pricingTier as string | undefined,
    pricingCostPer1MInput: body.pricingCostPer1MInput as number | undefined,
    pricingCostPer1MOutput: body.pricingCostPer1MOutput as number | undefined,
    pricingCostPer1MCachedInput: body.pricingCostPer1MCachedInput as number | null | undefined,
    pricingAverageLatencyMs: body.pricingAverageLatencyMs as number | undefined,

    defaultTemperature: body.defaultTemperature as number | null | undefined,
    defaultTopP: body.defaultTopP as number | null | undefined,
    defaultMaxTokens: body.defaultMaxTokens as number | null | undefined,
    defaultSystemPrompt: body.defaultSystemPrompt as string | null | undefined,

    isActive: body.isActive as boolean | undefined,
    isDeprecated: body.isDeprecated as boolean | undefined,
    // `timestamptz` hands TypeScript a `Date`; a JSON body carries a string, so
    // the conversion is here rather than at the driver, where it would fail.
    deprecationDate: typeof body.deprecationDate === 'string'
      ? new Date(body.deprecationDate)
      : (body.deprecationDate as Date | null | undefined),
    replacementModelId: body.replacementModelId as string | null | undefined,

    description: body.description as string | null | undefined,
    providerUrl: body.providerUrl as string | null | undefined,
    notes: body.notes as string | null | undefined,
  };
}

/**
 * GET /v1/models
 * List all model configurations with optional filtering
 */
router.get('/', async (req: Request, res: Response) => {
  try {
    const { provider, clarityTier, active, deprecated } = req.query;

    const models = await listModels(getDb(), {
      provider: typeof provider === 'string' ? provider : undefined,
      clarityTier: typeof clarityTier === 'string' ? clarityTier : undefined,
      isActive: active !== undefined ? active === 'true' : undefined,
      isDeprecated: deprecated !== undefined ? deprecated === 'true' : undefined,
    });

    res.json({
      success: true,
      count: models.length,
      data: models,
    });
  } catch (error: unknown) {
    log.models.error({ err: error }, 'Error listing models');
    res.status(500).json({
      success: false,
      error: sanitizeMessage(getErrorMessage(error)),
      code: 'INTERNAL_ERROR',
    });
  }
});

/**
 * GET /v1/models/by-tier/:tier
 * Get all models for a specific Clarity tier
 */
router.get('/by-tier/:tier', async (req: Request<{ tier: string }>, res: Response) => {
  try {
    const { tier } = req.params;

    const models = await listByTier(getDb(), tier);

    res.json({
      success: true,
      tier,
      count: models.length,
      data: models,
    });
  } catch (error: unknown) {
    log.models.error({ err: error }, 'Error getting models by tier');
    res.status(500).json({
      success: false,
      error: sanitizeMessage(getErrorMessage(error)),
      code: 'INTERNAL_ERROR',
    });
  }
});

/**
 * GET /v1/models/:provider/:modelId
 * Get specific model configuration
 */
router.get('/:provider/:modelId', async (req: Request<{ provider: string; modelId: string }>, res: Response) => {
  try {
    const { provider, modelId } = req.params;

    const model = await findByProviderModel(getDb(), provider, modelId);

    if (!model) {
      return res.status(404).json({
        success: false,
        error: 'Model not found',
        code: 'MODEL_NOT_FOUND',
      });
    }

    res.json({
      success: true,
      data: model,
    });
  } catch (error: unknown) {
    log.models.error({ err: error }, 'Error getting model');
    res.status(500).json({
      success: false,
      error: sanitizeMessage(getErrorMessage(error)),
      code: 'INTERNAL_ERROR',
    });
  }
});

/**
 * POST /v1/models
 * Create new model configuration (admin only)
 */
router.post('/', async (req: Request, res: Response) => {
  try {
    const { provider, modelId } = req.body;

    if (typeof provider !== 'string' || typeof modelId !== 'string') {
      return res.status(400).json({
        success: false,
        error: 'provider and modelId are required',
        code: 'INVALID_REQUEST',
      });
    }

    const db = getDb();

    // Check if model already exists
    const existing = await findByProviderModel(db, provider, modelId);

    if (existing) {
      return res.status(409).json({
        success: false,
        error: 'Model already exists',
        code: 'MODEL_ALREADY_EXISTS',
      });
    }

    // Create new model
    const model = await createModel(db, {
      ...writableModelFields(req.body),
      provider,
      modelId,
    });

    res.status(201).json({
      success: true,
      data: model,
    });

    broadcastModelsUpdate(provider);
  } catch (error: unknown) {
    log.models.error({ err: error }, 'Error creating model');
    res.status(500).json({
      success: false,
      error: sanitizeMessage(getErrorMessage(error)),
      code: 'INTERNAL_ERROR',
    });
  }
});

/**
 * PATCH /v1/models/:provider/:modelId
 * Update model configuration (admin only)
 */
router.patch('/:provider/:modelId', async (req: Request<{ provider: string; modelId: string }>, res: Response) => {
  try {
    const { provider, modelId } = req.params;
    // `provider` and `modelId` are absent from the whitelist, which is what the
    // source's two `delete` statements achieved.
    const updates = writableModelFields(req.body);

    const model = await patchModel(getDb(), provider, modelId, updates);

    if (!model) {
      return res.status(404).json({
        success: false,
        error: 'Model not found',
        code: 'MODEL_NOT_FOUND',
      });
    }

    res.json({
      success: true,
      data: model,
    });

    broadcastModelsUpdate(provider);
  } catch (error: unknown) {
    log.models.error({ err: error }, 'Error updating model');
    res.status(500).json({
      success: false,
      error: sanitizeMessage(getErrorMessage(error)),
      code: 'INTERNAL_ERROR',
    });
  }
});

/**
 * DELETE /v1/models/:provider/:modelId
 * Delete model configuration (admin only)
 */
router.delete('/:provider/:modelId', async (req: Request<{ provider: string; modelId: string }>, res: Response) => {
  try {
    const { provider, modelId } = req.params;

    const model = await deleteModel(getDb(), provider, modelId);

    if (!model) {
      return res.status(404).json({
        success: false,
        error: 'Model not found',
        code: 'MODEL_NOT_FOUND',
      });
    }

    res.json({
      success: true,
      message: 'Model deleted successfully',
    });

    broadcastModelsUpdate(provider);
  } catch (error: unknown) {
    // `clarity_model_provider_mappings.model_config_id` is `onDelete: 'restrict'`,
    // so a provider model a Clarity model still maps to cannot be deleted. In
    // Mongo the delete succeeded and left the mapping dangling; here it fails
    // loudly and the caller unmaps first. 409 rather than 500 — the request is
    // well formed, the state refuses it.
    if (isForeignKeyViolation(error)) {
      return res.status(409).json({
        success: false,
        error: 'Model is still mapped by a Clarity model. Remove those mappings first.',
        code: 'MODEL_IN_USE',
      });
    }
    log.models.error({ err: error }, 'Error deleting model');
    res.status(500).json({
      success: false,
      error: sanitizeMessage(getErrorMessage(error)),
      code: 'INTERNAL_ERROR',
    });
  }
});

export default router;
