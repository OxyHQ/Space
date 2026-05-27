import { Router } from 'express';
import type { NextFunction, Request, Response } from 'express';
import mongoose from 'mongoose';
import { z } from 'zod';
import { Page, type IPage } from '../models/page.js';
import { Block } from '../models/block.js';
import { authenticateToken } from '../middleware/auth.js';
import { requireWorkspaceMember } from '../middleware/workspace.js';
import { log } from '../lib/logger.js';

const router = Router();

// All page routes require an authenticated Oxy user.
router.use(authenticateToken);

/**
 * Zod helper: 24-char hex MongoDB ObjectId.
 * Using `mongoose.Types.ObjectId.isValid` is more permissive than we want
 * (accepts 12-byte strings); restrict to the canonical hex form.
 */
const objectIdSchema = z
  .string()
  .regex(/^[0-9a-fA-F]{24}$/u, 'Invalid id');

const listQuerySchema = z.object({
  workspaceId: objectIdSchema,
  parentId: z
    .union([objectIdSchema, z.literal('null'), z.literal('root')])
    .optional(),
  includeArchived: z
    .union([z.literal('true'), z.literal('false')])
    .optional()
    .transform((v) => v === 'true'),
});

const createPageSchema = z.object({
  workspaceId: objectIdSchema,
  parentId: objectIdSchema.nullable().optional(),
  title: z.string().max(2000).optional(),
  icon: z.string().max(200).nullable().optional(),
  cover: z.string().max(2000).nullable().optional(),
});

const updatePageSchema = z
  .object({
    title: z.string().max(2000).optional(),
    icon: z.string().max(200).nullable().optional(),
    cover: z.string().max(2000).nullable().optional(),
    parentId: objectIdSchema.nullable().optional(),
    order: z.number().finite().optional(),
    archived: z.boolean().optional(),
  })
  .refine((data) => Object.keys(data).length > 0, {
    message: 'At least one field is required',
  });

function handleZodError(err: unknown, res: Response): boolean {
  if (err instanceof z.ZodError) {
    res.status(400).json({ error: 'Invalid input', details: err.errors });
    return true;
  }
  return false;
}

function assertWorkspace(req: Request, res: Response): string | null {
  const workspaceId = req.workspace?.id;
  if (!workspaceId) {
    res.status(400).json({ error: 'Workspace context required' });
    return null;
  }
  return workspaceId;
}

/**
 * Sets the X-Workspace-Id header from the given page's workspaceId, then
 * runs `requireWorkspaceMember` inline. Returns true if the caller is a
 * member; false (with a response already sent) otherwise.
 *
 * Used by `:id`-style routes where the workspace is not in the URL/query
 * but is derived from the loaded resource.
 */
async function checkWorkspaceMembership(
  req: Request,
  res: Response,
  workspaceId: mongoose.Types.ObjectId | string,
): Promise<boolean> {
  req.headers['x-workspace-id'] = String(workspaceId);
  const passed = await new Promise<boolean>((resolve) => {
    const next: NextFunction = (err?: unknown) => {
      if (err) {
        log.general.error({ err }, 'Workspace membership middleware errored');
        if (!res.headersSent) {
          res.status(500).json({ error: 'Workspace membership check failed' });
        }
        resolve(false);
        return;
      }
      resolve(true);
    };
    requireWorkspaceMember(req, res, next);
  });
  if (!passed) return false;
  return !res.headersSent;
}

/**
 * Subset of `IPage` shared by both Mongoose Documents and lean POJOs —
 * everything `serializePage` reads.
 */
type SerializablePage = Pick<
  IPage,
  | '_id'
  | 'workspaceId'
  | 'parentId'
  | 'title'
  | 'icon'
  | 'cover'
  | 'ownerId'
  | 'archived'
  | 'order'
  | 'createdAt'
  | 'updatedAt'
>;

function serializePage(page: SerializablePage) {
  return {
    id: String(page._id),
    workspaceId: String(page.workspaceId),
    parentId: page.parentId ? String(page.parentId) : null,
    title: page.title,
    icon: page.icon,
    cover: page.cover,
    ownerId: page.ownerId,
    archived: page.archived,
    order: page.order,
    createdAt: page.createdAt,
    updatedAt: page.updatedAt,
  };
}

/**
 * GET /api/pages?workspaceId=...[&parentId=...][&includeArchived=false]
 * Returns a flat list. Frontend builds the tree.
 */
// `requireWorkspaceMember` resolves the workspace id from (in order) route
// param, ?workspaceId=..., or X-Workspace-Id header — so listing only needs
// the query string.
router.get(
  '/',
  requireWorkspaceMember,
  async (req: Request, res: Response) => {
    try {
      const query = listQuerySchema.parse(req.query);
      const workspaceId = assertWorkspace(req, res);
      if (!workspaceId) return;

      if (query.workspaceId !== workspaceId) {
        res.status(403).json({ error: 'Workspace mismatch' });
        return;
      }

      const filter: Record<string, unknown> = {
        workspaceId: new mongoose.Types.ObjectId(workspaceId),
      };

      if (query.parentId !== undefined) {
        filter.parentId =
          query.parentId === 'null' || query.parentId === 'root'
            ? null
            : new mongoose.Types.ObjectId(query.parentId);
      }

      if (!query.includeArchived) {
        filter.archived = false;
      }

      const pages = await Page.find(filter)
        .sort({ order: 1, createdAt: 1 })
        .lean();

      res.json({ pages: pages.map((p) => serializePage(p)) });
    } catch (error: unknown) {
      if (handleZodError(error, res)) return;
      log.general.error({ err: error }, 'Failed to list pages');
      res.status(500).json({ error: 'Failed to list pages' });
    }
  },
);

