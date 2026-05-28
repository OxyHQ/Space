import { describe, it, expect, vi, beforeEach } from 'vitest';
import mongoose from 'mongoose';

// ── Mocks ─────────────────────────────────────────────────────────────

vi.mock('../../models/comment.js', () => ({
  Comment: {
    create: vi.fn(),
    find: vi.fn(),
    findById: vi.fn(),
    findOne: vi.fn(),
    deleteOne: vi.fn(),
    deleteMany: vi.fn(),
  },
}));

vi.mock('../../models/block.js', () => ({
  Block: { findById: vi.fn() },
}));

vi.mock('../../models/page.js', () => ({
  Page: { findById: vi.fn(), find: vi.fn() },
}));

vi.mock('../../models/workspace-member.js', async () => {
  const actual = await vi.importActual<typeof import('../../models/workspace-member.js')>(
    '../../models/workspace-member.js',
  );
  return { ...actual, WorkspaceMember: { find: vi.fn(), findOne: vi.fn() } };
});

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

import { Comment } from '../../models/comment.js';
import { Block } from '../../models/block.js';
import { Page } from '../../models/page.js';
import { WorkspaceMember } from '../../models/workspace-member.js';
import commentsRouter from '../comments.js';

const mockComment = Comment as unknown as Record<string, ReturnType<typeof vi.fn>>;
const mockBlock = Block as unknown as Record<string, ReturnType<typeof vi.fn>>;
const mockPage = Page as unknown as Record<string, ReturnType<typeof vi.fn>>;
const mockMember = WorkspaceMember as unknown as Record<string, ReturnType<typeof vi.fn>>;

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

const WORKSPACE_ID = new mongoose.Types.ObjectId();
const PAGE_ID = new mongoose.Types.ObjectId();
const BLOCK_ID = new mongoose.Types.ObjectId();
const USER_ID = 'user-1';

