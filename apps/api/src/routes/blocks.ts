import { Router } from 'express';
import type { NextFunction, Request, Response } from 'express';
import mongoose from 'mongoose';
import { z } from 'zod';
import {
  Block,
  BLOCK_TYPES,
  type BlockContent,
  type BlockType,
  type IBlock,
} from '../models/block.js';
import { Page } from '../models/page.js';
import { authenticateToken } from '../middleware/auth.js';
import { requireWorkspaceMember } from '../middleware/workspace.js';
import { log } from '../lib/logger.js';

const router = Router();

// All block routes require an authenticated Oxy user.
router.use(authenticateToken);

const objectIdSchema = z
  .string()
  .regex(/^[0-9a-fA-F]{24}$/u, 'Invalid id');

const blockTypeSchema = z.enum(BLOCK_TYPES as readonly [BlockType, ...BlockType[]]);

/**
 * Per-type content schemas with defaults. Concretely typed so each
 * `.parse()` returns the exact `BlockContent` variant without casts.
 *
 * Defaults are applied via Zod (`.default()`) so missing keys are filled
 * before validation and the output types remain non-optional strings/bools.
 */
const textContentSchema = z.object({ text: z.string().default('') });
const todoContentSchema = z.object({
  text: z.string().default(''),
  checked: z.boolean().default(false),
});
const codeContentSchema = z.object({
  text: z.string().default(''),
  language: z.string().default('plain'),
});
const calloutContentSchema = z.object({
  text: z.string().default(''),
  icon: z.string().default('lightbulb'),
});
const dividerContentSchema = z.object({}).strict();

/**
 * Normalize content by filling in type-specific defaults and validating shape.
 * Throws ZodError on validation failure (handled by the caller).
 */
function normalizeContent(type: BlockType, content: unknown): BlockContent {
  const incoming =
    content && typeof content === 'object' && !Array.isArray(content)
      ? (content as Record<string, unknown>)
      : {};

  switch (type) {
    case 'paragraph':
    case 'heading_1':
    case 'heading_2':
    case 'heading_3':
    case 'bulleted_list_item':
    case 'numbered_list_item':
    case 'quote':
      return textContentSchema.parse(incoming);
    case 'todo':
      return todoContentSchema.parse(incoming);
    case 'code':
      return codeContentSchema.parse(incoming);
    case 'callout':
      return calloutContentSchema.parse(incoming);
    case 'divider':
      return dividerContentSchema.parse({});
  }
}

const createBlockSchema = z.object({
  type: blockTypeSchema,
  content: z.unknown().optional(),
  order: z.number().finite().optional(),
  parentBlockId: objectIdSchema.nullable().optional(),
});

const updateBlockSchema = z
  .object({
    type: blockTypeSchema.optional(),
    content: z.unknown().optional(),
    order: z.number().finite().optional(),
    parentBlockId: objectIdSchema.nullable().optional(),
  })
  .refine((data) => Object.keys(data).length > 0, {
    message: 'At least one field is required',
  });

const reorderSchema = z.object({
  blockIds: z.array(objectIdSchema).min(1),
});

function handleZodError(err: unknown, res: Response): boolean {
  if (err instanceof z.ZodError) {
    res.status(400).json({ error: 'Invalid input', details: err.errors });
    return true;
  }
  return false;
}

type SerializableBlock = Pick<
  IBlock,
  | '_id'
  | 'pageId'
  | 'parentBlockId'
  | 'type'
  | 'content'
  | 'order'
  | 'createdAt'
  | 'updatedAt'
>;

function serializeBlock(block: SerializableBlock) {
  return {
    id: String(block._id),
    pageId: String(block.pageId),
    parentBlockId: block.parentBlockId ? String(block.parentBlockId) : null,
    type: block.type,
    content: block.content,
    order: block.order,
    createdAt: block.createdAt,
    updatedAt: block.updatedAt,
  };
}

/**
 * Sets the X-Workspace-Id header from the loaded resource's workspaceId
 * and runs `requireWorkspaceMember` inline. Returns true if the caller is
 * a member; false (with a response already sent) otherwise.
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
 * GET /api/pages/:pageId/blocks
 * Returns a flat list of blocks for the page. Frontend nests by parentBlockId.
 */
