import { OxyServices } from '@oxyhq/core';
import {
  createOxyAuthMiddleware,
  type OxyRequestUser,
} from '@oxyhq/core/server';
import type { WorkspaceRole } from '../db/schema/workspaces.js';
import type { WorkspaceMemberRow, WorkspaceRow } from '../repositories/workspaces.js';

const OXY_API_URL = process.env.OXY_API_URL || 'https://api.oxy.so';
export const oxyClient = new OxyServices({
  baseURL: OXY_API_URL,
});

declare global {
  namespace Express {
    interface Request {
      userId?: string;
      accessToken?: string;
      user?: OxyRequestUser | null;
      workspaceDoc?: WorkspaceRow;
      member?: WorkspaceMemberRow;
      workspace?: {
        id: string | null;
        role?: WorkspaceRole;
      };
    }
  }
}

/** Validate an Oxy session and attach its user context to the request. */
export const authenticateToken = createOxyAuthMiddleware(oxyClient, {
  auth: { debug: true },
});
