/**
 * Conversation Saver
 * Shared utility for extracting titles and persisting conversations.
 * Used by both the internal chat endpoint and the v1/chat-completions endpoint.
 */

import { generateText } from 'ai';
import { getDb } from '../db/client.js';
import {
  findByConversationId,
  updateTitle,
  upsert as upsertConversation,
} from '../repositories/conversations.js';
import {
  countForConversation,
  replaceForConversation as replaceMessages,
  type MessageInput,
} from '../repositories/messages.js';
import { MESSAGE_ROLES, type ConversationSource, type MessageRole } from '../db/schema/aiChat.js';
import { resolveModel, getAIModel } from './chat-core.js';
import { log } from './logger.js';

/** One assembled message, before the stored-role filter narrows it. */
interface AssembledMessage {
  role: string;
  content: MessageInput['content'];
  toolInvocations?: MessageInput['toolInvocations'];
  agentInfo?: MessageInput['agentInfo'];
}

/**
 * `role` is `string` all the way from the request body — `ChatMessage.role` is
 * declared `string` precisely because OpenAI-format bodies carry roles this
 * schema does not store. This is the only place it becomes a `MessageRole`.
 */
function isStorableRole(msg: AssembledMessage): msg is AssembledMessage & { role: MessageRole } {
  return (MESSAGE_ROLES as readonly string[]).includes(msg.role);
}

// Known translations of "TITLE" that LLMs may produce
const TAG = String.raw`CLARITY_TITLE|TITLE|TÍTULO|TITRE|TITOLO|TITEL|ЗАГОЛОВОК`;
const TITLE_EXTRACT_RE = new RegExp(String.raw`\[(${TAG})\](.*?)\[\/\1\]|<(${TAG})>(.*?)<\/\3>`, 'i');
const TITLE_STRIP_RE = new RegExp(String.raw`\[(${TAG})\].*?\[\/\1\]|<(${TAG})>.*?<\/\2>`, 'gi');

