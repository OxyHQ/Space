/**
 * Plans API Routes (Admin Only)
 * CRUD for subscription plan definitions
 */

import express, { Request, Response } from 'express';
import { getDb } from '../../../db/client.js';
import {
  createPlan,
  deletePlan,
  findBySlug,
  listPlans,
  patchPlan,
} from '../../../repositories/plans.js';
import { findExistingSlugs } from '../../../repositories/clarity-models.js';
import { broadcastPlansUpdate } from '../lib/broadcast-helpers.js';
import { log } from '../../../lib/logger.js';

const router = express.Router();

/**
 * The columns a client may set. See the note in `routes/features.ts`.
 * `planId` is the key and is never patched.
 */
function writablePlanFields(body: Record<string, unknown>) {
  return {
    name: body.name as string | undefined,
    product: body.product as string | undefined,
    creditsPerMonth: body.creditsPerMonth as number | undefined,
    dailyFreeCredits: body.dailyFreeCredits as number | undefined,
    monthlyPrice: body.monthlyPrice as number | undefined,
    annualPrice: body.annualPrice as number | undefined,
    currency: body.currency as string | undefined,
    subtitle: body.subtitle as string | undefined,
    creditsLabel: body.creditsLabel as string | undefined,
    isFeatured: body.isFeatured as boolean | undefined,
    sortOrder: body.sortOrder as number | undefined,
    modelIds: body.modelIds as string[] | undefined,
    isActive: body.isActive as boolean | undefined,
    isFree: body.isFree as boolean | undefined,
    stripeProductId: body.stripeProductId as string | null | undefined,
    stripeMonthlyPriceId: body.stripeMonthlyPriceId as string | null | undefined,
    stripeAnnualPriceId: body.stripeAnnualPriceId as string | null | undefined,
    description: body.description as string | null | undefined,
    notes: body.notes as string | null | undefined,
  };
}

/**
 * Which of these ids name no Clarity model?
 *
 * The source filtered `ClarityModel` on `modelId`, a field that model does not
 * have — the slug is `clarityModelId`. In Mongo a filter on an absent path
 * matches nothing, so `validModels` was always empty and every non-empty
 * `modelIds` array was rejected with `INVALID_MODEL_IDS`. Matching on the real
 * column is what both call sites plainly meant, so this validation starts
 * working here; it is named in the port report because "always rejects" to
 * "accepts valid input" is a behaviour change even when it is the intended one.
 */
async function invalidModelIds(modelIds: readonly string[]): Promise<string[]> {
  const existing = new Set(await findExistingSlugs(getDb(), modelIds));
  return modelIds.filter((id) => !existing.has(id.toLowerCase()));
}

/**
 * GET /v1/plans
 * List all plans, optionally filtered by product and active status
 */
router.get('/', async (req: Request, res: Response) => {
  try {
    const { product, active } = req.query;

    const plans = await listPlans(getDb(), {
      product: product && typeof product === 'string' ? product : undefined,
      isActive: active !== undefined ? active === 'true' : undefined,
    });

    res.json({
      success: true,
      count: plans.length,
      data: plans,
    });
  } catch (error: unknown) {
    log.providers.error({ err: error }, 'Error listing plans');
    res.status(500).json({
      success: false,
      error: 'An internal error occurred',
      code: 'INTERNAL_ERROR',
    });
  }
});

/**
 * GET /v1/plans/:planId
 * Get specific plan
 */
router.get('/:planId', async (req: Request<{ planId: string }>, res: Response) => {
  try {
    const { planId } = req.params;
    const plan = await findBySlug(getDb(), planId);

    if (!plan) {
      return res.status(404).json({
        success: false,
        error: 'Plan not found',
        code: 'PLAN_NOT_FOUND',
      });
    }

    res.json({
      success: true,
      data: plan,
    });
  } catch (error: unknown) {
    log.providers.error({ err: error }, 'Error getting plan');
    res.status(500).json({
      success: false,
      error: 'An internal error occurred',
      code: 'INTERNAL_ERROR',
    });
  }
});

/**
 * POST /v1/plans
 * Create new plan
 */
