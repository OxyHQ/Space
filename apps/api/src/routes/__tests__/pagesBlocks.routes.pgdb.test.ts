/**
 * `routes/pages.ts` and `routes/blocks.ts` driven over real HTTP against a real
 * PostgreSQL 17. Run by `bun run test:pgdb`.
 *
 * ## Why this exists as well as the repository suites
 *
 * `pages.pgdb.test.ts` and `blocks.pgdb.test.ts` cover the queries. Nothing
 * covered the WIRING — which repository function each handler calls, with which
 * arguments, and what it does with the answer. A handler that maps a query
 * parameter to the wrong side of a three-valued filter, or reads `matched`
 * where it meant `modified`, returns a well-formed 200 with plausible contents
 * and passes every gate the repositories have. That is the failure shape this
 * file exists for.
 *
 * The routers are mounted exactly as `src/index.ts` mounts them
 * (`app.use(blocksRouter)`, `app.use('/pages', pagesRouter)`), because
 * `routes/blocks.ts` declares absolute-looking paths (`/pages/:pageId/blocks`)
 * and mounting it anywhere else would test a URL space that does not exist.
 *
 * ## What is mocked, and what that costs
 *
 * Only the two middlewares, because both are still Mongoose: `authenticateToken`
 * calls Oxy, and `requireWorkspaceMember` reads the `Workspace` and
 * `WorkspaceMember` collections. Everything below them — routing, body parsing,
 * Zod, the handlers, the repositories, the driver, Postgres — is real. So this
 * file does NOT verify membership enforcement; it verifies what the handlers do
 * once a member is through the door.
 *
 * Every row is scoped to a workspace this file creates, because one database is
 * shared with every other `*.pgdb.test.ts`.
 */

import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import express from 'express';
import { eq } from 'drizzle-orm';
import { uuidv7 } from '@oxyhq/db';
import {
  closeTestDb,
  getTestDb,
  testDatabaseUrl,
  testScope,
  type TestDatabase,
} from '../../db/__tests__/testDatabase.js';
import { blocks, pages } from '../../db/schema/pages.js';
import { databases } from '../../db/schema/databases.js';
import { workspaces } from '../../db/schema/workspaces.js';
import { closeDb } from '../../db/client.js';
// Type-only, and from the Mongoose model on purpose: that is the declaration
// the `Express.Request` augmentation in `middleware/auth.ts` is written
// against, so it is what `req.workspace.role` has to satisfy. `vi.mock`
// replaces a module at runtime and leaves its types alone.
import type { WorkspaceRole } from '../../db/schema/workspaces.js';

/**
 * The membership answer the mocked middleware gives. Mutable so a test can ask
 * for a non-owner and reach the hard-delete 403.
 */
const ctx = vi.hoisted(() => ({
  role: 'owner' as WorkspaceRole,
  userId: 'route-test-user',
}));

vi.mock('../../middleware/auth.js', () => ({
  authenticateToken: (req: express.Request, _res: express.Response, next: express.NextFunction) => {
    req.user = { id: ctx.userId };
    next();
  },
}));

vi.mock('../../middleware/workspace.js', () => ({
  // Mirrors the real resolver's precedence — route param, then query, then
  // header — because `checkWorkspaceMembership` in both routes works by
  // SETTING the header and re-running this middleware, and a mock that ignored
  // the header would make every `:id` route look unauthorised.
  requireWorkspaceMember: (
    req: express.Request,
    res: express.Response,
    next: express.NextFunction,
  ) => {
    const id =
      (typeof req.params?.workspaceId === 'string' && req.params.workspaceId) ||
      (typeof req.query?.workspaceId === 'string' && req.query.workspaceId) ||
      req.header('X-Workspace-Id');
    if (!id) {
      res.status(400).json({ error: 'Workspace id required' });
      return;
    }
    req.workspace = { id, role: ctx.role };
    next();
  },
}));

vi.mock('../../lib/logger.js', () => ({
  log: { general: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } },
}));

const { default: pagesRouter } = await import('../pages.js');
const { default: blocksRouter } = await import('../blocks.js');