/**
 * GET /api/pages/:id
 */
router.get('/:id', async (req: Request, res: Response) => {
  try {
    const params = z.object({ id: objectIdSchema }).parse(req.params);

    const page = await Page.findById(params.id).lean();
    if (!page) {
      res.status(404).json({ error: 'Page not found' });
      return;
    }

    const ok = await checkWorkspaceMembership(req, res, page.workspaceId);
    if (!ok) return;

    res.json({ page: serializePage(page) });
  } catch (error: unknown) {
    if (handleZodError(error, res)) return;
    log.general.error({ err: error }, 'Failed to fetch page');
    res.status(500).json({ error: 'Failed to fetch page' });
  }
});

/**
 * POST /api/pages
 */
router.post(
  '/',
  (req, res, next) => {
    const wsFromBody = typeof req.body?.workspaceId === 'string' ? req.body.workspaceId : undefined;
    if (wsFromBody && !req.headers['x-workspace-id']) {
      req.headers['x-workspace-id'] = wsFromBody;
    }
    next();
  },
  requireWorkspaceMember,
  async (req: Request, res: Response) => {
    try {
      const body = createPageSchema.parse(req.body);
      const workspaceId = assertWorkspace(req, res);
      if (!workspaceId) return;
      if (body.workspaceId !== workspaceId) {
        res.status(403).json({ error: 'Workspace mismatch' });
        return;
      }

      const userId = req.user?.id;
      if (!userId) {
        res.status(401).json({ error: 'Unauthorized' });
        return;
      }

      // If parentId provided, ensure the parent belongs to the same workspace.
      if (body.parentId) {
        const parent = await Page.findById(body.parentId).select('workspaceId').lean();
        if (!parent) {
          res.status(404).json({ error: 'Parent page not found' });
          return;
        }
        if (String(parent.workspaceId) !== workspaceId) {
          res.status(400).json({ error: 'Parent page is in a different workspace' });
          return;
        }
      }

      // Compute next order: max(order) + 1 among siblings.
      const siblingFilter: Record<string, unknown> = {
        workspaceId: new mongoose.Types.ObjectId(workspaceId),
        parentId: body.parentId
          ? new mongoose.Types.ObjectId(body.parentId)
          : null,
      };
      const last = await Page.findOne(siblingFilter)
        .sort({ order: -1 })
        .select('order')
        .lean();
      const nextOrder = last ? last.order + 1 : 0;

      const page = await Page.create({
        workspaceId: new mongoose.Types.ObjectId(workspaceId),
        parentId: body.parentId
          ? new mongoose.Types.ObjectId(body.parentId)
          : null,
        title: body.title ?? '',
        icon: body.icon ?? null,
        cover: body.cover ?? null,
        ownerId: userId,
        archived: false,
        order: nextOrder,
      });

      res.status(201).json({ page: serializePage(page) });
    } catch (error: unknown) {
      if (handleZodError(error, res)) return;
      log.general.error({ err: error }, 'Failed to create page');
      res.status(500).json({ error: 'Failed to create page' });
    }
  },
);

/**
 * PATCH /api/pages/:id
 */
router.patch('/:id', async (req: Request, res: Response) => {
  try {
    const params = z.object({ id: objectIdSchema }).parse(req.params);
    const body = updatePageSchema.parse(req.body);

    const page = await Page.findById(params.id);
    if (!page) {
      res.status(404).json({ error: 'Page not found' });
      return;
    }

    const ok = await checkWorkspaceMembership(req, res, page.workspaceId);
    if (!ok) return;

    if (body.parentId !== undefined) {
      if (body.parentId === null) {
        page.parentId = null;
      } else {
        if (body.parentId === String(page._id)) {
          res.status(400).json({ error: 'A page cannot be its own parent' });
          return;
        }
        const parent = await Page.findById(body.parentId).select('workspaceId').lean();
        if (!parent) {
          res.status(404).json({ error: 'Parent page not found' });
          return;
        }
        if (String(parent.workspaceId) !== String(page.workspaceId)) {
          res.status(400).json({ error: 'Parent page is in a different workspace' });
          return;
        }
        page.parentId = new mongoose.Types.ObjectId(body.parentId);
      }
    }
    if (body.title !== undefined) page.title = body.title;
    if (body.icon !== undefined) page.icon = body.icon;
    if (body.cover !== undefined) page.cover = body.cover;
    if (body.order !== undefined) page.order = body.order;
    if (body.archived !== undefined) page.archived = body.archived;

    await page.save();

    res.json({ page: serializePage(page) });
  } catch (error: unknown) {
    if (handleZodError(error, res)) return;
    log.general.error({ err: error }, 'Failed to update page');
    res.status(500).json({ error: 'Failed to update page' });
  }
});

