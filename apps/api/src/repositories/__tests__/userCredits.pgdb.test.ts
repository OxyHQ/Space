import { eq, sql } from 'drizzle-orm';
import { afterAll, describe, expect, it } from 'vitest';
import { userCredits } from '../../db/schema/billing.js';
import {
  addCredits,
  chargeAdditionalCredits,
  DEFAULT_FREE_CREDITS,
  deductCredits,
  findUserCreditsById,
  findUserCreditsByStripeCustomerId,
  getOrCreateUserCredits,
  refreshCreditsIfNeeded,
  refundCredits,
  reserveCredits,
  setStripeCustomerId,
  zeroCredits,
} from '../userCredits.js';
import { closeTestDb, testDb, testUserId } from './testDatabase.js';

const db = testDb();

afterAll(closeTestDb);

/** Seed a row with an exact balance. Every test owns its own user id. */
async function seed(free: number, paid: number): Promise<string> {
  const id = testUserId('uc');
  await db.insert(userCredits).values({
    id,
    creditsFree: free,
    creditsFreeLimit: DEFAULT_FREE_CREDITS,
    creditsDailyRefresh: DEFAULT_FREE_CREDITS,
    creditsPaid: paid,
  });
  return id;
}

async function balance(id: string): Promise<{ free: number; paid: number }> {
  const row = await findUserCreditsById(db, id);
  if (!row) throw new Error(`no row for ${id}`);
  return { free: row.creditsFree, paid: row.creditsPaid };
}

describe('getOrCreateUserCredits', () => {
  it('creates a row with the default grant', async () => {
    const id = testUserId('uc-create');
    const row = await getOrCreateUserCredits(db, id);

    expect(row.id).toBe(id);
    expect(row.creditsFree).toBe(DEFAULT_FREE_CREDITS);
    expect(row.creditsFreeLimit).toBe(DEFAULT_FREE_CREDITS);
    expect(row.creditsDailyRefresh).toBe(DEFAULT_FREE_CREDITS);
    expect(row.creditsPaid).toBe(0);
    expect(row.creditsLastUsed).toBeNull();
  });

  /**
   * The `$setOnInsert` half. If this were an `onConflictDoUpdate`, or if the
   * insert values were applied unconditionally, a returning user's spent
   * balance would be reset to 300 on their next request — a silent refund of
   * every credit they have used, on every call.
   */
  it('does NOT overwrite an existing balance', async () => {
    const id = await seed(7, 3);

    const row = await getOrCreateUserCredits(db, id);

    expect(row.creditsFree).toBe(7);
    expect(row.creditsPaid).toBe(3);
  });
});

describe('reserveCredits', () => {
  /**
   * Free is spent before paid — the source's order
   * (`lib/credits-manager.ts:97-110`), and the opposite of `deductCredits`.
   * The second reservation is the one that discriminates: it must take the
   * remaining 6 free AND 2 paid, not 8 from either bucket alone.
   */
  it('spends free first, then paid', async () => {
    const id = await seed(10, 5);

    await reserveCredits(db, id, 4);
    expect(await balance(id)).toEqual({ free: 6, paid: 5 });

    await reserveCredits(db, id, 8);
    expect(await balance(id)).toEqual({ free: 0, paid: 3 });
  });

  it('stamps credits_last_used, the field the Mongoose schema never declared', async () => {
    const id = await seed(10, 0);
    expect((await findUserCreditsById(db, id))?.creditsLastUsed).toBeNull();

    await reserveCredits(db, id, 1);

    expect((await findUserCreditsById(db, id))?.creditsLastUsed).toBeInstanceOf(Date);
  });

  /**
   * Insufficient means REFUSED, and refused means UNCHANGED. Asserting the
   * null alone would pass against an implementation that returned null after
   * having already written a negative balance.
   */
  it('refuses a reservation the balance cannot cover and leaves the row untouched', async () => {
    const id = await seed(3, 2);

    expect(await reserveCredits(db, id, 6)).toBeNull();

    expect(await balance(id)).toEqual({ free: 3, paid: 2 });
  });

  it('allows a reservation for exactly the whole balance', async () => {
    const id = await seed(3, 2);

    expect(await reserveCredits(db, id, 5)).not.toBeNull();

    expect(await balance(id)).toEqual({ free: 0, paid: 0 });
  });

  it('returns null for a user with no row rather than creating one', async () => {
    const id = testUserId('uc-missing');

    expect(await reserveCredits(db, id, 1)).toBeNull();
    expect(await findUserCreditsById(db, id)).toBeNull();
  });
});

