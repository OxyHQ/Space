/**
 * Message reads and writes.
 *
 * Call sites covered:
 *   listForConversation      routes/conversations.ts:112
 *   deleteForConversation    routes/conversations.ts:184, :264, lib/conversation-saver.ts:97
 *   insertMany               routes/conversations.ts:186, lib/conversation-saver.ts:99
 *   replaceForConversation   the delete+insert pair at both of the above
 *   setVote                  routes/conversations.ts:231
 *   countForConversation     lib/conversation-saver.ts:158
 *   existsForConversation    lib/chat-lifecycle.ts:85
 */

import { and, asc, count, eq } from 'drizzle-orm';
import {
  messages,
  type AgentInfo,
  type MessageContent,
  type MessageRole,
  type MessageVote,
  type ToolInvocation,
} from '../db/schema/aiChat.js';
import { requireTransaction, resolveHandle, type PgHandle } from './handle.js';

export interface MessageInput {
  conversationId: string;
  oxyUserId: string;
  /** The client-supplied message id — Mongo's `Message.id`. */
  messageId?: string;
  role: MessageRole;
  content: MessageContent;
  vote?: MessageVote;
  toolInvocations?: ToolInvocation[];
  agentInfo?: AgentInfo;
  audioUrl?: string;
  createdAt?: Date;
}

/** `routes/conversations.ts:112` — the conversation's history, oldest first. */
export async function listForConversation(
  key: { conversationId: string; oxyUserId: string },
  handle?: PgHandle,
): Promise<Array<typeof messages.$inferSelect>> {
  return resolveHandle(handle)
    .select()
    .from(messages)
    .where(
      and(
        eq(messages.conversationId, key.conversationId),
        eq(messages.oxyUserId, key.oxyUserId),
      ),
    )
    .orderBy(asc(messages.createdAt));
}

/**
 * `routes/conversations.ts:184`, `:264` and `lib/conversation-saver.ts:97`.
 * Returns the number of rows removed — Mongo's `deletedCount`.
 */
export async function deleteForConversation(
  key: { conversationId: string; oxyUserId: string },
  handle?: PgHandle,
): Promise<number> {
  const result = await resolveHandle(handle)
    .delete(messages)
    .where(
      and(
        eq(messages.conversationId, key.conversationId),
        eq(messages.oxyUserId, key.oxyUserId),
      ),
    );
  return result.count;
}

/**
 * `routes/conversations.ts:186` and `lib/conversation-saver.ts:99` —
 * `insertMany(rows, { ordered: false })`.
 *
 * DIVERGENCE, chosen deliberately: this is all-or-nothing, `ordered: false` was
 * not.
 *
 * Mongo skipped rows that failed validation and inserted the rest, then threw.
 * A single multi-row INSERT fails entirely instead. Both call sites DELETE the
 * conversation's messages immediately before inserting, so under the Mongo
 * semantics a batch containing one message with a bad `role` — reachable today,
 * because `routes/conversations.ts:149` filters for `msg.role` being truthy and
 * never checks it against the enum — leaves the conversation permanently
 * missing that message while the rest of the history survives and the request
 * still 500s. Nothing tells the user which messages were lost.
 *
 * All-or-nothing turns that into a failure that changes nothing, which is why
 * it is the defensible reading; and `replaceForConversation` makes the delete
 * roll back with it so the old history is still there afterwards. Preserving
 * the partial-write behaviour would mean inserting row by row, which is a
 * guarantee no caller asked for and which no test could distinguish from a bug.
 */
export async function insertMany(
  rows: MessageInput[],
  handle?: PgHandle,
): Promise<Array<typeof messages.$inferSelect>> {
  if (rows.length === 0) return [];
  return resolveHandle(handle)
    .insert(messages)
    .values(rows.map(toInsertValues))
    .returning();
}

/**
 * Build one row's insert values from DEFINED keys only.
 *
 * An explicit `undefined` and an absent key mean the same thing to drizzle on
 * INSERT (both take the column default), so this is not load-bearing the way
 * `buildSet` in `conversations.ts` is. It is spelled out anyway because the two
 * writers hand over `req.body` fields that are routinely undefined
 * (`routes/conversations.ts:193-196`), and reading "these become NULL, not
 * garbage" out of an object literal is easier than deriving it from drizzle's
 * treatment of undefined.
 */
