/**
 * `routes/conversations.ts` driven over real HTTP against a real PostgreSQL 17.
 * Run by `bun run test:pgdb`.
 *
 * ## Why this exists as well as the repository suites
 *
 * `conversations.pgdb.test.ts` and `messages.pgdb.test.ts` cover the queries.
 * Nothing covers the WIRING — which repository function each handler calls,
 * with which arguments, and what it does with the answer. A handler that reads
 * `matched` where it meant `modified`, projects the wrong id, or drops a
 * transaction returns a well-formed 200 with plausible contents and passes
 * every gate the repositories have. That is the failure shape this file exists
 * for, and it is the shape the suite it replaces could not see at all: the old
 * `routes/__tests__/conversations.test.ts` mocked both Mongoose models and then
 * called the mocks directly, never importing the router, so it measured a
 * re-implementation of the handlers written in the test body.
 *
 * ## What is mocked, and what that costs
 *
 * Only `middleware/auth.ts`, because it calls Oxy. Everything below it —
 * routing, body parsing, the handlers, the repositories, drizzle, the driver,
 * Postgres — is real. So this file does NOT verify authentication; it verifies
 * what the handlers do once a user is through the door.
 *
 * Every row is scoped to an `oxyUserId` this file mints, because one database
 * is shared with every other `*.pgdb.test.ts`. Conversations hang off no
 * parent row, so the user id is the only thing that makes ownership scopable.
 */

import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import express from 'express';
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

/** The user every request in this file authenticates as. */
const ctx = vi.hoisted(() => ({ userId: '' }));

vi.mock('../../middleware/auth.js', () => {
  const attach = (req: express.Request, _res: express.Response, next: express.NextFunction) => {
    req.user = { id: ctx.userId };
    next();
  };
  return { authenticateToken: attach, authenticateTokenOrApiKey: attach };
});

vi.mock('../../lib/logger.js', () => ({
  log: { chat: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } },
}));

const { default: conversationsRouter } = await import('../conversations.js');

let db: TestDatabase;
let server: Server;
let base: string;
let previousDatabaseUrl: string | undefined;

interface ApiResponse {
  status: number;
  json: Record<string, never> & Record<string, unknown>;
  text: string;
}