router.get('/pages/:pageId/blocks', async (req: Request, res: Response) => {
  try {
    const params = z.object({ pageId: objectIdSchema }).parse(req.params);

    const page = await Page.findById(params.pageId).select('workspaceId').lean();
    if (!page) {
      res.status(404).json({ error: 'Page not found' });
      return;
    }

    const ok = await checkWorkspaceMembership(req, res, page.workspaceId);
    if (!ok) return;

    const blocks = await Block.find({ pageId: page._id })
      .sort({ parentBlockId: 1, order: 1, createdAt: 1 })
      .lean();

    res.json({ blocks: blocks.map((b) => serializeBlock(b)) });
  } catch (error: unknown) {
    if (handleZodError(error, res)) return;
    log.general.error({ err: error }, 'Failed to list blocks');
    res.status(500).json({ error: 'Failed to list blocks' });
  }
});

/**
 * POST /api/pages/:pageId/blocks
 */
router.post('/pages/:pageId/blocks', async (req: Request, res: Response) => {
  try {
    const params = z.object({ pageId: objectIdSchema }).parse(req.params);
    const body = createBlockSchema.parse(req.body);

    const page = await Page.findById(params.pageId).select('workspaceId').lean();
    if (!page) {
      res.status(404).json({ error: 'Page not found' });
      return;
    }

    const ok = await checkWorkspaceMembership(req, res, page.workspaceId);
    if (!ok) return;

    if (body.parentBlockId) {
      const parent = await Block.findById(body.parentBlockId).select('pageId').lean();
      if (!parent) {
        res.status(404).json({ error: 'Parent block not found' });
        return;
      }
      if (String(parent.pageId) !== String(page._id)) {
        res.status(400).json({ error: 'Parent block belongs to a different page' });
        return;
      }
    }

    const content = normalizeContent(body.type, body.content);

    // Default order = max(order) + 1 among siblings if not provided.
    let order = body.order;
    if (order === undefined) {
      const siblingFilter: Record<string, unknown> = {
        pageId: page._id,
        parentBlockId: body.parentBlockId
          ? new mongoose.Types.ObjectId(body.parentBlockId)
          : null,
      };
      const last = await Block.findOne(siblingFilter)
        .sort({ order: -1 })
        .select('order')
        .lean();
      order = last ? last.order + 1 : 0;
    }

    const block = await Block.create({
      pageId: page._id,
      parentBlockId: body.parentBlockId
        ? new mongoose.Types.ObjectId(body.parentBlockId)
        : null,
      type: body.type,
      content,
      order,
    });

    res.status(201).json({ block: serializeBlock(block) });
  } catch (error: unknown) {
    if (handleZodError(error, res)) return;
    log.general.error({ err: error }, 'Failed to create block');
    res.status(500).json({ error: 'Failed to create block' });
  }
});

/**
 * PATCH /api/blocks/:id
 */
router.patch('/blocks/:id', async (req: Request, res: Response) => {
  try {
    const params = z.object({ id: objectIdSchema }).parse(req.params);
    const body = updateBlockSchema.parse(req.body);

    const block = await Block.findById(params.id);
    if (!block) {
      res.status(404).json({ error: 'Block not found' });
      return;
    }

    const page = await Page.findById(block.pageId).select('workspaceId').lean();
    if (!page) {
      res.status(404).json({ error: 'Page not found' });
      return;
    }

    const ok = await checkWorkspaceMembership(req, res, page.workspaceId);
    if (!ok) return;

    if (body.parentBlockId !== undefined) {
      if (body.parentBlockId === null) {
        block.parentBlockId = null;
      } else {
        if (body.parentBlockId === String(block._id)) {
          res.status(400).json({ error: 'A block cannot be its own parent' });
          return;
        }
        const parent = await Block.findById(body.parentBlockId).select('pageId').lean();
        if (!parent) {
          res.status(404).json({ error: 'Parent block not found' });
          return;
        }
        if (String(parent.pageId) !== String(block.pageId)) {
          res.status(400).json({ error: 'Parent block belongs to a different page' });
          return;
        }
        block.parentBlockId = new mongoose.Types.ObjectId(body.parentBlockId);
      }
    }

    if (body.type !== undefined) {
      block.type = body.type;
    }

    if (body.content !== undefined || body.type !== undefined) {
      // Re-normalize content against the (possibly new) type. If only the
      // type changed, fall back to defaults so we never persist mismatched shapes.
      const effectiveType = body.type ?? block.type;
      const incoming = body.content !== undefined ? body.content : block.content;
      block.content = normalizeContent(effectiveType, incoming);
    }

    if (body.order !== undefined) {
      block.order = body.order;
    }

    await block.save();

    res.json({ block: serializeBlock(block) });
  } catch (error: unknown) {
    if (handleZodError(error, res)) return;
    log.general.error({ err: error }, 'Failed to update block');
    res.status(500).json({ error: 'Failed to update block' });
  }
});

