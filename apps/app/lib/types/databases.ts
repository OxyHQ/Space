/**
 * Shared types for Databases (Phase 4).
 *
 * Mirrors the backend contract:
 *   - apps/api/src/models/database.ts
 *   - apps/api/src/models/database-view.ts
 *   - apps/api/src/routes/databases.ts
 *
 * Property `value` shapes are validated at write time on the server. The
 * frontend uses these as a TypeScript-only assertion of the payload it
 * sends — the wire shape stays JSON-clean.
 */

export type DatabasePropertyType =
  | 'text'
  | 'number'
  | 'select'
  | 'multi_select'
  | 'status'
  | 'date'
  | 'person'
  | 'files'
  | 'checkbox'
  | 'url'
  | 'email'
  | 'phone'
  | 'relation'
  | 'rollup'
  | 'created_time'
  | 'last_edited_time'
  | 'created_by'
  | 'last_edited_by'
  | 'formula';

export type SelectColor =
  | 'default'
  | 'gray'
  | 'brown'
  | 'orange'
  | 'yellow'
  | 'green'
  | 'blue'
  | 'purple'
  | 'pink'
  | 'red';

export const SELECT_COLORS: readonly SelectColor[] = [
  'default',
  'gray',
  'brown',
  'orange',
  'yellow',
  'green',
  'blue',
  'purple',
  'pink',
  'red',
];

export interface SelectOption {
  id: string;
  name: string;
  color: SelectColor;
}

export type NumberFormat =
  | 'number'
  | 'percent'
  | 'currency:USD'
  | 'currency:EUR'
  | 'currency:GBP'
  | 'currency:JPY';

export interface PropertyConfig {
  options?: SelectOption[];
  format?: NumberFormat;
  precision?: number;
  includeTime?: boolean;
  targetDatabaseId?: string;
  twoWay?: boolean;
  relationPropertyId?: string;
  targetPropertyId?: string;
  function?:
    | 'count'
    | 'sum'
    | 'avg'
    | 'min'
    | 'max'
    | 'earliest'
    | 'latest';
  expression?: string;
}

export interface DatabaseProperty {
  id: string;
  name: string;
  type: DatabasePropertyType;
  config?: PropertyConfig;
}

export interface DatabaseSchema {
  properties: DatabaseProperty[];
}

export interface Database {
  id: string;
  workspaceId: string;
  name: string;
  icon: string | null;
  cover: string | null;
  ownerId: string;
  schema: DatabaseSchema;
  isInline: boolean;
  parentPageId: string | null;
  archived: boolean;
  createdAt: string;
  updatedAt: string;
}

export type DatabaseViewType =
  | 'table'
  | 'board'
  | 'gallery'
  | 'list'
  | 'calendar'
  | 'timeline';

export type SortDirection = 'asc' | 'desc';

export interface ViewSort {
  propertyId: string;
  direction: SortDirection;
}

export interface FilterCondition {
  kind: 'condition';
  propertyId: string;
  operator: string;
  value?: unknown;
}

export interface FilterGroup {
  kind: 'group';
  combinator: 'and' | 'or';
  filters: Filter[];
}

export type Filter = FilterCondition | FilterGroup;

export interface ViewConfig {
  datePropertyId?: string;
  startPropertyId?: string;
  endPropertyId?: string;
  coverSource?: 'property' | 'pageCover';
  coverPropertyId?: string;
  fit?: 'cover' | 'contain';
}

export interface DatabaseView {
  id: string;
  databaseId: string;
  name: string;
  type: DatabaseViewType;
  isDefault: boolean;
  filters: FilterGroup;
  sorts: ViewSort[];
  groupBy: { propertyId: string } | null;
  hiddenProperties: string[];
  frozenProperties: string[];
  pageSize: number;
  config: ViewConfig;
  order: number;
  createdAt: string;
  updatedAt: string;
}

/**
 * Stored property value shapes — what the backend sends back and accepts
 * on write.
 */
export interface TextValue {
  text: string;
}
export interface NumberValue {
  number: number | null;
}
export interface SelectValue {
  optionId: string | null;
}
export interface MultiSelectValue {
  optionIds: string[];
}
export interface DateValue {
  start: string | null;
  end?: string | null;
  includeTime?: boolean;
}
export interface PersonValue {
  userIds: string[];
}
export interface FilesValue {
  files: { name: string; url: string }[];
}
export interface CheckboxValue {
  checked: boolean;
}
export interface ScalarStringValue {
  value: string;
}
export interface RelationValue {
  pageIds: string[];
}

export type PropertyValue =
  | TextValue
  | NumberValue
  | SelectValue
  | MultiSelectValue
  | DateValue
  | PersonValue
  | FilesValue
  | CheckboxValue
  | ScalarStringValue
  | RelationValue
  | null;

export interface DatabaseRow {
  id: string;
  _id: string;
  workspaceId: string;
  parentId: string | null;
  databaseId: string | null;
  title: string;
  icon: string | null;
  cover: string | null;
  ownerId: string;
  archived: boolean;
  order: number;
  properties: Record<string, PropertyValue>;
  createdAt: string;
  updatedAt: string;
}

export interface DatabasesListResponse {
  databases: Database[];
}

export interface DatabaseResponse {
  database: Database;
  views?: DatabaseView[];
}

export interface DatabaseRowsResponse {
  rows: DatabaseRow[];
  total: number;
  cursor: string | null;
  view: DatabaseView | null;
}

export interface DatabaseRowResponse {
  row: DatabaseRow;
}

export interface DatabaseViewsResponse {
  views: DatabaseView[];
}

export interface DatabaseViewResponse {
  view: DatabaseView;
}
