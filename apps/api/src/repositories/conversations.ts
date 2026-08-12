/**
 * Conversation reads and writes.
 *
 * One function per query the live code performs, named for the call site it
 * replaces. Nothing here is called yet — the rewiring is a separate change, so
 * that the repositories and their real-database coverage land as reviewable
 * code rather than inside the commit that also moves the traffic.
 *
 * Call sites covered:
 *   create                  routes/conversations.ts:21
 *   listByUser              routes/conversations.ts:62
 *   findByConversationId    routes/conversations.ts:102, lib/conversation-saver.ts:156
 *   existsForUser           lib/chat-lifecycle.ts:80
 *   saveFromRoute           routes/conversations.ts:178
 *   saveFromChat            lib/conversation-saver.ts:79
 *   updateTitle             lib/conversation-saver.ts:163, routes/v1/chat-completions.ts:970
 *   deleteForUser           routes/conversations.ts:260
 */

import { and, desc, eq, lt } from 'drizzle-orm';
import { conversations, type ConversationSource } from '../db/schema/aiChat.js';
import { resolveHandle, type PgHandle } from './handle.js';

export interface ConversationKey {
  oxyUserId: string;
  conversationId: string;
}

export interface CreateConversationInput extends ConversationKey {
  title?: string;
  source?: ConversationSource;
  agentId?: string;
}

/** `routes/conversations.ts:21` — `Conversation.create({...})`. */
export async function create(
  input: CreateConversationInput,
  handle?: PgHandle,
): Promise<typeof conversations.$inferSelect> {
  const [row] = await resolveHandle(handle)
    .insert(conversations)
    .values({
      oxyUserId: input.oxyUserId,
      conversationId: input.conversationId,
      // `title` and `source` carry column defaults ('New chat', 'app'), so an
      // absent one is left to the database rather than defaulted here twice.
      ...(input.title !== undefined && { title: input.title }),
      ...(input.source !== undefined && { source: input.source }),
      ...(input.agentId !== undefined && { agentId: input.agentId }),
    })
    .returning();
  return row;
}

/**
 * The projection `routes/conversations.ts:63` selects. Spelled out so the wire
 * shape is a decision in one place rather than whatever `select *` happens to
 * return after the next column is added.
 */
const LIST_COLUMNS = {
  conversationId: conversations.conversationId,
  title: conversations.title,
  lastMessage: conversations.lastMessage,
  source: conversations.source,
  agentId: conversations.agentId,
  createdAt: conversations.createdAt,
  updatedAt: conversations.updatedAt,
} as const;

export interface ListByUserInput {
  oxyUserId: string;
  /** Page size. The extra row that decides `hasMore` is added here, not by the caller. */
  limit: number;
  /** `updatedAt` of the last row of the previous page. */
  cursor?: Date;
}

export interface ListByUserResult {
  conversations: Array<{
    [K in keyof typeof LIST_COLUMNS]: (typeof conversations.$inferSelect)[K];
  }>;
  nextCursor: Date | null;
  hasMore: boolean;
}

/**
 * `routes/conversations.ts:62` — cursor pagination down
 * `conversations_user_updated_idx`.
 *
 * The cursor is bound as a `Date` through the query builder, never interpolated
 * into a `sql` template: a bare Date in a template fails at serialisation in
 * the driver rather than at the server, which is a much harder error to read.
 *
 * `updatedAt` is not unique, so two conversations sharing a millisecond can
 * straddle a page boundary and the strict `<` drops the second. That is the
 * behaviour the Mongo query already had (`{ updatedAt: { $lt: cursor } }`);
 * fixing it means a composite cursor and a wire-format change, which is not
 * this port's to make.
 */
