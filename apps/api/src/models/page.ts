import mongoose, { Schema, Model, Document } from 'mongoose';

/**
 * Page — the document primitive for Oxy Space.
 * Pages form a tree per workspace (parentId points at a parent page, null = root).
 * Soft-delete via `archived`. Hard-delete is gated on workspace ownership.
 *
 * Phase 4 (Databases): a Page may also be a database "row" — `databaseId` is
 * non-null and `properties` carries typed property values keyed by
 * propertyId. Database rows still own their block content (the "page body"
 * shown when a row is opened), so they reuse the same block editor.
 */

/**
 * Per-property value. Shape depends on the property's type — validated at
 * the route boundary, not by Mongoose. See
 * `apps/api/src/lib/databases/property-values.ts` for the parser.
 */
export type PagePropertyValue = unknown;

export interface IPage extends Document {
  workspaceId: mongoose.Types.ObjectId;
  parentId: mongoose.Types.ObjectId | null;
  title: string;
  icon: string | null;
  cover: string | null;
  /**
   * Vertical offset (0–100, percent) for cropped cover rendering.
   * Defaults to 50 (centered). Stored separately from `cover` so cover
   * sources (gradient/color/url) stay portable.
   */
  coverPosition: number;
  ownerId: string;
  archived: boolean;
  /**
   * Marks the page as starred in the user's sidebar Favorites section.
   */
  favorited: boolean;
  order: number;
  // Phase 4 — Databases.
  databaseId: mongoose.Types.ObjectId | null;
  properties: Map<string, PagePropertyValue>;
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
    coverPosition: {
      type: Number,
      default: 50,
      min: 0,
      max: 100,
    },
    ownerId: {
      type: String,
      required: true,
    },
    archived: {
      type: Boolean,
      default: false,
    },
    favorited: {
      type: Boolean,
      default: false,
      index: true,
    },
    order: {
      type: Number,
      required: true,
      default: 0,
    },
    databaseId: {
      type: Schema.Types.ObjectId,
      ref: 'Database',
      default: null,
      index: true,
    },
    properties: {
      type: Map,
      of: Schema.Types.Mixed,
      default: () => new Map(),
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
// Database row scans by createdAt (default sort), and group/filter operations.
PageSchema.index({ databaseId: 1, archived: 1, createdAt: 1 });

export const Page: Model<IPage> =
  mongoose.models.Page || mongoose.model<IPage>('Page', PageSchema);

export default Page;
