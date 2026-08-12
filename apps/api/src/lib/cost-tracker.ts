/**
 * Cost Tracking & Optimization
 *
 * Tracks real-time costs per request, aggregates by user/model,
 * and provides analytics for cost optimization.
 *
 * ## The ledger has no writer in this codebase
 *
 * `recordCost` below is the only insert path and NOTHING CALLS IT — verified by
 * grepping the symbol across `src/`, which names only this file. The same is
 * true of `getUserCostSummary`, `getUserDashboardData`, `getTopUsersByCost`,
 * `getModelEfficiency` and `getCostOptimizationRecommendations`. The two live
 * exports are `calculateCost` (a pure function over an in-code pricing table,
 * used by `internal/providers/routes/providers.ts:203`) and `getGlobalCostStats`
 * (`internal/providers/routes/usage.ts:125`), which today reads an empty table
 * and returns zeroes.
 *
 * That was equally true of the Mongo original — the state is inherited, not
 * introduced by this port. It is stated here because a reader who assumes these
 * numbers mean something will misread an admin dashboard full of zeroes as a
 * quiet week rather than as a ledger nobody writes.
 */

import { getDb } from '../db/client.js';
import {
  listForUser,
  listGlobal,
  listRecentForUser,
  modelEfficiency,
  recordCost as insertCostEntry,
  topUsersByCost,
} from '../repositories/cost-entries.js';
import { getModelPricing } from '../internal/providers/lib/model-capabilities-data.js';
import { log } from './logger.js';

// ============== TYPES ==============

export interface CostEntry {
  userId: string;
  sessionId?: string;
  clarityModelId: string;      // User sees this (e.g., "clarity-pro")
  actualProvider: string;    // Internal only
  actualModelId: string;     // Internal only
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  costUSD: number;
  savedFromCache: boolean;
  timestamp: Date;
}

export interface UserCostSummary {
  userId: string;
  totalSpent: number;
  totalTokens: number;
  totalRequests: number;
  costByModel: Record<string, number>;  // Only Clarity model names!
  tokensByModel: Record<string, number>;
  avgCostPerRequest: number;
  estimatedMonthlyCost: number;
  cacheSavings: number;
  freeTierSavings: number;  // Savings from using free providers
}

// ============== COST CALCULATION ==============

/**
 * Calculate cost for a request based on token usage
 */
export function calculateCost(
  provider: string,
  modelId: string,
  inputTokens: number,
  outputTokens: number
): number {
  const pricing = getModelPricing(modelId);

  // Free tier models have no cost
  if (pricing.tier === 'free') {
    return 0;
  }

  // Calculate cost per million tokens
  const inputCost = (pricing.costPer1MInput || 0) * (inputTokens / 1_000_000);
  const outputCost = (pricing.costPer1MOutput || 0) * (outputTokens / 1_000_000);

  return inputCost + outputCost;
}

/**
 * Estimate cost savings from using free tier instead of paid
 */
export function estimateFreeTierSavings(
  inputTokens: number,
  outputTokens: number
): number {
  // Compare against a typical paid model (gpt-4o equivalent)
  const paidInputCost = 2.50 * (inputTokens / 1_000_000);
  const paidOutputCost = 10.00 * (outputTokens / 1_000_000);
  return paidInputCost + paidOutputCost;
}

// ============== TRACKING ==============

/**
 * Record a request's cost
 */
export async function recordCost(
  userId: string,
  clarityModelId: string,
  actualProvider: string,
  actualModelId: string,
  inputTokens: number,
  outputTokens: number,
  savedFromCache: boolean = false,
  sessionId?: string
): Promise<void> {
  try {
    const totalTokens = inputTokens + outputTokens;
    const costUSD = calculateCost(actualProvider, actualModelId, inputTokens, outputTokens);

    await insertCostEntry(getDb(), {
      userId,
      sessionId: sessionId ?? null,
      clarityModelId,
      actualProvider,
      actualModelId,
      inputTokens,
      outputTokens,
      totalTokens,
      costUSD,
      savedFromCache,
      timestamp: new Date(),
    });

    log.credits.info({ costUSD, clarityModelId, totalTokens, savedFromCache }, 'Recorded cost');
  } catch (error) {
    log.credits.error({ err: error }, 'Error recording cost');
  }
}

// ============== ANALYTICS ==============

/**
 * Get cost summary for a user
 */