function toInsertValues(row: MessageInput): typeof messages.$inferInsert {
  return {
    conversationId: row.conversationId,
    oxyUserId: row.oxyUserId,
    role: row.role,
    content: row.content,
    ...(row.messageId !== undefined && { messageId: row.messageId }),
    ...(row.vote !== undefined && { vote: row.vote }),
    ...(row.toolInvocations !== undefined && { toolInvocations: row.toolInvocations }),
    ...(row.agentInfo !== undefined && { agentInfo: row.agentInfo }),
    ...(row.audioUrl !== undefined && { audioUrl: row.audioUrl }),
    ...(row.createdAt !== undefined && { createdAt: row.createdAt }),
  };
}

/**
 * Replace a conversation's entire message history.
 *
 * Both writers perform this as a DELETE followed by an INSERT, and in Mongo
 * those were two independent operations with a real gap between them: a crash,
 * a statement timeout or a concurrent read landing in that window sees a
 * conversation with NO messages, and a crash makes it permanent. Nothing errors
 * and nothing logs.
 *
 * Requiring a transaction is what closes the gap, and `requireTransaction`
 * enforces it at runtime rather than only in the signature — a caller can pass
 * the pool handle where a transaction is expected and have it type-check, which
 * would restore the gap silently.
 *
 * The caller that already had no transaction (`routes/conversations.ts:177`
 * runs the delete/insert pair inside a `Promise.all` beside the conversation
 * upsert) must open one when it is rewired; the conversation metadata write and
 * the message replacement are one logical write and belong in the same
 * transaction. `Promise.all` does not make them atomic and never did.
 */
export async function replaceForConversation(
  key: { conversationId: string; oxyUserId: string },
  rows: MessageInput[],
  handle: PgHandle,
): Promise<Array<typeof messages.$inferSelect>> {
  const tx = requireTransaction(handle, 'replaceForConversation');
  await deleteForConversation(key, tx);
  return insertMany(rows, tx);
}

/**
 * `routes/conversations.ts:231` — vote on a message.
 *
 * `null` clears the vote, translating Mongo's `$unset: { vote: 1 }`: an absent
 * field and a NULL column are the same absence, and the route already accepts
 * `null` as a distinct input from `'up'`/`'down'`.
 *
 * Returns the updated row, or null when nothing matched — the route's 404.
 */
export async function setVote(
  key: { conversationId: string; messageId: string; oxyUserId: string },
  vote: MessageVote | null,
  handle?: PgHandle,
): Promise<typeof messages.$inferSelect | null> {
  const [row] = await resolveHandle(handle)
    .update(messages)
    .set({ vote })
    .where(
      and(
        eq(messages.conversationId, key.conversationId),
        eq(messages.messageId, key.messageId),
        eq(messages.oxyUserId, key.oxyUserId),
      ),
    )
    .returning();
  return row ?? null;
}

/**
 * `lib/conversation-saver.ts:158` — `countDocuments({ conversationId })`.
 *
 * NOT scoped to a user, faithfully: the source query is not either. Scoping it
 * would be a behaviour change dressed as a fix, and this count only gates
 * whether a title is worth generating.
 *
 * `count()` maps the result with `Number`. Postgres returns `count(*)` as
 * `bigint`, which postgres.js decodes as a STRING while drizzle's types claim
 * `number`, so an unmapped count would make `messageCount > 3` a string
 * comparison — `'10' > 3` is false. `messages.pgdb.test.ts` asserts the runtime
 * `typeof`, since the type alone cannot catch it.
 */
export async function countForConversation(
  conversationId: string,
  handle?: PgHandle,
): Promise<number> {
  const [row] = await resolveHandle(handle)
    .select({ value: count() })
    .from(messages)
    .where(eq(messages.conversationId, conversationId));
  return row.value;
}

/**
 * `lib/chat-lifecycle.ts:85` — `Message.exists({ conversationId })`, reached
 * through a dynamic `await import(...)`. Not user-scoped, for the same reason
 * as `countForConversation`.
 */
export async function existsForConversation(
  conversationId: string,
  handle?: PgHandle,
): Promise<boolean> {
  const [row] = await resolveHandle(handle)
    .select({ id: messages.id })
    .from(messages)
    .where(eq(messages.conversationId, conversationId))
    .limit(1);
  return row !== undefined;
}
