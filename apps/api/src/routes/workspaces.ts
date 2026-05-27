import { Router, type Request, type Response } from 'express';
import { z } from 'zod';
import { authenticateToken, oxyClient } from '../middleware/auth.js';
import {
  ensurePersonalWorkspace,
  requireRole,
  requireWorkspaceMember,
} from '../middleware/workspace.js';
import { Workspace } from '../models/workspace.js';
import {
  WorkspaceMember,
  WORKSPACE_ROLES,
  type WorkspaceRole,
} from '../models/workspace-member.js';
import { log } from '../lib/logger.js';

const router = Router();

const ICON_MAX_LENGTH = 64;
const WORKSPACE_NAME_MAX = 200;

const createWorkspaceSchema = z.object({
  name: z.string().trim().min(1).max(WORKSPACE_NAME_MAX),
  icon: z.string().max(ICON_MAX_LENGTH).nullable().optional(),
});

const updateWorkspaceSchema = z
  .object({
    name: z.string().trim().min(1).max(WORKSPACE_NAME_MAX).optional(),
    icon: z.string().max(ICON_MAX_LENGTH).nullable().optional(),
  })
  .refine(
    (val) => val.name !== undefined || val.icon !== undefined,
    { message: 'Provide at least one of: name, icon' },
  );

// Members can be invited as any role except `owner`. Owner is reserved
// for the creator and is not transferable in MVP.
const INVITABLE_ROLES: readonly WorkspaceRole[] = ['admin', 'editor', 'commenter', 'viewer'];

const inviteMemberSchema = z.object({
  email: z.string().email(),
  role: z.enum(INVITABLE_ROLES as unknown as [WorkspaceRole, ...WorkspaceRole[]]),
});

const updateMemberSchema = z.object({
  role: z.enum(INVITABLE_ROLES as unknown as [WorkspaceRole, ...WorkspaceRole[]]),
});

function serializeWorkspace(
  ws: { id: string; name: string; icon: string | null; ownerId: string; isPersonal: boolean; archivedAt: Date | null; createdAt: Date; updatedAt: Date },
  role: WorkspaceRole | null,
) {
  return {
    id: ws.id,
    name: ws.name,
    icon: ws.icon,
    ownerId: ws.ownerId,
    isPersonal: ws.isPersonal,
    archivedAt: ws.archivedAt,
    createdAt: ws.createdAt,
    updatedAt: ws.updatedAt,
    role,
  };
}

/**
 * GET /api/workspaces
 *
 * Lists every workspace the caller is a member of, sorted by most recent
 * join. Personal workspace is created lazily on first access via the
 * `ensurePersonalWorkspace` middleware.
 */
router.get(
  '/',
  authenticateToken,
  ensurePersonalWorkspace,
  async (req: Request, res: Response) => {
    try {
      if (!req.user?.id) {
        res.status(401).json({ error: 'Unauthorized' });
        return;
      }

      const memberships = await WorkspaceMember.find({ userId: req.user.id })
        .sort({ joinedAt: -1 })
        .lean();

      if (memberships.length === 0) {
        res.json({ workspaces: [] });
        return;
      }

      const workspaceIds = memberships.map((m) => m.workspaceId);
      const workspaces = await Workspace.find({
        _id: { $in: workspaceIds },
        archivedAt: null,
      });

      const roleByWorkspace = new Map<string, WorkspaceRole>();
      for (const m of memberships) {
        roleByWorkspace.set(String(m.workspaceId), m.role);
      }

      const serialized = workspaces
        .map((ws) => {
          const role = roleByWorkspace.get(ws.id) ?? null;
          return serializeWorkspace(
            {
              id: ws.id,
              name: ws.name,
              icon: ws.icon,
              ownerId: ws.ownerId,
              isPersonal: ws.isPersonal,
              archivedAt: ws.archivedAt,
              createdAt: ws.createdAt,
              updatedAt: ws.updatedAt,
            },
            role,
          );
        })
        // Stable ordering: personal first, then most recently joined.
        .sort((a, b) => {
          if (a.isPersonal !== b.isPersonal) return a.isPersonal ? -1 : 1;
          return b.createdAt.getTime() - a.createdAt.getTime();
        });

      res.json({ workspaces: serialized });
    } catch (error: unknown) {
      log.general.error({ err: error }, 'Failed to list workspaces');
      res.status(500).json({ error: 'Failed to list workspaces' });
    }
  },
);

