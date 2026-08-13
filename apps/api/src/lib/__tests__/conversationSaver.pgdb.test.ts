/**
 * `lib/conversation-saver.ts` against a real PostgreSQL 17.
 * Run by `bun run test:pgdb`.
 *
 * This is the save path for every chat completion, and it has no HTTP surface
 * and no caller that inspects its result — `saveConversationResult` in
 * `lib/chat-lifecycle.ts` catches whatever it throws and writes a log line. So
 * every failure here is silent by construction, which is exactly why it needs
 * real-database coverage rather than a mock of the repositories.
 *
 * `chat-core.js` is mocked because `generateTitle` reaches a model provider
 * through it. Nothing else is: the repositories, drizzle, the driver and
 * Postgres are all real.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { and, eq } from 'drizzle-orm';
import { randomUUID } from 'node:crypto';
import {
  closeTestDb,
  getTestDb,
  testDatabaseUrl,
  testScope,
  type TestDatabase,
} from '../../db/__tests__/testDatabase.js';
import { conversations, messages } from '../../db/schema/aiChat.js';
import { closeDb } from '../../db/client.js';

const generateTextMock = vi.hoisted(() => vi.fn());

vi.mock('ai', () => ({ generateText: generateTextMock }));

vi.mock('../chat-core.js', () => ({
  resolveModel: vi.fn().mockResolvedValue({ keyConfig: { provider: 'test' } }),
  getAIModel: vi.fn(() => ({})),
}));

vi.mock('../logger.js', () => ({
  log: { chat: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } },
}));

const { generateConversationTitle, saveConversation } = await import('../conversation-saver.js');

let db: TestDatabase;
let userId: string;
let previousDatabaseUrl: string | undefined;

async function storedConversation(conversationId: string) {
  const [row] = await db
    .select()
    .from(conversations)
    .where(
      and(
        eq(conversations.oxyUserId, userId),
        eq(conversations.conversationId, conversationId),
      ),
    );
  return row;
}

async function storedMessages(conversationId: string) {
  return db
    .select()
    .from(messages)
    .where(and(eq(messages.oxyUserId, userId), eq(messages.conversationId, conversationId)));
}

beforeAll(async () => {
  db = await getTestDb();
  previousDatabaseUrl = process.env.DATABASE_URL;
  process.env.DATABASE_URL = testDatabaseUrl();
  userId = `user-${testScope('conv-saver')}`;
});

afterAll(async () => {
  await closeDb();
  await closeTestDb();
  if (previousDatabaseUrl === undefined) {
    delete process.env.DATABASE_URL;
  } else {
    process.env.DATABASE_URL = previousDatabaseUrl;
  }
});

beforeEach(() => {
  generateTextMock.mockReset();
});

describe('saveConversation', () => {
  it('stores the exchange and the assistant reply', async () => {
    const conversationId = randomUUID();
    await saveConversation({
      userId,
      conversationId,
      messages: [{ role: 'user', content: 'what is a hedgehog' }],
      assistantResponse: 'A small spiny mammal.',
    });

    const stored = await storedMessages(conversationId);
    expect(stored.map((m) => m.role)).toEqual(['user', 'assistant']);
    expect(stored[1].content).toBe('A small spiny mammal.');
    expect((await storedConversation(conversationId)).lastMessage).toBe('A small spiny mammal.');
  });

  /**
   * The regression this file exists for.
   *
   * These messages come straight from an OpenAI-format request body, where a
   * tool RESULT carries `role: "tool"` — `lib/message-converter.ts` has a
   * branch for exactly that — and the stored enum is user/assistant/system.
   * `ChatMessage.role` is declared `string`, so nothing in the type system
   * objects.
   *
   * Mongo's `insertMany(..., { ordered: false })` skipped the offending rows,
   * inserted the rest and threw; the throw was swallowed, so the conversation
   * was saved without its tool rows. The repository's `insertMany` is
   * all-or-nothing, so letting a `tool` row reach it would abort the
   * transaction and lose the ENTIRE exchange — silently, on every conversation
   * that used a tool. The filter in `saveConversation` is what stands between
   * those two outcomes.
   */
  it('drops a tool-role message instead of losing the whole exchange', async () => {
    const conversationId = randomUUID();
    await saveConversation({
      userId,
      conversationId,
      messages: [
        { role: 'user', content: 'weather?' },
        { role: 'assistant', content: 'checking' },
        { role: 'tool', content: '{"temp":12}' },
      ],
      assistantResponse: 'It is 12 degrees.',
    });

    const stored = await storedMessages(conversationId);
    // The tool row is gone and everything else survived. An empty list here is
    // the failure being guarded against, so the roles are asserted exactly
    // rather than by a count.
    expect(stored.map((m) => m.role)).toEqual(['user', 'assistant', 'assistant']);
    expect(stored.map((m) => m.content)).toEqual([
      'weather?',
      'checking',
      'It is 12 degrees.',
    ]);
  });

  it('replaces the history rather than appending to it', async () => {
    const conversationId = randomUUID();
    await saveConversation({
      userId,
      conversationId,
      messages: [{ role: 'user', content: 'first' }],
      assistantResponse: 'reply one',
    });
    await saveConversation({
      userId,
      conversationId,
      messages: [
        { role: 'user', content: 'first' },
        { role: 'assistant', content: 'reply one' },
        { role: 'user', content: 'second' },
      ],
      assistantResponse: 'reply two',
    });

    const stored = await storedMessages(conversationId);
    expect(stored).toHaveLength(4);
    expect(stored.at(-1)?.content).toBe('reply two');
  });

  it('sets title and source on insert only', async () => {
    const conversationId = randomUUID();
    await saveConversation({
      userId,
      conversationId,
      messages: [{ role: 'user', content: 'the first question' }],
      assistantResponse: 'an answer',
      source: 'telegram',
    });
    const first = await storedConversation(conversationId);
    expect(first.source).toBe('telegram');
    expect(first.title).toBe('the first question');

    await saveConversation({
      userId,
      conversationId,
      messages: [{ role: 'user', content: 'a later question' }],
      assistantResponse: 'another answer',
      source: 'app',
    });
    const second = await storedConversation(conversationId);
    expect(second.source).toBe('telegram');
    expect(second.title).toBe('the first question');
  });

  it('strips the title tag out of the stored reply and the preview', async () => {
    const conversationId = randomUUID();
    await saveConversation({
      userId,
      conversationId,
      messages: [{ role: 'user', content: 'hello' }],
      assistantResponse: '[TITLE]Greeting[/TITLE]Hello there.',
    });
    const stored = await storedMessages(conversationId);
    expect(stored.at(-1)?.content).toBe('Hello there.');
    const conv = await storedConversation(conversationId);
    expect(conv.lastMessage).toBe('Hello there.');
    expect(conv.title).toBe('Greeting');
  });

  it('carries agent messages in before the final reply', async () => {
    const conversationId = randomUUID();
    const agentInfo = { id: 'a1', name: 'Helper', avatar: null, handle: 'helper' };
    await saveConversation({
      userId,
      conversationId,
      messages: [{ role: 'user', content: 'delegate this' }],
      assistantResponse: 'done',
      agentMessages: [{ role: 'assistant', content: 'working on it', agentInfo }],
    });

    const stored = await storedMessages(conversationId);
    expect(stored.map((m) => m.content)).toEqual(['delegate this', 'working on it', 'done']);
    expect(stored[1].agentInfo).toEqual(agentInfo);
  });
});

