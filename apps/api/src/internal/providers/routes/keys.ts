/**
 * Keys API Routes (Admin Only)
 * Handles provider API key management
 */

import express, { Request, Response } from 'express';
import crypto from 'crypto';
import { getDb } from '../../../db/client.js';
import {
  countActiveKeys,
  createKey,
  deleteKey,
  findById,
  findByKeyHash,
  findPublicById,
  hashProviderKey,
  listKeys,
  listKeysForDiagnostics,
  patchKey,
  providerKeyPrefix,
  resetCooldowns,
  resetSpend,
  rotateKey,
  setActive,
  type ProviderKeyPatch,
} from '../../../repositories/provider-keys.js';
import { invalidateKeyCache } from '../lib/key-manager';
import { clearHealthCache } from '../lib/provider-health';
import { broadcastKeysUpdate } from '../lib/broadcast-helpers';
import { log } from '../../../lib/logger.js';
import { PROVIDER_NAMES } from '../lib/provider-names.js';

const router = express.Router();

// Note: Service authentication is applied at mount point in index.ts

// Valid provider names (derived from shared constant)
const VALID_PROVIDERS: string[] = [...PROVIDER_NAMES];

// Sanitize string input: must be a non-empty string within length limits
function sanitizeString(value: unknown, maxLength = 200): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  if (trimmed.length === 0 || trimmed.length > maxLength) return null;
  return trimmed;
}

// Sanitize query param: reject objects (NoSQL injection prevention)
function sanitizeQueryParam(value: unknown): string | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== 'string') return undefined;
  return value;
}

/**
 * The rate-limit columns a client may set.
 *
 * Mongo nested these under a `rateLimit` sub-document; the table flattens them
 * into eight nullable columns, where "unset" means "no limit of this kind".
 * Reads already return the flat row, so the write half is flat too — the same
 * decision, for the same reason, as in `routes/models.ts`.
 */
function writableRateLimits(body: Record<string, unknown>) {
  return {
    rateLimitRps: body.rateLimitRps as number | null | undefined,
    rateLimitRpm: body.rateLimitRpm as number | null | undefined,
    rateLimitRph: body.rateLimitRph as number | null | undefined,
    rateLimitRpd: body.rateLimitRpd as number | null | undefined,
    rateLimitTps: body.rateLimitTps as number | null | undefined,
    rateLimitTpm: body.rateLimitTpm as number | null | undefined,
    rateLimitTph: body.rateLimitTph as number | null | undefined,
    rateLimitTpd: body.rateLimitTpd as number | null | undefined,
  };
}

/**
 * POST /v1/keys/reload
 * Invalidate all in-memory caches and reload provider configuration
 */
router.post('/reload', async (req: Request, res: Response) => {
  try {
    // Clear all in-memory caches
    invalidateKeyCache();
    clearHealthCache();

    const db = getDb();

    // Reset all key cooldowns and failure counters.
    //
    // Mongo reported `modifiedCount`; Postgres reports only `rowCount`, which
    // behaves like `matchedCount`. They cannot disagree here — the predicate
    // selects rows with a non-null cooldown or a positive failure count and the
    // update clears both, so every matched row changes. This number is shown to
    // an operator, so an inflation would have been invisible.
    const cooldownsReset = await resetCooldowns(db);

    // Compute config hash for tracking
    const keyCount = await countActiveKeys(db);
    const configHash = crypto
      .createHash('sha256')
      .update(JSON.stringify({ keyCount, reloadedAt: Date.now() }))
      .digest('hex')
      .substring(0, 12);

    log.keys.info({ configHash, keyCount, cooldownsReset }, 'Configuration reloaded');

    res.json({
      success: true,
      message: 'Configuration reloaded successfully',
      configHash,
      keyCount,
      cooldownsReset,
      reloadedAt: new Date().toISOString(),
    });
  } catch (error: unknown) {
    log.keys.error({ err: error }, 'Error');
    res.status(500).json({ success: false, error: 'Failed to reload configuration' });
  }
});

/**
 * GET /v1/keys
 * List all provider keys (returns hashed keys only, never actual keys)
 */
router.get('/', async (req: Request, res: Response) => {
  try {
    const provider = sanitizeQueryParam(req.query.provider);
    const environment = sanitizeQueryParam(req.query.environment);
    const active = sanitizeQueryParam(req.query.active);

    // `listKeys` projects `PUBLIC_COLUMNS` — the port of `.select('-keyHash -key')`.
    const keys = await listKeys(getDb(), {
      provider,
      environment,
      isActive: active !== undefined ? active === 'true' : undefined,
    });

    res.json({
      success: true,
      count: keys.length,
      data: keys,
    });
  } catch (error: unknown) {
    log.keys.error({ err: error }, 'Error listing keys');
    res.status(500).json({
      success: false,
      error: 'An internal error occurred',
      code: 'INTERNAL_ERROR',
    });
  }
});

