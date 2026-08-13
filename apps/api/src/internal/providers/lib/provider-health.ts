/**
 * Provider Health Monitoring System
 *
 * Tracks provider reliability, implements circuit breaker pattern,
 * and automatically adjusts routing based on real-time health metrics.
 *
 * The circuit-breaker state machine and its thresholds live in
 * `repositories/provider-healths.ts`, because every transition is now part of
 * the statement that performs it. The read-modify-write this module used to do
 * — fetch the document, mutate it in JavaScript, `save()` — lost one of two
 * concurrent requests' counters and lost the whole update on a crash between
 * the two round trips.
 */

import { getDb } from '../../../db/client.js';
import {
  ensureExists,
  listAll,
  recordFailure as recordHealthFailure,
  recordSuccess as recordHealthSuccess,
  resetOne,
  sweepOpenCircuits,
  transitionToHalfOpen,
  type ProviderHealthRow,
} from '../../../repositories/provider-healths.js';
import { log } from '../../../lib/logger.js';

// ============== HEALTH METRICS ==============

export interface HealthMetrics {
  provider: string;
  modelId: string;
  successCount: number;
  failureCount: number;
  totalRequests: number;
  successRate: number;              // 0-100
  averageLatencyMs: number;
  lastSuccess: Date | null;
  lastFailure: Date | null;
  consecutiveFailures: number;
  circuitState: 'closed' | 'open' | 'half-open';
  lastHealthCheck: Date;
  isHealthy: boolean;
}

// ============== IN-MEMORY CACHE ==============

// Cache health data for fast lookups (TTL: 10 seconds)
const healthCache = new Map<string, { metrics: HealthMetrics; expiry: number }>();
const CACHE_TTL_MS = 10000;

function getCacheKey(provider: string, modelId: string): string {
  return `${provider}:${modelId}`;
}

function getCachedHealth(provider: string, modelId: string): HealthMetrics | null {
  const key = getCacheKey(provider, modelId);
  const cached = healthCache.get(key);
  if (cached && cached.expiry > Date.now()) {
    return cached.metrics;
  }
  healthCache.delete(key);
  return null;
}

function setCachedHealth(provider: string, modelId: string, metrics: HealthMetrics): void {
  const key = getCacheKey(provider, modelId);
  healthCache.set(key, {
    metrics,
    expiry: Date.now() + CACHE_TTL_MS
  });
}

/**
 * Clear the entire in-memory health cache (used during config reload)
 */
export function clearHealthCache(): void {
  healthCache.clear();
}

// ============== HEALTH MONITORING API ==============

/**
 * Get health metrics for a provider/model combination
 */
export async function getProviderHealth(provider: string, modelId: string): Promise<HealthMetrics> {
  // Check cache first
  const cached = getCachedHealth(provider, modelId);
  if (cached) {
    return cached;
  }

  try {
    // Find-or-initialise in one call. `ON CONFLICT DO NOTHING` then read back,
    // so two requests racing to initialise the same provider/model do not turn
    // into a unique violation the caller reads as a failure.
    const health = await ensureExists(getDb(), provider, modelId);

    const metrics = healthToMetrics(health);
    setCachedHealth(provider, modelId, metrics);
    return metrics;
  } catch (error) {
    log.providers.error({ err: error, provider, modelId }, 'Error fetching health');
    // Return default healthy state on error
    return {
      provider,
      modelId,
      successCount: 0,
      failureCount: 0,
      totalRequests: 0,
      successRate: 100,
      averageLatencyMs: 1500,
      lastSuccess: null,
      lastFailure: null,
      consecutiveFailures: 0,
      circuitState: 'closed',
      lastHealthCheck: new Date(),
      isHealthy: true
    };
  }
}

/**
 * Record a successful request
 */
export async function recordSuccess(
  provider: string,
  modelId: string,
  latencyMs: number
): Promise<void> {
  try {
    // One `INSERT ... ON CONFLICT DO UPDATE`, which also collapses the source's
    // "does the row exist yet" branch: both branches wrote the same facts and
    // differed only in whether they were expressed as increments.
    await recordHealthSuccess(getDb(), provider, modelId, latencyMs);

    // Invalidate cache
    healthCache.delete(getCacheKey(provider, modelId));
  } catch (error) {
    log.providers.error({ err: error }, 'Error recording success');
  }
}

/**
 * Record a failed request
 */
