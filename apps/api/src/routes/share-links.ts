import { Router, type Request, type Response } from 'express';
import crypto from 'crypto';
import mongoose, { type HydratedDocument } from 'mongoose';
import { z } from 'zod';
import { authenticateToken } from '../middleware/auth.js';
import { Page, type IPage } from '../models/page.js';
import { Block } from '../models/block.js';
import { WorkspaceMember, hasRole } from '../models/workspace-member.js';
import {
  ShareLink,
  SHARE_LINK_SCOPES,
  type ShareLinkScope,
} from '../models/share-link.js';
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

type LoadedPage = HydratedDocument<IPage>;

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
  if (!pageId || !mongoose.isValidObjectId(pageId)) {
    res.status(400).json({ error: 'Invalid page id' });
    return null;
  }

  const page = await Page.findById(pageId);
  if (!page) {
    res.status(404).json({ error: 'Page not found' });
    return null;
  }

  const member = await WorkspaceMember.findOne({
    workspaceId: page.workspaceId,
    userId: req.user.id,
  });

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
      let saved = false;
      let attempts = 0;
      const link = new ShareLink({
        pageId: page._id,
        token: '',
        scope: parsed.data.scope,
        createdBy: userId,
        expiresAt,
        revokedAt: null,
      });

      while (!saved && attempts < 5) {
        attempts++;
        link.token = generateToken();
        try {
          await link.save();
          saved = true;
        } catch (createErr: unknown) {
          const code = (createErr as { code?: number } | null)?.code;
          if (code !== 11000) throw createErr;
          link.isNew = true;
        }
      }

      if (!saved) {
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

      const now = new Date();
      const links = await ShareLink.find({
        pageId: page._id,
        revokedAt: null,
        $or: [{ expiresAt: null }, { expiresAt: { $gt: now } }],
      })
        .sort({ createdAt: -1 })
        .lean();

      res.json({
        shareLinks: links.map((l) => ({
          id: String(l._id),
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
      if (!id || !mongoose.isValidObjectId(id)) {
        res.status(400).json({ error: 'Invalid share link id' });
        return;
      }

      const link = await ShareLink.findById(id);
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
        const page = await Page.findById(link.pageId);
        if (!page) {
          // Page already gone; allow workspace-less revoke only by creator.
          res.status(404).json({ error: 'Linked page not found' });
          return;
        }
        const member = await WorkspaceMember.findOne({
          workspaceId: page.workspaceId,
          userId: req.user.id,
        });
        isWorkspaceAdmin = !!member && hasRole(member.role, 'admin');
      }

      if (!isCreator && !isWorkspaceAdmin) {
        res.status(403).json({ error: 'Forbidden' });
        return;
      }

      link.revokedAt = new Date();
      await link.save();
      res.json({ success: true, revokedAt: link.revokedAt });
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

    const link = await ShareLink.findOne({ token });
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

    const page = await Page.findById(link.pageId);
    if (!page || page.archived) {
      res.status(404).json({ error: 'Shared page is no longer available' });
      return;
    }

    const blocks = await Block.find({ pageId: page._id })
      .sort({ order: 1 })
      .lean();

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
        id: String(b._id),
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
