import { eq, like, sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { executeRows } from '@oxyhq/db';
import { sweepExpiredRows } from '@oxyhq/db/expiry';
import { closeTestDb, getTestDb, type TestDatabase, testScope } from '../../db/__tests__/testDatabase.js';
import {
  NOTIFICATION_DISMISSED_RETENTION_SECONDS,
  notifications,
} from '../../db/schema/collab.js';
import {
  countNotifications,
  countUnreadNotifications,
  createNotification,
  dismissNotification,
  findNotificationById,
  listNotifications,
  markAllNotificationsRead,
  markNotificationRead,
  NOTIFICATION_EXPIRY_TARGET,
  updateNotificationDeliveryStatus,
} from '../notifications.js';

let db: TestDatabase;

const scope = testScope('notifications');
const userId = `${scope}-user`;
const otherUserId = `${scope}-other`;

beforeAll(async () => {
  db = await getTestDb();
});

afterAll(async () => {
  await db.delete(notifications).where(like(notifications.oxyUserId, `${scope}%`));
  await closeTestDb();
});

async function newNotification(overrides: Partial<Parameters<typeof createNotification>[1]> = {}) {
  return createNotification(db, {
    oxyUserId: userId,
    type: 'mention',
    title: 'title',
    body: 'body',
    channels: ['in_app'],
    deliveryStatus: { in_app: 'pending' },
    status: 'sent',
    priority: 'normal',
    ...overrides,
  });
}

/** Backdate a row without going through the repository's update path. */
async function backdate(id: string, createdAt: Date): Promise<void> {
  await db.update(notifications).set({ createdAt }).where(eq(notifications.id, id));
}

describe('notifications repository', () => {
  it('round-trips every column the writer sets', async () => {
    const expiresAt = new Date('2026-12-01T00:00:00.000Z');
    const created = await newNotification({
      type: 'comment_reply',
      title: 'New reply',
      body: 'someone replied',
      data: { commentId: 'c1', pageId: 'p1' },
      channels: ['in_app', 'push'],
      deliveryStatus: { in_app: 'pending', push: 'pending' },
      status: 'sent',
      priority: 'high',
      triggerId: `${scope}-trigger`,
      conversationId: `${scope}-conversation`,
      expiresAt,
    });

    const read = await findNotificationById(db, created.id);
    expect(read).toMatchObject({
      oxyUserId: userId,
      type: 'comment_reply',
      title: 'New reply',
      body: 'someone replied',
      data: { commentId: 'c1', pageId: 'p1' },
      channels: ['in_app', 'push'],
      deliveryStatus: { in_app: 'pending', push: 'pending' },
      status: 'sent',
      priority: 'high',
      triggerId: `${scope}-trigger`,
      conversationId: `${scope}-conversation`,
      expiresAt,
      readAt: null,
    });
  });

  it('leaves omitted optional fields null rather than writing undefined', async () => {
    const created = await newNotification();
    expect(created.data).toBeNull();
    expect(created.triggerId).toBeNull();
    expect(created.conversationId).toBeNull();
    expect(created.expiresAt).toBeNull();
  });

  describe('feed', () => {
    it('is newest-first and scoped to the owner', async () => {
      const feedUser = `${scope}-feed`;
      const older = await newNotification({ oxyUserId: feedUser });
      const newer = await newNotification({ oxyUserId: feedUser });
      await newNotification({ oxyUserId: otherUserId });
      await backdate(older.id, new Date('2026-01-01T00:00:00.000Z'));
      await backdate(newer.id, new Date('2026-01-02T00:00:00.000Z'));

      const listed = await listNotifications(db, { oxyUserId: feedUser }, 30, 0);
      expect(listed.map((n) => n.id)).toEqual([newer.id, older.id]);
    });

    it('filters by status and by type', async () => {
      const filterUser = `${scope}-filter`;
      const mention = await newNotification({ oxyUserId: filterUser, type: 'mention' });
      const reminder = await newNotification({
        oxyUserId: filterUser,
        type: 'reminder',
        status: 'read',
      });

      expect(
        (await listNotifications(db, { oxyUserId: filterUser, type: 'mention' }, 30, 0)).map(
          (n) => n.id,
        ),
      ).toEqual([mention.id]);
      expect(
        (await listNotifications(db, { oxyUserId: filterUser, status: 'read' }, 30, 0)).map(
          (n) => n.id,
        ),
      ).toEqual([reminder.id]);
    });

    /**
     * The list and the count must apply the SAME filter — the route returns
     * both in one payload, and a total that disagreed with the page would
     * paginate past the end or stop early. They share `listFilter` for that
     * reason; this is the assertion that keeps them sharing it.
     */
    it('the total agrees with the filtered list', async () => {
      const countUser = `${scope}-count`;
      await newNotification({ oxyUserId: countUser, type: 'mention' });
      await newNotification({ oxyUserId: countUser, type: 'mention' });
      await newNotification({ oxyUserId: countUser, type: 'reminder' });

      const filter = { oxyUserId: countUser, type: 'mention' as const };
      const total = await countNotifications(db, filter);
      expect(typeof total).toBe('number');
      expect(total).toBe((await listNotifications(db, filter, 100, 0)).length);
      expect(total).toBe(2);
    });

    /**
     * Offset pagination over a non-total order can return a row on two pages
     * or on neither. `createdAt DESC` alone is not total, so the id tiebreak is
     * load-bearing here rather than cosmetic — every row below shares one
     * instant.
     */
    it('pages without repeating or dropping a row when timestamps tie', async () => {
      const pageUser = `${scope}-paging`;
      const sameInstant = new Date('2026-07-07T07:07:07.000Z');
      const ids: string[] = [];
      for (let index = 0; index < 6; index += 1) {
        const created = await newNotification({ oxyUserId: pageUser });
        await backdate(created.id, sameInstant);
        ids.push(created.id);
      }

      const first = await listNotifications(db, { oxyUserId: pageUser }, 3, 0);
      const second = await listNotifications(db, { oxyUserId: pageUser }, 3, 3);
      const seen = [...first, ...second].map((n) => n.id);

      expect(new Set(seen).size).toBe(6);
      expect(seen.sort()).toEqual([...ids].sort());
    });
  });

  describe('unread count', () => {
    it('counts pending and sent, and nothing else', async () => {
      const unreadUser = `${scope}-unread`;
      await newNotification({ oxyUserId: unreadUser, status: 'pending' });
      await newNotification({ oxyUserId: unreadUser, status: 'sent' });
      await newNotification({ oxyUserId: unreadUser, status: 'read' });
      await newNotification({ oxyUserId: unreadUser, status: 'dismissed' });

      const count = await countUnreadNotifications(db, unreadUser);
      expect(typeof count).toBe('number');
      expect(count).toBe(2);
      // Arithmetic, because a bigint decoded as a string passes the value check.
      expect(count + 1).toBe(3);
    });

    it('is scoped to one user', async () => {
      const a = `${scope}-unread-a`;
      const b = `${scope}-unread-b`;
      await newNotification({ oxyUserId: a, status: 'sent' });
      await newNotification({ oxyUserId: b, status: 'sent' });
      expect(await countUnreadNotifications(db, a)).toBe(1);
    });
  });

  describe('status transitions', () => {
    it('marks one read and reports the row count', async () => {
      const created = await newNotification({ status: 'sent' });
      const readAt = new Date('2026-08-08T00:00:00.000Z');

      expect(await markNotificationRead(db, created.id, userId, readAt)).toBe(1);
      const read = await findNotificationById(db, created.id);
      expect(read?.status).toBe('read');
      expect(read?.readAt).toEqual(readAt);
    });

    /**
     * Ownership is in the WHERE, not in the caller. A permission question
     * answered by fetching the row and comparing in JavaScript is one edit away
     * from leaking it.
     */
    it('will not mark another user’s notification read', async () => {
      const created = await newNotification({ oxyUserId: otherUserId, status: 'sent' });
      expect(await markNotificationRead(db, created.id, userId, new Date())).toBe(0);
      expect((await findNotificationById(db, created.id))?.status).toBe('sent');
    });

    it('marks all unread read and leaves read and dismissed alone', async () => {
      const bulkUser = `${scope}-bulk`;
      await newNotification({ oxyUserId: bulkUser, status: 'pending' });
      await newNotification({ oxyUserId: bulkUser, status: 'sent' });
      const alreadyRead = await newNotification({ oxyUserId: bulkUser, status: 'read' });
      const dismissed = await newNotification({ oxyUserId: bulkUser, status: 'dismissed' });

      expect(await markAllNotificationsRead(db, bulkUser, new Date())).toBe(2);
      expect(await countUnreadNotifications(db, bulkUser)).toBe(0);
      expect((await findNotificationById(db, alreadyRead.id))?.readAt).toBeNull();
      expect((await findNotificationById(db, dismissed.id))?.status).toBe('dismissed');
    });

    it('a second mark-all-read moves nothing', async () => {
      const bulkUser = `${scope}-bulk-2`;
      await newNotification({ oxyUserId: bulkUser, status: 'sent' });
      expect(await markAllNotificationsRead(db, bulkUser, new Date())).toBe(1);
      expect(await markAllNotificationsRead(db, bulkUser, new Date())).toBe(0);
    });

    it('dismisses without touching readAt', async () => {
      const created = await newNotification({ status: 'sent' });
      expect(await dismissNotification(db, created.id, userId)).toBe(1);
      const read = await findNotificationById(db, created.id);
      expect(read?.status).toBe('dismissed');
      expect(read?.readAt).toBeNull();
    });

    /**
     * A REPEATED call is the discriminator between Mongo's `matchedCount` and
     * its `modifiedCount`, and the two answers differ here: 1 is `matchedCount`,
     * 0 would be `modifiedCount` under the reading where an unchanged document
     * is not modified. 1 is correct, because mongoose adds `updatedAt` to every
     * `updateOne` on a `{ timestamps: true }` schema, so the source document IS
     * modified on the second dismiss too.
     */
    it('a second dismiss still reports one row, as mongoose did', async () => {
      const created = await newNotification({ status: 'sent' });
      expect(await dismissNotification(db, created.id, userId)).toBe(1);
      expect(await dismissNotification(db, created.id, userId)).toBe(1);
    });

    it('replaces the whole delivery status map', async () => {
      const created = await newNotification({
        channels: ['in_app', 'push'],
        deliveryStatus: { in_app: 'pending', push: 'pending' },
      });

      const updated = await updateNotificationDeliveryStatus(db, created.id, {
        in_app: 'sent',
        push: 'failed',
      });
      expect(updated?.deliveryStatus).toEqual({ in_app: 'sent', push: 'failed' });
    });
  });

  describe('constraints', () => {
    it.each([
      ['type', sql`update notifications set type = 'not_a_type' where id = `],
      ['status', sql`update notifications set status = 'archived' where id = `],
      ['priority', sql`update notifications set priority = 'critical' where id = `],
    ])('refuses a %s outside the declared set', async (_field, statement) => {
      const created = await newNotification();
      await expect(
        executeRows(db, sql`${statement}${created.id}`),
      ).rejects.toThrow();
    });

    it('refuses a channel outside the declared set', async () => {
      const created = await newNotification();
      await expect(
        executeRows(
          db,
          sql`update notifications set channels = array['carrier_pigeon']::text[] where id = ${created.id}`,
        ),
      ).rejects.toThrow();
    });

    /**
     * The containment CHECK is vacuously true for an empty array. Accepted
     * deliberately — Mongo's `channels` was not `required` and accepted `[]`
     * too — and asserted so that a later "tighten it to require at least one"
     * has to be a decision rather than a drive-by.
     */
    it('accepts an empty channel list, as Mongo did', async () => {
      const created = await newNotification({ channels: [] });
      expect(created.channels).toEqual([]);
    });

    it('refuses a delivery status that is not an object', async () => {
      const created = await newNotification();
      await expect(
        executeRows(
          db,
          sql`update notifications set delivery_status = '[]'::jsonb where id = ${created.id}`,
        ),
      ).rejects.toThrow();
    });
  });

  /**
   * The TTL replacement.
   *
   * This is the one suite here that cannot scope its aggregate: the sweep is a
   * whole-table DELETE by design. So nothing asserts a total — every claim is
   * about rows this file owns by id, plus a floor proving the sweep did
   * something at all. `notifications` is written by no other test file in this
   * package.
   */
  describe('expiry sweep', () => {
    const longAgo = new Date(
      Date.now() - (NOTIFICATION_DISMISSED_RETENTION_SECONDS + 86_400) * 1000,
    );

    it('registers the retention the Mongo TTL index declared', () => {
      expect(NOTIFICATION_EXPIRY_TARGET.retentionSeconds).toBe(90 * 24 * 60 * 60);
      expect(NOTIFICATION_EXPIRY_TARGET.column).toBe(notifications.dismissedReapAt);
    });

    it('deletes a dismissed row past retention and keeps everything else', async () => {
      const sweepUser = `${scope}-sweep`;
      const oldDismissed = await newNotification({ oxyUserId: sweepUser, status: 'dismissed' });
      const oldRead = await newNotification({ oxyUserId: sweepUser, status: 'read' });
      const oldPending = await newNotification({ oxyUserId: sweepUser, status: 'pending' });
      const recentDismissed = await newNotification({
        oxyUserId: sweepUser,
        status: 'dismissed',
      });
      await backdate(oldDismissed.id, longAgo);
      await backdate(oldRead.id, longAgo);
      await backdate(oldPending.id, longAgo);

      const result = await sweepExpiredRows(db, NOTIFICATION_EXPIRY_TARGET);

      // Positive control: the sweep ran and deleted something. Without this,
      // "my row is gone" and "the sweep is a no-op and my row was never there"
      // are the same observation.
      expect(result.deleted).toBeGreaterThanOrEqual(1);
      expect(result.table).toBe('notifications');

      // The measurement, by identity rather than by count.
      expect(await findNotificationById(db, oldDismissed.id)).toBeNull();

      // The negative controls. These are what fail if `dismissedReapAt` is ever
      // simplified to a plain `createdAt` — which is the cheapest way to make a
      // "the TTL is registered" gate go green, and a silent history wipe.
      expect(await findNotificationById(db, oldRead.id)).not.toBeNull();
      expect(await findNotificationById(db, oldPending.id)).not.toBeNull();
      expect(await findNotificationById(db, recentDismissed.id)).not.toBeNull();
    });

    /**
     * Mongo's TTL measured from `createdAt` and reaped as soon as the document
     * was dismissed, however old it already was. The generated column keeps
     * that clock: dismissing a 100-day-old notification makes it immediately
     * eligible, rather than starting a fresh 90 days.
     */
    it('reaps an already-old notification as soon as it is dismissed', async () => {
      const sweepUser = `${scope}-sweep-clock`;
      const created = await newNotification({ oxyUserId: sweepUser, status: 'sent' });
      await backdate(created.id, longAgo);

      await sweepExpiredRows(db, NOTIFICATION_EXPIRY_TARGET);
      expect(await findNotificationById(db, created.id)).not.toBeNull();

      await dismissNotification(db, created.id, sweepUser);
      await sweepExpiredRows(db, NOTIFICATION_EXPIRY_TARGET);
      expect(await findNotificationById(db, created.id)).toBeNull();
    });

    /**
     * NOT WIRED UP. Nothing schedules this sweep — registering a target is not
     * the same as running one, and a sweeper with zero callers is green and
     * inert. This asserts the current, deliberate state so that wiring it is a
     * change that fails a test first.
     */
    it('has no scheduler yet: no module calls sweepAllExpiredRows', async () => {
      const { readdir, readFile } = await import('node:fs/promises');
      const { join } = await import('node:path');

      const sourceRoot = new URL('../../', import.meta.url).pathname;
      const files: string[] = [];
      const walk = async (dir: string): Promise<void> => {
        for (const entry of await readdir(dir, { withFileTypes: true })) {
          if (entry.name === 'node_modules') continue;
          const full = join(dir, entry.name);
          if (entry.isDirectory()) await walk(full);
          else if (entry.name.endsWith('.ts')) files.push(full);
        }
      };
      await walk(sourceRoot);

      // Vacuity floor: the walk really did read this package's source.
      expect(files.length).toBeGreaterThan(50);
      expect(files.some((f) => f.endsWith('repositories/notifications.ts'))).toBe(true);

      const callers: string[] = [];
      for (const file of files) {
        if (file.endsWith('notifications.pgdb.test.ts')) continue;
        const text = await readFile(file, 'utf8');
        if (text.includes('sweepAllExpiredRows(') || text.includes('sweepExpiredRows(')) {
          callers.push(file);
        }
      }
      expect(callers).toEqual([]);
    });
  });
});
