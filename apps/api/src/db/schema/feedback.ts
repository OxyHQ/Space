import { sql } from 'drizzle-orm';
import { check, index, integer, pgTable, text } from 'drizzle-orm/pg-core';
import { createdAt, generatedId, inList, updatedAt } from '@oxyhq/db';

export const FEEDBACK_TYPES = ['bug', 'feature', 'improvement', 'other'] as const;
export type FeedbackType = (typeof FEEDBACK_TYPES)[number];

export const FEEDBACK_STATUSES = ['pending', 'reviewed', 'resolved'] as const;
export type FeedbackStatus = (typeof FEEDBACK_STATUSES)[number];

/** User-submitted product feedback, independent of inference. */
export const feedback = pgTable(
  'feedback',
  {
    id: generatedId(),
    oxyUserId: text().notNull(),
    type: text().notNull(),
    rating: integer(),
    message: text().notNull(),
    email: text(),
    metadataPlatform: text(),
    metadataAppVersion: text(),
    metadataDeviceInfo: text(),
    status: text().notNull().default('pending'),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    index('feedback_user_created_idx').on(t.oxyUserId, t.createdAt.desc()),
    index('feedback_status_idx').on(t.status),
    index('feedback_type_idx').on(t.type),
    check('feedback_type', sql`${t.type} in (${sql.raw(inList(FEEDBACK_TYPES))})`),
    check('feedback_status', sql`${t.status} in (${sql.raw(inList(FEEDBACK_STATUSES))})`),
    check(
      'feedback_rating_range',
      sql`${t.rating} is null or (${t.rating} >= 1 and ${t.rating} <= 5)`,
    ),
  ],
);
