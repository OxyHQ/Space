import { Router } from 'express';
import type { NextFunction, Request, Response } from 'express';
import { isLiveEntityId } from '@oxyhq/db';
import { z } from 'zod';
import { getDb } from '../db/client.js';
import {
  BLOCK_TYPES,
  type BlockContent,
  type BlockType,
} from '../db/schema/pages.js';
import type { BlockRow } from '../repositories/blocks.js';
import {
  createBlock,
  deleteBlockTree,
  findBlockById,
  findBlocksByIds,
  listBlocksForPage,
  nextBlockOrder,
  reorderBlocks,
  updateBlock,
} from '../repositories/blocks.js';
import { findPageById } from '../repositories/pages.js';
import { authenticateToken } from '../middleware/auth.js';
import { requireWorkspaceMember } from '../middleware/workspace.js';
import { log } from '../lib/logger.js';

const router = Router();

// All block routes require an authenticated Oxy user.
router.use(authenticateToken);

/**
 * An id this schema could have stored — uuid v7, or a 24-char ObjectId hex for
 * a row a backfill copied over. See the identical helper in `routes/pages.ts`
 * for why a 24-hex-only regex is not it, and why this is a 400 guard rather
 * than a precondition on a lookup.
 */
const entityIdSchema = z.string().refine(isLiveEntityId, 'Invalid id');

/**
 * The id a content payload carries when the UI has not chosen a target yet —
 * `link_to_page` before a page is picked, `inline_database` between the block
 * being created and its database existing.
 *
 * It survives the move off ObjectIds unchanged because it is a well-formed
 * ObjectId hex that names no row, which is exactly what it has to be: a
 * sentinel the id validator accepts and no lookup ever resolves. Changing its
 * shape would be a wire-format change for the two block types that read it.
 */
const UNRESOLVED_TARGET_ID = '000000000000000000000000';

const blockTypeSchema = z.enum(BLOCK_TYPES);

/**
 * Notion-style named colours a block or a rich-text segment may carry.
 *
 * Declared here rather than in `db/schema/pages.ts`: `blocks.content` is jsonb
 * the table validates nothing about, and this route is the only thing that has
 * ever validated its shape. The `BlockColor` union that used to sit beside this
 * array is gone — `z.enum` derives the type from the array, so the two cannot
 * drift.
 */
const BLOCK_COLORS = [
  'default',
  'gray',
  'brown',
  'orange',
  'yellow',
  'green',
  'blue',
  'purple',
  'pink',
  'red',
] as const;

const blockColorSchema = z.enum(BLOCK_COLORS);

/**
 * Rich-text segment — single run of text plus optional annotations.
 * Editors that don't read `segments` keep working against `text`; both stay
 * in sync at the route boundary (see `syncSegmentsAndText`).
 */
const segmentSchema = z.object({
  text: z.string(),
  bold: z.boolean().optional(),
  italic: z.boolean().optional(),
  underline: z.boolean().optional(),
  strike: z.boolean().optional(),
  code: z.boolean().optional(),
  color: blockColorSchema.optional(),
  background: blockColorSchema.optional(),
  link: z.string().optional(),
});

/**
 * Common optional block-level styling fields. Kept on every content variant
 * so client code can read `content.color` uniformly.
 */
const styleFields = {
  color: blockColorSchema.optional(),
  backgroundColor: blockColorSchema.optional(),
} as const;

/**
 * Per-type content schemas with defaults. Concretely typed so each
 * `.parse()` returns the exact `BlockContent` variant without casts.
 *
 * Defaults are applied via Zod (`.default()`) so missing keys are filled
 * before validation and the output types remain non-optional strings/bools.
 */
const textContentSchema = z.object({
  text: z.string().default(''),
  segments: z.array(segmentSchema).optional(),
  ...styleFields,
});
const todoContentSchema = z.object({
  text: z.string().default(''),
  segments: z.array(segmentSchema).optional(),
  checked: z.boolean().default(false),
  ...styleFields,
});
const codeContentSchema = z.object({
  text: z.string().default(''),
  language: z.string().default('plain'),
  ...styleFields,
});
const calloutContentSchema = z.object({
  text: z.string().default(''),
  segments: z.array(segmentSchema).optional(),
  icon: z.string().default('lightbulb'),
  ...styleFields,
});
const toggleContentSchema = z.object({
  text: z.string().default(''),
  segments: z.array(segmentSchema).optional(),
  expanded: z.boolean().default(true),
  ...styleFields,
});
const dividerContentSchema = z.object(styleFields);

