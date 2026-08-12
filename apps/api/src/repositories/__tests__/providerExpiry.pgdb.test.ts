/**
 * The provider-routing half of the expiry registry, against a real PostgreSQL 17.
 *
 * ## What this file establishes, and what it does NOT
 *
 * It proves the registry names the right tables at the right retentions, and
 * that the sweep MECHANISM deletes the right rows and spares the wrong ones. It
 * does NOT prove the sweep RUNS: `sweepAllExpiredRows` has no scheduled caller,
 * and every test here invokes it directly.
 *
 * Saying so is the point. A registered sweep with zero callers is GREEN AND
 * INERT — the suite proves the mechanism CAN work while nothing establishes
 * that it DOES, and a green file named after expiry reads like coverage of a
 * behaviour that is not happening. The rewiring PR owns the schedule and owes a
 * source-level assertion that the entrypoint really calls the starter.
 *
 * ## Why this file is safe to run beside its siblings
 *
 * The sweep is GLOBAL: it deletes every expired row in the two tables, not just
 * this file's. That is safe only because no sibling writes a row older than the
 * retention — `fallbackEvents.pgdb.test.ts` caps its oldest fixture at two days
 * against a 30-day retention, and `authHealthMetrics.pgdb.test.ts` never writes
 * an explicit `createdAt` at all, so its rows are always fresh. The old rows
 * below are written by this file and belong to it. Breaking that convention
 * elsewhere makes this file delete a sibling's fixture mid-assertion.
 */

