import { Router } from 'express';
import { randomUUID } from 'crypto';
import { z } from 'zod';
import { getDb } from '../db/client.js';
import {
  create as createConversation,
  deleteForUser as deleteConversation,
  findByConversationId,
  listByUser,
  upsert as upsertConversation,
} from '../repositories/conversations.js';
import {
  deleteForConversation as deleteMessages,
  listForConversation as listMessages,
  replaceForConversation as replaceMessages,
  setVote,
  type MessageInput,
} from '../repositories/messages.js';
import {
  MESSAGE_ROLES,
  MESSAGE_VOTES,
  type AgentInfo,
  type MessageContent,
  type MessageRole,
  type MessageVote,
  type ToolInvocation,
  type messages as messagesTable,
} from '../db/schema/aiChat.js';
import { authenticateToken, authenticateTokenOrApiKey } from '../middleware/auth.js';
import type { Request, Response } from 'express';
import { log } from '../lib/logger.js';

const router = Router();

/**
 * Route params, narrowed to `string`.
 *
 * `z.string()` and NOT the `entityIdSchema` the page and database routes use:
 * neither of these is an entity id. `:id` is `conversations.conversationId`, a
 * client-facing identifier minted by `randomUUID()` at `POST /new` or supplied
 * verbatim by the caller at `POST /`, and `:messageId` is
 * `messages.messageId`, whatever string the client chose. Neither has ever had
 * a format, so imposing one here — a uuid check, or the 24-hex check the old
 * ObjectId columns implied — would reject identifiers the schema stores
 * happily. The parse exists only because `@types/express` 5 types a param as
 * `string | string[]`; it constrains nothing Express does not already
 * guarantee for a non-wildcard route.
 */
const idParams = z.object({ id: z.string() });
const messageParams = z.object({ id: z.string(), messageId: z.string() });

/**
 * A message as it arrives in `POST /conversations`.
 *
 * `role` and `vote` are typed `string` rather than their enums on purpose: this
 * is untrusted JSON, and typing them as the union would assert a fact about the
 * body that nothing has checked. `isStorableMessage` below is what turns the
 * string into the enum, and it is the only place that narrowing happens.
 */
interface IncomingMessage {
  id?: string;
  role?: string;
  content?: MessageContent;
  vote?: string;
  toolInvocations?: ToolInvocation[];
  agentInfo?: AgentInfo;
  audioUrl?: string;
  createdAt?: string | number;
}

/** A message the schema will accept: both enums narrowed, content present. */
type StorableMessage = Omit<IncomingMessage, 'role' | 'content' | 'vote'> & {
  role: MessageRole;
  content: MessageContent;
  vote?: MessageVote;
};

function isMessageRole(value: string): value is MessageRole {
  return (MESSAGE_ROLES as readonly string[]).includes(value);
}

function isMessageVote(value: string): value is MessageVote {
  return (MESSAGE_VOTES as readonly string[]).includes(value);
}

/**
 * The filter at the old `routes/conversations.ts:149`, unchanged: a null
 * message, one with no `role` at all, or one with no `content` is DROPPED
 * silently, exactly as before. Only messages that got this far were ever
 * offered to the database.
 */
function isPresentMessage(msg: IncomingMessage | null | undefined): msg is IncomingMessage & {
  role: string;
  content: MessageContent;
} {
  return (
    msg != null &&
    typeof msg.role === 'string' &&
    msg.role.length > 0 &&
    msg.content !== undefined
  );
}

/**
 * The enum narrowing, applied to messages that passed the filter above.
 *
 * DIVERGENCE, chosen here: a message whose `role` or `vote` is present but is
 * not one of the stored values now fails the request with a 400 instead of
 * reaching the database.
 *
 * Mongo enforced both enums — `insertMany` runs validators — but with
 * `ordered: false` it skipped the offending message, inserted the rest and then
 * threw. The request 500'd having permanently dropped one message out of the
 * middle of a history the same request had just deleted, and nothing told the
 * caller which. The repository's `insertMany` is all-or-nothing (its own
 * documented divergence), so what is left to choose is only how a body the
 * schema will not accept gets reported. 400 is what this same file already
 * answers for a bad `vote` on `PATCH /:id/messages/:messageId/vote`, so it is
 * this file's own convention rather than a rule invented at the port. Nothing
 * is written under either behaviour.
 *
 * NOTE the deliberate asymmetry with `source`, which is NOT checked here: an
 * unknown `source` still reaches the database and raises a check violation
 * (a 500). That tightening is `db/schema/aiChat.ts`'s documented decision and
 * `conversations.pgdb.test.ts` asserts it; changing where it is reported is a
 * separate call from this rewiring, so it is left alone and flagged.
 */