async function api(method: string, path: string, body?: unknown): Promise<ApiResponse> {
  const res = await fetch(`${base}${path}`, {
    method,
    // `connection: close` so no keep-alive socket outlives `server.close()`.
    headers: { 'content-type': 'application/json', connection: 'close' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  const isJson = res.headers.get('content-type')?.includes('application/json') ?? false;
  return { status: res.status, json: isJson ? JSON.parse(text) : {}, text };
}

/** Rows as the database holds them, for the assertions the wire cannot make. */
async function storedConversation(conversationId: string) {
  const [row] = await db
    .select()
    .from(conversations)
    .where(
      and(
        eq(conversations.oxyUserId, ctx.userId),
        eq(conversations.conversationId, conversationId),
      ),
    );
  return row;
}

async function storedMessages(conversationId: string) {
  return db
    .select()
    .from(messages)
    .where(
      and(eq(messages.oxyUserId, ctx.userId), eq(messages.conversationId, conversationId)),
    );
}

beforeAll(async () => {
  db = await getTestDb();
  // `getDb()` opens its own pool from `DATABASE_URL`; point it at the same
  // database the harness applied the schema to. Restored in `afterAll` for the
  // reason `pagesBlocks.routes.pgdb.test.ts` sets out: `resolveHandle()` falls
  // back to `getDb()`, which throws while the variable is unset, so leaving it
  // set changes what a sibling file does. That file's comment claiming to be
  // the only opener of the application pool is now one file out of date —
  // this one opens it too, which is safe only because each closes it.
  previousDatabaseUrl = process.env.DATABASE_URL;
  process.env.DATABASE_URL = testDatabaseUrl();
  ctx.userId = `user-${testScope('conv-routes')}`;

  const app = express();
  app.use(express.json());
  app.use('/conversations', conversationsRouter);
  server = app.listen(0);
  await new Promise<void>((resolve) => server.once('listening', resolve));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(async () => {
  server.closeAllConnections();
  await new Promise<void>((resolve, reject) => {
    server.close((err) => (err ? reject(err) : resolve()));
  });
  await closeDb();
  await closeTestDb();
  if (previousDatabaseUrl === undefined) {
    delete process.env.DATABASE_URL;
  } else {
    process.env.DATABASE_URL = previousDatabaseUrl;
  }
});

describe('the wire contract', () => {
  it('emits `id` and never `_id` on any conversation-shaped response', async () => {
    const created = await api('POST', '/conversations/new', {});
    expect(created.status).toBe(200);
    expect(created.json.id).toEqual(expect.any(String));
    expect(created.json).not.toHaveProperty('_id');

    const conversationId = created.json.id as string;
    await api('POST', '/conversations', {
      conversationId,
      messages: [{ id: 'm1', role: 'user', content: 'hi' }],
    });

    const fetched = await api('GET', `/conversations/${conversationId}`);
    expect(fetched.json).not.toHaveProperty('_id');
    for (const m of fetched.json.messages as Record<string, unknown>[]) {
      expect(m).not.toHaveProperty('_id');
      expect(m).not.toHaveProperty('__v');
    }

    const listed = await api('GET', '/conversations');
    for (const c of listed.json.conversations as Record<string, unknown>[]) {
      expect(c).not.toHaveProperty('_id');
      expect(c.id).toEqual(expect.any(String));
    }
  });

  it('mints a conversation id that is not the row primary key', async () => {
    const created = await api('POST', '/conversations/new', {});
    const row = await storedConversation(created.json.id as string);
    expect(row).toBeDefined();
    // The wire id is `conversationId`; `id` is the uuidv7 the row was given.
    // Emitting the primary key instead would be invisible to every response
    // shape assertion above and would break every addressed route.
    expect(row.id).not.toEqual(created.json.id);
  });
});

/**
 * The id a client reads off a message must be the id the vote route matches.
 *
 * `messages` has TWO ids — the uuidv7 primary key and the client-supplied
 * `messageId` — and `PATCH /:id/messages/:messageId/vote` matches on the
 * latter. Projecting the primary key would produce a perfectly well-formed
 * response whose every message id 404s on vote, with nothing in the log. The
 * round trip is the only thing that catches it; asserting the field is a string
 * would pass on either.
 */
describe('the message id round trip', () => {
  it('votes with the id the read handed out', async () => {
    const conversationId = randomUUID();
    await api('POST', '/conversations', {
      conversationId,
      messages: [
        { id: 'client-msg-1', role: 'user', content: 'question' },
        { id: 'client-msg-2', role: 'assistant', content: 'answer' },
      ],
    });

    const fetched = await api('GET', `/conversations/${conversationId}`);
    const wire = fetched.json.messages as Array<{ id: string }>;
    expect(wire.map((m) => m.id)).toEqual(['client-msg-1', 'client-msg-2']);

    const voted = await api(
      'PATCH',
      `/conversations/${conversationId}/messages/${wire[1].id}/vote`,
      { vote: 'up' },
    );
    expect(voted.status).toBe(200);
    expect(voted.json).toEqual({ success: true, vote: 'up' });
  });

  it('clears a vote with null, and 404s an id that is not a message', async () => {
    const conversationId = randomUUID();
    await api('POST', '/conversations', {
      conversationId,
      messages: [{ id: 'votable', role: 'user', content: 'x', vote: 'down' }],
    });

    const cleared = await api(
      'PATCH',
      `/conversations/${conversationId}/messages/votable/vote`,
      { vote: null },
    );
    expect(cleared.status).toBe(200);
    expect(cleared.json).toEqual({ success: true, vote: null });
    const [row] = await storedMessages(conversationId);
    expect(row.vote).toBeNull();

    const missing = await api(
      'PATCH',
      `/conversations/${conversationId}/messages/no-such-message/vote`,
      { vote: 'up' },
    );
    expect(missing.status).toBe(404);
  });
});

describe('POST /conversations — upsert and replace', () => {
  it('replaces the message history rather than appending to it', async () => {
    const conversationId = randomUUID();
    await api('POST', '/conversations', {
      conversationId,
      messages: [
        { id: 'a', role: 'user', content: 'one' },
        { id: 'b', role: 'assistant', content: 'two' },
      ],
    });
    await api('POST', '/conversations', {
      conversationId,
      messages: [{ id: 'c', role: 'user', content: 'three' }],
    });

    const stored = await storedMessages(conversationId);
    expect(stored.map((m) => m.messageId)).toEqual(['c']);
  });

  it('sets the title only on insert, and lets an explicit title through on update', async () => {
    const conversationId = randomUUID();
    await api('POST', '/conversations', {
      conversationId,
      messages: [{ id: 'a', role: 'user', content: 'a question about hedgehogs' }],
    });
    expect((await storedConversation(conversationId)).title).toBe('a question about hedgehogs');

    // No title in the body: the fallback is `$setOnInsert`, so it must NOT
    // overwrite the title of a row that already exists.
    await api('POST', '/conversations', {
      conversationId,
      messages: [{ id: 'b', role: 'user', content: 'something else entirely' }],
    });
    expect((await storedConversation(conversationId)).title).toBe('a question about hedgehogs');

    await api('POST', '/conversations', {
      conversationId,
      title: 'Renamed by the user',
      messages: [{ id: 'c', role: 'user', content: 'x' }],
    });
    expect((await storedConversation(conversationId)).title).toBe('Renamed by the user');
  });

  it('does not change the source of an existing conversation', async () => {
    const conversationId = randomUUID();
    await api('POST', '/conversations', {
      conversationId,
      source: 'telegram',
      messages: [{ id: 'a', role: 'user', content: 'x' }],
    });
    expect((await storedConversation(conversationId)).source).toBe('telegram');

    await api('POST', '/conversations', {
      conversationId,
      source: 'web',
      messages: [{ id: 'b', role: 'user', content: 'y' }],
    });
    expect((await storedConversation(conversationId)).source).toBe('telegram');
  });

  /**
   * The `$set: { x: undefined }` divergence, driven from the route rather than
   * from the repository.
   *
   * A body whose messages are all unstorable leaves `lastMessage` undefined.
   * Mongo stripped an undefined key out of `$set` and kept the stored value;
   * the same statement in Postgres writes NULL and erases it. This is the
   * request that reaches it, and the assertion is that the preview SURVIVES.
   */
  it('keeps the stored preview when a save carries no usable message', async () => {
    const conversationId = randomUUID();
    await api('POST', '/conversations', {
      conversationId,
      messages: [{ id: 'a', role: 'user', content: 'the preview text' }],
    });
    expect((await storedConversation(conversationId)).lastMessage).toBe('the preview text');

    // `{}` fails the presence filter (no role, no content) and is dropped
    // silently, exactly as before — so `lastMessage` is computed as undefined.
    const res = await api('POST', '/conversations', { conversationId, messages: [{}] });
    expect(res.status).toBe(200);
    expect((await storedConversation(conversationId)).lastMessage).toBe('the preview text');
  });

  it('drops a message with no role, and stores the rest', async () => {
    const conversationId = randomUUID();
    const res = await api('POST', '/conversations', {
      conversationId,
      messages: [
        { id: 'keep', role: 'user', content: 'kept' },
        { id: 'drop', content: 'no role' },
        { id: 'drop2', role: 'user' },
      ],
    });
    expect(res.status).toBe(200);
    expect((await storedMessages(conversationId)).map((m) => m.messageId)).toEqual(['keep']);
  });

  it('rejects an unstored role with 400 and writes nothing', async () => {
    const conversationId = randomUUID();
    const res = await api('POST', '/conversations', {
      conversationId,
      // `tool` is a real OpenAI role and the stored enum is user/assistant/
      // system. Mongo skipped it and saved the rest; this reports it.
      messages: [{ id: 'a', role: 'tool', content: 'result' }],
    });
    expect(res.status).toBe(400);
    expect(await storedConversation(conversationId)).toBeUndefined();
    expect(await storedMessages(conversationId)).toEqual([]);
  });

  /**
   * The transaction, driven by a failure the route cannot filter out.
   *
   * `content: null` passes the presence filter (`null !== undefined`) and the
   * role is valid, so the row reaches a NOT NULL column and the INSERT fails
   * AFTER the conversation upsert and AFTER the message delete have run. Under
   * the old `Promise.all` of independent operations the delete would have
   * stood: the conversation would have kept its new preview text and lost every
   * message it had. Both must be intact here, which is only true if the two
   * writes share one transaction.
   */
  it('rolls back the whole save when a message cannot be stored', async () => {
    const conversationId = randomUUID();
    await api('POST', '/conversations', {
      conversationId,
      messages: [
        { id: 'survivor-1', role: 'user', content: 'original' },
        { id: 'survivor-2', role: 'assistant', content: 'history' },
      ],
    });

    const res = await api('POST', '/conversations', {
      conversationId,
      title: 'This title must not land',
      messages: [{ id: 'poison', role: 'user', content: null }],
    });
    expect(res.status).toBe(500);

    const after = await storedConversation(conversationId);
    expect(after.title).toBe('original');
    expect(after.lastMessage).toBe('history');
    expect((await storedMessages(conversationId)).map((m) => m.messageId)).toEqual([
      'survivor-1',
      'survivor-2',
    ]);
  });
});

describe('GET /conversations — cursor pagination', () => {
  it('pages down updatedAt and round-trips its own cursor', async () => {
    // Explicit, spread timestamps: uuidv7 is NOT monotonic within a
    // millisecond, so ordering must never be left to insertion order.
    const ids = [randomUUID(), randomUUID(), randomUUID()];
    for (const [i, conversationId] of ids.entries()) {
      await db.insert(conversations).values({
        oxyUserId: ctx.userId,
        conversationId,
        title: `page-${i}`,
        updatedAt: new Date(Date.UTC(2030, 0, 1 + i)),
      });
    }

    const first = await api('GET', '/conversations?limit=2');
    const firstPage = first.json.conversations as Array<{ id: string; title: string }>;
    expect(firstPage.map((c) => c.title)).toEqual(['page-2', 'page-1']);
    expect(first.json.hasMore).toBe(true);
    expect(first.json.nextCursor).toEqual(expect.any(String));

    const second = await api(
      'GET',
      `/conversations?limit=2&cursor=${encodeURIComponent(first.json.nextCursor as string)}`,
    );
    const secondPage = second.json.conversations as Array<{ title: string }>;
    // The cursor is strict `<`, so the row it names must NOT reappear.
    expect(secondPage.map((c) => c.title)).toContain('page-0');
    expect(secondPage.map((c) => c.title)).not.toContain('page-1');
  });
});

describe('DELETE /conversations/:id', () => {
  it('removes the conversation and its messages together', async () => {
    const conversationId = randomUUID();
    await api('POST', '/conversations', {
      conversationId,
      messages: [{ id: 'a', role: 'user', content: 'x' }],
    });

    const res = await api('DELETE', `/conversations/${conversationId}`);
    expect(res.status).toBe(200);
    expect(await storedConversation(conversationId)).toBeUndefined();
    // No foreign key ties the two tables — `messages.conversationId` holds the
    // client-facing id, not the row's primary key — so nothing cascades and the
    // handler has to delete both. A missed second delete strands the rows
    // behind a conversation that no longer exists to delete them by.
    expect(await storedMessages(conversationId)).toEqual([]);
  });

  it('404s an id that is not a conversation', async () => {
    const res = await api('DELETE', `/conversations/${randomUUID()}`);
    expect(res.status).toBe(404);
  });

  it('does not delete another user\'s conversation', async () => {
    const conversationId = randomUUID();
    await db.insert(conversations).values({
      oxyUserId: `${ctx.userId}-stranger`,
      conversationId,
      title: 'not yours',
    });

    const res = await api('DELETE', `/conversations/${conversationId}`);
    expect(res.status).toBe(404);
    const [row] = await db
      .select()
      .from(conversations)
      .where(
        and(
          eq(conversations.oxyUserId, `${ctx.userId}-stranger`),
          eq(conversations.conversationId, conversationId),
        ),
      );
    expect(row).toBeDefined();
  });
});

describe('GET /conversations/:id', () => {
  it('404s a conversation belonging to someone else', async () => {
    const conversationId = randomUUID();
    await db.insert(conversations).values({
      oxyUserId: `${ctx.userId}-stranger`,
      conversationId,
      title: 'not yours',
    });
    expect((await api('GET', `/conversations/${conversationId}`)).status).toBe(404);
  });

  it('returns messages oldest first', async () => {
    const conversationId = randomUUID();
    await api('POST', '/conversations', {
      conversationId,
      messages: [
        { id: 'first', role: 'user', content: 'a', createdAt: '2030-01-01T00:00:00.000Z' },
        { id: 'second', role: 'assistant', content: 'b', createdAt: '2030-01-02T00:00:00.000Z' },
      ],
    });
    const res = await api('GET', `/conversations/${conversationId}`);
    expect((res.json.messages as Array<{ id: string }>).map((m) => m.id)).toEqual([
      'first',
      'second',
    ]);
  });

  /**
   * `createdAt` arrives as a JSON string and Mongoose cast it; drizzle does
   * not, and postgres.js serialises an Invalid Date by throwing. The handler
   * converts, so the stored value has to be the instant the body named — not
   * now, and not a 500.
   */
  it('stores a client-supplied createdAt as the instant it names', async () => {
    const conversationId = randomUUID();
    await api('POST', '/conversations', {
      conversationId,
      messages: [{ id: 'dated', role: 'user', content: 'x', createdAt: '2029-06-01T12:00:00.000Z' }],
    });
    const [row] = await storedMessages(conversationId);
    expect(row.createdAt.toISOString()).toBe('2029-06-01T12:00:00.000Z');
  });
});
