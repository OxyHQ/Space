import { eq, like, sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { executeRows } from '@oxyhq/db';
import { closeTestDb, getTestDb, type TestDatabase, testScope } from '../../db/__tests__/testDatabase.js';
import { pushTokens } from '../../db/schema/collab.js';
import {
  deactivatePushToken,
  deactivatePushTokenById,
  deactivatePushTokenEverywhere,
  hasActivePushToken,
  listActivePushTokens,
  touchPushTokensLastUsed,
  upsertPushToken,
} from '../pushTokens.js';

let db: TestDatabase;

const scope = testScope('pushtokens');
const userId = `${scope}-user`;
const otherUserId = `${scope}-other`;

beforeAll(async () => {
  db = await getTestDb();
});

afterAll(async () => {
  await db.delete(pushTokens).where(like(pushTokens.oxyUserId, `${scope}%`));
  await closeTestDb();
});

describe('pushTokens repository', () => {
  describe('upsert', () => {
    it('inserts a new registration with its defaults', async () => {
      const row = await upsertPushToken(db, {
        oxyUserId: userId,
        token: `${scope}-fresh`,
        deviceId: 'device-1',
        platform: 'ios',
      });

      expect(row).toMatchObject({
        oxyUserId: userId,
        token: `${scope}-fresh`,
        deviceId: 'device-1',
        platform: 'ios',
        active: true,
      });
      expect(row.lastUsedAt).toBeNull();
    });

    it('reactivates an existing registration instead of duplicating it', async () => {
      const token = `${scope}-reactivate`;
      const first = await upsertPushToken(db, { oxyUserId: userId, token, platform: 'android' });
      await deactivatePushToken(db, userId, token);

      const second = await upsertPushToken(db, { oxyUserId: userId, token, platform: 'android' });

      expect(second.id).toBe(first.id);
      expect(second.active).toBe(true);
      const rows = await db.select().from(pushTokens).where(eq(pushTokens.token, token));
      expect(rows).toHaveLength(1);
    });

    /**
     * The route builds its `$set` with a conditional spread, so a request that
     * omits `deviceId` must leave the stored one alone. `coalesce(excluded.…,
     * push_tokens.…)` is that rule; without it the second call would null out
     * the device recorded when the app first registered, and nothing would
     * error — the push would simply stop being attributable to a device.
     */
    it('an omitted deviceId or platform leaves the stored value alone', async () => {
      const token = `${scope}-preserve`;
      await upsertPushToken(db, {
        oxyUserId: userId,
        token,
        deviceId: 'device-original',
        platform: 'web',
      });

      const second = await upsertPushToken(db, { oxyUserId: userId, token });

      expect(second.deviceId).toBe('device-original');
      expect(second.platform).toBe('web');
    });

    it('a supplied deviceId replaces the stored one', async () => {
      const token = `${scope}-replace`;
      await upsertPushToken(db, { oxyUserId: userId, token, deviceId: 'device-old' });
      const second = await upsertPushToken(db, {
        oxyUserId: userId,
        token,
        deviceId: 'device-new',
      });
      expect(second.deviceId).toBe('device-new');
    });

    it('two users may register the same token', async () => {
      const token = `${scope}-shared-device`;
      const mine = await upsertPushToken(db, { oxyUserId: userId, token });
      const theirs = await upsertPushToken(db, { oxyUserId: otherUserId, token });
      expect(mine.id).not.toBe(theirs.id);
    });
  });

  describe('deactivation', () => {
    it('reports one row for a token this user registered', async () => {
      const token = `${scope}-deactivate`;
      await upsertPushToken(db, { oxyUserId: userId, token });
      expect(await deactivatePushToken(db, userId, token)).toBe(1);
      expect(await listActivePushTokens(db, userId)).not.toContainEqual(
        expect.objectContaining({ token }),
      );
    });

    /**
     * The route 404s on zero, which is Mongo's `matchedCount === 0`. Postgres's
     * row count is the `matchedCount` analogue, so a token belonging to someone
     * else must report zero rather than silently succeeding.
     */
    it('reports zero for a token this user never registered', async () => {
      const token = `${scope}-not-mine`;
      await upsertPushToken(db, { oxyUserId: otherUserId, token });
      expect(await deactivatePushToken(db, userId, token)).toBe(0);
    });

    it('a second deactivation still reports one row, as mongoose did', async () => {
      const token = `${scope}-twice`;
      await upsertPushToken(db, { oxyUserId: userId, token });
      expect(await deactivatePushToken(db, userId, token)).toBe(1);
      expect(await deactivatePushToken(db, userId, token)).toBe(1);
    });

    /**
     * DIVERGENCE, pinned. Mongo's `updateOne({ token })` deactivated ONE
     * arbitrary matching document; this deactivates every registration of the
     * device. The caller is handling a `DeviceNotRegistered` receipt, so the
     * device is gone for everyone — porting the arbitrariness would leave one
     * user still being pushed to a dead device, chosen by whichever document
     * the query reached first.
     */
    it('deactivating by token alone reaches every user that registered it', async () => {
      const token = `${scope}-device-gone`;
      await upsertPushToken(db, { oxyUserId: userId, token });
      await upsertPushToken(db, { oxyUserId: otherUserId, token });

      expect(await deactivatePushTokenEverywhere(db, token)).toBe(2);

      const rows = await db.select().from(pushTokens).where(eq(pushTokens.token, token));
      expect(rows.map((r) => r.active)).toEqual([false, false]);
    });

    it('deactivates one row by id', async () => {
      const row = await upsertPushToken(db, { oxyUserId: userId, token: `${scope}-by-id` });
      expect(await deactivatePushTokenById(db, row.id)).toBe(1);
      expect(await deactivatePushTokenById(db, `${scope}-no-such-id`)).toBe(0);
    });
  });

  describe('reads', () => {
    it('lists only this user’s active tokens', async () => {
      const listUser = `${scope}-list`;
      const active = await upsertPushToken(db, { oxyUserId: listUser, token: `${scope}-a` });
      await upsertPushToken(db, { oxyUserId: listUser, token: `${scope}-b` });
      await deactivatePushToken(db, listUser, `${scope}-b`);
      await upsertPushToken(db, { oxyUserId: otherUserId, token: `${scope}-c` });

      const listed = await listActivePushTokens(db, listUser);
      expect(listed.map((t) => t.id)).toEqual([active.id]);
    });

    it('answers the channel-resolution question with a boolean', async () => {
      const boolUser = `${scope}-bool`;
      expect(await hasActivePushToken(db, boolUser)).toBe(false);

      await upsertPushToken(db, { oxyUserId: boolUser, token: `${scope}-bool-token` });
      expect(await hasActivePushToken(db, boolUser)).toBe(true);

      await deactivatePushToken(db, boolUser, `${scope}-bool-token`);
      expect(await hasActivePushToken(db, boolUser)).toBe(false);
    });
  });

  describe('touchPushTokensLastUsed', () => {
    it('does nothing for an empty id list', async () => {
      expect(await touchPushTokensLastUsed(db, [], new Date())).toBe(0);
    });

    it('stamps exactly the ids it is given', async () => {
      const touched = await upsertPushToken(db, { oxyUserId: userId, token: `${scope}-touch` });
      const untouched = await upsertPushToken(db, {
        oxyUserId: userId,
        token: `${scope}-untouched`,
      });
      const lastUsedAt = new Date('2026-09-09T00:00:00.000Z');

      expect(await touchPushTokensLastUsed(db, [touched.id], lastUsedAt)).toBe(1);

      const rows = await db.select().from(pushTokens).where(eq(pushTokens.oxyUserId, userId));
      expect(rows.find((r) => r.id === touched.id)?.lastUsedAt).toEqual(lastUsedAt);
      expect(rows.find((r) => r.id === untouched.id)?.lastUsedAt).toBeNull();
    });
  });

  describe('constraints', () => {
    it('refuses a platform outside the declared set', async () => {
      await expect(
        executeRows(
          db,
          sql`insert into push_tokens (id, oxy_user_id, token, platform)
              values (${`${scope}-badplatform`}, ${userId}, ${`${scope}-bad`}, 'blackberry')`,
        ),
      ).rejects.toThrow();
    });

    /**
     * The legitimate case the CHECK must NOT reject. `platform` is optional and
     * `null in (...)` is NULL, which a CHECK admits because it rejects only
     * FALSE — but that is subtle enough that a later "tidy the constraint" could
     * turn it into something that rejects a row the route writes every day.
     */
    it('accepts a registration with no platform', async () => {
      const row = await upsertPushToken(db, { oxyUserId: userId, token: `${scope}-no-platform` });
      expect(row.platform).toBeNull();
    });

    it('refuses a second row for the same user and token', async () => {
      const token = `${scope}-unique`;
      await upsertPushToken(db, { oxyUserId: userId, token });
      await expect(
        executeRows(
          db,
          sql`insert into push_tokens (id, oxy_user_id, token)
              values (${`${scope}-dupe`}, ${userId}, ${token})`,
        ),
      ).rejects.toThrow();
    });
  });
});
