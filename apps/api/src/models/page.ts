import mongoose, { Schema, Model, Document } from 'mongoose';

/**
 * Page — the document primitive for Oxy Space.
 * Pages form a tree per workspace (parentId points at a parent page, null = root).
 * Soft-delete via `archived`. Hard-delete is gated on workspace ownership.
 */
export interface IPage extends Document {
  workspaceId: mongoose.Types.ObjectId;
  parentId: mongoose.Types.ObjectId | null;
  title: string;
  icon: string | null;
  cover: string | null;
  ownerId: string;
  archived: boolean;
  order: number;
  createdAt: Date;
  updatedAt: Date;
}

const PageSchema = new Schema<IPage>(
  {
    workspaceId: {
      type: Schema.Types.ObjectId,
      ref: 'Workspace',
      required: true,
      index: true,
    },
    parentId: {
      type: Schema.Types.ObjectId,
      ref: 'Page',
      default: null,
    },
    title: {
      type: String,
      default: '',
    },
    icon: {
      type: String,
      default: null,
    },
    cover: {
      type: String,
      default: null,
    },
    ownerId: {
      type: String,
      required: true,
    },
    archived: {
      type: Boolean,
      default: false,
    },
    order: {
      type: Number,
      required: true,
      default: 0,
    },
  },
  {
    timestamps: true,
  },
);

// Tree queries: list children of a given parent in order.
PageSchema.index({ workspaceId: 1, parentId: 1, order: 1 });
// Archive filter scans.
PageSchema.index({ workspaceId: 1, archived: 1 });

export const Page: Model<IPage> =
  mongoose.models.Page || mongoose.model<IPage>('Page', PageSchema);

export default Page;
