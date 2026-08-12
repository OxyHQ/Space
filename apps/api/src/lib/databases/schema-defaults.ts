import { randomUUID } from 'crypto';
import type {
  DatabaseProperty,
  DatabaseSchema,
} from '../../db/schema/databases.js';

/**
 * Build the default property schema used when a Database is created without
 * an explicit one. Mirrors Notion's first-run defaults — a `Name` text
 * property and a `Status` select property.
 *
 * The "Name" property is special: its value is mirrored to the row's
 * `title` field so that:
 *   - the row's page header shows the same string,
 *   - default views surface a recognizable label,
 *   - links to a row render with a useful preview.
 */
export const NAME_PROPERTY_ID = 'name';
export const NAME_PROPERTY_NAME = 'Name';

export function buildDefaultSchema(): DatabaseSchema {
  const statusOptionTodo = randomUUID();
  const statusOptionInProgress = randomUUID();
  const statusOptionDone = randomUUID();

  const properties: DatabaseProperty[] = [
    {
      id: NAME_PROPERTY_ID,
      name: NAME_PROPERTY_NAME,
      type: 'text',
    },
    {
      id: 'status',
      name: 'Status',
      type: 'status',
      config: {
        options: [
          { id: statusOptionTodo, name: 'Not started', color: 'gray' },
          {
            id: statusOptionInProgress,
            name: 'In progress',
            color: 'blue',
          },
          { id: statusOptionDone, name: 'Done', color: 'green' },
        ],
      },
    },
  ];

  return { properties };
}

/**
 * The Name property's id is fixed — `"name"` — so the title <-> Name sync
 * doesn't depend on schema metadata. UI may still rename it; only the
 * `id` is load-bearing.
 */
export function findNameProperty(
  schema: DatabaseSchema,
): DatabaseProperty | null {
  return (
    schema.properties.find((p) => p.id === NAME_PROPERTY_ID) ?? null
  );
}