export async function recordFailure(
  provider: string,
  modelId: string,
  errorCode?: string
): Promise<void> {
  try {
    // Rate limits are transient (provider works fine, just hit quota) and must
    // not increment consecutiveFailures or open the circuit — which is why the
    // error code is passed through rather than a boolean. The classification
    // happens in the repository, from the source's own regex.
    await recordHealthFailure(getDb(), provider, modelId, errorCode);

    // Invalidate cache
    healthCache.delete(getCacheKey(provider, modelId));
  } catch (error) {
    log.providers.error({ err: error }, 'Error recording failure');
  }
}

/**
 * Check if a provider should accept requests (circuit breaker check)
 */
export async function isProviderAvailable(provider: string, modelId: string): Promise<boolean> {
  const health = await getProviderHealth(provider, modelId);

  if (health.circuitState === 'closed') {
    return true; // Circuit closed - provider is healthy
  }

  if (health.circuitState === 'open') {
    // The cooldown check is part of the UPDATE's predicate rather than a
    // decision taken here and written unconditionally: between the read and the
    // write another request can already have re-opened the circuit, and the
    // source would then re-admit traffic to a provider that just failed again.
    try {
      const transitioned = await transitionToHalfOpen(getDb(), provider, modelId);
      if (transitioned) {
        healthCache.delete(getCacheKey(provider, modelId));
        return true;
      }
    } catch (error) {
      log.providers.error({ err: error, provider, modelId }, 'Error transitioning to half-open');
      return false;
    }
    return false; // Circuit still open
  }

  if (health.circuitState === 'half-open') {
    // In half-open state, allow limited requests
    return true;
  }

  return true;
}

/**
 * Get all provider health metrics (for monitoring dashboard)
 */
export async function getAllProviderHealth(): Promise<HealthMetrics[]> {
  try {
    const healthRecords = await listAll(getDb());
    return healthRecords.map(healthToMetrics);
  } catch (error) {
    log.providers.error({ err: error }, 'Error fetching all health metrics');
    return [];
  }
}

/**
 * Reset health metrics for a provider (admin function)
 */
export async function resetProviderHealth(provider: string, modelId: string): Promise<void> {
  try {
    await resetOne(getDb(), provider, modelId);
    healthCache.delete(getCacheKey(provider, modelId));
  } catch (error) {
    log.providers.error({ err: error }, 'Error resetting health');
  }
}

// ============== HELPER FUNCTIONS ==============

function healthToMetrics(health: ProviderHealthRow): HealthMetrics {
  return {
    provider: health.provider,
    modelId: health.modelId,
    successCount: health.successCount,
    failureCount: health.failureCount,
    totalRequests: health.totalRequests,
    successRate: health.successRate,
    averageLatencyMs: health.averageLatencyMs || 0,
    lastSuccess: health.lastSuccess,
    lastFailure: health.lastFailure,
    consecutiveFailures: health.consecutiveFailures,
    circuitState: health.circuitState as HealthMetrics['circuitState'],
    lastHealthCheck: health.lastHealthCheck,
    isHealthy: health.isHealthy
  };
}

// ============== BACKGROUND HEALTH CHECK ==============

// Run periodic health check every 5 minutes
let healthCheckInterval: NodeJS.Timeout | null = null;

export function startHealthCheckMonitor(): void {
  if (healthCheckInterval) return; // Already running

  healthCheckInterval = setInterval(async () => {
    try {
      // The source fetched every open and half-open circuit and saved each one
      // whose cooldown had elapsed. The fetch existed only to evaluate a
      // predicate the database can evaluate, and iterating row by row meant a
      // circuit could be re-opened by a concurrent failure between the read and
      // its own save. One statement.
      const swept = await sweepOpenCircuits(getDb());
      if (swept > 0) {
        // The cached metrics for those rows now name a state that has moved on.
        clearHealthCache();
      }
    } catch (error) {
      log.providers.error({ err: error }, 'Error in health check monitor');
    }
  }, 5 * 60 * 1000); // Every 5 minutes

  // A module-level interval must not hold the process open — an unref'd handle
  // is what keeps a test runner from hanging on it.
  healthCheckInterval.unref?.();
}

export function stopHealthCheckMonitor(): void {
  if (healthCheckInterval) {
    clearInterval(healthCheckInterval);
    healthCheckInterval = null;
  }
}

// Auto-start monitor
if (process.env.NODE_ENV !== 'test') {
  startHealthCheckMonitor();
}
