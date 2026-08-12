import { sql } from 'drizzle-orm';
import { boolean, check, index, pgTable, text, uniqueIndex } from 'drizzle-orm/pg-core';
import { createdAt, generatedId, inList, timestamptz, updatedAt } from '@oxyhq/db';

/**
 * Reference shape for every schema file in this folder. Conventions, and why:
 *
 * - `generatedId()` — uuidv7. NOT monotonic within a millisecond (~50%
 *   inversions), unlike the ObjectId it replaces, so nothing may infer
 *   creation order from an id. Tests that need an order write explicit
 *   timestamps.
 * - Enums are `text` plus a CHECK built from the exported constant, never
 *   `pgEnum`: adding a value is then an ordinary migration instead of an
 *   `ALTER TYPE`, and removing one is possible at all.
 * - `inList` renders the CHECK's literal side. A value interpolated into a
 *   `check()` becomes the literal `$1` in the generated migration and fails at
 *   APPLY time, so the constant side never goes through a bound parameter.
 * - Column names are derived by `DATABASE_CASING`; they are never spelled by
 *   hand. Anywhere SQL needs the identifier rather than the property, use
 *   `sqlColumnName` — interpolating the column object emits the JS property
 *   name, so `workspaceId` would become `workspaceid` and fail with 42703.
 */

export const WORKSPACE_ROLES = ['viewer', 'commenter', 'editor', 'admin', 'owner'] as const;
export type WorkspaceRole = (typeof WORKSPACE_ROLES)[number];

export const WORKSPACE_NAME_MAX = 200;

export const workspaces = pgTable(
  'workspaces',
  {
    id: generatedId(),
    name: text().notNull(),
    icon: text(),
    /**
     * Oxy user id. Text, not a uuid and not a foreign key: Oxy user ids are
     * opaque identifiers issued by the Oxy auth service and there is no users
     * table in this database to point at.
     */
    ownerId: text().notNull(),
    isPersonal: boolean().notNull().default(false),
    /**
     * Soft delete. `DELETE /api/workspaces/:id` stamps this rather than
     * removing the row, so pages that reference the workspace still resolve.
     */
    archivedAt: timestamptz(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    // Owner lookup: list workspaces a user owns, personal separated from team.
    index('workspaces_owner_personal_idx').on(t.ownerId, t.isPersonal),
    /**
     * At most one personal workspace per owner.
     *
     * This predicate is REAL and must be ported — it is not the `sparse: true`
     * case. A Mongo sparse unique does not exclude a stored null and needs a
     * partial predicate to behave; a Postgres unique is NULLS DISTINCT by
     * default and needs none. Here the predicate carries meaning: a user may
     * own many non-personal workspaces, so the uniqueness applies only to the
     * personal one.
     */
    uniqueIndex('unique_personal_workspace_per_owner')
      .on(t.ownerId)
      .where(sql`${t.isPersonal}`),
    /**
     * The Mongoose `maxlength: 200` on this field genuinely ran — workspaces
     * are written through `new Workspace(...).save()` and `ws.name = ...;
     * save()`, never through `updateOne`/`findOneAndUpdate`, which skip
     * validators. So it becomes a live constraint rather than being dropped as
     * a validator that never fired.
     */
    check('workspaces_name_length', sql`char_length(${t.name}) <= ${sql.raw(String(WORKSPACE_NAME_MAX))}`),
  ],
);

export const workspaceMembers = pgTable(
  'workspace_members',
  {
    id: generatedId(),
    /**
     * The port is where this stops being a convention and becomes structural:
     * a member row pointing at a workspace that does not exist was always
     * garbage, and Mongo simply could not say so. Cascade covers the hard
     * delete; the ordinary path soft-deletes the workspace and leaves members
     * in place.
     */
    workspaceId: text()
      .notNull()
      .references(() => workspaces.id, { onDelete: 'cascade' }),
    /** Oxy user id — see the note on `workspaces.ownerId`. */
    userId: text().notNull(),
    role: text().notNull().default('viewer'),
    /** User id of the inviter, or null for the auto-created owner row. */
    invitedBy: text(),
    joinedAt: timestamptz().notNull().defaultNow(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    // A user is a member of a given workspace at most once.
    uniqueIndex('workspace_members_workspace_user_key').on(t.workspaceId, t.userId),
    // "List my workspaces".
    index('workspace_members_user_joined_idx').on(t.userId, t.joinedAt.desc()),
    // `inList` renders the members WITHOUT surrounding parentheses
    // (`'viewer', 'editor'`), so the parentheses belong to the caller. Verified
    // against the real function rather than assumed — the version without them
    // generates `role in 'viewer', ...`, which fails at apply time.
    check('workspace_members_role', sql`${t.role} in (${sql.raw(inList(WORKSPACE_ROLES))})`),
  ],
);