/**
 * ## The test this whole file exists for
 *
 * `Promise.all` of two reservations does NOT interleave: each transaction runs
 * to completion before the event loop returns to the other, so the second
 * reads the first's committed row and correctly refuses. That shape passes
 * against a guard lifted into JavaScript and therefore proves nothing.
 *
 * This forces the interleaving instead. A holder transaction pins the row with
 * `SELECT ... FOR UPDATE`; the contender's `UPDATE` blocks on it; the holder
 * then moves the balance BELOW what the contender is about to spend and
 * commits. Under READ COMMITTED the contender re-evaluates its `WHERE` against
 * the new row version:
 *
 *   - guard in the `WHERE`  ⇒ it matches nothing, returns null, row intact.
 *   - guard in JavaScript   ⇒ it overwrites a decision the database already
 *                             made, and the balance goes negative.
 *
 * The wait asserts its OWN precondition: if the contender never actually
 * blocks, the test throws rather than passing on a race that did not happen —
 * otherwise the vacuity just moves up one level.
 */
describe('reserveCredits under a forced write-write conflict', () => {
  it('re-evaluates its guard against the committed row and refuses', async () => {
    const id = await seed(10, 0);

    let contender: Promise<Awaited<ReturnType<typeof reserveCredits>>> | undefined;

    await db.transaction(async (holder) => {
      // Pin the row so the contender cannot proceed past its UPDATE.
      await holder.execute(
        sql`select 1 from ${userCredits} where ${userCredits.id} = ${id} for update`,
      );

      // Started, deliberately NOT awaited: it must block inside Postgres.
      contender = reserveCredits(db, id, 8);

      await waitForBlockedWriter();

      // Move the balance under the contender's feet. It is released when this
      // callback returns and the transaction commits.
      await holder.update(userCredits).set({ creditsFree: 3 }).where(eq(userCredits.id, id));
    });

    const contended = await contender;

    // The reservation was REFUSED — not merely "something went wrong".
    expect(contended).toBeNull();
    // 3, not -5: the guard re-ran. A JS-side guard would have written 3 - 8.
    expect(await balance(id)).toEqual({ free: 3, paid: 0 });
  });
});

/**
 * Polls for a writer waiting on a lock in THIS database, and throws if none
 * appears — the assertion that makes the race test non-vacuous.
 *
 * The waiting condition is read from `pg_locks`, not from `pg_stat_activity`'s
 * `state`/`query`: under a migrator/app role split Postgres blanks those for
 * another role's backend, so the obvious predicate silently matches nothing.
 *
 * `pg_stat_activity` is joined ONLY for `datname`, and that join is the fix for
 * a probe that reported the comfortable answer. A row-lock wait queues on the
 * holder's **`transactionid`**, and `pg_locks.database` is NULL for that
 * locktype — so the natural-looking `where database = (…current_database())`
 * filters out the exact row being looked for and prints "they never
 * overlapped" beside a result only an overlap can produce. Scoping through
 * `datname` keeps sibling ports on this shared server out of the count without
 * discarding the lock that matters.
 */
async function waitForBlockedWriter(timeoutMs = 5000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const rows = await db.execute(sql`
      select count(*)::int as waiting
      from pg_locks l
      join pg_stat_activity a on a.pid = l.pid
      where not l.granted
        and a.datname = current_database()
    `);
    if (Number(rows[0]?.waiting ?? 0) > 0) return;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error(
    'no blocked writer ever appeared — the contender did not contend, so this test measured nothing',
  );
}

describe('the non-negative CHECK', () => {
  /**
   * The CHECK is the safety net under every CAS in this file: if a guard is
   * ever lifted out of a `WHERE`, this is what turns a silent negative balance
   * into a loud refusal. A test asserting it is live is what stops it from
   * being dropped as "redundant with the application logic".
   */
  it('refuses a negative balance instead of storing one', async () => {
    const id = await seed(5, 0);

    await expect(addCredits(db, id, -10, 'free')).rejects.toThrow();

    expect(await balance(id)).toEqual({ free: 5, paid: 0 });
  });

  it('permits exactly zero', async () => {
    const id = await seed(1, 0);
    await expect(addCredits(db, id, -1, 'free')).resolves.not.toBeNull();
    expect(await balance(id)).toEqual({ free: 0, paid: 0 });
  });
});

describe('refreshCreditsIfNeeded', () => {
  /**
   * Fixture instants are written relative to `now` — never as absolute dates,
   * which age into a different meaning and detonate in an unrelated file.
   */
  it('restores free credits to the limit once the window has passed', async () => {
    const id = await seed(0, 0);
    await db
      .update(userCredits)
      .set({ creditsLastRefresh: sql`now() - interval '25 hours'` })
      .where(eq(userCredits.id, id));

    const { row, refreshed } = await refreshCreditsIfNeeded(db, id);

    expect(refreshed).toBe(true);
    expect(row?.creditsFree).toBe(DEFAULT_FREE_CREDITS);
  });

  it('leaves the balance alone inside the window', async () => {
    const id = await seed(4, 0);
    await db
      .update(userCredits)
      .set({ creditsLastRefresh: sql`now() - interval '23 hours'` })
      .where(eq(userCredits.id, id));

    const { row, refreshed } = await refreshCreditsIfNeeded(db, id);

    expect(refreshed).toBe(false);
    expect(row?.creditsFree).toBe(4);
  });

  /**
   * Two refreshes in the same window must grant once. The source needed an
   * explicit CAS on `credits.lastRefresh` for this; here the staleness test
   * lives in the `WHERE` and the second statement simply matches nothing.
   */
  it('grants once per window even when called twice', async () => {
    const id = await seed(0, 0);
    await db
      .update(userCredits)
      .set({ creditsLastRefresh: sql`now() - interval '25 hours'` })
      .where(eq(userCredits.id, id));

    expect((await refreshCreditsIfNeeded(db, id)).refreshed).toBe(true);
    await reserveCredits(db, id, 50);
    expect((await refreshCreditsIfNeeded(db, id)).refreshed).toBe(false);

    expect((await balance(id)).free).toBe(DEFAULT_FREE_CREDITS - 50);
  });

  it('reports no refresh for a user with no row', async () => {
    const result = await refreshCreditsIfNeeded(db, testUserId('uc-none'));
    expect(result).toEqual({ row: null, refreshed: false });
  });
});

