/**
 * Notification Service
 *
 * Delivers notifications to users via multiple channels:
 * - in_app: Socket.io real-time event
 * - push: Expo push notifications (mobile)
 * Each notification is persisted and can be delivered to multiple channels simultaneously.
 *
 * ## The id coercion that used to guard every query here is gone
 *
 * Every read and write below wrapped the caller's id in
 * `new mongoose.Types.ObjectId(userId)`, which THROWS on anything that is not 24
 * hex characters. `notifications.oxyUserId` is `text`, so the same id now simply
 * matches no rows. That is a LOUD-to-QUIET change: an id that produced a 500
 * produces an empty notification list. No format guard is re-added — there is no
 * users table to validate against and inventing one would be a new constraint —
 * but it is stated here because it is the kind of divergence that is invisible
 * until someone asks why a user sees nothing.
 */

import Expo, { type ExpoPushMessage, type ExpoPushReceiptId } from 'expo-server-sdk';
import { getDb } from '../db/client.js';
import {
  countUnreadNotifications,
  createNotification,
  dismissNotification as dismissNotificationRow,
  markAllNotificationsRead,
  markNotificationRead,
  updateNotificationDeliveryStatus,
  type NotificationDeliveryStatus,
  type NotificationRow,
} from '../repositories/notifications.js';
import {
  deactivatePushTokenById,
  deactivatePushTokenEverywhere,
  hasActivePushToken,
  listActivePushTokens,
  touchPushTokensLastUsed,
} from '../repositories/pushTokens.js';
import {
  deactivateWebPushSubscriptionById,
  hasActiveWebPushSubscription,
  listActiveWebPushSubscriptions,
} from '../repositories/webPushSubscriptions.js';
import type {
  NotificationChannel,
  NotificationPriority,
  NotificationType,
} from '../db/schema/collab.js';
import { webPush, VAPID_PUBLIC_KEY } from './web-push.js';
import { getIO } from '../socket.js';
import { log } from './logger.js';

// ── Expo push singleton ──────────────────────────────────────────────
const expo = new Expo();

// ── Types ──────────────────────────────────────────────────────────

export interface SendNotificationOptions {
  userId: string;
  type: NotificationType;
  title: string;
  body: string;
  priority?: NotificationPriority;
  channels?: NotificationChannel[];
  data?: Record<string, unknown>;
}

/** The HTTP statuses a push service uses for "this subscription is dead". */
const GONE_STATUS_CODES = [410, 404];

function pushServiceStatusCode(error: unknown): number | undefined {
  if (typeof error !== 'object' || error === null) return undefined;
  const statusCode = (error as { statusCode?: unknown }).statusCode;
  return typeof statusCode === 'number' ? statusCode : undefined;
}

// ── Resolve delivery channels ──────────────────────────────────────

/**
 * Determine which channels to deliver a notification to.
 * If explicit channels are provided, use those. Otherwise, default to in_app
 * plus any connected messaging accounts the user has.
 */
async function resolveChannels(userId: string, explicit?: NotificationChannel[]): Promise<NotificationChannel[]> {
  if (explicit && explicit.length > 0) {
    return explicit;
  }

  // Default: always in_app
  const channels: NotificationChannel[] = ['in_app'];

  const db = getDb();

  // Check in parallel: push tokens and web push subscriptions
  const [hasPushTokens, hasWebPushSubs] = await Promise.all([
    // Push: check if user has any active Expo push tokens
    hasActivePushToken(db, userId).catch(() => false),

    // Web push: check if user has any active browser push subscriptions (only if VAPID configured)
    VAPID_PUBLIC_KEY
      ? hasActiveWebPushSubscription(db, userId).catch(() => false)
      : false,
  ]);

  if (hasPushTokens || hasWebPushSubs) {
    channels.push('push');
  }

  return channels;
}

// ── Channel delivery implementations ───────────────────────────────

async function deliverInApp(notification: NotificationRow): Promise<boolean> {
  const io = getIO();
  if (!io) return false;

  io.to(`user:${notification.oxyUserId}`).emit('notification', {
    id: notification.id,
    type: notification.type,
    title: notification.title,
    body: notification.body,
    priority: notification.priority,
    data: notification.data,
    createdAt: notification.createdAt,
  });

  return true;
}

// ── Expo Push Notifications ─────────────────────────────────────────

/**
 * Deliver a push notification to all of a user's registered Expo push tokens.
 * Handles chunked sending (Expo limit) and async receipt checking.
 */
