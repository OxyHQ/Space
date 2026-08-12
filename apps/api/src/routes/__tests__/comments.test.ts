import { describe, it, expect, vi, beforeEach } from 'vitest';

// ── Mocks ─────────────────────────────────────────────────────────────

// The route talks to repositories now, so these mock the repositories. Mocking
// the old models would have left every assertion below passing against a double
// nothing calls — the shape of a test that measures itself.
vi.mock('../../db/client.js', () => ({ getDb: vi.fn(() => ({})) }));

vi.mock('../../repositories/comments.js', () => ({
  createComment: vi.fn(),
  listCommentsByPage: vi.fn(),
  listCommentsByBlock: vi.fn(),
  findCommentById: vi.fn(),
  updateCommentContent: vi.fn(),
  setCommentResolvedAt: vi.fn(),
  deleteComment: vi.fn(),
  deleteCommentThread: vi.fn(),
}));

vi.mock('../../repositories/pages.js', () => ({
  findPageById: vi.fn(),
  findPagesByIds: vi.fn(),
}));

vi.mock('../../repositories/blocks.js', () => ({
  findBlockById: vi.fn(),
}));

vi.mock('../../repositories/workspaces.js', () => ({
  listMembershipsForUsers: vi.fn(),
  findMembership: vi.fn(),
}));

vi.mock('../../middleware/auth.js', () => ({
  authenticateToken: vi.fn((_req: any, _res: any, next: any) => next()),
}));

vi.mock('../../middleware/workspace.js', () => ({
  requireWorkspaceMember: vi.fn((_req: any, _res: any, next: any) => next()),
}));

vi.mock('../../lib/notification-service.js', () => ({
  sendNotification: vi.fn().mockResolvedValue({}),
}));

vi.mock('../../lib/logger.js', () => ({
  log: {
    general: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
  },
}));

import * as commentsRepo from '../../repositories/comments.js';
import * as pagesRepo from '../../repositories/pages.js';
import * as blocksRepo from '../../repositories/blocks.js';
import * as workspacesRepo from '../../repositories/workspaces.js';
import commentsRouter from '../comments.js';

const mockComment = commentsRepo as unknown as Record<string, ReturnType<typeof vi.fn>>;
const mockBlock = blocksRepo as unknown as Record<string, ReturnType<typeof vi.fn>>;
const mockPage = pagesRepo as unknown as Record<string, ReturnType<typeof vi.fn>>;
const mockMember = workspacesRepo as unknown as Record<string, ReturnType<typeof vi.fn>>;

interface RouteLayer {
  route?: {
    path: string;
    stack: { method: string; handle: (req: unknown, res: unknown, next?: unknown) => unknown }[];
  };
}

function findHandler(
  method: 'get' | 'post' | 'patch' | 'delete',
  path: string,
): (req: unknown, res: unknown) => unknown {
  const stack = (commentsRouter as unknown as { stack: RouteLayer[] }).stack;
  for (const layer of stack) {
    if (!layer.route) continue;
    if (layer.route.path !== path) continue;
    const found = layer.route.stack.find((s) => s.method === method);
    if (found) return found.handle as (req: unknown, res: unknown) => unknown;
  }
  throw new Error(`No handler for ${method.toUpperCase()} ${path}`);
}

function makeReq(overrides: Record<string, unknown> = {}) {
  return {
    user: { id: 'user-1' },
    headers: {},
    body: {},
    query: {},
    params: {},
    member: { role: 'editor' },
    ...overrides,
  } as Record<string, unknown> & { user: { id: string } };
}

function makeRes() {
  const res: { status: ReturnType<typeof vi.fn>; json: ReturnType<typeof vi.fn>; headersSent: boolean } = {
    status: vi.fn(),
    json: vi.fn(),
    headersSent: false,
  };
  res.status.mockReturnValue(res);
  res.json.mockReturnValue(res);
  return res;
}

const WORKSPACE_ID = 'ws-0000000000000001';
const PAGE_ID = 'page-000000000000001';
const BLOCK_ID = 'block-00000000000001';
const USER_ID = 'user-1';

let idCounter = 0;
function randomId(): string {
  idCounter += 1;
  return `id-${idCounter}`;
}

