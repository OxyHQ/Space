import { Router } from 'express';
import Expo from 'expo-server-sdk';
import { getDb } from '../db/client.js';
import {
  countNotifications,
  listNotifications,
  type ListNotificationsFilter,
} from '../repositories/notifications.js';
import { deactivatePushToken, upsertPushToken } from '../repositories/pushTokens.js';
import {
  deactivateWebPushSubscription,
  upsertWebPushSubscription,
} from '../repositories/webPushSubscriptions.js';
import {
  PUSH_PLATFORMS,
  type NotificationStatus,
  type NotificationType,
  type PushPlatform,
} from '../db/schema/collab.js';
import { authenticateToken } from '../middleware/auth.js';
import { getUnreadCount, markAsRead, markAllAsRead, dismissNotification } from '../lib/notification-service.js';
import { VAPID_PUBLIC_KEY } from '../lib/web-push.js';
import { log } from '../lib/logger.js';
import type { Request, Response } from 'express';

const router = Router();

const DEFAULT_PAGE_SIZE = 30;
const MAX_PAGE_SIZE = 100;

/**
 * A finite, non-negative integer, or the fallback.
 *
 * The source passed `Number(req.query.limit)` straight into `.limit()`, and
 * `Number('abc')` is `NaN`. Mongo treated a `NaN` limit as "no limit" and a
 * `NaN` skip as zero; Postgres rejects `LIMIT NaN` outright, so the same request
 * that quietly returned the whole table would now 500. Neither is the intent —
 * a malformed page parameter should fall back to the default it already has.
 */
function pageParam(value: unknown, fallback: number, max?: number): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < 0) return fallback;
  const floored = Math.floor(parsed);
  return max === undefined ? floored : Math.min(floored, max);
}

// ── Public route (no auth) — VAPID public key for browser subscription ──
router.get('/vapid-public-key', (_req: Request, res: Response) => {
  if (!VAPID_PUBLIC_KEY) {
    return res.status(503).json({ error: 'Web push not configured' });
  }
  res.json({ publicKey: VAPID_PUBLIC_KEY });
});

router.use(authenticateToken);

// GET /notifications — list user's notifications (paginated)
router.get('/', async (req: Request, res: Response) => {
  try {
    if (!req.user?.id) return res.status(401).json({ error: 'Unauthorized' });
    const userId = req.user.id as string;

    const { status, type, limit, offset } = req.query;
    const filter: ListNotificationsFilter = { oxyUserId: userId };

    if (status && typeof status === 'string') {
      filter.status = status as NotificationStatus;
    }
    if (type && typeof type === 'string') {
      filter.type = type as NotificationType;
    }

    const db = getDb();
    const [notifications, total, unreadCount] = await Promise.all([
      listNotifications(
        db,
        filter,
        pageParam(limit, DEFAULT_PAGE_SIZE, MAX_PAGE_SIZE),
        pageParam(offset, 0),
      ),
      countNotifications(db, filter),
      getUnreadCount(userId),
    ]);

    // Rows carry `id`; `_id` is gone. The repository also reassembles nothing
    // here — `data` and `deliveryStatus` are jsonb and come back as objects.
    res.json({ notifications, total, unreadCount });
  } catch (error: unknown) {
    log.general.error({ err: error }, 'Error listing notifications');
    res.status(500).json({ error: 'Failed to list notifications' });
  }
});

// GET /notifications/unread-count
router.get('/unread-count', async (req: Request, res: Response) => {
  try {
    if (!req.user?.id) return res.status(401).json({ error: 'Unauthorized' });
    const count = await getUnreadCount(req.user.id as string);
    res.json({ count });
  } catch (error: unknown) {
    log.general.error({ err: error }, 'Error getting unread count');
    res.status(500).json({ error: 'Failed to get unread count' });
  }
});

// PATCH /notifications/:id/read — mark single notification as read
router.patch('/:id/read', async (req: Request, res: Response) => {
  try {
    if (!req.user?.id) return res.status(401).json({ error: 'Unauthorized' });
    const userId = req.user.id as string;
    const success = await markAsRead(req.params.id as string, userId);
    if (!success) return res.status(404).json({ error: 'Notification not found' });
    res.json({ success: true });
  } catch (error: unknown) {
    log.general.error({ err: error }, 'Error marking notification as read');
    res.status(500).json({ error: 'Failed to mark as read' });
  }
});

// POST /notifications/read-all — mark all notifications as read
router.post('/read-all', async (req: Request, res: Response) => {
  try {
    if (!req.user?.id) return res.status(401).json({ error: 'Unauthorized' });
    const userId = req.user.id as string;
    const count = await markAllAsRead(userId);
    res.json({ success: true, count });
  } catch (error: unknown) {
    log.general.error({ err: error }, 'Error marking all as read');
    res.status(500).json({ error: 'Failed to mark all as read' });
  }
});

