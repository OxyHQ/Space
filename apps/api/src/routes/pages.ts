import { Router } from 'express';
import type { NextFunction, Request, Response } from 'express';
import { isLiveEntityId } from '@oxyhq/db';
import { z } from 'zod';
import { getDb } from '../db/client.js';
import type { PageRow } from '../repositories/pages.js';
import {
  createPage,
  deletePageTree,
  findPageAncestry,
  findPageById,
  listPages,
  nextSiblingOrder,
  updatePage,
} from '../repositories/pages.js';
import {
  duplicateBlocksToPage,
  listBlocksForPageByOrder,
} from '../repositories/blocks.js';
import { findDatabaseById } from '../repositories/databases.js';
import { authenticateToken } from '../middleware/auth.js';
import { requireWorkspaceMember } from '../middleware/workspace.js';
import { log } from '../lib/logger.js';
import {
  parsePropertyValue,
  serializeParsedValue,
} from '../lib/databases/property-values.js';
import { NAME_PROPERTY_ID } from '../lib/databases/schema-defaults.js';

const router = Router();

// All page routes require an authenticated Oxy user.
router.use(authenticateToken);

/**
 * Zod helper: an id this schema could have stored.
 *
 * `isLiveEntityId` accepts the two shapes a `generatedId()` primary key holds —
 * a uuid v7 for every row created after the cutover, and a 24-char ObjectId hex
 * for every row a backfill copies over verbatim. A 24-hex-only regex, which is
 * what this was, rejects every id the Postgres schema now mints.
 *
 * It is a 400 guard and nothing more: it never gates a lookup, because the
 * query already answers "no such row" for free, and a shape predicate used as a
 * precondition fails closed on a valid id it has not been taught about.
 * `workspaceId` goes through it too — workspaces are still Mongoose, so those
 * ids are ObjectIds today and uuid v7 once that domain ports; the predicate
 * spans both without needing to know which.
 */
const entityIdSchema = z.string().refine(isLiveEntityId, 'Invalid id');

const listQuerySchema = z.object({
  workspaceId: entityIdSchema,
  parentId: z
    .union([entityIdSchema, z.literal('null'), z.literal('root')])
    .optional(),
  includeArchived: z
    .union([z.literal('true'), z.literal('false')])
    .optional()
    .transform((v) => v === 'true'),
  archivedOnly: z
    .union([z.literal('true'), z.literal('false')])
    .optional()
    .transform((v) => v === 'true'),
  favoritedOnly: z
    .union([z.literal('true'), z.literal('false')])
    .optional()
    .transform((v) => v === 'true'),
});

const createPageSchema = z.object({
  workspaceId: entityIdSchema,
  parentId: entityIdSchema.nullable().optional(),
  title: z.string().max(2000).optional(),
  icon: z.string().max(200).nullable().optional(),
  cover: z.string().max(2000).nullable().optional(),
});

