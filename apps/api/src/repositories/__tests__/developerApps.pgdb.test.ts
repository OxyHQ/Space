import { eq, sql } from 'drizzle-orm';
import { afterAll, describe, expect, it } from 'vitest';
import { API_KEY_SCOPES, developerApiKeys, developerApps } from '../../db/schema/billing.js';
import {
  createDeveloperApiKey,
  createDeveloperApp,
  findDeveloperApiKeyByHash,
  findDeveloperAppById,
  listDeveloperApiKeysByApp,
  listDeveloperAppsByUser,
  setDeveloperApiKeyActive,
  setDeveloperAppActive,
  touchDeveloperApiKey,
} from '../developerApps.js';
import { closeTestDb, testDb, testUserId } from './testDatabase.js';

const db = testDb();

afterAll(closeTestDb);

/**
 * These two tables have NO CALL SITES anywhere in `src/` — the symbols
 * `DeveloperApp` and `DeveloperApiKey` appear only in their own model files.
 * So nothing here is a ported behaviour; it is the model's declared shape,
 * exercised so the tables are known to work if the developer portal ever
 * returns. The tests assert STRUCTURE — defaults, constraints, cascade — not
 * semantics nobody has chosen.
 */

async function app(userId: string): Promise<string> {
  const row = await createDeveloperApp(db, { oxyUserId: userId, name: 'Test App' });
  return row.id;
}

describe('developer apps', () => {
  it('applies the defaults the Mongoose schema declared', async () => {
    const userId = testUserId('dev-app');
    const row = await createDeveloperApp(db, { oxyUserId: userId, name: 'Defaults' });

    expect(row.isActive).toBe(true);
    expect(row.redirectUrls).toEqual([]);
    expect(row.description).toBeNull();
  });

  it('stores redirect urls as an array', async () => {
    const userId = testUserId('dev-redirects');
    const row = await createDeveloperApp(db, {
      oxyUserId: userId,
      name: 'Redirects',
      redirectUrls: ['https://a.example', 'https://b.example'],
    });

    expect(row.redirectUrls).toEqual(['https://a.example', 'https://b.example']);
    expect((await findDeveloperAppById(db, row.id))?.redirectUrls).toHaveLength(2);
  });

  /**
   * `maxlength: 100` / `maxlength: 500` become live CHECKs because the model's
   * only write path would be `new DeveloperApp()` + `save()`, which runs
   * validators.
   */
  it('refuses a name longer than 100 characters', async () => {
    await expect(
      createDeveloperApp(db, { oxyUserId: testUserId('dev-long'), name: 'x'.repeat(101) }),
    ).rejects.toThrow();
  });

  it('accepts a name of exactly 100 characters', async () => {
    await expect(
      createDeveloperApp(db, { oxyUserId: testUserId('dev-100'), name: 'x'.repeat(100) }),
    ).resolves.toBeDefined();
  });

  it('refuses a description longer than 500 characters but allows none at all', async () => {
    const userId = testUserId('dev-desc');
    await expect(
      createDeveloperApp(db, { oxyUserId: userId, name: 'D', description: 'x'.repeat(501) }),
    ).rejects.toThrow();
    await expect(
      createDeveloperApp(db, { oxyUserId: userId, name: 'D' }),
    ).resolves.toBeDefined();
  });

  it('lists a user\'s apps and can narrow to the active ones', async () => {
    const userId = testUserId('dev-list');
    const keep = await app(userId);
    const drop = await app(userId);
    await setDeveloperAppActive(db, drop, false);

    expect(await listDeveloperAppsByUser(db, userId)).toHaveLength(2);
    const active = await listDeveloperAppsByUser(db, userId, { activeOnly: true });
    expect(active.map((a) => a.id)).toEqual([keep]);
  });
});