export async function getUserCostSummary(
  userId: string,
  startDate?: Date,
  endDate?: Date
): Promise<UserCostSummary> {
  try {
    const entries = await listForUser(getDb(), userId, startDate, endDate);

    let totalSpent = 0;
    let totalTokens = 0;
    let cacheSavings = 0;
    let freeTierSavings = 0;
    const costByModel: Record<string, number> = {};
    const tokensByModel: Record<string, number> = {};

    for (const entry of entries) {
      totalSpent += entry.costUSD;
      totalTokens += entry.totalTokens;

      // Aggregate by Clarity model (not provider!)
      const model = entry.clarityModelId;
      costByModel[model] = (costByModel[model] || 0) + entry.costUSD;
      tokensByModel[model] = (tokensByModel[model] || 0) + entry.totalTokens;

      // Track cache savings (cost that would have been incurred). This is the
      // one place the internal pair is read on a per-user path; it feeds a
      // scalar and never reaches the response — see the note on `listForUser`.
      if (entry.savedFromCache) {
        const wouldHaveCost = calculateCost(
          entry.actualProvider,
          entry.actualModelId,
          entry.inputTokens,
          entry.outputTokens
        );
        cacheSavings += wouldHaveCost;
      }

      // Track free tier savings
      if (entry.costUSD === 0) {
        freeTierSavings += estimateFreeTierSavings(entry.inputTokens, entry.outputTokens);
      }
    }

    const totalRequests = entries.length;
    const avgCostPerRequest = totalRequests > 0 ? totalSpent / totalRequests : 0;

    // Estimate monthly cost based on usage pattern
    const daysOfData = endDate && startDate
      ? Math.max(1, (endDate.getTime() - startDate.getTime()) / (1000 * 60 * 60 * 24))
      : 30;
    const estimatedMonthlyCost = (totalSpent / daysOfData) * 30;

    return {
      userId,
      totalSpent,
      totalTokens,
      totalRequests,
      costByModel,
      tokensByModel,
      avgCostPerRequest,
      estimatedMonthlyCost,
      cacheSavings,
      freeTierSavings
    };
  } catch (error) {
    log.credits.error({ err: error }, 'Error getting user cost summary');
    return {
      userId,
      totalSpent: 0,
      totalTokens: 0,
      totalRequests: 0,
      costByModel: {},
      tokensByModel: {},
      avgCostPerRequest: 0,
      estimatedMonthlyCost: 0,
      cacheSavings: 0,
      freeTierSavings: 0
    };
  }
}

/**
 * Get global cost statistics (admin)
 */
export async function getGlobalCostStats(
  startDate?: Date,
  endDate?: Date
): Promise<{
  totalRevenue: number;
  totalTokens: number;
  totalRequests: number;
  uniqueUsers: number;
  costByClarityModel: Record<string, number>;
  costByActualProvider: Record<string, number>;  // Internal only!
  avgCostPerRequest: number;
  cacheSavingsTotal: number;
  freeTierSavingsTotal: number;
}> {
  try {
    const entries = await listGlobal(getDb(), startDate, endDate);
    const uniqueUsers = new Set(entries.map(e => e.userId)).size;

    let totalRevenue = 0;
    let totalTokens = 0;
    let cacheSavingsTotal = 0;
    let freeTierSavingsTotal = 0;
    const costByClarityModel: Record<string, number> = {};
    const costByActualProvider: Record<string, number> = {};

    for (const entry of entries) {
      totalRevenue += entry.costUSD;
      totalTokens += entry.totalTokens;

      // By Clarity model (user-facing)
      costByClarityModel[entry.clarityModelId] = (costByClarityModel[entry.clarityModelId] || 0) + entry.costUSD;

      // By actual provider (internal analytics only!)
      costByActualProvider[entry.actualProvider] = (costByActualProvider[entry.actualProvider] || 0) + entry.costUSD;

      if (entry.savedFromCache) {
        cacheSavingsTotal += calculateCost(entry.actualProvider, entry.actualModelId, entry.inputTokens, entry.outputTokens);
      }

      if (entry.costUSD === 0) {
        freeTierSavingsTotal += estimateFreeTierSavings(entry.inputTokens, entry.outputTokens);
      }
    }

    const totalRequests = entries.length;
    const avgCostPerRequest = totalRequests > 0 ? totalRevenue / totalRequests : 0;

    return {
      totalRevenue,
      totalTokens,
      totalRequests,
      uniqueUsers,
      costByClarityModel,        // Safe for users
      costByActualProvider,    // INTERNAL ONLY - never expose to users!
      avgCostPerRequest,
      cacheSavingsTotal,
      freeTierSavingsTotal
    };
  } catch (error) {
    log.credits.error({ err: error }, 'Error getting global cost stats');
    return {
      totalRevenue: 0,
      totalTokens: 0,
      totalRequests: 0,
      uniqueUsers: 0,
      costByClarityModel: {},
      costByActualProvider: {},
      avgCostPerRequest: 0,
      cacheSavingsTotal: 0,
      freeTierSavingsTotal: 0
    };
  }
}

