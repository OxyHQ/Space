/**
 * Key Manager - Handles provider key loading, selection, and rate limiting
 * Uses dynamic priority rotation: failed keys move to end of queue
 *
 * Transitional local manager for rows in `provider_keys`.
 *
 * Provider credentials are never environment variables. The destination is
 * Kaana-owned credential storage; Station's local provider runtime remains only
 * until Hub AI is routed through Alia -> Oxy -> Kaana.
 */

import { getDb } from '../../../db/client.js';
import {
  listKeysForProvider,
  listSelectableKeys,
  markCreditExhausted,
  maxPriorityInGroup,
  recordFailure,
  recordSuccess,
  recordSpend,
  recordUsage as recordKeyUsageRow,
  setCooldown,
  findById,
  type ProviderKeyRow,
} from '../../../repositories/provider-keys.js';
import { recordUsage as recordApiUsage, usageWindowsForKey } from '../../../repositories/api-usages.js';
import type { KeyConfig } from './types';
import { log } from '../../../lib/logger.js';

// Pre-compiled patterns for error classification in recordKeyFailure
const TIMEOUT_PATTERN = /timeout|AbortError/i;
const RATE_LIMIT_PATTERN = /rate.?limit|429|RESOURCE_EXHAUSTED|quota/i;

/**
 * What the selection loop needs from a stored key.
 */
interface SelectableKey {
  id: string;
  provider: string;
  keyPrefix: string;
  key: string | null;
  isPaid: boolean;
  cooldownUntil: Date | null;
  creditLimitUSD: number | null;
  spentUSD: number;
  rateLimitRps: number | null;
  rateLimitRpm: number | null;
  rateLimitRph: number | null;
  rateLimitRpd: number | null;
  rateLimitTps: number | null;
  rateLimitTpm: number | null;
  rateLimitTph: number | null;
  rateLimitTpd: number | null;
}

// Cache for loaded keys (TTL: 10 seconds — short to minimize stale-key window)
const keyCache = new Map<string, { keys: SelectableKey[]; timestamp: number }>();
const KEY_CACHE_TTL = 10000;

function toSelectableKey(row: ProviderKeyRow): SelectableKey {
  return {
    id: row.id,
    provider: row.provider,
    keyPrefix: row.keyPrefix,
    key: row.key,
    isPaid: row.isPaid,
    cooldownUntil: row.cooldownUntil,
    creditLimitUSD: row.creditLimitUSD,
    spentUSD: row.spentUSD,
    rateLimitRps: row.rateLimitRps,
    rateLimitRpm: row.rateLimitRpm,
    rateLimitRph: row.rateLimitRph,
    rateLimitRpd: row.rateLimitRpd,
    rateLimitTps: row.rateLimitTps,
    rateLimitTpm: row.rateLimitTpm,
    rateLimitTph: row.rateLimitTph,
    rateLimitTpd: row.rateLimitTpd,
  };
}

/**
 * Load all locally stored keys for a provider.
 * Keys are sorted by: 1) Free first, then paid 2) currentPriority within each group
 */
export async function loadProviderKeys(provider: string): Promise<SelectableKey[]> {
  const cacheKey = `provider:${provider}`;
  const cached = keyCache.get(cacheKey);

  // Return cached if still valid
  if (cached && Date.now() - cached.timestamp < KEY_CACHE_TTL) {
    return cached.keys;
  }

  // The free-then-paid, priority-ascending order the source built with two
  // JavaScript sorts is the query's `order by` now, with `id` as a tiebreak:
  // `Array.prototype.sort` is stable so equal-priority keys kept their fetch
  // order, and a Postgres sort has no such guarantee.
  const rows = await listSelectableKeys(getDb(), provider);
  const allKeys = rows.map(toSelectableKey);

  // Cache the results
  keyCache.set(cacheKey, { keys: allKeys, timestamp: Date.now() });

  return allKeys;
}

/**
 * Check if a key has exceeded rate limits.
 * Uses a single $facet aggregation to check all limits in one DB round-trip.
 */
async function isKeyRateLimited(key: SelectableKey, tokens: number = 0): Promise<boolean> {
  // No limits configured = not rate limited.
  if (
    !key.rateLimitRps && !key.rateLimitRpm && !key.rateLimitRph && !key.rateLimitRpd &&
    !key.rateLimitTps && !key.rateLimitTpm && !key.rateLimitTph && !key.rateLimitTpd
  ) {
    return false;
  }

  // One query for all four windows rather than the source's conditional facet
  // stages: it is the same index scan, and four code paths that can disagree
  // are worse than three unused numbers.
  //
  // Every count and token sum is cast in the repository. postgres.js decodes
  // `int8` as a STRING while drizzle types it `number`, and `second.tokens +
  // tokens > rl.tps` below would then be string CONCATENATION — `"0" + 500`
  // is `"0500"`, which coerces back to a number and gives the right answer
  // often enough that a test performing the comparison once cannot see it.
  const { second, minute, hour, day } = await usageWindowsForKey(getDb(), key.id);

  if (key.rateLimitRps && second.count >= key.rateLimitRps) return true;
  if (key.rateLimitRpm && minute.count >= key.rateLimitRpm) return true;
  if (key.rateLimitRph && hour.count >= key.rateLimitRph) return true;
  if (key.rateLimitRpd && day.count >= key.rateLimitRpd) return true;
  if (key.rateLimitTps && tokens > 0 && second.tokens + tokens > key.rateLimitTps) return true;
  if (key.rateLimitTpm && tokens > 0 && minute.tokens + tokens > key.rateLimitTpm) return true;
  if (key.rateLimitTph && tokens > 0 && hour.tokens + tokens > key.rateLimitTph) return true;
  if (key.rateLimitTpd && tokens > 0 && day.tokens + tokens > key.rateLimitTpd) return true;

  return false;
}