/**
 * DELETE /api/blocks/:id
 * Hard-delete. Cascades to child blocks (parentBlockId chain).
 */
router.delete('/blocks/:id', async (req: Request, res: Response) => {
  try {
    const params = z.object({ id: objectIdSchema }).parse(req.params);

    const block = await Block.findById(params.id);
    if (!block) {
      res.status(404).json({ error: 'Block not found' });
      return;
    }

    const page = await Page.findById(block.pageId).select('workspaceId').lean();
    if (!page) {
      res.status(404).json({ error: 'Page not found' });
      return;
    }

    const ok = await checkWorkspaceMembership(req, res, page.workspaceId);
    if (!ok) return;

    const descendants = await collectDescendantBlockIds(block._id as mongoose.Types.ObjectId);
    const allIds = [block._id as mongoose.Types.ObjectId, ...descendants];
    await Block.deleteMany({ _id: { $in: allIds } });

    res.json({ success: true, deleted: allIds.length });
  } catch (error: unknown) {
    if (handleZodError(error, res)) return;
    log.general.error({ err: error }, 'Failed to delete block');
    res.status(500).json({ error: 'Failed to delete block' });
  }
});

/**
 * POST /api/blocks/reorder
 * Bulk reorder. All items must already belong to `pageId` — we verify
 * before issuing writes. New parentBlockId values (when provided) must also
 * belong to the same page.
 *
 * Writes go through a single `bulkWrite` so all updates ship in one
 * round-trip. Without MongoDB transactions (which require a replica set
 * and aren't assumed available), the inputs are fully validated up-front
 * to minimize the chance of a partial-write outcome.
 */
router.post('/pages/:pageId/blocks/reorder', async (req: Request, res: Response) => {
  try {
    const pageId = req.params.pageId;
    if (typeof pageId !== 'string' || !/^[0-9a-fA-F]{24}$/.test(pageId)) {
      res.status(400).json({ error: 'Invalid pageId' });
      return;
    }
    const body = reorderSchema.parse(req.body);

    const page = await Page.findById(pageId).select('workspaceId').lean();
    if (!page) {
      res.status(404).json({ error: 'Page not found' });
      return;
    }

    const ok = await checkWorkspaceMembership(req, res, page.workspaceId);
    if (!ok) return;

    const itemIds = body.blockIds.map((id) => new mongoose.Types.ObjectId(id));
    const existing = await Block.find({ _id: { $in: itemIds } })
      .select('_id pageId')
      .lean();
    if (existing.length !== body.blockIds.length) {
      res.status(404).json({ error: 'One or more blocks not found' });
      return;
    }
    for (const b of existing) {
      if (String(b.pageId) !== String(page._id)) {
        res.status(400).json({ error: 'All blocks must belong to the same page' });
        return;
      }
    }

    // Order from frontend = index in blockIds array. Backend assigns
    // sequential integer order values to maintain the requested sequence.
    const ops = body.blockIds.map((id, index) => ({
      updateOne: {
        filter: { _id: new mongoose.Types.ObjectId(id), pageId: page._id },
        update: { $set: { order: index } },
      },
    }));

    const result = await Block.bulkWrite(ops, { ordered: false });

    res.json({
      success: true,
      matched: result.matchedCount,
      modified: result.modifiedCount,
    });
  } catch (error: unknown) {
    if (handleZodError(error, res)) return;
    log.general.error({ err: error }, 'Failed to reorder blocks');
    res.status(500).json({ error: 'Failed to reorder blocks' });
  }
});

async function collectDescendantBlockIds(
  rootId: mongoose.Types.ObjectId,
): Promise<mongoose.Types.ObjectId[]> {
  const collected: mongoose.Types.ObjectId[] = [];
  let frontier: mongoose.Types.ObjectId[] = [rootId];
  while (frontier.length > 0) {
    const children = await Block.find({ parentBlockId: { $in: frontier } })
      .select('_id')
      .lean();
    const childIds = children.map((c) => c._id as mongoose.Types.ObjectId);
    collected.push(...childIds);
    frontier = childIds;
  }
  return collected;
}

export default router;