const updatePageSchema = z
  .object({
    title: z.string().max(2000).optional(),
    icon: z.string().max(200).nullable().optional(),
    cover: z.string().max(2000).nullable().optional(),
    coverPosition: z.number().min(0).max(100).optional(),
    parentId: entityIdSchema.nullable().optional(),
    order: z.number().finite().optional(),
    archived: z.boolean().optional(),
    favorited: z.boolean().optional(),
    // Database row property writes. Keys are propertyIds; shapes are
    // validated per-property type by `parsePropertyValue`.
    properties: z.record(z.unknown()).optional(),
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
 * The wire shape of a page.
 *
 * `_id` is gone. It was a Mongo artefact that this serializer emitted BESIDE
 * `id`, holding the same value, and the storage layer that produced it no
 * longer exists — so it is deleted rather than carried forward as an alias.
 * Every consumer of it is listed in the rewiring PR; `apps/app` reads
 * `page._id` in twenty-odd files and has to move to `page.id`.
 *
 * Every column is already the right JavaScript type coming out of drizzle, so
 * there is nothing here to coerce: `String(...)` around each id was undoing
 * `ObjectId`, and `?? 50` / `?? false` were defending against a document
 * written before those fields had defaults. `coverPosition`, `favorited` and
 * `properties` are all `NOT NULL DEFAULT` in the schema.
 */
function serializePage(page: PageRow) {
  return {
    id: page.id,
    workspaceId: page.workspaceId,
    parentId: page.parentId,
    title: page.title,
    icon: page.icon,
    cover: page.cover,
    coverPosition: page.coverPosition,
    ownerId: page.ownerId,
    archived: page.archived,
    favorited: page.favorited,
    order: page.order,
    databaseId: page.databaseId,
    properties: page.properties,
    createdAt: page.createdAt,
    updatedAt: page.updatedAt,
  };
}

/**
 * GET /api/pages?workspaceId=...[&parentId=...][&includeArchived=false]
 *                              [&archivedOnly=true][&favoritedOnly=true]
 * Returns a flat list. Frontend builds the tree.
 *
 * - `archivedOnly=true`     — return only archived pages (trash view).
 * - `favoritedOnly=true`    — return only starred pages (sidebar favorites).
 * - `includeArchived=true`  — include archived pages alongside active ones.
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

      // `archived` is three-valued and the three cases are not symmetric:
      // absent means "archived and active together", which only
      // `?includeArchived=true` (without `?archivedOnly=true`) asks for.
      let archived: boolean | undefined;
      if (query.archivedOnly) {
        archived = true;
      } else if (!query.includeArchived) {
        archived = false;
      }

      const pages = await listPages(getDb(), {
        workspaceId,
        parentId:
          query.parentId === undefined
            ? undefined
            : query.parentId === 'null' || query.parentId === 'root'
              ? null
              : query.parentId,
        archived,
        favoritedOnly: query.favoritedOnly,
      });

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
    const params = z.object({ id: entityIdSchema }).parse(req.params);

    const page = await findPageById(getDb(), params.id);
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

      const db = getDb();

      // If parentId provided, ensure the parent belongs to the same workspace.
      if (body.parentId) {
        const parent = await findPageById(db, body.parentId);
        if (!parent) {
          res.status(404).json({ error: 'Parent page not found' });
          return;
        }
        if (parent.workspaceId !== workspaceId) {
          res.status(400).json({ error: 'Parent page is in a different workspace' });
          return;
        }
      }

      // `max(order) + 1` among siblings, then insert. Read and write are
      // deliberately NOT wrapped in a transaction: under READ COMMITTED one
      // would take no lock and two concurrent creates would still read the same
      // maximum, so it would buy nothing while implying the race was closed.
      // The race is the one Mongo had, and `order` is a client-writable
      // `double precision` that `PATCH /api/pages/:id` renumbers anyway.
      const order = await nextSiblingOrder(db, {
        workspaceId,
        parentId: body.parentId ?? null,
      });

      const page = await createPage(db, {
        workspaceId,
        parentId: body.parentId ?? null,
        title: body.title ?? '',
        icon: body.icon ?? null,
        cover: body.cover ?? null,
        ownerId: userId,
        archived: false,
        order,
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
    const params = z.object({ id: entityIdSchema }).parse(req.params);
    const body = updatePageSchema.parse(req.body);

    const db = getDb();
    const page = await findPageById(db, params.id);
    if (!page) {
      res.status(404).json({ error: 'Page not found' });
      return;
    }

    const ok = await checkWorkspaceMembership(req, res, page.workspaceId);
    if (!ok) return;

    if (body.parentId !== undefined && body.parentId !== null) {
      if (body.parentId === page.id) {
        res.status(400).json({ error: 'A page cannot be its own parent' });
        return;
      }
      const parent = await findPageById(db, body.parentId);
      if (!parent) {
        res.status(404).json({ error: 'Parent page not found' });
        return;
      }
      if (parent.workspaceId !== page.workspaceId) {
        res.status(400).json({ error: 'Parent page is in a different workspace' });
        return;
      }
    }

    // Built by assignment rather than by spreading `body`, because `title` is
    // written twice below and the second write has to win.
    const patch = {
      parentId: body.parentId,
      title: body.title,
      icon: body.icon,
      cover: body.cover,
      coverPosition: body.coverPosition,
      order: body.order,
      archived: body.archived,
      favorited: body.favorited,
      mergeProperties: undefined as Record<string, unknown> | undefined,
    };

    if (body.properties) {
      if (!page.databaseId) {
        res.status(400).json({
          error: 'Properties can only be set on database row pages',
        });
        return;
      }
      const database = await findDatabaseById(db, page.databaseId);
      if (!database) {
        res.status(404).json({ error: 'Database not found for row' });
        return;
      }
      const schemaById = new Map(
        database.propertiesSchema.properties.map((p) => [p.id, p]),
      );
      // Only the keys that survive validation are sent. `mergeProperties` is a
      // shallow top-level merge into the stored object, so the keys the request
      // does not mention keep their values — which is what `.set()` on the
      // page's existing property Map did.
      const merge: Record<string, unknown> = {};
      for (const [key, raw] of Object.entries(body.properties)) {
        const prop = schemaById.get(key);
        if (!prop) continue;
        const parsed = parsePropertyValue(prop.type, raw);
        if (!parsed) continue;
        merge[key] = serializeParsedValue(parsed);
        // Keep title <-> Name in sync. This overwrites `body.title` when both
        // are submitted, matching the order the two writes happened in before.
        if (key === NAME_PROPERTY_ID && parsed.kind === 'text') {
          patch.title = parsed.text;
        }
      }
      patch.mergeProperties = merge;
    }

    // Sync the Name property when the title changes on a database row. Runs
    // after the loop above, so an explicit `title` wins over a submitted `name`
    // property for what gets STORED in `properties.name` — while the loop wins
    // for what gets stored in `title`. That asymmetry is the existing behaviour
    // and is preserved rather than quietly reconciled here.
    if (body.title !== undefined && page.databaseId) {
      patch.mergeProperties = {
        ...patch.mergeProperties,
        [NAME_PROPERTY_ID]: { text: body.title },
      };
    }

    const updated = await updatePage(db, page.id, patch);
    if (!updated) {
      res.status(404).json({ error: 'Page not found' });
      return;
    }

    res.json({ page: serializePage(updated) });
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
    const params = z.object({ id: entityIdSchema }).parse(req.params);
    const hard = req.query.hard === 'true';

    const db = getDb();
    const page = await findPageById(db, params.id);
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

      // One recursive statement rather than the BFS-then-two-`deleteMany` this
      // replaces, and NOT a bare `delete from pages where id = ?` relying on
      // the referential action. `pages.parentId` is `ON DELETE SET NULL`, not
      // CASCADE — deliberately, so that emptying the trash cannot destroy live
      // children of an archived page — so a single-row delete here would
      // ORPHAN the subtree instead of removing it. Blocks still go by cascade;
      // the explicit `Block.deleteMany` has no counterpart because
      // `blocks.pageId` is CASCADE.
      const deleted = await deletePageTree(db, page.id);

      res.json({ success: true, deleted });
      return;
    }

    const archivedPage = await updatePage(db, page.id, { archived: true });
    if (!archivedPage) {
      res.status(404).json({ error: 'Page not found' });
      return;
    }

    res.json({ page: serializePage(archivedPage) });
  } catch (error: unknown) {
    if (handleZodError(error, res)) return;
    log.general.error({ err: error }, 'Failed to delete page');
    res.status(500).json({ error: 'Failed to delete page' });
  }
});

/**
 * POST /api/pages/:id/duplicate
 * Duplicates the page and all its blocks. Children pages are NOT duplicated
 * in Phase 1 (matches Notion's "Duplicate" default of single-page copy).
 */
router.post('/:id/duplicate', async (req: Request, res: Response) => {
  try {
    const params = z.object({ id: entityIdSchema }).parse(req.params);

    const db = getDb();
    const source = await findPageById(db, params.id);
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

    // The new page and its copied blocks are ONE logical write, so they commit
    // together. The two-statement version this replaces could leave a page with
    // no blocks behind a 500, and Mongo had no way to promise otherwise.
    //
    // The transaction does NOT close the sibling-order race — `nextSiblingOrder`
    // takes no lock under READ COMMITTED — it is here for the page/blocks pair.
    const duplicate = await db.transaction(async (tx) => {
      const order = await nextSiblingOrder(tx, {
        workspaceId: source.workspaceId,
        parentId: source.parentId,
      });

      const created = await createPage(tx, {
        workspaceId: source.workspaceId,
        parentId: source.parentId,
        title: source.title ? `${source.title} (copy)` : '(copy)',
        icon: source.icon,
        cover: source.cover,
        ownerId: userId,
        archived: false,
        order,
      });

      // Children pages are NOT duplicated (see the route comment above), so the
      // copy takes the source's blocks and nothing else.
      await duplicateBlocksToPage(tx, source.id, created.id);
      return created;
    });

    res.status(201).json({ page: serializePage(duplicate) });
  } catch (error: unknown) {
    if (handleZodError(error, res)) return;
    log.general.error({ err: error }, 'Failed to duplicate page');
    res.status(500).json({ error: 'Failed to duplicate page' });
  }
});

/**
 * GET /api/pages/:id/breadcrumb
 * Returns the chain of ancestors from workspace root → current page (inclusive).
 * Each entry is a slim {id, title, icon} record — enough to render a nav crumb.
 * Bounded at 32 levels to defend against pathological loops.
 */
router.get('/:id/breadcrumb', async (req: Request, res: Response) => {
  try {
    const params = z.object({ id: entityIdSchema }).parse(req.params);

    const db = getDb();
    const head = await findPageById(db, params.id);
    if (!head) {
      res.status(404).json({ error: 'Page not found' });
      return;
    }

    const ok = await checkWorkspaceMembership(req, res, head.workspaceId);
    if (!ok) return;

    // One recursive walk instead of one query per level. The depth bound and
    // the cycle handling that the `seen` set provided are both inside
    // `findPageAncestry`, which returns root-first exactly as the `unshift` did.
    const breadcrumb = await findPageAncestry(db, head.id);

    res.json({ breadcrumb });
  } catch (error: unknown) {
    if (handleZodError(error, res)) return;
    log.general.error({ err: error }, 'Failed to fetch page breadcrumb');
    res.status(500).json({ error: 'Failed to fetch page breadcrumb' });
  }
});

/**
 * Render a block tree to markdown text. Used by /pages/:id/export?format=md.
 *
 * The renderer keeps things conservative: unknown block types degrade to
 * a paragraph (just `text`). Lists/todos honour the parentBlockId hierarchy.
 */
interface RenderableBlock {
  id: string;
  parentBlockId: string | null;
  type: string;
  content: Record<string, unknown>;
  order: number;
}

function textOf(content: Record<string, unknown>): string {
  const text = content.text;
  return typeof text === 'string' ? text : '';
}

function renderBlockMarkdown(
  block: RenderableBlock,
  childrenByParent: Map<string, RenderableBlock[]>,
  depth: number,
): string {
  const indent = '  '.repeat(depth);
  const text = textOf(block.content);
  const children = childrenByParent.get(block.id) ?? [];
  const childMd = children
    .map((c) => renderBlockMarkdown(c, childrenByParent, depth + 1))
    .join('\n');

  let line = '';
  switch (block.type) {
    case 'heading_1':
      line = `# ${text}`;
      break;
    case 'heading_2':
      line = `## ${text}`;
      break;
    case 'heading_3':
      line = `### ${text}`;
      break;
    case 'bulleted_list_item':
      line = `${indent}- ${text}`;
      break;
    case 'numbered_list_item':
      line = `${indent}1. ${text}`;
      break;
    case 'todo': {
      const checked = block.content.checked === true ? 'x' : ' ';
      line = `${indent}- [${checked}] ${text}`;
      break;
    }
    case 'quote':
      line = `> ${text}`;
      break;
    case 'divider':
      line = '---';
      break;
    case 'code': {
      const lang = typeof block.content.language === 'string'
        ? block.content.language
        : '';
      line = `\`\`\`${lang}\n${text}\n\`\`\``;
      break;
    }
    case 'callout': {
      const icon = typeof block.content.icon === 'string'
        ? block.content.icon
        : '';
      line = `> ${icon ? `${icon} ` : ''}${text}`;
      break;
    }
    case 'paragraph':
    default:
      line = text;
      break;
  }

  return childMd ? `${line}\n${childMd}` : line;
}

const exportQuerySchema = z.object({
  format: z.enum(['md', 'markdown']).default('md'),
});

/**
 * GET /api/pages/:id/export?format=md
 * Streams markdown for the page (title + blocks). HTML/PDF live in the
 * client (or a future worker) — this endpoint stays MD-only on purpose.
 */
router.get('/:id/export', async (req: Request, res: Response) => {
  try {
    const params = z.object({ id: entityIdSchema }).parse(req.params);
    exportQuerySchema.parse(req.query);

    const db = getDb();
    const page = await findPageById(db, params.id);
    if (!page) {
      res.status(404).json({ error: 'Page not found' });
      return;
    }

    const ok = await checkWorkspaceMembership(req, res, page.workspaceId);
    if (!ok) return;

    const blocks = await listBlocksForPageByOrder(db, page.id);

    const childrenByParent = new Map<string, RenderableBlock[]>();
    const roots: RenderableBlock[] = [];
    for (const b of blocks) {
      const renderable: RenderableBlock = {
        id: b.id,
        parentBlockId: b.parentBlockId,
        type: b.type,
        content: b.content,
        order: b.order,
      };
      if (renderable.parentBlockId) {
        const key = renderable.parentBlockId;
        const list = childrenByParent.get(key) ?? [];
        list.push(renderable);
        childrenByParent.set(key, list);
      } else {
        roots.push(renderable);
      }
    }

    const title = page.title?.trim() ? page.title : 'Untitled';
    const body = roots
      .map((b) => renderBlockMarkdown(b, childrenByParent, 0))
      .join('\n\n');

    const markdown = `# ${title}\n\n${body}\n`;
    res.setHeader('Content-Type', 'text/markdown; charset=utf-8');
    res.setHeader(
      'Content-Disposition',
      `attachment; filename="${title.replace(/[^a-zA-Z0-9-_]+/gu, '-')}.md"`,
    );
    res.send(markdown);
  } catch (error: unknown) {
    if (handleZodError(error, res)) return;
    log.general.error({ err: error }, 'Failed to export page');
    res.status(500).json({ error: 'Failed to export page' });
  }
});

export default router;
