/**
 * Provider keys — every query `internal/providers/routes/keys.ts`,
 * `internal/providers/lib/key-manager.ts`, `lib/broadcast-helpers.ts` and
 * `lib/seed-model-configs.ts` perform against the `ProviderKey` model.
 *
 * ## The secret and the digest are handled differently, on purpose
 *
 * `keyHash` is `sha256(key)` and is what every lookup matches on
 * ({@link findByKeyHash}). It must stay a DETERMINISTIC digest. `key` is the
 * secret itself and is only ever read back to be handed to a provider — nothing
 * matches, sorts or groups on it, and this module deliberately exposes no way
 * to look a key up by its value. {@link PUBLIC_COLUMNS} is the projection the
 * admin routes use (`.select('-keyHash -key')`), and it omits both.
 *
 * `__tests__/provider-keys.pgdb.test.ts` fails if either half of that changes.
 *
 * ## Three document methods are NOT here, because nothing calls them
 *
 * `validateKey`, `updateUsage` and `isAvailable` (`provider-key.ts:79-83`) plus
 * the `hashKey` / `getKeyPrefix` statics have zero call sites in the repository
 * — the routes inline `crypto.createHash('sha256')` instead. They are dead in
 * the source and are not ported; porting them would grow a surface nobody uses
 * and imply a caller that does not exist. `recordSuccess` and `recordFailure`
 * ARE live (`key-manager.ts:333` and `:376`) and are here.
 */

import { createHash } from 'node:crypto';
import { and, asc, count, eq, gt, isNotNull, or, sql } from 'drizzle-orm';
import type { PgHandle } from './handle.js';
import { providerKeys } from '../db/schema/providers.js';

/**
 * Failure reasons that mean "quota", not "broken key".
 *
 * Lifted verbatim from `provider-key.ts:229`, and it must stay identical: a
 * rate-limited key is deliberately spared the `consecutiveFailures` /
 * `totalFailures` increments so a busy key is never archived for being busy.
 */
const RATE_LIMIT_PATTERN = /rate.?limit|429|RESOURCE_EXHAUSTED|quota/i;

/** `provider-key.ts:246` truncates to this before storing. */
const FAILURE_REASON_MAX = 500;

/**
 * What the admin routes are allowed to return: everything except the secret and
 * its digest. This is the port of `.select('-keyHash -key')`, spelled once so a
 * new route cannot forget it.
 */
export const PUBLIC_COLUMNS = {
  id: providerKeys.id,
  name: providerKeys.name,
  provider: providerKeys.provider,
  environment: providerKeys.environment,
  keyPrefix: providerKeys.keyPrefix,
  rateLimitRps: providerKeys.rateLimitRps,
  rateLimitRpm: providerKeys.rateLimitRpm,
  rateLimitRph: providerKeys.rateLimitRph,
  rateLimitRpd: providerKeys.rateLimitRpd,
  rateLimitTps: providerKeys.rateLimitTps,
  rateLimitTpm: providerKeys.rateLimitTpm,
  rateLimitTph: providerKeys.rateLimitTph,
  rateLimitTpd: providerKeys.rateLimitTpd,
  isActive: providerKeys.isActive,
  isPaid: providerKeys.isPaid,
  tier: providerKeys.tier,
  currentPriority: providerKeys.currentPriority,
  originalPriority: providerKeys.originalPriority,
  creditLimitUSD: providerKeys.creditLimitUSD,
  spentUSD: providerKeys.spentUSD,
  lastUsedAt: providerKeys.lastUsedAt,
  lastSuccessAt: providerKeys.lastSuccessAt,
  totalRequests: providerKeys.totalRequests,
  totalTokens: providerKeys.totalTokens,
  successCount: providerKeys.successCount,
  consecutiveFailures: providerKeys.consecutiveFailures,
  totalFailures: providerKeys.totalFailures,
  lastFailureAt: providerKeys.lastFailureAt,
  lastFailureReason: providerKeys.lastFailureReason,
  cooldownUntil: providerKeys.cooldownUntil,
  rateLimitResetMs: providerKeys.rateLimitResetMs,
  maxTotalFailures: providerKeys.maxTotalFailures,
  isArchived: providerKeys.isArchived,
  archivedAt: providerKeys.archivedAt,
  archivedReason: providerKeys.archivedReason,
  rotatedAt: providerKeys.rotatedAt,
  expiresAt: providerKeys.expiresAt,
  rotationSchedule: providerKeys.rotationSchedule,
  ownerId: providerKeys.ownerId,
  organizationId: providerKeys.organizationId,
  createdAt: providerKeys.createdAt,
  updatedAt: providerKeys.updatedAt,
} as const;

