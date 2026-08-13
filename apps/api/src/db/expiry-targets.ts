/**
 * The registry replacing this service's Mongo TTL indexes.
 *
 * Postgres has no TTL index. Mongo reaped; Postgres does not — so a table that
 * carried `expireAfterSeconds` and arrives here without an entry grows
 * FOREVER, with no error, no failing test and no symptom of any kind until the
 * disk fills. It is the quietest failure in the whole port precisely because
 * the thing doing the work was never in this codebase to be missed: there is
 * no deleted call site and no orphaned function for a reviewer to notice.
 *
 * ## THIS REGISTRY IS NOT YET SCHEDULED, AND NOTHING HERE PRETENDS OTHERWISE
 *
 * `sweepAllExpiredRows` has no caller. Wiring it to a schedule means editing
 * the service entrypoint, which is out of scope for a port that lands
 * not-yet-called code — so it belongs to the rewiring PR, together with the
 * assertion that the entrypoint really calls the starter.
 *
 * That assertion is not optional bookkeeping. A registered sweep with zero
 * callers is GREEN AND INERT: its tests pass because they invoke the sweep
 * directly, proving the mechanism CAN work while nothing establishes that it
 * DOES. `expiry-targets.pgdb.test.ts` deliberately tests only the former and
 * says so, rather than leaving a green suite that reads like coverage.
 */

import type { ExpirySweepTarget } from '@oxyhq/db/expiry';
import { API_KEY_USAGE_RETENTION_SECONDS, apiKeyUsage } from './schema/billing.js';
import {
  AUTH_HEALTH_METRIC_RETENTION_SECONDS,
  authHealthMetrics,
  FALLBACK_EVENT_RETENTION_SECONDS,
  fallbackEvents,
} from './schema/providers.js';

/**
 * Every billing table that carried a Mongo TTL index.
 *
 * `api_key_usage` is the only one. Derived by reading each model in this
 * domain for `expireAfterSeconds`: it appeared once, at
 * `models/api-key-usage.ts:91`.
 *
 * That path, and every other `models/*.ts` cited in this file, is the PRE-PORT
 * Mongoose source. The billing and collab models were deleted when their routes
 * were rewired; read them at `master` f7834e8 or earlier. The citations are
 * kept because they are the only record of where each retention came from.
 *
 * INTENT CHECK, because replicating a TTL index without one is how history
 * gets destroyed quietly: this table is pure telemetry — request metering for
 * rate limits, usage charts and anomaly detection. Deleting a 90-day-old row
 * loses a data point on a chart. It holds no unprocessed work, so a stalled
 * consumer cannot have a backlog swept out from under it, and nothing bills
 * from it: `transactions` is the money ledger and has no expiry.
 *
 * COEXISTENCE CHECK: every read path filters on `timestamp` with its own
 * window — the longest is 30 days (`routes/credits.ts:35`), well inside the
 * 90-day retention — so no reader depends on a swept row already being gone,
 * and a row the sweep has not yet reached is at worst stale, never unsafe.
 */
export const BILLING_EXPIRY_TARGETS: readonly ExpirySweepTarget[] = [
  {
    table: apiKeyUsage,
    column: apiKeyUsage.timestamp,
    retentionSeconds: API_KEY_USAGE_RETENTION_SECONDS,
    reason:
      'Request metering older than 90 days. Costs a data point on a usage chart; bills nothing and blocks no work.',
  },
];

/**
 * Every provider-routing table that carried a Mongo TTL index.
 *
 * Derived by grepping `expireAfterSeconds` across the whole repository, not
 * across one directory: two of this domain's three inline-declared models sit
 * outside any `models/` folder, and a census scoped to `models/` sees neither.
 *
 * The repo-wide count is FOUR, re-measured against `master` at f7834e8 during
 * the rewiring: `models/api-key-usage.ts:91` (billing's, above),
 * `internal/providers/models/fallback-event.ts:46` (that file is DELETED as of
 * the providers rewiring — read it at f7834e8) and `lib/auth-health.ts:53`
 * (both here), and `models/notification.ts:84` — 90 days and PARTIAL on
 * `status: 'dismissed'`, a predicate `ExpirySweepTarget` cannot express, which
 * is why the collab domain registers it through a generated column instead.
 *
 * This paragraph previously read "five" and named a fifth index at
 * `models/routing-log.ts:56`. No such file has ever existed in this repository
 * — the only occurrence of that path anywhere was this sentence. The registry
 * itself was unaffected (all four real indexes are registered, and the
 * assertions are by content), so the error was confined to the prose; it is
 * corrected rather than deleted because the count is the thing a future reader
 * would check this comment for.
 *
 * `internal/providers/models/api-usage.ts` is deliberately ABSENT: it declared
 * no TTL at all (that file is DELETED as of the providers rewiring — read it at
 * f7834e8). It is easy to mistake for the billing domain's
 * `api_key_usage`, which does have one, and giving it a 90-day retention on
 * that resemblance would start deleting rows nobody agreed to delete. The
 * consequence is real and is
 * recorded at the `api_usages` table: unbounded growth behind a one-day read
 * window, wanting a retention policy decided on purpose rather than inherited
 * by accident.
 */
export const PROVIDER_EXPIRY_TARGETS: readonly ExpirySweepTarget[] = [
  {
    table: fallbackEvents,
    column: fallbackEvents.timestamp,
    retentionSeconds: FALLBACK_EVENT_RETENTION_SECONDS,
    /**
     * INTENT CHECK: pure analytics. Nothing reads a fallback event to make a
     * routing decision — the circuit breaker lives in `provider_healths` — so
     * deleting one costs a row in an admin chart and blocks no work. It holds
     * no unprocessed backlog, so a stalled consumer cannot be swept out from
     * under.
     *
     * COEXISTENCE CHECK: the only reader (`routes/fallback-stats.ts:30`) caps
     * its own window at 720 hours, inside the retention, so no read depends on
     * a swept row already being gone.
     *
     * The `fallback_event_attempts` children go with the parent: their foreign
     * key is `on delete cascade`, so they need no entry of their own and must
     * not get one — a second target would delete attempts whose event is still
     * inside the window.
     */
    reason:
      'Fallback analytics older than 30 days. Costs a row in an admin chart; blocks no work and bills nothing.',
  },
  {
    table: authHealthMetrics,
    column: authHealthMetrics.createdAt,
    retentionSeconds: AUTH_HEALTH_METRIC_RETENTION_SECONDS,
    /**
     * INTENT CHECK: hourly auth counters, read only by an admin dashboard.
     *
     * COEXISTENCE CHECK: the reader caps its window at 168 hours
     * (`routes/auth-health.ts:23`), inside the retention.
     *
     * Note the retention is measured from `createdAt`, NOT from `hour`. That is
     * what the Mongo index did (`lib/auth-health.ts:53`), and the two differ:
     * a bucket is deleted seven days after it was first WRITTEN, and a bucket
     * is written at the start of its hour, so the practical difference is under
     * an hour. Reproduced rather than "corrected", because changing which
     * column a retention measures from is a behaviour change.
     */
    reason:
      'Auth health buckets older than 7 days. Costs a point on the auth dashboard; no request depends on one.',
  },
];