describe('comments route', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // Default: page exists, user is workspace member.
    mockPage.findById.mockImplementation(() => ({
      select: vi.fn().mockReturnValue({
        lean: vi.fn().mockResolvedValue({
          _id: PAGE_ID,
          workspaceId: WORKSPACE_ID,
          title: 'Sample page',
        }),
      }),
    }));
  });

  describe('POST /pages/:pageId/comments', () => {
    it('creates a page-level comment', async () => {
      mockComment.create.mockResolvedValue({
        _id: new mongoose.Types.ObjectId(),
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
        params: { pageId: PAGE_ID.toHexString() },
        body: {
          content: { segments: [{ type: 'text', text: 'Hello' }] },
        },
      });
      const res = makeRes();
      await handler(req, res);

      expect(res.status).toHaveBeenCalledWith(201);
      expect(mockComment.create).toHaveBeenCalledWith(
        expect.objectContaining({
          workspaceId: WORKSPACE_ID,
          pageId: PAGE_ID,
          blockId: null,
          parentCommentId: null,
          authorId: USER_ID,
        }),
      );
      const calledWith = mockComment.create.mock.calls[0][0] as {
        content: { plainText: string };
      };
      expect(calledWith.content.plainText).toBe('Hello');
    });

    it('rejects empty content (Zod)', async () => {
      const handler = findHandler('post', '/pages/:pageId/comments');
      const req = makeReq({
        params: { pageId: PAGE_ID.toHexString() },
        body: { content: { segments: [] } },
      });
      const res = makeRes();
      await handler(req, res);
      expect(res.status).toHaveBeenCalledWith(400);
    });

    it('validates a user mention belongs to the workspace', async () => {
      mockMember.find.mockReturnValue({
        select: vi.fn().mockReturnValue({
          lean: vi.fn().mockResolvedValue([]),
        }),
      });
      const handler = findHandler('post', '/pages/:pageId/comments');
      const req = makeReq({
        params: { pageId: PAGE_ID.toHexString() },
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
      mockBlock.findById.mockReturnValue({
        select: vi.fn().mockReturnValue({
          lean: vi.fn().mockResolvedValue({
            _id: BLOCK_ID,
            pageId: PAGE_ID,
          }),
        }),
      });
      mockComment.create.mockResolvedValue({
        _id: new mongoose.Types.ObjectId(),
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
        params: { pageId: PAGE_ID.toHexString() },
        body: {
          blockId: BLOCK_ID.toHexString(),
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
        _id: new mongoose.Types.ObjectId(),
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
        _id: new mongoose.Types.ObjectId(),
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
      mockComment.find.mockReturnValue({
        sort: vi.fn().mockReturnValue({
          lean: vi.fn().mockResolvedValue([rootOpen, rootResolved]),
        }),
      });

      const handler = findHandler('get', '/pages/:pageId/comments');
      const req = makeReq({
        params: { pageId: PAGE_ID.toHexString() },
        query: {},
      });
      const res = makeRes();
      await handler(req, res);

      expect(res.json).toHaveBeenCalled();
      const result = res.json.mock.calls[0][0] as { comments: { id: string }[] };
      expect(result.comments).toHaveLength(1);
      expect(result.comments[0].id).toBe(String(rootOpen._id));
    });
  });

  describe('POST /comments/:id/resolve', () => {
    it('sets resolvedAt on top-level threads', async () => {
      const save = vi.fn();
      const comment = {
        _id: new mongoose.Types.ObjectId(),
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
        save,
      };
      mockComment.findById.mockResolvedValue(comment);

      const handler = findHandler('post', '/comments/:id/resolve');
      const req = makeReq({ params: { id: String(comment._id) } });
      const res = makeRes();
      await handler(req, res);

      expect(save).toHaveBeenCalled();
      expect(comment.resolvedAt).toBeInstanceOf(Date);
    });

    it('refuses to resolve a reply', async () => {
      const save = vi.fn();
      const comment = {
        _id: new mongoose.Types.ObjectId(),
        workspaceId: WORKSPACE_ID,
        pageId: PAGE_ID,
        blockId: null,
        parentCommentId: new mongoose.Types.ObjectId(),
        authorId: USER_ID,
        content: { segments: [], plainText: '' },
        resolvedAt: null,
        editedAt: null,
        createdAt: new Date(),
        updatedAt: new Date(),
        save,
      };
      mockComment.findById.mockResolvedValue(comment);

      const handler = findHandler('post', '/comments/:id/resolve');
      const req = makeReq({ params: { id: String(comment._id) } });
      const res = makeRes();
      await handler(req, res);

      expect(save).not.toHaveBeenCalled();
      expect(res.status).toHaveBeenCalledWith(400);
    });
  });

  describe('DELETE /comments/:id', () => {
    it('lets the author delete their own comment', async () => {
      const comment = {
        _id: new mongoose.Types.ObjectId(),
        workspaceId: WORKSPACE_ID,
        pageId: PAGE_ID,
        blockId: null,
        parentCommentId: new mongoose.Types.ObjectId(),
        authorId: USER_ID,
        content: { segments: [], plainText: '' },
        resolvedAt: null,
        editedAt: null,
        createdAt: new Date(),
        updatedAt: new Date(),
      };
      mockComment.findById.mockResolvedValue(comment);
      mockComment.deleteOne.mockResolvedValue({ deletedCount: 1 });

      const handler = findHandler('delete', '/comments/:id');
      const req = makeReq({ params: { id: String(comment._id) } });
      const res = makeRes();
      await handler(req, res);

      expect(mockComment.deleteOne).toHaveBeenCalled();
      expect(res.json).toHaveBeenCalledWith({ success: true });
    });

    it('cascades when deleting a top-level thread', async () => {
      const comment = {
        _id: new mongoose.Types.ObjectId(),
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
      mockComment.findById.mockResolvedValue(comment);
      mockComment.deleteMany.mockResolvedValue({ deletedCount: 3 });

      const handler = findHandler('delete', '/comments/:id');
      const req = makeReq({ params: { id: String(comment._id) } });
      const res = makeRes();
      await handler(req, res);

      expect(mockComment.deleteMany).toHaveBeenCalledWith({
        $or: [{ _id: comment._id }, { parentCommentId: comment._id }],
      });
    });

    it('rejects non-author non-admin', async () => {
      const comment = {
        _id: new mongoose.Types.ObjectId(),
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
      mockComment.findById.mockResolvedValue(comment);

      const handler = findHandler('delete', '/comments/:id');
      const req = makeReq({
        params: { id: String(comment._id) },
        member: { role: 'editor' },
      });
      const res = makeRes();
      await handler(req, res);

      expect(res.status).toHaveBeenCalledWith(403);
    });

    it('lets an admin delete a non-author comment', async () => {
      const comment = {
        _id: new mongoose.Types.ObjectId(),
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
      mockComment.findById.mockResolvedValue(comment);
      mockComment.deleteMany.mockResolvedValue({ deletedCount: 1 });

      const handler = findHandler('delete', '/comments/:id');
      const req = makeReq({
        params: { id: String(comment._id) },
        member: { role: 'admin' },
      });
      const res = makeRes();
      await handler(req, res);

      expect(mockComment.deleteMany).toHaveBeenCalled();
    });
  });
});