/**
 * POST /api/workspaces
 *
 * Create a new shared workspace. Caller becomes the owner. Personal
 * workspaces cannot be created via this endpoint (they are auto-created).
 */
router.post('/', authenticateToken, async (req: Request, res: Response) => {
  try {
    if (!req.user?.id) {
      res.status(401).json({ error: 'Unauthorized' });
      return;
    }

    const parsed = createWorkspaceSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: 'Invalid body', details: parsed.error.flatten() });
      return;
    }

    const userId = req.user.id;
    const { name, icon } = parsed.data;

    // Two-step create. MongoDB transactions require a replica set which we
    // do not assume in dev. On member-create failure we roll back the
    // workspace so we never leak an unowned shared workspace.
    const workspace = new Workspace({
      name,
      icon: icon ?? null,
      ownerId: userId,
      isPersonal: false,
    });
    await workspace.save();

    try {
      const member = new WorkspaceMember({
        workspaceId: workspace._id,
        userId,
        role: 'owner',
        invitedBy: null,
        joinedAt: new Date(),
      });
      await member.save();
    } catch (memberErr: unknown) {
      log.general.error(
        { err: memberErr, workspaceId: workspace.id },
        'Owner member create failed, rolling back workspace',
      );
      await workspace.deleteOne().catch((rollbackErr: unknown) => {
        log.general.error(
          { err: rollbackErr, workspaceId: workspace.id },
          'Workspace rollback failed',
        );
      });
      throw memberErr;
    }

    res.status(201).json({
      workspace: serializeWorkspace(
        {
          id: workspace.id,
          name: workspace.name,
          icon: workspace.icon,
          ownerId: workspace.ownerId,
          isPersonal: workspace.isPersonal,
          archivedAt: workspace.archivedAt,
          createdAt: workspace.createdAt,
          updatedAt: workspace.updatedAt,
        },
        'owner',
      ),
    });
  } catch (error: unknown) {
    log.general.error({ err: error }, 'Failed to create workspace');
    res.status(500).json({ error: 'Failed to create workspace' });
  }
});

/**
 * GET /api/workspaces/:workspaceId
 *
 * Fetch a single workspace. Caller must be a member.
 */
router.get(
  '/:workspaceId',
  authenticateToken,
  requireWorkspaceMember,
  async (req: Request, res: Response) => {
    if (!req.workspaceDoc || !req.member) {
      res.status(500).json({ error: 'Workspace context not loaded' });
      return;
    }

    const ws = req.workspaceDoc;
    res.json({
      workspace: serializeWorkspace(
        {
          id: ws.id,
          name: ws.name,
          icon: ws.icon,
          ownerId: ws.ownerId,
          isPersonal: ws.isPersonal,
          archivedAt: ws.archivedAt,
          createdAt: ws.createdAt,
          updatedAt: ws.updatedAt,
        },
        req.member.role,
      ),
    });
  },
);

/**
 * PATCH /api/workspaces/:workspaceId
 *
 * Update workspace metadata (name, icon). Admin role or higher.
 */
router.patch(
  '/:workspaceId',
  authenticateToken,
  requireWorkspaceMember,
  requireRole('admin'),
  async (req: Request, res: Response) => {
    try {
      if (!req.workspaceDoc || !req.member) {
        res.status(500).json({ error: 'Workspace context not loaded' });
        return;
      }

      const parsed = updateWorkspaceSchema.safeParse(req.body);
      if (!parsed.success) {
        res.status(400).json({ error: 'Invalid body', details: parsed.error.flatten() });
        return;
      }

      const ws = req.workspaceDoc;
      if (parsed.data.name !== undefined) ws.name = parsed.data.name;
      if (parsed.data.icon !== undefined) ws.icon = parsed.data.icon;
      await ws.save();

      res.json({
        workspace: serializeWorkspace(
          {
            id: ws.id,
            name: ws.name,
            icon: ws.icon,
            ownerId: ws.ownerId,
            isPersonal: ws.isPersonal,
            archivedAt: ws.archivedAt,
            createdAt: ws.createdAt,
            updatedAt: ws.updatedAt,
          },
          req.member.role,
        ),
      });
    } catch (error: unknown) {
      log.general.error({ err: error }, 'Failed to update workspace');
      res.status(500).json({ error: 'Failed to update workspace' });
    }
  },
);

