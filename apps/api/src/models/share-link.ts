import mongoose, { Schema, Model, Document, HydratedDocument } from 'mongoose';

/**
 * Scope of access granted by a share link.
 *   - read    : view page + blocks
 *   - comment : read + add comments (Phase 3+ feature)
 *   - edit    : read + comment + edit (Phase 3+ feature)
 */
export type ShareLinkScope = 'read' | 'comment' | 'edit';

export const SHARE_LINK_SCOPES: ShareLinkScope[] = ['read', 'comment', 'edit'];

export interface IShareLink extends Document {
  /**
   * Reference to the page the link grants access to. Stored as ObjectId
   * because the Page model (Phase 1 backend) keys on its own _id.
   */
  pageId: mongoose.Types.ObjectId;
  /** Url-safe random 32-char token; unique across the collection. */
  token: string;
  scope: ShareLinkScope;
  /** Oxy user id of the creator. */
  createdBy: string;
  /** Optional expiration; null means link does not expire. */
  expiresAt: Date | null;
  /** Set when the link is revoked. Null = still active. */
  revokedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

export type ShareLinkDoc = HydratedDocument<IShareLink>;

const ShareLinkSchema = new Schema<IShareLink>(
  {
    pageId: {
      type: Schema.Types.ObjectId,
      ref: 'Page',
      required: true,
      index: true,
    },
    token: { type: String, required: true },
    scope: {
      type: String,
      enum: SHARE_LINK_SCOPES,
      required: true,
      default: 'read',
    },
    createdBy: { type: String, required: true },
    expiresAt: { type: Date, default: null },
    revokedAt: { type: Date, default: null },
  },
  { timestamps: true },
);

// Public lookup by token (the only path used by the unauthenticated /share/:token
// endpoint). Must be unique so we can rely on findOne returning at most one.
ShareLinkSchema.index({ token: 1 }, { unique: true });

// "List active share links for a page" query.
ShareLinkSchema.index({ pageId: 1, revokedAt: 1, createdAt: -1 });

export const ShareLink: Model<IShareLink> =
  mongoose.models.ShareLink || mongoose.model<IShareLink>('ShareLink', ShareLinkSchema);
