/**
 * The one place the "database or transaction" parameter is spelled.
 *
 * Every repository function takes a handle rather than reaching for `getDb()`
 * itself, so a caller that needs two writes to commit together can pass its
 * transaction and get it. A function that reached for the pool directly would
 * silently escape its caller's transaction — which is the failure the
 * `replaceForConversation` chokepoint in `messages.ts` exists to prevent, and
 * it can only be prevented if the handle is a parameter everywhere.
 */

import { getDb, type StationDatabase } from '../db/client.js';

/** The transaction object drizzle hands a `db.transaction(...)` callback. */
export type StationTransaction = Parameters<Parameters<StationDatabase['transaction']>[0]>[0];

/** A pool handle or a transaction handle — anything that can run a statement. */
export type PgHandle = StationDatabase | StationTransaction;

/**
 * Resolve an optional handle to a usable one.
 *
 * Deliberately NOT a default parameter value: `getDb()` throws when
 * `DATABASE_URL` is unset, and a default would evaluate it at every call
 * regardless of whether the caller supplied a handle.
 */
export function resolveHandle(handle?: PgHandle): PgHandle {
  return handle ?? getDb();
}

/**
 * Refuse to run outside a transaction.
 *
 * A signature makes `tsc` ask for a handle; only this makes the caller open a
 * transaction. Checked at runtime because `StationDatabase` and
 * `StationTransaction` are structurally close enough that a pool handle passed
 * where a transaction is required type-checks in practice.
 */
export function requireTransaction(handle: PgHandle, operation: string): StationTransaction {
  if (!isTransaction(handle)) {
    throw new Error(
      `${operation} must run inside a transaction: it deletes rows before inserting their replacements, and the gap between the two is a state no reader may observe.`,
    );
  }
  return handle;
}

function isTransaction(handle: PgHandle): handle is StationTransaction {
  // `rollback` exists only on the transaction object drizzle passes to the
  // callback, never on the pool handle returned by `createDatabase()`.
  return typeof (handle as StationTransaction).rollback === 'function';
}