/**
 * DELETE /api/workspaces/:workspaceId
 *
 * Soft-delete (archive) the workspace. Owner only. Personal workspaces
 * cannot be archived — the user always has their personal space.
 *
 * Cascade behavior for pages/blocks is intentionally out of scope here;
 * that lives in the Phase 1/Phase 4 cleanup work.
 */
router.delete(
  '/:workspaceId',
  authenticateToken,
  requireWorkspaceMember,
  requireRole('owner'),
  async (req: Request, res: Response) => {
    try {
      if (!req.workspaceDoc) {
        res.status(500).json({ error: 'Workspace context not loaded' });
        return;
      }

      const ws = req.workspaceDoc;
      if (ws.isPersonal) {
        res.status(400).json({ error: 'Personal workspaces cannot be archived' });
        return;
      }

      if (ws.archivedAt) {
        res.json({ success: true, alreadyArchived: true });
        return;
      }

      ws.archivedAt = new Date();
      await ws.save();
      res.json({ success: true, archivedAt: ws.archivedAt });
    } catch (error: unknown) {
      log.general.error({ err: error }, 'Failed to archive workspace');
      res.status(500).json({ error: 'Failed to archive workspace' });
    }
  },
);

/**
 * GET /api/workspaces/:workspaceId/members
 *
 * List all members of a workspace with their roles. Any member can view.
 */
router.get(
  '/:workspaceId/members',
  authenticateToken,
  requireWorkspaceMember,
  async (req: Request, res: Response) => {
    try {
      if (!req.workspaceDoc) {
        res.status(500).json({ error: 'Workspace context not loaded' });
        return;
      }

      const members = await WorkspaceMember.find({ workspaceId: req.workspaceDoc._id })
        .sort({ joinedAt: 1 })
        .lean();

      res.json({
        members: members.map((m) => ({
          userId: m.userId,
          role: m.role,
          invitedBy: m.invitedBy,
          joinedAt: m.joinedAt,
        })),
      });
    } catch (error: unknown) {
      log.general.error({ err: error }, 'Failed to list workspace members');
      res.status(500).json({ error: 'Failed to list members' });
    }
  },
);

/**
 * Find an Oxy user by email via the SDK's `searchProfiles` method. Returns
 * the matching user or null. Email match is case-insensitive and exact.
 */
async function findUserByEmail(email: string): Promise<{ id: string; email?: string } | null> {
  try {
    const response = await oxyClient.searchProfiles(email, { limit: 5 });
    const target = email.toLowerCase();
    const hit = response.data.find(
      (u) => typeof u.email === 'string' && u.email.toLowerCase() === target,
    );
    if (!hit) return null;
    return { id: hit.id, email: hit.email };
  } catch (err: unknown) {
    log.general.warn({ err, email }, 'searchProfiles failed during workspace invite');
    return null;
  }
}

/**
 * POST /api/workspaces/:workspaceId/members
 *
 * Invite a user by email. Admin role or higher.
 *
 * We refuse to create Oxy accounts on the caller's behalf — if the email
 * does not resolve to an existing Oxy user we 404 with a clear message.
 */