describe('addCredits', () => {
  it('adds to paid by default', async () => {
    const id = await seed(1, 2);
    await addCredits(db, id, 10);
    expect(await balance(id)).toEqual({ free: 1, paid: 12 });
  });

  it('adds to free when asked', async () => {
    const id = await seed(1, 2);
    await addCredits(db, id, 10, 'free');
    expect(await balance(id)).toEqual({ free: 11, paid: 2 });
  });

  it('returns null for a user with no row', async () => {
    expect(await addCredits(db, testUserId('uc-none'), 5)).toBeNull();
  });
});

describe('refundCredits', () => {
  /**
   * Refunds land in FREE even when the reservation came out of PAID. That is
   * `$inc: { 'credits.free': ... }` in the source, ported verbatim: a user who
   * bought credits and had a request refunded ends up with the balance moved
   * from paid to free. Pinned by a test so the behaviour is a decision rather
   * than something a later reader "fixes" without noticing whose money moved.
   */
  it('credits the free bucket even for a reservation taken from paid', async () => {
    const id = await seed(0, 10);
    await reserveCredits(db, id, 4);
    expect(await balance(id)).toEqual({ free: 0, paid: 6 });

    await refundCredits(db, id, 4);

    expect(await balance(id)).toEqual({ free: 4, paid: 6 });
  });
});

describe('chargeAdditionalCredits and zeroCredits', () => {
  it('charges the shortfall when the balance covers it', async () => {
    const id = await seed(5, 5);
    expect(await chargeAdditionalCredits(db, id, 7)).not.toBeNull();
    expect(await balance(id)).toEqual({ free: 0, paid: 3 });
  });

  it('refuses when it does not, leaving the caller to write the overage off', async () => {
    const id = await seed(1, 1);

    expect(await chargeAdditionalCredits(db, id, 5)).toBeNull();
    expect(await balance(id)).toEqual({ free: 1, paid: 1 });

    // What `_adjustReservation` does next (`lib/credits-manager.ts:198`).
    await zeroCredits(db, id);
    expect(await balance(id)).toEqual({ free: 0, paid: 0 });
  });
});

describe('deductCredits', () => {
  /**
   * PAID first — deliberately the reverse of `reserveCredits`. The source's
   * two paths have always disagreed and the port preserves the disagreement;
   * this test is what makes the divergence visible instead of looking like a
   * bug in one of them.
   */
  it('spends paid before free, unlike reserveCredits', async () => {
    const id = await seed(10, 5);

    expect(await deductCredits(db, id, 3)).toBe(true);

    expect(await balance(id)).toEqual({ free: 10, paid: 2 });
  });

  it('falls through to free once paid is exhausted', async () => {
    const id = await seed(10, 5);
    expect(await deductCredits(db, id, 8)).toBe(true);
    expect(await balance(id)).toEqual({ free: 7, paid: 0 });
  });

  it('returns false and changes nothing when the total is short', async () => {
    const id = await seed(2, 2);
    expect(await deductCredits(db, id, 5)).toBe(false);
    expect(await balance(id)).toEqual({ free: 2, paid: 2 });
  });
});

describe('stripe customer linkage', () => {
  it('round-trips the customer id', async () => {
    const id = await seed(1, 1);
    const customerId = `cus_${id}`;

    await setStripeCustomerId(db, id, customerId);

    expect((await findUserCreditsByStripeCustomerId(db, customerId))?.id).toBe(id);
  });

  /**
   * The Mongo index was `sparse`, NOT unique, so many rows may legitimately
   * have no customer id. A Postgres index simply indexes the nulls and needs
   * no partial predicate — this asserts the absence of a uniqueness we never
   * had, which is the constraint a careless port would invent.
   */
  it('permits many rows with no stripe customer at all', async () => {
    await seed(1, 0);
    await seed(1, 0);

    const rows = await db.execute(sql`
      select count(*)::int as n from ${userCredits} where ${userCredits.stripeCustomerId} is null
    `);
    expect(Number(rows[0]?.n ?? 0)).toBeGreaterThanOrEqual(2);
  });
});
