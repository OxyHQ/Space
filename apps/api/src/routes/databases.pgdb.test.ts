import { createServer, request as httpRequest, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import express from 'express';
import type { NextFunction, Request, Response } from 'express';
import { and, eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import {
  closeTestDb,
  getTestDb,
  seedWorkspace,
  type TestDatabase,
} from '../db/__tests__/testDatabase.js';
import { databaseViews, databases } from '../db/schema/databases.js';
import { blocks, pages } from '../db/schema/pages.js';
import { closeDb } from '../db/client.js';
import type { WorkspaceRole } from '../db/schema/workspaces.js';

/**
 * `routes/databases.ts` against a real Postgres, driven over HTTP.
 *
 * The router is mounted as `src/index.ts` mounts it and exercised with real
 * requests, so the serializers, the zod boundary and the repository calls are
 * all the shipped ones. A test that called the repositories directly would
 * measure the repositories — which `repositories/databases.pgdb.test.ts`
 * already does — and would say nothing about whether the route calls them.
 *
 * ## What is mocked, and what that costs
 *
 * The two middlewares and the logger — nothing that touches Postgres.
 * `authenticateToken` reaches Oxy and `requireWorkspaceMember` reads the Mongo
 * `Workspace` / `WorkspaceMember` models; the logger is mocked for the reason
 * given at its `vi.mock`. Membership is the workspaces domain and is still
 * on Mongo, so it is not under test here — but the mock does resolve the
 * workspace id the same way the real middleware does (param, then query, then
 * the `X-Workspace-Id` header) and refuses a workspace the caller is not a
 * member of, because several route paths depend on `checkWorkspaceMembership`
 * rejecting rather than passing.
 *
 * Every assertion is scoped to a workspace, database or page id this file
 * created: the suite shares one database with every other `*.pgdb.test.ts`.
 */

const ctx = vi.hoisted(() => ({
  /** The Oxy user id `authenticateToken` attaches. */
  userId: 'user-pending',
  /** The one workspace this file's caller is a member of. */
  workspaceId: '',
  /** The role the membership mock reports. `hard=true` requires `owner`. */
  role: 'owner' as WorkspaceRole,
}));

vi.mock('../middleware/auth.js', () => ({
  authenticateToken: (req: Request, _res: Response, next: NextFunction) => {
    req.user = { id: ctx.userId };
    next();
  },
}));

/**
 * NOT about log noise: outside production `lib/logger.ts` configures pino with
 * the `pino-pretty` TRANSPORT, which runs on a `thread-stream` worker thread.
 * This is the first `*.pgdb.test.ts` to import a route, so it is the first to
 * load the logger at all, and a live worker thread is a handle the fork does
 * not need to be holding when vitest terminates it. Every later route suite
 * wants the same mock.
 *
 * It does NOT fix the run's intermittent "Timeout terminating forks worker",
 * which silently drops a whole file's results and reports the count as a pass.
 * That is PRE-EXISTING: measured on the base revision (f7834e8, none of this
 * change) at 2 losses in 11 full runs, against 1 in 8 here. So a short run is
 * evidence of nothing — re-run before reading a missing file as a regression.
 *
 * Errors still surface — a route that 500s unexpectedly says so on stderr.
 */
vi.mock('../lib/logger.js', () => ({
  log: {
    general: {
      error: (...args: unknown[]) => console.error('[route]', ...args),
      warn: () => {},
      info: () => {},
      debug: () => {},
    },
  },
}));

vi.mock('../middleware/workspace.js', () => ({
  requireWorkspaceMember: (req: Request, res: Response, next: NextFunction) => {
    const fromParam = req.params?.workspaceId;
    const fromQuery = req.query?.workspaceId;
    const fromHeader = req.header('X-Workspace-Id');
    const workspaceId =
      (typeof fromParam === 'string' && fromParam) ||
      (typeof fromQuery === 'string' && fromQuery) ||
      (typeof fromHeader === 'string' && fromHeader !== 'personal' && fromHeader) ||
      null;
    if (!workspaceId) {
      res.status(400).json({ error: 'Workspace id required' });
      return;
    }
    if (workspaceId !== ctx.workspaceId) {
      res.status(403).json({ error: 'Forbidden: not a workspace member' });
      return;
    }
    req.workspace = { id: workspaceId, role: ctx.role };
    next();
  },
}));

// `vi.mock` is hoisted above this, so the router resolves the mocks.
import databasesRouter from './databases.js';

let db: TestDatabase;
let originalDatabaseUrl: string | undefined;
let server: Server;
let baseUrl: string;
/** A second workspace, so "scoped to this workspace" is a claim with a control. */
let otherWorkspaceId: string;

interface ApiResponse {
  status: number;
  body: Record<string, unknown>;
}

/**
 * `node:http` with `agent: false` rather than `fetch`: undici's global
 * dispatcher keeps its sockets and their keep-alive timers alive after the
 * response and offers no way to shut them down from here, so a worker that
 * used `fetch` still holds handles after `afterAll`. One connection per
 * request, closed with the response, leaves nothing behind.
 */
async function api(
  method: string,
  path: string,
  body?: unknown,
): Promise<ApiResponse> {
  const payload = body === undefined ? undefined : JSON.stringify(body);
  return new Promise<ApiResponse>((resolve, reject) => {
    const request = httpRequest(
      `${baseUrl}${path}`,
      {
        method,
        agent: false,
        headers: payload === undefined ? {} : { 'content-type': 'application/json' },
      },
      (response) => {
        let text = '';
        response.setEncoding('utf8');
        response.on('data', (chunk: string) => {
          text += chunk;
        });
        response.on('end', () => {
          resolve({
            status: response.statusCode ?? 0,
            body: text.length > 0 ? (JSON.parse(text) as Record<string, unknown>) : {},
          });
        });
      },
    );
    request.on('error', reject);
    if (payload !== undefined) request.write(payload);
    request.end();
  });
}

/** The `id` a serializer emitted, or a failure naming what it emitted instead. */
function idOf(entity: unknown): string {
  const id = (entity as { id?: unknown } | null)?.id;
  if (typeof id !== 'string') {
    throw new Error(`expected an id, got ${JSON.stringify(entity)}`);
  }
  return id;
}

function asRecord(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object') {
    throw new Error(`expected an object, got ${JSON.stringify(value)}`);
  }
  return value as Record<string, unknown>;
}

function asArray(value: unknown): unknown[] {
  if (!Array.isArray(value)) {
    throw new Error(`expected an array, got ${JSON.stringify(value)}`);
  }
  return value;
}

/** Create a database through the route and return its id. */
async function createDatabase(
  overrides: Record<string, unknown> = {},
): Promise<string> {
  const created = await api('POST', '/api/databases', {
    workspaceId: ctx.workspaceId,
    name: 'Tasks',
    ...overrides,
  });
  expect(created.status).toBe(201);
  return idOf(created.body.database);
}

beforeAll(async () => {
  db = await getTestDb();
  // The route resolves its own handle through `getDb()`, which reads
  // DATABASE_URL. Pointed at the same database the fixtures are seeded in, and
  // restored afterwards — `process.env` is shared with every sibling file.
  originalDatabaseUrl = process.env.DATABASE_URL;
  process.env.DATABASE_URL = process.env.STATION_TEST_DATABASE_URL;

  ctx.workspaceId = await seedWorkspace(db, 'route-databases');
  otherWorkspaceId = await seedWorkspace(db, 'route-databases-other');
  ctx.userId = `owner-${ctx.workspaceId}`;

  const app = express();
  app.use(express.json());
  app.use('/api/databases', databasesRouter);
  server = createServer(app);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address() as AddressInfo;
  baseUrl = `http://127.0.0.1:${address.port}`;
});

afterAll(async () => {
  server.closeAllConnections();
  await new Promise<void>((resolve, reject) => {
    server.close((err) => (err ? reject(err) : resolve()));
  });
  await closeDb();
  await closeTestDb();
  if (originalDatabaseUrl === undefined) delete process.env.DATABASE_URL;
  else process.env.DATABASE_URL = originalDatabaseUrl;
});

// ---------------------------------------------------------------------------
// The wire contract
// ---------------------------------------------------------------------------

describe('id contract', () => {
  it('emits a uuid v7 `id` on every entity and no `_id` anywhere', async () => {
    const created = await api('POST', '/api/databases', {
      workspaceId: ctx.workspaceId,
      name: 'Ids',
    });
    expect(created.status).toBe(201);
    const databaseId = idOf(created.body.database);

    const row = await api('POST', `/api/databases/${databaseId}/rows`, {
      title: 'A row',
    });
    expect(row.status).toBe(201);

    const uuidV7 =
      /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
    expect(databaseId).toMatch(uuidV7);
    expect(idOf(asArray(created.body.views)[0])).toMatch(uuidV7);
    expect(idOf(row.body.row)).toMatch(uuidV7);

    // `_id` absent is also what an empty response looks like, so the ids above
    // are the positive half of this assertion and this is the negative half.
    const serialized = JSON.stringify([created.body, row.body]);
    expect(serialized).not.toContain('_id');
    expect(serialized).toContain(databaseId);
  });

  it('400s a malformed id and reaches the row for a 24-hex one', async () => {
    expect((await api('GET', '/api/databases/not-an-id')).status).toBe(400);

    // A backfilled row keeps its ObjectId forever, so a 24-hex id must reach
    // the query rather than being rejected at the boundary. 404, not 400.
    const objectIdShaped = '507f1f77bcf86cd799439011';
    expect((await api('GET', `/api/databases/${objectIdShaped}`)).status).toBe(404);
  });
});

// ---------------------------------------------------------------------------
// Databases
// ---------------------------------------------------------------------------

describe('POST /api/databases', () => {
  it('commits the database and its default view together', async () => {
    const created = await api('POST', '/api/databases', {
      workspaceId: ctx.workspaceId,
      name: 'With default view',
    });
    expect(created.status).toBe(201);
    const databaseId = idOf(created.body.database);

    const stored = await db
      .select()
      .from(databaseViews)
      .where(eq(databaseViews.databaseId, databaseId));
    expect(stored).toHaveLength(1);
    expect(stored[0].isDefault).toBe(true);
    expect(stored[0].name).toBe('All');
    expect(asArray(created.body.views)).toHaveLength(1);
  });

  it('builds the Notion default schema when none is given', async () => {
    const created = await api('POST', '/api/databases', {
      workspaceId: ctx.workspaceId,
      name: 'Defaults',
    });
    const schema = asRecord(asRecord(created.body.database).schema);
    const properties = asArray(schema.properties);
    expect(properties.map((p) => asRecord(p).id)).toEqual(['name', 'status']);
  });

  it('refuses a workspace the caller is not a member of', async () => {
    const created = await api('POST', '/api/databases', {
      workspaceId: otherWorkspaceId,
      name: 'Not mine',
    });
    expect(created.status).toBe(403);
    const rows = await db
      .select()
      .from(databases)
      .where(eq(databases.workspaceId, otherWorkspaceId));
    expect(rows).toHaveLength(0);
  });

  it('rejects a parent page in another workspace', async () => {
    const [foreignPage] = await db
      .insert(pages)
      .values({ workspaceId: otherWorkspaceId, ownerId: ctx.userId, order: 0 })
      .returning();

    const created = await api('POST', '/api/databases', {
      workspaceId: ctx.workspaceId,
      name: 'Inline',
      isInline: true,
      parentPageId: foreignPage.id,
    });
    expect(created.status).toBe(400);
    expect(created.body.error).toBe('Parent page is in a different workspace');
  });

  it('stores parentPageId for an inline database in the same workspace', async () => {
    const [hostPage] = await db
      .insert(pages)
      .values({ workspaceId: ctx.workspaceId, ownerId: ctx.userId, order: 0 })
      .returning();

    const created = await api('POST', '/api/databases', {
      workspaceId: ctx.workspaceId,
      name: 'Inline',
      isInline: true,
      parentPageId: hostPage.id,
    });
    expect(created.status).toBe(201);
    expect(asRecord(created.body.database).parentPageId).toBe(hostPage.id);
    expect(asRecord(created.body.database).isInline).toBe(true);
  });
});

describe('GET /api/databases', () => {
  it('lists this workspace only, excluding archived unless asked', async () => {
    const listedId = await createDatabase({ name: 'Listed' });
    const archivedId = await createDatabase({ name: 'Archived' });
    await api('PATCH', `/api/databases/${archivedId}`, { archived: true });

    const active = await api(
      'GET',
      `/api/databases?workspaceId=${ctx.workspaceId}`,
    );
    const activeIds = asArray(active.body.databases).map((d) => idOf(d));
    expect(activeIds).toContain(listedId);
    expect(activeIds).not.toContain(archivedId);

    const all = await api(
      'GET',
      `/api/databases?workspaceId=${ctx.workspaceId}&includeArchived=true`,
    );
    expect(asArray(all.body.databases).map((d) => idOf(d))).toContain(archivedId);
  });
});

describe('PATCH /api/databases/:id', () => {
  it('writes an explicit null and leaves an omitted field alone', async () => {
    const databaseId = await createDatabase({ icon: '📘', cover: 'c.png' });

    const renamed = await api('PATCH', `/api/databases/${databaseId}`, {
      name: 'Renamed',
    });
    expect(asRecord(renamed.body.database).icon).toBe('📘');
    expect(asRecord(renamed.body.database).cover).toBe('c.png');
    expect(asRecord(renamed.body.database).name).toBe('Renamed');

    const cleared = await api('PATCH', `/api/databases/${databaseId}`, {
      icon: null,
    });
    expect(asRecord(cleared.body.database).icon).toBeNull();
    expect(asRecord(cleared.body.database).cover).toBe('c.png');
  });
});

describe('DELETE /api/databases/:id', () => {
  it('archives by default and leaves the rows in place', async () => {
    const databaseId = await createDatabase();
    await api('POST', `/api/databases/${databaseId}/rows`, { title: 'Kept' });

    const deleted = await api('DELETE', `/api/databases/${databaseId}`);
    expect(deleted.status).toBe(200);
    expect(asRecord(deleted.body.database).archived).toBe(true);

    const rows = await db
      .select()
      .from(pages)
      .where(eq(pages.databaseId, databaseId));
    expect(rows).toHaveLength(1);
  });

  it('hard-deletes rows, their blocks, the views and the database together', async () => {
    const databaseId = await createDatabase();
    const row = await api('POST', `/api/databases/${databaseId}/rows`, {
      title: 'Doomed',
    });
    const rowId = idOf(row.body.row);
    await db
      .insert(blocks)
      .values({ pageId: rowId, type: 'paragraph', order: 0 });

    // Positive control: everything this asserts the absence of is present now.
    expect(
      await db.select().from(blocks).where(eq(blocks.pageId, rowId)),
    ).toHaveLength(1);

    const deleted = await api('DELETE', `/api/databases/${databaseId}?hard=true`);
    expect(deleted.status).toBe(200);
    expect(deleted.body.success).toBe(true);

    expect(
      await db.select().from(pages).where(eq(pages.databaseId, databaseId)),
    ).toHaveLength(0);
    expect(
      await db.select().from(blocks).where(eq(blocks.pageId, rowId)),
    ).toHaveLength(0);
    expect(
      await db
        .select()
        .from(databaseViews)
        .where(eq(databaseViews.databaseId, databaseId)),
    ).toHaveLength(0);
    expect(
      await db.select().from(databases).where(eq(databases.id, databaseId)),
    ).toHaveLength(0);
  });

  it('refuses a hard delete below owner role and destroys nothing', async () => {
    const databaseId = await createDatabase();
    await api('POST', `/api/databases/${databaseId}/rows`, { title: 'Safe' });

    ctx.role = 'editor';
    try {
      const refused = await api(
        'DELETE',
        `/api/databases/${databaseId}?hard=true`,
      );
      expect(refused.status).toBe(403);
    } finally {
      ctx.role = 'owner';
    }

    expect(
      await db.select().from(databases).where(eq(databases.id, databaseId)),
    ).toHaveLength(1);
    expect(
      await db.select().from(pages).where(eq(pages.databaseId, databaseId)),
    ).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// Properties
// ---------------------------------------------------------------------------

describe('properties', () => {
  it('adds a property, assigning option ids', async () => {
    const databaseId = await createDatabase();
    const added = await api('POST', `/api/databases/${databaseId}/properties`, {
      name: 'Priority',
      type: 'select',
      config: { options: [{ name: 'High' }] },
    });
    expect(added.status).toBe(201);

    const properties = asArray(
      asRecord(asRecord(added.body.database).schema).properties,
    ).map((p) => asRecord(p));
    const priority = properties.find((p) => p.name === 'Priority');
    expect(priority).toBeDefined();
    const options = asArray(asRecord(priority?.config).options).map((o) =>
      asRecord(o),
    );
    expect(typeof options[0].id).toBe('string');
    expect(options[0].color).toBe('default');
  });

  it('409s a duplicate property id without touching the stored schema', async () => {
    const databaseId = await createDatabase();
    const conflict = await api(
      'POST',
      `/api/databases/${databaseId}/properties`,
      { id: 'name', name: 'Name again', type: 'text' },
    );
    expect(conflict.status).toBe(409);

    const [stored] = await db
      .select()
      .from(databases)
      .where(eq(databases.id, databaseId));
    expect(stored.propertiesSchema.properties.map((p) => p.id)).toEqual([
      'name',
      'status',
    ]);
  });

  it('renames a property in place', async () => {
    const databaseId = await createDatabase();
    const renamed = await api(
      'PATCH',
      `/api/databases/${databaseId}/properties/status`,
      { name: 'Stage' },
    );
    expect(renamed.status).toBe(200);
    const [stored] = await db
      .select()
      .from(databases)
      .where(eq(databases.id, databaseId));
    const status = stored.propertiesSchema.properties.find(
      (p) => p.id === 'status',
    );
    expect(status?.name).toBe('Stage');
    expect(status?.type).toBe('status');
  });

  it('refuses to delete the Name property', async () => {
    const databaseId = await createDatabase();
    const refused = await api(
      'DELETE',
      `/api/databases/${databaseId}/properties/name`,
    );
    expect(refused.status).toBe(400);
    const [stored] = await db
      .select()
      .from(databases)
      .where(eq(databases.id, databaseId));
    expect(
      stored.propertiesSchema.properties.some((p) => p.id === 'name'),
    ).toBe(true);
  });

  it('drops the key from the schema and from every row that carries it', async () => {
    const databaseId = await createDatabase();
    const withValue = await api('POST', `/api/databases/${databaseId}/rows`, {
      title: 'Has status',
      properties: { status: { optionId: 'opt-1' } },
    });
    const withoutValue = await api('POST', `/api/databases/${databaseId}/rows`, {
      title: 'No status',
    });
    const withValueId = idOf(withValue.body.row);
    const withoutValueId = idOf(withoutValue.body.row);

    // Positive control: the key is there to be removed.
    const [before] = await db
      .select()
      .from(pages)
      .where(eq(pages.id, withValueId));
    expect(Object.keys(before.properties)).toContain('status');

    const dropped = await api(
      'DELETE',
      `/api/databases/${databaseId}/properties/status`,
    );
    expect(dropped.status).toBe(200);

    const [stored] = await db
      .select()
      .from(databases)
      .where(eq(databases.id, databaseId));
    expect(
      stored.propertiesSchema.properties.some((p) => p.id === 'status'),
    ).toBe(false);

    const [after] = await db
      .select()
      .from(pages)
      .where(eq(pages.id, withValueId));
    expect(Object.keys(after.properties)).not.toContain('status');

    // The degenerate case: removing a key a row never had leaves `{}`, not
    // null. `jsonb - text` on a missing key is a no-op, unlike a replacement.
    const [untouched] = await db
      .select()
      .from(pages)
      .where(eq(pages.id, withoutValueId));
    expect(untouched.properties).toEqual({});
  });
});

// ---------------------------------------------------------------------------
// Rows
// ---------------------------------------------------------------------------

describe('rows', () => {
  it('stores property values as jsonb and mirrors the name into the title', async () => {
    const databaseId = await createDatabase();
    const created = await api('POST', `/api/databases/${databaseId}/rows`, {
      properties: { name: { text: 'From the name property' } },
    });
    expect(created.status).toBe(201);
    expect(asRecord(created.body.row).title).toBe('From the name property');

    const [stored] = await db
      .select()
      .from(pages)
      .where(eq(pages.id, idOf(created.body.row)));
    expect(stored.properties).toEqual({ name: { text: 'From the name property' } });
    expect(stored.databaseId).toBe(databaseId);
    expect(stored.parentId).toBeNull();
  });

  it('drops keys naming an unknown or server-derived property', async () => {
    const databaseId = await createDatabase();
    const created = await api('POST', `/api/databases/${databaseId}/rows`, {
      title: 'Filtered',
      properties: {
        name: { text: 'Kept' },
        nope: { text: 'Unknown property' },
      },
    });
    const [stored] = await db
      .select()
      .from(pages)
      .where(eq(pages.id, idOf(created.body.row)));
    expect(Object.keys(stored.properties)).toEqual(['name']);
  });

  it('numbers rows from the highest existing order', async () => {
    const databaseId = await createDatabase();
    const first = await api('POST', `/api/databases/${databaseId}/rows`, {
      title: 'first',
    });
    const second = await api('POST', `/api/databases/${databaseId}/rows`, {
      title: 'second',
    });
    expect(asRecord(first.body.row).order).toBe(0);
    expect(asRecord(second.body.row).order).toBe(1);
  });

  it('lists live rows, filters in JS, and paginates by offset', async () => {
    const databaseId = await createDatabase();
    for (const title of ['alpha', 'beta', 'gamma']) {
      await api('POST', `/api/databases/${databaseId}/rows`, { title });
    }
    await db
      .update(pages)
      .set({ archived: true })
      .where(and(eq(pages.databaseId, databaseId), eq(pages.title, 'gamma')));

    const listed = await api('GET', `/api/databases/${databaseId}/rows`);
    expect(listed.status).toBe(200);
    expect(listed.body.total).toBe(2);
    expect(
      asArray(listed.body.rows).map((r) => asRecord(r).title),
    ).toEqual(['alpha', 'beta']);

    const searched = await api(
      'GET',
      `/api/databases/${databaseId}/rows?search=alp`,
    );
    expect(searched.body.total).toBe(1);

    const paged = await api(
      'GET',
      `/api/databases/${databaseId}/rows?pageSize=1`,
    );
    expect(asArray(paged.body.rows)).toHaveLength(1);
    expect(paged.body.cursor).toBe('1');
    const second = await api(
      'GET',
      `/api/databases/${databaseId}/rows?pageSize=1&cursor=1`,
    );
    expect(asRecord(asArray(second.body.rows)[0]).title).toBe('beta');
    expect(second.body.cursor).toBeNull();
  });

  it('applies a view filter and a view sort to the Postgres rows', async () => {
    const databaseId = await createDatabase();
    for (const title of ['keep me', 'drop me', 'keep also']) {
      await api('POST', `/api/databases/${databaseId}/rows`, { title });
    }

    const view = await api('POST', `/api/databases/${databaseId}/views`, {
      name: 'Keepers',
      type: 'table',
      filters: {
        kind: 'group',
        combinator: 'and',
        filters: [
          {
            kind: 'condition',
            propertyId: 'name',
            operator: 'contains',
            value: 'keep',
          },
        ],
      },
      sorts: [{ propertyId: 'name', direction: 'desc' }],
    });
    const viewId = idOf(view.body.view);

    const listed = await api(
      'GET',
      `/api/databases/${databaseId}/rows?viewId=${viewId}`,
    );
    expect(asArray(listed.body.rows).map((r) => asRecord(r).title)).toEqual([
      'keep me',
      'keep also',
    ]);
    expect(listed.body.total).toBe(2);
  });

  it('resolves created_time, created_by and formula properties at read time', async () => {
    const databaseId = await createDatabase({
      schema: {
        properties: [
          { id: 'name', name: 'Name', type: 'text' },
          { id: 'made', name: 'Made', type: 'created_time' },
          { id: 'by', name: 'By', type: 'created_by' },
          {
            id: 'calc',
            name: 'Calc',
            type: 'formula',
            config: { expression: '2 + 3' },
          },
        ],
      },
    });
    await api('POST', `/api/databases/${databaseId}/rows`, { title: 'Derived' });

    const listed = await api('GET', `/api/databases/${databaseId}/rows`);
    const properties = asRecord(asRecord(asArray(listed.body.rows)[0]).properties);
    expect(typeof asRecord(properties.made).start).toBe('string');
    expect(asRecord(properties.by).userIds).toEqual([ctx.userId]);
    expect(asRecord(properties.calc).number).toBe(5);
  });

  it('sums a rollup across rows referenced by uuid v7 ids', async () => {
    const targetId = await createDatabase({
      name: 'Amounts',
      schema: {
        properties: [
          { id: 'name', name: 'Name', type: 'text' },
          { id: 'amount', name: 'Amount', type: 'number' },
        ],
      },
    });
    const five = await api('POST', `/api/databases/${targetId}/rows`, {
      title: 'five',
      properties: { amount: { number: 5 } },
    });
    const seven = await api('POST', `/api/databases/${targetId}/rows`, {
      title: 'seven',
      properties: { amount: { number: 7 } },
    });

    const sourceId = await createDatabase({
      name: 'Rollups',
      schema: {
        properties: [
          { id: 'name', name: 'Name', type: 'text' },
          {
            id: 'rel',
            name: 'Related',
            type: 'relation',
            config: { targetDatabaseId: targetId },
          },
          {
            id: 'total',
            name: 'Total',
            type: 'rollup',
            config: {
              relationPropertyId: 'rel',
              targetPropertyId: 'amount',
              function: 'sum',
            },
          },
        ],
      },
    });

    // The write itself is half the regression: `relationValueSchema` used to
    // require a 24-hex id, so a relation naming uuid v7 rows was a 400.
    const created = await api('POST', `/api/databases/${sourceId}/rows`, {
      title: 'Sums',
      properties: {
        rel: { pageIds: [idOf(five.body.row), idOf(seven.body.row)] },
      },
    });
    expect(created.status).toBe(201);

    const listed = await api('GET', `/api/databases/${sourceId}/rows`);
    const properties = asRecord(asRecord(asArray(listed.body.rows)[0]).properties);
    expect(asRecord(properties.total).number).toBe(12);
  });

  it('counts an empty relation as 0 and a missing one as blank', async () => {
    const databaseId = await createDatabase({
      name: 'Empty rollups',
      schema: {
        properties: [
          { id: 'name', name: 'Name', type: 'text' },
          { id: 'rel', name: 'Related', type: 'relation' },
          {
            id: 'howMany',
            name: 'How many',
            type: 'rollup',
            config: {
              relationPropertyId: 'rel',
              targetPropertyId: 'amount',
              function: 'count',
            },
          },
        ],
      },
    });

    await api('POST', `/api/databases/${databaseId}/rows`, {
      title: 'empty list',
      properties: { rel: { pageIds: [] } },
    });
    await api('POST', `/api/databases/${databaseId}/rows`, {
      title: 'no relation at all',
    });

    const listed = await api('GET', `/api/databases/${databaseId}/rows`);
    const byTitle = new Map(
      asArray(listed.body.rows).map((r) => {
        const row = asRecord(r);
        return [String(row.title), asRecord(row.properties)];
      }),
    );
    expect(asRecord(byTitle.get('empty list')?.howMany).number).toBe(0);
    // No relation value at all is unresolvable, not zero — the em-dash case.
    expect(asRecord(byTitle.get('no relation at all')?.howMany).text).toBe('');
  });
});

// ---------------------------------------------------------------------------
// Views
// ---------------------------------------------------------------------------

describe('views', () => {
  it('creates a view after the last order and lists it in order', async () => {
    const databaseId = await createDatabase();
    const created = await api('POST', `/api/databases/${databaseId}/views`, {
      name: 'Board',
      type: 'board',
      groupBy: { propertyId: 'status' },
      hiddenProperties: [],
    });
    expect(created.status).toBe(201);
    expect(asRecord(created.body.view).order).toBe(1);
    expect(asRecord(asRecord(created.body.view).groupBy).propertyId).toBe(
      'status',
    );
    expect(asRecord(created.body.view).hiddenProperties).toEqual([]);

    const listed = await api('GET', `/api/databases/${databaseId}/views`);
    expect(asArray(listed.body.views).map((v) => asRecord(v).name)).toEqual([
      'All',
      'Board',
    ]);
  });

  it('honours an explicit order of 0 rather than treating it as absent', async () => {
    const databaseId = await createDatabase();
    const created = await api('POST', `/api/databases/${databaseId}/views`, {
      name: 'First',
      type: 'table',
      order: 0,
    });
    expect(asRecord(created.body.view).order).toBe(0);
  });

  it('promotes a view to default and demotes the previous one', async () => {
    const databaseId = await createDatabase();
    const created = await api('POST', `/api/databases/${databaseId}/views`, {
      name: 'Gallery',
      type: 'gallery',
    });
    const promotedId = idOf(created.body.view);

    const promoted = await api(
      'PATCH',
      `/api/databases/${databaseId}/views/${promotedId}`,
      { isDefault: true },
    );
    expect(promoted.status).toBe(200);

    const stored = await db
      .select()
      .from(databaseViews)
      .where(eq(databaseViews.databaseId, databaseId));
    expect(stored.filter((v) => v.isDefault).map((v) => v.id)).toEqual([
      promotedId,
    ]);
  });

  it('distinguishes an omitted groupBy from an explicit null', async () => {
    const databaseId = await createDatabase();
    const created = await api('POST', `/api/databases/${databaseId}/views`, {
      name: 'Board',
      type: 'board',
      groupBy: { propertyId: 'status' },
    });
    const viewId = idOf(created.body.view);

    const renamed = await api(
      'PATCH',
      `/api/databases/${databaseId}/views/${viewId}`,
      { name: 'Renamed' },
    );
    expect(asRecord(asRecord(renamed.body.view).groupBy).propertyId).toBe(
      'status',
    );

    const ungrouped = await api(
      'PATCH',
      `/api/databases/${databaseId}/views/${viewId}`,
      { groupBy: null },
    );
    expect(asRecord(ungrouped.body.view).groupBy).toBeNull();
  });

  it('refuses a view belonging to another database', async () => {
    const first = await createDatabase();
    const second = await createDatabase();
    const stolen = await db
      .select()
      .from(databaseViews)
      .where(eq(databaseViews.databaseId, second));

    const patched = await api(
      'PATCH',
      `/api/databases/${first}/views/${stolen[0].id}`,
      { name: 'Nope' },
    );
    expect(patched.status).toBe(404);
    const [unchanged] = await db
      .select()
      .from(databaseViews)
      .where(eq(databaseViews.id, stolen[0].id));
    expect(unchanged.name).toBe('All');
  });

  it('refuses to delete the last view', async () => {
    const databaseId = await createDatabase();
    const [only] = await db
      .select()
      .from(databaseViews)
      .where(eq(databaseViews.databaseId, databaseId));

    const refused = await api(
      'DELETE',
      `/api/databases/${databaseId}/views/${only.id}`,
    );
    expect(refused.status).toBe(400);
    expect(
      await db
        .select()
        .from(databaseViews)
        .where(eq(databaseViews.databaseId, databaseId)),
    ).toHaveLength(1);
  });

  it('promotes the next view when the default is deleted', async () => {
    const databaseId = await createDatabase();
    const [original] = await db
      .select()
      .from(databaseViews)
      .where(eq(databaseViews.databaseId, databaseId));
    const extra = await api('POST', `/api/databases/${databaseId}/views`, {
      name: 'Second',
      type: 'list',
    });
    const extraId = idOf(extra.body.view);

    const deleted = await api(
      'DELETE',
      `/api/databases/${databaseId}/views/${original.id}`,
    );
    expect(deleted.status).toBe(200);

    const remaining = await db
      .select()
      .from(databaseViews)
      .where(eq(databaseViews.databaseId, databaseId));
    expect(remaining.map((v) => v.id)).toEqual([extraId]);
    expect(remaining[0].isDefault).toBe(true);
  });
});
