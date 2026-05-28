/**
 * Shared types for Comments + @mentions (Phase 2).
 *
 * Mirrors the contract owned by the API agent (`apps/api/src/routes/comments.ts`).
 * Mention segments are the source of truth for inline references inside
 * editor blocks and comment bodies — Editor v2 and the comment composer both
 * render the same `MentionSegment` shape.
 */

export type MentionKind = "user" | "page" | "date";

export interface MentionSegment {
  type: "mention";
  kind: MentionKind;
  /** Set when kind === 'user' or 'page'. */
  id?: string;
  /** ISO yyyy-mm-dd. Set when kind === 'date'. */
  date?: string;
  /** Literal text that was replaced when the chip was inserted (e.g. "@nate"). */
  originalText: string;
}

export interface TextSegment {
  type?: "text";
  text: string;
  bold?: boolean;
  italic?: boolean;
  underline?: boolean;
  strike?: boolean;
  code?: boolean;
  link?: string;
}

export type CommentSegment = TextSegment | MentionSegment;

export interface CommentContent {
  segments: CommentSegment[];
  plainText: string;
}

export interface Comment {
  id: string;
  workspaceId: string;
  pageId: string;
  blockId: string | null;
  parentCommentId: string | null;
  authorId: string;
  content: CommentContent;
  resolvedAt: string | null;
  editedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface CommentsListResponse {
  comments: Comment[];
}

export interface CommentResponse {
  comment: Comment;
}

/**
 * Type guard — narrows a CommentSegment to MentionSegment.
 */
export function isMentionSegment(seg: CommentSegment): seg is MentionSegment {
  return "type" in seg && seg.type === "mention";
}
