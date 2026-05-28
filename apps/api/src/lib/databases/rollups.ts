import mongoose from 'mongoose';
import { Page } from '../../models/page.js';
import type {
  DatabaseProperty,
  DatabaseSchema,
} from '../../models/database.js';
import { Database } from '../../models/database.js';

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
 */
export async function resolveRollup(
  rollupProperty: DatabaseProperty,
  row: { properties: Map<string, unknown> | Record<string, unknown> | undefined },
): Promise<number | string | null> {
  const config = rollupProperty.config;
  if (!config?.relationPropertyId || !config.function || !config.targetPropertyId) {
    return null;
  }

  const relationValue = readValue(row.properties, config.relationPropertyId);
  if (!relationValue || typeof relationValue !== 'object') return null;
  const pageIds = (relationValue as { pageIds?: unknown }).pageIds;
  if (!Array.isArray(pageIds) || pageIds.length === 0) {
    return config.function === 'count' ? 0 : null;
  }

  if (config.function === 'count') return pageIds.length;

  const ids = pageIds
    .filter((id): id is string => typeof id === 'string')
    .filter((id) => /^[0-9a-fA-F]{24}$/u.test(id))
    .map((id) => new mongoose.Types.ObjectId(id));
  if (ids.length === 0) return null;

  const relatedRows = await Page.find({
    _id: { $in: ids },
    archived: false,
  })
    .select('databaseId properties title createdAt updatedAt ownerId')
    .lean();
  if (relatedRows.length === 0) return null;

  const targetDbId = relatedRows[0]?.databaseId;
  if (!targetDbId) return null;
  const targetDb = await Database.findById(targetDbId).lean<{
    propertiesSchema: DatabaseSchema;
  } | null>();
  if (!targetDb) return null;
  const targetProp = targetDb.propertiesSchema.properties.find(
    (p) => p.id === config.targetPropertyId,
  );
  if (!targetProp) return null;

  const numbers: number[] = [];
  const dates: number[] = [];
  for (const r of relatedRows) {
    const props = r.properties as
      | Map<string, unknown>
      | Record<string, unknown>
      | undefined;
    const value = readValue(props, targetProp.id);
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

function readValue(
  properties: Map<string, unknown> | Record<string, unknown> | undefined,
  key: string,
): unknown {
  if (!properties) return null;
  if (properties instanceof Map) return properties.get(key) ?? null;
  return (properties as Record<string, unknown>)[key] ?? null;
}
