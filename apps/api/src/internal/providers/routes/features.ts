/**
 * Features API Routes (Admin Only)
 * CRUD for canonical feature definitions
 */

import express, { Request, Response } from 'express';
import { getDb } from '../../../db/client.js';
import {
  createFeature,
  deleteFeature,
  findBySlug,
  listFeatures,
  patchFeature,
} from '../../../repositories/features.js';
import { broadcastFeaturesUpdate } from '../lib/broadcast-helpers.js';
import { log } from '../../../lib/logger.js';

const router = express.Router();

/**
 * The columns a client may set, spelled out.
 *
 * The source spread `...rest` into `Feature.create()` and `{ ...req.body }` into
 * `$set`, so any key a caller invented was written. Against a table that is both
 * mass assignment and a 500 on the first unknown column; the repository's insert
 * type names the columns, and this names the subset a REQUEST may carry.
 * `featureId` is not here — it is the key, taken from the path or validated
 * separately, never patched.
 */
function writableFeatureFields(body: Record<string, unknown>) {
  return {
    label: body.label as string | undefined,
    description: body.description as string | null | undefined,
    icon: body.icon as string | null | undefined,
    category: body.category as string | undefined,
    featureType: body.featureType as string | undefined,
    sortOrder: body.sortOrder as number | undefined,
    isVisibleOnPricing: body.isVisibleOnPricing as boolean | undefined,
    isActive: body.isActive as boolean | undefined,
  };
}

/**
 * GET /v1/features
 */
router.get('/', async (req: Request, res: Response) => {
  try {
    const { category, active } = req.query;

    const features = await listFeatures(getDb(), {
      category: category && typeof category === 'string' ? category : undefined,
      isActive: active !== undefined ? active === 'true' : undefined,
    });
    res.json({ success: true, count: features.length, data: features });
  } catch (error: unknown) {
    log.providers.error({ err: error }, 'Error listing features');
    res.status(500).json({ success: false, error: 'An internal error occurred', code: 'INTERNAL_ERROR' });
  }
});

/**
 * GET /v1/features/:featureId
 */
router.get('/:featureId', async (req: Request<{ featureId: string }>, res: Response) => {
  try {
    const feature = await findBySlug(getDb(), req.params.featureId);
    if (!feature) {
      return res.status(404).json({ success: false, error: 'Feature not found', code: 'FEATURE_NOT_FOUND' });
    }
    res.json({ success: true, data: feature });
  } catch (error: unknown) {
    log.providers.error({ err: error }, 'Error getting feature');
    res.status(500).json({ success: false, error: 'An internal error occurred', code: 'INTERNAL_ERROR' });
  }
});

/**
 * POST /v1/features
 */
router.post('/', async (req: Request, res: Response) => {
  try {
    const { featureId, label, category, featureType } = req.body;

    if (!featureId || !label || !category) {
      return res.status(400).json({ success: false, error: 'featureId, label, and category are required', code: 'INVALID_REQUEST' });
    }
    if (featureType && !['boolean', 'limit'].includes(featureType)) {
      return res.status(400).json({ success: false, error: 'featureType must be "boolean" or "limit"', code: 'INVALID_REQUEST' });
    }

    const db = getDb();
    const existing = await findBySlug(db, featureId.toLowerCase());
    if (existing) {
      return res.status(409).json({ success: false, error: 'Feature with this ID already exists', code: 'FEATURE_ALREADY_EXISTS' });
    }

    const feature = await createFeature(db, {
      ...writableFeatureFields(req.body),
      featureId: featureId.toLowerCase(),
      label,
      category,
      featureType: featureType || 'boolean',
    });

    res.status(201).json({ success: true, data: feature });
    broadcastFeaturesUpdate();
  } catch (error: unknown) {
    log.providers.error({ err: error }, 'Error creating feature');
    res.status(500).json({ success: false, error: 'An internal error occurred', code: 'INTERNAL_ERROR' });
  }
});

/**
 * PATCH /v1/features/:featureId
 */
router.patch('/:featureId', async (req: Request<{ featureId: string }>, res: Response) => {
  try {
    // `featureId` is deliberately absent from the whitelist, which is what the
    // source's `delete updates.featureId` achieved.
    const updates = writableFeatureFields(req.body);

    if (updates.featureType && !['boolean', 'limit'].includes(updates.featureType)) {
      return res.status(400).json({ success: false, error: 'featureType must be "boolean" or "limit"', code: 'INVALID_REQUEST' });
    }

    // A key the caller did not send is `undefined` and never reaches the SET
    // clause; an explicit `null` still clears. That is Mongoose's update
    // semantics, and writing the undefineds through would blank every column
    // the caller did not mention.
    const feature = await patchFeature(getDb(), req.params.featureId, updates);

    if (!feature) {
      return res.status(404).json({ success: false, error: 'Feature not found', code: 'FEATURE_NOT_FOUND' });
    }

    res.json({ success: true, data: feature });
    broadcastFeaturesUpdate();
  } catch (error: unknown) {
    log.providers.error({ err: error }, 'Error updating feature');
    res.status(500).json({ success: false, error: 'An internal error occurred', code: 'INTERNAL_ERROR' });
  }
});

/**
 * DELETE /v1/features/:featureId
 */
router.delete('/:featureId', async (req: Request<{ featureId: string }>, res: Response) => {
  try {
    const feature = await deleteFeature(getDb(), req.params.featureId);
    if (!feature) {
      return res.status(404).json({ success: false, error: 'Feature not found', code: 'FEATURE_NOT_FOUND' });
    }
    res.json({ success: true, message: 'Feature deleted successfully' });
    broadcastFeaturesUpdate();
  } catch (error: unknown) {
    log.providers.error({ err: error }, 'Error deleting feature');
    res.status(500).json({ success: false, error: 'An internal error occurred', code: 'INTERNAL_ERROR' });
  }
});

export default router;