// --- Phase 3: media blocks ---
const imageAlignmentSchema = z.enum(['left', 'center', 'right', 'full']);
const imageContentSchema = z.object({
  url: z.string().default(''),
  caption: z.string().optional(),
  alt: z.string().optional(),
  width: z.number().finite().positive().optional(),
  alignment: imageAlignmentSchema.optional(),
  ...styleFields,
});

const videoSourceSchema = z.enum(['upload', 'youtube', 'vimeo', 'loom', 'other']);
const videoContentSchema = z.object({
  url: z.string().default(''),
  source: videoSourceSchema.default('other'),
  caption: z.string().optional(),
  ...styleFields,
});

const audioContentSchema = z.object({
  url: z.string().default(''),
  caption: z.string().optional(),
  ...styleFields,
});

const fileContentSchema = z.object({
  url: z.string().default(''),
  name: z.string().default(''),
  size: z.number().int().nonnegative().default(0),
  mimeType: z.string().default('application/octet-stream'),
  ...styleFields,
});

const pdfContentSchema = z.object({
  url: z.string().default(''),
  ...styleFields,
});

// --- Phase 3: embeds ---
const bookmarkContentSchema = z.object({
  url: z.string().default(''),
  title: z.string().optional(),
  description: z.string().optional(),
  image: z.string().optional(),
  favicon: z.string().optional(),
  ...styleFields,
});

const embedContentSchema = z.object({
  url: z.string().default(''),
  source: z.string().optional(),
  ...styleFields,
});

// --- Phase 3: layout ---
const columnsContentSchema = z.object({
  columnCount: z.union([z.literal(2), z.literal(3), z.literal(4)]).default(2),
  ...styleFields,
});

const columnContentSchema = z.object({
  /** Optional 0..1 fractional ratio. Defaults to even split when unset. */
  ratio: z.number().min(0).max(1).optional(),
  ...styleFields,
});

const tableContentSchema = z.object({
  rows: z.number().int().positive().default(2),
  cols: z.number().int().positive().default(2),
  withHeader: z.boolean().default(false),
  ...styleFields,
});

const tableRowContentSchema = z.object(styleFields);

const tableCellContentSchema = z.object({
  text: z.string().default(''),
  segments: z.array(segmentSchema).optional(),
  ...styleFields,
});

// --- Phase 3: interactive ---
const buttonActionSchema = z.enum([
  'duplicate-template',
  'new-page',
  'navigate',
  'webhook',
]);
const buttonContentSchema = z.object({
  label: z.string().default('Button'),
  action: buttonActionSchema.default('navigate'),
  /** Action-specific params kept loose — validated by callers when fired. */
  url: z.string().optional(),
  pageId: entityIdSchema.optional(),
  templateId: entityIdSchema.optional(),
  webhookUrl: z.string().optional(),
  ...styleFields,
});

const linkToPageContentSchema = z.object({
  pageId: entityIdSchema.default(UNRESOLVED_TARGET_ID),
  ...styleFields,
});

const syncBlockContentSchema = z.object({
  sourceBlockId: entityIdSchema.optional(),
  ...styleFields,
});

const breadcrumbContentSchema = z.object(styleFields);
const tableOfContentsContentSchema = z.object(styleFields);

// --- Phase 3: math + diagram ---
const equationContentSchema = z.object({
  latex: z.string().default(''),
  ...styleFields,
});

const mermaidContentSchema = z.object({
  code: z.string().default(''),
  ...styleFields,
});