/**
 * Get the best available key for a provider/model combination
 * Keys are already sorted by currentPriority (dynamic rotation)
 */
export async function getBestKeyForModel(
  provider: string,
  modelId: string,
  estimatedTokens: number = 0,
  skipKeyIds?: Set<string>,
): Promise<KeyConfig | null> {
  const keys = await loadProviderKeys(provider);

  if (keys.length === 0) {
    log.keys.warn({ provider }, 'No keys found for provider');
    return null;
  }

  // Try keys in order of currentPriority (already sorted)
  // Failed keys will have been moved to end of queue
  const now = new Date();
  for (const key of keys) {
    const keyId = key.id;

    // Skip keys the caller has already tried and failed on
    if (skipKeyIds?.has(keyId)) {
      continue;
    }

    // Skip keys in cooldown period
    if (key.cooldownUntil && key.cooldownUntil > now) {
      log.keys.debug({ keyPrefix: key.keyPrefix, provider: key.provider, cooldownUntil: key.cooldownUntil }, 'Key in cooldown, skipping');
      continue;
    }

    // Skip keys that have exceeded their credit limit
    if (key.creditLimitUSD != null && key.spentUSD >= key.creditLimitUSD) {
      log.keys.debug({ keyPrefix: key.keyPrefix, provider: key.provider, spentUSD: key.spentUSD, creditLimitUSD: key.creditLimitUSD }, 'Key credit exhausted, skipping');
      continue;
    }

    // Check rate limits
    const isLimited = await isKeyRateLimited(key, estimatedTokens);
    if (isLimited) {
      continue;
    }

    // Skip keys without a stored key value
    if (!key.key) {
      log.keys.warn({ keyPrefix: key.keyPrefix, provider: key.provider }, 'Key has no value, skipping');
      continue;
    }

    // Found a suitable key
    return {
      keyId,
      provider: key.provider,
      modelId,
      key: key.key,
      isPaid: key.isPaid,
      rps: key.rateLimitRps,
      rpm: key.rateLimitRpm,
      rph: key.rateLimitRph,
      rpd: key.rateLimitRpd,
      tps: key.rateLimitTps,
      tpm: key.rateLimitTpm,
      tph: key.rateLimitTph,
      tpd: key.rateLimitTpd,
    };
  }

  log.keys.warn({ provider }, 'All keys rate-limited or in cooldown');
  return null;
}

/**
 * Record key usage for rate limiting
 */
export async function recordKeyUsage(
  keyId: string,
  tokens: number,
  provider: string,
  modelId: string
): Promise<void> {
  const db = getDb();

  await recordApiUsage(db, {
    keyId,
    provider,
    modelId,
    tokens,
    timestamp: new Date(),
  });

  // Update key statistics (fire and forget). One `SET x = x + n` rather than a
  // read-modify-write, so two concurrent requests can no longer lose each
  // other's increment — an existing invariant made structural, not a new one.
  recordKeyUsageRow(db, keyId, tokens).catch((err) =>
    log.keys.error({ err }, 'Failed to update key stats'),
  );
}

/**
 * Record key success (resets failure counters, restores original priority, clears cooldown)
 */
export async function recordKeySuccess(keyId: string): Promise<void> {
  if (!keyId) return;

  try {
    // The counters, the priority restore and the cooldown clear are one
    // statement. The source issued `save()` and then a separate `updateOne` to
    // null the cooldown; a crash between them left a key that had just
    // succeeded still in cooldown.
    const key = await recordSuccess(getDb(), keyId);
    if (key) {
      // Invalidate cache to pick up priority changes
      invalidateKeyCache(key.provider);
    }
  } catch (error: unknown) {
    log.keys.error({ err: error }, 'Failed to record key success');
  }
}

/**
 * Record key failure (moves key to last priority within its group - free or paid)
 * Also sets exponential cooldown: 30s * 2^consecutiveFailures, max 30min
 */
