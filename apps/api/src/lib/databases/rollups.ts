import type { PgHandle } from '../../db/client.js';
import type { DatabaseProperty } from '../../db/schema/databases.js';
import type { PageProperties } from '../../db/schema/pages.js';
import { findDatabaseById } from '../../repositories/databases.js';
import { findPagesByIds } from '../../repositories/pages.js';

/**
 * Resolve a rollup property's value against a single source row.
 *
 * MVP behaviour:
 *   - one-way relations only (we do not propagate two-way back-refs yet)
 *   - functions: count | sum | avg | min | max | earliest | latest
 *   - target property must be a number (for sum/avg/min/max) or a date
 *     (for earliest/latest); other shapes return `null`.
 *
 * Returns `null` if the rollup can't be resolved (missing config, missing
 * target db, etc.) so the UI can render an em-dash placeholder.
 *
 * This module is NOT one of the pure `lib/databases/*` evaluators: it reads
 * the related rows and their database, so it takes a handle like any
 * repository caller.
 */
export async function resolveRollup(
  handle: PgHandle,
  rollupProperty: DatabaseProperty,
  row: { properties: PageProperties },
): Promise<number | string | null> {
  const config = rollupProperty.config;
  if (!config?.relationPropertyId || !config.function || !config.targetPropertyId) {
    return null;
  }

  const relationValue = row.properties[config.relationPropertyId] ?? null;
  if (!relationValue || typeof relationValue !== 'object') return null;
  const pageIds = (relationValue as { pageIds?: unknown }).pageIds;
  if (!Array.isArray(pageIds) || pageIds.length === 0) {
    return config.function === 'count' ? 0 : null;
  }

  if (config.function === 'count') return pageIds.length;

  /**
   * The 24-hex filter this used to apply is GONE, and its removal is the
   * point rather than tidying.
   *
   * It existed to keep a malformed string out of `new ObjectId(...)`, which
   * throws. There is no cast here — the ids are `text` — and a uuid v7 does
   * not match `/^[0-9a-fA-F]{24}$/`, so keeping the filter would have emptied
   * this list for every row created after the cutover and returned `null` for
   * every numeric rollup. Silently, and looking exactly like a rollup whose
   * targets happen to hold no numbers.
   *
   * An id that names nothing now costs one row fewer in the result instead of
   * an exception, which is the answer the query gives for free.
   */
  const ids = pageIds.filter((id): id is string => typeof id === 'string');
  if (ids.length === 0) return null;

  const relatedRows = await findPagesByIds(handle, ids, { archived: false });
  if (relatedRows.length === 0) return null;

  const targetDbId = relatedRows[0]?.databaseId;
  if (!targetDbId) return null;
  const targetDb = await findDatabaseById(handle, targetDbId);
  if (!targetDb) return null;
  const targetProp = targetDb.propertiesSchema.properties.find(
    (p) => p.id === config.targetPropertyId,
  );
  if (!targetProp) return null;

  const numbers: number[] = [];
  const dates: number[] = [];
  for (const r of relatedRows) {
    const value = r.properties[targetProp.id] ?? null;
    if (!value || typeof value !== 'object') continue;
    const obj = value as Record<string, unknown>;
    if (typeof obj.number === 'number' && Number.isFinite(obj.number)) {
      numbers.push(obj.number);
    }
    if (typeof obj.start === 'string') {
      const t = Date.parse(obj.start);
      if (Number.isFinite(t)) dates.push(t);
    }
  }

  switch (config.function) {
    case 'sum':
      return numbers.reduce((acc, n) => acc + n, 0);
    case 'avg':
      return numbers.length > 0
        ? numbers.reduce((acc, n) => acc + n, 0) / numbers.length
        : null;
    case 'min':
      return numbers.length > 0 ? Math.min(...numbers) : null;
    case 'max':
      return numbers.length > 0 ? Math.max(...numbers) : null;
    case 'earliest':
      return dates.length > 0 ? new Date(Math.min(...dates)).toISOString() : null;
    case 'latest':
      return dates.length > 0 ? new Date(Math.max(...dates)).toISOString() : null;
    default:
      return null;
  }
}
