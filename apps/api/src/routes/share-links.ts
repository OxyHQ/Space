import { Router, type Request, type Response } from 'express';
import crypto from 'crypto';
import { z } from 'zod';
import { authenticateToken } from '../middleware/auth.js';
import { getDb } from '../db/client.js';
import { hasRole } from '../db/schema/workspaces.js';
import { SHARE_LINK_SCOPES, type ShareLinkScope } from '../db/schema/collab.js';
import { listBlocksForPageByOrder } from '../repositories/blocks.js';
import { findPageById, type PageRow } from '../repositories/pages.js';
import {
  createShareLink,
  findShareLinkById,
  findShareLinkByToken,
  listActiveShareLinksByPage,
  revokeShareLink,
} from '../repositories/shareLinks.js';
import { findMembership } from '../repositories/workspaces.js';
import { log } from '../lib/logger.js';

const router = Router();

const TOKEN_BYTES = 24; // base64url of 24 random bytes ≈ 32 chars

function generateToken(): string {
  // base64url is url-safe (RFC 4648 §5) — no padding, only [A-Za-z0-9_-]
  return crypto.randomBytes(TOKEN_BYTES).toString('base64url');
}

function shareLinkPublicUrl(token: string): string {
  const base = process.env.OXYSTATION_PUBLIC_URL || 'https://station.oxy.so';
  return `${base.replace(/\/$/, '')}/share/${token}`;
}

const createShareLinkSchema = z.object({
  scope: z
    .enum(SHARE_LINK_SCOPES as unknown as [ShareLinkScope, ...ShareLinkScope[]])
    .default('read'),
  expiresAt: z
    .string()
    .datetime({ offset: true })
    .nullable()
    .optional(),
});

/**
 * Narrow an Express route param to a single string, normalizing the
 * `string | string[]` shape Express types declare for path params.
 */
function paramString(value: unknown): string | null {
  if (typeof value === 'string' && value.length > 0) return value;
  return null;
}

type LoadedPage = PageRow;

/**
 * Asserts the caller is a member of the workspace owning `pageId` with at
 * least the role `editor`. Returns the page on success, or null after
 * having already sent an error response.
 */
async function authorizePageForShareManagement(
  req: Request,
  res: Response,
  pageIdRaw: unknown,
): Promise<{ page: LoadedPage } | null> {
  if (!req.user?.id) {
    res.status(401).json({ error: 'Unauthorized' });
    return null;
  }

  const pageId = paramString(pageIdRaw);
  if (!pageId) {
    res.status(400).json({ error: 'Invalid page id' });
    return null;
  }

  // No 24-hex shape gate: it rejected every uuidv7 the schema now produces. A
  // malformed id matches no row and falls through to the 404 below.
  const db = getDb();
  const page = await findPageById(db, pageId);
  if (!page) {
    res.status(404).json({ error: 'Page not found' });
    return null;
  }

  const member = await findMembership(db, page.workspaceId, req.user.id);

  if (!member) {
    res.status(403).json({ error: 'Forbidden: not a workspace member' });
    return null;
  }

  if (!hasRole(member.role, 'editor')) {
    res.status(403).json({ error: 'Forbidden: editor role required to manage share links' });
    return null;
  }

  return { page };
}

/**
 * POST /api/pages/:pageId/share
 *
 * Create a new share link for a page. Requires editor+ on the page's
 * workspace.
 */
router.post(
  '/pages/:pageId/share',
  authenticateToken,
  async (req: Request, res: Response) => {
    try {
      const auth = await authorizePageForShareManagement(req, res, req.params.pageId);
      if (!auth) return;
      const { page } = auth;
      const userId = req.user?.id;
      if (!userId) {
        // authorize* already 401s if missing; this re-check keeps TS happy.
        res.status(401).json({ error: 'Unauthorized' });
        return;
      }

      const parsed = createShareLinkSchema.safeParse(req.body ?? {});
      if (!parsed.success) {
        res.status(400).json({ error: 'Invalid body', details: parsed.error.flatten() });
        return;
      }

      const expiresAt = parsed.data.expiresAt ? new Date(parsed.data.expiresAt) : null;
      if (expiresAt && expiresAt.getTime() <= Date.now()) {
        res.status(400).json({ error: 'expiresAt must be in the future' });
        return;
      }

      // Up to a few retries in the extremely unlikely event of a token
      // collision. base64url(24) gives 192 bits of entropy; collisions are
      // not expected in practice.
      // `createShareLink` uses ON CONFLICT DO NOTHING RETURNING, so a token
      // collision comes back as null rather than as an exception. That is the
      // whole point: the ported `code === 11000` catch could not tell a
      // collision from a dropped connection, and would have retried — with a
      // fresh token — against an infrastructure failure. Here a real failure
      // still throws out of the loop.
      let link: Awaited<ReturnType<typeof createShareLink>> = null;
      let attempts = 0;
      while (!link && attempts < 5) {
        attempts++;
        link = await createShareLink(getDb(), {
          pageId: page.id,
          token: generateToken(),
          scope: parsed.data.scope,
          createdBy: userId,
          expiresAt,
        });
      }

      if (!link) {
        log.general.error({ pageId: page.id }, 'Failed to generate unique share token');
        res.status(500).json({ error: 'Failed to generate share link' });
        return;
      }

      res.status(201).json({
        shareLink: {
          id: link.id,
          token: link.token,
          url: shareLinkPublicUrl(link.token),
          scope: link.scope,
          expiresAt: link.expiresAt,
          createdAt: link.createdAt,
          createdBy: link.createdBy,
        },
      });
    } catch (error: unknown) {
      log.general.error({ err: error }, 'Failed to create share link');
      res.status(500).json({ error: 'Failed to create share link' });
    }
  },
);