export type ProviderKeyRow = typeof providerKeys.$inferSelect;
export type NewProviderKey = typeof providerKeys.$inferInsert;

/** `sha256(key)` hex — the same digest `routes/keys.ts:265` and `:444` compute. */
export function hashProviderKey(key: string): string {
  return createHash('sha256').update(key).digest('hex');
}

/** `key.substring(0, 8) + '...'` — the display prefix, derived, never matched on. */
export function providerKeyPrefix(key: string): string {
  return `${key.substring(0, Math.min(8, key.length))}...`;
}

/**
 * `key-manager.ts:89` — every selectable key for a provider.
 *
 * The source loads the rows and sorts them in JavaScript: free keys first, then
 * paid, each group by `currentPriority` ascending (`key-manager.ts:142-151`).
 * That ordering moves into SQL unchanged, with `id` added as a tiebreak —
 * `Array.prototype.sort` is stable so equal-priority keys kept their fetch
 * order, and a Postgres sort has no such guarantee. Without the tiebreak the
 * order of two same-priority keys would vary between calls, which is exactly
 * the kind of arbitrariness that must not be ported as-is.
 */
export async function listSelectableKeys(
  db: PgHandle,
  provider: string,
): Promise<ProviderKeyRow[]> {
  return db
    .select()
    .from(providerKeys)
    .where(
      and(
        eq(providerKeys.provider, provider),
        eq(providerKeys.isArchived, false),
        eq(providerKeys.isActive, true),
      ),
    )
    .orderBy(asc(providerKeys.isPaid), asc(providerKeys.currentPriority), asc(providerKeys.id));
}

/**
 * `routes/keys.ts:95` and `lib/broadcast-helpers.ts:20` — the admin listing.
 *
 * ## The source's sort key does not exist
 *
 * Both call sites sort `{ provider: 1, priority: 1 }`, and `ProviderKey` has no
 * `priority` field — it has `currentPriority` and `originalPriority`. In Mongo a
 * sort on an absent path compares every document equal on that key, so the
 * order within a provider is whatever the scan happens to produce. Porting that
 * arbitrariness is not an option, so this sorts by `currentPriority` — the
 * field the caller plainly meant, and the one the selection order already uses
 * — then by `id`.
 */
export async function listKeys(
  db: PgHandle,
  filter: { provider?: string; environment?: string; isActive?: boolean } = {},
) {
  const conditions = [];
  if (filter.provider !== undefined) conditions.push(eq(providerKeys.provider, filter.provider));
  if (filter.environment !== undefined) {
    conditions.push(eq(providerKeys.environment, filter.environment));
  }
  if (filter.isActive !== undefined) conditions.push(eq(providerKeys.isActive, filter.isActive));

  return db
    .select(PUBLIC_COLUMNS)
    .from(providerKeys)
    .where(conditions.length > 0 ? and(...conditions) : undefined)
    .orderBy(asc(providerKeys.provider), asc(providerKeys.currentPriority), asc(providerKeys.id));
}

/**
 * `routes/keys.ts:120` — the diagnostics listing.
 *
 * Returns `key` because the caller needs `!!k.key` and `k.key.length` to report
 * whether a key has a usable value. It never returns the value itself, and the
 * route does not either — the shape it builds carries `hasKeyValue` and
 * `keyLength` only.
 */
