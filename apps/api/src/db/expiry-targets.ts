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

/**
 * Every billing table that carried a Mongo TTL index.
 *
 * `api_key_usage` is the only one. Derived by reading each model in this
 * domain for `expireAfterSeconds`: it appears once, at
 * `models/api-key-usage.ts:91`.
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