// PATCH /notifications/:id/dismiss — dismiss a notification
router.patch('/:id/dismiss', async (req: Request, res: Response) => {
  try {
    if (!req.user?.id) return res.status(401).json({ error: 'Unauthorized' });
    const userId = req.user.id as string;
    const success = await dismissNotification(req.params.id as string, userId);
    if (!success) return res.status(404).json({ error: 'Notification not found' });
    res.json({ success: true });
  } catch (error: unknown) {
    log.general.error({ err: error }, 'Error dismissing notification');
    res.status(500).json({ error: 'Failed to dismiss notification' });
  }
});

// ── Push Token Management ─────────────────────────────────────────

// POST /notifications/push-token — register or update an Expo push token
router.post('/push-token', async (req: Request, res: Response) => {
  try {
    if (!req.user?.id) return res.status(401).json({ error: 'Unauthorized' });
    const userId = req.user.id as string;
    const { token, deviceId, platform } = req.body;

    if (!token || typeof token !== 'string') {
      return res.status(400).json({ error: 'Push token is required' });
    }

    if (!Expo.isExpoPushToken(token)) {
      return res.status(400).json({ error: 'Invalid Expo push token format' });
    }

    if (platform && !PUSH_PLATFORMS.includes(platform)) {
      return res.status(400).json({ error: 'Invalid platform (must be ios, android, or web)' });
    }

    // Upsert: if user already registered this token, just reactivate it.
    // An omitted `deviceId` or `platform` leaves the stored value alone, which
    // is what the source's conditional spread did — there is no way to CLEAR
    // either through this path, in Mongo or here.
    const pushToken = await upsertPushToken(getDb(), {
      oxyUserId: userId,
      token,
      deviceId: typeof deviceId === 'string' && deviceId ? deviceId : undefined,
      platform: platform ? (platform as PushPlatform) : undefined,
    });

    log.general.info({ userId, tokenId: pushToken.id }, 'Push token registered');
    res.json({ success: true, id: pushToken.id });
  } catch (error: unknown) {
    log.general.error({ err: error }, 'Error registering push token');
    res.status(500).json({ error: 'Failed to register push token' });
  }
});

// DELETE /notifications/push-token — deactivate a push token (logout / uninstall)
router.delete('/push-token', async (req: Request, res: Response) => {
  try {
    if (!req.user?.id) return res.status(401).json({ error: 'Unauthorized' });
    const userId = req.user.id as string;
    const { token } = req.body;

    if (!token || typeof token !== 'string') {
      return res.status(400).json({ error: 'Push token is required' });
    }

    // Row count, which is Mongo's `matchedCount` analogue — the count this
    // route has always branched on.
    const matched = await deactivatePushToken(getDb(), userId, token);

    if (matched === 0) {
      return res.status(404).json({ error: 'Push token not found' });
    }

    log.general.info({ userId }, 'Push token deactivated');
    res.json({ success: true });
  } catch (error: unknown) {
    log.general.error({ err: error }, 'Error deactivating push token');
    res.status(500).json({ error: 'Failed to deactivate push token' });
  }
});

// ── Web Push Subscription Management ─────────────────────────────

// POST /notifications/web-push-subscription — save browser push subscription
router.post('/web-push-subscription', async (req: Request, res: Response) => {
  try {
    if (!req.user?.id) return res.status(401).json({ error: 'Unauthorized' });
    const userId = req.user.id as string;
    const { endpoint, keys } = req.body;

    if (!endpoint || typeof endpoint !== 'string') {
      return res.status(400).json({ error: 'Subscription endpoint is required' });
    }
    if (!keys?.p256dh || !keys?.auth) {
      return res.status(400).json({ error: 'Subscription keys (p256dh, auth) are required' });
    }

    const subscription = await upsertWebPushSubscription(getDb(), {
      oxyUserId: userId,
      endpoint,
      keys: { p256dh: keys.p256dh, auth: keys.auth },
    });

    log.general.info({ userId, subscriptionId: subscription.id }, 'Web push subscription registered');
    res.json({ success: true, id: subscription.id });
  } catch (error: unknown) {
    log.general.error({ err: error }, 'Error registering web push subscription');
    res.status(500).json({ error: 'Failed to register web push subscription' });
  }
});

// DELETE /notifications/web-push-subscription — deactivate browser push subscription
router.delete('/web-push-subscription', async (req: Request, res: Response) => {
  try {
    if (!req.user?.id) return res.status(401).json({ error: 'Unauthorized' });
    const userId = req.user.id as string;
    const { endpoint } = req.body;

    if (!endpoint || typeof endpoint !== 'string') {
      return res.status(400).json({ error: 'Subscription endpoint is required' });
    }

    const matched = await deactivateWebPushSubscription(getDb(), userId, endpoint);

    if (matched === 0) {
      return res.status(404).json({ error: 'Subscription not found' });
    }

    log.general.info({ userId }, 'Web push subscription deactivated');
    res.json({ success: true });
  } catch (error: unknown) {
    log.general.error({ err: error }, 'Error deactivating web push subscription');
    res.status(500).json({ error: 'Failed to deactivate web push subscription' });
  }
});

export default router;
