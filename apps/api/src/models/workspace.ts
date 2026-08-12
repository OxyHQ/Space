import mongoose, { Schema, Model, Document, HydratedDocument } from 'mongoose';

/**
 * Workspace — top-level container for Oxy Station pages, blocks, databases.
 *
 * Every user gets exactly one personal workspace on first authenticated
 * access (created by `ensurePersonalWorkspace` middleware). Additional
 * shared workspaces can be created via the API and have multiple members
 * via the `WorkspaceMember` collection.
 */
export interface IWorkspace extends Document {
  name: string;
  icon: string | null;
  /**
   * Oxy user id of the owner. Stored as a string because Oxy user ids are
   * opaque identifiers issued by the Oxy auth service, not Mongo ObjectIds
   * in this database.
   */
  ownerId: string;
  /**
   * True for the single auto-created personal workspace per user. Enforced
   * via the `{ ownerId, isPersonal }` partial unique index below.
   */
  isPersonal: boolean;
  /**
   * Soft-delete timestamp. `DELETE /api/workspaces/:id` sets this rather
   * than removing the document so we can still resolve historical
   * references (e.g. pages that point to this workspace).
   */
  archivedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

export type WorkspaceDoc = HydratedDocument<IWorkspace>;

const WorkspaceSchema = new Schema<IWorkspace>(
  {
    name: { type: String, required: true, trim: true, maxlength: 200 },
    icon: { type: String, default: null },
    ownerId: { type: String, required: true },
    isPersonal: { type: Boolean, required: true, default: false },
    archivedAt: { type: Date, default: null },
  },
  { timestamps: true },
);

// Owner lookup: list workspaces a user owns, separate personal from team.
WorkspaceSchema.index({ ownerId: 1, isPersonal: 1 });

// At most one personal workspace per owner. Partial filter so non-personal
// workspaces (where the user can own many) are unconstrained.
WorkspaceSchema.index(
  { ownerId: 1 },
  {
    unique: true,
    partialFilterExpression: { isPersonal: true },
    name: 'unique_personal_workspace_per_owner',
  },
);

export const Workspace: Model<IWorkspace> =
  mongoose.models.Workspace || mongoose.model<IWorkspace>('Workspace', WorkspaceSchema);
