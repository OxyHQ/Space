/**
 * Share-link reads and writes, covering every query `routes/share-links.ts`
 * performs.
 */

import { and, desc, eq, gt, isNull, or, sql } from 'drizzle-orm';
import type { StationDatabase } from '../db/client.js';
import { type ShareLinkScope, shareLinks } from '../db/schema/collab.js';

export interface ShareLinkRow {
  id: string;
  pageId: string;
  token: string;
  scope: ShareLinkScope;
  createdBy: string;
  expiresAt: Date | null;
  revokedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface CreateShareLinkInput {
  pageId: string;
  token: string;
  scope: ShareLinkScope;
  createdBy: string;
  expiresAt: Date | null;
}

function toShareLinkRow(row: typeof shareLinks.$inferSelect): ShareLinkRow {
  return { ...row, scope: row.scope as ShareLinkScope };
}

/**
 * Insert a share link, or report a token collision by returning null.
 *
 * The route retries with a freshly generated token up to five times
 * (`routes/share-links.ts:144-155`). Mongo signalled the collision by THROWING
 * `code: 11000`, and the naive port — catching the Postgres exception — cannot
 * tell a duplicate key from a dropped connection, so a network blip would be
 * read as "that token is taken, try another" and the real failure would vanish.
 *
 * `on conflict do nothing returning` makes the empty result the answer instead:
 * a collision returns null and the caller retries, while an infrastructure
 * failure still propagates as an exception.
 */
export async function createShareLink(
  db: StationDatabase,
  input: CreateShareLinkInput,
): Promise<ShareLinkRow | null> {
  const rows = await db
    .insert(shareLinks)
    .values({
      pageId: input.pageId,
      token: input.token,
      scope: input.scope,
      createdBy: input.createdBy,
      expiresAt: input.expiresAt,
    })
    .onConflictDoNothing({ target: shareLinks.token })
    .returning();
  const row = rows[0];
  return row ? toShareLinkRow(row) : null;
}

/**
 * Active links for a page — not revoked, and either never expiring or expiring
 * in the future — newest first.
 *
 * `now` is a parameter rather than `now()` so a caller and its test agree on the
 * instant, and so this reads the same way as the route's own boundary check.
 */
export async function listActiveShareLinksByPage(
  db: StationDatabase,
  pageId: string,
  now: Date,
): Promise<ShareLinkRow[]> {
  const rows = await db
    .select()
    .from(shareLinks)
    .where(
      and(
        eq(shareLinks.pageId, pageId),
        isNull(shareLinks.revokedAt),
        or(isNull(shareLinks.expiresAt), gt(shareLinks.expiresAt, now)),
      ),
    )
    .orderBy(desc(shareLinks.createdAt), desc(shareLinks.id));
  return rows.map(toShareLinkRow);
}

export async function findShareLinkById(
  db: StationDatabase,
  id: string,
): Promise<ShareLinkRow | null> {
  const rows = await db.select().from(shareLinks).where(eq(shareLinks.id, id)).limit(1);
  const row = rows[0];
  return row ? toShareLinkRow(row) : null;
}

/**
 * The unauthenticated `GET /api/share/:token` lookup.
 *
 * A plain equality on the stored token. Revocation and expiry are deliberately
 * NOT folded into this predicate: the route distinguishes "revoked" from
 * "expired" from "unknown" in its response handling, and a single filtered query
 * would collapse all three into one silent miss.
 */
export async function findShareLinkByToken(
  db: StationDatabase,
  token: string,
): Promise<ShareLinkRow | null> {
  const rows = await db.select().from(shareLinks).where(eq(shareLinks.token, token)).limit(1);
  const row = rows[0];
  return row ? toShareLinkRow(row) : null;
}

/**
 * Stamp `revokedAt`, but only on a link that is not already revoked.
 *
 * The `is null` guard is in the WHERE, not in JavaScript: two concurrent revokes
 * then agree on one instant instead of the second overwriting the first's
 * timestamp. Returns null when the link is missing OR already revoked — the
 * route reads its own `revokedAt` first and short-circuits, so it never needs to
 * tell those apart.
 */
export async function revokeShareLink(
  db: StationDatabase,
  id: string,
  revokedAt: Date,
): Promise<ShareLinkRow | null> {
  const rows = await db
    .update(shareLinks)
    .set({ revokedAt })
    .where(and(eq(shareLinks.id, id), isNull(shareLinks.revokedAt)))
    .returning();
  const row = rows[0];
  return row ? toShareLinkRow(row) : null;
}

/**
 * How many links exist for a page, active or not — for callers that need a
 * count without loading tokens.
 *
 * `::int` is not decoration: postgres.js decodes `bigint` as a STRING while
 * drizzle types it `number`, so an uncast `count(*)` returns `"3"` and any
 * arithmetic on it becomes string concatenation.
 */
export async function countShareLinksByPage(
  db: StationDatabase,
  pageId: string,
): Promise<number> {
  const rows = await db
    .select({ total: sql<number>`count(*)::int` })
    .from(shareLinks)
    .where(eq(shareLinks.pageId, pageId));
  return rows[0]?.total ?? 0;
}
