import { eq, like } from 'drizzle-orm';
import { constraintNameOf, isCheckViolation } from '@oxyhq/db';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { workspaceMembers, workspaces } from '../../db/schema/workspaces.js';
import {
  closeTestDb,
  getTestDb,
  type TestDatabase,
  testScope,
} from '../../db/__tests__/testDatabase.js';
import {
  addMember,
  addMemberIfAbsent,
  archiveWorkspace,
  createPersonalWorkspaceIfAbsent,
  createWorkspace,
  findLiveWorkspaceById,
  findMembership,
  findPersonalWorkspace,
  listLiveWorkspacesByIds,
  listMembershipsForUsers,
  removeMember,
  updateMemberRole,
  updateWorkspace,
} from '../workspaces.js';

let db: TestDatabase;

/** Every owner id this file writes carries this prefix. */
const scope = testScope('ws-repo');
const owner = `${scope}-owner`;

beforeAll(async () => {
  db = await getTestDb();
});

afterAll(async () => {
  // Scoped to the rows this file owns. Members go with the workspace cascade.
  await db.delete(workspaces).where(like(workspaces.ownerId, `${scope}%`));
  await closeTestDb();
});

describe('workspaces repository', () => {
  it('round-trips a workspace and folds archived into "not found"', async () => {
    const ws = await createWorkspace(db, { name: 'Team', ownerId: owner });
    expect(await findLiveWorkspaceById(db, ws.id)).toMatchObject({ name: 'Team' });

    await archiveWorkspace(db, ws.id);

    // The two callers both turn "missing" and "archived" into the same 404, so
    // the repository gives them one answer rather than inviting a caller to
    // check existence and forget the archive.
    expect(await findLiveWorkspaceById(db, ws.id)).toBeNull();
  });

  it('excludes archived workspaces from a bulk read', async () => {
    const live = await createWorkspace(db, { name: 'Live', ownerId: `${scope}-bulk` });
    const dead = await createWorkspace(db, { name: 'Dead', ownerId: `${scope}-bulk` });
    await archiveWorkspace(db, dead.id);

    const rows = await listLiveWorkspacesByIds(db, [live.id, dead.id]);
    expect(rows.map((r) => r.id)).toEqual([live.id]);
  });

  it('returns nothing for an empty id list without asking the database', async () => {
    // `inArray` with an empty list renders as the literal `false` — correct,
    // but a wasted round trip. The guard is the saving, not a behaviour change.
    expect(await listLiveWorkspacesByIds(db, [])).toEqual([]);
  });
});

describe('the personal-workspace race', () => {
  it('creates exactly one and returns null to the loser', async () => {
    const racer = `${scope}-race`;
    const first = await createPersonalWorkspaceIfAbsent(db, { name: 'A', ownerId: racer });
    const second = await createPersonalWorkspaceIfAbsent(db, { name: 'B', ownerId: racer });

    expect(first).not.toBeNull();
    // Null, not a throw. A ported `code === 11000` catch cannot tell a
    // duplicate from a dropped connection, so it would report "already
    // provisioned" for an infrastructure failure; the empty result is the
    // answer instead and a real failure still propagates.
    expect(second).toBeNull();

    const found = await findPersonalWorkspace(db, racer);
    expect(found?.name).toBe('A');
  });

  it('still lets one owner hold many NON-personal workspaces', async () => {
    // The negative control for the partial predicate. Without it the unique
    // would be over `ownerId` alone and this would fail — which is exactly how
    // an over-broad index passes a test that only checks the personal case.
    const many = `${scope}-many`;
    await createWorkspace(db, { name: 'One', ownerId: many });
    await createWorkspace(db, { name: 'Two', ownerId: many });

    const rows = await db.select().from(workspaces).where(eq(workspaces.ownerId, many));
    expect(rows).toHaveLength(2);
  });
});