/**
 * GET /v1/keys/diagnostics
 * Check if all keys have stored key values and are usable
 */
router.get('/diagnostics', async (req: Request, res: Response) => {
  try {
    const keys = await listKeysForDiagnostics(getDb());

    // `key` is read here only to report whether one EXISTS. Its value never
    // enters the response — `hasKeyValue` and `keyLength` are all that leave.
    const diagnostics = keys.map((k) => ({
      name: k.name,
      provider: k.provider,
      keyPrefix: k.keyPrefix,
      isActive: k.isActive,
      hasKeyValue: !!k.key,
      keyLength: k.key ? k.key.length : 0,
      isPaid: k.isPaid,
      currentPriority: k.currentPriority,
      totalRequests: k.totalRequests,
      successCount: k.successCount,
      totalFailures: k.totalFailures,
      lastFailureReason: k.lastFailureReason || null,
      creditLimitUSD: k.creditLimitUSD ?? null,
      spentUSD: k.spentUSD || 0,
      creditExhausted: k.creditLimitUSD != null && k.spentUSD >= k.creditLimitUSD,
    }));

    const issues: string[] = [];
    for (const d of diagnostics) {
      if (!d.hasKeyValue) {
        issues.push(`Key "${d.name}" (${d.provider}) has no stored key value`);
      }
      if (!d.isActive) {
        issues.push(`Key "${d.name}" (${d.provider}) is inactive`);
      }
    }

    res.json({
      success: true,
      data: {
        totalKeys: diagnostics.length,
        keysWithValues: diagnostics.filter((d) => d.hasKeyValue).length,
        activeKeys: diagnostics.filter((d) => d.isActive).length,
        issues,
        keys: diagnostics,
      },
    });
  } catch (error: unknown) {
    log.keys.error({ err: error }, 'Error running key diagnostics');
    res.status(500).json({
      success: false,
      error: 'An internal error occurred',
      code: 'INTERNAL_ERROR',
    });
  }
});

/**
 * GET /v1/keys/:keyId
 * Get specific key details (without actual key value)
 */
router.get('/:keyId', async (req: Request<{ keyId: string }>, res: Response) => {
  try {
    const { keyId } = req.params;

    // A malformed id used to throw a Mongoose CastError and surface as a 500.
    // Ids are `text` here, so an unknown one simply matches no row and 404s —
    // the same outcome the caller already had to handle, reached quietly.
    const key = await findPublicById(getDb(), keyId);

    if (!key) {
      return res.status(404).json({
        success: false,
        error: 'Key not found',
        code: 'KEY_NOT_FOUND',
      });
    }

    res.json({
      success: true,
      data: key,
    });
  } catch (error: unknown) {
    log.keys.error({ err: error }, 'Error getting key');
    res.status(500).json({
      success: false,
      error: 'An internal error occurred',
      code: 'INTERNAL_ERROR',
    });
  }
});

/**
 * POST /v1/keys
 * Add new provider key
 */
