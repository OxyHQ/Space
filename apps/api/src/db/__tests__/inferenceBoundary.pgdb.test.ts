import { sql } from 'drizzle-orm';
import { executeRows } from '@oxyhq/db';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { closeTestDb, getTestDb, schemaTableNames, type TestDatabase } from './testDatabase.js';

const RETIRED_TABLES = [
  'api_key_usage',
  'api_usages',
  'auth_health_metrics',
  'chat_analytics',
  'clarity_model_provider_mappings',
  'clarity_models',
  'conversations',
  'cost_entries',
  'credit_packages',
  'developer_api_keys',
  'developer_apps',
  'fallback_event_attempts',
  'fallback_events',
  'features',
  'messages',
  'model_configs',
  'plan_features',
  'plans',
  'provider_healths',
  'provider_keys',
  'subscriptions',
  'transactions',
  'user_credits',
] as const;

let db: TestDatabase;

beforeAll(async () => {
  db = await getTestDb();
});

afterAll(closeTestDb);

describe('the live Station schema contains workspace data only', () => {
  it('does not declare or create retired inference, provider-key or AI-billing tables', async () => {
    const declared = schemaTableNames();
    const liveRows = await executeRows<{ table_name: string }>(
      db,
      sql`select table_name
          from information_schema.tables
          where table_schema = 'public'
            and table_name = any(${sql.param([...RETIRED_TABLES])})
          order by table_name`,
    );

    expect(declared.length).toBeGreaterThanOrEqual(12);
    expect(declared).toContain('workspaces');
    expect(declared).toContain('feedback');
    expect(declared.filter((name) => RETIRED_TABLES.includes(name as (typeof RETIRED_TABLES)[number]))).toEqual([]);
    expect(liveRows).toEqual([]);
  });
});
