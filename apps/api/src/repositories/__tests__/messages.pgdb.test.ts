import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { constraintNameOf, isCheckViolation } from '@oxyhq/db';
import { messages } from '../../db/schema/aiChat.js';
import * as repo from '../messages.js';
import { scopedIds, setupPgDatabase, teardownPgDatabase } from './pgdb.js';
import type { StationDatabase } from '../../db/client.js';

const ids = scopedIds('msg');
let db: StationDatabase;

beforeAll(async () => {
  db = await setupPgDatabase();
});

afterAll(async () => {
  await teardownPgDatabase();
});

function message(conversationId: string, oxyUserId: string, overrides: Partial<repo.MessageInput> = {}): repo.MessageInput {
  return { conversationId, oxyUserId, role: 'user', content: 'hello', ...overrides };
}

describe('messages repository', () => {
  describe('content — the Mixed column', () => {
    it('round-trips a plain string as a string, not a one-element array', async () => {
      const conversationId = ids.conversation('content-string');
      const oxyUserId = ids.user('content');
      await repo.insertMany([message(conversationId, oxyUserId, { content: 'just text' })]);

      const [row] = await repo.listForConversation({ conversationId, oxyUserId });
      expect(row.content).toBe('just text');
      expect(typeof row.content).toBe('string');
    });

    it('round-trips the multi-part array shape', async () => {
      const conversationId = ids.conversation('content-array');
      const oxyUserId = ids.user('content');
      const content = [
        { type: 'text', text: 'look at this' },
        { type: 'image', image: 'https://example.invalid/a.png' },
      ];
      await repo.insertMany([message(conversationId, oxyUserId, { content })]);

      const [row] = await repo.listForConversation({ conversationId, oxyUserId });
      expect(row.content).toEqual(content);
    });

    it('preserves nested tool payloads verbatim', async () => {
      const conversationId = ids.conversation('tools');
      const oxyUserId = ids.user('tools');
      const toolInvocations = [
        {
          toolCallId: 'call-1',
          toolName: 'web_search',
          state: 'result' as const,
          args: { query: 'oxy', nested: { deep: [1, 2, { flag: true }] } },
          result: { hits: [{ url: 'https://example.invalid', score: 0.5 }] },
        },
      ];
      const agentInfo = { id: 'a-1', name: 'Helper', avatar: null, handle: 'helper' };
      await repo.insertMany([
        message(conversationId, oxyUserId, { role: 'assistant', toolInvocations, agentInfo }),
      ]);

      const [row] = await repo.listForConversation({ conversationId, oxyUserId });
      expect(row.toolInvocations).toEqual(toolInvocations);
      expect(row.agentInfo).toEqual(agentInfo);
    });
  });

  describe('CHECK constraints', () => {
    it('accepts every role the Mongoose enum listed', async () => {
      const conversationId = ids.conversation('roles');
      const oxyUserId = ids.user('roles');
      for (const role of ['user', 'assistant', 'system'] as const) {
        await expect(
          repo.insertMany([message(conversationId, oxyUserId, { role })]),
        ).resolves.toHaveLength(1);
      }
    });

    it('refuses a role outside the enum', async () => {
      const error = await repo
        .insertMany([
          message(ids.conversation('bad-role'), ids.user('bad'), { role: 'tool' as 'user' }),
        ])
        .catch((e: unknown) => e);

      expect(isCheckViolation(error)).toBe(true);
      expect(constraintNameOf(error)).toBe('messages_role');
    });

    /**
     * A CHECK rejects only FALSE, and `NULL in ('up','down')` is NULL — so an
     * unvoted message passes `messages_vote` with no predicate guarding it.
     * That is what makes the constraint safe on a nullable column, and it is
     * exactly the property that would break if someone "fixed" the CHECK by
     * wrapping it in a NOT NULL guard or made the column NOT NULL.
     */
    it('accepts a NULL vote, because a CHECK rejects only FALSE', async () => {
      const conversationId = ids.conversation('null-vote');
      const oxyUserId = ids.user('null-vote');
      await repo.insertMany([message(conversationId, oxyUserId)]);

      const [row] = await repo.listForConversation({ conversationId, oxyUserId });
      expect(row.vote).toBeNull();
    });

    it('refuses a vote outside the enum', async () => {
      const error = await repo
        .insertMany([
          message(ids.conversation('bad-vote'), ids.user('bad'), { vote: 'sideways' as 'up' }),
        ])
        .catch((e: unknown) => e);

      expect(isCheckViolation(error)).toBe(true);
      expect(constraintNameOf(error)).toBe('messages_vote');
    });
  });

  describe('insertMany', () => {
    it('is a no-op for an empty batch', async () => {
      await expect(repo.insertMany([])).resolves.toEqual([]);
    });

    /**
     * A heterogeneous batch: drizzle builds one statement from the union of the
     * rows' keys, so a row that omits a key the next row sets must take the
     * column default rather than shifting the values. Tidy fixtures where every
     * row has the same shape cannot catch that.
     */
    it('fills absent optional fields with NULL across a mixed batch', async () => {
      const conversationId = ids.conversation('mixed');
      const oxyUserId = ids.user('mixed');
      await repo.insertMany([
        message(conversationId, oxyUserId, { messageId: 'm-1', createdAt: new Date(1_700_000_000_000) }),
        message(conversationId, oxyUserId, {
          role: 'assistant',
          content: 'with extras',
          audioUrl: 'https://example.invalid/a.mp3',
          agentInfo: { id: 'a', name: 'A', avatar: null, handle: 'a' },
          createdAt: new Date(1_700_000_001_000),
        }),
      ]);

      const rows = await repo.listForConversation({ conversationId, oxyUserId });
      expect(rows).toHaveLength(2);
      expect(rows[0].messageId).toBe('m-1');
      expect(rows[0].audioUrl).toBeNull();
      expect(rows[0].agentInfo).toBeNull();
      expect(rows[1].messageId).toBeNull();
      expect(rows[1].audioUrl).toBe('https://example.invalid/a.mp3');
    });

    /**
     * The chosen divergence from `ordered: false`, asserted as a behaviour
     * rather than left in a comment: one bad row rejects the whole batch. If
     * this ever starts inserting the good rows, the delete that precedes it in
     * `replaceForConversation` has silently become a partial history loss.
     */
    it('inserts nothing at all when one row in the batch violates a CHECK', async () => {
      const conversationId = ids.conversation('atomic');
      const oxyUserId = ids.user('atomic');

      const error = await repo
        .insertMany([
          message(conversationId, oxyUserId, { content: 'good one' }),
          message(conversationId, oxyUserId, { role: 'nonsense' as 'user' }),
          message(conversationId, oxyUserId, { content: 'good two' }),
        ])
        .catch((e: unknown) => e);
      expect(isCheckViolation(error)).toBe(true);

      expect(await repo.listForConversation({ conversationId, oxyUserId })).toHaveLength(0);
    });
  });

  describe('listForConversation', () => {
    it('orders oldest first and excludes other users and conversations', async () => {
      const conversationId = ids.conversation('order');
      const oxyUserId = ids.user('order');
      const base = 1_700_000_000_000;

      await repo.insertMany([
        message(conversationId, oxyUserId, { content: 'third', createdAt: new Date(base + 2000) }),
        message(conversationId, oxyUserId, { content: 'first', createdAt: new Date(base) }),
        message(conversationId, oxyUserId, { content: 'second', createdAt: new Date(base + 1000) }),
        // Same conversation id, different user.
        message(conversationId, ids.user('order-other'), { content: 'not mine' }),
        // Same user, different conversation.
        message(ids.conversation('order-other'), oxyUserId, { content: 'elsewhere' }),
      ]);

      const rows = await repo.listForConversation({ conversationId, oxyUserId });
      expect(rows.map((r) => r.content)).toEqual(['first', 'second', 'third']);
    });
  });

  describe('setVote', () => {
    it('sets and then clears a vote, translating $unset to NULL', async () => {
      const conversationId = ids.conversation('vote');
      const oxyUserId = ids.user('vote');
      await repo.insertMany([message(conversationId, oxyUserId, { messageId: 'm-vote' })]);
      const key = { conversationId, messageId: 'm-vote', oxyUserId };

      expect((await repo.setVote(key, 'up'))?.vote).toBe('up');
      expect((await repo.setVote(key, 'down'))?.vote).toBe('down');
      expect((await repo.setVote(key, null))?.vote).toBeNull();
    });

    it('returns null — the route\'s 404 — when the message is another user\'s', async () => {
      const conversationId = ids.conversation('vote-scope');
      await repo.insertMany([
        message(conversationId, ids.user('vote-owner'), { messageId: 'm-scoped' }),
      ]);

      expect(
        await repo.setVote(
          { conversationId, messageId: 'm-scoped', oxyUserId: ids.user('vote-stranger') },
          'up',
        ),
      ).toBeNull();
    });

    it('returns null when the message id does not exist', async () => {
      expect(
        await repo.setVote(
          {
            conversationId: ids.conversation('vote-missing'),
            messageId: 'nope',
            oxyUserId: ids.user('vote'),
          },
          'up',
        ),
      ).toBeNull();
    });
  });

  describe('countForConversation', () => {
    /**
     * `count(*)` is a bigint, which postgres.js decodes as a STRING while
     * drizzle's types claim `number`. The caller at
     * `lib/conversation-saver.ts:159` does `messageCount > 3`, and `'10' > 3`
     * is false — so a title would silently stop being generated on exactly the
     * conversations long enough to need one. The typeof assertion is the whole
     * point; the numeric one alone passes against a string for small values.
     */
    it('returns a number, not the string a bigint decodes to', async () => {
      const conversationId = ids.conversation('count');
      const oxyUserId = ids.user('count');
      await repo.insertMany(
        Array.from({ length: 10 }, (_, i) =>
          message(conversationId, oxyUserId, { content: `m${i}` }),
        ),
      );

      const total = await repo.countForConversation(conversationId);
      expect(typeof total).toBe('number');
      expect(total).toBe(10);
      expect(total > 3).toBe(true);
    });

    it('is zero for a conversation with no messages', async () => {
      expect(await repo.countForConversation(ids.conversation('count-empty'))).toBe(0);
    });

    /**
     * Not user-scoped, faithfully to `countDocuments({ conversationId })`. The
     * assertion pins that on purpose: scoping it later would be a behaviour
     * change, and this is where somebody notices.
     */
    it('counts every user\'s messages in the conversation, as the source query did', async () => {
      const conversationId = ids.conversation('count-shared');
      await repo.insertMany([
        message(conversationId, ids.user('count-a')),
        message(conversationId, ids.user('count-b')),
      ]);

      expect(await repo.countForConversation(conversationId)).toBe(2);
    });
  });

  describe('existsForConversation', () => {
    it('distinguishes a conversation with messages from one without', async () => {
      const conversationId = ids.conversation('exists');
      expect(await repo.existsForConversation(conversationId)).toBe(false);

      await repo.insertMany([message(conversationId, ids.user('exists'))]);
      expect(await repo.existsForConversation(conversationId)).toBe(true);
    });
  });

  describe('deleteForConversation', () => {
    it('deletes only the given user\'s messages and reports the count', async () => {
      const conversationId = ids.conversation('delete');
      const oxyUserId = ids.user('delete');
      await repo.insertMany([
        message(conversationId, oxyUserId, { content: 'a' }),
        message(conversationId, oxyUserId, { content: 'b' }),
        message(conversationId, ids.user('delete-other'), { content: 'theirs' }),
      ]);

      expect(await repo.deleteForConversation({ conversationId, oxyUserId })).toBe(2);
      expect(await repo.listForConversation({ conversationId, oxyUserId })).toHaveLength(0);
      expect(
        await repo.listForConversation({ conversationId, oxyUserId: ids.user('delete-other') }),
      ).toHaveLength(1);
    });
  });

  describe('replaceForConversation', () => {
    it('replaces the history inside a transaction', async () => {
      const conversationId = ids.conversation('replace');
      const oxyUserId = ids.user('replace');
      await repo.insertMany([message(conversationId, oxyUserId, { content: 'old' })]);

      await db.transaction(async (tx) => {
        await repo.replaceForConversation(
          { conversationId, oxyUserId },
          [
            message(conversationId, oxyUserId, { content: 'new one' }),
            message(conversationId, oxyUserId, { content: 'new two' }),
          ],
          tx,
        );
      });

      const rows = await repo.listForConversation({ conversationId, oxyUserId });
      expect(rows.map((r) => r.content).sort()).toEqual(['new one', 'new two']);
    });

    /**
     * The reason the transaction is required. With the delete and the insert
     * running independently, a failing insert leaves the conversation with NO
     * messages and nothing errors afterwards — the state the Mongo code could
     * reach and this cannot.
     */
    it('leaves the old history intact when the new batch is rejected', async () => {
      const conversationId = ids.conversation('rollback');
      const oxyUserId = ids.user('rollback');
      await repo.insertMany([message(conversationId, oxyUserId, { content: 'survivor' })]);

      const error = await db
        .transaction(async (tx) => {
          await repo.replaceForConversation(
            { conversationId, oxyUserId },
            [message(conversationId, oxyUserId, { role: 'bogus' as 'user' })],
            tx,
          );
        })
        .catch((e: unknown) => e);
      expect(isCheckViolation(error)).toBe(true);

      const rows = await repo.listForConversation({ conversationId, oxyUserId });
      expect(rows.map((r) => r.content)).toEqual(['survivor']);
    });

    /**
     * `requireTransaction` is a RUNTIME check because a pool handle passed
     * where a transaction is expected type-checks. Without it the rollback test
     * above would still pass while production ran the pair unprotected.
     */
    it('refuses to run on a pool handle', async () => {
      const conversationId = ids.conversation('no-tx');
      const oxyUserId = ids.user('no-tx');
      await repo.insertMany([message(conversationId, oxyUserId, { content: 'still here' })]);

      await expect(
        repo.replaceForConversation({ conversationId, oxyUserId }, [], db),
      ).rejects.toThrow(/must run inside a transaction/);

      // The refusal happens BEFORE the delete, not after it.
      expect(await repo.listForConversation({ conversationId, oxyUserId })).toHaveLength(1);
    });
  });

  describe('messageId is the client id, not the row id', () => {
    it('keeps them distinct and lets two conversations reuse a client id', async () => {
      const oxyUserId = ids.user('ids');
      const a = ids.conversation('ids-a');
      const b = ids.conversation('ids-b');
      await repo.insertMany([
        message(a, oxyUserId, { messageId: 'shared-client-id' }),
        message(b, oxyUserId, { messageId: 'shared-client-id' }),
      ]);

      const [rowA] = await repo.listForConversation({ conversationId: a, oxyUserId });
      const [rowB] = await repo.listForConversation({ conversationId: b, oxyUserId });

      expect(rowA.messageId).toBe('shared-client-id');
      expect(rowB.messageId).toBe('shared-client-id');
      expect(rowA.id).not.toBe(rowB.id);
      expect(rowA.id).not.toBe(rowA.messageId);
    });
  });

  describe('schema shape', () => {
    /**
     * `models/message.ts` has no `timestamps: true`, so there is no `updatedAt`
     * to maintain. Asserted because adding one is the kind of tidy-up that
     * looks like a fix and invents a fact no writer keeps true.
     */
    it('has no updatedAt column', async () => {
      const conversationId = ids.conversation('shape');
      const oxyUserId = ids.user('shape');
      await repo.insertMany([message(conversationId, oxyUserId)]);
      const [row] = await db.select().from(messages).where(eq(messages.conversationId, conversationId));

      expect(Object.keys(row)).not.toContain('updatedAt');
      expect(row.createdAt).toBeInstanceOf(Date);
    });
  });
});
