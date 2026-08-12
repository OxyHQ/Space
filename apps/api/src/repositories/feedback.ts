/**
 * Feedback — user-submitted bug reports, feature requests and ratings.
 *
 * The one divergence worth knowing is in the schema, not here: `oxyUserId` is
 * `text`, though Mongoose declared it `Schema.Types.ObjectId, ref: 'User'`.
 * The declaration never matched what the writer stores — `routes/feedback.ts:36`
 * passes the opaque Oxy user id — so the cast Mongoose performed was incidental
 * and both sides of every comparison here are the same unconverted string.
 */

import { and, desc, eq } from 'drizzle-orm';
import type { StationDatabase } from '../db/client.js';
import { feedback } from '../db/schema/billing.js';

export type FeedbackRow = typeof feedback.$inferSelect;

/**
 * `new Feedback({...}); await feedback.save()` — `routes/feedback.ts:35-45`.
 *
 * The `metadata` sub-document arrives straight from the request body and is
 * destructured into its three declared fields. That reproduces Mongo's strict
 * mode, which silently DROPPED every other key: passing the object through to
 * a `jsonb` column would start persisting arbitrary unvalidated user input
 * that the source discarded.
 */
export async function createFeedback(
  db: StationDatabase,
  values: {
    oxyUserId: string;
    type: string;
    rating?: number | null;
    message: string;
    email?: string | null;
    metadata?: { platform?: string; appVersion?: string; deviceInfo?: string } | null;
  },
): Promise<FeedbackRow> {
  const rows = await db
    .insert(feedback)
    .values({
      oxyUserId: values.oxyUserId,
      type: values.type,
      rating: values.rating ?? null,
      message: values.message,
      email: values.email ?? null,
      metadataPlatform: values.metadata?.platform ?? null,
      metadataAppVersion: values.metadata?.appVersion ?? null,
      metadataDeviceInfo: values.metadata?.deviceInfo ?? null,
      status: 'pending',
    })
    .returning();
  if (!rows[0]) throw new Error('feedback insert returned no row');
  return rows[0];
}

/** `routes/feedback.ts:68` — a user's own history, newest first, capped at 50. */
export async function listFeedbackByUser(
  db: StationDatabase,
  oxyUserId: string,
  limit = 50,
): Promise<FeedbackRow[]> {
  return db
    .select()
    .from(feedback)
    .where(eq(feedback.oxyUserId, oxyUserId))
    .orderBy(desc(feedback.createdAt), desc(feedback.id))
    .limit(limit);
}

/**
 * `routes/feedback.ts:85` — `findOne({ _id, oxyUserId })`.
 *
 * The owner is part of the WHERE clause, not checked afterwards, so a request
 * for someone else's feedback is a miss rather than a row the caller has to
 * remember to reject.
 */
export async function findFeedbackByIdForUser(
  db: StationDatabase,
  id: string,
  oxyUserId: string,
): Promise<FeedbackRow | null> {
  const rows = await db
    .select()
    .from(feedback)
    .where(and(eq(feedback.id, id), eq(feedback.oxyUserId, oxyUserId)))
    .limit(1);
  return rows[0] ?? null;
}