export async function listKeysForDiagnostics(db: PgHandle) {
  return db
    .select({
      id: providerKeys.id,
      name: providerKeys.name,
      provider: providerKeys.provider,
      keyPrefix: providerKeys.keyPrefix,
      isActive: providerKeys.isActive,
      key: providerKeys.key,
      isPaid: providerKeys.isPaid,
      currentPriority: providerKeys.currentPriority,
      totalRequests: providerKeys.totalRequests,
      successCount: providerKeys.successCount,
      totalFailures: providerKeys.totalFailures,
      lastFailureReason: providerKeys.lastFailureReason,
      creditLimitUSD: providerKeys.creditLimitUSD,
      spentUSD: providerKeys.spentUSD,
    })
    .from(providerKeys)
    .where(eq(providerKeys.isArchived, false));
}

/** `key-manager.ts:420` — every non-archived key for a provider, for the stats roll-up. */
export async function listKeysForProvider(
  db: PgHandle,
  provider: string,
): Promise<ProviderKeyRow[]> {
  return db
    .select()
    .from(providerKeys)
    .where(and(eq(providerKeys.provider, provider), eq(providerKeys.isArchived, false)));
}

/** `routes/keys.ts:180` — one key, without the secret or its digest. */
export async function findPublicById(db: PgHandle, id: string) {
  const [row] = await db.select(PUBLIC_COLUMNS).from(providerKeys).where(eq(providerKeys.id, id));
  return row ?? null;
}

/**
 * `key-manager.ts:331`, `:358`, `:454` — the full row, secret included.
 *
 * Separate from {@link findPublicById} so that returning the secret is always a
 * choice someone made by naming this function, never the default.
 */
export async function findById(db: PgHandle, id: string): Promise<ProviderKeyRow | null> {
  const [row] = await db.select().from(providerKeys).where(eq(providerKeys.id, id));
  return row ?? null;
}

/**
 * `routes/keys.ts:268` and `:447` — the deduplication lookup.
 *
 * This is the one place a key is found by a derived value, and it works only
 * because `hashProviderKey` is deterministic. Making the digest randomised
 * would not error here; it would silently return `null` for a key that already
 * exists, so `POST /v1/keys` would accept a duplicate and the unique index
 * would reject it with a 500. Pinned by test.
 */
export async function findByKeyHash(
  db: PgHandle,
  keyHash: string,
): Promise<ProviderKeyRow | null> {
  const [row] = await db.select().from(providerKeys).where(eq(providerKeys.keyHash, keyHash));
  return row ?? null;
}

/** `routes/keys.ts:281`. */
export async function createKey(
  db: PgHandle,
  values: NewProviderKey,
): Promise<ProviderKeyRow> {
  const [row] = await db.insert(providerKeys).values(values).returning();
  return row;
}

/**
 * Fields `PATCH /v1/keys/:keyId` may change (`routes/keys.ts:330`).
 *
 * The route's allow-list contains `priority`, which is NOT a field on the
 * model. Mongoose runs `findByIdAndUpdate` in strict mode, so that key is
 * silently STRIPPED and the update is a no-op for it — a caller sending
 * `{ priority: 5 }` gets a 200 and no change. That is a bug in the route, and
 * it is out of scope here; what matters for the port is that this type does not
 * quietly invent the field, which would turn a silent no-op into a silent
 * WRITE to `currentPriority`. The rewiring commit has to decide which field the
 * route meant.
 */
export interface ProviderKeyPatch {
  name?: string;
  isActive?: boolean;
  rateLimitRps?: number | null;
  rateLimitRpm?: number | null;
  rateLimitRph?: number | null;
  rateLimitRpd?: number | null;
  rateLimitTps?: number | null;
  rateLimitTpm?: number | null;
  rateLimitTph?: number | null;
  rateLimitTpd?: number | null;
  environment?: string;
  isPaid?: boolean;
  tier?: string;
  creditLimitUSD?: number | null;
  rateLimitResetMs?: number | null;
}

