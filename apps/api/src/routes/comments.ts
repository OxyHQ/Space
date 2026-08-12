import { Router } from 'express';
import type { NextFunction, Request, Response } from 'express';
import { z } from 'zod';
import { getDb } from '../db/client.js';
import { findBlockById } from '../repositories/blocks.js';
import { findPageById, findPagesByIds } from '../repositories/pages.js';
import { listMembershipsForUsers } from '../repositories/workspaces.js';
import {
  createComment,
  deleteComment,
  deleteCommentThread,
  findCommentById,
  listCommentsByBlock,
  listCommentsByPage,
  setCommentResolvedAt,
  updateCommentContent,
  type CommentContent,
  type CommentSegment,
  type CommentRow,
  type MentionSegment,
} from '../repositories/comments.js';
import { authenticateToken } from '../middleware/auth.js';
import { requireWorkspaceMember } from '../middleware/workspace.js';
import { sendNotification } from '../lib/notification-service.js';
import { log } from '../lib/logger.js';

const router = Router();
router.use(authenticateToken);

const EDIT_WINDOW_MINUTES = 30;

/**
 * Ids are opaque. The 24-hex ObjectId regex this replaces rejected every
 * uuidv7 the schema now produces, which would have 400'd every comments
 * route — so a shape gate is not "ported" here, it is deleted. A malformed
 * id matches no row and reaches the same 404 by asking the database.
 */
const objectIdSchema = z.string().min(1, 'Invalid id');

const isoDateSchema = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/u, 'Invalid date (expected yyyy-mm-dd)');

const mentionSegmentSchema = z.object({
  type: z.literal('mention'),
  kind: z.enum(['user', 'page', 'date']),
  id: z.string().optional(),
  date: z.string().optional(),
  originalText: z.string(),
});

const textSegmentSchema = z.object({
  type: z.literal('text').optional(),
  text: z.string(),
  bold: z.boolean().optional(),
  italic: z.boolean().optional(),
  underline: z.boolean().optional(),
  strike: z.boolean().optional(),
  code: z.boolean().optional(),
  link: z.string().optional(),
});

const segmentSchema = z.union([mentionSegmentSchema, textSegmentSchema]);

const contentInputSchema = z.object({
  segments: z.array(segmentSchema).min(1, 'Comment must not be empty'),
});

const createBodySchema = z.object({
  blockId: objectIdSchema.nullable().optional(),
  parentCommentId: objectIdSchema.nullable().optional(),
  content: contentInputSchema,
});

const updateBodySchema = z.object({
  content: contentInputSchema,
});

/**
 * Compute the plain-text projection of a segment list. Mention segments
 * fall back to their `originalText` (e.g. "@nate", "@Some Page").
 */
function flattenSegments(segments: CommentSegment[]): string {
  return segments
    .map((s) => {
      if ('type' in s && s.type === 'mention') {
        return s.originalText;
      }
      return s.text;
    })
    .join('');
}

/**
 * Validate mention segments against the resolved workspace. Returns the
 * normalized segment list (with explicit `type: 'text'` on text segments)
 * plus the set of mentioned user ids.
 *
 * - `kind: 'user'`: `id` must be a workspace member.
 * - `kind: 'page'`: `id` must be a Page in the same workspace.
 * - `kind: 'date'`: `date` must be present (validated as ISO yyyy-mm-dd).
 */
