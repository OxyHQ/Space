/**
 * `provider_keys` and `api_usages` against a real PostgreSQL 17.
 *
 * ## Scoping
 *
 * Every `*.pgdb.test.ts` shares one database, so any assertion that COUNTS or
 * AGGREGATES is scoped to ids this file owns — `own()` mints them. Two
 * functions under test are unavoidably global (`countActiveKeys`,
 * `resetCooldowns`); those are asserted as DELTAS, and this is the only file in
 * the suite that writes `provider_keys`, which is what makes a delta sound.
 *
 * Fixture instants are relative to `now`. An absolute date in a committed
 * fixture ages into a different meaning and detonates later in a sibling file.
 */

import { randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { and, eq, sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { closeTestDb, getTestDb, type TestDatabase } from '../../db/__tests__/testDatabase.js';
import { apiUsages, providerKeys } from '../../db/schema/providers.js';
import * as apiUsageRepo from '../api-usages.js';
import * as keys from '../provider-keys.js';

const FILE = 'pk';
let db: TestDatabase;

/** An id no other file and no previous run can produce. */
function own(label: string): string {
  return `${FILE}-${label}-${randomBytes(6).toString('hex')}`;
}

async function makeKey(overrides: Partial<typeof providerKeys.$inferInsert> = {}) {
  const secret = overrides.key ?? own('secret');
  return keys.createKey(db, {
    name: own('name'),
    provider: 'openai',
    keyHash: overrides.keyHash ?? keys.hashProviderKey(secret),
    keyPrefix: keys.providerKeyPrefix(secret),
    key: secret,
    ...overrides,
  });
}

beforeAll(async () => {
  db = await getTestDb();
});

afterAll(closeTestDb);

describe('the secret and its digest are stored and matched differently', () => {
  /**
   * The digest is the LOOKUP. A randomised or salted scheme would not error
   * here — `findByKeyHash` would simply return null for a key that exists, so
   * `POST /v1/keys` would accept a duplicate and the unique index would reject
   * it with a 500 nobody could explain.
   */
  it('the same secret always produces the same digest, so the lookup matches', async () => {
    const secret = own('deterministic');
    const first = keys.hashProviderKey(secret);
    const second = keys.hashProviderKey(secret);
    expect(second).toBe(first);

    const created = await makeKey({ key: secret, keyHash: first });
    const found = await keys.findByKeyHash(db, keys.hashProviderKey(secret));

    expect(found?.id).toBe(created.id);
  });

  /**
   * The negative control for the assertion above, in the same currency: a
   * DIFFERENT secret must not match. Without it, "the lookup found the row"
   * would read identically against a predicate that matched everything.
   */
  it('a different secret does not match', async () => {
    await makeKey();
    expect(await keys.findByKeyHash(db, keys.hashProviderKey(own('other')))).toBeNull();
  });

  /**
   * The asymmetry, as a property of the MODULE rather than of one call.
   *
   * "Make the two secret columns consistent" is a plausible future change, and
   * the way it goes wrong is by introducing a lookup on `key` — at which point
   * encrypting `key` silently breaks it. Asserted against the source text
   * because there is no runtime shape to inspect: a function that does not
   * exist cannot be called.
   *
   * The floor is what keeps this from passing on an unreadable file.
   */
  it('exposes no way to find a key by its secret value', () => {
    const source = readFileSync(new URL('../provider-keys.ts', import.meta.url), 'utf8');
    expect(source.length).toBeGreaterThan(1000);
    // Positive control: the scan can see the lookup that DOES exist.
    expect(source).toContain('eq(providerKeys.keyHash, keyHash)');
    // The COMMA is load-bearing. Without it the pattern is a prefix of the
    // legitimate `eq(providerKeys.keyHash, ...)` lookup, so the assertion fires
    // on the very thing it exists to permit — measured, on the first run.
    expect(source).not.toContain('eq(providerKeys.key,');
  });

  /**
   * `.select('-keyHash -key')`, ported. Both must be absent, and the projection
   * must be non-empty — an empty selection would satisfy "does not contain the
   * secret" while returning nothing at all.
   */
  it('the public projection carries neither the secret nor its digest', async () => {
    const created = await makeKey();
    const row = await keys.findPublicById(db, created.id);

    expect(Object.keys(keys.PUBLIC_COLUMNS).length).toBeGreaterThan(20);
    expect(row).not.toBeNull();
    expect(row).not.toHaveProperty('key');
    expect(row).not.toHaveProperty('keyHash');
    expect(row?.keyPrefix).toBe(created.keyPrefix);
  });
});

describe('failure and success bookkeeping', () => {
  it('a real failure increments both counters and moves the key to the back', async () => {
    const key = await makeKey({ currentPriority: 5, originalPriority: 5 });

    const after = await keys.recordFailure(db, key.id, 'connection reset', 20);

    expect(after?.consecutiveFailures).toBe(1);
    expect(after?.totalFailures).toBe(1);
    expect(after?.currentPriority).toBe(21);
    expect(after?.lastFailureReason).toBe('connection reset');
  });

  /**
   * A rate limit means the key works and the quota does not. It must move down
   * the queue WITHOUT counting toward archival, or a busy key is archived for
   * being busy — which is the failure mode the source's regex exists to
   * prevent.
   */
  it('a rate-limit failure moves the key without counting toward archival', async () => {
    const key = await makeKey({ currentPriority: 5, originalPriority: 5 });

    const after = await keys.recordFailure(db, key.id, 'HTTP 429 Too Many Requests', 30);

    expect(after?.consecutiveFailures).toBe(0);
    expect(after?.totalFailures).toBe(0);
    expect(after?.currentPriority).toBe(31);
    expect(after?.isArchived).toBe(false);
  });

  it('archives once total failures reach the key’s own threshold', async () => {
    const key = await makeKey({ maxTotalFailures: 10, totalFailures: 9 });

    const after = await keys.recordFailure(db, key.id, 'upstream 500', 12);

    expect(after?.totalFailures).toBe(10);
    expect(after?.isArchived).toBe(true);
    expect(after?.isActive).toBe(false);
    // The source quotes the POST-increment total.
    expect(after?.archivedReason).toBe('Archived after 10 total failures');
    expect(after?.archivedAt).toBeInstanceOf(Date);
  });

  it('does not archive one failure short of the threshold', async () => {
    const key = await makeKey({ maxTotalFailures: 10, totalFailures: 8 });
    const after = await keys.recordFailure(db, key.id, 'upstream 500', 12);

    expect(after?.totalFailures).toBe(9);
    expect(after?.isArchived).toBe(false);
  });

  /**
   * Success restores the priority, clears the cooldown and reactivates — the
   * three writes the source spreads across `key.save()` and a following
   * `updateOne`, merged so a crash between them cannot leave a key that
   * succeeded still in cooldown.
   */
  it('success restores priority, clears the cooldown and reactivates', async () => {
    const key = await makeKey({
      currentPriority: 99,
      originalPriority: 7,
      isActive: false,
      consecutiveFailures: 4,
      cooldownUntil: new Date(Date.now() + 60_000),
    });

    const after = await keys.recordSuccess(db, key.id);

    expect(after?.currentPriority).toBe(7);
    expect(after?.consecutiveFailures).toBe(0);
    expect(after?.successCount).toBe(1);
    expect(after?.cooldownUntil).toBeNull();
    expect(after?.isActive).toBe(true);
  });

  /** An archived key must stay inactive — reactivating one is what the guard prevents. */
  it('success does not reactivate an archived key', async () => {
    const key = await makeKey({ isArchived: true, isActive: false });
    const after = await keys.recordSuccess(db, key.id);

    expect(after?.isArchived).toBe(true);
    expect(after?.isActive).toBe(false);
  });
});

describe('numbers come back as numbers', () => {
  /**
   * postgres.js decodes `int8` as a STRING while drizzle types it `number`, so
   * `max + 1` becomes string concatenation. `maxPriorityInGroup` feeds exactly
   * that expression in `key-manager.ts:373`.
   *
   * Two keys, not one: with a single row `"20" + 1 === "201"` and `20 + 1 ===
   * 21` are both "a value", and only comparing the ARITHMETIC result to a
   * number tells them apart. The `typeof` assertion is what makes the failure
   * name its own cause.
   */
  it('maxPriorityInGroup returns a number that survives arithmetic', async () => {
    const provider = 'groq';
    await makeKey({ provider, isPaid: false, currentPriority: 12 });
    await makeKey({ provider, isPaid: false, currentPriority: 20 });

    const max = await keys.maxPriorityInGroup(db, provider, false);

    expect(typeof max).toBe('number');
    expect(max).toBe(20);
    expect((max ?? 0) + 1).toBe(21);
    expect(String((max ?? 0) + 1)).not.toBe('201');
  });

  it('returns null for a group with no keys, so the caller can fall back to 999', async () => {
    expect(await keys.maxPriorityInGroup(db, 'cohere', true)).toBeNull();
  });

  /**
   * Lifetime counters are `bigint` columns. `recordUsage` increments them in
   * SQL and the row must read back as numbers, or every later `+=` in the
   * caller concatenates.
   */
  it('usage counters increment as numbers', async () => {
    const key = await makeKey();

    await keys.recordUsage(db, key.id, 1500);
    await keys.recordUsage(db, key.id, 2500);

    const after = await keys.findById(db, key.id);
    expect(typeof after?.totalTokens).toBe('number');
    expect(after?.totalTokens).toBe(4000);
    expect(after?.totalRequests).toBe(2);
    expect(after?.lastUsedAt).toBeInstanceOf(Date);
  });
});

describe('patching a key', () => {
  /**
   * THE `$set: { x: undefined }` HAZARD.
   *
   * Mongoose strips undefined from an update, so a PATCH mentioning only
   * `isActive` leaves every other field alone. The naive Postgres translation
   * writes NULL and erases them — silently, with a 200. This is the assertion
   * that fails if `patchKey` ever stops relying on drizzle dropping undefined.
   */
  it('leaves fields the caller did not mention alone', async () => {
    const key = await makeKey({ creditLimitUSD: 25, rateLimitRpm: 60, tier: 'paid' });

    const after = await keys.patchKey(db, key.id, { isActive: false });

    expect(after?.isActive).toBe(false);
    expect(after?.creditLimitUSD).toBe(25);
    expect(after?.rateLimitRpm).toBe(60);
    expect(after?.tier).toBe('paid');
  });

  /** An explicit null still clears — that is a caller saying so, and Mongo agrees. */
  it('an explicit null clears the field', async () => {
    const key = await makeKey({ creditLimitUSD: 25 });
    const after = await keys.patchKey(db, key.id, { creditLimitUSD: null });

    expect(after?.creditLimitUSD).toBeNull();
  });

  /** drizzle throws `No values to set` on an empty SET clause; the guard returns the row. */
  it('an all-undefined patch is a no-op rather than an error', async () => {
    const key = await makeKey({ name: 'unchanged-name' });
    const after = await keys.patchKey(db, key.id, { isActive: undefined });

    expect(after?.name).toBe('unchanged-name');
  });
});

describe('credit limits and cooldowns', () => {
  it('marks a key exhausted at its own limit, in one statement', async () => {
    const key = await makeKey({ creditLimitUSD: 12.5, spentUSD: 3 });

    expect(await keys.markCreditExhausted(db, key.id)).toBe(true);
    expect((await keys.findById(db, key.id))?.spentUSD).toBe(12.5);
  });

  /**
   * A key with no limit is left alone and the caller is told so. The source
   * expressed this as an `if` around a second round trip; here it is the
   * predicate, so a limit changing between the read and the write cannot make
   * the two disagree.
   */
  it('reports false for a key with no credit limit, and writes nothing', async () => {
    const key = await makeKey({ creditLimitUSD: null, spentUSD: 4 });

    expect(await keys.markCreditExhausted(db, key.id)).toBe(false);
    expect((await keys.findById(db, key.id))?.spentUSD).toBe(4);
  });

  it('accumulates spend', async () => {
    const key = await makeKey({ spentUSD: 0 });
    await keys.recordSpend(db, key.id, 0.25);
    await keys.recordSpend(db, key.id, 0.5);

    expect((await keys.findById(db, key.id))?.spentUSD).toBeCloseTo(0.75, 10);
  });

  /**
   * `resetCooldowns` reports Mongo's `modifiedCount`; Postgres reports matched
   * rows. They agree only because every row the predicate selects genuinely
   * changes. The delta is measured across a global call, which is sound because
   * this is the only file that writes `provider_keys`.
   */
  it('resets exactly the keys that needed resetting', async () => {
    await keys.resetCooldowns(db);

    const needsReset = await makeKey({
      cooldownUntil: new Date(Date.now() + 60_000),
      consecutiveFailures: 3,
    });
    const alsoNeedsReset = await makeKey({ consecutiveFailures: 1 });
    const clean = await makeKey({ cooldownUntil: null, consecutiveFailures: 0 });

    expect(await keys.resetCooldowns(db)).toBe(2);

    expect((await keys.findById(db, needsReset.id))?.cooldownUntil).toBeNull();
    expect((await keys.findById(db, alsoNeedsReset.id))?.consecutiveFailures).toBe(0);
    expect((await keys.findById(db, clean.id))?.consecutiveFailures).toBe(0);
  });

  it('counts active, non-archived keys', async () => {
    const before = await keys.countActiveKeys(db);
    await makeKey({ isActive: true, isArchived: false });
    await makeKey({ isActive: false, isArchived: false });
    await makeKey({ isActive: true, isArchived: true });

    expect(await keys.countActiveKeys(db)).toBe(before + 1);
  });
});

describe('rate-limit windows', () => {
  /**
   * The `$facet` port. Every aggregate is cast, because the caller ADDS the
   * token sums to an estimate before comparing — `"0" + 500 > 100` is a string
   * comparison that usually gives the right answer, which is what makes it
   * dangerous.
   */
  it('returns counts and token sums as numbers, scoped to the window', async () => {
    const key = await makeKey();
    const now = new Date();

    // Inside every window.
    await apiUsageRepo.recordUsage(db, {
      keyId: key.id,
      provider: 'openai',
      modelId: own('m'),
      tokens: 100,
      timestamp: new Date(now.getTime() - 200),
    });
    // Inside the hour and the day, outside the second and the minute.
    await apiUsageRepo.recordUsage(db, {
      keyId: key.id,
      provider: 'openai',
      modelId: own('m'),
      tokens: 250,
      timestamp: new Date(now.getTime() - 30 * 60_000),
    });
    // Inside the day only.
    await apiUsageRepo.recordUsage(db, {
      keyId: key.id,
      provider: 'openai',
      modelId: own('m'),
      tokens: 400,
      timestamp: new Date(now.getTime() - 5 * 3_600_000),
    });
    // Outside every window — the negative control. Two days, deliberately well
    // inside every expiry retention in this schema so no sweep can take it.
    await apiUsageRepo.recordUsage(db, {
      keyId: key.id,
      provider: 'openai',
      modelId: own('m'),
      tokens: 9999,
      timestamp: new Date(now.getTime() - 2 * 86_400_000),
    });

    const windows = await apiUsageRepo.usageWindowsForKey(db, key.id, now);

    expect(windows.second).toEqual({ count: 1, tokens: 100 });
    expect(windows.minute).toEqual({ count: 1, tokens: 100 });
    expect(windows.hour).toEqual({ count: 2, tokens: 350 });
    expect(windows.day).toEqual({ count: 3, tokens: 750 });

    expect(typeof windows.day.count).toBe('number');
    expect(typeof windows.day.tokens).toBe('number');
    // The arithmetic the caller actually performs.
    expect(windows.day.tokens + 500).toBe(1250);
  });

  it('reports zeroes rather than nulls for a key with no usage', async () => {
    const key = await makeKey();
    const windows = await apiUsageRepo.usageWindowsForKey(db, key.id);

    expect(windows.day).toEqual({ count: 0, tokens: 0 });
    expect(windows.second.tokens + 1).toBe(1);
  });

  /**
   * An environment-derived id has no row. Without the foreign key Postgres
   * would store the dangling id happily, so the transitional failure must stay
   * loud until PR B removes the environment-key path.
   */
  it('refuses a usage row for a key that does not exist', async () => {
    await expect(
      apiUsageRepo.recordUsage(db, {
        keyId: 'env-google-0',
        provider: 'google',
        modelId: own('m'),
        tokens: 10,
      }),
    ).rejects.toThrow();
  });

  it('removes a key’s usage rows with the key', async () => {
    const key = await makeKey();
    await apiUsageRepo.recordUsage(db, {
      keyId: key.id,
      provider: 'openai',
      modelId: own('m'),
      tokens: 1,
    });

    await keys.deleteKey(db, key.id);

    const remaining = await db.select().from(apiUsages).where(eq(apiUsages.keyId, key.id));
    expect(remaining).toHaveLength(0);
  });
});

describe('selection order', () => {
  /**
   * Free keys before paid, each group by ascending priority — the JavaScript
   * sort in `key-manager.ts:142-151`, moved into SQL. `id` breaks ties because
   * `Array.prototype.sort` is stable and a Postgres sort is not.
   */
  it('returns free keys before paid, each by ascending priority', async () => {
    const provider = 'mistral';
    const paidLow = await makeKey({ provider, isPaid: true, currentPriority: 1 });
    const freeHigh = await makeKey({ provider, isPaid: false, currentPriority: 50 });
    const freeLow = await makeKey({ provider, isPaid: false, currentPriority: 2 });

    const mine = new Set([freeLow.id, freeHigh.id, paidLow.id]);
    const selected = (await keys.listSelectableKeys(db, provider)).filter((row) =>
      mine.has(row.id),
    );

    // Scoped to this test's own rows. Nothing truncates between runs, so an
    // unscoped assertion reads the previous run's keys for the same provider —
    // which is exactly how it failed the first time it was written.
    expect(selected).toHaveLength(3);
    expect(selected.map((row) => row.id)).toEqual([freeLow.id, freeHigh.id, paidLow.id]);
  });

  it('excludes archived and inactive keys', async () => {
    const provider = 'deepseek';
    const usable = await makeKey({ provider });
    const hidden = await makeKey({ provider, isArchived: true });
    const inactive = await makeKey({ provider, isActive: false });

    const mine = new Set([usable.id, hidden.id, inactive.id]);
    const selected = (await keys.listSelectableKeys(db, provider)).filter((row) =>
      mine.has(row.id),
    );
    expect(selected.map((row) => row.id)).toEqual([usable.id]);
  });
});

describe('what the DDL actually created', () => {
  /**
   * An index is the one thing whose absence no functional test can detect: a
   * sequential scan returns exactly the right rows. Read out of the catalogue,
   * not out of the declaration.
   */
  it('created the indexes the selection and lookup paths need', async () => {
    const rows = await db.execute(sql`
      select indexname from pg_indexes
      where schemaname = 'public' and tablename in ('provider_keys', 'api_usages')
    `);
    const names = rows.map((row) => String(row.indexname));

    expect(names).toContain('provider_keys_key_hash_key');
    expect(names).toContain('provider_keys_provider_active_archived_priority_idx');
    expect(names).toContain('provider_keys_environment_active_idx');
    expect(names).toContain('api_usages_key_timestamp_idx');
  });

  /**
   * `provider-key.ts:251-252` declares these `{ sparse: true }`. A Mongo sparse
   * index omits documents missing the field; a Postgres b-tree indexes nulls
   * and needs no predicate. Porting the predicate would embed a false belief
   * about Postgres in the schema, so the assertion is that there is NO
   * predicate — and it is paired with a control proving the query can see one,
   * or "no partial index" is also what a broken catalogue query reports.
   */
  it('ported the sparse indexes as plain indexes, with no partial predicate', async () => {
    const rows = await db.execute(sql`
      select indexname, indexdef from pg_indexes
      where schemaname = 'public'
        and indexname in ('provider_keys_owner_idx', 'provider_keys_organization_idx')
    `);

    expect(rows).toHaveLength(2);
    for (const row of rows) {
      expect(String(row.indexdef)).not.toContain(' WHERE ');
    }

    // Positive control, in the same currency: this query CAN see a `WHERE` on a
    // partial index. `workspaces` declares one deliberately.
    const partial = await db.execute(sql`
      select indexdef from pg_indexes
      where schemaname = 'public' and indexname = 'unique_personal_workspace_per_owner'
    `);
    expect(partial).toHaveLength(1);
    expect(String(partial[0]?.indexdef)).toContain(' WHERE ');
  });

  it('enforces the provider enum the Mongoose schema declared', async () => {
    await expect(makeKey({ provider: 'not-a-provider' })).rejects.toThrow();
  });

  it('enforces the name length the Mongoose validator enforced', async () => {
    await expect(makeKey({ name: 'x'.repeat(201) })).rejects.toThrow();
    const ok = await makeKey({ name: 'x'.repeat(200) });
    expect(ok.name).toHaveLength(200);
  });

  it('rejects a duplicate digest', async () => {
    const secret = own('dupe');
    await makeKey({ key: secret, keyHash: keys.hashProviderKey(secret) });
    await expect(makeKey({ key: secret, keyHash: keys.hashProviderKey(secret) })).rejects.toThrow();
  });
});

describe('rotation', () => {
  it('replaces the digest, the prefix and the secret in one statement', async () => {
    const key = await makeKey();
    const replacement = own('rotated');

    const after = await keys.rotateKey(db, key.id, replacement);

    expect(after?.keyHash).toBe(keys.hashProviderKey(replacement));
    expect(after?.key).toBe(replacement);
    expect(after?.keyPrefix).toBe(keys.providerKeyPrefix(replacement));
    expect(after?.rotatedAt).toBeInstanceOf(Date);

    // The rotated key is findable by its NEW digest and not by its old one.
    const found = await keys.findByKeyHash(db, keys.hashProviderKey(replacement));
    expect(found?.id).toBe(key.id);
    expect(await keys.findByKeyHash(db, key.keyHash)).toBeNull();
  });
});

describe('diagnostics and stats', () => {
  it('reports which keys have a stored value without returning it', async () => {
    const withValue = await makeKey({ key: own('present') });
    const withoutValue = await makeKey({ key: null });

    const rows = await keys.listKeysForDiagnostics(db);
    const mine = rows.filter((row) => row.id === withValue.id || row.id === withoutValue.id);

    expect(mine).toHaveLength(2);
    expect(mine.find((row) => row.id === withValue.id)?.key).toBeTruthy();
    expect(mine.find((row) => row.id === withoutValue.id)?.key).toBeNull();
  });

  it('excludes archived keys from diagnostics', async () => {
    const archived = await makeKey({ isArchived: true });
    const rows = await keys.listKeysForDiagnostics(db);

    expect(rows.map((row) => row.id)).not.toContain(archived.id);
  });

  it('lists a provider’s non-archived keys for the stats roll-up', async () => {
    const provider = 'cerebras';
    const live = await makeKey({ provider });
    const archived = await makeKey({ provider, isArchived: true });

    const mine = new Set([live.id, archived.id]);
    const rows = (await keys.listKeysForProvider(db, provider)).filter((row) => mine.has(row.id));
    expect(rows.map((row) => row.id)).toEqual([live.id]);
  });

  it('activates and deactivates', async () => {
    const key = await makeKey({ isActive: true });

    expect((await keys.setActive(db, key.id, false))?.isActive).toBe(false);
    expect((await keys.setActive(db, key.id, true))?.isActive).toBe(true);
  });

  it('resets spend', async () => {
    const key = await makeKey({ spentUSD: 9 });
    expect((await keys.resetSpend(db, key.id))?.spentUSD).toBe(0);
  });

  it('sets and clears a cooldown', async () => {
    const key = await makeKey();
    const until = new Date(Date.now() + 30_000);

    await keys.setCooldown(db, key.id, until);
    expect((await keys.findById(db, key.id))?.cooldownUntil?.getTime()).toBe(until.getTime());

    await keys.setCooldown(db, key.id, null);
    expect((await keys.findById(db, key.id))?.cooldownUntil).toBeNull();
  });

  it('filters the admin listing', async () => {
    const provider = 'together';
    const staging = await makeKey({ provider, environment: 'staging' });
    const production = await makeKey({ provider, environment: 'production' });

    const mine = new Set([staging.id, production.id]);
    const rows = (await keys.listKeys(db, { provider, environment: 'staging' })).filter((row) =>
      mine.has(row.id),
    );
    expect(rows.map((row) => row.id)).toEqual([staging.id]);
  });

  it('returns null rather than throwing for a key that does not exist', async () => {
    const missing = own('nope');
    expect(await keys.findById(db, missing)).toBeNull();
    expect(await keys.findPublicById(db, missing)).toBeNull();
    expect(await keys.deleteKey(db, missing)).toBeNull();
    expect(await keys.patchKey(db, missing, { isActive: true })).toBeNull();
    expect(await keys.recordSuccess(db, missing)).toBeNull();
    expect(await keys.recordFailure(db, missing, 'x', 1)).toBeNull();
  });
});

describe('a key that is only reachable through its own row', () => {
  it('does not leak the secret through the admin listing', async () => {
    const secret = own('never-listed');
    await makeKey({ key: secret, keyHash: keys.hashProviderKey(secret) });

    const listed = await keys.listAllPublic(db);
    expect(JSON.stringify(listed)).not.toContain(secret);

    // Control: the secret really is stored, so the assertion above is about the
    // projection rather than about an empty table.
    const [stored] = await db
      .select({ key: providerKeys.key })
      .from(providerKeys)
      .where(and(eq(providerKeys.keyHash, keys.hashProviderKey(secret))));
    expect(stored.key).toBe(secret);
  });
});