async function deliverPush(userId: string, notification: NotificationRow): Promise<boolean> {
  const db = getDb();
  const tokens = await listActivePushTokens(db, userId);

  if (tokens.length === 0) return false;

  // Build messages — one per device token
  const messages: ExpoPushMessage[] = [];
  for (const t of tokens) {
    if (!Expo.isExpoPushToken(t.token)) {
      log.general.warn({ token: t.token, userId }, 'Invalid Expo push token, deactivating');
      await deactivatePushTokenById(db, t.id);
      continue;
    }

    messages.push({
      to: t.token,
      title: notification.title,
      body: notification.body,
      data: {
        notificationId: notification.id,
        type: notification.type,
        ...notification.data,
      },
      sound: 'default',
      priority: notification.priority === 'urgent' || notification.priority === 'high' ? 'high' : 'normal',
      channelId: 'default',
    });
  }

  if (messages.length === 0) return false;

  // Send in chunks (Expo recommends batches of ~100)
  const chunks = expo.chunkPushNotifications(messages);
  const receiptIds: ExpoPushReceiptId[] = [];
  let anySucceeded = false;

  for (const chunk of chunks) {
    try {
      const tickets = await expo.sendPushNotificationsAsync(chunk);

      for (let i = 0; i < tickets.length; i++) {
        const ticket = tickets[i];
        if (ticket.status === 'ok') {
          anySucceeded = true;
          if (ticket.id) {
            receiptIds.push(ticket.id);
          }
        } else {
          // ticket.status === 'error'
          const errorDetail = ticket as { status: 'error'; message: string; details?: { error: string } };
          const messageTo = chunk[i].to;
          const messageToken = Array.isArray(messageTo) ? messageTo[0] : messageTo;
          log.general.warn(
            { userId, token: messageToken, error: errorDetail.message, errorCode: errorDetail.details?.error },
            'Expo push ticket error',
          );

          // Deactivate tokens that are permanently invalid.
          //
          // DIVERGENCE: this deactivates EVERY row naming the token, where
          // Mongo's `updateOne({ token })` touched at most one — so with two
          // users on one device, which of them lost the token depended on
          // whichever document the query happened to reach first. That
          // arbitrariness has no Postgres equivalent and should not get one:
          // `DeviceNotRegistered` means the device is gone for everybody.
          if (errorDetail.details?.error === 'DeviceNotRegistered') {
            await deactivatePushTokenEverywhere(db, messageToken);
          }
        }
      }
    } catch (error) {
      log.general.error({ err: error, userId }, 'Expo push chunk send failed');
    }
  }

  // Fire-and-forget receipt checking (delayed)
  if (receiptIds.length > 0) {
    setTimeout(() => checkPushReceipts(receiptIds).catch(() => {}), 15_000).unref?.();
  }

  // Update lastUsedAt for active tokens
  if (anySucceeded) {
    const activeTokenIds = tokens.filter(t => Expo.isExpoPushToken(t.token)).map(t => t.id);
    await touchPushTokensLastUsed(db, activeTokenIds, new Date());
  }

  return anySucceeded;
}

/**
 * Check push notification receipts after a delay.
 * Expo recommends checking ~15 seconds after sending.
 * Deactivates tokens that received DeviceNotRegistered errors.
 */
async function checkPushReceipts(receiptIds: ExpoPushReceiptId[]): Promise<void> {
  const chunks = expo.chunkPushNotificationReceiptIds(receiptIds);

  for (const chunk of chunks) {
    try {
      const receipts = await expo.getPushNotificationReceiptsAsync(chunk);

      for (const [receiptId, receipt] of Object.entries(receipts)) {
        if (receipt.status === 'error') {
          const { message, details } = receipt;
          log.general.warn({ receiptId, message, error: details?.error }, 'Expo push receipt error');

          // Deactivate invalid device tokens
          if (details?.error === 'DeviceNotRegistered') {
            // We can't directly map receiptId -> token, but Expo will stop delivering
            // to unregistered devices. The token gets deactivated on the next send attempt.
            log.general.info({ receiptId }, 'Device not registered — token will be deactivated on next send');
          }
        }
      }
    } catch (error) {
      log.general.error({ err: error }, 'Failed to check Expo push receipts');
    }
  }
}

// ── Web Push Notifications ───────────────────────────────────────────

/**
 * Deliver a push notification to all of a user's registered web push subscriptions.
 * Handles 410 Gone (expired subscription) by deactivating.
 */