// --- Phase 4: database ---
const inlineDatabaseContentSchema = z.object({
  /**
   * The database to render — a `databases` row id. Defaults to
   * `UNRESOLVED_TARGET_ID` so the type-changed-to-inline_database path doesn't
   * fail validation; UI immediately replaces it after creating the DB.
   */
  databaseId: entityIdSchema.default(UNRESOLVED_TARGET_ID),
  /** Optional starting view; falls back to the database's default view. */
  viewId: entityIdSchema.optional(),
  ...styleFields,
});

/**
 * Keep plain `text` consistent with `segments`. When both are present, the
 * concatenated segment text wins (more expressive). When only `text` is
 * present, segments are left undefined so older readers keep working.
 *
 * Mutates and returns the same object — caller owns it (fresh from a Zod
 * parse), so this is safe and avoids spread-typing pain across heterogeneous
 * content variants.
 */
function syncTextFromSegments(value: BlockContent): BlockContent {
  const segments = value.segments;
  if (Array.isArray(segments) && segments.length > 0) {
    const flat = segments
      .map((s) => (s && typeof s === 'object' && 'text' in s ? String((s as { text: unknown }).text ?? '') : ''))
      .join('');
    value.text = flat;
  }
  return value;
}

/**
 * Normalize content by filling in type-specific defaults and validating shape.
 * Throws ZodError on validation failure (handled by the caller).
 *
 * Exported for `__tests__/blocks.phase3.test.ts`, which used to assert these
 * shapes against a hand-written COPY of the schemas below — so it measured the
 * copy, and went on passing when the copy and this file disagreed about what an
 * id looks like. It is the unit under test, not a seam invented for the test.
 */
export function normalizeContent(type: BlockType, content: unknown): BlockContent {
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
      return syncTextFromSegments(textContentSchema.parse(incoming));
    case 'todo':
      return syncTextFromSegments(todoContentSchema.parse(incoming));
    case 'code':
      return codeContentSchema.parse(incoming);
    case 'callout':
      return syncTextFromSegments(calloutContentSchema.parse(incoming));
    case 'toggle':
      return syncTextFromSegments(toggleContentSchema.parse(incoming));
    case 'divider':
      return dividerContentSchema.parse(incoming);
    case 'image':
      return imageContentSchema.parse(incoming);
    case 'video':
      return videoContentSchema.parse(incoming);
    case 'audio':
      return audioContentSchema.parse(incoming);
    case 'file':
      return fileContentSchema.parse(incoming);
    case 'pdf':
      return pdfContentSchema.parse(incoming);
    case 'bookmark':
      return bookmarkContentSchema.parse(incoming);
    case 'embed':
      return embedContentSchema.parse(incoming);
    case 'columns':
      return columnsContentSchema.parse(incoming);
    case 'column':
      return columnContentSchema.parse(incoming);
    case 'table':
      return tableContentSchema.parse(incoming);
    case 'table_row':
      return tableRowContentSchema.parse(incoming);
    case 'table_cell':
      return syncTextFromSegments(tableCellContentSchema.parse(incoming));
    case 'button':
      return buttonContentSchema.parse(incoming);
    case 'link_to_page':
      return linkToPageContentSchema.parse(incoming);
    case 'sync_block':
      return syncBlockContentSchema.parse(incoming);
    case 'breadcrumb':
      return breadcrumbContentSchema.parse(incoming);
    case 'table_of_contents':
      return tableOfContentsContentSchema.parse(incoming);
    case 'equation':
      return equationContentSchema.parse(incoming);
    case 'mermaid':
      return mermaidContentSchema.parse(incoming);
    case 'inline_database':
      return inlineDatabaseContentSchema.parse(incoming);
  }
}

const createBlockSchema = z.object({
  type: blockTypeSchema,
  content: z.unknown().optional(),
  order: z.number().finite().optional(),
  parentBlockId: entityIdSchema.nullable().optional(),
});

const updateBlockSchema = z
  .object({
    type: blockTypeSchema.optional(),
    content: z.unknown().optional(),
    order: z.number().finite().optional(),
    parentBlockId: entityIdSchema.nullable().optional(),
  })
  .refine((data) => Object.keys(data).length > 0, {
    message: 'At least one field is required',
  });

