/**
 * CreditPackages API Routes (Admin Only)
 * CRUD for one-time credit purchase packages
 */

import express, { Request, Response } from 'express';
import { getDb } from '../../../db/client.js';
import {
  createPackage,
  deletePackage,
  findBySlug,
  listPackages,
  patchPackage,
} from '../../../repositories/credit-packages.js';
import { broadcastCreditPackagesUpdate } from '../lib/broadcast-helpers.js';
import { log } from '../../../lib/logger.js';

const router = express.Router();

/**
 * The columns a client may set. See the note in `routes/features.ts` — the
 * source spread `...rest` and `{ ...req.body }`, which against a table is mass
 * assignment. `packageId` is the key and is never patched.
 */
function writablePackageFields(body: Record<string, unknown>) {
  return {
    name: body.name as string | undefined,
    credits: body.credits as number | undefined,
    price: body.price as number | undefined,
    currency: body.currency as string | undefined,
    stripePriceId: body.stripePriceId as string | null | undefined,
    sortOrder: body.sortOrder as number | undefined,
    isActive: body.isActive as boolean | undefined,
    description: body.description as string | null | undefined,
  };
}

/**
 * GET /v1/credit-packages
 * List all credit packages, optionally filtered by active status
 */
router.get('/', async (req: Request, res: Response) => {
  try {
    const { active } = req.query;

    const packages = await listPackages(getDb(), {
      isActive: active !== undefined ? active === 'true' : undefined,
    });

    res.json({
      success: true,
      count: packages.length,
      data: packages,
    });
  } catch (error: unknown) {
    log.providers.error({ err: error }, 'Error listing credit packages');
    res.status(500).json({
      success: false,
      error: 'An internal error occurred',
      code: 'INTERNAL_ERROR',
    });
  }
});

/**
 * GET /v1/credit-packages/:packageId
 * Get specific credit package
 */
router.get('/:packageId', async (req: Request<{ packageId: string }>, res: Response) => {
  try {
    const { packageId } = req.params;
    const pkg = await findBySlug(getDb(), packageId);

    if (!pkg) {
      return res.status(404).json({
        success: false,
        error: 'Credit package not found',
        code: 'PACKAGE_NOT_FOUND',
      });
    }

    res.json({
      success: true,
      data: pkg,
    });
  } catch (error: unknown) {
    log.providers.error({ err: error }, 'Error getting credit package');
    res.status(500).json({
      success: false,
      error: 'An internal error occurred',
      code: 'INTERNAL_ERROR',
    });
  }
});

/**
 * POST /v1/credit-packages
 * Create new credit package
 */
router.post('/', async (req: Request, res: Response) => {
  try {
    const { packageId, name, credits, price, currency } = req.body;

    if (!packageId || !name) {
      return res.status(400).json({
        success: false,
        error: 'packageId and name are required',
        code: 'INVALID_REQUEST',
      });
    }

    if (typeof credits !== 'number' || credits < 1) {
      return res.status(400).json({
        success: false,
        error: 'credits must be a positive number',
        code: 'INVALID_REQUEST',
      });
    }

    if (typeof price !== 'number' || price < 0) {
      return res.status(400).json({
        success: false,
        error: 'price must not be negative',
        code: 'INVALID_REQUEST',
      });
    }

    const db = getDb();
    const existing = await findBySlug(db, packageId.toLowerCase());
    if (existing) {
      return res.status(409).json({
        success: false,
        error: 'Credit package with this ID already exists',
        code: 'PACKAGE_ALREADY_EXISTS',
      });
    }

    const pkg = await createPackage(db, {
      ...writablePackageFields(req.body),
      packageId: packageId.toLowerCase(),
      name,
      credits,
      price,
      currency: currency || 'usd',
    });

    res.status(201).json({
      success: true,
      data: pkg,
    });

    broadcastCreditPackagesUpdate();
  } catch (error: unknown) {
    log.providers.error({ err: error }, 'Error creating credit package');
    res.status(500).json({
      success: false,
      error: 'An internal error occurred',
      code: 'INTERNAL_ERROR',
    });
  }
});

/**
 * PATCH /v1/credit-packages/:packageId
 * Update credit package
 */
router.patch('/:packageId', async (req: Request<{ packageId: string }>, res: Response) => {
  try {
    const { packageId } = req.params;
    // `packageId` is absent from the whitelist, which is what the source's
    // `delete updates.packageId` achieved.
    const updates = writablePackageFields(req.body);

    if (typeof updates.credits === 'number' && updates.credits < 1) {
      return res.status(400).json({
        success: false,
        error: 'credits must be a positive number',
        code: 'INVALID_REQUEST',
      });
    }

    if (typeof updates.price === 'number' && updates.price < 0) {
      return res.status(400).json({
        success: false,
        error: 'price must not be negative',
        code: 'INVALID_REQUEST',
      });
    }

    const pkg = await patchPackage(getDb(), packageId, updates);

    if (!pkg) {
      return res.status(404).json({
        success: false,
        error: 'Credit package not found',
        code: 'PACKAGE_NOT_FOUND',
      });
    }

    res.json({
      success: true,
      data: pkg,
    });

    broadcastCreditPackagesUpdate();
  } catch (error: unknown) {
    log.providers.error({ err: error }, 'Error updating credit package');
    res.status(500).json({
      success: false,
      error: 'An internal error occurred',
      code: 'INTERNAL_ERROR',
    });
  }
});

/**
 * DELETE /v1/credit-packages/:packageId
 * Delete credit package
 */
router.delete('/:packageId', async (req: Request<{ packageId: string }>, res: Response) => {
  try {
    const { packageId } = req.params;

    const pkg = await deletePackage(getDb(), packageId);

    if (!pkg) {
      return res.status(404).json({
        success: false,
        error: 'Credit package not found',
        code: 'PACKAGE_NOT_FOUND',
      });
    }

    res.json({
      success: true,
      message: 'Credit package deleted successfully',
    });

    broadcastCreditPackagesUpdate();
  } catch (error: unknown) {
    log.providers.error({ err: error }, 'Error deleting credit package');
    res.status(500).json({
      success: false,
      error: 'An internal error occurred',
      code: 'INTERNAL_ERROR',
    });
  }
});

export default router;