async function validateAndNormalizeContent(
  segments: z.infer<typeof segmentSchema>[],
  workspaceId: string,
): Promise<{ segments: CommentSegment[]; mentionedUserIds: string[] }> {
  const userIds = new Set<string>();
  const pageIds = new Set<string>();
  const dateStrings: { idx: number; date?: string }[] = [];

  segments.forEach((seg, idx) => {
    if (seg.type === 'mention') {
      if (seg.kind === 'user') {
        if (!seg.id) {
          throw new z.ZodError([
            {
              code: 'custom',
              path: ['segments', idx, 'id'],
              message: 'User mention requires id',
            },
          ]);
        }
        userIds.add(seg.id);
      } else if (seg.kind === 'page') {
        if (!seg.id) {
          throw new z.ZodError([
            {
              code: 'custom',
              path: ['segments', idx, 'id'],
              message: 'Page mention requires id',
            },
          ]);
        }
        pageIds.add(seg.id);
      } else if (seg.kind === 'date') {
        dateStrings.push({ idx, date: seg.date });
      }
    }
  });

  // Date format validation up-front.
  for (const { idx, date } of dateStrings) {
    if (!date) {
      throw new z.ZodError([
        {
          code: 'custom',
          path: ['segments', idx, 'date'],
          message: 'Date mention requires date',
        },
      ]);
    }
    const parsed = isoDateSchema.safeParse(date);
    if (!parsed.success) {
      throw new z.ZodError([
        {
          code: 'custom',
          path: ['segments', idx, 'date'],
          message: 'Date must be yyyy-mm-dd',
        },
      ]);
    }
  }

  // Verify user mentions belong to the workspace.
  if (userIds.size > 0) {
    const members = await listMembershipsForUsers(getDb(), workspaceId, Array.from(userIds));
    const validUserIds = new Set(members.map((m) => m.userId));
    for (const id of userIds) {
      if (!validUserIds.has(id)) {
        throw new z.ZodError([
          {
            code: 'custom',
            path: ['segments'],
            message: `User ${id} is not a member of this workspace`,
          },
        ]);
      }
    }
  }

  // Verify page mentions belong to the workspace.
  if (pageIds.size > 0) {
    // Scoped to the workspace in the caller, not in the query: a page mention
    // pointing at another workspace's page must be rejected, and asking for the
    // ids and then filtering keeps that decision visible here.
    const pages = (await findPagesByIds(getDb(), Array.from(pageIds))).filter(
      (page) => page.workspaceId === workspaceId,
    );
    const validPageIds = new Set(pages.map((p) => p.id));
    for (const id of pageIds) {
      if (!validPageIds.has(id)) {
        throw new z.ZodError([
          {
            code: 'custom',
            path: ['segments'],
            message: `Page ${id} is not in this workspace`,
          },
        ]);
      }
    }
  }

  const normalized: CommentSegment[] = segments.map((seg) => {
    if (seg.type === 'mention') {
      const mention: MentionSegment = {
        type: 'mention',
        kind: seg.kind,
        originalText: seg.originalText,
      };
      if (seg.id !== undefined) mention.id = seg.id;
      if (seg.date !== undefined) mention.date = seg.date;
      return mention;
    }
    return {
      type: 'text',
      text: seg.text,
      ...(seg.bold !== undefined ? { bold: seg.bold } : {}),
      ...(seg.italic !== undefined ? { italic: seg.italic } : {}),
      ...(seg.underline !== undefined ? { underline: seg.underline } : {}),
      ...(seg.strike !== undefined ? { strike: seg.strike } : {}),
      ...(seg.code !== undefined ? { code: seg.code } : {}),
      ...(seg.link !== undefined ? { link: seg.link } : {}),
    };
  });

  return { segments: normalized, mentionedUserIds: Array.from(userIds) };
}

type SerializableComment = CommentRow;

function serializeComment(c: SerializableComment) {
  return {
    id: c.id,
    workspaceId: c.workspaceId,
    pageId: c.pageId,
    blockId: c.blockId,
    parentCommentId: c.parentCommentId,
    authorId: c.authorId,
    content: c.content,
    resolvedAt: c.resolvedAt,
    editedAt: c.editedAt,
    createdAt: c.createdAt,
    updatedAt: c.updatedAt,
  };
}

function handleZodError(err: unknown, res: Response): boolean {
  if (err instanceof z.ZodError) {
    res.status(400).json({ error: 'Invalid input', details: err.errors });
    return true;
  }
  return false;
}

/**
 * Inline workspace-membership check by resource workspace id. Mirrors the
 * pattern used by blocks.ts so we can authorize without forcing callers to
 * pass `X-Workspace-Id` for every comment route.
 */
