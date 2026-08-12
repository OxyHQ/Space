/**
 * Workspaces and their membership.
 *
 * This is the domain every other one sits on: `middleware/workspace.ts`
 * resolves a workspace and a membership on behalf of `routes/pages.ts`,
 * `routes/blocks.ts`, `routes/databases.ts`, `routes/comments.ts` and
 * `routes/share-links.ts`. If that middleware still read Mongo while any of
 * them read Postgres, it would receive a Postgres uuid, look it up in Mongo,
 * find nothing and return 403 on every request — no throw, no log line.
 */

import { and, desc, eq, inArray, isNull } from 'drizzle-orm';
import { isUniqueViolation } from '@oxyhq/db';
import {
  workspaceMembers,
  workspaces,
  type WorkspaceRole,
} from '../db/schema/workspaces.js';
import type { PgHandle } from './handle.js';

export type WorkspaceRow = typeof workspaces.$inferSelect;
export type WorkspaceMemberRow = typeof workspaceMembers.$inferSelect;

export async function findWorkspaceById(
  db: PgHandle,
  id: string,
): Promise<WorkspaceRow | null> {
  const [row] = await db.select().from(workspaces).where(eq(workspaces.id, id)).limit(1);
  return row ?? null;
}

/**
 * The live workspace, or null when it is missing OR archived.
 *
 * The two are one answer on purpose: every caller turns both into the same
 * 404, and splitting them invites a caller to check existence and forget the
 * archive, which reads as a working workspace nobody can see in the sidebar.
 */
export async function findLiveWorkspaceById(
  db: PgHandle,
  id: string,
): Promise<WorkspaceRow | null> {
  const [row] = await db
    .select()
    .from(workspaces)
    .where(and(eq(workspaces.id, id), isNull(workspaces.archivedAt)))
    .limit(1);
  return row ?? null;
}

export async function findMembership(
  db: PgHandle,
  workspaceId: string,
  userId: string,
): Promise<WorkspaceMemberRow | null> {
  const [row] = await db
    .select()
    .from(workspaceMembers)
    .where(
      and(eq(workspaceMembers.workspaceId, workspaceId), eq(workspaceMembers.userId, userId)),
    )
    .limit(1);
  return row ?? null;
}

/** Every membership a user holds, newest first — the "list my workspaces" query. */
export async function listMembershipsForUser(
  db: PgHandle,
  userId: string,
): Promise<WorkspaceMemberRow[]> {
  return db
    .select()
    .from(workspaceMembers)
    .where(eq(workspaceMembers.userId, userId))
    .orderBy(desc(workspaceMembers.joinedAt));
}

/**
 * Live workspaces by id.
 *
 * Guarded rather than relying on `inArray` with an empty list: drizzle renders
 * that as the literal `false`, which is correct but still costs a round trip.
 */
export async function listLiveWorkspacesByIds(
  db: PgHandle,
  ids: readonly string[],
): Promise<WorkspaceRow[]> {
  if (ids.length === 0) return [];
  return db
    .select()
    .from(workspaces)
    .where(and(inArray(workspaces.id, [...ids]), isNull(workspaces.archivedAt)));
}

export async function listMembers(
  db: PgHandle,
  workspaceId: string,
): Promise<WorkspaceMemberRow[]> {
  return db
    .select()
    .from(workspaceMembers)
    .where(eq(workspaceMembers.workspaceId, workspaceId))
    .orderBy(desc(workspaceMembers.joinedAt));
}

/** Memberships for a specific set of users — the mention validator in comments. */
export async function listMembershipsForUsers(
  db: PgHandle,
  workspaceId: string,
  userIds: readonly string[],
): Promise<WorkspaceMemberRow[]> {
  if (userIds.length === 0) return [];
  return db
    .select()
    .from(workspaceMembers)
    .where(
      and(
        eq(workspaceMembers.workspaceId, workspaceId),
        inArray(workspaceMembers.userId, [...userIds]),
      ),
    );
}

export async function findPersonalWorkspace(
  db: PgHandle,
  ownerId: string,
): Promise<WorkspaceRow | null> {
  const [row] = await db
    .select()
    .from(workspaces)
    .where(and(eq(workspaces.ownerId, ownerId), eq(workspaces.isPersonal, true)))
    .limit(1);
  return row ?? null;
}

export async function createWorkspace(
  db: PgHandle,
  values: { name: string; icon?: string | null; ownerId: string; isPersonal?: boolean },
): Promise<WorkspaceRow> {
  const [row] = await db.insert(workspaces).values(values).returning();
  return row;
}

/**
 * Create the caller's personal workspace, tolerating a concurrent creator.
 *
 * `ON CONFLICT ... DO NOTHING RETURNING` rather than catching a duplicate-key
 * error, and the difference is not stylistic. On Postgres one failed statement
 * aborts the whole transaction, and an exception cannot distinguish a duplicate
 * from a dropped connection — so the ported `code === 11000` catch would answer
 * "already done" to an infrastructure failure and hand back someone else's
 * absence as success. Here the EMPTY RESULT is the answer, and a real failure
 * still propagates.
 *
 * `where` is required because the target is a PARTIAL unique index
 * (`unique_personal_workspace_per_owner`, predicated on `is_personal`);
 * without it Postgres cannot match the arbiter and raises 42P10.
 *
 * Returns null when another request won the race — the caller re-reads.
 */
