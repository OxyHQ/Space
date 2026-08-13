import { Router, type Request, type Response } from 'express';
import { z } from 'zod';
import { authenticateToken, oxyClient } from '../middleware/auth.js';
import {
  ensurePersonalWorkspace,
  requireRole,
  requireWorkspaceMember,
} from '../middleware/workspace.js';
import { getDb } from '../db/client.js';
import type { WorkspaceRole } from '../db/schema/workspaces.js';
import { deleteArchivedPages } from '../repositories/pages.js';
import {
  addMember,
  archiveWorkspace,
  createWorkspace,
  findMembership,
  listLiveWorkspacesByIds,
  listMembers,
  listMembershipsForUser,
  removeMember,
  updateMemberRole,
  updateWorkspace,
} from '../repositories/workspaces.js';
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

      const db = getDb();
      const memberships = await listMembershipsForUser(db, req.user.id);

      if (memberships.length === 0) {
        res.json({ workspaces: [] });
        return;
      }

      const workspaces = await listLiveWorkspacesByIds(
        db,
        memberships.map((m) => m.workspaceId),
      );

      const roleByWorkspace = new Map<string, WorkspaceRole>();
      for (const m of memberships) {
        roleByWorkspace.set(m.workspaceId, m.role);
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

    // ONE transaction, replacing a two-step create with a hand-rolled
    // rollback. That rollback existed because Mongo transactions need a
    // replica set the dev environment does not assume — but it leaves a real
    // window: if the process dies between the two saves, the workspace exists
    // with no owner and nobody can reach it or delete it. Postgres has real
    // transactions, so the window closes rather than narrows.
    const db = getDb();
    const workspace = await db.transaction(async (tx) => {
      const created = await createWorkspace(tx, {
        name,
        icon: icon ?? null,
        ownerId: userId,
        isPersonal: false,
      });
      const owner = await addMember(tx, {
        workspaceId: created.id,
        userId,
        role: 'owner',
        invitedBy: null,
      });
      if ('duplicate' in owner) {
        // Unreachable in practice — the workspace id was generated inside this
        // transaction, so no membership can already reference it. Throwing
        // rolls the whole thing back rather than returning a workspace whose
        // owner row silently did not land.
        throw new Error('owner membership collided on a freshly created workspace');
      }
      return created;
    });

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
      const updated = await updateWorkspace(getDb(), ws.id, {
        name: parsed.data.name,
        icon: parsed.data.icon,
      });
      if (!updated) {
        res.status(404).json({ error: 'Workspace not found' });
        return;
      }

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

      const archived = await archiveWorkspace(getDb(), ws.id);
      if (!archived) {
        res.status(404).json({ error: 'Workspace not found' });
        return;
      }
      res.json({ success: true, archivedAt: archived.archivedAt });
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

      const members = await listMembers(getDb(), req.workspaceDoc.id);

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
        // The LOUD counterpart to the idempotent provisioning path: "already a
        // member" is an answer this caller must show the user as a 409, not
        // swallow. `addMember` reads the SQLSTATE off `cause` — a ported
        // `err.code === '23505'` matches nothing and the branch collapses.
        const result = await addMember(getDb(), {
          workspaceId: ws.id,
          userId: invitee.id,
          role,
          invitedBy: req.user.id,
        });

        if ('duplicate' in result) {
          res.status(409).json({ error: 'That user is already a member' });
          return;
        }

        res.status(201).json({
          member: {
            userId: result.member.userId,
            role: result.member.role,
            invitedBy: result.member.invitedBy,
            joinedAt: result.member.joinedAt,
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

      const target = await findMembership(getDb(), req.workspaceDoc.id, targetUserId);
      if (!target) {
        res.status(404).json({ error: 'Member not found' });
        return;
      }
      if (target.role === 'owner') {
        res.status(400).json({ error: "Cannot change the owner's role" });
        return;
      }

      const updated = await updateMemberRole(
        getDb(),
        req.workspaceDoc.id,
        targetUserId,
        parsed.data.role,
      );
      if (!updated) {
        res.status(404).json({ error: 'Member not found' });
        return;
      }

      res.json({
        member: {
          userId: updated.userId,
          role: updated.role,
          invitedBy: updated.invitedBy,
          joinedAt: updated.joinedAt,
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

      const target = await findMembership(getDb(), req.workspaceDoc.id, targetUserId);
      if (!target) {
        res.status(404).json({ error: 'Member not found' });
        return;
      }
      if (target.role === 'owner') {
        res.status(400).json({ error: 'The owner cannot be removed' });
        return;
      }

      // `removeMember` reports off RETURNING. Mongo gave `deletedCount`;
      // Postgres gives only `rowCount`, and `rows.length` on a bare DELETE is
      // 0 whether or not anything went.
      const removed = await removeMember(getDb(), req.workspaceDoc.id, targetUserId);
      if (!removed) {
        res.status(404).json({ error: 'Member not found' });
        return;
      }
      res.json({ success: true });
    } catch (error: unknown) {
      log.general.error({ err: error }, 'Failed to remove member');
      res.status(500).json({ error: 'Failed to remove member' });
    }
  },
);

/**
 * POST /api/workspaces/:workspaceId/trash/empty
 *
 * Hard-deletes every archived page in the workspace and their blocks.
 * Owner only — irreversible. Returns the count of removed pages.
 */
router.post(
  '/:workspaceId/trash/empty',
  authenticateToken,
  requireWorkspaceMember,
  requireRole('owner'),
  async (req: Request, res: Response) => {
    try {
      if (!req.workspaceDoc) {
        res.status(500).json({ error: 'Workspace context not loaded' });
        return;
      }

      // Blocks are removed by the `blocks.page_id -> pages.id` cascade, so the
      // explicit Block.deleteMany is gone rather than reimplemented — an
      // application-level cascade racing the database one is worse than either
      // alone. The count comes from RETURNING; the old code fell back to
      // `ids.length` when deletedCount was absent, which reports a full delete
      // for a partial one.
      // The old early return for "nothing archived" is gone with the query it
      // guarded: one statement that deletes zero rows returns 0, which is the
      // same answer for one fewer round trip.
      const deleted = await deleteArchivedPages(getDb(), req.workspaceDoc.id);

      res.json({ success: true, deleted });
    } catch (error: unknown) {
      log.general.error({ err: error }, 'Failed to empty workspace trash');
      res.status(500).json({ error: 'Failed to empty trash' });
    }
  },
);

export default router;
