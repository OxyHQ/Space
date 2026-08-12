import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { feedback } from '../../db/schema/billing.js';
import {
  createFeedback,
  findFeedbackByIdForUser,
  listFeedbackByUser,
} from '../feedback.js';
import {
  closeTestDb,
  getTestDb,
  type TestDatabase,
  testScope,
} from '../../db/__tests__/testDatabase.js';

let db: TestDatabase;

beforeAll(async () => {
  db = await getTestDb();
});

afterAll(closeTestDb);

describe('createFeedback', () => {
  it('stores the submission with its declared metadata fields', async () => {
    const userId = testScope('fb-create');

    const row = await createFeedback(db, {
      oxyUserId: userId,
      type: 'bug',
      rating: 4,
      message: 'The sidebar collapses on its own',
      email: 'someone@example.com',
      metadata: { platform: 'ios', appVersion: '1.2.3', deviceInfo: 'iPhone 15' },
    });

    expect(row.status).toBe('pending');
    expect(row.metadataPlatform).toBe('ios');
    expect(row.metadataAppVersion).toBe('1.2.3');
    expect(row.metadataDeviceInfo).toBe('iPhone 15');
  });

  /**
   * The Mongoose schema declares exactly three metadata keys, so strict mode
   * DROPPED everything else — and the route passes `metadata` straight out of
   * the request body. Storing the object wholesale in a `jsonb` column would
   * start persisting arbitrary unvalidated user input the source discarded, so
   * the three columns are the faithful port. This asserts the extra keys go
   * nowhere.
   */
  it('discards metadata keys the schema never declared', async () => {
    const userId = testScope('fb-strict');

    const row = await createFeedback(db, {
      oxyUserId: userId,
      type: 'other',
      message: 'hello',
      metadata: {
        platform: 'web',
        // Not part of the declared shape — the source dropped these.
        ...({ injected: 'value', apiKey: 'sk-secret' } as Record<string, string>),
      },
    });

    expect(row.metadataPlatform).toBe('web');
    expect(Object.values(row)).not.toContain('sk-secret');
  });

  it('accepts a submission with no rating and no metadata', async () => {
    const userId = testScope('fb-minimal');

    const row = await createFeedback(db, {
      oxyUserId: userId,
      type: 'feature',
      message: 'Dark mode please',
    });

    expect(row.rating).toBeNull();
    expect(row.metadataPlatform).toBeNull();
    expect(row.email).toBeNull();
  });
});

/**
 * `min: 1, max: 5` genuinely fires in the source — feedback is written through
 * `new Feedback(...).save()`, the one path that runs validators — so it is a
 * live constraint here rather than a dead validator converted into one.
 */
describe('rating CHECK', () => {
  it('refuses a rating above 5', async () => {
    await expect(
      createFeedback(db, { oxyUserId: testScope('fb-hi'), type: 'bug', message: 'x', rating: 6 }),
    ).rejects.toThrow();
  });

  it('refuses a rating below 1', async () => {
    await expect(
      createFeedback(db, { oxyUserId: testScope('fb-lo'), type: 'bug', message: 'x', rating: 0 }),
    ).rejects.toThrow();
  });

  it('accepts both boundaries', async () => {
    const userId = testScope('fb-bounds');
    await expect(
      createFeedback(db, { oxyUserId: userId, type: 'bug', message: 'x', rating: 1 }),
    ).resolves.toBeDefined();
    await expect(
      createFeedback(db, { oxyUserId: userId, type: 'bug', message: 'x', rating: 5 }),
    ).resolves.toBeDefined();
  });

  it('refuses a type outside the enum', async () => {
    await expect(
      createFeedback(db, { oxyUserId: testScope('fb-type'), type: 'complaint', message: 'x' }),
    ).rejects.toThrow();
  });
});

describe('reading feedback back', () => {
  it('returns a user history newest first', async () => {
    const userId = testScope('fb-list');
    await db.insert(feedback).values([
      {
        oxyUserId: userId,
        type: 'bug',
        message: 'older',
        createdAt: new Date(Date.now() - 20_000),
      },
      {
        oxyUserId: userId,
        type: 'bug',
        message: 'newer',
        createdAt: new Date(Date.now() - 10_000),
      },
    ]);

    const rows = await listFeedbackByUser(db, userId);

    expect(rows.map((r) => r.message)).toEqual(['newer', 'older']);
  });

  it('scopes a history to its own user', async () => {
    const mine = testScope('fb-mine');
    const theirs = testScope('fb-theirs');
    await createFeedback(db, { oxyUserId: mine, type: 'bug', message: 'mine' });
    await createFeedback(db, { oxyUserId: theirs, type: 'bug', message: 'theirs' });

    const rows = await listFeedbackByUser(db, mine);

    expect(rows).toHaveLength(1);
    expect(rows[0]?.message).toBe('mine');
  });

  /**
   * Ownership is part of the WHERE clause, so another user's feedback is a
   * MISS rather than a row the caller has to remember to reject. An
   * id-only lookup plus a caller-side check is the shape that turns into an
   * IDOR the first time someone forgets the second half.
   */
  it('refuses to return another user\'s feedback', async () => {
    const mine = testScope('fb-owner');
    const theirs = testScope('fb-other');
    const row = await createFeedback(db, { oxyUserId: mine, type: 'bug', message: 'private' });

    expect((await findFeedbackByIdForUser(db, row.id, mine))?.message).toBe('private');
    expect(await findFeedbackByIdForUser(db, row.id, theirs)).toBeNull();
  });

  /**
   * `oxyUserId` is `text`, not an ObjectId, because the only writer stores an
   * opaque Oxy user id. A non-hex id must therefore round-trip rather than
   * raising the CastError Mongoose would have thrown.
   */
  it('round-trips an Oxy user id that is not ObjectId-shaped', async () => {
    const userId = 'oxy-user-not-hex-at-all';
    const row = await createFeedback(db, {
      oxyUserId: userId,
      type: 'other',
      message: 'shape probe',
    });

    expect(row.oxyUserId).toBe(userId);
    expect((await findFeedbackByIdForUser(db, row.id, userId))?.id).toBe(row.id);
  });
});
