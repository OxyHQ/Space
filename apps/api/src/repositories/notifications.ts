/**
 * Notification reads and writes, covering every query `routes/notifications.ts`
 * and `lib/notification-service.ts` perform.
 *
 * ## The count mappings, which are per-call-site decisions
 *
 * Mongo reports `matchedCount` AND `modifiedCount`; Postgres reports only
 * `rowCount`, which behaves like `matchedCount`. Reading the wrong one 404s a
 * retry or 200s a no-op.
 *
 * Here the two Mongo counts are always EQUAL, and that is measured rather than
 * assumed: `NotificationSchema` is declared `{ timestamps: true }`, and mongoose
 * 9.2.1's `applyTimestampsToUpdate` unconditionally adds
 * `updates.$set[updatedAt] = now` to every `updateOne`/`updateMany`
 * (`node_modules/mongoose/lib/helpers/update/applyTimestampsToUpdate.js:52-80`).
 * So any matched document is also modified, including a second dismiss of an
 * already-dismissed notification. Returning the Postgres row count therefore
 * reproduces `modifiedCount` exactly — and drizzle's `updatedAt()` has the same
 * `$onUpdate` behaviour, so the equality holds on this side too.
 */

import { and, desc, eq, inArray, sql } from 'drizzle-orm';
import type { ExpirySweepTarget } from '@oxyhq/db/expiry';
import type { StationDatabase } from '../db/client.js';
import {
  NOTIFICATION_DISMISSED_RETENTION_SECONDS,
  NOTIFICATION_UNREAD_STATUSES,
  type NotificationChannel,
  type NotificationPriority,
  type NotificationStatus,
  type NotificationType,
  notifications,
} from '../db/schema/collab.js';

/** Per-channel outcome, as `sendNotification` records it. */
export type NotificationDeliveryStatus = Record<string, 'pending' | 'sent' | 'failed'>;