router.post('/', async (req: Request, res: Response) => {
  try {
    const { planId, name, product, creditsPerMonth, monthlyPrice, annualPrice, currency } = req.body;

    if (!planId || !name || !product) {
      return res.status(400).json({
        success: false,
        error: 'planId, name, and product are required',
        code: 'INVALID_REQUEST',
      });
    }

    if (!['clarity', 'codea'].includes(product)) {
      return res.status(400).json({
        success: false,
        error: 'product must be "clarity" or "codea"',
        code: 'INVALID_REQUEST',
      });
    }

    if ((typeof creditsPerMonth === 'number' && creditsPerMonth < 0) ||
        (typeof monthlyPrice === 'number' && monthlyPrice < 0) ||
        (typeof annualPrice === 'number' && annualPrice < 0)) {
      return res.status(400).json({
        success: false,
        error: 'creditsPerMonth, monthlyPrice, and annualPrice must not be negative',
        code: 'INVALID_REQUEST',
      });
    }

    const db = getDb();
    const existing = await findBySlug(db, planId.toLowerCase());
    if (existing) {
      return res.status(409).json({
        success: false,
        error: 'Plan with this ID already exists',
        code: 'PLAN_ALREADY_EXISTS',
      });
    }

    const fields = writablePlanFields(req.body);

    if (Array.isArray(fields.modelIds) && fields.modelIds.length > 0) {
      const invalid = await invalidModelIds(fields.modelIds);
      if (invalid.length > 0) {
        return res.status(400).json({
          success: false,
          error: `Invalid modelIds: ${invalid.join(', ')}`,
          code: 'INVALID_MODEL_IDS',
        });
      }
    }

    const plan = await createPlan(db, {
      ...fields,
      planId: planId.toLowerCase(),
      name,
      product,
      creditsPerMonth: creditsPerMonth || 0,
      monthlyPrice: monthlyPrice || 0,
      annualPrice: annualPrice || 0,
      currency: currency || 'usd',
    });

    res.status(201).json({
      success: true,
      data: plan,
    });

    broadcastPlansUpdate();
  } catch (error: unknown) {
    log.providers.error({ err: error }, 'Error creating plan');
    res.status(500).json({
      success: false,
      error: 'An internal error occurred',
      code: 'INTERNAL_ERROR',
    });
  }
});

/**
 * PATCH /v1/plans/:planId
 * Update plan configuration
 */
router.patch('/:planId', async (req: Request<{ planId: string }>, res: Response) => {
  try {
    const { planId } = req.params;
    // `planId` is absent from the whitelist, which is what the source's
    // `delete updates.planId` achieved.
    const updates = writablePlanFields(req.body);

    if (updates.product && !['clarity', 'codea'].includes(updates.product)) {
      return res.status(400).json({
        success: false,
        error: 'product must be "clarity" or "codea"',
        code: 'INVALID_REQUEST',
      });
    }

    if ((typeof updates.creditsPerMonth === 'number' && updates.creditsPerMonth < 0) ||
        (typeof updates.monthlyPrice === 'number' && updates.monthlyPrice < 0) ||
        (typeof updates.annualPrice === 'number' && updates.annualPrice < 0)) {
      return res.status(400).json({
        success: false,
        error: 'creditsPerMonth, monthlyPrice, and annualPrice must not be negative',
        code: 'INVALID_REQUEST',
      });
    }

    if (Array.isArray(updates.modelIds) && updates.modelIds.length > 0) {
      const invalid = await invalidModelIds(updates.modelIds);
      if (invalid.length > 0) {
        return res.status(400).json({
          success: false,
          error: `Invalid modelIds: ${invalid.join(', ')}`,
          code: 'INVALID_MODEL_IDS',
        });
      }
    }

    const plan = await patchPlan(getDb(), planId, updates);

    if (!plan) {
      return res.status(404).json({
        success: false,
        error: 'Plan not found',
        code: 'PLAN_NOT_FOUND',
      });
    }

    res.json({
      success: true,
      data: plan,
    });

    broadcastPlansUpdate();
  } catch (error: unknown) {
    log.providers.error({ err: error }, 'Error updating plan');
    res.status(500).json({
      success: false,
      error: 'An internal error occurred',
      code: 'INTERNAL_ERROR',
    });
  }
});

/**
 * DELETE /v1/plans/:planId
 * Delete plan
 */
router.delete('/:planId', async (req: Request<{ planId: string }>, res: Response) => {
  try {
    const { planId } = req.params;

    const plan = await deletePlan(getDb(), planId);

    if (!plan) {
      return res.status(404).json({
        success: false,
        error: 'Plan not found',
        code: 'PLAN_NOT_FOUND',
      });
    }

    res.json({
      success: true,
      message: 'Plan deleted successfully',
    });

    broadcastPlansUpdate();
  } catch (error: unknown) {
    log.providers.error({ err: error }, 'Error deleting plan');
    res.status(500).json({
      success: false,
      error: 'An internal error occurred',
      code: 'INTERNAL_ERROR',
    });
  }
});

export default router;
