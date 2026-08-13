/**
 * User credits — the balance every paid path in this service reads and writes.
 *
 * ## The one thing to understand before changing anything here
 *
 * Mongo did the arithmetic in a single `findOneAndUpdate` whose FILTER carried
 * the guard (`$expr: { $gte: [{ $add: ['$credits.free', '$credits.paid'] }, amount] }`).
 * That is a compare-and-set: the balance check and the deduction are one
 * statement, and "no document matched" IS the answer "insufficient credits".
 *
 * Every function below keeps the guard in the `WHERE` clause for the same
 * reason. Under READ COMMITTED a Postgres `UPDATE` re-evaluates its `WHERE`
 * against the newest row version after waiting on a concurrent writer's lock,
 * so two simultaneous deductions cannot both pass a guard only one of them can
 * afford. Lift a guard into TypeScript — read the row, check in JS, then
 * write — and it silently becomes a read-modify-write race that double-spends
 * under load and passes every single-threaded test.
 *
 * Empty result means REFUSED, never "something went wrong": a driver failure
 * still throws.
 *
 * Every `models/user-credits.ts` and `lib/user-credits-helpers.ts` citation
 * below points at the PRE-PORT Mongoose source. Both files were deleted when
 * the billing routes were rewired onto this repository; read them at `master`
 * f7834e8 or earlier. They are cited rather than paraphrased because each one
 * is the evidence for a semantic choice made here — the spend order, the refund
 * bucket, the unguarded `$inc` — and a paraphrase is what lets one of those
 * quietly change.
 */

import { and, eq, gte, sql } from 'drizzle-orm';
import type { StationDatabase } from '../db/client.js';
import type { PgHandle } from './handle.js';
import { userCredits } from '../db/schema/billing.js';

/**
 * The free-credit grant a new row starts with. One constant, as
 * `lib/user-credits-helpers.ts:8` had it — the column defaults in
 * `schema/billing.ts` carry the same number, and both are written explicitly
 * on insert so a default drifting from this constant cannot change what a new
 * account receives.
 */
export const DEFAULT_FREE_CREDITS = 300;

export type UserCreditsRow = typeof userCredits.$inferSelect;

/**
 * Port of `getOrCreateUserCredits` (`lib/user-credits-helpers.ts:10`), whose
 * Mongo form was `findByIdAndUpdate(userId, { $setOnInsert: {...} },
 * { upsert: true, returnDocument: 'after' })`.
 *
 * `$setOnInsert` writes ONLY when inserting, so the existing-row path must not
 * touch the row — which is why this is not an `onConflictDoUpdate`. A no-op
 * update would still take a row lock and cut a new row version on every chat
 * completion, and this is called on each one.
 *
 * The select comes first because the row almost always exists; the insert is
 * `DO NOTHING` so a concurrent creation is answered by the re-read rather than
 * by an exception. `RETURNING` is empty exactly when someone else won the
 * race, which is why the final read cannot be skipped.
 */
export async function getOrCreateUserCredits(
  db: StationDatabase,
  userId: string,
): Promise<UserCreditsRow> {
  const existing = await db.select().from(userCredits).where(eq(userCredits.id, userId)).limit(1);
  if (existing[0]) return existing[0];

  const inserted = await db
    .insert(userCredits)
    .values({
      id: userId,
      creditsFree: DEFAULT_FREE_CREDITS,
      creditsFreeLimit: DEFAULT_FREE_CREDITS,
      creditsDailyRefresh: DEFAULT_FREE_CREDITS,
      creditsPaid: 0,
      creditsLastRefresh: new Date(),
    })
    .onConflictDoNothing({ target: userCredits.id })
    .returning();
  if (inserted[0]) return inserted[0];

  const raced = await db.select().from(userCredits).where(eq(userCredits.id, userId)).limit(1);
  if (!raced[0]) {
    throw new Error(`user_credits row for ${userId} vanished between insert and read`);
  }
  return raced[0];
}

export async function findUserCreditsById(
  db: StationDatabase,
  userId: string,
): Promise<UserCreditsRow | null> {
  const rows = await db.select().from(userCredits).where(eq(userCredits.id, userId)).limit(1);
  return rows[0] ?? null;
}

/** `UserCredits.findOne({ stripeCustomerId })` — `routes/billing.ts:665`. */
export async function findUserCreditsByStripeCustomerId(
  db: StationDatabase,
  stripeCustomerId: string,
): Promise<UserCreditsRow | null> {
  const rows = await db
    .select()
    .from(userCredits)
    .where(eq(userCredits.stripeCustomerId, stripeCustomerId))
    .limit(1);
  return rows[0] ?? null;
}