async function checkWorkspaceMembership(
  req: Request,
  res: Response,
  workspaceId: string,
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
 * Best-effort notification fan-out. Logs failures but never throws — comment
 * creation must succeed even if downstream messaging is offline.
 */
async function notifyMentions(
  comment: CommentRow,
  mentionedUserIds: string[],
  page: { id: string; title: string },
): Promise<void> {
  const recipients = mentionedUserIds.filter((id) => id !== comment.authorId);
  if (recipients.length === 0) return;

  const preview = comment.content.plainText.slice(0, 280);
  const pageTitle = page.title || 'Untitled';

  await Promise.all(
    recipients.map(async (userId) => {
      try {
        await sendNotification({
          userId,
          type: 'mention',
          title: `You were mentioned in ${pageTitle}`,
          body: preview,
          priority: 'normal',
          data: {
            commentId: comment.id,
            pageId: page.id,
            blockId: comment.blockId ? String(comment.blockId) : null,
            authorId: comment.authorId,
          },
        });
      } catch (err: unknown) {
        log.general.warn({ err, userId, commentId: comment.id }, 'Failed to send mention notification');
      }
    }),
  );
}

/**
 * Notify the parent thread author when someone replies.
 */
async function notifyReply(
  comment: CommentRow,
  parentAuthorId: string,
  page: { id: string; title: string },
): Promise<void> {
  if (parentAuthorId === comment.authorId) return;
  try {
    await sendNotification({
      userId: parentAuthorId,
      type: 'comment_reply',
      title: `New reply in ${page.title || 'Untitled'}`,
      body: comment.content.plainText.slice(0, 280),
      priority: 'normal',
      data: {
        commentId: comment.id,
        pageId: page.id,
        blockId: comment.blockId ? String(comment.blockId) : null,
        parentCommentId: comment.parentCommentId ? String(comment.parentCommentId) : null,
        authorId: comment.authorId,
      },
    });
  } catch (err: unknown) {
    log.general.warn({ err, userId: parentAuthorId, commentId: comment.id }, 'Failed to send reply notification');
  }
}

/**
 * GET /pages/:pageId/comments
 * Lists threaded comments on a page. Defaults to non-resolved only; pass
 * `?includeResolved=true` to include resolved threads.
 */
router.get('/pages/:pageId/comments', async (req: Request, res: Response) => {
  try {
    const params = z.object({ pageId: objectIdSchema }).parse(req.params);
    const query = z
      .object({ includeResolved: z.enum(['true', 'false']).optional() })
      .parse(req.query);
    const includeResolved = query.includeResolved === 'true';

    const db = getDb();
    const page = await findPageById(db, params.pageId);
    if (!page) {
      res.status(404).json({ error: 'Page not found' });
      return;
    }

    const ok = await checkWorkspaceMembership(req, res, page.workspaceId);
    if (!ok) return;

    // Thread listing: when hiding resolved threads we still need replies to
    // be returned (clients group by parentCommentId), so we fetch all and
    // filter the resolved-root threads in memory.
    const all = await listCommentsByPage(db, page.id);

    if (includeResolved) {
      res.json({ comments: all.map((c) => serializeComment(c)) });
      return;
    }

    // Hide top-level threads whose root is resolved (but keep all replies in
    // the returned list — clients group by parentCommentId).
    const resolvedTopIds = new Set(
      all
        .filter((c) => c.parentCommentId === null && c.resolvedAt !== null)
        .map((c) => c.id),
    );
    const filtered = all.filter((c) => {
      const rootId = c.parentCommentId ?? c.id;
      return !resolvedTopIds.has(rootId);
    });

    res.json({ comments: filtered.map((c) => serializeComment(c)) });
  } catch (error: unknown) {
    if (handleZodError(error, res)) return;
    log.general.error({ err: error }, 'Failed to list page comments');
    res.status(500).json({ error: 'Failed to list comments' });
  }
});

/**
 * GET /blocks/:blockId/comments
 * Lists comments anchored to a specific block (always includes resolved so
 * the right-side panel can show counts; clients filter for the inline badge).
 */
router.get('/blocks/:blockId/comments', async (req: Request, res: Response) => {
  try {
    const params = z.object({ blockId: objectIdSchema }).parse(req.params);

    const db = getDb();
    const block = await findBlockById(db, params.blockId);
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

    const comments = await listCommentsByBlock(db, block.id);

    res.json({ comments: comments.map((c) => serializeComment(c)) });
  } catch (error: unknown) {
    if (handleZodError(error, res)) return;
    log.general.error({ err: error }, 'Failed to list block comments');
    res.status(500).json({ error: 'Failed to list comments' });
  }
});

/**
 * POST /pages/:pageId/comments
 * Create a new comment (page-level, block-level, or reply).
 */
router.post('/pages/:pageId/comments', async (req: Request, res: Response) => {
  try {
    if (!req.user?.id) {
      res.status(401).json({ error: 'Unauthorized' });
      return;
    }
    const params = z.object({ pageId: objectIdSchema }).parse(req.params);
    const body = createBodySchema.parse(req.body);

    const db = getDb();
    const page = await findPageById(db, params.pageId);
    if (!page) {
      res.status(404).json({ error: 'Page not found' });
      return;
    }

    const ok = await checkWorkspaceMembership(req, res, page.workspaceId);
    if (!ok) return;

    // Validate block belongs to the same page (if provided).
    let blockId: string | null = null;
    if (body.blockId) {
      const block = await findBlockById(db, body.blockId);
      if (!block) {
        res.status(404).json({ error: 'Block not found' });
        return;
      }
      if (block.pageId !== page.id) {
        res.status(400).json({ error: 'Block belongs to a different page' });
        return;
      }
      blockId = block.id;
    }

    // Validate parent comment belongs to the same page and is a top-level
    // comment (one-level reply nesting only).
    let parentCommentId: string | null = null;
    let parentAuthorId: string | null = null;
    if (body.parentCommentId) {
      const parent = await findCommentById(db, body.parentCommentId);
      if (!parent) {
        res.status(404).json({ error: 'Parent comment not found' });
        return;
      }
      if (parent.pageId !== page.id) {
        res.status(400).json({ error: 'Parent comment belongs to a different page' });
        return;
      }
      if (parent.parentCommentId !== null) {
        res
          .status(400)
          .json({ error: 'Replies can only target top-level comments' });
        return;
      }
      parentCommentId = parent.id;
      parentAuthorId = parent.authorId;
    }

    const { segments, mentionedUserIds } = await validateAndNormalizeContent(
      body.content.segments,
      page.workspaceId,
    );

    const content: CommentContent = {
      segments,
      plainText: flattenSegments(segments),
    };

    const comment = await createComment(db, {
      workspaceId: page.workspaceId,
      pageId: page.id,
      blockId,
      parentCommentId,
      authorId: req.user.id,
      content,
    });

    // Notifications: fan-out non-blocking. Errors logged inside the helpers.
    void notifyMentions(comment, mentionedUserIds, { id: page.id, title: page.title });
    if (parentAuthorId) {
      void notifyReply(comment, parentAuthorId, { id: page.id, title: page.title });
    }

    res.status(201).json({ comment: serializeComment(comment) });
  } catch (error: unknown) {
    if (handleZodError(error, res)) return;
    log.general.error({ err: error }, 'Failed to create comment');
    res.status(500).json({ error: 'Failed to create comment' });
  }
});

/**
 * PATCH /comments/:id
 * Edit comment content. Author only, within EDIT_WINDOW_MINUTES.
 */
router.patch('/comments/:id', async (req: Request, res: Response) => {
  try {
    if (!req.user?.id) {
      res.status(401).json({ error: 'Unauthorized' });
      return;
    }
    const params = z.object({ id: objectIdSchema }).parse(req.params);
    const body = updateBodySchema.parse(req.body);

    const db = getDb();
    const comment = await findCommentById(db, params.id);
    if (!comment) {
      res.status(404).json({ error: 'Comment not found' });
      return;
    }

    const ok = await checkWorkspaceMembership(req, res, comment.workspaceId);
    if (!ok) return;

    if (comment.authorId !== req.user.id) {
      res.status(403).json({ error: 'Only the author can edit this comment' });
      return;
    }

    const ageMinutes = (Date.now() - comment.createdAt.getTime()) / 60000;
    if (ageMinutes > EDIT_WINDOW_MINUTES) {
      res.status(403).json({
        error: `Comments can only be edited within ${EDIT_WINDOW_MINUTES} minutes of creation`,
      });
      return;
    }

    const { segments } = await validateAndNormalizeContent(
      body.content.segments,
      comment.workspaceId,
    );

    const updated = await updateCommentContent(
      db,
      comment.id,
      { segments, plainText: flattenSegments(segments) },
      new Date(),
    );
    if (!updated) {
      // Deleted between the read above and the write. Same answer as a miss.
      res.status(404).json({ error: 'Comment not found' });
      return;
    }

    res.json({ comment: serializeComment(updated) });
  } catch (error: unknown) {
    if (handleZodError(error, res)) return;
    log.general.error({ err: error }, 'Failed to update comment');
    res.status(500).json({ error: 'Failed to update comment' });
  }
});

/**
 * POST /comments/:id/resolve
 * Sets resolvedAt. Top-level threads only — replies inherit the thread state.
 */
router.post('/comments/:id/resolve', async (req: Request, res: Response) => {
  try {
    const params = z.object({ id: objectIdSchema }).parse(req.params);

    const db = getDb();
    const comment = await findCommentById(db, params.id);
    if (!comment) {
      res.status(404).json({ error: 'Comment not found' });
      return;
    }
    if (comment.parentCommentId !== null) {
      res.status(400).json({ error: 'Only top-level threads can be resolved' });
      return;
    }

    const ok = await checkWorkspaceMembership(req, res, comment.workspaceId);
    if (!ok) return;

    // Already-resolved is not an error and not a write: the repository's
    // guard is in the WHERE clause, so a null means "already resolved" and the
    // row we read is the answer.
    const resolved =
      comment.resolvedAt === null
        ? await setCommentResolvedAt(db, comment.id, new Date())
        : null;

    res.json({ comment: serializeComment(resolved ?? comment) });
  } catch (error: unknown) {
    if (handleZodError(error, res)) return;
    log.general.error({ err: error }, 'Failed to resolve comment');
    res.status(500).json({ error: 'Failed to resolve comment' });
  }
});

/**
 * POST /comments/:id/unresolve
 * Clears resolvedAt.
 */
router.post('/comments/:id/unresolve', async (req: Request, res: Response) => {
  try {
    const params = z.object({ id: objectIdSchema }).parse(req.params);

    const db = getDb();
    const comment = await findCommentById(db, params.id);
    if (!comment) {
      res.status(404).json({ error: 'Comment not found' });
      return;
    }
    if (comment.parentCommentId !== null) {
      res.status(400).json({ error: 'Only top-level threads can be unresolved' });
      return;
    }

    const ok = await checkWorkspaceMembership(req, res, comment.workspaceId);
    if (!ok) return;

    const unresolved =
      comment.resolvedAt !== null ? await setCommentResolvedAt(db, comment.id, null) : null;

    res.json({ comment: serializeComment(unresolved ?? comment) });
  } catch (error: unknown) {
    if (handleZodError(error, res)) return;
    log.general.error({ err: error }, 'Failed to unresolve comment');
    res.status(500).json({ error: 'Failed to unresolve comment' });
  }
});

/**
 * DELETE /comments/:id
 * Hard-delete the comment. Allowed for the author or workspace admin/owner.
 * Deleting a top-level thread cascades to its replies.
 */
router.delete('/comments/:id', async (req: Request, res: Response) => {
  try {
    if (!req.user?.id) {
      res.status(401).json({ error: 'Unauthorized' });
      return;
    }
    const params = z.object({ id: objectIdSchema }).parse(req.params);

    const db = getDb();
    const comment = await findCommentById(db, params.id);
    if (!comment) {
      res.status(404).json({ error: 'Comment not found' });
      return;
    }

    const ok = await checkWorkspaceMembership(req, res, comment.workspaceId);
    if (!ok) return;

    const isAuthor = comment.authorId === req.user.id;
    const role = req.member?.role;
    const isAdmin = role === 'admin' || role === 'owner';
    if (!isAuthor && !isAdmin) {
      res.status(403).json({ error: 'Only the author or an admin can delete this comment' });
      return;
    }

    // Cascade replies when deleting a top-level thread.
    if (comment.parentCommentId === null) {
      await deleteCommentThread(db, comment.id);
    } else {
      await deleteComment(db, comment.id);
    }

    res.json({ success: true });
  } catch (error: unknown) {
    if (handleZodError(error, res)) return;
    log.general.error({ err: error }, 'Failed to delete comment');
    res.status(500).json({ error: 'Failed to delete comment' });
  }
});

export default router;
