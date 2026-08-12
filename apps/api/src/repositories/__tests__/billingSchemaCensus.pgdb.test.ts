import { getTableConfig } from 'drizzle-orm/pg-core';
import { sqlColumnName } from '@oxyhq/db';
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { PgTable } from 'drizzle-orm/pg-core';
import {
  apiKeyUsage,
  developerApiKeys,
  developerApps,
  feedback,
  subscriptions,
  transactions,
  userCredits,
} from '../../db/schema/billing.js';
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
 * ## The writer-versus-columns diff, kept as a gate rather than done once
 *
 * A `pgTable` can OMIT a column its writer writes and every other gate stays
 * green: `tsc` does not object, because the insert simply never mentions the
 * field; a schema test does not compare field SETS; and the table exists, so
 * nothing errors on read. The symptom arrives later as a query grouping by a
 * column that is always null and returning an empty list to every user.
 *
 * So each expected set below is transcribed from the SOURCE WRITERS — the
 * `create`/`save`/`findOneAndUpdate` call sites named beside it — and compared
 * against the columns the database actually has. A field a writer sets with no
 * column to land in fails here.
 *
 * Column names come from `sqlColumnName`, never spelled by hand:
 * `getTableConfig(t).columns[].name` is the TypeScript PROPERTY name, so
 * building the set from it yields camelCase and produces a false-positive list
 * of "columns with no writer" that costs an hour to dismiss.
 */

/** The SQL identifiers a table declares, as drizzle will actually emit them. */
function declaredColumns(table: PgTable): string[] {
  return getTableConfig(table)
    .columns.map((c) => sqlColumnName(c))
    .sort();
}

/** The SQL identifiers the LIVE database has, which is the real authority. */
async function liveColumns(tableName: string): Promise<string[]> {
  const rows = await db.execute(sql`
    select column_name from information_schema.columns
    where table_schema = 'public' and table_name = ${tableName}
    order by column_name
  `);
  return rows.map((r) => String(r.column_name));
}

/**
 * Every billing table, with the columns its Mongo writers actually produce.
 *
 * `id`, `created_at` and `updated_at` are included where the source carried
 * them (`timestamps: true`); `api_key_usage` deliberately has no timestamp
 * pair because its schema sets `timestamps: false`.
 */
const EXPECTED: { table: PgTable; name: string; columns: string[]; writers: string }[] = [
  {
    table: userCredits,
    name: 'user_credits',
    writers:
      'lib/user-credits-helpers.ts:14, routes/v1.ts:43, routes/billing.ts:64, lib/credits-manager.ts:97 (incl. the undeclared credits.lastUsed at :111), models/user-credits.ts:44/58/90',
    columns: [
      'id',
      'credits_free',
      'credits_free_limit',
      'credits_daily_refresh',
      'credits_paid',
      'credits_last_refresh',
      'credits_last_used',
      'stripe_customer_id',
      'created_at',
      'updated_at',
    ],
  },
  {
    table: subscriptions,
    name: 'subscriptions',
    writers: 'routes/billing.ts:695 (upsert), :500 (change plan), :412, :744, :773',
    columns: [
      'id',
      'oxy_user_id',
      'stripe_customer_id',
      'stripe_subscription_id',
      'stripe_price_id',
      'status',
      'current_period_start',
      'current_period_end',
      'cancel_at_period_end',
      'plan_id',
      'billing_period',
      'plan_plan_id',
      'plan_name',
      'plan_product',
      'plan_credits_per_month',
      'plan_price',
      'plan_currency',
      'plan_billing_period',
      'created_at',
      'updated_at',
    ],
  },
  {
    table: transactions,
    name: 'transactions',
    writers: 'routes/billing.ts:631 (credit purchase), :718 (subscription grant)',
    columns: [
      'id',
      'oxy_user_id',
      'stripe_customer_id',
      'stripe_payment_intent_id',
      'type',
      'amount',
      'currency',
      'credits',
      'status',
      'description',
      'dedup',
      'metadata',
      'created_at',
      'updated_at',
    ],
  },
  {
    table: apiKeyUsage,
    name: 'api_key_usage',
    writers: 'middleware/api-key-rate-limit.ts:240 (the only writer; never sets api_key_id or app_id)',
    columns: [
      'id',
      'api_key_id',
      'oxy_user_id',
      'app_id',
      'endpoint',
      'method',
      'status_code',
      'tokens_used',
      'credits_used',
      'response_time',
      'user_agent',
      'ip_address',
      'timestamp',
      'auth_type',
      'service_app',
    ],
  },
  {
    table: feedback,
    name: 'feedback',
    writers: 'routes/feedback.ts:35',
    columns: [
      'id',
      'oxy_user_id',
      'type',
      'rating',
      'message',
      'email',
      'metadata_platform',
      'metadata_app_version',
      'metadata_device_info',
      'status',
      'created_at',
      'updated_at',
    ],
  },
  {
    table: developerApps,
    name: 'developer_apps',
    writers: 'none — no call sites anywhere in src/',
    columns: [
      'id',
      'oxy_user_id',
      'organization_id',
      'name',
      'description',
      'website_url',
      'redirect_urls',
      'icon',
      'is_active',
      'created_at',
      'updated_at',
    ],
  },
  {
    table: developerApiKeys,
    name: 'developer_api_keys',
    writers: 'none — no call sites anywhere in src/',
    columns: [
      'id',
      'oxy_user_id',
      'app_id',
      'name',
      'key_hash',
      'key_prefix',
      'scopes',
      'expires_at',
      'last_used_at',
      'is_active',
      'rate_limit_requests_per_minute',
      'rate_limit_requests_per_day',
      'rate_limit_tokens_per_minute',
      'rate_limit_tokens_per_day',
      'created_at',
      'updated_at',
    ],
  },
];