router.post('/', async (req: Request, res: Response) => {
  try {
    const { name, provider, key, environment, isPaid, tier, priority, creditLimitUSD, rateLimitResetMs } = req.body;

    // Validate required fields
    if (!name || !provider || !key) {
      return res.status(400).json({
        success: false,
        error: 'name, provider, and key are required',
        code: 'INVALID_REQUEST',
      });
    }

    // Validate field types and lengths
    const sanitizedName = sanitizeString(name, 100);
    if (!sanitizedName) {
      return res.status(400).json({
        success: false,
        error: 'name must be a non-empty string (max 100 chars)',
        code: 'INVALID_REQUEST',
      });
    }

    const sanitizedProvider = sanitizeString(provider, 50);
    if (!sanitizedProvider || !VALID_PROVIDERS.includes(sanitizedProvider.toLowerCase())) {
      return res.status(400).json({
        success: false,
        error: `provider must be one of: ${VALID_PROVIDERS.join(', ')}`,
        code: 'INVALID_REQUEST',
      });
    }

    if (typeof key !== 'string' || key.length < 10 || key.length > 500) {
      return res.status(400).json({
        success: false,
        error: 'key must be a string between 10 and 500 characters',
        code: 'INVALID_REQUEST',
      });
    }

    if (priority !== undefined && (typeof priority !== 'number' || priority < 0 || priority > 100)) {
      return res.status(400).json({
        success: false,
        error: 'priority must be a number between 0 and 100',
        code: 'INVALID_REQUEST',
      });
    }

    if (creditLimitUSD !== undefined && creditLimitUSD !== null && (typeof creditLimitUSD !== 'number' || creditLimitUSD < 0)) {
      return res.status(400).json({
        success: false,
        error: 'creditLimitUSD must be a non-negative number or null',
        code: 'INVALID_REQUEST',
      });
    }

    const db = getDb();

    // Hash the key for deduplication. Deterministic by contract — a randomised
    // digest would make this lookup miss and the unique index would then reject
    // the insert with a 500 instead of this 409.
    const keyHash = hashProviderKey(key);

    // Check if key already exists
    const existing = await findByKeyHash(db, keyHash);
    if (existing) {
      return res.status(409).json({
        success: false,
        error: 'Key already exists',
        code: 'KEY_ALREADY_EXISTS',
      });
    }

    // Create new key
    const newKey = await createKey(db, {
      ...writableRateLimits(req.body),
      name,
      provider,
      keyHash,
      keyPrefix: providerKeyPrefix(key),
      key,
      environment: environment || 'production',
      isPaid: isPaid || false,
      tier: tier || 'free',
      currentPriority: priority || 10,
      originalPriority: priority || 10,
      creditLimitUSD: creditLimitUSD ?? null,
      rateLimitResetMs: rateLimitResetMs ?? null,
      isActive: true,
    });

    // Invalidate cache
    invalidateKeyCache(provider);

    res.status(201).json({
      success: true,
      data: {
        id: newKey.id,
        keyPrefix: newKey.keyPrefix,
        message: 'Key added successfully',
      },
    });

    broadcastKeysUpdate(provider);
  } catch (error: unknown) {
    log.keys.error({ err: error }, 'Error adding key');
    res.status(500).json({
      success: false,
      error: 'An internal error occurred',
      code: 'INTERNAL_ERROR',
    });
  }
});

/**
 * PATCH /v1/keys/:keyId
 * Update key configuration (cannot update the key itself, use rotate for that)
 */
router.patch('/:keyId', async (req: Request<{ keyId: string }>, res: Response) => {
  try {
    const { keyId } = req.params;

    // The source's allow-list also carried `priority`, which is NOT a field on
    // the model — Mongoose strict mode STRIPPED it, so a caller sending it got
    // a 200 and no change. It is gone rather than wired to `currentPriority`:
    // turning a silent no-op into a silent write is a behaviour change, and the
    // two priority columns move together (`recordSuccess` restores
    // `currentPriority` from `originalPriority`, so writing only the first would
    // evaporate on the key's next success). A request carrying ONLY `priority`
    // now gets an explicit 400 instead of a 200 that did nothing; making a key's
    // priority settable is a feature, not part of this port.
    const updates: ProviderKeyPatch = {
      ...writableRateLimits(req.body),
      name: req.body.name,
      isActive: req.body.isActive,
      environment: req.body.environment,
      isPaid: req.body.isPaid,
      tier: req.body.tier,
      creditLimitUSD: req.body.creditLimitUSD,
      rateLimitResetMs: req.body.rateLimitResetMs,
    };

    if (Object.values(updates).every((value) => value === undefined)) {
      return res.status(400).json({
        success: false,
        error: 'No valid fields to update',
        code: 'INVALID_REQUEST',
      });
    }

    // `undefined` never reaches the SET clause; an explicit `null` still clears.
    const key = await patchKey(getDb(), keyId, updates);

    if (!key) {
      return res.status(404).json({
        success: false,
        error: 'Key not found',
        code: 'KEY_NOT_FOUND',
      });
    }

    // Invalidate cache
    invalidateKeyCache(key.provider);

    res.json({
      success: true,
      data: key,
    });

    broadcastKeysUpdate(key.provider);
  } catch (error: unknown) {
    log.keys.error({ err: error }, 'Error updating key');
    res.status(500).json({
      success: false,
      error: 'An internal error occurred',
      code: 'INTERNAL_ERROR',
    });
  }
});

/**
 * DELETE /v1/keys/:keyId
 * Delete a provider key
 */
router.delete('/:keyId', async (req: Request<{ keyId: string }>, res: Response) => {
  try {
    const { keyId } = req.params;

    const key = await deleteKey(getDb(), keyId);

    if (!key) {
      return res.status(404).json({
        success: false,
        error: 'Key not found',
        code: 'KEY_NOT_FOUND',
      });
    }

    // Invalidate cache
    invalidateKeyCache(key.provider);

    res.json({
      success: true,
      message: 'Key deleted successfully',
    });

    broadcastKeysUpdate(key.provider);
  } catch (error: unknown) {
    log.keys.error({ err: error }, 'Error deleting key');
    res.status(500).json({
      success: false,
      error: 'An internal error occurred',
      code: 'INTERNAL_ERROR',
    });
  }
});

