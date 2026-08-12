import { sql } from 'drizzle-orm';
import { boolean, check, index, jsonb, pgTable, text, uniqueIndex } from 'drizzle-orm/pg-core';
import { createdAt, generatedId, inList, updatedAt } from '@oxyhq/db';

/**
 * AI chat: the `conversations` and `messages` collections.
 *
 * Ported from `src/models/conversation.ts` and `src/models/message.ts`.
 * Conventions (uuidv7 ids, `text` + CHECK instead of `pgEnum`, `inList` for the
 * literal side, column names derived from `DATABASE_CASING`) are explained once
 * in `workspaces.ts` and are not repeated here.
 *
 * The other three models the chat domain used to own — `agent.ts`, `skill.ts`
 * and `user-memory.ts` — are NOT ported, because nothing reaches them. Their
 * callers were stubbed out during the Clarity pruning and say so at
 * `services/chat.service.ts:145,152` and `lib/user-context.ts:19`. The census
 * behind that claim, including the negative controls, is in
 * `__tests__/aiChat.deadModels.test.ts`.
 */

/** Source apps a conversation can arrive from. `models/conversation.ts:71`. */
export const CONVERSATION_SOURCES = [
  'app',
  'telegram',
  'api',
  'web',
  'discord',
  'whatsapp',
  'slack',
] as const;
export type ConversationSource = (typeof CONVERSATION_SOURCES)[number];

/** `models/message.ts:31`. */
export const MESSAGE_ROLES = ['user', 'assistant', 'system'] as const;
export type MessageRole = (typeof MESSAGE_ROLES)[number];

/** `models/message.ts:33`. Optional — an unvoted message stores NULL. */
export const MESSAGE_VOTES = ['up', 'down'] as const;
export type MessageVote = (typeof MESSAGE_VOTES)[number];

/**
 * A message body is either a plain string or the AI SDK's multi-part array.
 * Mongo stored it as `Schema.Types.Mixed`; jsonb preserves both shapes, and a
 * string round-trips as a JSON string rather than becoming a one-element array.
 */
export type MessageContent = string | Array<{ type: string; [key: string]: unknown }>;

/** `models/message.ts:9-18`. `args`/`result` are provider-shaped, hence unknown. */
export interface ToolInvocation {
  toolCallId: string;
  toolName: string;
  state: 'partial-call' | 'call' | 'result';
  args?: unknown;
  result?: unknown;
}

/** `models/message.ts:20-25`. */
export interface AgentInfo {
  id: string;
  name: string;
  avatar: string | null;
  handle: string;
}