/**
 * `routes/keys.ts:346` — patch a key, returning the public projection.
 *
 * ## `undefined` must never reach the SET clause
 *
 * Mongoose strips `undefined` values from an update object, so
 * `$set: { creditLimitUSD: undefined }` is a NO-OP in Mongo. The same statement
 * written naively in Postgres writes NULL and ERASES the field. drizzle's
 * `mapUpdateSet` filters `undefined` for exactly this reason (verified against
 * `drizzle-orm/utils.js`, and pinned by a test here rather than trusted), which
 * is why this takes a `Partial` and passes it through rather than spelling out
 * a coalesce per column. An explicit `null` still writes NULL — that is a
 * caller saying "clear it", which Mongo does too.
 *
 * A patch with no defined keys returns the row unchanged instead of reaching
 * drizzle, which throws `No values to set` on an empty object.
 */
export async function patchKey(db: PgHandle, id: string, patch: ProviderKeyPatch) {
  if (Object.values(patch).every((value) => value === undefined)) {
    return findPublicById(db, id);
  }
  const [row] = await db
    .update(providerKeys)
    .set(patch)
    .where(eq(providerKeys.id, id))
    .returning(PUBLIC_COLUMNS);
  return row ?? null;
}

/** `routes/keys.ts:387` — returns the deleted row so the caller can 404 and invalidate its cache. */
export async function deleteKey(db: PgHandle, id: string): Promise<ProviderKeyRow | null> {
  const [row] = await db.delete(providerKeys).where(eq(providerKeys.id, id)).returning();
  return row ?? null;
}

/**
 * `routes/keys.ts:458` — key rotation.
 *
 * One statement rather than the source's four assignments plus `save()`: the
 * digest, the prefix, the secret and the rotation stamp are one fact about one
 * key and there is no state in which some of them should have landed.
 */
export async function rotateKey(
  db: PgHandle,
  id: string,
  newKey: string,
  rotatedAt: Date = new Date(),
): Promise<ProviderKeyRow | null> {
  const [row] = await db
    .update(providerKeys)
    .set({
      keyHash: hashProviderKey(newKey),
      keyPrefix: providerKeyPrefix(newKey),
      key: newKey,
      rotatedAt,
    })
    .where(eq(providerKeys.id, id))
    .returning();
  return row ?? null;
}

/**
 * `routes/keys.ts:48` and `seed-model-configs.ts:279` — clear stale lockouts.
 *
 * ## `modifiedCount` and `rowCount` agree here, and that needed checking
 *
 * Mongo reports `modifiedCount` (documents actually changed); Postgres reports
 * only `rowCount`, which behaves like `matchedCount`. They differ whenever an
 * update writes a value a row already holds. They cannot differ here: the
 * predicate selects rows with a non-null cooldown OR a positive failure count,
 * and the update clears both, so every matched row changes at least one field.
 * Both call sites report the number to an operator, so a silent inflation would
 * have been invisible.
 */
export async function resetCooldowns(db: PgHandle): Promise<number> {
  const result = await db
    .update(providerKeys)
    .set({ cooldownUntil: null, consecutiveFailures: 0 })
    .where(or(isNotNull(providerKeys.cooldownUntil), gt(providerKeys.consecutiveFailures, 0)));
  return result.count;
}

/** `routes/keys.ts:55` — active, non-archived key count for the config hash. */
export async function countActiveKeys(db: PgHandle): Promise<number> {
  const [row] = await db
    .select({ value: count() })
    .from(providerKeys)
    .where(and(eq(providerKeys.isArchived, false), eq(providerKeys.isActive, true)));
  return row.value;
}

/**
 * `key-manager.ts:365` — the highest `currentPriority` within a key's own
 * group, so a failing key can be moved behind every sibling.
 *
 * The source reads it with `findOne(...).sort({ currentPriority: -1 })`, which
 * is `max()`. `currentPriority` is NOT NULL with a default, so there are no
 * nulls to sort to the front — but `max()` ignores them regardless, which is
 * what makes this safe where a bare `order by ... desc limit 1` would not be.
 *
 * `count()` and `max()` over an `int8`-producing expression come back as
 * STRINGS from postgres.js while drizzle types them `number`; `currentPriority`
 * is `double precision`, so `max()` is a float8 and decodes as a real number.
 * The `+ 1` the caller performs is arithmetic, not string concatenation —
 * asserted directly in the tests rather than reasoned about here.
 */