/**
 * POST /v1/keys/:keyId/rotate
 * Rotate a provider key (replace with new key)
 */
router.post('/:keyId/rotate', async (req: Request<{ keyId: string }>, res: Response) => {
  try {
    const { keyId } = req.params;
    const { newKey } = req.body;

    if (!newKey || typeof newKey !== 'string' || newKey.length < 10 || newKey.length > 500) {
      return res.status(400).json({
        success: false,
        error: 'newKey must be a string between 10 and 500 characters',
        code: 'INVALID_REQUEST',
      });
    }

    const db = getDb();

    // Find existing key
    const key = await findById(db, keyId);
    if (!key) {
      return res.status(404).json({
        success: false,
        error: 'Key not found',
        code: 'KEY_NOT_FOUND',
      });
    }

    // Check if new key already exists
    const existing = await findByKeyHash(db, hashProviderKey(newKey));
    if (existing) {
      return res.status(409).json({
        success: false,
        error: 'New key already exists in system',
        code: 'KEY_ALREADY_EXISTS',
      });
    }

    // The digest, the prefix, the secret and the stamp are one fact about one
    // key — one statement, so no state has some of them landed.
    const rotated = await rotateKey(db, keyId, newKey);
    if (!rotated) {
      return res.status(404).json({
        success: false,
        error: 'Key not found',
        code: 'KEY_NOT_FOUND',
      });
    }

    // Invalidate cache
    invalidateKeyCache(rotated.provider);

    res.json({
      success: true,
      data: {
        keyPrefix: rotated.keyPrefix,
        rotatedAt: rotated.rotatedAt,
        message: 'Key rotated successfully',
      },
    });

    broadcastKeysUpdate(rotated.provider);
  } catch (error: unknown) {
    log.keys.error({ err: error }, 'Error rotating key');
    res.status(500).json({
      success: false,
      error: 'An internal error occurred',
      code: 'INTERNAL_ERROR',
    });
  }
});

/**
 * POST /v1/keys/:keyId/reset-spend
 * Reset spentUSD to 0 (e.g., after adding credit to a provider account)
 */
router.post('/:keyId/reset-spend', async (req: Request<{ keyId: string }>, res: Response) => {
  try {
    const { keyId } = req.params;

    const key = await resetSpend(getDb(), keyId);

    if (!key) {
      return res.status(404).json({
        success: false,
        error: 'Key not found',
        code: 'KEY_NOT_FOUND',
      });
    }

    // Invalidate cache so the key becomes selectable again
    invalidateKeyCache(key.provider);

    res.json({
      success: true,
      data: key,
      message: 'Key spend reset successfully',
    });

    broadcastKeysUpdate(key.provider);
  } catch (error: unknown) {
    log.keys.error({ err: error }, 'Error resetting key spend');
    res.status(500).json({
      success: false,
      error: 'An internal error occurred',
      code: 'INTERNAL_ERROR',
    });
  }
});

/**
 * POST /v1/keys/:keyId/deactivate
 * Deactivate a key (soft delete)
 */
router.post('/:keyId/deactivate', async (req: Request<{ keyId: string }>, res: Response) => {
  try {
    const { keyId } = req.params;

    const key = await setActive(getDb(), keyId, false);

    if (!key) {
      return res.status(404).json({
        success: false,
        error: 'Key not found',
        code: 'KEY_NOT_FOUND',
      });
    }

    // Invalidate cache
    invalidateKeyCache(key.provider);

    res.json({
      success: true,
      data: key,
      message: 'Key deactivated successfully',
    });

    broadcastKeysUpdate(key.provider);
  } catch (error: unknown) {
    log.keys.error({ err: error }, 'Error deactivating key');
    res.status(500).json({
      success: false,
      error: 'An internal error occurred',
      code: 'INTERNAL_ERROR',
    });
  }
});

/**
 * POST /v1/keys/:keyId/activate
 * Activate a previously deactivated key
 */
router.post('/:keyId/activate', async (req: Request<{ keyId: string }>, res: Response) => {
  try {
    const { keyId } = req.params;

    const key = await setActive(getDb(), keyId, true);

    if (!key) {
      return res.status(404).json({
        success: false,
        error: 'Key not found',
        code: 'KEY_NOT_FOUND',
      });
    }

    // Invalidate cache
    invalidateKeyCache(key.provider);

    res.json({
      success: true,
      data: key,
      message: 'Key activated successfully',
    });

    broadcastKeysUpdate(key.provider);
  } catch (error: unknown) {
    log.keys.error({ err: error }, 'Error activating key');
    res.status(500).json({
      success: false,
      error: 'An internal error occurred',
      code: 'INTERNAL_ERROR',
    });
  }
});

export default router;