function isStorableMessage(
  msg: IncomingMessage & { role: string; content: MessageContent },
): msg is StorableMessage {
  return (
    isMessageRole(msg.role) &&
    (msg.vote === undefined || (typeof msg.vote === 'string' && isMessageVote(msg.vote)))
  );
}

/**
 * `createdAt` arrives as a JSON string, and Mongoose cast it. drizzle does not:
 * the column takes a `Date`, and postgres.js serialises an Invalid Date by
 * throwing, so an unparseable value must not reach the driver. It falls back to
 * now — which is what the old `m.createdAt || new Date()` did for an absent
 * one — rather than failing the whole batch for a timestamp nobody reads back
 * as anything but ordering.
 */
function toCreatedAt(value: string | number | undefined): Date {
  if (value === undefined) return new Date();
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? new Date() : parsed;
}

/**
 * The wire shape of a message.
 *
 * `id` is the CLIENT-supplied message id (`messages.messageId`), not the row's
 * uuidv7 primary key. That is not a detail: `PATCH /:id/messages/:messageId/vote`
 * matches on `messageId`, so emitting the primary key here would hand clients
 * an id that 404s on every vote — the quiet failure this port is meant to avoid.
 *
 * It is null for every message written by `lib/conversation-saver.ts`, which
 * inserts without one; those messages were never votable. The asymmetry is
 * pre-existing and is documented on the column itself.
 *
 * `_id` and `__v` are gone, per the clean cut. Every other field the old
 * `.lean()` documents carried is still here.
 */
function toWireMessage(row: typeof messagesTable.$inferSelect): Record<string, unknown> {
  return {
    id: row.messageId,
    conversationId: row.conversationId,
    oxyUserId: row.oxyUserId,
    role: row.role,
    content: row.content,
    vote: row.vote,
    toolInvocations: row.toolInvocations,
    agentInfo: row.agentInfo,
    audioUrl: row.audioUrl,
    createdAt: row.createdAt,
  };
}

// Create a new empty conversation
router.post('/new', authenticateToken, async (req: Request, res: Response) => {
  try {
    if (!req.user?.id) {
      return res.status(401).json({ error: 'Unauthorized' });
    }

    const conversationId = randomUUID();
    const { source = 'app', agentId } = req.body;

    const conversation = await createConversation({
      oxyUserId: req.user.id,
      conversationId,
      title: 'New chat',
      source,
      ...(agentId && { agentId }),
    });

    res.json({
      id: conversation.conversationId,
      title: conversation.title,
      source: conversation.source,
      agentId: conversation.agentId,
      createdAt: conversation.createdAt,
      updatedAt: conversation.updatedAt
    });
  } catch (error: unknown) {
    log.chat.error({ err: error }, 'Error creating conversation');
    res.status(500).json({ error: 'Failed to create conversation' });
  }
});

// Get all conversations for the authenticated user with cursor-based pagination
router.get('/', authenticateTokenOrApiKey, async (req: Request, res: Response) => {
  try {
    if (!req.user?.id) {
      return res.status(401).json({ error: 'Unauthorized' });
    }

    // Pagination parameters
    const limit = Math.min(parseInt(req.query.limit as string) || 20, 50); // Max 50 per request
    const cursor = req.query.cursor as string | undefined; // ISO date string

    // The extra row that decides `hasMore`, the slice and the next cursor all
    // live in the repository now; it reads one page down
    // `conversations_user_updated_idx`.
    const page = await listByUser({
      oxyUserId: req.user.id,
      limit,
      ...(cursor && { cursor: new Date(cursor) }),
    });

    res.json({
      conversations: page.conversations.map(c => ({
        id: c.conversationId,
        title: c.title,
        lastMessage: c.lastMessage,
        // `source` is NOT NULL with a default of 'app' and a CHECK that admits
        // no empty string, so the old `|| 'app'` fallback could not fire.
        source: c.source,
        agentId: c.agentId,
        createdAt: c.createdAt,
        updatedAt: c.updatedAt
      })),
      nextCursor: page.nextCursor ? page.nextCursor.toISOString() : null,
      hasMore: page.hasMore
    });
  } catch (error: unknown) {
    log.chat.error({ err: error }, 'Error fetching conversations');
    res.status(500).json({ error: 'Failed to fetch conversations' });
  }
});