async function deliverWebPush(userId: string, notification: NotificationRow): Promise<boolean> {
  if (!VAPID_PUBLIC_KEY) return false;

  const db = getDb();
  // `keys` is reassembled by the repository out of the two columns the Mongo
  // sub-document became. A raw row would carry `keys: undefined`, which
  // `webPush.sendNotification` reports as a malformed subscription rather than
  // as a missing column.
  const subscriptions = await listActiveWebPushSubscriptions(db, userId);

  if (subscriptions.length === 0) return false;

  const payload = JSON.stringify({
    title: notification.title,
    body: notification.body,
    notificationId: notification.id,
    type: notification.type,
    ...notification.data,
  });

  const results = await Promise.allSettled(
    subscriptions.map(async (sub) => {
      try {
        await webPush.sendNotification(
          { endpoint: sub.endpoint, keys: sub.keys },
          payload,
        );
      } catch (error: unknown) {
        if (GONE_STATUS_CODES.includes(pushServiceStatusCode(error) ?? 0)) {
          // Subscription expired or invalid — deactivate
          await deactivateWebPushSubscriptionById(db, sub.id);
          log.general.info({ userId, endpoint: sub.endpoint }, 'Web push subscription expired, deactivated');
        } else {
          log.general.warn({ err: error, userId, endpoint: sub.endpoint }, 'Web push delivery failed');
        }
        throw error; // Re-throw so Promise.allSettled marks as rejected
      }
    }),
  );

  return results.some(r => r.status === 'fulfilled');
}

// ── Main send function ─────────────────────────────────────────────

/**
 * Create and deliver a notification to a user across their preferred channels.
 */
export async function sendNotification(options: SendNotificationOptions): Promise<NotificationRow> {
  const {
    userId,
    type,
    title,
    body,
    priority = 'normal',
    data,
  } = options;

  const channels = await resolveChannels(userId, options.channels);

  const deliveryStatus: NotificationDeliveryStatus = Object.fromEntries(
    channels.map(ch => [ch, 'pending' as const]),
  );

  // Persist the notification
  const notification = await createNotification(getDb(), {
    oxyUserId: userId,
    type,
    title,
    body: body.slice(0, 4000), // Cap body length
    data,
    channels,
    deliveryStatus: { ...deliveryStatus },
    status: 'sent',
    priority,
  });

  // Deliver to each channel in parallel. The outcomes accumulate into the local
  // `deliveryStatus` map, which is then written in ONE update — the source
  // mutated the live document and called `markModified('deliveryStatus')`
  // before `save()`, and a jsonb column has no such per-key merge.
  const deliveries = channels.map(async (channel) => {
    try {
      let success = false;

      switch (channel) {
        case 'in_app':
          success = await deliverInApp(notification);
          break;
        case 'push': {
          // Deliver to both Expo (mobile) and web push in parallel
          const [expoPushOk, webPushOk] = await Promise.all([
            deliverPush(userId, notification),
            deliverWebPush(userId, notification),
          ]);
          success = expoPushOk || webPushOk;
          break;
        }
      }

      deliveryStatus[channel] = success ? 'sent' : 'failed';
    } catch (error: unknown) {
      log.general.error({ err: error, channel, userId }, 'Notification delivery failed');
      deliveryStatus[channel] = 'failed';
    }
  });

  await Promise.allSettled(deliveries);

  // Persist delivery status
  const persisted = await updateNotificationDeliveryStatus(getDb(), notification.id, deliveryStatus);

  log.general.info(
    { type, userId, channels, title: title.slice(0, 50) },
    'Notification sent',
  );

  // The row was inserted a moment ago, so the update finding nothing means it
  // was deleted mid-send. Returning the in-memory copy with the statuses this
  // call computed keeps the caller's contract; the source returned the same
  // document either way.
  return persisted ?? { ...notification, deliveryStatus };
}

// ── Query helpers ──────────────────────────────────────────────────

export async function getUnreadCount(userId: string): Promise<number> {
  return countUnreadNotifications(getDb(), userId);
}

/**
 * Mongo reported `modifiedCount` here and Postgres reports only a row count,
 * which is the `matchedCount` analogue. The two Mongo counts were always equal
 * for this statement — `{ timestamps: true }` makes mongoose add `updatedAt` to
 * every `updateOne`, so a matched document is always a modified one — so the row
 * count reproduces the source exactly. See the header of
 * `repositories/notifications.ts`, where that equality is measured rather than
 * assumed.
 */
export async function markAsRead(notificationId: string, userId: string): Promise<boolean> {
  return (await markNotificationRead(getDb(), notificationId, userId, new Date())) > 0;
}

export async function markAllAsRead(userId: string): Promise<number> {
  return markAllNotificationsRead(getDb(), userId, new Date());
}

export async function dismissNotification(notificationId: string, userId: string): Promise<boolean> {
  return (await dismissNotificationRow(getDb(), notificationId, userId)) > 0;
}