describe('developer api keys', () => {
  it('applies the default scopes and rate limits', async () => {
    const userId = testUserId('dev-key');
    const row = await createDeveloperApiKey(db, {
      oxyUserId: userId,
      appId: await app(userId),
      name: 'Default Key',
      keyHash: `hash_${userId}`,
      keyPrefix: 'clarity_sk_1234',
    });

    expect(row.scopes).toEqual(['chat:read', 'chat:write']);
    // null means UNLIMITED — the source's own encoding, preserved as nullable
    // columns rather than flattened into a jsonb blob.
    expect(row.rateLimitRequestsPerDay).toBe(1000);
    expect(row.rateLimitRequestsPerMinute).toBeNull();
    expect(row.rateLimitTokensPerDay).toBeNull();
    expect(row.isActive).toBe(true);
    expect(row.expiresAt).toBeNull();
  });

  it('finds a key by its hash', async () => {
    const userId = testUserId('dev-hash');
    const keyHash = `hash_${userId}`;
    await createDeveloperApiKey(db, {
      oxyUserId: userId,
      appId: await app(userId),
      name: 'Lookup',
      keyHash,
      keyPrefix: 'clarity_sk_abcd',
    });

    expect((await findDeveloperApiKeyByHash(db, keyHash))?.keyHash).toBe(keyHash);
    expect(await findDeveloperApiKeyByHash(db, `${keyHash}_nope`)).toBeNull();
  });

  it('refuses a duplicate key hash', async () => {
    const userId = testUserId('dev-dupe');
    const appId = await app(userId);
    const keyHash = `hash_${userId}`;
    const base = { oxyUserId: userId, appId, keyPrefix: 'clarity_sk_0000', keyHash };

    await createDeveloperApiKey(db, { ...base, name: 'First' });
    await expect(createDeveloperApiKey(db, { ...base, name: 'Second' })).rejects.toThrow();
  });

  it('refuses a scope outside the enum', async () => {
    const userId = testUserId('dev-scope');
    await expect(
      createDeveloperApiKey(db, {
        oxyUserId: userId,
        appId: await app(userId),
        name: 'Bad scope',
        keyHash: `hash_${userId}`,
        keyPrefix: 'clarity_sk_0000',
        scopes: ['chat:read', 'billing:write'],
      }),
    ).rejects.toThrow();
  });

  it('accepts every declared scope at once', async () => {
    const userId = testUserId('dev-allscopes');
    const row = await createDeveloperApiKey(db, {
      oxyUserId: userId,
      appId: await app(userId),
      name: 'All scopes',
      keyHash: `hash_${userId}`,
      keyPrefix: 'clarity_sk_0000',
      scopes: [...API_KEY_SCOPES],
    });

    expect(row.scopes).toHaveLength(API_KEY_SCOPES.length);
  });

  /**
   * The containment CHECK is VACUOUSLY TRUE for an empty array, and that is
   * faithful: Mongo validates the enum per ELEMENT, so an empty array has
   * nothing to reject and stores fine. Pinned so a later tidy-up does not add
   * a `cardinality(...) >= 1` beside it and invent a constraint the source
   * never had.
   */
  it('accepts an empty scope list, as the source did', async () => {
    const userId = testUserId('dev-noscope');
    const row = await createDeveloperApiKey(db, {
      oxyUserId: userId,
      appId: await app(userId),
      name: 'No scopes',
      keyHash: `hash_${userId}`,
      keyPrefix: 'clarity_sk_0000',
      scopes: [],
    });

    expect(row.scopes).toEqual([]);
  });

  it('stamps lastUsedAt on touch', async () => {
    const userId = testUserId('dev-touch');
    const row = await createDeveloperApiKey(db, {
      oxyUserId: userId,
      appId: await app(userId),
      name: 'Touch',
      keyHash: `hash_${userId}`,
      keyPrefix: 'clarity_sk_0000',
    });
    expect(row.lastUsedAt).toBeNull();

    expect((await touchDeveloperApiKey(db, row.id))?.lastUsedAt).toBeInstanceOf(Date);
  });

  it('lists an app\'s keys and can narrow to the active ones', async () => {
    const userId = testUserId('dev-keylist');
    const appId = await app(userId);
    const base = { oxyUserId: userId, appId, keyPrefix: 'clarity_sk_0000' };
    const live = await createDeveloperApiKey(db, {
      ...base,
      name: 'Live',
      keyHash: `hash_${userId}_a`,
    });
    const dead = await createDeveloperApiKey(db, {
      ...base,
      name: 'Dead',
      keyHash: `hash_${userId}_b`,
    });
    await setDeveloperApiKeyActive(db, dead.id, false);

    expect(await listDeveloperApiKeysByApp(db, appId)).toHaveLength(2);
    const active = await listDeveloperApiKeysByApp(db, appId, { activeOnly: true });
    expect(active.map((k) => k.id)).toEqual([live.id]);
  });

  /**
   * A key pointing at an app that does not exist was always garbage, and Mongo
   * could not say so. The cascade makes it structural — and this asserts the
   * foreign key really is enforced, which no functional test would notice.
   */
  it('refuses a key whose app does not exist', async () => {
    const userId = testUserId('dev-orphan');
    await expect(
      createDeveloperApiKey(db, {
        oxyUserId: userId,
        appId: 'no-such-app',
        name: 'Orphan',
        keyHash: `hash_${userId}`,
        keyPrefix: 'clarity_sk_0000',
      }),
    ).rejects.toThrow();
  });

  it('cascades a hard app delete to its keys', async () => {
    const userId = testUserId('dev-cascade');
    const appId = await app(userId);
    await createDeveloperApiKey(db, {
      oxyUserId: userId,
      appId,
      name: 'Doomed',
      keyHash: `hash_${userId}`,
      keyPrefix: 'clarity_sk_0000',
    });

    await db.delete(developerApps).where(eq(developerApps.id, appId));

    const remaining = await db.execute(
      sql`select count(*)::int as n from ${developerApiKeys} where ${developerApiKeys.appId} = ${appId}`,
    );
    expect(Number(remaining[0]?.n)).toBe(0);
  });
});