import { randomBytes } from 'node:crypto';
import { sweepAllExpiredRows } from '@oxyhq/db/expiry';
import { eq, sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { closeTestDb, getTestDb, type TestDatabase } from '../../db/__tests__/testDatabase.js';
import { PROVIDER_EXPIRY_TARGETS } from '../../db/expiry-targets.js';
import {
  AUTH_HEALTH_METRIC_RETENTION_SECONDS,
  authHealthMetrics,
  FALLBACK_EVENT_RETENTION_SECONDS,
  fallbackEventAttempts,
  fallbackEvents,
} from '../../db/schema/providers.js';

const DAY = 86_400_000;
let db: TestDatabase;

function own(label: string): string {
  return `exp-${label}-${randomBytes(6).toString('hex')}`;
}

async function eventsNamed(clarityModel: string): Promise<number> {
  const rows = await db
    .select({ id: fallbackEvents.id })
    .from(fallbackEvents)
    .where(eq(fallbackEvents.clarityModel, clarityModel));
  return rows.length;
}

async function bucketsFor(method: string): Promise<number> {
  const rows = await db
    .select({ id: authHealthMetrics.id })
    .from(authHealthMetrics)
    .where(eq(authHealthMetrics.method, method));
  return rows.length;
}

beforeAll(async () => {
  db = await getTestDb();
});

afterAll(closeTestDb);

describe('the registry', () => {
  /**
   * Asserted by CONTENT against the source declarations, not by counting.
   *
   * A Mongo TTL index leaves NO trace in the ported code — no deleted call
   * site, no orphaned function, nothing a reviewer diffing the port would see
   * go absent. A table that loses its entry grows forever with no symptom until
   * the disk fills, so the entries have to be pinned to the numbers the source
   * declared rather than to whatever the registry currently says.
   *
   *   `internal/providers/models/fallback-event.ts:46` — 30 * 24 * 60 * 60
   *   `src/lib/auth-health.ts:53`                      — 7 * 24 * 60 * 60
   *
   * The first file is DELETED as of the providers rewiring; read it at f7834e8.
   * The number stays pinned here precisely because its source is now historical
   * — nothing recomputes it, so this assertion is what preserves it.
   */
  it('names exactly this domain’s two TTL indexes, at the source’s retentions', () => {
    expect(PROVIDER_EXPIRY_TARGETS).toHaveLength(2);

    const [events, auth] = PROVIDER_EXPIRY_TARGETS;

    expect(events?.table).toBe(fallbackEvents);
    expect(events?.column).toBe(fallbackEvents.timestamp);
    expect(events?.retentionSeconds).toBe(30 * 24 * 60 * 60);
    expect(FALLBACK_EVENT_RETENTION_SECONDS).toBe(30 * 24 * 60 * 60);

    expect(auth?.table).toBe(authHealthMetrics);
    expect(auth?.column).toBe(authHealthMetrics.createdAt);
    expect(auth?.retentionSeconds).toBe(7 * 24 * 60 * 60);
    expect(AUTH_HEALTH_METRIC_RETENTION_SECONDS).toBe(7 * 24 * 60 * 60);

    for (const target of PROVIDER_EXPIRY_TARGETS) {
      expect(target.reason).toBeTruthy();
    }
  });

  /**
   * `api_usages` is NOT a target, and this is the assertion that keeps it that
   * way. `internal/providers/models/api-usage.ts` declared no
   * `expireAfterSeconds` (that file is DELETED as of the providers rewiring —
   * read it at f7834e8); the 90-day TTL that looks like it belongs to it is on
   * the billing domain's `api_key_usage`, which does have one. Adding
   * a retention on that resemblance would start deleting rows nobody agreed to
   * delete.
   *
   * A bare "must not contain" would also pass on a registry that failed to
   * load, so it is paired with the length assertion above and the table names
   * it DOES contain.
   */
  it('does not sweep api_usages, which never had a TTL index', () => {
    const tables = PROVIDER_EXPIRY_TARGETS.map((target) => target.table);
    expect(tables).toContain(fallbackEvents);
    expect(tables).toContain(authHealthMetrics);
    expect(tables).toHaveLength(2);
  });

  /**
   * `fallback_event_attempts` must NOT get an entry of its own: its foreign key
   * cascades, so a second target would delete attempts whose parent event is
   * still inside the window — leaving events that look like they needed no
   * fallback at all.
   */
  it('does not sweep the attempts child table separately', () => {
    const names = PROVIDER_EXPIRY_TARGETS.map((target) => String(target.table));
    expect(names.join(' ')).not.toContain('fallback_event_attempts');
  });

  /**
   * `@oxyhq/db/expiry` deletes on the retention column and states it must be
   * indexed. Read out of the live catalogue, not out of the declaration: an
   * index is the one thing whose absence no functional test can detect.
   */
  it('has the indexes the sweep deletes through', async () => {
    const rows = await db.execute(sql`
      select indexname from pg_indexes
      where schemaname = 'public'
        and indexname in ('fallback_events_timestamp_idx', 'auth_health_metrics_created_at_idx')
    `);
    expect(rows).toHaveLength(2);
  });
});

describe('sweeping fallback events', () => {
  it('deletes events past the retention and spares the rest', async () => {
    const oldModel = own('old');
    const freshModel = own('fresh');
    const retentionDays = FALLBACK_EVENT_RETENTION_SECONDS / 86_400;

    await db.insert(fallbackEvents).values([
      {
        clarityModel: oldModel,
        success: false,
        timestamp: new Date(Date.now() - (retentionDays + 1) * DAY),
      },
      {
        clarityModel: freshModel,
        success: true,
        timestamp: new Date(Date.now() - 60_000),
      },
    ]);

    expect(await eventsNamed(oldModel)).toBe(1);

    await sweepAllExpiredRows(db, PROVIDER_EXPIRY_TARGETS);

    expect(await eventsNamed(oldModel)).toBe(0);
    expect(await eventsNamed(freshModel)).toBe(1);
  });

  /**
   * The boundary in the direction that matters. A row one day INSIDE the window
   * must survive: an off-by-one that swept it would destroy a day of analytics
   * silently, and every remaining chart would still render.
   */
  it('spares an event one day inside the window', async () => {
    const model = own('edge');
    const retentionDays = FALLBACK_EVENT_RETENTION_SECONDS / 86_400;

    await db.insert(fallbackEvents).values({
      clarityModel: model,
      success: false,
      timestamp: new Date(Date.now() - (retentionDays - 1) * DAY),
    });

    await sweepAllExpiredRows(db, PROVIDER_EXPIRY_TARGETS);
    expect(await eventsNamed(model)).toBe(1);
  });

  /**
   * The attempts go with the parent, through the cascade rather than through a
   * registry entry of their own. Without it the sweep would leave orphans that
   * no query can reach and nothing ever deletes.
   */
  it('takes an expired event’s attempts with it', async () => {
    const model = own('cascade');
    const retentionDays = FALLBACK_EVENT_RETENTION_SECONDS / 86_400;

    const [event] = await db
      .insert(fallbackEvents)
      .values({
        clarityModel: model,
        success: false,
        timestamp: new Date(Date.now() - (retentionDays + 2) * DAY),
      })
      .returning({ id: fallbackEvents.id });

    await db.insert(fallbackEventAttempts).values([
      { eventId: event.id, position: 0, provider: own('p'), reason: 'timeout' },
      { eventId: event.id, position: 1, provider: own('p'), reason: 'timeout' },
    ]);

    const before = await db
      .select({ id: fallbackEventAttempts.id })
      .from(fallbackEventAttempts)
      .where(eq(fallbackEventAttempts.eventId, event.id));
    expect(before).toHaveLength(2);

    await sweepAllExpiredRows(db, PROVIDER_EXPIRY_TARGETS);

    const after = await db
      .select({ id: fallbackEventAttempts.id })
      .from(fallbackEventAttempts)
      .where(eq(fallbackEventAttempts.eventId, event.id));
    expect(after).toHaveLength(0);
  });
});

describe('sweeping auth health buckets', () => {
  /**
   * The retention is measured from `createdAt`, NOT from `hour` — which is what
   * the Mongo index did (`lib/auth-health.ts:53`). The fixture makes the two
   * disagree: a bucket whose `hour` is ancient but which was WRITTEN a minute
   * ago must survive, and a bucket whose `hour` is recent but which was written
   * long ago must not.
   */
  it('measures retention from createdAt, not from the bucket hour', async () => {
    const recentlyWritten = own('recent-write');
    const longAgoWritten = own('old-write');
    const retentionDays = AUTH_HEALTH_METRIC_RETENTION_SECONDS / 86_400;

    await db.insert(authHealthMetrics).values([
      {
        method: recentlyWritten,
        hour: new Date(Date.now() - 90 * DAY),
        createdAt: new Date(),
      },
      {
        method: longAgoWritten,
        hour: new Date(),
        createdAt: new Date(Date.now() - (retentionDays + 1) * DAY),
      },
    ]);

    await sweepAllExpiredRows(db, PROVIDER_EXPIRY_TARGETS);

    expect(await bucketsFor(recentlyWritten)).toBe(1);
    expect(await bucketsFor(longAgoWritten)).toBe(0);
  });

  it('spares a bucket one day inside the window', async () => {
    const method = own('auth-edge');
    const retentionDays = AUTH_HEALTH_METRIC_RETENTION_SECONDS / 86_400;

    await db.insert(authHealthMetrics).values({
      method,
      hour: new Date(),
      createdAt: new Date(Date.now() - (retentionDays - 1) * DAY),
    });

    await sweepAllExpiredRows(db, PROVIDER_EXPIRY_TARGETS);
    expect(await bucketsFor(method)).toBe(1);
  });
});

describe('the sweep itself', () => {
  /**
   * THE POSITIVE CONTROL for every "the fresh row survived" assertion above.
   *
   * If the sweep silently did nothing at all — a target naming a column that
   * does not exist, a predicate matching no rows, a registry that failed to
   * load — every one of those assertions would read exactly the same. This one
   * fails in that case, and it is the only one that does.
   */
  it('positive control: the sweep really deletes, and says how much', async () => {
    const model = own('control');
    const retentionDays = FALLBACK_EVENT_RETENTION_SECONDS / 86_400;

    await db.insert(fallbackEvents).values({
      clarityModel: model,
      success: false,
      timestamp: new Date(Date.now() - (retentionDays + 40) * DAY),
    });
    expect(await eventsNamed(model)).toBe(1);

    const results = await sweepAllExpiredRows(db, PROVIDER_EXPIRY_TARGETS);

    expect(results).toHaveLength(2);
    expect(results.map((result) => result.table).sort()).toEqual([
      'auth_health_metrics',
      'fallback_events',
    ]);
    const swept = results.find((result) => result.table === 'fallback_events');
    expect(swept?.deleted).toBeGreaterThanOrEqual(1);

    expect(await eventsNamed(model)).toBe(0);
  });

  /** It runs on a schedule, so most runs find nothing and must be a no-op, not an error. */
  it('reports zero deletions when nothing has expired', async () => {
    await sweepAllExpiredRows(db, PROVIDER_EXPIRY_TARGETS);
    const results = await sweepAllExpiredRows(db, PROVIDER_EXPIRY_TARGETS);

    for (const result of results) {
      expect(result.deleted).toBe(0);
      expect(result.truncated).toBe(false);
    }
  });

  /**
   * The sweep must not reach beyond its own tables. `provider_keys` holds the
   * credentials the whole domain runs on and carried no TTL index — a sweep
   * that touched it would take the service offline.
   */
  it('leaves tables outside the registry alone', async () => {
    const counted = await db.execute(sql`
      select
        (select count(*)::int from provider_keys) as keys,
        (select count(*)::int from api_usages) as usages,
        (select count(*)::int from provider_healths) as healths
    `);
    const before = counted[0];

    await sweepAllExpiredRows(db, PROVIDER_EXPIRY_TARGETS);

    const after = (
      await db.execute(sql`
        select
          (select count(*)::int from provider_keys) as keys,
          (select count(*)::int from api_usages) as usages,
          (select count(*)::int from provider_healths) as healths
      `)
    )[0];

    expect(after).toEqual(before);
    // Floor: an all-zero comparison would pass on three empty tables.
    expect(Number(before?.keys)).toBeGreaterThan(0);
  });

  /**
   * A registry entry is only safe once its table's readers are audited for
   * depending on a swept row already being gone. Pinned as numbers, so
   * shortening a retention below the longest read window fails here instead of
   * quietly truncating a chart.
   *
   *   fallback stats  — `routes/fallback-stats.ts:30` caps at 720 hours (30 days)
   *   auth health     — `routes/auth-health.ts:23`    caps at 168 hours (7 days)
   */
  it('retains data for at least as long as the longest read window', () => {
    expect(FALLBACK_EVENT_RETENTION_SECONDS).toBeGreaterThanOrEqual(720 * 3600);
    expect(AUTH_HEALTH_METRIC_RETENTION_SECONDS).toBeGreaterThanOrEqual(168 * 3600);
  });
});