/**
 * GET /api/pages/:pageId/share
 *
 * List active (non-revoked, non-expired) share links for a page. Requires
 * editor+ on the page's workspace — same authority as creating one, since
 * the token itself is sensitive.
 */
router.get(
  '/pages/:pageId/share',
  authenticateToken,
  async (req: Request, res: Response) => {
    try {
      const auth = await authorizePageForShareManagement(req, res, req.params.pageId);
      if (!auth) return;
      const { page } = auth;

      const links = await listActiveShareLinksByPage(getDb(), page.id, new Date());

      res.json({
        shareLinks: links.map((l) => ({
          id: l.id,
          token: l.token,
          url: shareLinkPublicUrl(l.token),
          scope: l.scope,
          createdBy: l.createdBy,
          expiresAt: l.expiresAt,
          createdAt: l.createdAt,
        })),
      });
    } catch (error: unknown) {
      log.general.error({ err: error }, 'Failed to list share links');
      res.status(500).json({ error: 'Failed to list share links' });
    }
  },
);

/**
 * DELETE /api/share-links/:id
 *
 * Revoke a share link. Allowed for: the link creator, or any admin+
 * member of the workspace that owns the linked page.
 */
router.delete(
  '/share-links/:id',
  authenticateToken,
  async (req: Request, res: Response) => {
    try {
      if (!req.user?.id) {
        res.status(401).json({ error: 'Unauthorized' });
        return;
      }

      const id = paramString(req.params.id);
      if (!id) {
        res.status(400).json({ error: 'Invalid share link id' });
        return;
      }

      const db = getDb();
      const link = await findShareLinkById(db, id);
      if (!link) {
        res.status(404).json({ error: 'Share link not found' });
        return;
      }

      if (link.revokedAt) {
        res.json({ success: true, alreadyRevoked: true });
        return;
      }

      const isCreator = link.createdBy === req.user.id;
      let isWorkspaceAdmin = false;
      if (!isCreator) {
        const page = await findPageById(db, link.pageId);
        if (!page) {
          // Page already gone; allow workspace-less revoke only by creator.
          res.status(404).json({ error: 'Linked page not found' });
          return;
        }
        const member = await findMembership(db, page.workspaceId, req.user.id);
        isWorkspaceAdmin = !!member && hasRole(member.role, 'admin');
      }

      if (!isCreator && !isWorkspaceAdmin) {
        res.status(403).json({ error: 'Forbidden' });
        return;
      }

      // `revokeShareLink` only stamps a link that is not already revoked, so a
      // null here means someone revoked it between the read above and now. That
      // is the same answer the early return gives, not an error.
      const revoked = await revokeShareLink(db, link.id, new Date());
      res.json({ success: true, revokedAt: revoked?.revokedAt ?? link.revokedAt, alreadyRevoked: !revoked });
    } catch (error: unknown) {
      log.general.error({ err: error }, 'Failed to revoke share link');
      res.status(500).json({ error: 'Failed to revoke share link' });
    }
  },
);

/**
 * GET /api/share/:token
 *
 * Public, unauthenticated read of a shared page. Returns the page metadata
 * and its non-archived blocks. 404 on revoked, expired, or missing tokens.
 */
router.get('/share/:token', async (req: Request, res: Response) => {
  try {
    const token = paramString(req.params.token);
    if (!token || token.length < 8 || token.length > 128) {
      res.status(404).json({ error: 'Share link not found' });
      return;
    }

    const db = getDb();
    const link = await findShareLinkByToken(db, token);
    if (!link) {
      res.status(404).json({ error: 'Share link not found' });
      return;
    }
    if (link.revokedAt) {
      res.status(404).json({ error: 'Share link has been revoked' });
      return;
    }
    if (link.expiresAt && link.expiresAt.getTime() <= Date.now()) {
      res.status(404).json({ error: 'Share link has expired' });
      return;
    }

    const page = await findPageById(db, link.pageId);
    if (!page || page.archived) {
      res.status(404).json({ error: 'Shared page is no longer available' });
      return;
    }

    // Ordering lives in the repository (`...ByOrder`) rather than in a chained
    // `.sort()` here, so every reader of a page's blocks gets the same order.
    const blocks = await listBlocksForPageByOrder(db, page.id);

    res.json({
      page: {
        id: page.id,
        title: page.title,
        icon: page.icon,
        cover: page.cover,
        parentId: page.parentId,
        createdAt: page.createdAt,
        updatedAt: page.updatedAt,
      },
      blocks: blocks.map((b) => ({
        id: b.id,
        pageId: String(b.pageId),
        parentBlockId: b.parentBlockId ? String(b.parentBlockId) : null,
        type: b.type,
        content: b.content,
        order: b.order,
      })),
      share: {
        scope: link.scope,
        expiresAt: link.expiresAt,
      },
    });
  } catch (error: unknown) {
    log.general.error({ err: error }, 'Failed to resolve share link');
    res.status(500).json({ error: 'Failed to load shared page' });
  }
});

export default router;