/** `userCredits.stripeCustomerId = id; await userCredits.save()` — `routes/billing.ts:64`, `:671`. */
export async function setStripeCustomerId(
  db: StationDatabase,
  userId: string,
  stripeCustomerId: string,
): Promise<UserCreditsRow | null> {
  const rows = await db
    .update(userCredits)
    .set({ stripeCustomerId })
    .where(eq(userCredits.id, userId))
    .returning();
  return rows[0] ?? null;
}

/**
 * Port of the `refreshCreditsIfNeeded` instance method
 * (`models/user-credits.ts:36`). Call sites: `routes/v1.ts:55`,
 * `routes/credits.ts:15`, `services/chat.service.ts:127`.
 *
 * The source read the document, computed `hoursSinceRefresh` in JavaScript,
 * and then guarded the write with `'credits.lastRefresh': this.credits.lastRefresh`
 * — an optimistic CAS whose only job was to stop two concurrent refreshes from
 * both applying. Here the staleness test itself lives in the `WHERE`, so the
 * CAS is unnecessary: the row is refreshed at most once per window because the
 * second statement re-evaluates `credits_last_refresh` after the first commits
 * and matches nothing.
 *
 * Two deliberate consequences, neither observable to a caller:
 *  - the 24-hour boundary is measured against the DATABASE clock rather than
 *    each API instance's, so instances with drifting clocks agree;
 *  - `credits_free` is set from the `credits_free_limit` COLUMN rather than
 *    from the caller's copy of it. Equivalent today — no writer in the
 *    codebase ever updates `freeLimit` after the row is created — and it
 *    cannot go stale.
 *
 * Returns the row either way; `refreshed` says whether the grant was applied.
 */
export async function refreshCreditsIfNeeded(
  db: StationDatabase,
  userId: string,
): Promise<{ row: UserCreditsRow | null; refreshed: boolean }> {
  const refreshedRows = await db
    .update(userCredits)
    .set({
      creditsFree: sql`${userCredits.creditsFreeLimit}`,
      creditsLastRefresh: sql`now()`,
    })
    .where(
      and(
        eq(userCredits.id, userId),
        sql`${userCredits.creditsLastRefresh} <= now() - interval '24 hours'`,
      ),
    )
    .returning();

  if (refreshedRows[0]) return { row: refreshedRows[0], refreshed: true };

  // No refresh was due — or there is no such row. Distinguish by reading.
  return { row: await findUserCreditsById(db, userId), refreshed: false };
}

/**
 * Port of the `addCredits` instance method (`models/user-credits.ts:54`).
 * Call sites: `routes/billing.ts:627` (credit purchase) and `:729`
 * (subscription grant), both with `'paid'`.
 *
 * Deliberately unguarded against a negative `amount`, exactly as `$inc` was.
 * A negative grant is refused by the `user_credits_non_negative` CHECK rather
 * than by a branch here — loudly, at the moment of the write, instead of
 * silently producing a negative balance that every downstream reader treats as
 * arithmetic.
 *
 * Returns null when the user has no row, matching `findByIdAndUpdate`'s null.
 */
export async function addCredits(
  db: PgHandle,
  userId: string,
  amount: number,
  type: 'free' | 'paid' = 'paid',
): Promise<UserCreditsRow | null> {
  const rows = await db
    .update(userCredits)
    .set(
      type === 'free'
        ? { creditsFree: sql`${userCredits.creditsFree} + ${amount}` }
        : { creditsPaid: sql`${userCredits.creditsPaid} + ${amount}` },
    )
    .where(eq(userCredits.id, userId))
    .returning();
  return rows[0] ?? null;
}

/**
 * Port of `reserveCredits` (`lib/credits-manager.ts:81`) — the hot path, run
 * on every chat completion.
 *
 * FREE IS SPENT FIRST, then paid. That is the source's order and it is the
 * OPPOSITE of `deductCredits` below; both orders are preserved as they were
 * found rather than reconciled, because reconciling them silently changes who
 * gets billed for what.
 *
 * Every `SET` expression reads the OLD row, so `credits_paid - (amount -
 * credits_free)` uses the pre-update `credits_free` — the same values the
 * `CASE` discriminates on, and the same ones Mongo's pipeline stage saw.
 *
 * `credits_last_used` is written here and nowhere else, reproducing
 * `'credits.lastUsed': new Date()` at `lib/credits-manager.ts:111`. Nothing
 * reads it; see the column's note in `schema/billing.ts`.
 *
 * Returns null when the balance cannot cover `amount` — zero rows updated,
 * which is the whole guard.
 */