const reorderSchema = z.object({
  /**
   * The page's new block sequence; each block takes its index as its `order`.
   *
   * Distinctness is enforced rather than left unspecified. The payload means
   * "this is the sequence", and a sequence cannot hold the same block twice —
   * but both storage engines answered a duplicate ARBITRARILY, so neither
   * behaviour is one to port. Mongo issued two `updateOne`s under
   * `ordered: false`; Postgres joins against `(values ...)` and, where two rows
   * match one block, applies an unspecified one of them. A 400 replaces an
   * unspecified outcome with a stated one, and rejects nothing the editor
   * sends — a repeated id there would mean an already-corrupted block list.
   */
  blockIds: z
    .array(entityIdSchema)
    .min(1)
    .refine((ids) => new Set(ids).size === ids.length, {
      message: 'blockIds must not contain duplicates',
    }),
});

function handleZodError(err: unknown, res: Response): boolean {
  if (err instanceof z.ZodError) {
    res.status(400).json({ error: 'Invalid input', details: err.errors });
    return true;
  }
  return false;
}

/**
 * The wire shape of a block. Unchanged by the port: this serializer has always
 * emitted `id` and never `_id`, so unlike `serializePage` there is nothing to
 * remove here. Every field already arrives from drizzle as the right type, so
 * the `String(...)` coercions that undid `ObjectId` are gone.
 */
