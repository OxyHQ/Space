/**
 * Fallback Stats API Route (Admin Only)
 *
 * Provides aggregated fallback analytics from FallbackEvent data.
 * Used by the admin panel to monitor fallback behavior and provider reliability.
 */

import express, { Request, Response } from 'express';
import { getDb } from '../../../db/client.js';
import {
  failuresByModel,
  mostFailedProviders,
  recentFailures,
  summary as fallbackSummary,
  topFailureReasons,
} from '../../../repositories/fallback-events.js';
import { log } from '../../../lib/logger.js';

const router = express.Router();

/**
 * GET /v1/fallback-stats
 *
 * Returns aggregated fallback statistics for a given time window.
 * Query params:
 *   - hours (number, default: 24) - Time window in hours
 *
 * Returns:
 *   - summary: total events, success/failure counts, fallback rate
 *   - topFailureReasons: most common failure reasons with counts
 *   - mostFailedProviders: providers with the most failures
 *   - failuresByModel: failures grouped by Clarity model
 *   - recentFailures: last 20 failed fallback events
 */
router.get('/', async (req: Request, res: Response) => {
  try {
    const hours = Math.min(Math.max(parseInt(req.query.hours as string) || 24, 1), 720); // 1h to 30d
    const since = new Date(Date.now() - hours * 60 * 60 * 1000);

    const db = getDb();

    // Five aggregates, each with its Mongo `$group` arbitrariness resolved at
    // the query rather than here — see the repository. Every ordering there is
    // total, because a `$limit` over a partial order silently changes which
    // rows survive between two identical calls.
    const [
      summary,
      reasons,
      providers,
      byModel,
      failures,
    ] = await Promise.all([
      fallbackSummary(db, since),
      topFailureReasons(db, since),
      mostFailedProviders(db, since),
      failuresByModel(db, since),
      recentFailures(db, since),
    ]);

    // Both operands are cast to `int` in the repository. Left as postgres.js
    // hands them back — strings — this division would still produce a
    // believable percentage, which is why the cast is there and not here.
    const fallbackRate =
      summary.totalEvents > 0
        ? Math.round((summary.failureCount / summary.totalEvents) * 1000) / 10
        : 0;

    res.json({
      success: true,
      data: {
        timeWindow: {
          hours,
          since: since.toISOString(),
        },
        summary: {
          totalEvents: summary.totalEvents,
          successCount: summary.successCount,
          failureCount: summary.failureCount,
          fallbackRate: `${fallbackRate}%`,
          // An aggregate over an empty set is one row of NULLs, where an empty
          // Mongo `$group` produced NO document — the `summaryResult[0] || {…}`
          // fallback the source needed is gone, and these coalesces replace it.
          avgTotalLatencyMs: Math.round(summary.avgTotalLatencyMs ?? 0),
          avgAttempts: Math.round((summary.avgAttempts ?? 0) * 10) / 10,
          maxAttempts: summary.maxAttempts ?? 0,
        },
        // `$round: ['$avgLatencyMs', 0]` and `$round: ['$avgAttempts', 1]` were
        // projection stages in the pipelines; they round here instead.
        topFailureReasons: reasons.map((r) => ({
          reason: r.reason,
          count: r.count,
          avgLatencyMs: Math.round(r.avgLatencyMs ?? 0),
        })),
        mostFailedProviders: providers,
        failuresByModel: byModel.map((m) => ({
          clarityModel: m.clarityModel,
          totalEvents: m.totalEvents,
          failures: m.failures,
          successes: m.successes,
          avgAttempts: Math.round((m.avgAttempts ?? 0) * 10) / 10,
          fallbackRate: Math.round(m.fallbackRate * 10) / 10,
        })),
        recentFailures: failures.map((e) => ({
          timestamp: e.timestamp,
          clarityModel: e.clarityModel,
          attempts: e.attempts,
          totalLatencyMs: e.totalLatencyMs,
        })),
      },
    });
  } catch (error: unknown) {
    log.providers.error({ err: error }, 'Error getting fallback stats');
    res.status(500).json({
      success: false,
      error: 'An internal error occurred',
      code: 'INTERNAL_ERROR',
    });
  }
});

export default router;