router.post(
  '/:workspaceId/members',
  authenticateToken,
  requireWorkspaceMember,
  requireRole('admin'),
  async (req: Request, res: Response) => {
    try {
      if (!req.workspaceDoc || !req.user?.id) {
        res.status(500).json({ error: 'Workspace context not loaded' });
        return;
      }

      const parsed = inviteMemberSchema.safeParse(req.body);
      if (!parsed.success) {
        res.status(400).json({ error: 'Invalid body', details: parsed.error.flatten() });
        return;
      }

      const { email, role } = parsed.data;

      const ws = req.workspaceDoc;
      if (ws.isPersonal) {
        res.status(400).json({ error: 'Personal workspaces cannot have additional members' });
        return;
      }

      const invitee = await findUserByEmail(email);
      if (!invitee) {
        res.status(404).json({
          error: 'No Oxy user found with that email',
          code: 'INVITEE_NOT_FOUND',
          message:
            'Ask them to sign up at Oxy first — we do not create accounts on a user\'s behalf.',
        });
        return;
      }

      try {
        const member = await WorkspaceMember.create({
          workspaceId: ws._id,
          userId: invitee.id,
          role,
          invitedBy: req.user.id,
          joinedAt: new Date(),
        });

        res.status(201).json({
          member: {
            userId: member.userId,
            role: member.role,
            invitedBy: member.invitedBy,
            joinedAt: member.joinedAt,
          },
        });
      } catch (createErr: unknown) {
        const code = (createErr as { code?: number } | null)?.code;
        if (code === 11000) {
          res.status(409).json({ error: 'User is already a member of this workspace' });
          return;
        }
        throw createErr;
      }
    } catch (error: unknown) {
      log.general.error({ err: error }, 'Failed to invite member');
      res.status(500).json({ error: 'Failed to invite member' });
    }
  },
);

/**
 * PATCH /api/workspaces/:workspaceId/members/:userId
 *
 * Change a member's role. Admin or higher. The owner's role cannot be
 * changed (ownership transfer is out of scope for MVP).
 */
router.patch(
  '/:workspaceId/members/:userId',
  authenticateToken,
  requireWorkspaceMember,
  requireRole('admin'),
  async (req: Request, res: Response) => {
    try {
      if (!req.workspaceDoc) {
        res.status(500).json({ error: 'Workspace context not loaded' });
        return;
      }

      const parsed = updateMemberSchema.safeParse(req.body);
      if (!parsed.success) {
        res.status(400).json({ error: 'Invalid body', details: parsed.error.flatten() });
        return;
      }

      const targetUserId = typeof req.params.userId === 'string' ? req.params.userId : null;
      if (!targetUserId) {
        res.status(400).json({ error: 'Target user id required' });
        return;
      }

      const target = await WorkspaceMember.findOne({
        workspaceId: req.workspaceDoc._id,
        userId: targetUserId,
      });
      if (!target) {
        res.status(404).json({ error: 'Member not found' });
        return;
      }
      if (target.role === 'owner') {
        res.status(400).json({ error: "Cannot change the owner's role" });
        return;
      }

      target.role = parsed.data.role;
      await target.save();

      res.json({
        member: {
          userId: target.userId,
          role: target.role,
          invitedBy: target.invitedBy,
          joinedAt: target.joinedAt,
        },
      });
    } catch (error: unknown) {
      log.general.error({ err: error }, 'Failed to update member role');
      res.status(500).json({ error: 'Failed to update member' });
    }
  },
);

/**
 * DELETE /api/workspaces/:workspaceId/members/:userId
 *
 * Remove a member. The owner cannot be removed. Admins can remove anyone
 * except the owner. Any member can remove themselves (self-leave).
 */
router.delete(
  '/:workspaceId/members/:userId',
  authenticateToken,
  requireWorkspaceMember,
  async (req: Request, res: Response) => {
    try {
      if (!req.workspaceDoc || !req.user?.id || !req.member) {
        res.status(500).json({ error: 'Workspace context not loaded' });
        return;
      }

      const targetUserId = typeof req.params.userId === 'string' ? req.params.userId : null;
      if (!targetUserId) {
        res.status(400).json({ error: 'Target user id required' });
        return;
      }

      const isSelfRemoval = targetUserId === req.user.id;
      const callerIsAdminOrHigher =
        req.member.role === 'admin' || req.member.role === 'owner';

      if (!isSelfRemoval && !callerIsAdminOrHigher) {
        res.status(403).json({ error: 'Forbidden: only admins can remove other members' });
        return;
      }

      const target = await WorkspaceMember.findOne({
        workspaceId: req.workspaceDoc._id,
        userId: targetUserId,
      });
      if (!target) {
        res.status(404).json({ error: 'Member not found' });
        return;
      }
      if (target.role === 'owner') {
        res.status(400).json({ error: 'The owner cannot be removed' });
        return;
      }

      await target.deleteOne();
      res.json({ success: true });
    } catch (error: unknown) {
      log.general.error({ err: error }, 'Failed to remove member');
      res.status(500).json({ error: 'Failed to remove member' });
    }
  },
);

export default router;