function serializeBlock(block: BlockRow) {
  return {
    id: block.id,
    pageId: block.pageId,
    parentBlockId: block.parentBlockId,
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
  workspaceId: string,
): Promise<boolean> {
  req.headers['x-workspace-id'] = workspaceId;
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
    const params = z.object({ pageId: entityIdSchema }).parse(req.params);

    const db = getDb();
    const page = await findPageById(db, params.pageId);
    if (!page) {
      res.status(404).json({ error: 'Page not found' });
      return;
    }

    const ok = await checkWorkspaceMembership(req, res, page.workspaceId);
    if (!ok) return;

    const blocks = await listBlocksForPage(db, page.id);

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
    const params = z.object({ pageId: entityIdSchema }).parse(req.params);
    const body = createBlockSchema.parse(req.body);

    const db = getDb();
    const page = await findPageById(db, params.pageId);
    if (!page) {
      res.status(404).json({ error: 'Page not found' });
      return;
    }

    const ok = await checkWorkspaceMembership(req, res, page.workspaceId);
    if (!ok) return;

    if (body.parentBlockId) {
      const parent = await findBlockById(db, body.parentBlockId);
      if (!parent) {
        res.status(404).json({ error: 'Parent block not found' });
        return;
      }
      if (parent.pageId !== page.id) {
        res.status(400).json({ error: 'Parent block belongs to a different page' });
        return;
      }
    }

    const content = normalizeContent(body.type, body.content);

    // Default order = max(order) + 1 among siblings if not provided. Same race
    // as `POST /api/pages` and the same reasoning: a transaction would take no
    // lock here, so it would not close it.
    const order =
      body.order ??
      (await nextBlockOrder(db, {
        pageId: page.id,
        parentBlockId: body.parentBlockId ?? null,
      }));

    const block = await createBlock(db, {
      pageId: page.id,
      parentBlockId: body.parentBlockId ?? null,
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
    const params = z.object({ id: entityIdSchema }).parse(req.params);
    const body = updateBlockSchema.parse(req.body);

    const db = getDb();
    const block = await findBlockById(db, params.id);
    if (!block) {
      res.status(404).json({ error: 'Block not found' });
      return;
    }

    const page = await findPageById(db, block.pageId);
    if (!page) {
      res.status(404).json({ error: 'Page not found' });
      return;
    }

    const ok = await checkWorkspaceMembership(req, res, page.workspaceId);
    if (!ok) return;

    if (body.parentBlockId !== undefined && body.parentBlockId !== null) {
      if (body.parentBlockId === block.id) {
        res.status(400).json({ error: 'A block cannot be its own parent' });
        return;
      }
      const parent = await findBlockById(db, body.parentBlockId);
      if (!parent) {
        res.status(404).json({ error: 'Parent block not found' });
        return;
      }
      if (parent.pageId !== block.pageId) {
        res.status(400).json({ error: 'Parent block belongs to a different page' });
        return;
      }
    }

    let content: BlockContent | undefined;
    if (body.content !== undefined || body.type !== undefined) {
      // Re-normalize content against the (possibly new) type. If only the
      // type changed, fall back to defaults so we never persist mismatched shapes.
      // `block.type` is a `BlockType` rather than a bare `string` because the
      // column carries `$type<BlockType>()`, matching its CHECK.
      const effectiveType = body.type ?? block.type;
      const incoming = body.content !== undefined ? body.content : block.content;
      content = normalizeContent(effectiveType, incoming);
    }

    const updated = await updateBlock(db, block.id, {
      parentBlockId: body.parentBlockId,
      type: body.type,
      content,
      order: body.order,
    });
    if (!updated) {
      res.status(404).json({ error: 'Block not found' });
      return;
    }

    res.json({ block: serializeBlock(updated) });
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
    const params = z.object({ id: entityIdSchema }).parse(req.params);

    const db = getDb();
    const block = await findBlockById(db, params.id);
    if (!block) {
      res.status(404).json({ error: 'Block not found' });
      return;
    }

    const page = await findPageById(db, block.pageId);
    if (!page) {
      res.status(404).json({ error: 'Page not found' });
      return;
    }

    const ok = await checkWorkspaceMembership(req, res, page.workspaceId);
    if (!ok) return;

    // One recursive statement in place of the BFS. The descendants are named
    // explicitly rather than left to `blocks.parentBlockId`'s CASCADE because
    // this route answers with the COUNT and a cascade reports none.
    const deleted = await deleteBlockTree(db, block.id);

    res.json({ success: true, deleted });
  } catch (error: unknown) {
    if (handleZodError(error, res)) return;
    log.general.error({ err: error }, 'Failed to delete block');
    res.status(500).json({ error: 'Failed to delete block' });
  }
});

/**
 * POST /api/pages/:pageId/blocks/reorder
 * Bulk reorder. All items must already belong to `pageId` — we verify
 * before issuing writes.
 *
 * The up-front validation used to carry a second job: "without MongoDB
 * transactions (which require a replica set and aren't assumed available), the
 * inputs are fully validated up-front to minimize the chance of a partial-write
 * outcome". That is no longer why it is here. `blocksRepository.reorderBlocks`
 * counts and writes inside one transaction, so the partial write this could
 * only make unlikely is now impossible; the validation survives to produce the
 * 404 and 400, not to narrow a window.
 */
router.post('/pages/:pageId/blocks/reorder', async (req: Request, res: Response) => {
  try {
    const params = z.object({ pageId: entityIdSchema }).parse(req.params);
    const body = reorderSchema.parse(req.body);

    const db = getDb();
    const page = await findPageById(db, params.pageId);
    if (!page) {
      res.status(404).json({ error: 'Page not found' });
      return;
    }

    const ok = await checkWorkspaceMembership(req, res, page.workspaceId);
    if (!ok) return;

    const existing = await findBlocksByIds(db, body.blockIds);
    if (existing.length !== body.blockIds.length) {
      res.status(404).json({ error: 'One or more blocks not found' });
      return;
    }
    for (const b of existing) {
      if (b.pageId !== page.id) {
        res.status(400).json({ error: 'All blocks must belong to the same page' });
        return;
      }
    }

    // Order from frontend = index in blockIds array.
    //
    // `modified` is NARROWER than the number the Mongo route reported, and the
    // difference is deliberate — Mongoose stamped `updatedAt` onto every
    // operation of the `bulkWrite`, so its `modifiedCount` equalled
    // `matchedCount` whether or not a block had actually moved. `matched` keeps
    // Mongo's `matchedCount` meaning, which is what Postgres's row count is.
    // Neither field is read: the only caller discards the response body.
    const result = await reorderBlocks(db, page.id, body.blockIds);

    res.json({
      success: true,
      matched: result.matched,
      modified: result.modified,
    });
  } catch (error: unknown) {
    if (handleZodError(error, res)) return;
    log.general.error({ err: error }, 'Failed to reorder blocks');
    res.status(500).json({ error: 'Failed to reorder blocks' });
  }
});

export default router;