export const conversations = pgTable(
  'conversations',
  {
    id: generatedId(),
    /**
     * Oxy user id. `text`, matching `workspaces.ownerId`, NOT the
     * `Schema.Types.ObjectId` the Mongoose model declared.
     *
     * This is a deliberate divergence and it changes a failure mode. Every
     * writer passes `req.user.id`, a string minted by the Oxy auth service;
     * Mongoose cast it on the way in, so an id that was not 24 hex characters
     * threw a CastError — loud, and at the call site. Comparing text instead
     * makes the same id simply match no row: quiet, and at the read. The
     * repository's `findByConversationId` is covered by a test that asserts a
     * non-ObjectId user id round-trips rather than being rejected, because
     * `text` is what makes the opaque-id contract in `workspaces.ts` true here
     * too.
     */
    oxyUserId: text().notNull(),
    /**
     * The client-facing conversation id — a `randomUUID()` minted by
     * `routes/conversations.ts:18`, not this row's primary key. Every query in
     * the domain addresses a conversation by `(oxyUserId, conversationId)`,
     * never by `id`.
     */
    conversationId: text().notNull(),
    title: text().notNull().default('New chat'),
    /**
     * Set when a user renames a conversation, so auto-titling leaves it alone
     * (`lib/conversation-saver.ts:157`). Read by live code, written by none —
     * see the note on `icon` below.
     */
    isManualTitle: boolean().notNull().default(false),
    lastMessage: text(),
    source: text().notNull().default('app'),
    /**
     * `models/conversation.ts:76` declares `ref: 'Folder'`. There is no folder
     * model in this repo and never was one on this branch, so this is plain
     * text with no foreign key — a reference to a collection that does not
     * exist is not an integrity constraint worth inventing at the port.
     */
    folderId: text(),
    /**
     * `icon`, `iconColor`, `isFavorite`, `isPublic` and `folderId` are declared
     * by the Mongoose schema and read or written by NO live code (census in
     * `__tests__/aiChat.deadModels.test.ts`). They are carried across anyway:
     * dropping a column is a data-loss decision for whoever runs the backfill,
     * and an unwritten column costs nothing. They are candidates for removal,
     * not removals.
     */
    icon: text(),
    iconColor: text(),
    isFavorite: boolean().notNull().default(false),
    isPublic: boolean().notNull().default(false),
    /**
     * `models/conversation.ts:81` declares `ref: 'Agent'`. The Agent model is
     * dead (see the file header), so this stays plain text with no foreign key
     * — the column is still written by `routes/conversations.ts:26` and read
     * back at `:33` and `:124`, so it is live data pointing at a dead model.
     */
    agentId: text(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    // `ConversationSchema.index({ oxyUserId: 1, conversationId: 1 }, { unique: true })`.
    uniqueIndex('conversations_user_conversation_key').on(t.oxyUserId, t.conversationId),
    // `{ oxyUserId: 1, updatedAt: -1 }` — the cursor pagination in
    // `routes/conversations.ts:62-65` reads straight down it.
    index('conversations_user_updated_idx').on(t.oxyUserId, t.updatedAt.desc()),
    // `{ oxyUserId: 1, agentId: 1 }`.
    index('conversations_user_agent_idx').on(t.oxyUserId, t.agentId),
    /**
     * The `source` enum is a TIGHTENING, deliberately.
     *
     * Mongoose enforced it on one of the two write paths and not the other:
     * `Conversation.create()` (`routes/conversations.ts:21`) runs validators,
     * while `findOneAndUpdate` does not — so `POST /conversations` with
     * `{"source":"bogus"}` in the body reaches `$setOnInsert` at
     * `routes/conversations.ts:169` and stores the bogus value today. The
     * invariant is declared and half-enforced, which is the case the port is
     * supposed to make structural; it is not a new rule invented here. The
     * consequence — that same request now raises a check violation instead of
     * writing garbage — is asserted in `conversations.pgdb.test.ts` so a later
     * reader cannot mistake it for an accident.
     */
    check('conversations_source', sql`${t.source} in (${sql.raw(inList(CONVERSATION_SOURCES))})`),
  ],
);

export const messages = pgTable(
  'messages',
  {
    id: generatedId(),
    conversationId: text().notNull(),
    /** Oxy user id — see the note on `conversations.oxyUserId`. */
    oxyUserId: text().notNull(),
    /**
     * Mongo's `Message.id` (`models/message.ts:30`) — a client-supplied
     * identifier, distinct from the row's primary key, which the vote route
     * matches on (`routes/conversations.ts:234`). Renamed because `id` is the
     * primary key here; the repository takes `messageId` and no caller ever
     * sees the column name.
     *
     * Nullable: `lib/conversation-saver.ts:99` inserts messages without one,
     * so only conversations saved through `POST /conversations` are votable.
     * That asymmetry is pre-existing, not introduced here.
     */
    messageId: text(),
    role: text().notNull(),
    content: jsonb().$type<MessageContent>().notNull(),
    vote: text(),
    toolInvocations: jsonb().$type<ToolInvocation[]>(),
    agentInfo: jsonb().$type<AgentInfo>(),
    audioUrl: text(),
    /**
     * `models/message.ts:37` declares `createdAt` by hand and the schema has NO
     * `timestamps: true`, so there is no `updatedAt` to port. Adding one would
     * invent a fact no writer maintains.
     *
     * The `createdAt()` helper rather than a plain `defaultNow()`: it defaults
     * at JS millisecond precision, which is what `Date.now()` gave the Mongo
     * column and what a `Date` read back out of the driver can represent. Raw
     * `now()` stores microseconds that no reader can see, so two rows written
     * in the same millisecond would order by digits absent from every value the
     * application handles.
     */
    createdAt: createdAt(),
  },
  (t) => [
    // `MessageSchema.index({ conversationId: 1, createdAt: 1 })`. Also the
    // index `countDocuments({ conversationId })` and `exists({ conversationId })`
    // ride on, via the leading column.
    index('messages_conversation_created_idx').on(t.conversationId, t.createdAt),
    // `MessageSchema.index({ oxyUserId: 1, conversationId: 1 })` — the cascade
    // delete in `routes/conversations.ts:264`.
    index('messages_user_conversation_idx').on(t.oxyUserId, t.conversationId),
    /**
     * `insertMany` DOES run validators, so both of these enums fire today and
     * port as live constraints rather than as validators that never ran.
     *
     * `vote` is nullable and a CHECK rejects only FALSE, so an unvoted message
     * (`vote IS NULL` ⇒ the predicate is NULL, not FALSE) is accepted without a
     * predicate guarding it. That is load-bearing and is asserted directly.
     */
    check('messages_role', sql`${t.role} in (${sql.raw(inList(MESSAGE_ROLES))})`),
    check('messages_vote', sql`${t.vote} in (${sql.raw(inList(MESSAGE_VOTES))})`),
  ],
);