describe('membership', () => {
  it('reports a duplicate loudly for the invite path', async () => {
    const ws = await createWorkspace(db, { name: 'Invites', ownerId: `${scope}-inv` });
    const first = await addMember(db, { workspaceId: ws.id, userId: 'u1', role: 'editor' });
    expect('member' in first).toBe(true);

    const second = await addMember(db, { workspaceId: ws.id, userId: 'u1', role: 'viewer' });
    // A 409 for the user, reached through the SQLSTATE on `cause`. A ported
    // `err.code === '23505'` matches nothing and this branch never runs.
    expect(second).toEqual({ duplicate: true });
  });

  it('stays quiet about a duplicate on the idempotent provisioning path', async () => {
    const ws = await createWorkspace(db, { name: 'Provision', ownerId: `${scope}-prov` });
    expect(await addMemberIfAbsent(db, { workspaceId: ws.id, userId: 'u2', role: 'owner' })).not
      .toBeNull();
    expect(await addMemberIfAbsent(db, { workspaceId: ws.id, userId: 'u2', role: 'owner' })).toBeNull();
  });

  it('reads a removal off RETURNING, not a row count', async () => {
    const ws = await createWorkspace(db, { name: 'Removals', ownerId: `${scope}-rm` });
    await addMember(db, { workspaceId: ws.id, userId: 'u3', role: 'viewer' });

    expect(await removeMember(db, ws.id, 'u3')).toBe(true);
    // The second call must report false. `rows.length` on a bare DELETE is 0
    // either way, so a naive port answers false for both — or true for both.
    expect(await removeMember(db, ws.id, 'u3')).toBe(false);
  });

  it('scopes a membership lookup to one workspace', async () => {
    const a = await createWorkspace(db, { name: 'A', ownerId: `${scope}-scope` });
    const b = await createWorkspace(db, { name: 'B', ownerId: `${scope}-scope` });
    await addMember(db, { workspaceId: a.id, userId: 'u4', role: 'admin' });

    expect(await findMembership(db, a.id, 'u4')).toMatchObject({ role: 'admin' });
    expect(await findMembership(db, b.id, 'u4')).toBeNull();
  });

  it('reads only the users asked for', async () => {
    const ws = await createWorkspace(db, { name: 'Mentions', ownerId: `${scope}-mention` });
    await addMember(db, { workspaceId: ws.id, userId: 'm1', role: 'editor' });
    await addMember(db, { workspaceId: ws.id, userId: 'm2', role: 'viewer' });

    const found = await listMembershipsForUsers(db, ws.id, ['m1', 'nobody']);
    expect(found.map((m) => m.userId)).toEqual(['m1']);
    expect(await listMembershipsForUsers(db, ws.id, [])).toEqual([]);
  });

  it('refuses a role the CHECK does not allow', async () => {
    const ws = await createWorkspace(db, { name: 'Roles', ownerId: `${scope}-role` });

    // Asserted through `constraintNameOf`, not by matching the error MESSAGE.
    // A drizzle error's message is only "Failed query: insert into ..." — the
    // SQLSTATE and the constraint name live on `cause`, which is the same
    // reason a ported `err.code === '23505'` matches nothing. Matching the
    // message here would have passed for any failure at all, including a
    // dropped connection.
    const error = await db
      .insert(workspaceMembers)
      // The type says this is impossible; the database has to say so too, or a
      // raw write reaches the table with a role nothing can interpret.
      .values({ workspaceId: ws.id, userId: 'u5', role: 'wizard' as never })
      .then(
        () => null,
        (err: unknown) => err,
      );

    expect(error).not.toBeNull();
    expect(isCheckViolation(error)).toBe(true);
    expect(constraintNameOf(error)).toBe('workspace_members_role');
  });
});

describe('patching', () => {
  it('leaves a field alone when the caller omits it', async () => {
    const ws = await createWorkspace(db, { name: 'Before', icon: 'x', ownerId: `${scope}-patch` });

    const updated = await updateWorkspace(db, ws.id, { name: 'After' });
    // `$set: { icon: undefined }` is a no-op in Mongo and writes NULL in
    // Postgres. This is the assertion that the port did not quietly erase a
    // sibling field on every patch.
    expect(updated).toMatchObject({ name: 'After', icon: 'x' });
  });

  it('accepts an explicit null as a real erasure', async () => {
    const ws = await createWorkspace(db, { name: 'Icon', icon: 'y', ownerId: `${scope}-null` });
    expect(await updateWorkspace(db, ws.id, { icon: null })).toMatchObject({ icon: null });
  });

  it('returns the row unchanged for an empty patch', async () => {
    const ws = await createWorkspace(db, { name: 'Same', ownerId: `${scope}-empty` });
    // An empty `.set()` is a syntax error rather than a no-op, so the guard is
    // load-bearing and this is what pins it.
    expect(await updateWorkspace(db, ws.id, {})).toMatchObject({ name: 'Same' });
  });

  it('returns null when the target does not exist', async () => {
    expect(await updateWorkspace(db, 'no-such-id', { name: 'x' })).toBeNull();
    expect(await archiveWorkspace(db, 'no-such-id')).toBeNull();
    expect(await updateMemberRole(db, 'no-such-id', 'nobody', 'viewer')).toBeNull();
  });
});
