/**
 * Comment reads and writes, covering every query `routes/comments.ts` performs.
 *
 * Rows never leave this module raw: `content` is stored as two columns and
 * rebuilt here into the `{ segments, plainText }` shape the route serializes and
 * the notification fan-out reads. A caller that selected the row itself would
 * get `undefined` from `row.content.plainText` and send an empty mention
 * preview, with nothing erroring.
 */

import { and, asc, eq, inArray, isNull, or } from 'drizzle-orm';
import type { StationDatabase } from '../db/client.js';
import { comments } from '../db/schema/collab.js';

/** Inline reference inside comment content. */
export type MentionKind = 'user' | 'page' | 'date';

export interface MentionSegment {
  type: 'mention';
  kind: MentionKind;
  /** Set when kind is 'user' or 'page'. */
  id?: string;
  /** Set when kind is 'date' (ISO yyyy-mm-dd). */
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

export type CommentSegment = TextSegment | MentionSegment;

export interface CommentContent {
  segments: CommentSegment[];
  /** Plain-text projection of `segments`, which is the source of truth. */
  plainText: string;
}

export interface CommentRow {
  id: string;
  workspaceId: string;
  pageId: string;
  blockId: string | null;
  parentCommentId: string | null;
  authorId: string;
  content: CommentContent;
  resolvedAt: Date | null;
  editedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface CreateCommentInput {
  workspaceId: string;
  pageId: string;
  blockId?: string | null;
  parentCommentId?: string | null;
  authorId: string;
  content: CommentContent;
}

/** The stored columns, reassembled into the shape every caller expects. */
function toCommentRow(row: typeof comments.$inferSelect): CommentRow {
  return {
    id: row.id,
    workspaceId: row.workspaceId,
    pageId: row.pageId,
    blockId: row.blockId,
    parentCommentId: row.parentCommentId,
    authorId: row.authorId,
    content: {
      segments: row.contentSegments as CommentSegment[],
      plainText: row.contentPlainText,
    },
    resolvedAt: row.resolvedAt,
    editedAt: row.editedAt,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

/**
 * Every comment on a page, oldest first.
 *
 * `id` is the tiebreak Mongo did not have. `sort({ createdAt: 1 })` alone is not
 * a total order, and two comments written in the same millisecond came back in
 * an arbitrary order that could differ between calls. The tiebreak does not
 * order by creation time — uuidv7 is not monotonic within a millisecond — it
 * only makes the result STABLE, which is what the thread grouping needs.
 */
export async function listCommentsByPage(
  db: StationDatabase,
  pageId: string,
): Promise<CommentRow[]> {
  const rows = await db
    .select()
    .from(comments)
    .where(eq(comments.pageId, pageId))
    .orderBy(asc(comments.createdAt), asc(comments.id));
  return rows.map(toCommentRow);
}

/** Every comment anchored to one block, oldest first. */
export async function listCommentsByBlock(
  db: StationDatabase,
  blockId: string,
): Promise<CommentRow[]> {
  const rows = await db
    .select()
    .from(comments)
    .where(eq(comments.blockId, blockId))
    .orderBy(asc(comments.createdAt), asc(comments.id));
  return rows.map(toCommentRow);
}

export async function findCommentById(
  db: StationDatabase,
  id: string,
): Promise<CommentRow | null> {
  const rows = await db.select().from(comments).where(eq(comments.id, id)).limit(1);
  const row = rows[0];
  return row ? toCommentRow(row) : null;
}

export async function createComment(
  db: StationDatabase,
  input: CreateCommentInput,
): Promise<CommentRow> {
  const rows = await db
    .insert(comments)
    .values({
      workspaceId: input.workspaceId,
      pageId: input.pageId,
      blockId: input.blockId ?? null,
      parentCommentId: input.parentCommentId ?? null,
      authorId: input.authorId,
      contentSegments: input.content.segments,
      contentPlainText: input.content.plainText,
    })
    .returning();
  const row = rows[0];
  if (!row) {
    throw new Error('createComment inserted no row');
  }
  return toCommentRow(row);
}

/**
 * Replace a comment's content and stamp `editedAt`.
 *
 * Returns null when the id matches nothing, so the caller can 404 without a
 * second read.
 */
export async function updateCommentContent(
  db: StationDatabase,
  id: string,
  content: CommentContent,
  editedAt: Date,
): Promise<CommentRow | null> {
  const rows = await db
    .update(comments)
    .set({
      contentSegments: content.segments,
      contentPlainText: content.plainText,
      editedAt,
    })
    .where(eq(comments.id, id))
    .returning();
  const row = rows[0];
  return row ? toCommentRow(row) : null;
}

/**
 * Resolve (`resolvedAt` set) or reopen (`resolvedAt` null) a thread.
 *
 * The route only writes this when the value actually changes, and only for
 * top-level comments; neither rule moves here. The one-level nesting rule in
 * particular cannot be a constraint — it is a claim about the PARENT row — so it
 * stays at the route, where `findCommentById` gives it the parent it needs.
 */
export async function setCommentResolvedAt(
  db: StationDatabase,
  id: string,
  resolvedAt: Date | null,
): Promise<CommentRow | null> {
  const rows = await db
    .update(comments)
    .set({ resolvedAt })
    .where(eq(comments.id, id))
    .returning();
  const row = rows[0];
  return row ? toCommentRow(row) : null;
}

/**
 * Delete a top-level comment and its replies, and report how many rows went.
 *
 * The `ON DELETE CASCADE` on `comments.parentCommentId` removes the replies, so
 * this is one statement where Mongo needed `deleteMany({ $or: [...] })`. The
 * predicate is still written out in full rather than relying on the cascade
 * alone: the count then covers the whole thread, and deleting a REPLY (which
 * has no children) goes through the same call with the same meaning.
 */
export async function deleteCommentThread(
  db: StationDatabase,
  id: string,
): Promise<number> {
  const rows = await db
    .delete(comments)
    .where(or(eq(comments.id, id), eq(comments.parentCommentId, id)))
    .returning({ id: comments.id });
  return rows.length;
}

/** Delete exactly one comment by id. */
export async function deleteComment(db: StationDatabase, id: string): Promise<number> {
  const rows = await db.delete(comments).where(eq(comments.id, id)).returning({
    id: comments.id,
  });
  return rows.length;
}

/**
 * Top-level (unresolved-thread) roots for a page.
 *
 * The route currently fetches every comment and partitions in memory
 * (`routes/comments.ts:383-402`) because it must keep replies whose root is
 * open. This is the same question asked of the database, for the callers that
 * only need the roots — it is not wired in by this change.
 */
export async function listOpenThreadRoots(
  db: StationDatabase,
  pageId: string,
): Promise<CommentRow[]> {
  const rows = await db
    .select()
    .from(comments)
    .where(
      and(
        eq(comments.pageId, pageId),
        isNull(comments.parentCommentId),
        isNull(comments.resolvedAt),
      ),
    )
    .orderBy(asc(comments.createdAt), asc(comments.id));
  return rows.map(toCommentRow);
}

/**
 * Comments by id, for callers holding a set of ids.
 *
 * `inArray` rather than a bare array: interpolating an array into a `sql`
 * template renders a ROW CONSTRUCTOR, not a membership list. An empty input
 * renders as the literal `false`, so the early return is a saved round trip
 * rather than a guard against a wrong answer.
 */
export async function findCommentsByIds(
  db: StationDatabase,
  ids: readonly string[],
): Promise<CommentRow[]> {
  if (ids.length === 0) return [];
  const rows = await db
    .select()
    .from(comments)
    .where(inArray(comments.id, [...ids]))
    .orderBy(asc(comments.createdAt), asc(comments.id));
  return rows.map(toCommentRow);
}