export async function maxPriorityInGroup(
  db: PgHandle,
  provider: string,
  isPaid: boolean,
): Promise<number | null> {
  const [row] = await db
    .select({ value: sql<number | null>`max(${providerKeys.currentPriority})` })
    .from(providerKeys)
    .where(
      and(
        eq(providerKeys.provider, provider),
        eq(providerKeys.isPaid, isPaid),
        eq(providerKeys.isArchived, false),
      ),
    );
  return row?.value ?? null;
}

/**
 * `key-manager.ts:317` — usage counters after a request.
 *
 * The source fires this and forgets it; keeping it a single `UPDATE ... SET
 * x = x + n` also removes the read-modify-write the document method would have
 * had, so two concurrent requests can no longer lose one another's increment.
 * That is an existing invariant (these are accumulating counters) made
 * structural, not a new one.
 */
export async function recordUsage(
  db: PgHandle,
  id: string,
  tokens: number,
  usedAt: Date = new Date(),
): Promise<void> {
  await db
    .update(providerKeys)
    .set({
      lastUsedAt: usedAt,
      totalRequests: sql`${providerKeys.totalRequests} + 1`,
      totalTokens: sql`${providerKeys.totalTokens} + ${tokens}`,
    })
    .where(eq(providerKeys.id, id));
}

/**
 * `provider-key.ts:264` (`key.recordSuccess()`), plus the cooldown clear that
 * `key-manager.ts:336` performs immediately afterwards.
 *
 * The two are merged because they are one event: the source issues a `save()`
 * and then a separate `updateOne` to null the cooldown, and a crash between
 * them leaves a key that succeeded still in cooldown. One statement removes the
 * window, and both writes were already unconditional.
 *
 * Restoring `currentPriority` and reactivating are conditional in the source
 * only so it can log; the writes themselves are idempotent, so the CASE
 * expressions here reproduce them exactly.
 */
export async function recordSuccess(
  db: PgHandle,
  id: string,
  succeededAt: Date = new Date(),
): Promise<ProviderKeyRow | null> {
  const [row] = await db
    .update(providerKeys)
    .set({
      consecutiveFailures: 0,
      successCount: sql`${providerKeys.successCount} + 1`,
      lastSuccessAt: succeededAt,
      currentPriority: sql`${providerKeys.originalPriority}`,
      isActive: sql`case when ${providerKeys.isArchived} then ${providerKeys.isActive} else true end`,
      cooldownUntil: null,
    })
    .where(eq(providerKeys.id, id))
    .returning();
  return row ?? null;
}

/**
 * `provider-key.ts:222` (`key.recordFailure(reason, maxPriority)`).
 *
 * A rate-limit reason is transient — the key works, the quota does not — so it
 * moves the key down the queue and stamps the reason WITHOUT incrementing
 * either failure counter, which is what keeps a busy key from being archived
 * for being busy. The classification is done in JavaScript from the same regex
 * the model uses, because the archive threshold below depends on the
 * POST-increment total and expressing both in SQL would mean writing the
 * predicate twice.
 *
 * Archiving reproduces the source's own wording, including the fact that
 * `archivedReason` quotes the total AFTER the increment.
 */
