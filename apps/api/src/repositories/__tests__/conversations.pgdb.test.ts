import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { and, eq } from 'drizzle-orm';
import { constraintNameOf, isCheckViolation, isUniqueViolation } from '@oxyhq/db';
import { conversations } from '../../db/schema/aiChat.js';
import * as repo from '../conversations.js';
import { scopedIds, setupPgDatabase, teardownPgDatabase } from './pgdb.js';
import type { StationDatabase } from '../../db/client.js';

const ids = scopedIds('conv');
let db: StationDatabase;

beforeAll(async () => {
  db = await setupPgDatabase();
});

afterAll(async () => {
  await teardownPgDatabase();
});

describe('conversations repository', () => {
  it('creates a conversation and applies the column defaults', async () => {
    const row = await repo.create({
      oxyUserId: ids.user('create'),
      conversationId: ids.conversation('create'),
    });

    expect(row.title).toBe('New chat');
    expect(row.source).toBe('app');
    expect(row.isManualTitle).toBe(false);
    expect(row.isFavorite).toBe(false);
    expect(row.isPublic).toBe(false);
    expect(row.agentId).toBeNull();
    expect(row.lastMessage).toBeNull();
  });

  /**
   * The ObjectId → text divergence. Under Mongoose this id threw a CastError
   * before reaching the database; if the column were anything narrower than
   * text the same value would fail here too. `workspaces.ownerId` makes the
   * same promise about Oxy ids and this is where it is checked for this domain.
   */
  it('accepts an Oxy user id that is not a 24-character ObjectId', async () => {
    const oxyUserId = ids.user('not-an-objectid');
    expect(oxyUserId).not.toMatch(/^[0-9a-f]{24}$/);

    const conversationId = ids.conversation('opaque');
    await repo.create({ oxyUserId, conversationId });

    const found = await repo.findByConversationId({ oxyUserId, conversationId });
    expect(found?.oxyUserId).toBe(oxyUserId);
  });

  it('scopes reads to the owning user', async () => {
    const conversationId = ids.conversation('scoped');
    await repo.create({ oxyUserId: ids.user('owner'), conversationId });

    const asOwner = await repo.findByConversationId({
      oxyUserId: ids.user('owner'),
      conversationId,
    });
    const asStranger = await repo.findByConversationId({
      oxyUserId: ids.user('stranger'),
      conversationId,
    });

    expect(asOwner).not.toBeNull();
    expect(asStranger).toBeNull();
  });

  it('rejects a second conversation with the same id for one user', async () => {
    const oxyUserId = ids.user('dup');
    const conversationId = ids.conversation('dup');
    await repo.create({ oxyUserId, conversationId });

    const error = await repo.create({ oxyUserId, conversationId }).catch((e: unknown) => e);
    expect(isUniqueViolation(error)).toBe(true);
    expect(constraintNameOf(error)).toBe('conversations_user_conversation_key');
  });

  it('lets two different users hold the same conversation id', async () => {
    const conversationId = ids.conversation('shared');
    await repo.create({ oxyUserId: ids.user('a'), conversationId });
    await expect(
      repo.create({ oxyUserId: ids.user('b'), conversationId }),
    ).resolves.toMatchObject({ conversationId });
  });

  describe('source CHECK — the deliberate tightening', () => {
    it('accepts every source the Mongoose enum listed', async () => {
      const sources = ['app', 'telegram', 'api', 'web', 'discord', 'whatsapp', 'slack'] as const;
      for (const source of sources) {
        const row = await repo.create({
          oxyUserId: ids.user('source'),
          conversationId: ids.conversation(`source-${source}`),
          source,
        });
        expect(row.source).toBe(source);
      }
    });

    /**
     * `routes/conversations.ts:169` puts an unvalidated `req.body.source` into
     * `$setOnInsert`, where Mongoose runs no validators — so this value is
     * storable today and is not after the port. Asserting the SQLSTATE and the
     * constraint NAME, because "the write failed" is also what a broken
     * connection, a missing column and a violated NOT NULL look like.
     */
    it('refuses a source outside the enum, on the upsert path Mongo left open', async () => {
      const error = await repo
        .upsert({
          oxyUserId: ids.user('bad-source'),
          conversationId: ids.conversation('bad-source'),
          set: {},
          setOnInsert: { source: 'bogus' as 'app' },
        })
        .catch((e: unknown) => e);

      expect(isCheckViolation(error)).toBe(true);
      expect(constraintNameOf(error)).toBe('conversations_source');
    });
  });

  describe('upsert', () => {
    it('inserts when absent, applying both set and setOnInsert', async () => {
      const key = { oxyUserId: ids.user('upsert'), conversationId: ids.conversation('insert') };
      const row = await repo.upsert({
        ...key,
        set: { lastMessage: 'hello' },
        setOnInsert: { title: 'From insert', source: 'web', agentId: 'agent-7' },
      });

      expect(row.title).toBe('From insert');
      expect(row.source).toBe('web');
      expect(row.agentId).toBe('agent-7');
      expect(row.lastMessage).toBe('hello');
    });

    it('updates only the set fields when the row exists, leaving setOnInsert alone', async () => {
      const key = { oxyUserId: ids.user('upsert'), conversationId: ids.conversation('update') };
      await repo.upsert({
        ...key,
        set: { lastMessage: 'first' },
        setOnInsert: { title: 'Original', source: 'web' },
      });

      const row = await repo.upsert({
        ...key,
        set: { lastMessage: 'second' },
        setOnInsert: { title: 'Ignored', source: 'telegram' },
      });

      expect(row.lastMessage).toBe('second');
      expect(row.title).toBe('Original');
      expect(row.source).toBe('web');
    });

    /**
     * THE divergence this repository exists to contain.
     *
     * `routes/conversations.ts:154` yields `lastMessage: undefined` whenever a
     * save carries no valid messages. In Mongo that key is stripped from `$set`
     * and the stored preview survives; a direct translation writes NULL and
     * erases it. `buildSet` is the only thing preventing that, so the test
     * drives the repository — not a hand-built statement — and would fail if
     * anyone simplified `buildSet` into a spread.
     */
    it('does not erase a stored value when its set key is undefined', async () => {
      const key = { oxyUserId: ids.user('undef'), conversationId: ids.conversation('undef') };
      await repo.upsert({ ...key, set: { lastMessage: 'keep me' }, setOnInsert: {} });

      const row = await repo.upsert({
        ...key,
        set: { lastMessage: undefined, title: undefined },
        setOnInsert: {},
      });

      expect(row.lastMessage).toBe('keep me');
      expect(row.title).toBe('New chat');
    });

    /**
     * The case that caught the real bug. An empty `set` is reachable from
     * `routes/conversations.ts:159`, and drizzle's `mapUpdateSet` throws
     * `Error: No values to set` on an empty object — before the `$onUpdate` on
     * `updatedAt` contributes anything, so the column that looks like it keeps
     * this clause non-empty does not. The explicit `updatedAt` in `upsert` is
     * what makes this pass; deleting it turns every empty-set upsert into a
     * thrown error rather than a returned row.
     */
    it('returns the existing row when set is empty', async () => {
      const key = { oxyUserId: ids.user('empty'), conversationId: ids.conversation('empty') };
      await repo.upsert({ ...key, set: {}, setOnInsert: { title: 'Only once' } });

      const row = await repo.upsert({ ...key, set: {}, setOnInsert: { title: 'Not this' } });
      expect(row.title).toBe('Only once');
    });

    it('bumps updatedAt on the update branch', async () => {
      const key = { oxyUserId: ids.user('bump'), conversationId: ids.conversation('bump') };
      const inserted = await repo.upsert({ ...key, set: {}, setOnInsert: {} });
      await new Promise((resolve) => setTimeout(resolve, 5));
      const updated = await repo.upsert({ ...key, set: { lastMessage: 'x' }, setOnInsert: {} });

      expect(updated.updatedAt.getTime()).toBeGreaterThan(inserted.updatedAt.getTime());
      expect(updated.id).toBe(inserted.id);
    });
  });

  describe('listByUser', () => {
    /**
     * uuidv7 is not monotonic within a millisecond, so nothing may infer order
     * from an id. These rows carry explicit `updatedAt` values written straight
     * to the table, which is also the only way to test a DESC ordering without
     * sleeping between inserts.
     */
    const seedUser = ids.user('list');

    beforeAll(async () => {
      const base = Date.UTC(2026, 0, 1, 12, 0, 0);
      for (let i = 0; i < 5; i++) {
        await db.insert(conversations).values({
          oxyUserId: seedUser,
          conversationId: ids.conversation(`list-${i}`),
          title: `Conversation ${i}`,
          updatedAt: new Date(base + i * 60_000),
        });
      }
      // A row belonging to somebody else, at a time interleaved with the above:
      // if the query forgot its user filter, it would land mid-page.
      await db.insert(conversations).values({
        oxyUserId: ids.user('list-other'),
        conversationId: ids.conversation('list-other'),
        updatedAt: new Date(base + 30_000),
      });
    });

    it('returns one user\'s conversations newest first', async () => {
      const page = await repo.listByUser({ oxyUserId: seedUser, limit: 10 });

      expect(page.conversations).toHaveLength(5);
      expect(page.hasMore).toBe(false);
      expect(page.nextCursor).toBeNull();
      expect(page.conversations.map((c) => c.title)).toEqual([
        'Conversation 4',
        'Conversation 3',
        'Conversation 2',
        'Conversation 1',
        'Conversation 0',
      ]);
    });

    it('pages with the cursor without repeating or dropping a row', async () => {
      const first = await repo.listByUser({ oxyUserId: seedUser, limit: 2 });
      expect(first.hasMore).toBe(true);
      expect(first.nextCursor).not.toBeNull();

      const second = await repo.listByUser({
        oxyUserId: seedUser,
        limit: 2,
        cursor: first.nextCursor ?? undefined,
      });
      const third = await repo.listByUser({
        oxyUserId: seedUser,
        limit: 2,
        cursor: second.nextCursor ?? undefined,
      });

      const seen = [...first.conversations, ...second.conversations, ...third.conversations];
      expect(seen.map((c) => c.title)).toEqual([
        'Conversation 4',
        'Conversation 3',
        'Conversation 2',
        'Conversation 1',
        'Conversation 0',
      ]);
      expect(third.hasMore).toBe(false);
      expect(new Set(seen.map((c) => c.conversationId)).size).toBe(5);
    });

    /**
     * The extra row that decides `hasMore` must not reach the caller. Without
     * the slice this returns 3 for a limit of 2 — a bug whose only symptom is a
     * page one item too long.
     */
    it('never returns more rows than the limit', async () => {
      const page = await repo.listByUser({ oxyUserId: seedUser, limit: 2 });
      expect(page.conversations).toHaveLength(2);
    });

    it('projects exactly the columns the route sends on the wire', async () => {
      const page = await repo.listByUser({ oxyUserId: seedUser, limit: 1 });
      expect(Object.keys(page.conversations[0]).sort()).toEqual([
        'agentId',
        'conversationId',
        'createdAt',
        'lastMessage',
        'source',
        'title',
        'updatedAt',
      ]);
    });
  });

  describe('updateTitle', () => {
    it('writes the title and reports one matched row', async () => {
      const key = { oxyUserId: ids.user('title'), conversationId: ids.conversation('title') };
      await repo.create(key);

      expect(await repo.updateTitle(key, 'Renamed')).toBe(1);
      expect((await repo.findByConversationId(key))?.title).toBe('Renamed');
    });

    /**
     * Postgres reports matched rows, not modified ones. Writing the same title
     * twice returns 1 both times where Mongo's `modifiedCount` would say 0 —
     * and a single call cannot tell the two semantics apart, so the assertion
     * needs the repeat.
     */
    it('reports matchedCount semantics, not modifiedCount, on a repeated write', async () => {
      const key = { oxyUserId: ids.user('same'), conversationId: ids.conversation('same') };
      await repo.create(key);

      expect(await repo.updateTitle(key, 'Same')).toBe(1);
      expect(await repo.updateTitle(key, 'Same')).toBe(1);
    });

    it('reports zero when nothing matches', async () => {
      expect(
        await repo.updateTitle({
          oxyUserId: ids.user('absent'),
          conversationId: ids.conversation('absent'),
        }, 'x'),
      ).toBe(0);
    });
  });

  describe('deleteForUser', () => {
    it('deletes the row and reports the count the 404 depends on', async () => {
      const key = { oxyUserId: ids.user('del'), conversationId: ids.conversation('del') };
      await repo.create(key);

      expect(await repo.deleteForUser(key)).toBe(1);
      expect(await repo.findByConversationId(key)).toBeNull();
      expect(await repo.deleteForUser(key)).toBe(0);
    });

    it('will not delete another user\'s conversation', async () => {
      const conversationId = ids.conversation('del-scope');
      await repo.create({ oxyUserId: ids.user('del-owner'), conversationId });

      expect(
        await repo.deleteForUser({ oxyUserId: ids.user('del-stranger'), conversationId }),
      ).toBe(0);
      const survivors = await db
        .select()
        .from(conversations)
        .where(
          and(
            eq(conversations.oxyUserId, ids.user('del-owner')),
            eq(conversations.conversationId, conversationId),
          ),
        );
      expect(survivors).toHaveLength(1);
    });
  });

  describe('existsForUser', () => {
    it('is true only for the owner', async () => {
      const conversationId = ids.conversation('exists');
      await repo.create({ oxyUserId: ids.user('exists'), conversationId });

      expect(await repo.existsForUser({ oxyUserId: ids.user('exists'), conversationId })).toBe(true);
      expect(await repo.existsForUser({ oxyUserId: ids.user('nobody'), conversationId })).toBe(false);
    });
  });
});
