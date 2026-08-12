import { eq, like } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { openTestDatabase, type TestDatabase, testScope } from '../../db/__tests__/testDatabase.js';
import { shareLinks } from '../../db/schema/collab.js';
import {
  countShareLinksByPage,
  createShareLink,
  findShareLinkById,
  findShareLinkByToken,
  listActiveShareLinksByPage,
  revokeShareLink,
} from '../shareLinks.js';

let db: TestDatabase;
let close: () => Promise<void>;

const scope = testScope('sharelinks');
const pageId = `${scope}-page`;
const createdBy = `${scope}-user`;

beforeAll(() => {
  ({ db, close } = openTestDatabase());
});

afterAll(async () => {
  await db.delete(shareLinks).where(like(shareLinks.token, `${scope}%`));
  await close();
});

async function newLink(overrides: Partial<Parameters<typeof createShareLink>[1]> = {}) {
  const link = await createShareLink(db, {
    pageId,
    token: `${scope}-${Math.random().toString(36).slice(2)}`,
    scope: 'read',
    createdBy,
    expiresAt: null,
    ...overrides,
  });
  if (!link) throw new Error('fixture insert hit a token collision');
  return link;
}

describe('shareLinks repository', () => {
  /**
   * The token is the equality key for the unauthenticated share endpoint. If it
   * were ever stored transformed — encrypted with a random IV, hashed with a
   * per-row salt — this lookup would return nothing and every share link in
   * existence would 404 with no error anywhere. "Make the tokens consistent" is
   * a plausible later change, so the property gets an assertion rather than a
   * comment.
   */
  it('stores the token verbatim and finds it by exact match', async () => {
    const token = `${scope}-verbatim-token`;
    const created = await newLink({ token });

    expect(created.token).toBe(token);

    const found = await findShareLinkByToken(db, token);
    expect(found?.id).toBe(created.id);

    const raw = await db.select().from(shareLinks).where(eq(shareLinks.id, created.id));
    expect(raw[0]?.token).toBe(token);
  });

  it('does not find a token that differs by one character', async () => {
    const token = `${scope}-near-miss`;
    await newLink({ token });
    expect(await findShareLinkByToken(db, `${token}x`)).toBeNull();
  });

  it('defaults scope to read and accepts every declared scope', async () => {
    for (const value of ['read', 'comment', 'edit'] as const) {
      const link = await newLink({ scope: value });
      expect(link.scope).toBe(value);
    }
  });

  it('refuses a scope outside the declared set', async () => {
    await expect(
      // @ts-expect-error deliberately outside ShareLinkScope — the CHECK is the subject
      newLink({ scope: 'admin' }),
    ).rejects.toThrow();
  });

  describe('token collisions', () => {
    /**
     * The route retries with a fresh token. Mongo signalled a collision by
     * throwing `code: 11000`; catching the Postgres exception instead cannot
     * tell a duplicate key from a dropped connection, so a network failure
     * would be silently retried as if the token were taken. `on conflict do
     * nothing returning` makes the empty result the signal and lets a genuine
     * failure propagate.
     */
    it('returns null rather than throwing', async () => {
      const token = `${scope}-collide`;
      await newLink({ token });

      const second = await createShareLink(db, {
        pageId,
        token,
        scope: 'read',
        createdBy,
        expiresAt: null,
      });
      expect(second).toBeNull();
    });

    it('the retry with a fresh token succeeds', async () => {
      const token = `${scope}-collide-2`;
      await newLink({ token });
      expect(await createShareLink(db, {
        pageId,
        token,
        scope: 'read',
        createdBy,
        expiresAt: null,
      })).toBeNull();

      const retried = await createShareLink(db, {
        pageId,
        token: `${token}-fresh`,
        scope: 'read',
        createdBy,
        expiresAt: null,
      });
      expect(retried).not.toBeNull();
    });

    it('a collision on one page is still a collision on another', async () => {
      const token = `${scope}-global`;
      await newLink({ token });
      expect(
        await createShareLink(db, {
          pageId: `${scope}-other-page`,
          token,
          scope: 'read',
          createdBy,
          expiresAt: null,
        }),
      ).toBeNull();
    });
  });

  describe('listActiveShareLinksByPage', () => {
    const now = new Date('2026-06-01T00:00:00.000Z');

    it('keeps never-expiring and future-expiring links', async () => {
      const listPage = `${scope}-active-page`;
      const never = await newLink({ pageId: listPage, expiresAt: null });
      const future = await newLink({
        pageId: listPage,
        expiresAt: new Date('2026-06-02T00:00:00.000Z'),
      });

      const listed = await listActiveShareLinksByPage(db, listPage, now);
      expect(listed.map((l) => l.id).sort()).toEqual([never.id, future.id].sort());
    });

    it('drops expired and revoked links', async () => {
      const listPage = `${scope}-filtered-page`;
      const kept = await newLink({ pageId: listPage, expiresAt: null });
      await newLink({ pageId: listPage, expiresAt: new Date('2026-05-31T23:59:59.000Z') });
      const revoked = await newLink({ pageId: listPage, expiresAt: null });
      await revokeShareLink(db, revoked.id, now);

      const listed = await listActiveShareLinksByPage(db, listPage, now);
      expect(listed.map((l) => l.id)).toEqual([kept.id]);
    });

    /**
     * A link expiring exactly at `now` is expired. The route reads
     * `expiresAt.getTime() <= Date.now()`, so the list predicate has to be a
     * strict `>` to agree with it — the two would otherwise disagree on one
     * instant, and the list would advertise a link the share endpoint 404s.
     */
    it('treats an expiry exactly at now as expired, matching the read path', async () => {
      const listPage = `${scope}-boundary-page`;
      await newLink({ pageId: listPage, expiresAt: now });
      expect(await listActiveShareLinksByPage(db, listPage, now)).toEqual([]);
    });

    it('is newest-first', async () => {
      const listPage = `${scope}-order-page`;
      const older = await newLink({ pageId: listPage });
      const newer = await newLink({ pageId: listPage });
      await db
        .update(shareLinks)
        .set({ createdAt: new Date('2026-01-01T00:00:00.000Z') })
        .where(eq(shareLinks.id, older.id));
      await db
        .update(shareLinks)
        .set({ createdAt: new Date('2026-01-02T00:00:00.000Z') })
        .where(eq(shareLinks.id, newer.id));

      const listed = await listActiveShareLinksByPage(db, listPage, now);
      expect(listed.map((l) => l.id)).toEqual([newer.id, older.id]);
    });
  });

  describe('revoke', () => {
    it('stamps revokedAt once and refuses a second time', async () => {
      const link = await newLink();
      const at = new Date('2026-04-04T00:00:00.000Z');

      const revoked = await revokeShareLink(db, link.id, at);
      expect(revoked?.revokedAt).toEqual(at);

      // The `is null` guard lives in the WHERE, so a second revoke cannot
      // overwrite the first instant.
      expect(await revokeShareLink(db, link.id, new Date('2026-05-05T00:00:00.000Z'))).toBeNull();
      expect((await findShareLinkById(db, link.id))?.revokedAt).toEqual(at);
    });

    it('returns null for an id that is not there', async () => {
      expect(await revokeShareLink(db, `${scope}-missing`, new Date())).toBeNull();
    });
  });

  describe('countShareLinksByPage', () => {
    /**
     * postgres.js decodes `bigint` as a STRING while drizzle types it `number`,
     * so an uncast `count(*)` returns `"2"` and `total + 1` becomes `"21"`. The
     * type assertion is the point of this test; the value alone would pass
     * either way.
     */
    it('returns a number, not the string postgres.js decodes bigint into', async () => {
      const countPage = `${scope}-count-page`;
      await newLink({ pageId: countPage });
      await newLink({ pageId: countPage });

      const total = await countShareLinksByPage(db, countPage);
      expect(typeof total).toBe('number');
      expect(total).toBe(2);
      expect(total + 1).toBe(3);
    });
  });
});
