import { getDb } from '../db/client.js';
import {
  recordFailure,
  recordSuccess,
  summaryByMethod,
} from '../repositories/auth-health-metrics.js';
/**
 * Auth Health Monitoring
 * Tracks authentication success/failure rates per method, bucketed by hour.
 * All recording functions are fire-and-forget safe — they never throw or block the auth flow.
 */


// --- Types ---

export type AuthMethod = 'jwt' | 'api_key' | 'telegram' | 'service';

export interface AuthHealthSummary {
  method: string;
  totalSuccesses: number;
  totalFailures: number;
  successRate: number;
  lastFailure: Date | null;
  lastFailureReason: string | null;
  isHealthy: boolean;
}

// --- Schema ---

// Compound index for unique method+hour buckets
// --- Helpers ---

/**
 * Auth Health Monitoring
 * Tracks authentication success/failure rates per method, bucketed by hour.
 * All recording functions are fire-and-forget safe — they never throw or block the auth flow.
 */


// --- Types ---

export interface AuthHealthSummary {
  method: string;
  totalSuccesses: number;
  totalFailures: number;
  successRate: number;
  lastFailure: Date | null;
  lastFailureReason: string | null;
  isHealthy: boolean;
}

// --- Schema ---

// Compound index for unique method+hour buckets
// --- Helpers ---

/**
 * Bucket to the start of the hour, in LOCAL time — unchanged from the Mongo
 * version on purpose. Moving it to UTC would silently reassign existing
 * buckets, which is a data decision and not part of the port.
 */
function getBucketedHour(now: Date = new Date()): Date {
  return new Date(now.getFullYear(), now.getMonth(), now.getDate(), now.getHours());
}

/**
 * Record an auth success. Fire-and-forget: never throws, because a failure to
 * RECORD must not become a failure to AUTHENTICATE.
 */
export async function recordAuthSuccess(method: string): Promise<void> {
  try {
    await recordSuccess(getDb(), method, getBucketedHour());
  } catch {
    // Silently ignore — recording must never impact the auth flow.
  }
}

/** Record an auth failure. Same fire-and-forget contract as above. */
export async function recordAuthFailure(method: string, reason?: string): Promise<void> {
  try {
    await recordFailure(getDb(), method, getBucketedHour(), reason?.substring(0, 500));
  } catch {
    // Silently ignore — recording must never impact the auth flow.
  }
}

/**
 * Aggregated auth health for the last N hours, for the admin dashboard.
 *
 * The health rule is unchanged: healthy when fewer than 10 total attempts, or
 * when at least 80% succeeded. The small-sample exemption is why a brand-new
 * method does not report itself unhealthy on its first failure.
 */
export async function getAuthHealthStats(hours: number = 24): Promise<AuthHealthSummary[]> {
  const since = new Date();
  since.setHours(since.getHours() - hours);

  const rows = await summaryByMethod(getDb(), since);

  return rows.map((row) => {
    const total = row.totalSuccesses + row.totalFailures;
    const successRate = total > 0 ? row.totalSuccesses / total : 1;
    return {
      method: row.method,
      totalSuccesses: row.totalSuccesses,
      totalFailures: row.totalFailures,
      successRate: Math.round(successRate * 10000) / 10000,
      lastFailure: row.lastFailure ?? null,
      lastFailureReason: row.lastFailureReason ?? null,
      isHealthy: total < 10 || successRate >= 0.8,
    };
  });
}
