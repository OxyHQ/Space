import type {
  DatabaseProperty,
  DatabasePropertyType,
} from '../../models/database.js';
import type { ViewSort } from '../../models/database-view.js';
import { readPropertyValue } from './filters.js';

/**
 * Returns a stable comparator that orders rows according to `sorts`.
 *
 * Ties resolve to the next sort key, and finally to row insertion order
 * (the array index passed by the caller in the closure).
 */
export function compareBySorts(
  sorts: ViewSort[],
  propertyById: Map<string, DatabaseProperty>,
): (
  a: Parameters<typeof readPropertyValue>[0],
  b: Parameters<typeof readPropertyValue>[0],
) => number {
  return (a, b) => {
    for (const sort of sorts) {
      const prop = propertyById.get(sort.propertyId);
      if (!prop) continue;
      const av = readPropertyValue(a, prop);
      const bv = readPropertyValue(b, prop);
      const cmp = compareScalar(av, bv, prop.type);
      if (cmp !== 0) {
        return sort.direction === 'asc' ? cmp : -cmp;
      }
    }
    return 0;
  };
}

function compareScalar(
  a: unknown,
  b: unknown,
  type: DatabasePropertyType,
): number {
  const av = scalarFor(a, type);
  const bv = scalarFor(b, type);
  if (av === null && bv === null) return 0;
  if (av === null) return 1; // nulls sort last on asc
  if (bv === null) return -1;
  if (typeof av === 'number' && typeof bv === 'number') {
    if (av === bv) return 0;
    return av < bv ? -1 : 1;
  }
  const as = String(av);
  const bs = String(bv);
  return as.localeCompare(bs);
}

function scalarFor(
  value: unknown,
  type: DatabasePropertyType,
): string | number | null {
  if (value === null || value === undefined) return null;
  if (typeof value !== 'object') return null;
  const v = value as Record<string, unknown>;
  switch (type) {
    case 'text':
    case 'url':
    case 'email':
    case 'phone':
      return (v.text as string | undefined) ?? (v.value as string | undefined) ?? null;
    case 'number':
      return typeof v.number === 'number' ? v.number : null;
    case 'select':
    case 'status':
      return typeof v.optionId === 'string' ? v.optionId : null;
    case 'multi_select': {
      const arr = v.optionIds as string[] | undefined;
      return arr && arr.length > 0 ? arr.join(',') : null;
    }
    case 'date':
    case 'created_time':
    case 'last_edited_time': {
      const start = v.start as string | null | undefined;
      return start ? new Date(start).getTime() : null;
    }
    case 'person':
    case 'created_by':
    case 'last_edited_by': {
      const arr = v.userIds as string[] | undefined;
      return arr && arr.length > 0 ? arr.join(',') : null;
    }
    case 'checkbox':
      return v.checked ? 1 : 0;
    case 'files': {
      const files = v.files as Array<{ name: string }> | undefined;
      return files && files.length > 0 ? files[0].name : null;
    }
    case 'relation': {
      const arr = v.pageIds as string[] | undefined;
      return arr && arr.length > 0 ? arr.join(',') : null;
    }
    default:
      return null;
  }
}
