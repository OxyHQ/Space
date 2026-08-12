/**
 * The replacement for this service's Mongo TTL indexes.
 *
 * Postgres has no TTL index. A collection whose Mongoose schema declared
 * `expireAfterSeconds` was reaped by Mongo's TTL monitor; the ported table is
 * reaped by nothing at all, and the failure is completely silent — no error, no
 * failing test, no orphaned function a reviewer would see go absent, just a
 * table that grows forever until disk. So the registry is the port of that
 * behaviour, and a table is not ported until it is either listed here or
 * recorded below as deliberately excluded.
 *
 * ## THIS REGISTRY IS NOT YET CALLED BY ANYTHING
 *
 * Stated plainly because a registered sweep with no caller is green and inert:
 * `sweepAllExpiredRows` works, a test proves it works, and no row is ever
 * deleted in production. Wiring it to the service's job schedule is a change to
 * `src/index.ts` — a call site — and belongs to the rewiring commit, together
 * with the assertion that the entrypoint really does call the starter. Until
 * then this file is a declaration, not a mechanism.
 *
 * ## Scope
 *
 * Only the provider-routing domain. The repo-wide census finds five
 * `expireAfterSeconds` declarations; two are here and three belong to other
 * domains and must be registered by whoever ports them:
 *
 *   - `models/api-key-usage.ts:91`  — 90 days on `timestamp`
 *   - `models/notification.ts:84`   — 90 days on `createdAt`, PARTIAL on
 *                                     `status: 'dismissed'`, which the sweep
 *                                     target shape cannot express and which
 *                                     therefore needs an explicit decision
 *   - `models/routing-log.ts:56`    — 90 days on `createdAt`
 *
 * `internal/providers/models/api-usage.ts` declares NO TTL and is deliberately
 * absent — see the note on the `api_usages` table. It is easy to confuse with
 * `models/api-key-usage.ts`, which does.
 */

import type { ExpirySweepTarget } from '@oxyhq/db/expiry';
import { authHealthMetrics, fallbackEvents } from '../db/schema/providers.js';

const DAY_SECONDS = 24 * 60 * 60;

/**
 * Every TTL index the provider-routing domain declared in Mongo.
 *
 * Each entry states what deleting the row COSTS, because a registry entry with
 * no such note reads as "unconditionally safe to sweep" — and a TTL index can
 * just as easily have meant "mark expired" as "destroy".
 */
export const PROVIDER_EXPIRY_TARGETS: readonly ExpirySweepTarget[] = [
  {
    table: fallbackEvents,
    column: fallbackEvents.timestamp,
    retentionSeconds: 30 * DAY_SECONDS,
    reason:
      'Analytics only. `internal/providers/models/fallback-event.ts:46`. Nothing reads a ' +
      'fallback event to make a routing decision, and `routes/fallback-stats.ts` caps its own ' +
      'window at 30 days, so a not-yet-swept row is stale at worst and never unsafe. The ' +
      'attempts child table goes with it: the foreign key cascades.',
  },
  {
    table: authHealthMetrics,
    column: authHealthMetrics.createdAt,
    retentionSeconds: 7 * DAY_SECONDS,
    reason:
      'Metrics only. `src/lib/auth-health.ts:53`. The only reader caps its window at 168 ' +
      'hours (`routes/auth-health.ts:23`), inside the retention, so the sweep can never ' +
      'remove a bucket the dashboard would have shown. Note the retention is measured from ' +
      '`createdAt`, not from `hour`: a bucket is deleted seven days after it was first ' +
      'written, which is what the Mongo index did.',
  },
];