// Get a specific conversation by ID
router.get('/:id', authenticateTokenOrApiKey, async (req: Request, res: Response) => {
  try {
    if (!req.user?.id) {
      return res.status(401).json({ error: 'Unauthorized' });
    }

    const oxyUserId = req.user.id;
    const params = idParams.parse(req.params);

    const conversation = await findByConversationId({
      oxyUserId,
      conversationId: params.id,
    });

    if (!conversation) {
      return res.status(404).json({ error: 'Conversation not found' });
    }

    // Load messages from the separate table, oldest first
    const rows = await listMessages({
      conversationId: params.id,
      oxyUserId,
    });

    res.json({
      id: conversation.conversationId,
      title: conversation.title,
      lastMessage: conversation.lastMessage,
      source: conversation.source,
      agentId: conversation.agentId,
      messages: rows.map(toWireMessage),
      createdAt: conversation.createdAt,
      updatedAt: conversation.updatedAt
    });
  } catch (error: unknown) {
    log.chat.error({ err: error }, 'Error fetching conversation');
    res.status(500).json({ error: 'Failed to fetch conversation' });
  }
});

// Save or update a conversation
router.post('/', authenticateTokenOrApiKey, async (req: Request, res: Response) => {
  try {
    if (!req.user?.id) {
      return res.status(401).json({ error: 'Unauthorized' });
    }

    const oxyUserId = req.user.id;
    const { conversationId, title, messages, source } = req.body;

    if (!conversationId || !messages || !Array.isArray(messages)) {
      return res.status(400).json({ error: 'Invalid request body' });
    }

    const present = (messages as IncomingMessage[]).filter(isPresentMessage);
    const validMessages = present.filter(isStorableMessage);
    if (validMessages.length !== present.length) {
      return res.status(400).json({ error: 'A message has an unsupported role or vote' });
    }

    /**
     * The preview text.
     *
     * `content` is either a string or the AI SDK's multi-part array. The old
     * code called `.slice(0, 100)` on it unconditionally, so an array content
     * produced an ARRAY of up to 100 parts, which Mongoose then cast to the
     * `String` path as `"[object Object],[object Object],…"`. Both that and
     * this are meaningless preview text for a multi-part message; this one is
     * at least bounded. A string content slices identically to before.
     */
    const lastMessage = validMessages.length > 0
      ? String(validMessages[validMessages.length - 1].content).slice(0, 100)
      : undefined;

    // Only overwrite title if explicitly provided (e.g. user rename). An
    // undefined `lastMessage` — reachable whenever the body carries no storable
    // message — must NOT be written: Mongo stripped it from `$set` and kept the
    // stored preview, and the repository's `buildSet` is what preserves that.
    const set = { lastMessage, ...(title && { title }) };

    /**
     * Fallback title, only on first insert and only when no explicit title was
     * given. Same array/string split as `lastMessage`: the old expression
     * yielded a truthy ARRAY for multi-part content and stored `"[object
     * Object]"` as the conversation's title — and an EMPTY array, also truthy,
     * stored an empty title. Both now fall through to 'New chat'.
     */
    const firstUserContent = validMessages.find((m) => m.role === 'user')?.content;
    const fallbackTitle =
      typeof firstUserContent === 'string' && firstUserContent.length > 0
        ? firstUserContent.slice(0, 50)
        : 'New chat';

    // Only set source on insert (don't change source of existing conversations)
    const setOnInsert = {
      ...(source && { source }),
      ...(!title && { title: fallbackTitle }),
    };

    const rows: MessageInput[] = validMessages.map((m) => ({
      conversationId,
      oxyUserId,
      ...(m.id !== undefined && { messageId: m.id }),
      role: m.role,
      content: m.content,
      ...(m.vote !== undefined && { vote: m.vote }),
      ...(m.toolInvocations !== undefined && { toolInvocations: m.toolInvocations }),
      ...(m.agentInfo !== undefined && { agentInfo: m.agentInfo }),
      ...(m.audioUrl !== undefined && { audioUrl: m.audioUrl }),
      createdAt: toCreatedAt(m.createdAt),
    }));

    /**
     * The conversation metadata and the message history are ONE logical write.
     *
     * The old code ran them in a `Promise.all`, which made them concurrent and
     * never made them atomic: the delete and the insert were two independent
     * round trips, so a crash or a statement timeout between them left the
     * conversation with NO messages, permanently, with nothing logged.
     * `replaceForConversation` refuses to run outside a transaction for exactly
     * that reason, and the upsert joins it so a failed message write cannot
     * leave the preview text describing a history that was never stored.
     */
    const conversation = await getDb().transaction(async (tx) => {
      const row = await upsertConversation(
        { oxyUserId, conversationId, set, setOnInsert },
        tx,
      );
      await replaceMessages({ conversationId, oxyUserId }, rows, tx);
      return row;
    });

    res.json({
      id: conversation.conversationId,
      title: conversation.title,
      lastMessage: conversation.lastMessage,
      source: conversation.source,
      createdAt: conversation.createdAt,
      updatedAt: conversation.updatedAt
    });
  } catch (error: unknown) {
    log.chat.error({ err: error }, 'Error saving conversation');
    res.status(500).json({ error: 'Failed to save conversation' });
  }
});

