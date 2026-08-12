/**
 * Developer apps and their API keys.
 *
 * ## THESE TABLES HAVE NO CALLERS, AND THAT IS A FINDING, NOT A GAP
 *
 * `models/developer-app.ts` and `models/developer-api-key.ts` are imported by
 * nothing. Grepping the symbols `DeveloperApp` and `DeveloperApiKey` across
 * `src/` names only the two model files themselves — no route, no middleware,
 * no service. They are the residue of the legacy Clarity developer portal that
 * was stripped with the chat UI.
 *
 * Two consequences for anyone reading this file:
 *
 *  - **Every function below is derived from the MODEL's declared indexes and
 *    fields, not from an observed query.** There is no call site to be
 *    faithful to. Where the Mongo original would settle a question — which
 *    sort, which filter, what a missing row means — the answer here is a
 *    reasonable default, not a ported behaviour.
 *  - **`api_key_usage.apiKeyId` and `.appId` are always NULL** in the running
 *    system for the same reason: `recordUsage`
 *    (`middleware/api-key-rate-limit.ts:240`) builds its record without either
 *    field. Any analytics grouped by app or key returns nothing, and always
 *    has.
 *
 * `validateKey` and the `generateKey`/`hashKey` statics are NOT ported. They
 * are `crypto` operations on a value the caller already holds
 * (`sha256(key) === keyHash`) and involve no storage; re-expressing them as a
 * database round trip would be strictly worse. {@link findDeveloperApiKeyByHash}
 * is the storage half — the caller hashes, then looks up.
 */

import { and, desc, eq } from 'drizzle-orm';
import type { StationDatabase } from '../db/client.js';
import { developerApiKeys, developerApps } from '../db/schema/billing.js';

export type DeveloperAppRow = typeof developerApps.$inferSelect;
export type DeveloperApiKeyRow = typeof developerApiKeys.$inferSelect;

export async function createDeveloperApp(
  db: StationDatabase,
  values: typeof developerApps.$inferInsert,
): Promise<DeveloperAppRow> {
  const rows = await db.insert(developerApps).values(values).returning();
  if (!rows[0]) throw new Error('developer_apps insert returned no row');
  return rows[0];
}

export async function findDeveloperAppById(
  db: StationDatabase,
  id: string,
): Promise<DeveloperAppRow | null> {
  const rows = await db.select().from(developerApps).where(eq(developerApps.id, id)).limit(1);
  return rows[0] ?? null;
}

/** Backs the model's `{ oxyUserId: 1, isActive: 1 }` compound index. */
export async function listDeveloperAppsByUser(
  db: StationDatabase,
  oxyUserId: string,
  options: { activeOnly?: boolean } = {},
): Promise<DeveloperAppRow[]> {
  const clauses = [eq(developerApps.oxyUserId, oxyUserId)];
  if (options.activeOnly) clauses.push(eq(developerApps.isActive, true));
  return db
    .select()
    .from(developerApps)
    .where(and(...clauses))
    .orderBy(desc(developerApps.createdAt), desc(developerApps.id));
}

/**
 * Deactivation rather than deletion: `isActive` exists precisely so an app can
 * stop working without its usage history losing the row it points at.
 */
export async function setDeveloperAppActive(
  db: StationDatabase,
  id: string,
  isActive: boolean,
): Promise<DeveloperAppRow | null> {
  const rows = await db
    .update(developerApps)
    .set({ isActive })
    .where(eq(developerApps.id, id))
    .returning();
  return rows[0] ?? null;
}

export async function createDeveloperApiKey(
  db: StationDatabase,
  values: typeof developerApiKeys.$inferInsert,
): Promise<DeveloperApiKeyRow> {
  const rows = await db.insert(developerApiKeys).values(values).returning();
  if (!rows[0]) throw new Error('developer_api_keys insert returned no row');
  return rows[0];
}

/**
 * The authentication lookup the `unique: true` on `keyHash` exists for.
 *
 * The hash is a plain equality match on a deterministic sha256, which is what
 * makes the lookup possible at all — a randomised-IV encryption of the same
 * column would never match and every request would 404.
 */
export async function findDeveloperApiKeyByHash(
  db: StationDatabase,
  keyHash: string,
): Promise<DeveloperApiKeyRow | null> {
  const rows = await db
    .select()
    .from(developerApiKeys)
    .where(eq(developerApiKeys.keyHash, keyHash))
    .limit(1);
  return rows[0] ?? null;
}

export async function listDeveloperApiKeysByApp(
  db: StationDatabase,
  appId: string,
  options: { activeOnly?: boolean } = {},
): Promise<DeveloperApiKeyRow[]> {
  const clauses = [eq(developerApiKeys.appId, appId)];
  if (options.activeOnly) clauses.push(eq(developerApiKeys.isActive, true));
  return db
    .select()
    .from(developerApiKeys)
    .where(and(...clauses))
    .orderBy(desc(developerApiKeys.createdAt), desc(developerApiKeys.id));
}

export async function listDeveloperApiKeysByUser(
  db: StationDatabase,
  oxyUserId: string,
  options: { activeOnly?: boolean } = {},
): Promise<DeveloperApiKeyRow[]> {
  const clauses = [eq(developerApiKeys.oxyUserId, oxyUserId)];
  if (options.activeOnly) clauses.push(eq(developerApiKeys.isActive, true));
  return db
    .select()
    .from(developerApiKeys)
    .where(and(...clauses))
    .orderBy(desc(developerApiKeys.createdAt), desc(developerApiKeys.id));
}

/** `lastUsedAt` is stamped from the database clock, so instances agree. */
export async function touchDeveloperApiKey(
  db: StationDatabase,
  id: string,
): Promise<DeveloperApiKeyRow | null> {
  const rows = await db
    .update(developerApiKeys)
    .set({ lastUsedAt: new Date() })
    .where(eq(developerApiKeys.id, id))
    .returning();
  return rows[0] ?? null;
}

export async function setDeveloperApiKeyActive(
  db: StationDatabase,
  id: string,
  isActive: boolean,
): Promise<DeveloperApiKeyRow | null> {
  const rows = await db
    .update(developerApiKeys)
    .set({ isActive })
    .where(eq(developerApiKeys.id, id))
    .returning();
  return rows[0] ?? null;
}
