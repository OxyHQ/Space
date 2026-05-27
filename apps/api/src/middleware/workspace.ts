import { Request, Response, NextFunction } from 'express';
import mongoose from 'mongoose';
import { Workspace } from '../models/workspace.js';
import {
  WorkspaceMember,
  hasRole,
  type WorkspaceRole,
} from '../models/workspace-member.js';
import { oxyClient } from './auth.js';
import { log } from '../lib/logger.js';

/**
 * Resolves the X-Workspace-Id header into `req.workspace` without touching
 * the database. Useful for endpoints that need workspace context but do
 * not require strict membership verification.
 *
 * NOTE: This is the legacy passthrough resolver — use
 * `requireWorkspaceMember` for any endpoint that owns workspace resources.
 */
export async function resolveWorkspace(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  const headerValue = req.headers['x-workspace-id'];
  const workspaceId = typeof headerValue === 'string' ? headerValue : undefined;

  if (!workspaceId || workspaceId === 'personal') {
    req.workspace = { id: null };
    next();
    return;
  }

  if (!req.user?.id) {
    res.status(401).json({
      error: 'Authentication required',
      code: 'MISSING_AUTH',
      message: 'Authentication required',
    });
    return;
  }

  req.workspace = { id: workspaceId };
  next();
}

/**
 * Extract a workspace id from common locations: route param, query, header.
 */
function readWorkspaceId(req: Request): string | null {
  const fromParam = req.params?.workspaceId;
  if (typeof fromParam === 'string' && fromParam.length > 0) return fromParam;

  const fromQuery = req.query?.workspaceId;
  if (typeof fromQuery === 'string' && fromQuery.length > 0) return fromQuery;

  const fromHeader = req.header('X-Workspace-Id');
  if (typeof fromHeader === 'string' && fromHeader.length > 0 && fromHeader !== 'personal') {
    return fromHeader;
  }

  return null;
}

/**
 * Asserts the caller is an authenticated, active member of the resolved
 * workspace. On success attaches `req.workspaceDoc` and `req.member`.
 *
 * 400 if no workspace id can be resolved.
 * 401 if no authenticated user.
 * 403 if the user is not a member of the workspace.
 * 404 if the workspace does not exist or is archived.
 */
export async function requireWorkspaceMember(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    if (!req.user?.id) {
      res.status(401).json({ error: 'Unauthorized' });
      return;
    }

    const workspaceId = readWorkspaceId(req);
    if (!workspaceId) {
      res.status(400).json({
        error: 'Workspace id required',
        code: 'WORKSPACE_ID_MISSING',
        message: 'Provide workspaceId via route param, query string, or X-Workspace-Id header.',
      });
      return;
    }

    if (!mongoose.isValidObjectId(workspaceId)) {
      res.status(400).json({ error: 'Invalid workspace id' });
      return;
    }

    const [workspace, member] = await Promise.all([
      Workspace.findById(workspaceId),
      WorkspaceMember.findOne({ workspaceId, userId: req.user.id }),
    ]);

    if (!workspace || workspace.archivedAt) {
      res.status(404).json({ error: 'Workspace not found' });
      return;
    }

    if (!member) {
      res.status(403).json({ error: 'Forbidden: not a workspace member' });
      return;
    }

    req.workspaceDoc = workspace;
    req.member = member;
    req.workspace = { id: workspace.id, role: member.role };
    next();
  } catch (error: unknown) {
    log.general.error({ err: error }, 'requireWorkspaceMember failed');
    res.status(500).json({ error: 'Failed to verify workspace membership' });
  }
}

/**
 * Returns a middleware that asserts `req.member.role` is at least `minRole`.
 *
 * Must be chained AFTER `requireWorkspaceMember`. If used standalone, it
 * 500s — that is a programming error, not a runtime expectation.
 */
