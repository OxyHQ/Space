import mongoose, { Schema, Model, Document } from 'mongoose';

/**
 * Mention segment — inline reference inside comment / block content.
 * Three kinds:
 *   - user: links to a workspace member (id = Oxy userId). Triggers an
 *     in-app notification on comment create.
 *   - page: links to a page in the same workspace (id = Page _id). Renders
 *     as a clickable chip that navigates to the page.
 *   - date: references a calendar date (date = ISO yyyy-mm-dd string).
 *     Renders as a chip with calendar icon; no notification.
 *
 * `originalText` is the literal text that was replaced when the chip was
 * inserted (e.g. "@nate") — used for plain-text rendering / search.
 */
export type MentionKind = 'user' | 'page' | 'date';

export interface MentionSegment {
  type: 'mention';
  kind: MentionKind;
  /** Set when kind === 'user' or 'page'. */
  id?: string;
  /** Set when kind === 'date' (ISO yyyy-mm-dd). */
  date?: string;
  originalText: string;
}

export interface TextSegment {
  type?: 'text';
  text: string;
  bold?: boolean;
  italic?: boolean;
  underline?: boolean;
  strike?: boolean;
  code?: boolean;
  link?: string;
}

/**
 * Comment rich-text content. Same shape used by Editor v2 block segments,
 * extended with `mention` segments. Older clients that only read plain text
 * can use the `plainText` mirror (kept in sync at the route boundary).
 */
export type CommentSegment = TextSegment | MentionSegment;

export interface CommentContent {
  segments: CommentSegment[];
  /** Plain-text projection of segments. Source of truth = `segments`. */
  plainText: string;
}

/**
 * Comment — a single message on a page or block.
 *
 * Threading is flat (parentCommentId on top-level comment = null; replies set
 * parentCommentId to the top-level comment id). Notion-style — one level of
 * replies, no infinite nesting.
 */
export interface IComment extends Document {
  workspaceId: mongoose.Types.ObjectId;
  pageId: mongoose.Types.ObjectId;
  /** null = page-level comment (not anchored to a specific block). */
  blockId: mongoose.Types.ObjectId | null;
  /** null = top-level thread; set = reply to another comment. */
  parentCommentId: mongoose.Types.ObjectId | null;
  authorId: string;
  content: CommentContent;
  /** Set when comment thread is resolved. null = open. */
  resolvedAt: Date | null;
  /** Set on edit. null = never edited. */
  editedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

const mentionSegmentSchema = new Schema<MentionSegment>(
  {
    type: { type: String, enum: ['mention'], required: true },
    kind: { type: String, enum: ['user', 'page', 'date'], required: true },
    id: { type: String, default: undefined },
    date: { type: String, default: undefined },
    originalText: { type: String, required: true },
  },
  { _id: false },
);

const textSegmentSchema = new Schema<TextSegment>(
  {
    type: { type: String, enum: ['text'], default: 'text' },
    text: { type: String, required: true },
    bold: { type: Boolean },
    italic: { type: Boolean },
    underline: { type: Boolean },
    strike: { type: Boolean },
    code: { type: Boolean },
    link: { type: String },
  },
  { _id: false },
);

// Mongoose can't easily discriminate union schemas — store segments as Mixed
// and validate shape at the route boundary via Zod. We rely on the typed
// interface (`CommentContent`) for downstream consumers.
const contentSchema = new Schema(
  {
    segments: {
      type: Schema.Types.Mixed,
      required: true,
      default: () => [],
    },
    plainText: { type: String, required: true, default: '' },
  },
  { _id: false },
);

const CommentSchema = new Schema<IComment>(
  {
    workspaceId: {
      type: Schema.Types.ObjectId,
      ref: 'Workspace',
      required: true,
      index: true,
    },
    pageId: {
      type: Schema.Types.ObjectId,
      ref: 'Page',
      required: true,
      index: true,
    },
    blockId: {
      type: Schema.Types.ObjectId,
      ref: 'Block',
      default: null,
    },
    parentCommentId: {
      type: Schema.Types.ObjectId,
      ref: 'Comment',
      default: null,
    },
    authorId: { type: String, required: true, index: true },
    content: { type: contentSchema, required: true, default: () => ({ segments: [], plainText: '' }) },
    resolvedAt: { type: Date, default: null },
    editedAt: { type: Date, default: null },
  },
  { timestamps: true },
);

// "List comments for a page (resolved/unresolved split)" query.
CommentSchema.index({ pageId: 1, resolvedAt: 1, createdAt: 1 });
// "List comments on a block" query (block-level indicator badge).
CommentSchema.index({ blockId: 1, resolvedAt: 1, createdAt: 1 });
// "List replies in a thread" query.
CommentSchema.index({ parentCommentId: 1, createdAt: 1 });

// Re-export the schemas so other modules (e.g. tests) can reuse them if needed.
export {
  mentionSegmentSchema,
  textSegmentSchema,
  contentSchema as commentContentSchema,
};

export const Comment: Model<IComment> =
  mongoose.models.Comment || mongoose.model<IComment>('Comment', CommentSchema);

export default Comment;