/**
 * DELETE /api/pages/:id
 * Soft-delete (archived = true) by default. Hard-delete when `?hard=true`
 * and caller is the workspace owner.
 */
router.delete('/:id', async (req: Request, res: Response) => {
  try {
    const params = z.object({ id: objectIdSchema }).parse(req.params);
    const hard = req.query.hard === 'true';

    const page = await Page.findById(params.id);
    if (!page) {
      res.status(404).json({ error: 'Page not found' });
      return;
    }

    const ok = await checkWorkspaceMembership(req, res, page.workspaceId);
    if (!ok) return;

    if (hard) {
      // Hard-delete requires workspace ownership.
      if (req.workspace?.role !== 'owner') {
        res.status(403).json({ error: 'Hard delete requires workspace owner role' });
        return;
      }

      // Cascade: remove all blocks for this page and its descendants.
      const descendantIds = await collectDescendantPageIds(page._id as mongoose.Types.ObjectId);
      const allPageIds = [page._id as mongoose.Types.ObjectId, ...descendantIds];
      await Block.deleteMany({ pageId: { $in: allPageIds } });
      await Page.deleteMany({ _id: { $in: allPageIds } });

      res.json({ success: true, deleted: allPageIds.length });
      return;
    }

    page.archived = true;
    await page.save();

    res.json({ page: serializePage(page) });
  } catch (error: unknown) {
    if (handleZodError(error, res)) return;
    log.general.error({ err: error }, 'Failed to delete page');
    res.status(500).json({ error: 'Failed to delete page' });
  }
});

/**
 * Recursively collect every descendant page id beneath `rootId`.
 * Uses iterative BFS to bound recursion depth.
 */
async function collectDescendantPageIds(
  rootId: mongoose.Types.ObjectId,
): Promise<mongoose.Types.ObjectId[]> {
  const collected: mongoose.Types.ObjectId[] = [];
  let frontier: mongoose.Types.ObjectId[] = [rootId];
  while (frontier.length > 0) {
    const children = await Page.find({ parentId: { $in: frontier } })
      .select('_id')
      .lean();
    const childIds = children.map((c) => c._id as mongoose.Types.ObjectId);
    collected.push(...childIds);
    frontier = childIds;
  }
  return collected;
}

/**
 * POST /api/pages/:id/duplicate
 * Duplicates the page and all its blocks. Children pages are NOT duplicated
 * in Phase 1 (matches Notion's "Duplicate" default of single-page copy).
 */
router.post('/:id/duplicate', async (req: Request, res: Response) => {
  try {
    const params = z.object({ id: objectIdSchema }).parse(req.params);

    const source = await Page.findById(params.id).lean();
    if (!source) {
      res.status(404).json({ error: 'Page not found' });
      return;
    }

    const ok = await checkWorkspaceMembership(req, res, source.workspaceId);
    if (!ok) return;

    const userId = req.user?.id;
    if (!userId) {
      res.status(401).json({ error: 'Unauthorized' });
      return;
    }

    // Next order among siblings of the source.
    const siblingFilter: Record<string, unknown> = {
      workspaceId: source.workspaceId,
      parentId: source.parentId ?? null,
    };
    const last = await Page.findOne(siblingFilter)
      .sort({ order: -1 })
      .select('order')
      .lean();
    const nextOrder = last ? last.order + 1 : 0;

    const duplicate = await Page.create({
      workspaceId: source.workspaceId,
      parentId: source.parentId ?? null,
      title: source.title ? `${source.title} (copy)` : '(copy)',
      icon: source.icon,
      cover: source.cover,
      ownerId: userId,
      archived: false,
      order: nextOrder,
    });

    // Duplicate blocks preserving parentBlockId hierarchy.
    const blocks = await Block.find({ pageId: source._id }).lean();
    if (blocks.length > 0) {
      const idMap = new Map<string, mongoose.Types.ObjectId>();
      // Create new ObjectIds upfront so we can rewire parent pointers in one insert.
      const newDocs = blocks.map((b) => {
        const newId = new mongoose.Types.ObjectId();
        idMap.set(String(b._id), newId);
        return { ...b, _id: newId };
      });
      const rewired = newDocs.map((b) => ({
        _id: b._id,
        pageId: duplicate._id,
        parentBlockId: b.parentBlockId ? idMap.get(String(b.parentBlockId)) ?? null : null,
        type: b.type,
        content: b.content,
        order: b.order,
      }));
      await Block.insertMany(rewired);
    }

    res.status(201).json({ page: serializePage(duplicate) });
  } catch (error: unknown) {
    if (handleZodError(error, res)) return;
    log.general.error({ err: error }, 'Failed to duplicate page');
    res.status(500).json({ error: 'Failed to duplicate page' });
  }
});

export default router;
