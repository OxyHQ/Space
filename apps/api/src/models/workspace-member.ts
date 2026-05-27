import mongoose, { Schema, Model, Document, HydratedDocument } from 'mongoose';

/**
 * Role hierarchy from least privileged to most. The middleware
 * `requireRole(minRole)` compares against this ordering.
 */
export type WorkspaceRole = 'viewer' | 'commenter' | 'editor' | 'admin' | 'owner';

export const WORKSPACE_ROLES: WorkspaceRole[] = [
  'viewer',
  'commenter',
  'editor',
  'admin',
  'owner',
];

/**
 * Compare two roles. Returns:
 *   <0 if a < b, 0 if equal, >0 if a > b.
 */
export function compareRoles(a: WorkspaceRole, b: WorkspaceRole): number {
  return WORKSPACE_ROLES.indexOf(a) - WORKSPACE_ROLES.indexOf(b);
}

/**
 * Returns true when `actual` has at least the privilege of `required`.
 */
export function hasRole(actual: WorkspaceRole, required: WorkspaceRole): boolean {
  return compareRoles(actual, required) >= 0;
}

export interface IWorkspaceMember extends Document {
  workspaceId: mongoose.Types.ObjectId;
  /** Oxy user id (string). See note on Workspace.ownerId. */
  userId: string;
  role: WorkspaceRole;
  /** User id of the inviter, or null for the auto-created owner row. */
  invitedBy: string | null;
  joinedAt: Date;
  createdAt: Date;
  updatedAt: Date;
}

export type WorkspaceMemberDoc = HydratedDocument<IWorkspaceMember>;

const WorkspaceMemberSchema = new Schema<IWorkspaceMember>(
  {
    workspaceId: {
      type: Schema.Types.ObjectId,
      ref: 'Workspace',
      required: true,
      index: true,
    },
    userId: { type: String, required: true, index: true },
    role: {
      type: String,
      enum: WORKSPACE_ROLES,
      required: true,
      default: 'viewer',
    },
    invitedBy: { type: String, default: null },
    joinedAt: { type: Date, required: true, default: () => new Date() },
  },
  { timestamps: true },
);

// A user can only be a member of a given workspace once.
WorkspaceMemberSchema.index({ workspaceId: 1, userId: 1 }, { unique: true });

// "List my workspaces" query.
WorkspaceMemberSchema.index({ userId: 1, joinedAt: -1 });

export const WorkspaceMember: Model<IWorkspaceMember> =
  mongoose.models.WorkspaceMember ||
  mongoose.model<IWorkspaceMember>('WorkspaceMember', WorkspaceMemberSchema);