// Vote on a message (thumbs up/down)
router.patch('/:id/messages/:messageId/vote', authenticateToken, async (req: Request, res: Response) => {
  try {
    if (!req.user?.id) {
      return res.status(401).json({ error: 'Unauthorized' });
    }

    const { vote } = req.body;
    if (vote !== 'up' && vote !== 'down' && vote !== null) {
      return res.status(400).json({ error: 'vote must be "up", "down", or null' });
    }

    // `null` clears the vote — Mongo's `$unset`. An absent field and a NULL
    // column are the same absence.
    const params = messageParams.parse(req.params);
    const result = await setVote(
      {
        conversationId: params.id,
        messageId: params.messageId,
        oxyUserId: req.user.id,
      },
      vote,
    );

    if (!result) {
      return res.status(404).json({ error: 'Message not found' });
    }

    res.json({ success: true, vote: result.vote ?? null });
  } catch (error: unknown) {
    log.chat.error({ err: error }, 'Error voting on message');
    res.status(500).json({ error: 'Failed to vote on message' });
  }
});

// Delete a conversation
router.delete('/:id', authenticateToken, async (req: Request, res: Response) => {
  try {
    if (!req.user?.id) {
      return res.status(401).json({ error: 'Unauthorized' });
    }

    /**
     * Both deletes commit together. There is no foreign key between the two
     * tables — `messages.conversationId` holds the client-facing id, not the
     * conversation row's primary key — so nothing cascades on its own, and a
     * conversation delete that succeeded while the message delete failed would
     * strand every message of a conversation no longer reachable to delete
     * them by.
     *
     * The messages are removed whether or not the conversation existed, which
     * is what the old `Promise.all` did; the 404 is still decided by the
     * conversation's own count, after the transaction commits.
     */
    const oxyUserId = req.user.id;
    const params = idParams.parse(req.params);
    const deletedConversations = await getDb().transaction(async (tx) => {
      const count = await deleteConversation(
        { oxyUserId, conversationId: params.id },
        tx,
      );
      await deleteMessages({ oxyUserId, conversationId: params.id }, tx);
      return count;
    });

    if (deletedConversations === 0) {
      return res.status(404).json({ error: 'Conversation not found' });
    }

    res.json({ success: true });
  } catch (error: unknown) {
    log.chat.error({ err: error }, 'Error deleting conversation');
    res.status(500).json({ error: 'Failed to delete conversation' });
  }
});

export default router;
