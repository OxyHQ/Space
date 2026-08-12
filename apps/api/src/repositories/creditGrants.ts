/**
 * The two places money turns into credits, and the only two.
 *
 * ## Why this is a module rather than four lines in the route
 *
 * It exists because of a bug it now makes impossible. Each grant is a PAIR of
 * writes — a ledger row that acts as the idempotency lock, then the balance
 * change — and while that pair lived inline in `routes/billing.ts` it had three
 * properties that no test could reach and no reviewer could check in one place:
 * the order of the two writes, their atomicity, and the fact that the balance
 * change happens EXACTLY ONCE per delivery. A stray second `addCredits` after
 * the block doubled every subscription renewal, silently, and the suite was
 * green because every assertion tested the repositories separately.
 *
 * So the pair is one function with one test per path, and the test asserts the
 * exact delta rather than "the balance went up" — the latter passes just as
 * happily on a double grant, which is precisely how the bug survived.
 *
 * ## The three properties, and what each is protecting against
 *
 * **Order.** The ledger row goes FIRST and is the lock. Granting first means a
 * redelivered Stripe webhook — routine, not an error — adds the credits again
 * and only then discovers the duplicate.
 *
 * **The duplicate is a RESULT, not an exception.** `ON CONFLICT ... DO NOTHING
 * RETURNING` means no statement fails, so an empty result is "already granted"
 * and an exception can only ever be a real failure. A ported `catch (11000)`
 * cannot tell a duplicate key from a dropped connection, and answers "already
 * done" to an infrastructure failure — retiring work nobody performed.
 *
 * **Atomicity.** Both writes commit together or neither does. Ordering alone
 * would only MOVE the silent failure: a crash between the two leaves a ledger
 * row blocking every retry and a customer who paid and received nothing, which
 * reads downstream as a completed purchase. Under-crediting behind a present
 * ledger row is worse than over-crediting, because an overpayment is at least
 * visible in the balance.
 */

import type { StationDatabase } from '../db/client.js';
import { addCredits } from './userCredits.js';
import {
  createCreditPurchase,
  createSubscriptionPayment,
  type TransactionRow,
} from './transactions.js';

/**
 * The balance change is refused only because the row is gone — it was created
 * moments earlier by `getOrCreateUserCredits`, so this means someone deleted it
 * mid-request. Throwing rolls the ledger row back, which is the entire reason
 * these two writes share a transaction.
 */
function assertGranted(balance: unknown, oxyUserId: string): void {
  if (!balance) {
    throw new Error(`user_credits row for ${oxyUserId} vanished before the grant`);
  }
}

/**
 * A completed Stripe credit purchase. Idempotent on `stripePaymentIntentId`.
 *
 * @returns the ledger row, or null when this payment intent was already
 *   recorded — in which case NO credits were granted and none must be.
 */
export async function grantCreditPurchase(
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
  return db.transaction(async (tx) => {
    const transaction = await createCreditPurchase(tx, values);
    if (!transaction) return null;

    const balance = await addCredits(tx, values.oxyUserId, values.credits, 'paid');
    assertGranted(balance, values.oxyUserId);
    return transaction;
  });
}

/**
 * One subscription period's credit grant. Idempotent on `dedup`, which the
 * caller builds as `${stripeSubscriptionId}_${periodStart}`.
 *
 * `dedup` makes a REDELIVERED webhook idempotent. It cannot see two grants
 * inside ONE delivery — that is what this function's single `addCredits` is
 * for, and what `creditGrants.pgdb.test.ts` asserts by exact delta.
 *
 * @returns the ledger row, or null when this period was already granted.
 */
export async function grantSubscriptionPeriod(
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
  return db.transaction(async (tx) => {
    const transaction = await createSubscriptionPayment(tx, values);
    if (!transaction) return null;

    const balance = await addCredits(tx, values.oxyUserId, values.credits, 'paid');
    assertGranted(balance, values.oxyUserId);
    return transaction;
  });
}