export function requireRole(minRole: WorkspaceRole) {
  return function requireRoleMiddleware(
    req: Request,
    res: Response,
    next: NextFunction,
  ): void {
    if (!req.member) {
      log.general.error(
        { path: req.path },
        'requireRole used without requireWorkspaceMember',
      );
      res.status(500).json({ error: 'Server misconfigured' });
      return;
    }

    if (!hasRole(req.member.role, minRole)) {
      res.status(403).json({
        error: 'Forbidden: insufficient role',
        code: 'INSUFFICIENT_ROLE',
        required: minRole,
        actual: req.member.role,
      });
      return;
    }

    next();
  };
}

/**
 * Build a default display name for the personal workspace.
 *
 * Tries (in order):
 *   - user.name.full
 *   - user.name.first
 *   - user.username
 *   - user.email (local part)
 *   - "My Workspace"
 */
function defaultPersonalWorkspaceName(user: {
  username?: string;
  email?: string;
  name?: { full?: string; first?: string } | null;
} | null): string {
  if (!user) return 'My Workspace';
  const fullName = user.name?.full?.trim();
  if (fullName) return `${fullName}'s Workspace`;
  const firstName = user.name?.first?.trim();
  if (firstName) return `${firstName}'s Workspace`;
  if (user.username) return `${user.username}'s Workspace`;
  if (user.email) {
    const local = user.email.split('@')[0];
    if (local) return `${local}'s Workspace`;
  }
  return 'My Workspace';
}

/**
 * Idempotently ensures the authenticated caller has a personal workspace
 * with themselves as the `owner` member. Safe to invoke on every
 * authenticated request.
 *
 * If creation races (two parallel requests for the same new user), the
 * partial unique index on `Workspace { ownerId, isPersonal }` forces a
 * single winner; the loser swallows the duplicate-key error and reads
 * the existing row.
 */
export async function ensurePersonalWorkspace(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    if (!req.user?.id) {
      res.status(401).json({ error: 'Unauthorized' });
      return;
    }

    const userId = req.user.id;
    const existing = await Workspace.findOne({ ownerId: userId, isPersonal: true });
    if (existing) {
      next();
      return;
    }

    // Fetch user info for a friendlier default name. Failure is non-fatal —
    // we fall back to "My Workspace".
    let displayUser: {
      username?: string;
      email?: string;
      name?: { full?: string; first?: string } | null;
    } | null = null;
    try {
      const oxyUser = await oxyClient.getUserById(userId);
      if (oxyUser) {
        displayUser = {
          username: oxyUser.username,
          email: oxyUser.email,
          name: oxyUser.name
            ? { full: oxyUser.name.full, first: oxyUser.name.first }
            : null,
        };
      }
    } catch (lookupErr: unknown) {
      log.general.warn(
        { err: lookupErr, userId },
        'ensurePersonalWorkspace: failed to fetch user from Oxy (continuing with default name)',
      );
    }

    const name = defaultPersonalWorkspaceName(displayUser);

    let workspaceId: mongoose.Types.ObjectId;
    try {
      const created = await Workspace.create({
        name,
        icon: null,
        ownerId: userId,
        isPersonal: true,
      });
      workspaceId = created._id as mongoose.Types.ObjectId;
    } catch (createErr: unknown) {
      // Race: another request created the personal workspace concurrently.
      // Mongo duplicate key error has code 11000.
      const code = (createErr as { code?: number } | null)?.code;
      if (code === 11000) {
        const existingAfterRace = await Workspace.findOne({
          ownerId: userId,
          isPersonal: true,
        });
        if (!existingAfterRace) {
          throw createErr;
        }
        next();
        return;
      }
      throw createErr;
    }

    // Owner membership row. Same race story — owner row may have been
    // created by the winning request; tolerate duplicate key.
    try {
      await WorkspaceMember.create({
        workspaceId,
        userId,
        role: 'owner',
        invitedBy: null,
        joinedAt: new Date(),
      });
    } catch (memberErr: unknown) {
      const code = (memberErr as { code?: number } | null)?.code;
      if (code !== 11000) {
        throw memberErr;
      }
    }

    next();
  } catch (error: unknown) {
    log.general.error({ err: error }, 'ensurePersonalWorkspace failed');
    res.status(500).json({ error: 'Failed to provision personal workspace' });
  }
}
