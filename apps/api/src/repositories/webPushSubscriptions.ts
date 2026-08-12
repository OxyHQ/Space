/**
 * Browser (VAPID) push subscription reads and writes.
 *
 * A fifth repository rather than a section of `pushTokens.ts`: this is a second
 * table with its own conflict target and its own reassembly rule, and a module
 * named for one table that quietly writes another is exactly what makes a later
 * writer-versus-columns audit miss something.
 *
 * The reassembly is the part that matters. `keys` was a Mongo sub-document and
 * is two columns here, so `webPush.sendNotification({ endpoint, keys })`
 * (`lib/notification-service.ts:253-256`) gets `keys` rebuilt below. Hand it a
 * raw row instead and `sub.keys` is `undefined` — which surfaces as a malformed
 * subscription from the web-push library, not as a missing column.
 */

import { and, eq, sql } from 'drizzle-orm';
import type { StationDatabase } from '../db/client.js';
import { webPushSubscriptions } from '../db/schema/collab.js';

export interface WebPushKeys {
  p256dh: string;
  auth: string;
}

export interface WebPushSubscriptionRow {
  id: string;
  oxyUserId: string;
  endpoint: string;
  keys: WebPushKeys;
  active: boolean;
  createdAt: Date;
  updatedAt: Date;
}

export interface UpsertWebPushSubscriptionInput {
  oxyUserId: string;
  endpoint: string;
  keys: WebPushKeys;
}

function toWebPushSubscriptionRow(
  row: typeof webPushSubscriptions.$inferSelect,
): WebPushSubscriptionRow {
  return {
    id: row.id,
    oxyUserId: row.oxyUserId,
    endpoint: row.endpoint,
    keys: { p256dh: row.keyP256dh, auth: row.keyAuth },
    active: row.active,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

/**
 * Save a browser subscription, or reactivate and re-key the existing one.
 *
 * Unlike the Expo token upsert, both key halves are ALWAYS overwritten — the
 * source sets them unconditionally (`routes/notifications.ts:213-216`) and the
 * route rejects a request missing either with a 400 beforehand. A browser that
 * re-subscribes issues fresh keys for the same endpoint, so the newest write is
 * the correct one.
 */
export async function upsertWebPushSubscription(
  db: StationDatabase,
  input: UpsertWebPushSubscriptionInput,
): Promise<WebPushSubscriptionRow> {
  const rows = await db
    .insert(webPushSubscriptions)
    .values({
      oxyUserId: input.oxyUserId,
      endpoint: input.endpoint,
      keyP256dh: input.keys.p256dh,
      keyAuth: input.keys.auth,
    })
    .onConflictDoUpdate({
      target: [webPushSubscriptions.oxyUserId, webPushSubscriptions.endpoint],
      set: {
        active: true,
        keyP256dh: input.keys.p256dh,
        keyAuth: input.keys.auth,
      },
    })
    .returning();
  const row = rows[0];
  if (!row) {
    throw new Error('upsertWebPushSubscription wrote no row');
  }
  return toWebPushSubscriptionRow(row);
}

/**
 * Deactivate a user's subscription to one endpoint. Returns the row count; the
 * route 404s on zero, matching Mongo's `matchedCount === 0`.
 */
export async function deactivateWebPushSubscription(
  db: StationDatabase,
  oxyUserId: string,
  endpoint: string,
): Promise<number> {
  const rows = await db
    .update(webPushSubscriptions)
    .set({ active: false })
    .where(
      and(
        eq(webPushSubscriptions.oxyUserId, oxyUserId),
        eq(webPushSubscriptions.endpoint, endpoint),
      ),
    )
    .returning({ id: webPushSubscriptions.id });
  return rows.length;
}

/** Deactivate one row by primary key — the 410/404-from-the-push-service path. */
export async function deactivateWebPushSubscriptionById(
  db: StationDatabase,
  id: string,
): Promise<number> {
  const rows = await db
    .update(webPushSubscriptions)
    .set({ active: false })
    .where(eq(webPushSubscriptions.id, id))
    .returning({ id: webPushSubscriptions.id });
  return rows.length;
}

/** Every active subscription for a user, with `keys` reassembled. */
export async function listActiveWebPushSubscriptions(
  db: StationDatabase,
  oxyUserId: string,
): Promise<WebPushSubscriptionRow[]> {
  const rows = await db
    .select()
    .from(webPushSubscriptions)
    .where(
      and(
        eq(webPushSubscriptions.oxyUserId, oxyUserId),
        eq(webPushSubscriptions.active, true),
      ),
    );
  return rows.map(toWebPushSubscriptionRow);
}

/** Whether a user has any active browser subscription. */
export async function hasActiveWebPushSubscription(
  db: StationDatabase,
  oxyUserId: string,
): Promise<boolean> {
  const rows = await db
    .select({ one: sql<number>`1` })
    .from(webPushSubscriptions)
    .where(
      and(
        eq(webPushSubscriptions.oxyUserId, oxyUserId),
        eq(webPushSubscriptions.active, true),
      ),
    )
    .limit(1);
  return rows.length > 0;
}