export async function listByUser(
  input: ListByUserInput,
  handle?: PgHandle,
): Promise<ListByUserResult> {
  const rows = await resolveHandle(handle)
    .select(LIST_COLUMNS)
    .from(conversations)
    .where(
      input.cursor
        ? and(
            eq(conversations.oxyUserId, input.oxyUserId),
            lt(conversations.updatedAt, input.cursor),
          )
        : eq(conversations.oxyUserId, input.oxyUserId),
    )
    .orderBy(desc(conversations.updatedAt))
    .limit(input.limit + 1);

  const hasMore = rows.length > input.limit;
  const page = hasMore ? rows.slice(0, input.limit) : rows;
  return {
    conversations: page,
    nextCursor: hasMore && page.length > 0 ? page[page.length - 1].updatedAt : null,
    hasMore,
  };
}

/** `routes/conversations.ts:102` and `lib/conversation-saver.ts:156`. */
export async function findByConversationId(
  key: ConversationKey,
  handle?: PgHandle,
): Promise<typeof conversations.$inferSelect | null> {
  const [row] = await resolveHandle(handle)
    .select()
    .from(conversations)
    .where(
      and(
        eq(conversations.oxyUserId, key.oxyUserId),
        eq(conversations.conversationId, key.conversationId),
      ),
    )
    .limit(1);
  return row ?? null;
}

/**
 * `lib/chat-lifecycle.ts:80` — `findOne({...}, { _id: 1 }).lean()`, whose only
 * use is `existing ? ... : false`. Returns the boolean the caller wanted rather
 * than a one-key row it has to interpret.
 */
export async function existsForUser(key: ConversationKey, handle?: PgHandle): Promise<boolean> {
  const [row] = await resolveHandle(handle)
    .select({ id: conversations.id })
    .from(conversations)
    .where(
      and(
        eq(conversations.oxyUserId, key.oxyUserId),
        eq(conversations.conversationId, key.conversationId),
      ),
    )
    .limit(1);
  return row !== undefined;
}

/**
 * Fields an upsert writes whether the row is new or not — Mongo's `$set`.
 *
 * Every key is optional and an UNDEFINED one must not be written. In Mongo
 * `$set: { lastMessage: undefined }` is stripped and the stored value survives;
 * the same statement in Postgres writes NULL and erases it. This is reachable
 * today: `routes/conversations.ts:154` computes `lastMessage` as `undefined`
 * whenever a save carries no valid messages, so a naive port would blank the
 * preview text of any conversation saved with an empty message list.
 * `buildSet` below is the only thing standing between those two behaviours and
 * `conversations.pgdb.test.ts` asserts it directly.
 */
export interface ConversationSetFields {
  title?: string;
  lastMessage?: string;
}

/** Fields written only when the row is created — Mongo's `$setOnInsert`. */
export interface ConversationInsertFields {
  title?: string;
  source?: ConversationSource;
  agentId?: string;
}

function buildSet(set: ConversationSetFields): Partial<typeof conversations.$inferInsert> {
  const out: Partial<typeof conversations.$inferInsert> = {};
  if (set.title !== undefined) out.title = set.title;
  if (set.lastMessage !== undefined) out.lastMessage = set.lastMessage;
  return out;
}

export interface UpsertConversationInput extends ConversationKey {
  set: ConversationSetFields;
  setOnInsert: ConversationInsertFields;
}

/**
 * `routes/conversations.ts:178` and `lib/conversation-saver.ts:79` — one
 * `findOneAndUpdate(..., { upsert: true })` translated to
 * `INSERT ... ON CONFLICT (oxy_user_id, conversation_id) DO UPDATE`.
 *
 * The conflict target is `conversations_user_conversation_key`, the ported
 * unique index. Using ON CONFLICT rather than a read-then-write keeps the
 * operation a single statement: two concurrent saves of the same conversation
 * (a streaming response finishing while the client posts) cannot both take the
 * insert branch, and no statement fails, so nothing aborts a surrounding
 * transaction the way a caught duplicate-key error would.
 *
 * Returns the row as it stands after the write — Mongo's
 * `returnDocument: 'after'`.
 */
