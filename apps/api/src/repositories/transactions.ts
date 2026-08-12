/**
 * Transactions — the payment ledger, and the idempotency guard in front of
 * every credit grant.
 *
 * ## Why nothing here catches an exception to detect a duplicate
 *
 * The Mongo original wrapped `Transaction.create(...)` in a `try/catch` and
 * treated error code 11000 as "this Stripe event was already processed"
 * (`routes/billing.ts:642-648` and `:731-737`). That does not port.
 *
 * On Postgres an exception cannot tell a duplicate key from a dropped
 * connection, a statement timeout or a serialization failure — so the naive
 * port answers "already done, skip the credit grant" to an INFRASTRUCTURE
 * FAILURE, and a customer who paid never receives their credits. There is no
 * error and no retry, because the code just concluded the work was finished.
 *
 * `ON CONFLICT ... DO NOTHING RETURNING *` moves the answer out of the
 * exception channel entirely: no statement fails, an EMPTY RESULT is the
 * duplicate, and a genuine failure still throws and still reaches the caller.
 * That is why both writers below return `null` rather than raising.
 *
 * Each conflict target is NAMED. `isUniqueViolation(err)` alone cannot tell
 * "this payment intent was already recorded" from "this subscription period
 * was already granted" from some future index on this table firing for an
 * unrelated reason — and the recovery for each is different.
 */

import { and, desc, eq, sql, type SQL } from 'drizzle-orm';
import type { StationDatabase } from '../db/client.js';
import { transactions } from '../db/schema/billing.js';

export type TransactionRow = typeof transactions.$inferSelect;

/**
 * `routes/billing.ts:631` — a completed credit purchase.
 *
 * Idempotent on `stripePaymentIntentId` (`transactions_stripe_payment_intent_key`).
 * Stripe redelivers `checkout.session.completed`, so this runs more than once
 * for one payment as a matter of routine, not as an error.
 *
 * @returns the inserted row, or null when this payment intent was already
 *   recorded — in which case the caller must NOT grant credits again.
 */
export async function createCreditPurchase(
  db: StationDatabase,
  values: {
    oxyUserId: string;
    stripeCustomerId?: string | null;
    stripePaymentIntentId: string;
    amount: number;
    currency: string;
    credits: number;
    description?: string | null;
  },
): Promise<TransactionRow | null> {
  const rows = await db
    .insert(transactions)
    .values({
      oxyUserId: values.oxyUserId,
      stripeCustomerId: values.stripeCustomerId ?? null,
      stripePaymentIntentId: values.stripePaymentIntentId,
      type: 'credit_purchase',
      amount: values.amount,
      currency: values.currency,
      credits: values.credits,
      status: 'completed',
      description: values.description ?? null,
    })
    .onConflictDoNothing({ target: transactions.stripePaymentIntentId })
    .returning();
  return rows[0] ?? null;
}

/**
 * `routes/billing.ts:718` — a subscription period's credit grant.
 *
 * Idempotent on `dedup` (`transactions_dedup_key`), which the caller builds as
 * `${stripeSubscriptionId}_${periodStart}`. The source put that key inside a
 * `Mixed` (`metadata: { dedup }`) and indexed the nested path; it is a real
 * column here.
 *
 * The ORDER of the two operations is load-bearing and is the caller's to keep:
 * the source inserts the transaction FIRST, as the lock, and only grants
 * credits if the insert was accepted. Granting first would make a redelivered
 * webhook pay out twice.
 *
 * @returns the inserted row, or null when this period was already granted.
 */
export async function createSubscriptionPayment(
  db: StationDatabase,
  values: {
    oxyUserId: string;
    stripeCustomerId?: string | null;
    amount: number;
    currency: string;
    credits: number;
    description?: string | null;
    dedup: string;
  },
): Promise<TransactionRow | null> {
  const rows = await db
    .insert(transactions)
    .values({
      oxyUserId: values.oxyUserId,
      stripeCustomerId: values.stripeCustomerId ?? null,
      type: 'subscription_payment',
      amount: values.amount,
      currency: values.currency,
      credits: values.credits,
      status: 'completed',
      description: values.description ?? null,
      dedup: values.dedup,
    })
    .onConflictDoNothing({ target: transactions.dedup })
    .returning();
  return rows[0] ?? null;
}