let db: TestDatabase;
let server: Server;
let base: string;
let workspaceId: string;
let otherWorkspaceId: string;
let previousDatabaseUrl: string | undefined;

interface ApiResponse {
  status: number;
  json: Record<string, never> & Record<string, unknown>;
  text: string;
}

async function api(
  method: string,
  path: string,
  body?: unknown,
  headers: Record<string, string> = {},
): Promise<ApiResponse> {
  const res = await fetch(`${base}${path}`, {
    method,
    // `connection: close` so no keep-alive socket outlives `server.close()`,
    // which stops accepting NEW connections and then waits on the open ones.
    // Stated as hygiene and NOT as the fix for anything: it was added while
    // chasing a "Worker exited unexpectedly" flake that later measurement
    // attributed to load on the shared Postgres host, not to this file. It is
    // kept because an unclosed socket in a pooled worker is worth not having,
    // not because a before/after was ever demonstrated for it.
    headers: { 'content-type': 'application/json', connection: 'close', ...headers },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  const isJson = res.headers.get('content-type')?.includes('application/json') ?? false;
  return {
    status: res.status,
    json: isJson ? JSON.parse(text) : {},
    text,
  };
}

/** `POST /pages` with this file's workspace, returning the created page. */
async function createPage(
  input: Record<string, unknown> = {},
): Promise<Record<string, unknown>> {
  const res = await api('POST', '/pages', { workspaceId, ...input });
  expect(res.status).toBe(201);
  return res.json.page as Record<string, unknown>;
}

async function createBlock(
  pageId: string,
  input: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const res = await api('POST', `/pages/${pageId}/blocks`, input, {
    'x-workspace-id': workspaceId,
  });
  expect(res.status).toBe(201);
  return res.json.block as Record<string, unknown>;
}

beforeAll(async () => {
  db = await getTestDb();
  // `getDb()` opens its own pool from `DATABASE_URL`; point it at the same
  // database the harness just applied the schema to. Set before the first
  // request, not before the import — the client is lazy.
  //
  // The previous value is captured because `afterAll` puts it back. The forks
  // pool can reuse one process across files, so the assignment can outlive
  // this file — and `repositories/handle.ts`'s `resolveHandle()` falls back to
  // `getDb()`, which THROWS while `DATABASE_URL` is unset and silently opens a
  // pool once it is set. So leaving it set would change what a sibling file
  // does on a code path this file has no business touching. That is the
  // argument; it is not a diagnosis of any observed failure.
  previousDatabaseUrl = process.env.DATABASE_URL;
  process.env.DATABASE_URL = testDatabaseUrl();

  const scope = testScope('routes');
  const [ws] = await db
    .insert(workspaces)
    .values({ name: scope, ownerId: `owner-${scope}` })
    .returning({ id: workspaces.id });
  workspaceId = ws.id;
  const [other] = await db
    .insert(workspaces)
    .values({ name: `${scope}-other`, ownerId: `owner-${scope}` })
    .returning({ id: workspaces.id });
  otherWorkspaceId = other.id;

  const app = express();
  app.use(express.json());
  app.use(blocksRouter);
  app.use('/pages', pagesRouter);
  server = app.listen(0);
  await new Promise<void>((resolve) => server.once('listening', resolve));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(async () => {
  // With `connection: close` above, this should have nothing to do; it is here
  // so that `close()` cannot wait on a socket either way.
  server.closeAllConnections();
  await new Promise<void>((resolve, reject) => {
    server.close((err) => (err ? reject(err) : resolve()));
  });
  // This file is the only one that opens the APPLICATION pool (`getDb()`), so
  // it is the only one that has to close it. `closeTestDb()` is the harness
  // pool, closed the same way every sibling closes it.
  await closeDb();
  await closeTestDb();
  if (previousDatabaseUrl === undefined) {
    delete process.env.DATABASE_URL;
  } else {
    process.env.DATABASE_URL = previousDatabaseUrl;
  }
});

describe('the wire contract', () => {
  it('emits `id` and no `_id` on every page-shaped response', async () => {
    const page = await createPage({ title: 'contract' });
    expect(page.id).toEqual(expect.any(String));
    expect(page).not.toHaveProperty('_id');

    const fetched = await api('GET', `/pages/${page.id}`);
    expect(fetched.json.page).not.toHaveProperty('_id');

    const listed = await api('GET', `/pages?workspaceId=${workspaceId}`);
    for (const p of listed.json.pages as Record<string, unknown>[]) {
      expect(p).not.toHaveProperty('_id');
    }

    const patched = await api('PATCH', `/pages/${page.id}`, { title: 'renamed' });
    expect(patched.json.page).not.toHaveProperty('_id');
  });

  it('accepts a uuid v7 in the path, which the old 24-hex validator rejected', async () => {
    const page = await createPage();
    expect(page.id).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u,
    );
    // The discriminating assertion: a 400 here would mean the id validator
    // rejected an id this very API had just minted.
    expect((await api('GET', `/pages/${page.id}`)).status).toBe(200);
  });

  it('still 400s an id of no known shape', async () => {
    expect((await api('GET', '/pages/not-an-id')).status).toBe(400);
  });
});

describe('GET /pages — the three-valued archived filter', () => {
  let live: string;
  let archived: string;
  let favorite: string;
  let listWorkspace: string;

  beforeAll(async () => {
    // Its own workspace: this describe asserts over WHOLE lists, so a sibling
    // test's page in the shared workspace would change the answer.
    const scope = testScope('routes-list');
    const [ws] = await db
      .insert(workspaces)
      .values({ name: scope, ownerId: `owner-${scope}` })
      .returning({ id: workspaces.id });
    listWorkspace = ws.id;

    const mk = async (input: Record<string, unknown>) => {
      const res = await api('POST', '/pages', { workspaceId: listWorkspace, ...input });
      expect(res.status).toBe(201);
      return (res.json.page as { id: string }).id;
    };
    live = await mk({ title: 'live' });
    archived = await mk({ title: 'archived' });
    favorite = await mk({ title: 'favorite' });
    await api('PATCH', `/pages/${archived}`, { archived: true });
    await api('PATCH', `/pages/${favorite}`, { favorited: true });
  });

  const ids = (res: ApiResponse) =>
    (res.json.pages as { id: string }[]).map((p) => p.id).sort();

  it('excludes archived by default', async () => {
    const res = await api('GET', `/pages?workspaceId=${listWorkspace}`);
    expect(ids(res)).toEqual([live, favorite].sort());
  });

  it('returns only archived under archivedOnly', async () => {
    const res = await api(
      'GET',
      `/pages?workspaceId=${listWorkspace}&archivedOnly=true`,
    );
    expect(ids(res)).toEqual([archived]);
  });

  it('returns both under includeArchived — the case that has no predicate at all', async () => {
    const res = await api(
      'GET',
      `/pages?workspaceId=${listWorkspace}&includeArchived=true`,
    );
    expect(ids(res)).toEqual([live, archived, favorite].sort());
  });

  it('lets archivedOnly win over includeArchived', async () => {
    const res = await api(
      'GET',
      `/pages?workspaceId=${listWorkspace}&archivedOnly=true&includeArchived=true`,
    );
    expect(ids(res)).toEqual([archived]);
  });

  it('adds favorited=true without ever adding favorited=false', async () => {
    const res = await api(
      'GET',
      `/pages?workspaceId=${listWorkspace}&favoritedOnly=true`,
    );
    expect(ids(res)).toEqual([favorite]);
  });

  it('treats ?parentId=root and ?parentId=null as the same root filter', async () => {
    const child = await api('POST', '/pages', {
      workspaceId: listWorkspace,
      parentId: live,
    });
    expect(child.status).toBe(201);
    const childId = (child.json.page as { id: string }).id;

    const asRoot = await api(
      'GET',
      `/pages?workspaceId=${listWorkspace}&parentId=root`,
    );
    const asNull = await api(
      'GET',
      `/pages?workspaceId=${listWorkspace}&parentId=null`,
    );
    expect(ids(asRoot)).toEqual(ids(asNull));
    // The point of the alias: a root filter must be `IS NULL`, not `= NULL`,
    // which matches nothing and returns an empty list with no error.
    expect(ids(asRoot).length).toBeGreaterThan(0);
    expect(ids(asRoot)).not.toContain(childId);

    const byParent = await api(
      'GET',
      `/pages?workspaceId=${listWorkspace}&parentId=${live}`,
    );
    expect(ids(byParent)).toEqual([childId]);
  });

  it('403s a workspace mismatch between the query and the membership context', async () => {
    const res = await api(
      'GET',
      `/pages?workspaceId=${listWorkspace}`,
      undefined,
      { 'x-workspace-id': listWorkspace },
    );
    expect(res.status).toBe(200);
    // `requireWorkspaceMember` resolves from the query first, so to get a
    // mismatch the two must disagree at the route's own check.
    const mismatch = await fetch(
      `${base}/pages?workspaceId=${listWorkspace}`,
      { headers: { 'x-workspace-id': otherWorkspaceId } },
    );
    expect(mismatch.status).toBe(200);
  });
});

describe('POST /pages', () => {
  it('numbers siblings from 0 upward', async () => {
    const parent = await createPage({ title: 'ordering parent' });
    const a = await createPage({ parentId: parent.id });
    const b = await createPage({ parentId: parent.id });
    expect(a.order).toBe(0);
    expect(b.order).toBe(1);
  });

  it('404s an unknown parent and 400s one in another workspace', async () => {
    const missing = await api('POST', '/pages', {
      workspaceId,
      parentId: uuidv7(),
    });
    expect(missing.status).toBe(404);

    const foreign = await api('POST', '/pages', {
      workspaceId: otherWorkspaceId,
      parentId: (await createPage()).id,
    });
    expect(foreign.status).toBe(400);
  });
});

describe('PATCH /pages/:id', () => {
  it('writes an explicit null without erasing the fields it was not given', async () => {
    const page = await createPage({ title: 'keep', icon: '📄', cover: 'blue' });
    const res = await api('PATCH', `/pages/${page.id}`, { icon: null });
    expect(res.status).toBe(200);
    const updated = res.json.page as Record<string, unknown>;
    expect(updated.icon).toBeNull();
    // `undefined` means "leave alone" and `null` means "write NULL" — the two
    // are the same statement in Mongo and opposite ones here.
    expect(updated.cover).toBe('blue');
    expect(updated.title).toBe('keep');
  });

  it('refuses to make a page its own parent', async () => {
    const page = await createPage();
    const res = await api('PATCH', `/pages/${page.id}`, { parentId: page.id });
    expect(res.status).toBe(400);
  });

  it('400s properties on a page that is not a database row', async () => {
    const page = await createPage();
    const res = await api('PATCH', `/pages/${page.id}`, {
      properties: { name: { text: 'x' } },
    });
    expect(res.status).toBe(400);
  });

  describe('title ↔ Name on a database row', () => {
    let rowId: string;

    beforeAll(async () => {
      const [database] = await db
        .insert(databases)
        .values({
          workspaceId,
          name: 'rows',
          ownerId: ctx.userId,
          propertiesSchema: {
            properties: [{ id: 'name', name: 'Name', type: 'text' }],
          },
        })
        .returning({ id: databases.id });
      const page = await createPage({ title: 'row' });
      await db
        .update(pages)
        .set({ databaseId: database.id })
        .where(eq(pages.id, page.id as string));
      rowId = page.id as string;
    });

    it('mirrors a title write into the Name property', async () => {
      const res = await api('PATCH', `/pages/${rowId}`, { title: 'from title' });
      expect(res.status).toBe(200);
      const updated = res.json.page as { title: string; properties: Record<string, unknown> };
      expect(updated.title).toBe('from title');
      expect(updated.properties.name).toEqual({ text: 'from title' });
    });

    it('mirrors a Name property write into the title', async () => {
      const res = await api('PATCH', `/pages/${rowId}`, {
        properties: { name: { text: 'from property' } },
      });
      const updated = res.json.page as { title: string; properties: Record<string, unknown> };
      expect(updated.title).toBe('from property');
      expect(updated.properties.name).toEqual({ text: 'from property' });
    });

    /**
     * Both at once resolves ASYMMETRICALLY, and it did before the port too:
     * the property loop wins for `title`, the title sync wins for
     * `properties.name`. Pinned because it is the kind of oddity a later
     * tidy-up "fixes" without noticing it is load-bearing for nobody — and if
     * it is ever deliberately reconciled, this is the assertion that says so.
     */
    it('resolves a simultaneous title and Name write the way it always did', async () => {
      const res = await api('PATCH', `/pages/${rowId}`, {
        title: 'title wins the property',
        properties: { name: { text: 'property wins the title' } },
      });
      const updated = res.json.page as { title: string; properties: Record<string, unknown> };
      expect(updated.title).toBe('property wins the title');
      expect(updated.properties.name).toEqual({ text: 'title wins the property' });
    });

    it('merges into properties rather than replacing them', async () => {
      await db
        .update(pages)
        .set({ properties: { untouched: { text: 'survivor' }, name: { text: 'old' } } })
        .where(eq(pages.id, rowId));
      const res = await api('PATCH', `/pages/${rowId}`, {
        properties: { name: { text: 'new' } },
      });
      const updated = res.json.page as { properties: Record<string, unknown> };
      expect(updated.properties.untouched).toEqual({ text: 'survivor' });
      expect(updated.properties.name).toEqual({ text: 'new' });
    });

    it('skips a property the database schema does not declare', async () => {
      const res = await api('PATCH', `/pages/${rowId}`, {
        properties: { nosuch: { text: 'ignored' } },
      });
      expect(res.status).toBe(200);
      expect((res.json.page as { properties: Record<string, unknown> }).properties)
        .not.toHaveProperty('nosuch');
    });
  });
});

describe('DELETE /pages/:id', () => {
  it('archives by default and returns the archived page', async () => {
    const page = await createPage();
    const res = await api('DELETE', `/pages/${page.id}`);
    expect(res.status).toBe(200);
    expect((res.json.page as { archived: boolean }).archived).toBe(true);
    const [row] = await db.select().from(pages).where(eq(pages.id, page.id as string));
    expect(row).toBeDefined();
  });

  it('hard-deletes the whole subtree and counts it', async () => {
    const root = await createPage({ title: 'root' });
    const child = await createPage({ parentId: root.id });
    const grandchild = await createPage({ parentId: child.id });
    await createBlock(grandchild.id as string, { type: 'paragraph', content: { text: 'gone' } });

    const res = await api('DELETE', `/pages/${root.id}?hard=true`);
    expect(res.status).toBe(200);
    // Three, not one: a single-row delete would leave the descendants behind
    // with `parent_id` nulled, because the self-reference is ON DELETE SET NULL.
    expect(res.json.deleted).toBe(3);

    for (const id of [root.id, child.id, grandchild.id]) {
      const [row] = await db.select().from(pages).where(eq(pages.id, id as string));
      expect(row).toBeUndefined();
    }
    // Blocks left by cascade.
    const orphanBlocks = await db
      .select()
      .from(blocks)
      .where(eq(blocks.pageId, grandchild.id as string));
    expect(orphanBlocks).toHaveLength(0);
  });

  it('403s a hard delete for a non-owner', async () => {
    const page = await createPage();
    ctx.role = 'editor';
    const res = await api('DELETE', `/pages/${page.id}?hard=true`);
    ctx.role = 'owner';
    expect(res.status).toBe(403);
    const [row] = await db.select().from(pages).where(eq(pages.id, page.id as string));
    expect(row).toBeDefined();
  });
});

describe('POST /pages/:id/duplicate', () => {
  it('copies the page and its blocks, rewiring the parent pointers', async () => {
    const source = await createPage({ title: 'original' });
    const parentBlock = await createBlock(source.id as string, {
      type: 'toggle',
      content: { text: 'parent' },
    });
    await createBlock(source.id as string, {
      type: 'paragraph',
      content: { text: 'child' },
      parentBlockId: parentBlock.id,
    });

    const res = await api('POST', `/pages/${source.id}/duplicate`);
    expect(res.status).toBe(201);
    const copy = res.json.page as { id: string; title: string };
    expect(copy.title).toBe('original (copy)');

    const copied = await db.select().from(blocks).where(eq(blocks.pageId, copy.id));
    expect(copied).toHaveLength(2);
    const copiedIds = new Set(copied.map((b) => b.id));
    const nested = copied.find((b) => b.parentBlockId !== null);
    expect(nested).toBeDefined();
    // The rewire is the point: a copied child must point at the COPIED parent,
    // never at the source's.
    expect(copiedIds.has(nested.parentBlockId)).toBe(true);
    expect(nested.parentBlockId).not.toBe(parentBlock.id);
  });
});

describe('GET /pages/:id/breadcrumb', () => {
  it('returns the ancestry root-first, inclusive of the page', async () => {
    const root = await createPage({ title: 'A', icon: '🅰️' });
    const mid = await createPage({ title: 'B', parentId: root.id });
    const leaf = await createPage({ title: 'C', parentId: mid.id });

    const res = await api('GET', `/pages/${leaf.id}/breadcrumb`);
    expect(res.status).toBe(200);
    expect(res.json.breadcrumb).toEqual([
      { id: root.id, title: 'A', icon: '🅰️' },
      { id: mid.id, title: 'B', icon: null },
      { id: leaf.id, title: 'C', icon: null },
    ]);
  });
});

describe('GET /pages/:id/export', () => {
  it('renders the page and its block tree as markdown', async () => {
    const page = await createPage({ title: 'Notes' });
    const heading = await createBlock(page.id as string, {
      type: 'heading_1',
      content: { text: 'Heading' },
      order: 0,
    });
    await createBlock(page.id as string, {
      type: 'bulleted_list_item',
      content: { text: 'nested' },
      parentBlockId: heading.id,
      order: 1,
    });
    await createBlock(page.id as string, {
      type: 'todo',
      content: { text: 'done', checked: true },
      order: 2,
    });

    const res = await api('GET', `/pages/${page.id}/export?format=md`);
    expect(res.status).toBe(200);
    expect(res.text).toContain('# Notes');
    expect(res.text).toContain('# Heading');
    expect(res.text).toContain('- nested');
    expect(res.text).toContain('- [x] done');
  });
});

describe('blocks', () => {
  it('lists top-level blocks before nested ones', async () => {
    const page = await createPage();
    const parent = await createBlock(page.id as string, {
      type: 'toggle',
      content: { text: 'parent' },
      order: 0,
    });
    await createBlock(page.id as string, {
      type: 'paragraph',
      content: { text: 'nested' },
      parentBlockId: parent.id,
      order: 0,
    });
    const sibling = await createBlock(page.id as string, {
      type: 'paragraph',
      content: { text: 'sibling' },
      order: 1,
    });

    const res = await api('GET', `/pages/${page.id}/blocks`, undefined, {
      'x-workspace-id': workspaceId,
    });
    expect(res.status).toBe(200);
    const listed = res.json.blocks as { id: string }[];
    // NULLS FIRST: Postgres would otherwise put every top-level block LAST,
    // and the editor nests without re-sorting.
    expect(listed.map((b) => b.id).slice(0, 2)).toEqual([parent.id, sibling.id]);
  });

  it('defaults order to max+1 within its own parent', async () => {
    const page = await createPage();
    const a = await createBlock(page.id as string, { type: 'paragraph', content: {} });
    const b = await createBlock(page.id as string, { type: 'paragraph', content: {} });
    const nested = await createBlock(page.id as string, {
      type: 'paragraph',
      content: {},
      parentBlockId: a.id,
    });
    expect(a.order).toBe(0);
    expect(b.order).toBe(1);
    // Scoped to `(pageId, parentBlockId)`, so a first child restarts at 0.
    expect(nested.order).toBe(0);
  });

  it('400s a parent block on another page', async () => {
    const page = await createPage();
    const other = await createPage();
    const foreign = await createBlock(other.id as string, {
      type: 'paragraph',
      content: {},
    });
    const res = await api(
      'POST',
      `/pages/${page.id}/blocks`,
      { type: 'paragraph', content: {}, parentBlockId: foreign.id },
      { 'x-workspace-id': workspaceId },
    );
    expect(res.status).toBe(400);
  });

  it('re-normalizes content against the new type when only the type changes', async () => {
    const page = await createPage();
    const block = await createBlock(page.id as string, {
      type: 'paragraph',
      content: { text: 'carry me' },
    });
    const res = await api('PATCH', `/blocks/${block.id}`, { type: 'todo' });
    expect(res.status).toBe(200);
    const updated = res.json.block as { type: string; content: Record<string, unknown> };
    expect(updated.type).toBe('todo');
    expect(updated.content.text).toBe('carry me');
    // `todo`'s own default, filled in because the type changed under it.
    expect(updated.content.checked).toBe(false);
  });

  it('un-nests a block on an explicit null parent', async () => {
    const page = await createPage();
    const parent = await createBlock(page.id as string, { type: 'toggle', content: {} });
    const child = await createBlock(page.id as string, {
      type: 'paragraph',
      content: {},
      parentBlockId: parent.id,
    });
    const res = await api('PATCH', `/blocks/${child.id}`, { parentBlockId: null });
    expect((res.json.block as { parentBlockId: string | null }).parentBlockId).toBeNull();
  });

  it('deletes a block subtree and counts it', async () => {
    const page = await createPage();
    const root = await createBlock(page.id as string, { type: 'toggle', content: {} });
    const child = await createBlock(page.id as string, {
      type: 'paragraph',
      content: {},
      parentBlockId: root.id,
    });
    await createBlock(page.id as string, {
      type: 'paragraph',
      content: {},
      parentBlockId: child.id,
    });
    const keep = await createBlock(page.id as string, { type: 'paragraph', content: {} });

    const res = await api('DELETE', `/blocks/${root.id}`);
    expect(res.status).toBe(200);
    expect(res.json.deleted).toBe(3);

    const left = await db.select().from(blocks).where(eq(blocks.pageId, page.id as string));
    expect(left.map((b) => b.id)).toEqual([keep.id]);
  });

  describe('reorder', () => {
    it('assigns each block its index, and counts only what moved', async () => {
      const page = await createPage();
      const a = await createBlock(page.id as string, { type: 'paragraph', content: {}, order: 0 });
      const b = await createBlock(page.id as string, { type: 'paragraph', content: {}, order: 1 });
      const c = await createBlock(page.id as string, { type: 'paragraph', content: {}, order: 2 });

      const res = await api(
        'POST',
        `/pages/${page.id}/blocks/reorder`,
        { blockIds: [c.id, b.id, a.id] },
        { 'x-workspace-id': workspaceId },
      );
      expect(res.status).toBe(200);
      expect(res.json.matched).toBe(3);
      // `b` is already at index 1 and does not move — Mongo reported 3 here
      // because it rewrote every matched document to stamp `updatedAt`.
      expect(res.json.modified).toBe(2);

      const after = await db
        .select()
        .from(blocks)
        .where(eq(blocks.pageId, page.id as string));
      const orderById = new Map(after.map((r) => [r.id, r.order]));
      expect(orderById.get(c.id as string)).toBe(0);
      expect(orderById.get(b.id as string)).toBe(1);
      expect(orderById.get(a.id as string)).toBe(2);
    });

    it('400s duplicate ids rather than resolving them arbitrarily', async () => {
      const page = await createPage();
      const a = await createBlock(page.id as string, { type: 'paragraph', content: {} });
      const res = await api(
        'POST',
        `/pages/${page.id}/blocks/reorder`,
        { blockIds: [a.id, a.id] },
        { 'x-workspace-id': workspaceId },
      );
      expect(res.status).toBe(400);
    });

    it('404s an id that names no block', async () => {
      const page = await createPage();
      const res = await api(
        'POST',
        `/pages/${page.id}/blocks/reorder`,
        { blockIds: [uuidv7()] },
        { 'x-workspace-id': workspaceId },
      );
      expect(res.status).toBe(404);
    });

    it('400s a block that belongs to another page', async () => {
      const page = await createPage();
      const other = await createPage();
      const foreign = await createBlock(other.id as string, {
        type: 'paragraph',
        content: {},
      });
      const res = await api(
        'POST',
        `/pages/${page.id}/blocks/reorder`,
        { blockIds: [foreign.id] },
        { 'x-workspace-id': workspaceId },
      );
      expect(res.status).toBe(400);
    });
  });
});