export async function createPersonalWorkspaceIfAbsent(
  db: PgHandle,
  values: { name: string; ownerId: string },
): Promise<WorkspaceRow | null> {
  const [row] = await db
    .insert(workspaces)
    .values({ ...values, icon: null, isPersonal: true })
    .onConflictDoNothing({
      target: workspaces.ownerId,
      // drizzle's `where` on a conflict clause IS the arbiter's index
      // predicate, which is what a PARTIAL unique target needs.
      where: eq(workspaces.isPersonal, true),
    })
    .returning();
  return row ?? null;
}

/**
 * Add a member, tolerating a concurrent identical insert.
 *
 * Same reasoning as above: the empty result means "already a member", not
 * "something went wrong". Returns null when the row already existed.
 */
export async function addMemberIfAbsent(
  db: PgHandle,
  values: {
    workspaceId: string;
    userId: string;
    role: WorkspaceRole;
    invitedBy?: string | null;
  },
): Promise<WorkspaceMemberRow | null> {
  const [row] = await db
    .insert(workspaceMembers)
    .values(values)
    .onConflictDoNothing({
      target: [workspaceMembers.workspaceId, workspaceMembers.userId],
    })
    .returning();
  return row ?? null;
}

/**
 * Add a member, refusing a duplicate loudly.
 *
 * The invite route wants "this person is already a member" to reach the user
 * as a 409, which is a different answer from the idempotent provisioning path
 * above. The SQLSTATE lives on `cause`, never on `error.code` — a ported
 * `err.code === '23505'` matches nothing and the branch collapses silently.
 */
export async function addMember(
  db: PgHandle,
  values: {
    workspaceId: string;
    userId: string;
    role: WorkspaceRole;
    invitedBy?: string | null;
  },
): Promise<{ member: WorkspaceMemberRow } | { duplicate: true }> {
  try {
    const [row] = await db.insert(workspaceMembers).values(values).returning();
    return { member: row };
  } catch (error) {
    if (isUniqueViolation(error, 'workspace_members_workspace_user_key')) {
      return { duplicate: true };
    }
    throw error;
  }
}

/**
 * Patch a workspace from the fields the caller actually supplied.
 *
 * Built from DEFINED keys only. `$set: { x: undefined }` is a no-op in Mongo
 * and writes NULL in Postgres, so a patch that touches one field and leaves a
 * sibling `undefined` would erase the sibling. drizzle's `.set()` drops
 * undefined itself, so this guard is about the EMPTY patch: with no defined
 * keys there is nothing to write, and an empty `.set()` is a syntax error
 * rather than a no-op.
 */
export async function updateWorkspace(
  db: PgHandle,
  id: string,
  patch: { name?: string; icon?: string | null },
): Promise<WorkspaceRow | null> {
  const values: { name?: string; icon?: string | null } = {};
  if (patch.name !== undefined) values.name = patch.name;
  if (patch.icon !== undefined) values.icon = patch.icon;
  if (Object.keys(values).length === 0) return findWorkspaceById(db, id);

  const [row] = await db
    .update(workspaces)
    .set(values)
    .where(eq(workspaces.id, id))
    .returning();
  return row ?? null;
}

/** Soft delete. Returns null when the workspace does not exist. */
export async function archiveWorkspace(
  db: PgHandle,
  id: string,
): Promise<WorkspaceRow | null> {
  const [row] = await db
    .update(workspaces)
    .set({ archivedAt: new Date() })
    .where(eq(workspaces.id, id))
    .returning();
  return row ?? null;
}

export async function updateMemberRole(
  db: PgHandle,
  workspaceId: string,
  userId: string,
  role: WorkspaceRole,
): Promise<WorkspaceMemberRow | null> {
  const [row] = await db
    .update(workspaceMembers)
    .set({ role })
    .where(
      and(eq(workspaceMembers.workspaceId, workspaceId), eq(workspaceMembers.userId, userId)),
    )
    .returning();
  return row ?? null;
}

/**
 * Remove a member.
 *
 * Returns whether a row was removed, read off `RETURNING` rather than
 * `rowCount`. Mongo reported `deletedCount` and callers branch on it; Postgres
 * gives only `rowCount`, and reading `rows.length` on a bare DELETE returns 0
 * whether or not anything was deleted.
 */
export async function removeMember(
  db: PgHandle,
  workspaceId: string,
  userId: string,
): Promise<boolean> {
  const rows = await db
    .delete(workspaceMembers)
    .where(
      and(eq(workspaceMembers.workspaceId, workspaceId), eq(workspaceMembers.userId, userId)),
    )
    .returning({ id: workspaceMembers.id });
  return rows.length > 0;
}