export async function upsert(
  input: UpsertConversationInput,
  handle?: PgHandle,
): Promise<typeof conversations.$inferSelect> {
  const set = buildSet(input.set);

  const [row] = await resolveHandle(handle)
    .insert(conversations)
    .values({
      oxyUserId: input.oxyUserId,
      conversationId: input.conversationId,
      ...(input.setOnInsert.title !== undefined && { title: input.setOnInsert.title }),
      ...(input.setOnInsert.source !== undefined && { source: input.setOnInsert.source }),
      ...(input.setOnInsert.agentId !== undefined && { agentId: input.setOnInsert.agentId }),
      // `$set` also applies on insert in Mongo, and applies last so it wins
      // over `$setOnInsert` on any shared key.
      ...set,
    })
    .onConflictDoUpdate({
      target: [conversations.oxyUserId, conversations.conversationId],
      /**
       * `updatedAt` is written explicitly, and it is NOT the redundant write it
       * looks like.
       *
       * `set` is empty whenever every `$set` key was undefined — reachable from
       * `routes/conversations.ts:159` — and drizzle's `mapUpdateSet` throws
       * `Error: No values to set` on an empty object, BEFORE the `$onUpdate` on
       * `updatedAt` would have contributed anything. So the column that was
       * supposed to keep this clause non-empty cannot: an empty upsert failed
       * outright until this line existed. (Measured; the first version of this
       * function relied on `$onUpdate` and three tests caught it.)
       *
       * `new Date()` is the same JS clock `$onUpdate` uses, so the branch where
       * `set` is non-empty gets an identical value from either route rather
       * than silently switching to the server clock.
       *
       * Bumping it on every upsert is also the Mongo behaviour being ported:
       * `timestamps: true` makes Mongoose add `updatedAt` to every
       * `findOneAndUpdate`, including one whose `$set` was emptied by undefined
       * stripping — and `updatedAt` is what orders the conversation list.
       */
      set: { ...set, updatedAt: new Date() },
    })
    .returning();
  return row;
}

/**
 * `lib/conversation-saver.ts:163` and `routes/v1/chat-completions.ts:970`.
 *
 * Returns the number of rows the filter MATCHED. Postgres reports only
 * `rowCount`, which behaves like Mongo's `matchedCount`, not `modifiedCount` —
 * writing the same title twice reports 1 both times where Mongo's
 * `modifiedCount` would report 0 the second time. Neither call site reads
 * either count, so nothing turns on it; it is returned because a caller that
 * needs to tell "no such conversation" from "already had that title" must be
 * told which of the two questions this answers.
 */
export async function updateTitle(
  key: ConversationKey,
  title: string,
  handle?: PgHandle,
): Promise<number> {
  const result = await resolveHandle(handle)
    .update(conversations)
    .set({ title })
    .where(
      and(
        eq(conversations.oxyUserId, key.oxyUserId),
        eq(conversations.conversationId, key.conversationId),
      ),
    );
  return result.count;
}

/**
 * `routes/conversations.ts:260` — `deleteOne`, whose `deletedCount === 0`
 * decides the 404. A DELETE's `rowCount` is exactly `deletedCount`, so this one
 * translates without a choice to make.
 *
 * Deleting the conversation does NOT cascade to its messages: there is no
 * foreign key between the two tables, because `messages.conversationId` holds
 * the client-facing conversation id rather than the conversation row's primary
 * key. The route already deletes both sides explicitly; `messages.deleteForConversation`
 * is the other half.
 */
export async function deleteForUser(key: ConversationKey, handle?: PgHandle): Promise<number> {
  const result = await resolveHandle(handle)
    .delete(conversations)
    .where(
      and(
        eq(conversations.oxyUserId, key.oxyUserId),
        eq(conversations.conversationId, key.conversationId),
      ),
    );
  return result.count;
}