/** Extract or generate a conversation title from the AI response, with fallbacks. */
export function extractConversationTitle(response: string, messages: any[]): string {
  const m = response.match(TITLE_EXTRACT_RE);
  if (m) return (m[2] || m[4]).trim();

  // Prefer the first user message (most descriptive of conversation topic)
  const firstUserMsg = messages.find((msg: any) => msg.role === 'user')?.content;
  if (typeof firstUserMsg === 'string' && firstUserMsg.length > 0) return firstUserMsg.slice(0, 60);

  // Fallback: first ~6 words of cleaned response
  const cleaned = response.replace(/\[.*?\]|<.*?>|[#*_`]/g, '').trim();
  if (cleaned.length >= 10) return cleaned.split(/\s+/).slice(0, 6).join(' ');

  return 'New chat';
}

/** Remove [TITLE]...[/TITLE] and <TITLE>...</TITLE> tags from content. */
export function stripTitleTags(content: string): string {
  return content.replace(TITLE_STRIP_RE, '').trim();
}

export interface SaveConversationParams {
  userId: string;
  conversationId: string;
  messages: any[];
  assistantResponse: string;
  toolInvocations?: any[];
  source?: ConversationSource;
  agentId?: string;
  agentMessages?: Array<{ role: 'assistant'; content: string; agentInfo: { id: string; name: string; avatar: string | null; handle: string } }>;
}

/**
 * Save or update a conversation in the database.
 * Handles title extraction, tag stripping, and message assembly.
 */
export async function saveConversation(params: SaveConversationParams): Promise<void> {
  const { userId, conversationId, messages, assistantResponse, toolInvocations, source, agentId, agentMessages } = params;

  const allMessages: AssembledMessage[] = [
    ...messages.filter(m => m && m.role).map((m: any) => ({
      role: m.role,
      content: m.content,
      toolInvocations: m.toolInvocations,
    })),
    // Insert agent messages before the final assistant response
    ...(agentMessages || []).map(am => ({
      role: am.role,
      content: am.content,
      agentInfo: am.agentInfo,
    })),
    {
      role: 'assistant',
      content: stripTitleTags(assistantResponse),
      ...(toolInvocations && toolInvocations.length > 0 && { toolInvocations }),
    },
  ].filter(msg => msg != null && msg.role && msg.content !== undefined);

  /**
   * Messages the `messages_role` CHECK will not accept are DROPPED, not raised.
   *
   * This is reachable on every request that used a tool: these messages come
   * straight from an OpenAI-format request body, where a tool result carries
   * `role: "tool"` — `lib/message-converter.ts` has a branch for exactly that —
   * and the stored enum is only user/assistant/system.
   *
   * Dropping them is what Mongo did. `insertMany(..., { ordered: false })` ran
   * the enum validator, skipped the offending documents, inserted the rest and
   * then threw; the throw was swallowed by `saveConversationResult`, so the
   * observable outcome was "the conversation is saved without its tool rows,
   * and a line appears in the log".
   *
   * The repository's `insertMany` is all-or-nothing, so letting a `tool` row
   * reach it would abort the transaction and lose the ENTIRE exchange — the
   * user's message, the assistant's reply, everything — on any conversation
   * that used a tool, silently, because the caller only logs. That is a
   * regression the type system cannot see (`ChatMessage.role` is `string`) and
   * no existing test covers, so the filter is the load-bearing line here and
   * `conversationSaver.pgdb.test.ts` asserts it directly.
   */
  const storable = allMessages.filter(isStorableRole);
  if (storable.length !== allMessages.length) {
    log.chat.warn(
      { conversationId, dropped: allMessages.length - storable.length },
      'Dropped messages whose role is not stored',
    );
  }

  const title = extractConversationTitle(assistantResponse, messages);

  const rows: MessageInput[] = storable.map(m => ({
    conversationId,
    oxyUserId: userId,
    role: m.role,
    content: m.content,
    ...(m.toolInvocations ? { toolInvocations: m.toolInvocations } : {}),
    ...(m.agentInfo ? { agentInfo: m.agentInfo } : {}),
    createdAt: new Date(),
  }));

  /**
   * The metadata write and the message replacement share one transaction.
   *
   * They were two awaited round trips with a real gap between them: a crash or
   * a statement timeout after the DELETE left the conversation with its new
   * preview text and NO messages, permanently. `replaceForConversation` refuses
   * to run outside a transaction so that gap cannot be reintroduced by a caller
   * that simply forgets.
   */
  await getDb().transaction(async (tx) => {
    await upsertConversation(
      {
        oxyUserId: userId,
        conversationId,
        set: { lastMessage: stripTitleTags(assistantResponse).slice(0, 100) },
        setOnInsert: {
          title,
          source: source || 'app',
          ...(agentId && { agentId }),
        },
      },
      tx,
    );
    await replaceMessages({ conversationId, oxyUserId: userId }, rows, tx);
  });
}

/**
 * Generate a conversation title using a cheap model.
 * Returns the title string (or null on failure). Does NOT write to DB.
 * Can be called in parallel with the main LLM response since it only needs the user message.
 */
export async function generateTitle(userMessage: string): Promise<string | null> {
  const resolved = await resolveModel('clarity-fast');
  if (!resolved) {
    log.chat.warn('Title generation skipped: no model available for clarity-fast');
    return null;
  }

  try {
    const model = getAIModel(resolved.keyConfig);
    const result = await generateText({
      model,
      messages: [
        { role: 'system', content: 'Generate a concise conversation title (max 6 words) in the same language as the user message. Return ONLY the title, no quotes or trailing punctuation.' },
        { role: 'user', content: userMessage },
      ],
      maxOutputTokens: 30,
    });

    const title = result.text.trim().replace(/^["']|["']$/g, '').replace(/\.+$/, '');
    return (title.length > 0 && title.length < 100) ? title : null;
  } catch (err) {
    log.chat.error({ err }, 'Title generation LLM call failed');
    return null;
  }
}

/**
 * Generate a conversation title asynchronously and save it to DB.
 * Skips if the conversation already has a meaningful title or was manually titled.
 * Used as fire-and-forget fallback for non-streaming paths.
 */
export async function generateConversationTitle(
  userId: string,
  conversationId: string,
  userMessage: string,
): Promise<void> {
  try {
    const conv = await findByConversationId({ oxyUserId: userId, conversationId });
    if (!conv || conv.isManualTitle) return;
    // NOT scoped to the user, faithfully: the source `countDocuments` was not
    // either, and this count only gates whether a title is worth generating.
    // `count()` is mapped through `Number`, which matters: postgres.js decodes
    // `count(*)` as a STRING while drizzle types it `number`, so an unmapped
    // count would make this comparison `'10' > 3`, i.e. false.
    const messageCount = await countForConversation(conversationId);
    if (messageCount > 3) return;

    const title = await generateTitle(userMessage);
    if (title) {
      // `updateTitle` returns the number of rows MATCHED (Postgres reports only
      // `rowCount`); nothing here reads it, and nothing did before.
      await updateTitle({ oxyUserId: userId, conversationId }, title);
      log.chat.info({ conversationId, title }, 'Auto-generated conversation title');
    }
  } catch (err) {
    log.chat.error({ err, conversationId }, 'generateConversationTitle failed');
  }
}