export async function recordKeyFailure(keyId: string, reason: string, retryAfterMs?: number): Promise<void> {
  if (!keyId) return;

  try {
    const db = getDb();

    const key = await findById(db, keyId);
    if (!key) {
      log.keys.warn({ keyId }, 'Key not found');
      return;
    }

    // Get max priority within the same group (free or paid). `max()` over a
    // `double precision` column, so it decodes as a real number and the `+ 1`
    // inside the repository is arithmetic rather than string concatenation.
    const maxPriority = await maxPriorityInGroup(db, key.provider, key.isPaid) ?? 999;

    // Record failure and move to end of its group's queue. The returned row
    // carries the counters as they now stand.
    const failed = await recordFailure(db, keyId, reason, maxPriority);
    if (!failed) {
      log.keys.warn({ keyId }, 'Key not found');
      return;
    }

    // Set cooldown.
    // Timeouts indicate slow service, not a bad key — skip cooldown for them.
    // Priority: 1) Provider's Retry-After header, 2) Key's configured rateLimitResetMs, 3) Default
    // For rate_limit errors: use provider Retry-After or key config or 60s flat
    // For other errors: exponential backoff (30s base, doubles per failure, capped at 5min)
    const isTimeout = TIMEOUT_PATTERN.test(reason);
    if (!isTimeout) {
      // `failed.consecutiveFailures` is the POST-increment count, and the `+ 1`
      // reproduces the source exactly: it read the same post-increment value off
      // the mutated document and added one again, so the exponent is one higher
      // than the "30s doubling per failure" the comment above describes — a
      // first failure waits 60s, not 30s. Preserved rather than corrected,
      // because changing a live backoff curve is an operational decision and not
      // part of this port; it is named in the port report.
      const consecutiveFailures = (failed.consecutiveFailures || 0) + 1;
      const isRateLimit = RATE_LIMIT_PATTERN.test(reason);
      let cooldownMs: number;
      if (retryAfterMs && retryAfterMs > 0) {
        cooldownMs = retryAfterMs; // Provider-supplied Retry-After takes priority
      } else if (isRateLimit && key.rateLimitResetMs) {
        cooldownMs = key.rateLimitResetMs;  // Per-key configured value
      } else if (isRateLimit) {
        cooldownMs = 60000;  // Default 60s for rate limits
      } else {
        cooldownMs = Math.min(30000 * Math.pow(2, consecutiveFailures - 1), 300000);
      }
      const cooldownUntil = new Date(Date.now() + cooldownMs);

      await setCooldown(db, keyId, cooldownUntil);

      log.keys.info({ keyPrefix: key.keyPrefix, provider: key.provider, cooldownSec: cooldownMs / 1000 }, 'Key cooldown set');
    } else {
      log.keys.info({ keyPrefix: key.keyPrefix, provider: key.provider }, 'Timeout failure — skipping cooldown');
    }

    // Invalidate cache to pick up priority changes
    invalidateKeyCache(key.provider);
  } catch (error: unknown) {
    log.keys.error({ err: error }, 'Failed to record key failure');
  }
}

/**
 * Get statistics for a provider's keys
 */
export async function getProviderKeyStats(provider: string): Promise<any> {
  const keys = await listKeysForProvider(getDb(), provider);

  return {
    total: keys.length,
    active: keys.filter((k) => k.isActive).length,
    rateLimited: 0, // Would need to check actual rate limits
    averageSuccessRate:
      keys.reduce((sum, k) => {
        const total = k.successCount + k.totalFailures;
        return sum + (total > 0 ? k.successCount / total : 1);
      }, 0) / keys.length,
    totalRequests: keys.reduce((sum, k) => sum + k.totalRequests, 0),
    totalFailures: keys.reduce((sum, k) => sum + k.totalFailures, 0),
  };
}

/**
 * Record key spend (fire and forget) - increments spentUSD on the key
 */
export async function recordKeySpend(keyId: string, costUSD: number): Promise<void> {
  if (costUSD <= 0 || !keyId) return;
  recordSpend(getDb(), keyId, costUSD).catch((err) =>
    log.keys.error({ err }, 'Failed to update key spend'),
  );
}

/**
 * Mark a key as credit-exhausted (set spentUSD = creditLimitUSD)
 */
export async function markKeyCreditExhausted(keyId: string): Promise<void> {
  if (!keyId) return;

  try {
    const db = getDb();

    // The limit is read and written in ONE statement, with `creditLimitUSD is
    // not null` in the predicate — so a key with no limit is left alone exactly
    // as the source's `if` did, and the value written is guaranteed to be the
    // key's current limit rather than one that changed between two round trips.
    const marked = await markCreditExhausted(db, keyId);
    if (!marked) return;

    const key = await findById(db, keyId);
    if (!key) return;

    invalidateKeyCache(key.provider);
    log.keys.warn({ keyPrefix: key.keyPrefix, provider: key.provider, creditLimitUSD: key.creditLimitUSD }, 'Key marked as credit exhausted');
  } catch (err) {
    log.keys.error({ err }, 'Failed to mark key as credit exhausted');
  }
}

/**
 * Invalidate key cache (call after adding/removing/modifying keys)
 */
export function invalidateKeyCache(provider?: string): void {
  if (provider) {
    keyCache.delete(`provider:${provider}`);
  } else {
    keyCache.clear();
  }
}
