import { sql } from 'drizzle-orm';
import { check, index, integer, pgTable, text } from 'drizzle-orm/pg-core';
import { createdAt, generatedId, updatedAt } from '@oxyhq/db';

/**
 * One row per completed chat, written by the `analytics` afterChat hook.
 *
 * This collection was missed by the domain split — no agent owned it, because
 * it is declared INLINE inside `lib/hooks/built-in/analytics-hook.ts` rather
 * than under any `models/` directory, which is exactly the shape a census over
 * that directory cannot see. It is live: `lib/chat-lifecycle.ts` runs the
 * afterChat hooks, and `routes/analytics.ts` reads it through three
 * aggregates.
 */
export const chatAnalytics = pgTable(
  'chat_analytics',
  {
    id: generatedId(),
    /**
     * Oxy user id — `text`, like every other table here.
     *
     * The Mongoose field was `Schema.Types.ObjectId` with `ref: 'User'`, and
     * the writer handed it `ctx.userId`, a string, which mongoose cast on the
     * way in and `routes/analytics.ts` re-cast on the way out. There is no
     * users table in this database to point at, so the cast existed only to
     * satisfy a declaration; storing the id as what it is removes both sides.
     */
    oxyUserId: text().notNull(),
    conversationId: text(),
    /** The concrete provider model actually used. Internal — never surfaced. */
    model: text().notNull(),
    /** What the caller asked for. Safe to show. */
    clarityModelId: text(),
    /** Internal only — never reaches a user-facing response. */
    provider: text().notNull(),
    promptTokens: integer().notNull().default(0),
    completionTokens: integer().notNull().default(0),
    totalTokens: integer().notNull().default(0),
    latencyMs: integer().notNull().default(0),
    platform: text().notNull().default('app'),
    skillId: text(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    // The only read pattern: one user's rows over a window, newest first.
    index('chat_analytics_user_created_idx').on(t.oxyUserId, t.createdAt.desc()),
    // Token counts are counts. The Mongoose schema defaulted them to 0 and
    // nothing guarded the sign; a negative token count is not a state any
    // writer can mean, and it would silently corrupt every sum below it.
    check(
      'chat_analytics_non_negative',
      sql`${t.promptTokens} >= 0 and ${t.completionTokens} >= 0 and ${t.totalTokens} >= 0 and ${t.latencyMs} >= 0`,
    ),
  ],
);

export type ChatAnalyticsRow = typeof chatAnalytics.$inferSelect;
export type NewChatAnalytics = typeof chatAnalytics.$inferInsert;