describe('every billing table has exactly the columns its writers need', () => {
  for (const { table, name, columns, writers } of EXPECTED) {
    it(`${name} — writers: ${writers}`, async () => {
      expect(declaredColumns(table)).toEqual([...columns].sort());
      expect(await liveColumns(name)).toEqual([...columns].sort());
    });
  }

  /**
   * The vacuity floor. Every assertion above compares two lists, and two empty
   * lists are equal — a broken `getTableConfig`, a schema that failed to load,
   * or a query against the wrong database would make each one pass by
   * comparing nothing to nothing.
   *
   * The total is derived from the EXPECTED literals rather than written as a
   * magic number: a hand-typed count is a second place for the truth to live,
   * and the first version of this line said 117 against an actual 112 — a
   * number nothing recomputes is a number that is eventually wrong.
   */
  it('positive control: the census actually read columns', async () => {
    const declaredTotal = EXPECTED.reduce((n, e) => n + declaredColumns(e.table).length, 0);
    const expectedTotal = EXPECTED.reduce((n, e) => n + e.columns.length, 0);

    expect(declaredTotal).toBe(expectedTotal);
    // Derived from the census rather than hardcoded. A fixed floor has to be
    // edited on every legitimate change -- it went stale the moment
    // cost_entries moved to the providers domain -- and a floor that is
    // routinely edited downward stops being a floor. Ten columns per table is
    // far below any real billing table and far above what a broken read
    // (zero) or a half-broken one would produce.
    expect(declaredTotal).toBeGreaterThan(10 * EXPECTED.length);

    const live = await liveColumns('user_credits');
    expect(live.length).toBeGreaterThan(0);
    expect(live).toContain('credits_free');
  });

  /**
   * `sqlColumnName` must be doing real work. If it returned the TypeScript
   * property name, this would read `creditsFree` — the exact failure that
   * produces a plausible, wholly wrong "columns with no writer" list.
   */
  it('positive control: column names are SQL identifiers, not JS properties', () => {
    const names = declaredColumns(userCredits);
    expect(names).toContain('credits_free');
    expect(names).not.toContain('creditsFree');
  });
});

/**
 * The schema-loaded count. `drizzle-kit generate` exits 0 and leaves its output
 * byte-identical BOTH when there is nothing to do and when the schema failed to
 * load entirely — only a table count tells those apart, and the same reasoning
 * applies to any claim that this domain's tables exist.
 */
describe('the billing domain is fully reachable from the schema entry point', () => {
  /**
   * Seven, not the eight this census was written against.
   *
   * A decrement in a gate is how one erodes into vacuity, so the reason is
   * named here rather than left as a smaller number: `cost_entries` was ported
   * twice, by this domain and by providers, and providers' copy is the one
   * kept -- CostEntry is the provider-routing cost ledger and
   * `lib/cost-tracker.ts` is provider-routing code. It is still censused, by
   * providers' own suite. This decrement is legitimate ONLY because it is
   * paired with that named relocation in the same change; a future decrement
   * needs its own.
   */
  it('declares all seven tables', () => {
    expect(EXPECTED).toHaveLength(7);
    const names = new Set(EXPECTED.map((e) => getTableConfig(e.table).name));
    expect(names.size).toBe(7);
  });

  it('all seven exist in the database', async () => {
    const rows = await db.execute(sql`
      select table_name from information_schema.tables
      where table_schema = 'public'
        and table_name in (
          'user_credits','subscriptions','transactions','api_key_usage',
          'cost_entries','feedback','developer_apps','developer_api_keys'
        )
    `);
    expect(rows).toHaveLength(8);
  });

  /**
   * A value interpolated into a `check()` becomes the literal `$1` in the
   * generated migration and fails at APPLY time. Every CHECK in this domain
   * renders its constant side through `sql.raw`, and this is what proves it
   * against the applied DDL rather than against the declaration.
   */
  it('no CHECK constraint carries a bound parameter', async () => {
    const rows = await db.execute(sql`
      select conname, pg_get_constraintdef(oid) as def
      from pg_constraint
      where contype = 'c' and connamespace = 'public'::regnamespace
    `);

    const withParams = rows.filter((r) => /\$\d/.test(String(r.def)));
    expect(withParams.map((r) => r.conname)).toEqual([]);
    // Floor: a run that read no constraints would also report none with params.
    expect(rows.length).toBeGreaterThanOrEqual(16);
  });
});