/**
 * `routes/billing.ts:532` — a user's own transaction history.
 *
 * The source sorted on `createdAt` alone. `id` is added as a tiebreaker
 * because the primary key is a uuid v7, which is NOT monotonic within a
 * millisecond (roughly half of same-millisecond pairs invert), so two rows
 * written in the same millisecond would otherwise come back in an order
 * Postgres is free to change between calls — and this list is paginated, where
 * an unstable sort silently drops and repeats rows across pages.
 */
export async function listTransactionsByUser(
  db: StationDatabase,
  oxyUserId: string,
  options: { limit: number; offset: number },
): Promise<TransactionRow[]> {
  return db
    .select()
    .from(transactions)
    .where(eq(transactions.oxyUserId, oxyUserId))
    .orderBy(desc(transactions.createdAt), desc(transactions.id))
    .limit(options.limit)
    .offset(options.offset);
}

/**
 * `Transaction.countDocuments({ oxyUserId })` — `routes/billing.ts:537`.
 *
 * `count(*)` is `bigint`, which postgres.js decodes as a STRING while drizzle
 * types it `number`. Left alone, `total + 1` concatenates and `total > 20`
 * compares lexicographically. `Number(...)` at this boundary is the whole fix,
 * and `count.pgdb.test.ts` proves it by asserting arithmetic, not equality.
 */
export async function countTransactionsByUser(
  db: StationDatabase,
  oxyUserId: string,
): Promise<number> {
  const rows = await db
    .select({ total: sql<string>`count(*)` })
    .from(transactions)
    .where(eq(transactions.oxyUserId, oxyUserId));
  return Number(rows[0]?.total ?? 0);
}

/**
 * The admin listing — `internal/providers/routes/billing-admin.ts:30`, which
 * filters by an optional user and/or status.
 */
export async function listTransactions(
  db: StationDatabase,
  filter: { oxyUserId?: string; status?: string },
  options: { limit: number; offset: number },
): Promise<TransactionRow[]> {
  return db
    .select()
    .from(transactions)
    .where(transactionFilter(filter))
    .orderBy(desc(transactions.createdAt), desc(transactions.id))
    .limit(options.limit)
    .offset(options.offset);
}

/** Companion count for {@link listTransactions} — `billing-admin.ts:31`. */
export async function countTransactions(
  db: StationDatabase,
  filter: { oxyUserId?: string; status?: string },
): Promise<number> {
  const rows = await db
    .select({ total: sql<string>`count(*)` })
    .from(transactions)
    .where(transactionFilter(filter));
  return Number(rows[0]?.total ?? 0);
}

/**
 * `Transaction.find({ oxyUserId }).sort({ createdAt: -1 }).limit(50)` —
 * `billing-admin.ts:97`, the per-user admin view.
 */
export async function listRecentTransactionsByUser(
  db: StationDatabase,
  oxyUserId: string,
  limit = 50,
): Promise<TransactionRow[]> {
  return db
    .select()
    .from(transactions)
    .where(eq(transactions.oxyUserId, oxyUserId))
    .orderBy(desc(transactions.createdAt), desc(transactions.id))
    .limit(limit);
}

/**
 * An absent filter key means "no restriction", which is what the admin route's
 * `query` object expresses by simply not having the key. `undefined` must
 * therefore drop the clause entirely rather than compare against NULL — a
 * `where col = null` matches nothing and would turn "all transactions" into
 * "none", an empty admin table with no error.
 */
function transactionFilter(filter: { oxyUserId?: string; status?: string }): SQL | undefined {
  const clauses: SQL[] = [];
  if (filter.oxyUserId !== undefined) clauses.push(eq(transactions.oxyUserId, filter.oxyUserId));
  if (filter.status !== undefined) clauses.push(eq(transactions.status, filter.status));
  return clauses.length > 0 ? and(...clauses) : undefined;
}