export async function reserveCredits(
  db: StationDatabase,
  userId: string,
  amount: number,
): Promise<UserCreditsRow | null> {
  const rows = await db
    .update(userCredits)
    .set({
      creditsFree: sql`case when ${userCredits.creditsFree} >= ${amount} then ${userCredits.creditsFree} - ${amount} else 0 end`,
      creditsPaid: sql`case when ${userCredits.creditsFree} >= ${amount} then ${userCredits.creditsPaid} else ${userCredits.creditsPaid} - (${amount} - ${userCredits.creditsFree}) end`,
      creditsLastUsed: sql`now()`,
    })
    .where(
      and(
        eq(userCredits.id, userId),
        gte(sql`${userCredits.creditsFree} + ${userCredits.creditsPaid}`, amount),
      ),
    )
    .returning();
  return rows[0] ?? null;
}

/**
 * The over-reservation branch of `_adjustReservation`
 * (`lib/credits-manager.ts:167`): the request used MORE than was reserved, so
 * the difference is charged now. Identical CAS to `reserveCredits`, without
 * the `credits_last_used` write — the source's second pipeline omits it too.
 */
export async function chargeAdditionalCredits(
  db: StationDatabase,
  userId: string,
  amount: number,
): Promise<UserCreditsRow | null> {
  const rows = await db
    .update(userCredits)
    .set({
      creditsFree: sql`case when ${userCredits.creditsFree} >= ${amount} then ${userCredits.creditsFree} - ${amount} else 0 end`,
      creditsPaid: sql`case when ${userCredits.creditsFree} >= ${amount} then ${userCredits.creditsPaid} else ${userCredits.creditsPaid} - (${amount} - ${userCredits.creditsFree}) end`,
    })
    .where(
      and(
        eq(userCredits.id, userId),
        gte(sql`${userCredits.creditsFree} + ${userCredits.creditsPaid}`, amount),
      ),
    )
    .returning();
  return rows[0] ?? null;
}

/**
 * What `_adjustReservation` does when the additional charge cannot be covered
 * (`lib/credits-manager.ts:198`): both balances are set to zero and the
 * shortfall is absorbed. The user is not left owing anything, and the
 * remainder of the request is not refused.
 *
 * Preserved as found. It is a real policy — writing off the overage — and not
 * an error path, so it must not be turned into a rejection by anyone tidying
 * up later.
 */
export async function zeroCredits(
  db: StationDatabase,
  userId: string,
): Promise<UserCreditsRow | null> {
  const rows = await db
    .update(userCredits)
    .set({ creditsFree: 0, creditsPaid: 0 })
    .where(eq(userCredits.id, userId))
    .returning();
  return rows[0] ?? null;
}

/**
 * Port of `refundReservation` (`lib/credits-manager.ts:265`) and of the
 * refund branch of `_adjustReservation` (`:158`).
 *
 * REFUNDS ALWAYS LAND IN `credits_free`, even when the reservation was taken
 * from `credits_paid`. That is what `$inc: { 'credits.free': ... }` did, and
 * it means a user who pays for credits and then has a request refunded ends up
 * with the balance moved from paid to free. Ported verbatim because changing
 * it moves real money between two buckets with different top-up rules; it is
 * called out here so the choice is visible rather than inherited by accident.
 */
export async function refundCredits(
  db: StationDatabase,
  userId: string,
  amount: number,
): Promise<UserCreditsRow | null> {
  const rows = await db
    .update(userCredits)
    .set({ creditsFree: sql`${userCredits.creditsFree} + ${amount}` })
    .where(eq(userCredits.id, userId))
    .returning();
  return rows[0] ?? null;
}

/**
 * Port of the `deductCredits` instance method (`models/user-credits.ts:66`).
 *
 * NO CALL SITES. Verified by grepping `.deductCredits(` across `src/` — the
 * method is defined, typed on `IUserCredits`, and invoked by nothing. Ported
 * so the model's surface is complete and so the rewiring PR can delete it
 * deliberately rather than discover it missing.
 *
 * PAID IS SPENT FIRST here — the reverse of `reserveCredits`. The source says
 * so in a comment (`// Deduct from paid first, then free`) and the two have
 * always disagreed. Preserved, not reconciled.
 *
 * The source took two round trips and a JavaScript pre-check; this is one
 * statement, so the "total is sufficient" test and the deduction can no longer
 * disagree. `greatest(...)` reproduces the source's branch: when paid covers
 * the amount, free is untouched.
 */
export async function deductCredits(
  db: StationDatabase,
  userId: string,
  amount: number,
): Promise<boolean> {
  const rows = await db
    .update(userCredits)
    .set({
      creditsPaid: sql`greatest(${userCredits.creditsPaid} - ${amount}, 0)`,
      creditsFree: sql`${userCredits.creditsFree} - greatest(${amount} - ${userCredits.creditsPaid}, 0)`,
    })
    .where(
      and(
        eq(userCredits.id, userId),
        gte(sql`${userCredits.creditsFree} + ${userCredits.creditsPaid}`, amount),
      ),
    )
    .returning({ id: userCredits.id });
  return rows.length > 0;
}