export async function recordFailure(
  db: PgHandle,
  id: string,
  reason: string,
  maxPriority: number,
  failedAt: Date = new Date(),
): Promise<ProviderKeyRow | null> {
  // `sql.raw` rather than a bound parameter: this is 0 or 1 derived from a
  // boolean, never a caller value, and rendering it as a literal keeps Postgres
  // from having to infer a type for `bigint + $n` in three separate places.
  const increment = sql.raw(RATE_LIMIT_PATTERN.test(reason) ? '0' : '1');
  const newTotalFailures = sql`${providerKeys.totalFailures} + ${increment}`;
  const shouldArchive = sql`${newTotalFailures} >= ${providerKeys.maxTotalFailures}`;

  // `failedAt` is bound as an ISO string with an explicit cast wherever it goes
  // inside a `sql` template. A bare `Date` there has no column to take its
  // encoder from and fails in the DRIVER, before the server sees it. The plain
  // `lastFailureAt: failedAt` below is fine for the opposite reason: drizzle
  // knows the column.
  const [row] = await db
    .update(providerKeys)
    .set({
      consecutiveFailures: sql`${providerKeys.consecutiveFailures} + ${increment}`,
      totalFailures: newTotalFailures,
      lastFailureAt: failedAt,
      lastFailureReason: reason.substring(0, FAILURE_REASON_MAX),
      currentPriority: maxPriority + 1,
      isArchived: sql`case when ${shouldArchive} then true else ${providerKeys.isArchived} end`,
      isActive: sql`case when ${shouldArchive} then false else ${providerKeys.isActive} end`,
      archivedAt: sql`case when ${shouldArchive} then ${failedAt.toISOString()}::timestamptz else ${providerKeys.archivedAt} end`,
      archivedReason: sql`case when ${shouldArchive} then 'Archived after ' || ${newTotalFailures} || ' total failures' else ${providerKeys.archivedReason} end`,
    })
    .where(eq(providerKeys.id, id))
    .returning();
  return row ?? null;
}

/** `key-manager.ts:399` — the exponential/rate-limit cooldown the caller computed. */
export async function setCooldown(
  db: PgHandle,
  id: string,
  cooldownUntil: Date | null,
): Promise<void> {
  await db.update(providerKeys).set({ cooldownUntil }).where(eq(providerKeys.id, id));
}

/** `key-manager.ts:441` — accumulate spend against a key's credit limit. */
export async function recordSpend(db: PgHandle, id: string, costUSD: number): Promise<void> {
  await db
    .update(providerKeys)
    .set({ spentUSD: sql`${providerKeys.spentUSD} + ${costUSD}` })
    .where(eq(providerKeys.id, id));
}

/**
 * `key-manager.ts:456` — mark a key exhausted by setting `spentUSD` to its own
 * limit.
 *
 * The source reads the key, checks `creditLimitUSD != null`, then writes the
 * value it read. Here the limit is read and written in ONE statement, and the
 * `is not null` guard becomes part of the predicate — so a key with no limit is
 * left alone (0 rows) exactly as before, and the value written is guaranteed to
 * be the key's current limit rather than one that may have changed between the
 * two round trips.
 *
 * @returns `true` when a key was marked, `false` when it has no credit limit or
 *   does not exist — the same two outcomes the source's `if` produced.
 */
export async function markCreditExhausted(db: PgHandle, id: string): Promise<boolean> {
  const result = await db
    .update(providerKeys)
    .set({ spentUSD: sql`${providerKeys.creditLimitUSD}` })
    .where(and(eq(providerKeys.id, id), isNotNull(providerKeys.creditLimitUSD)));
  return result.count > 0;
}

/** `lib/broadcast-helpers.ts:20` — the whole public listing, for the websocket fan-out. */
export async function listAllPublic(db: PgHandle) {
  return db
    .select(PUBLIC_COLUMNS)
    .from(providerKeys)
    .orderBy(asc(providerKeys.provider), asc(providerKeys.currentPriority), asc(providerKeys.id));
}

/** `routes/keys.ts:495` — `POST /:keyId/reset-spend`. */
export async function resetSpend(db: PgHandle, id: string) {
  const [row] = await db
    .update(providerKeys)
    .set({ spentUSD: 0 })
    .where(eq(providerKeys.id, id))
    .returning(PUBLIC_COLUMNS);
  return row ?? null;
}

/** `routes/keys.ts:537` and `:579` — `POST /:keyId/deactivate` and `/activate`. */
export async function setActive(db: PgHandle, id: string, isActive: boolean) {
  const [row] = await db
    .update(providerKeys)
    .set({ isActive })
    .where(eq(providerKeys.id, id))
    .returning(PUBLIC_COLUMNS);
  return row ?? null;
}