describe('comments route', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // Default: page exists, user is workspace member.
    mockPage.findPageById.mockResolvedValue({
          id: PAGE_ID,
          workspaceId: WORKSPACE_ID,
          title: 'Sample page',
        });
  });

  describe('POST /pages/:pageId/comments', () => {
    it('creates a page-level comment', async () => {
      mockComment.createComment.mockResolvedValue({
        id: randomId(),
        workspaceId: WORKSPACE_ID,
        pageId: PAGE_ID,
        blockId: null,
        parentCommentId: null,
        authorId: USER_ID,
        content: { segments: [{ type: 'text', text: 'Hello' }], plainText: 'Hello' },
        resolvedAt: null,
        editedAt: null,
        createdAt: new Date(),
        updatedAt: new Date(),
      });

      const handler = findHandler('post', '/pages/:pageId/comments');
      const req = makeReq({
        params: { pageId: PAGE_ID },
        body: {
          content: { segments: [{ type: 'text', text: 'Hello' }] },
        },
      });
      const res = makeRes();
      await handler(req, res);

      expect(res.status).toHaveBeenCalledWith(201);
      expect(mockComment.createComment).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({
          workspaceId: WORKSPACE_ID,
          pageId: PAGE_ID,
          blockId: null,
          parentCommentId: null,
          authorId: USER_ID,
        }),
      );
      const calledWith = mockComment.createComment.mock.calls[0][1] as {
        content: { plainText: string };
      };
      expect(calledWith.content.plainText).toBe('Hello');
    });

    it('rejects empty content (Zod)', async () => {
      const handler = findHandler('post', '/pages/:pageId/comments');
      const req = makeReq({
        params: { pageId: PAGE_ID },
        body: { content: { segments: [] } },
      });
      const res = makeRes();
      await handler(req, res);
      expect(res.status).toHaveBeenCalledWith(400);
    });

    it('validates a user mention belongs to the workspace', async () => {
      mockMember.listMembershipsForUsers.mockResolvedValue([]);
      const handler = findHandler('post', '/pages/:pageId/comments');
      const req = makeReq({
        params: { pageId: PAGE_ID },
        body: {
          content: {
            segments: [
              {
                type: 'mention',
                kind: 'user',
                id: 'user-not-in-workspace',
                originalText: '@stranger',
              },
            ],
          },
        },
      });
      const res = makeRes();
      await handler(req, res);
      expect(res.status).toHaveBeenCalledWith(400);
    });

    it('attaches block when blockId provided and belongs to the page', async () => {
      mockBlock.findBlockById.mockResolvedValue({
            id: BLOCK_ID,
            pageId: PAGE_ID,
          });
      mockComment.createComment.mockResolvedValue({
        id: randomId(),
        workspaceId: WORKSPACE_ID,
        pageId: PAGE_ID,
        blockId: BLOCK_ID,
        parentCommentId: null,
        authorId: USER_ID,
        content: { segments: [{ type: 'text', text: 'On a block' }], plainText: 'On a block' },
        resolvedAt: null,
        editedAt: null,
        createdAt: new Date(),
        updatedAt: new Date(),
      });
      const handler = findHandler('post', '/pages/:pageId/comments');
      const req = makeReq({
        params: { pageId: PAGE_ID },
        body: {
          blockId: BLOCK_ID,
          content: { segments: [{ type: 'text', text: 'On a block' }] },
        },
      });
      const res = makeRes();
      await handler(req, res);
      expect(res.status).toHaveBeenCalledWith(201);
    });
  });

  describe('GET /pages/:pageId/comments', () => {
    it('lists comments, hides resolved threads by default', async () => {
      const rootOpen = {
        id: randomId(),
        workspaceId: WORKSPACE_ID,
        pageId: PAGE_ID,
        blockId: null,
        parentCommentId: null,
        authorId: USER_ID,
        content: { segments: [{ type: 'text', text: 'open' }], plainText: 'open' },
        resolvedAt: null,
        editedAt: null,
        createdAt: new Date(),
        updatedAt: new Date(),
      };
      const rootResolved = {
        id: randomId(),
        workspaceId: WORKSPACE_ID,
        pageId: PAGE_ID,
        blockId: null,
        parentCommentId: null,
        authorId: USER_ID,
        content: { segments: [{ type: 'text', text: 'done' }], plainText: 'done' },
        resolvedAt: new Date(),
        editedAt: null,
        createdAt: new Date(),
        updatedAt: new Date(),
      };
      mockComment.listCommentsByPage.mockResolvedValue([rootOpen, rootResolved]);

      const handler = findHandler('get', '/pages/:pageId/comments');
      const req = makeReq({
        params: { pageId: PAGE_ID },
        query: {},
      });
      const res = makeRes();
      await handler(req, res);

      expect(res.json).toHaveBeenCalled();
      const result = res.json.mock.calls[0][0] as { comments: { id: string }[] };
      expect(result.comments).toHaveLength(1);
      expect(result.comments[0].id).toBe(String(rootOpen.id));
    });
  });

  describe('POST /comments/:id/resolve', () => {
    it('sets resolvedAt on top-level threads', async () => {
      const comment = {
        id: randomId(),
        workspaceId: WORKSPACE_ID,
        pageId: PAGE_ID,
        blockId: null,
        parentCommentId: null,
        authorId: USER_ID,
        content: { segments: [], plainText: '' },
        resolvedAt: null,
        editedAt: null,
        createdAt: new Date(),
        updatedAt: new Date(),
      };
      mockComment.findCommentById.mockResolvedValue(comment);

      const handler = findHandler('post', '/comments/:id/resolve');
      const req = makeReq({ params: { id: String(comment.id) } });
      const res = makeRes();
      await handler(req, res);

      expect(mockComment.setCommentResolvedAt).toHaveBeenCalledWith(
        expect.anything(),
        comment.id,
        expect.any(Date),
      );
    });

    it('refuses to resolve a reply', async () => {
      const comment = {
        id: randomId(),
        workspaceId: WORKSPACE_ID,
        pageId: PAGE_ID,
        blockId: null,
        parentCommentId: randomId(),
        authorId: USER_ID,
        content: { segments: [], plainText: '' },
        resolvedAt: null,
        editedAt: null,
        createdAt: new Date(),
        updatedAt: new Date(),
      };
      mockComment.findCommentById.mockResolvedValue(comment);

      const handler = findHandler('post', '/comments/:id/resolve');
      const req = makeReq({ params: { id: String(comment.id) } });
      const res = makeRes();
      await handler(req, res);

      expect(mockComment.setCommentResolvedAt).not.toHaveBeenCalled();
      expect(res.status).toHaveBeenCalledWith(400);
    });
  });

  describe('DELETE /comments/:id', () => {
    it('lets the author delete their own comment', async () => {
      const comment = {
        id: randomId(),
        workspaceId: WORKSPACE_ID,
        pageId: PAGE_ID,
        blockId: null,
        parentCommentId: randomId(),
        authorId: USER_ID,
        content: { segments: [], plainText: '' },
        resolvedAt: null,
        editedAt: null,
        createdAt: new Date(),
        updatedAt: new Date(),
      };
      mockComment.findCommentById.mockResolvedValue(comment);
      mockComment.deleteComment.mockResolvedValue({ deletedCount: 1 });

      const handler = findHandler('delete', '/comments/:id');
      const req = makeReq({ params: { id: String(comment.id) } });
      const res = makeRes();
      await handler(req, res);

      expect(mockComment.deleteComment).toHaveBeenCalled();
      expect(res.json).toHaveBeenCalledWith({ success: true });
    });

    it('cascades when deleting a top-level thread', async () => {
      const comment = {
        id: randomId(),
        workspaceId: WORKSPACE_ID,
        pageId: PAGE_ID,
        blockId: null,
        parentCommentId: null,
        authorId: USER_ID,
        content: { segments: [], plainText: '' },
        resolvedAt: null,
        editedAt: null,
        createdAt: new Date(),
        updatedAt: new Date(),
      };
      mockComment.findCommentById.mockResolvedValue(comment);
      mockComment.deleteCommentThread.mockResolvedValue({ deletedCount: 3 });

      const handler = findHandler('delete', '/comments/:id');
      const req = makeReq({ params: { id: String(comment.id) } });
      const res = makeRes();
      await handler(req, res);

      // The cascade is the repository's job now — and the database's, via
      // `comments.parentCommentId` — rather than an $or the route assembles.
      expect(mockComment.deleteCommentThread).toHaveBeenCalledWith(
        expect.anything(),
        comment.id,
      );
      expect(mockComment.deleteComment).not.toHaveBeenCalled();
    });

    it('rejects non-author non-admin', async () => {
      const comment = {
        id: randomId(),
        workspaceId: WORKSPACE_ID,
        pageId: PAGE_ID,
        blockId: null,
        parentCommentId: null,
        authorId: 'someone-else',
        content: { segments: [], plainText: '' },
        resolvedAt: null,
        editedAt: null,
        createdAt: new Date(),
        updatedAt: new Date(),
      };
      mockComment.findCommentById.mockResolvedValue(comment);

      const handler = findHandler('delete', '/comments/:id');
      const req = makeReq({
        params: { id: String(comment.id) },
        member: { role: 'editor' },
      });
      const res = makeRes();
      await handler(req, res);

      expect(res.status).toHaveBeenCalledWith(403);
    });

    it('lets an admin delete a non-author comment', async () => {
      const comment = {
        id: randomId(),
        workspaceId: WORKSPACE_ID,
        pageId: PAGE_ID,
        blockId: null,
        parentCommentId: null,
        authorId: 'someone-else',
        content: { segments: [], plainText: '' },
        resolvedAt: null,
        editedAt: null,
        createdAt: new Date(),
        updatedAt: new Date(),
      };
      mockComment.findCommentById.mockResolvedValue(comment);
      mockComment.deleteCommentThread.mockResolvedValue({ deletedCount: 1 });

      const handler = findHandler('delete', '/comments/:id');
      const req = makeReq({
        params: { id: String(comment.id) },
        member: { role: 'admin' },
      });
      const res = makeRes();
      await handler(req, res);

      expect(mockComment.deleteCommentThread).toHaveBeenCalled();
    });
  });
});
