/**
 * PlanFeatures API Routes (Admin Only)
 * Manage plan-feature mappings: list, matrix view, upsert, bulk update
 */

import express, { Request, Response } from 'express';
import { getDb } from '../../../db/client.js';
import {
  bulkUpsertMappings,
  deleteMapping,
  listMappings,
  upsertMapping,
} from '../../../repositories/plan-features.js';
import { listFeatures } from '../../../repositories/features.js';
import { listPlans } from '../../../repositories/plans.js';
import { broadcastPlanFeaturesUpdate } from '../lib/broadcast-helpers.js';
import { log } from '../../../lib/logger.js';

const router = express.Router();

/**
 * GET /v1/plan-features?planId=
 * List plan-feature mappings, optionally filtered by planId
 */
router.get('/', async (req: Request, res: Response) => {
  try {
    const { planId } = req.query;

    const mappings = await listMappings(getDb(), {
      planId: planId && typeof planId === 'string' ? planId : undefined,
    });
    res.json({ success: true, count: mappings.length, data: mappings });
  } catch (error: unknown) {
    log.providers.error({ err: error }, 'Error listing plan-features');
    res.status(500).json({ success: false, error: 'An internal error occurred', code: 'INTERNAL_ERROR' });
  }
});

/**
 * GET /v1/plan-features/matrix
 * Full matrix: all plans x all features for the admin grid editor
 */
router.get('/matrix', async (_req: Request, res: Response) => {
  try {
    const db = getDb();
    const [features, plans, mappings] = await Promise.all([
      listFeatures(db, { isActive: true }),
      listPlans(db, { isActive: true }),
      listMappings(db),
    ]);

    // Build lookup: planId:featureId -> mapping
    const mappingMap: Record<string, unknown> = {};
    for (const m of mappings) {
      mappingMap[`${m.planId}:${m.featureId}`] = m;
    }

    res.json({
      success: true,
      data: {
        features,
        plans: plans.map(p => ({ planId: p.planId, name: p.name, product: p.product })),
        mappings: mappingMap,
      },
    });
  } catch (error: unknown) {
    log.providers.error({ err: error }, 'Error building plan-features matrix');
    res.status(500).json({ success: false, error: 'An internal error occurred', code: 'INTERNAL_ERROR' });
  }
});

/**
 * PUT /v1/plan-features/:planId/:featureId
 * Upsert a single plan-feature mapping
 */
router.put('/:planId/:featureId', async (req: Request<{ planId: string; featureId: string }>, res: Response) => {
  try {
    const { planId, featureId } = req.params;
    const { enabled, limitValue, displayLabel, displayDescription } = req.body;

    // A field the caller omitted arrives here as `undefined` and is dropped
    // from the conflict branch's SET clause; an explicit `null` still clears.
    // Writing the undefineds through would erase a feature's limit and its
    // display overrides on a request that only meant to toggle `enabled`.
    const mapping = await upsertMapping(getDb(), {
      planId,
      featureId,
      enabled: enabled ?? true,
      limitValue,
      displayLabel,
      displayDescription,
    });

    res.json({ success: true, data: mapping });
    broadcastPlanFeaturesUpdate();
  } catch (error: unknown) {
    log.providers.error({ err: error }, 'Error upserting plan-feature');
    res.status(500).json({ success: false, error: 'An internal error occurred', code: 'INTERNAL_ERROR' });
  }
});

/**
 * POST /v1/plan-features/bulk
 * Bulk upsert plan-feature mappings from the matrix editor "Save All"
 * Body: { mappings: Array<{ planId, featureId, enabled, limitValue?, displayLabel?, displayDescription? }> }
 */
router.post('/bulk', async (req: Request, res: Response) => {
  try {
    const { mappings } = req.body;
    if (!Array.isArray(mappings)) {
      return res.status(400).json({ success: false, error: 'mappings must be an array', code: 'INVALID_REQUEST' });
    }

    // One transaction, N per-row upserts — the port of Mongo's `bulkWrite`
    // batch. A half-applied matrix is a pricing page that disagrees with
    // itself, and the `upserted`/`modified` pair the editor displays would be a
    // lie about a partial write.
    const result = await bulkUpsertMappings(
      getDb(),
      (mappings as Record<string, unknown>[]).map((m) => ({
        planId: m.planId as string,
        featureId: m.featureId as string,
        enabled: (m.enabled as boolean | undefined) ?? true,
        limitValue: m.limitValue as number | null | undefined,
        displayLabel: m.displayLabel as string | null | undefined,
        displayDescription: m.displayDescription as string | null | undefined,
      })),
    );

    res.json({
      success: true,
      upserted: result.upserted,
      modified: result.modified,
      total: result.total,
    });
    broadcastPlanFeaturesUpdate();
  } catch (error: unknown) {
    log.providers.error({ err: error }, 'Error bulk upserting plan-features');
    res.status(500).json({ success: false, error: 'An internal error occurred', code: 'INTERNAL_ERROR' });
  }
});

/**
 * DELETE /v1/plan-features/:planId/:featureId
 * Remove a single plan-feature mapping
 */
router.delete('/:planId/:featureId', async (req: Request<{ planId: string; featureId: string }>, res: Response) => {
  try {
    const { planId, featureId } = req.params;
    const result = await deleteMapping(getDb(), planId, featureId);
    if (!result) {
      return res.status(404).json({ success: false, error: 'Mapping not found', code: 'MAPPING_NOT_FOUND' });
    }
    res.json({ success: true, message: 'Mapping deleted' });
    broadcastPlanFeaturesUpdate();
  } catch (error: unknown) {
    log.providers.error({ err: error }, 'Error deleting plan-feature');
    res.status(500).json({ success: false, error: 'An internal error occurred', code: 'INTERNAL_ERROR' });
  }
});

export default router;