describe('generateConversationTitle', () => {
  /** Seed a conversation with `count` stored messages. */
  async function seed(conversationId: string, count: number, isManualTitle = false) {
    await db.insert(conversations).values({
      oxyUserId: userId,
      conversationId,
      title: 'New chat',
      isManualTitle,
    });
    if (count > 0) {
      await db.insert(messages).values(
        Array.from({ length: count }, (_, i) => ({
          conversationId,
          oxyUserId: userId,
          role: 'user' as const,
          content: `m${i}`,
        })),
      );
    }
  }

  it('writes the generated title', async () => {
    const conversationId = randomUUID();
    await seed(conversationId, 2);
    generateTextMock.mockResolvedValue({ text: 'Hedgehog facts' });

    await generateConversationTitle(userId, conversationId, 'tell me about hedgehogs');
    expect((await storedConversation(conversationId)).title).toBe('Hedgehog facts');
  });

  it('leaves a manually titled conversation alone', async () => {
    const conversationId = randomUUID();
    await seed(conversationId, 1, true);
    generateTextMock.mockResolvedValue({ text: 'Should not land' });

    await generateConversationTitle(userId, conversationId, 'anything');
    expect((await storedConversation(conversationId)).title).toBe('New chat');
    expect(generateTextMock).not.toHaveBeenCalled();
  });

  /**
   * The `messageCount > 3` gate, with the string-comparison hazard underneath
   * it: Postgres returns `count(*)` as `bigint`, which postgres.js decodes as a
   * STRING while drizzle types it `number`. An unmapped count would make this
   * `'10' > 3`, which is false — so a long conversation would be re-titled on
   * every turn. Four messages is the smallest case that separates the two, and
   * ten is the case where the string comparison flips the answer.
   */
  it('does not re-title a conversation that is already under way', async () => {
    const conversationId = randomUUID();
    await seed(conversationId, 4);
    generateTextMock.mockResolvedValue({ text: 'Too late' });

    await generateConversationTitle(userId, conversationId, 'anything');
    expect((await storedConversation(conversationId)).title).toBe('New chat');
    expect(generateTextMock).not.toHaveBeenCalled();
  });

  it('does not re-title a ten-message conversation either', async () => {
    const conversationId = randomUUID();
    await seed(conversationId, 10);
    generateTextMock.mockResolvedValue({ text: 'Too late' });

    await generateConversationTitle(userId, conversationId, 'anything');
    expect((await storedConversation(conversationId)).title).toBe('New chat');
  });

  it('does nothing when the conversation does not exist', async () => {
    generateTextMock.mockResolvedValue({ text: 'nope' });
    await generateConversationTitle(userId, randomUUID(), 'anything');
    expect(generateTextMock).not.toHaveBeenCalled();
  });
});