export interface NotificationRow {
  id: string;
  oxyUserId: string;
  type: NotificationType;
  title: string;
  body: string;
  data: Record<string, unknown> | null;
  channels: NotificationChannel[];
  deliveryStatus: NotificationDeliveryStatus;
  status: NotificationStatus;
  priority: NotificationPriority;
  readAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface CreateNotificationInput {
  oxyUserId: string;
  type: NotificationType;
  title: string;
  body: string;
  data?: Record<string, unknown>;
  channels: NotificationChannel[];
  deliveryStatus: NotificationDeliveryStatus;
  status: NotificationStatus;
  priority: NotificationPriority;
}

export interface ListNotificationsFilter {
  oxyUserId: string;
  status?: NotificationStatus;
  type?: NotificationType;
}

function toNotificationRow(
  row: Omit<typeof notifications.$inferSelect, 'dismissedReapAt'>,
): NotificationRow {
  return {
    id: row.id,
    oxyUserId: row.oxyUserId,
    type: row.type as NotificationType,
    title: row.title,
    body: row.body,
    data: row.data as Record<string, unknown> | null,
    channels: row.channels as NotificationChannel[],
    deliveryStatus: row.deliveryStatus as NotificationDeliveryStatus,
    status: row.status as NotificationStatus,
    priority: row.priority as NotificationPriority,
    readAt: row.readAt,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

/** The filter shared by the list and the count, so the two cannot disagree. */
function listFilter(filter: ListNotificationsFilter) {
  return and(
    eq(notifications.oxyUserId, filter.oxyUserId),
    filter.status ? eq(notifications.status, filter.status) : undefined,
    filter.type ? eq(notifications.type, filter.type) : undefined,
  );
}

/**
 * One page of a user's notification feed, newest first.
 *
 * `id` is a tiebreak Mongo did not have, and here it is load-bearing rather than
 * cosmetic: this is the only OFFSET-paginated read in the domain, and
 * `createdAt DESC` alone is not a total order, so two notifications sharing a
 * millisecond at a page boundary could appear on both pages or on neither.
 *
 * `limit` and `offset` must be finite non-negative integers. The route currently
 * passes raw `Number(req.query.…)` output (`routes/notifications.ts:44-45`),
 * which is `NaN` for a non-numeric query string; validating that belongs at the
 * route and is called out as a rewiring-time item rather than silently absorbed
 * here.
 */
export async function listNotifications(
  db: StationDatabase,
  filter: ListNotificationsFilter,
  limit: number,
  offset: number,
): Promise<NotificationRow[]> {
  const rows = await db
    .select()
    .from(notifications)
    .where(listFilter(filter))
    .orderBy(desc(notifications.createdAt), desc(notifications.id))
    .limit(limit)
    .offset(offset);
  return rows.map(toNotificationRow);
}

/** Total matching the same filter as `listNotifications`. */
export async function countNotifications(
  db: StationDatabase,
  filter: ListNotificationsFilter,
): Promise<number> {
  const rows = await db
    .select({ total: sql<number>`count(*)::int` })
    .from(notifications)
    .where(listFilter(filter));
  return rows[0]?.total ?? 0;
}

/**
 * Unread count — the read the partial index exists for.
 *
 * `::int` because postgres.js decodes `bigint` as a STRING while drizzle types
 * it `number`; without the cast this returns `"3"` and the route's JSON carries
 * a string where every client expects a number.
 */
export async function countUnreadNotifications(
  db: StationDatabase,
  oxyUserId: string,
): Promise<number> {
  const rows = await db
    .select({ total: sql<number>`count(*)::int` })
    .from(notifications)
    .where(
      and(
        eq(notifications.oxyUserId, oxyUserId),
        inArray(notifications.status, [...NOTIFICATION_UNREAD_STATUSES]),
      ),
    );
  return rows[0]?.total ?? 0;
}

export async function findNotificationById(
  db: StationDatabase,
  id: string,
): Promise<NotificationRow | null> {
  const rows = await db.select().from(notifications).where(eq(notifications.id, id)).limit(1);
  const row = rows[0];
  return row ? toNotificationRow(row) : null;
}

/**
 * Persist a notification.
 *
 * Optional fields are omitted from the insert rather than passed as `undefined`.
 * On an INSERT the two are equivalent — both leave the column NULL — but the
 * habit is what keeps `$set: { x: undefined }`, a no-op in Mongo and a NULL
 * write in Postgres, from erasing a sibling field the day this shape is reused
 * for an update.
 */
export async function createNotification(
  db: StationDatabase,
  input: CreateNotificationInput,
): Promise<NotificationRow> {
  const rows = await db
    .insert(notifications)
    .values({
      oxyUserId: input.oxyUserId,
      type: input.type,
      title: input.title,
      body: input.body,
      channels: input.channels,
      deliveryStatus: input.deliveryStatus,
      status: input.status,
      priority: input.priority,
      ...(input.data !== undefined ? { data: input.data } : {}),
    })
    .returning();
  const row = rows[0];
  if (!row) {
    throw new Error('createNotification inserted no row');
  }
  return toNotificationRow(row);
}

/**
 * Replace the whole `deliveryStatus` map, which is what
 * `notification.markModified('deliveryStatus'); save()` did.
 */
export async function updateNotificationDeliveryStatus(
  db: StationDatabase,
  id: string,
  deliveryStatus: NotificationDeliveryStatus,
): Promise<NotificationRow | null> {
  const rows = await db
    .update(notifications)
    .set({ deliveryStatus })
    .where(eq(notifications.id, id))
    .returning();
  const row = rows[0];
  return row ? toNotificationRow(row) : null;
}

/**
 * Mark one notification read. Scoped to the owner, so a caller cannot read
 * another user's notification by guessing an id.
 *
 * Returns the row count, which the route reads as "found" — see the module
 * header for why that is `modifiedCount` and not merely `matchedCount`.
 */
export async function markNotificationRead(
  db: StationDatabase,
  id: string,
  oxyUserId: string,
  readAt: Date,
): Promise<number> {
  const rows = await db
    .update(notifications)
    .set({ status: 'read', readAt })
    .where(and(eq(notifications.id, id), eq(notifications.oxyUserId, oxyUserId)))
    .returning({ id: notifications.id });
  return rows.length;
}

/** Mark every unread notification read, and report how many moved. */
export async function markAllNotificationsRead(
  db: StationDatabase,
  oxyUserId: string,
  readAt: Date,
): Promise<number> {
  const rows = await db
    .update(notifications)
    .set({ status: 'read', readAt })
    .where(
      and(
        eq(notifications.oxyUserId, oxyUserId),
        inArray(notifications.status, [...NOTIFICATION_UNREAD_STATUSES]),
      ),
    )
    .returning({ id: notifications.id });
  return rows.length;
}

/**
 * Dismiss one notification, scoped to its owner.
 *
 * Dismissing is what starts the 90-day retention clock — see
 * {@link NOTIFICATION_EXPIRY_TARGET}. `readAt` is deliberately untouched, as in
 * the source: dismissing without reading leaves `readAt` null.
 */
export async function dismissNotification(
  db: StationDatabase,
  id: string,
  oxyUserId: string,
): Promise<number> {
  const rows = await db
    .update(notifications)
    .set({ status: 'dismissed' })
    .where(and(eq(notifications.id, id), eq(notifications.oxyUserId, oxyUserId)))
    .returning({ id: notifications.id });
  return rows.length;
}

/**
 * The replacement for the Mongo TTL index, expressed in the one shape
 * `@oxyhq/db`'s sweep understands.
 *
 * The source index is PARTIAL — `{ createdAt: 1 }`, `expireAfterSeconds:
 * 90 days`, `partialFilterExpression: { status: 'dismissed' }` — and
 * `ExpirySweepTarget` has no predicate field. Rather than re-implement the
 * sweep here with a predicate of its own, the predicate lives in the
 * `dismissedReapAt` GENERATED column, which is `createdAt` for a dismissed row
 * and null otherwise. `column <= now() - interval` is then exactly the Mongo
 * rule, and a row that is not dismissed is never selected because
 * `null <= anything` is null.
 *
 * ## What deleting the row costs
 *
 * A dismissed notification 90 days old. Nothing reads dismissed notifications —
 * the feed filters by status on request and the unread count covers
 * pending/sent only — so no read path depends on a swept row being present, and
 * none depends on it being ABSENT either, which is the condition that would
 * turn the sweep interval into a correctness window.
 *
 * ## NOT YET SCHEDULED
 *
 * This is a registry entry and nothing more. A sweeper with no caller is green
 * and inert: the mechanism can work and nothing establishes that it does.
 * Wiring `sweepAllExpiredRows` into the service entrypoint is still a release
 * lifecycle step. It must land with an assertion that the entrypoint really
 * calls it and that each API deployment starts exactly one scheduler.
 */
export const NOTIFICATION_EXPIRY_TARGET: ExpirySweepTarget = {
  table: notifications,
  column: notifications.dismissedReapAt,
  retentionSeconds: NOTIFICATION_DISMISSED_RETENTION_SECONDS,
  reason:
    'A notification the user dismissed 90 days ago. Ports the Mongo partial TTL index; ' +
    'no read path filters on dismissed notifications, so nothing depends on the row either way.',
};