/**
 * Get top users by cost (admin)
 *
 * The source sorted on `totalSpent` alone, so ties among equal spenders came
 * back in whatever order the `$group` produced and two identical calls could
 * disagree on the last row. The repository adds `userId` as a second sort key.
 */
export async function getTopUsersByCost(
  limit: number = 10,
  startDate?: Date,
  endDate?: Date
): Promise<Array<{ userId: string; totalSpent: number; totalTokens: number; totalRequests: number }>> {
  try {
    return await topUsersByCost(getDb(), limit, startDate, endDate);
  } catch (error) {
    log.credits.error({ err: error }, 'Error getting top users');
    return [];
  }
}

/**
 * Get cost efficiency by model (cost per 1k tokens)
 */
export async function getModelEfficiency(): Promise<Array<{
  clarityModelId: string;
  avgCostPer1kTokens: number;
  totalRequests: number;
  totalCost: number;
}>> {
  try {
    return await modelEfficiency(getDb());
  } catch (error) {
    log.credits.error({ err: error }, 'Error getting model efficiency');
    return [];
  }
}

// ============== OPTIMIZATION RECOMMENDATIONS ==============

/**
 * Get cost optimization recommendations for a user
 */
export async function getCostOptimizationRecommendations(userId: string): Promise<string[]> {
  const summary = await getUserCostSummary(userId);
  const recommendations: string[] = [];

  // Check if using expensive models unnecessarily
  const proUsage = (summary.costByModel['clarity-pro'] || 0) + (summary.costByModel['clarity-pro-max'] || 0);
  const totalCost = summary.totalSpent;

  if (proUsage > totalCost * 0.5 && summary.totalRequests > 20) {
    recommendations.push('💡 You\'re using Pro models frequently. Consider using standard Clarity V1 for simpler tasks to save costs.');
  }

  // Check cache usage
  if (summary.cacheSavings > 0) {
    recommendations.push(`✅ Great! Cache hits saved you $${summary.cacheSavings.toFixed(2)} this period.`);
  } else if (summary.totalRequests > 10) {
    recommendations.push('💡 You could save money by enabling response caching for repeated queries.');
  }

  // Check free tier savings
  if (summary.freeTierSavings > summary.totalSpent * 2) {
    recommendations.push(`🎉 Excellent! Free tier usage saved you $${summary.freeTierSavings.toFixed(2)} compared to paid-only models.`);
  }

  // Monthly projection
  if (summary.estimatedMonthlyCost > 50) {
    recommendations.push(`📊 Your projected monthly cost is $${summary.estimatedMonthlyCost.toFixed(2)}. Consider optimizing high-cost tasks.`);
  }

  return recommendations;
}

// ============== EXPORT FOR DASHBOARD ==============

/**
 * `recentActivity` is typed from the repository rather than as `CostEntry[]`,
 * and the difference is load-bearing: these rows ARE serialised into the
 * response, so they come back without `actualProvider` / `actualModelId`.
 * Declaring them `CostEntry[]` would assert two fields the query does not select
 * and invite a later reader to put them on the wire.
 */
export async function getUserDashboardData(userId: string): Promise<{
  summary: UserCostSummary;
  recommendations: string[];
  recentActivity: Awaited<ReturnType<typeof listRecentForUser>>;
}> {
  const thirtyDaysAgo = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);

  const [summary, recommendations, recentActivity] = await Promise.all([
    getUserCostSummary(userId, thirtyDaysAgo),
    getCostOptimizationRecommendations(userId),
    listRecentForUser(getDb(), userId),
  ]);

  return {
    summary,
    recommendations,
    recentActivity,
  };
}
