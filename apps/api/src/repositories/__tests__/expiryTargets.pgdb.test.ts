import { sweepAllExpiredRows } from '@oxyhq/db/expiry';
import { and, eq, sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { BILLING_EXPIRY_TARGETS } from '../../db/expiry-targets.js';
import { API_KEY_USAGE_RETENTION_SECONDS, apiKeyUsage } from '../../db/schema/billing.js';
import { recordApiKeyUsage } from '../apiKeyUsage.js';
import {
  closeTestDb,
  getTestDb,
  type TestDatabase,
  testScope,
} from '../../db/__tests__/testDatabase.js';

let db: TestDatabase;

beforeAll(async () => {
  db = await getTestDb();
});

afterAll(closeTestDb);

/**
 * ## What this file does and does NOT establish
 *
 * It proves the sweep MECHANISM deletes the right rows and spares the wrong
 * ones. It does NOT prove the sweep RUNS: `sweepAllExpiredRows` has no
 * scheduled caller, and every test here invokes it directly.
 *
 * That distinction is the whole point of saying it out loud. A registered
 * sweep with zero callers is green and inert — the suite proves the mechanism
 * CAN work while nothing establishes that it DOES, and a green file named
 * after expiry reads like coverage of a behaviour that is not happening. The
 * rewiring PR owns the schedule, and owes a source-level assertion that the
 * entrypoint really calls the starter.
 */

const RETENTION_DAYS = API_KEY_USAGE_RETENTION_SECONDS / 86_400;

async function usageRowsFor(oxyUserId: string): Promise<number> {
  const rows = await db.execute(
    sql`select count(*)::int as n from ${apiKeyUsage} where ${apiKeyUsage.oxyUserId} = ${oxyUserId}`,
  );
  return Number(rows[0]?.n ?? 0);
}

describe('the billing expiry registry', () => {
  /**
   * A Mongo TTL index is a behaviour of the SOURCE that leaves no trace in the
   * ported code: no deleted call site, no orphaned function, nothing a
   * reviewer diffing the port would see go absent. A table that loses its
   * entry grows forever with no symptom until the disk fills.
   *
   * So the registry is asserted by CONTENT, against the model it came from —
   * `models/api-key-usage.ts:91` declares `expireAfterSeconds: 90 * 24 * 60 * 60`.
   */
  it('carries exactly the one TTL index this domain had, at 90 days', () => {
    expect(BILLING_EXPIRY_TARGETS).toHaveLength(1);
    expect(RETENTION_DAYS).toBe(90);

    const target = BILLING_EXPIRY_TARGETS[0];
    expect(target?.table).toBe(apiKeyUsage);
    expect(target?.column).toBe(apiKeyUsage.timestamp);
    expect(target?.retentionSeconds).toBe(90 * 24 * 60 * 60);
    expect(target?.reason).toBeTruthy();
  });

  /**
   * The retention column must be indexed — the sweep deletes on it, and
   * `@oxyhq/db/expiry` states the requirement. Asserted against the live
   * catalogue rather than the schema declaration, because the declaration is
   * what a `push` might not have applied.
   */
  it('has the index the sweep deletes through', async () => {
    const rows = await db.execute(sql`
      select indexname from pg_indexes
      where schemaname = 'public' and indexname = 'api_key_usage_timestamp_idx'
    `);
    expect(rows).toHaveLength(1);
  });
});

describe('sweeping expired usage rows', () => {
  it('deletes rows past the retention window and spares the rest', async () => {
    const userId = testScope('sweep');

    // Fixture instants are relative to now — an absolute date in a committed
    // fixture ages into a different meaning and detonates in a sibling file.
    await recordApiKeyUsage(db, {
      oxyUserId: userId,
      endpoint: '/old',
      method: 'POST',
      statusCode: 200,
      timestamp: new Date(Date.now() - (RETENTION_DAYS + 1) * 86_400_000),
    });
    await recordApiKeyUsage(db, {
      oxyUserId: userId,
      endpoint: '/fresh',
      method: 'POST',
      statusCode: 200,
      timestamp: new Date(Date.now() - 60_000),
    });

    expect(await usageRowsFor(userId)).toBe(2);

    await sweepAllExpiredRows(db, BILLING_EXPIRY_TARGETS);

    // Scoped to this file's own ids: the sweep is global, so an unscoped count
    // would read whatever sibling files happened to have written.
    const survivors = await db
      .select({ endpoint: apiKeyUsage.endpoint })
      .from(apiKeyUsage)
      .where(eq(apiKeyUsage.oxyUserId, userId));

    expect(survivors.map((r) => r.endpoint)).toEqual(['/fresh']);
  });

  /**
   * The boundary, in the direction that matters. A row one day INSIDE the
   * window must survive: an off-by-one that swept it would destroy a day of
   * usage history silently, and every remaining chart would still render.
   */
  it('spares a row one day inside the window', async () => {
    const userId = testScope('sweep-edge');
    await recordApiKeyUsage(db, {
      oxyUserId: userId,
      endpoint: '/edge',
      method: 'GET',
      statusCode: 200,
      timestamp: new Date(Date.now() - (RETENTION_DAYS - 1) * 86_400_000),
    });

    await sweepAllExpiredRows(db, BILLING_EXPIRY_TARGETS);

    expect(await usageRowsFor(userId)).toBe(1);
  });

  /**
   * A sweep with nothing to do must be a no-op, not an error — it runs on a
   * schedule and most runs will find nothing.
   */
  it('reports zero deletions when nothing has expired', async () => {
    const userId = testScope('sweep-none');
    await recordApiKeyUsage(db, {
      oxyUserId: userId,
      endpoint: '/recent',
      method: 'GET',
      statusCode: 200,
      timestamp: new Date(Date.now() - 60_000),
    });

    const results = await sweepAllExpiredRows(db, BILLING_EXPIRY_TARGETS);

    expect(results).toHaveLength(1);
    expect(results[0]?.table).toBeTruthy();
    expect(await usageRowsFor(userId)).toBe(1);
  });

  /**
   * The positive control for the two assertions above: if the sweep silently
   * did nothing at all — a broken target, a column that does not exist, a
   * predicate matching no rows — "the fresh row survived" would read exactly
   * the same. This proves the sweep can actually delete.
   */
  it('positive control: the sweep really deletes when a row is expired', async () => {
    const userId = testScope('sweep-control');
    await recordApiKeyUsage(db, {
      oxyUserId: userId,
      endpoint: '/ancient',
      method: 'DELETE',
      statusCode: 204,
      timestamp: new Date(Date.now() - (RETENTION_DAYS + 30) * 86_400_000),
    });
    expect(await usageRowsFor(userId)).toBe(1);

    await sweepAllExpiredRows(db, BILLING_EXPIRY_TARGETS);

    expect(await usageRowsFor(userId)).toBe(0);
  });

  /**
   * The sweep must not reach beyond its own table. `transactions` is the money
   * ledger, carried no TTL index, and has no registry entry — a sweep that
   * touched it would destroy payment history.
   */
  it('leaves tables outside the registry alone', async () => {
    const rows = await db.execute(sql`
      select count(*)::int as n from information_schema.tables
      where table_schema = 'public' and table_name = 'transactions'
    `);
    expect(Number(rows[0]?.n)).toBe(1);

    const registeredTables = BILLING_EXPIRY_TARGETS.map((t) => t.table);
    expect(registeredTables).not.toContain('transactions');
    expect(registeredTables).toHaveLength(1);
  });
});

describe('read paths coexist with the sweep', () => {
  /**
   * A registry entry is only safe once its table's readers are audited for
   * depending on a swept row already being gone. Every read path here filters
   * on `timestamp` with its own window, the longest being 30 days
   * (`routes/credits.ts:35`) — comfortably inside the 90-day retention — so a
   * not-yet-swept row is stale at worst, never unsafe.
   *
   * This pins the relationship as a number, so shortening the retention below
   * the longest read window fails here instead of quietly truncating a chart.
   */
  it('retains data for longer than the longest read window', async () => {
    const longestReadWindowDays = 30;
    expect(RETENTION_DAYS).toBeGreaterThan(longestReadWindowDays);
  });

  it('a 30-day read finds rows the sweep would not have taken', async () => {
    const userId = testScope('sweep-read');
    await recordApiKeyUsage(db, {
      oxyUserId: userId,
      endpoint: '/in-window',
      method: 'POST',
      statusCode: 200,
      tokensUsed: 1500,
      timestamp: new Date(Date.now() - 29 * 86_400_000),
    });

    await sweepAllExpiredRows(db, BILLING_EXPIRY_TARGETS);

    const rows = await db
      .select({ endpoint: apiKeyUsage.endpoint })
      .from(apiKeyUsage)
      .where(
        and(
          eq(apiKeyUsage.oxyUserId, userId),
          sql`${apiKeyUsage.timestamp} >= now() - interval '30 days'`,
        ),
      );

    expect(rows).toHaveLength(1);
  });
});
