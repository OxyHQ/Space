import { eq, like, sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { executeRows } from '@oxyhq/db';
import { closeTestDb, getTestDb, type TestDatabase, testScope } from '../../db/__tests__/testDatabase.js';
import { webPushSubscriptions } from '../../db/schema/collab.js';
import {
  deactivateWebPushSubscription,
  deactivateWebPushSubscriptionById,
  hasActiveWebPushSubscription,
  listActiveWebPushSubscriptions,
  upsertWebPushSubscription,
} from '../webPushSubscriptions.js';

let db: TestDatabase;

const scope = testScope('webpush');
const userId = `${scope}-user`;
const otherUserId = `${scope}-other`;

beforeAll(async () => {
  db = await getTestDb();
});

afterAll(async () => {
  await db.delete(webPushSubscriptions).where(like(webPushSubscriptions.oxyUserId, `${scope}%`));
  await closeTestDb();
});

const keys = { p256dh: 'p256dh-value', auth: 'auth-value' };

describe('webPushSubscriptions repository', () => {
  /**
   * The sub-document flattening, stated as an assertion. `webPush.sendNotification`
   * is handed `{ endpoint, keys }`; if the repository stopped rebuilding `keys`
   * from its two columns, `sub.keys` would be `undefined` and the library would
   * report a malformed subscription rather than a missing column — a symptom
   * that points nowhere near the cause.
   */
  it('rebuilds keys from the two flattened columns', async () => {
    const endpoint = `${scope}-endpoint-shape`;
    const row = await upsertWebPushSubscription(db, { oxyUserId: userId, endpoint, keys });

    expect(row.keys).toEqual({ p256dh: 'p256dh-value', auth: 'auth-value' });

    const raw = await db
      .select()
      .from(webPushSubscriptions)
      .where(eq(webPushSubscriptions.id, row.id));
    expect(raw[0]?.keyP256dh).toBe('p256dh-value');
    expect(raw[0]?.keyAuth).toBe('auth-value');
    expect(raw[0]).not.toHaveProperty('keys');
  });

  /**
   * Stored verbatim: the endpoint is matched on, and the keys are read back to
   * be handed to the push service. Neither may be transformed at rest — a
   * transformed endpoint matches nothing on the next subscribe, and transformed
   * keys make every delivery fail authentication.
   */
  it('stores endpoint and keys verbatim', async () => {
    const endpoint = 'https://fcm.googleapis.com/fcm/send/AAA-BBB_ccc';
    const row = await upsertWebPushSubscription(db, {
      oxyUserId: userId,
      endpoint,
      keys: { p256dh: 'BEl62iUYgUiv+key/==', auth: 'k8J+auth==' },
    });
    expect(row.endpoint).toBe(endpoint);

    const listed = await listActiveWebPushSubscriptions(db, userId);
    expect(listed.find((s) => s.id === row.id)?.keys).toEqual({
      p256dh: 'BEl62iUYgUiv+key/==',
      auth: 'k8J+auth==',
    });
  });

  describe('upsert', () => {
    it('reactivates and re-keys an existing subscription rather than duplicating it', async () => {
      const endpoint = `${scope}-endpoint-rekey`;
      const first = await upsertWebPushSubscription(db, { oxyUserId: userId, endpoint, keys });
      await deactivateWebPushSubscription(db, userId, endpoint);

      const second = await upsertWebPushSubscription(db, {
        oxyUserId: userId,
        endpoint,
        keys: { p256dh: 'rotated-p256dh', auth: 'rotated-auth' },
      });

      expect(second.id).toBe(first.id);
      expect(second.active).toBe(true);
      // Unlike the Expo token upsert, both key halves are ALWAYS overwritten:
      // a browser that re-subscribes issues fresh keys for the same endpoint.
      expect(second.keys).toEqual({ p256dh: 'rotated-p256dh', auth: 'rotated-auth' });

      const rows = await db
        .select()
        .from(webPushSubscriptions)
        .where(eq(webPushSubscriptions.endpoint, endpoint));
      expect(rows).toHaveLength(1);
    });

    it('two users may subscribe to the same endpoint', async () => {
      const endpoint = `${scope}-endpoint-shared`;
      const mine = await upsertWebPushSubscription(db, { oxyUserId: userId, endpoint, keys });
      const theirs = await upsertWebPushSubscription(db, {
        oxyUserId: otherUserId,
        endpoint,
        keys,
      });
      expect(mine.id).not.toBe(theirs.id);
    });
  });

  describe('deactivation', () => {
    it('reports one row for this user’s subscription', async () => {
      const endpoint = `${scope}-endpoint-off`;
      await upsertWebPushSubscription(db, { oxyUserId: userId, endpoint, keys });
      expect(await deactivateWebPushSubscription(db, userId, endpoint)).toBe(1);
    });

    it('reports zero for another user’s subscription', async () => {
      const endpoint = `${scope}-endpoint-theirs`;
      await upsertWebPushSubscription(db, { oxyUserId: otherUserId, endpoint, keys });
      expect(await deactivateWebPushSubscription(db, userId, endpoint)).toBe(0);
    });

    it('deactivates one row by id — the 410 Gone path', async () => {
      const row = await upsertWebPushSubscription(db, {
        oxyUserId: userId,
        endpoint: `${scope}-endpoint-gone`,
        keys,
      });
      expect(await deactivateWebPushSubscriptionById(db, row.id)).toBe(1);
      expect(await deactivateWebPushSubscriptionById(db, `${scope}-no-such-id`)).toBe(0);
    });
  });

  describe('reads', () => {
    it('lists only this user’s active subscriptions', async () => {
      const listUser = `${scope}-list`;
      const active = await upsertWebPushSubscription(db, {
        oxyUserId: listUser,
        endpoint: `${scope}-list-a`,
        keys,
      });
      await upsertWebPushSubscription(db, {
        oxyUserId: listUser,
        endpoint: `${scope}-list-b`,
        keys,
      });
      await deactivateWebPushSubscription(db, listUser, `${scope}-list-b`);
      await upsertWebPushSubscription(db, {
        oxyUserId: otherUserId,
        endpoint: `${scope}-list-c`,
        keys,
      });

      expect((await listActiveWebPushSubscriptions(db, listUser)).map((s) => s.id)).toEqual([
        active.id,
      ]);
    });

    it('answers the channel-resolution question with a boolean', async () => {
      const boolUser = `${scope}-bool`;
      expect(await hasActiveWebPushSubscription(db, boolUser)).toBe(false);

      await upsertWebPushSubscription(db, {
        oxyUserId: boolUser,
        endpoint: `${scope}-bool-endpoint`,
        keys,
      });
      expect(await hasActiveWebPushSubscription(db, boolUser)).toBe(true);

      await deactivateWebPushSubscription(db, boolUser, `${scope}-bool-endpoint`);
      expect(await hasActiveWebPushSubscription(db, boolUser)).toBe(false);
    });
  });

  describe('constraints', () => {
    it('refuses a subscription missing either key half', async () => {
      await expect(
        executeRows(
          db,
          sql`insert into web_push_subscriptions (id, oxy_user_id, endpoint, key_p_256dh)
              values (${`${scope}-nokey`}, ${userId}, ${`${scope}-nokey-endpoint`}, 'only-one')`,
        ),
      ).rejects.toThrow();
    });

    it('refuses a second row for the same user and endpoint', async () => {
      const endpoint = `${scope}-endpoint-unique`;
      await upsertWebPushSubscription(db, { oxyUserId: userId, endpoint, keys });
      await expect(
        executeRows(
          db,
          sql`insert into web_push_subscriptions (id, oxy_user_id, endpoint, key_p_256dh, key_auth)
              values (${`${scope}-dupe`}, ${userId}, ${endpoint}, 'a', 'b')`,
        ),
      ).rejects.toThrow();
    });
  });
});
