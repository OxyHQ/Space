import mongoose, { Schema, Model, Document } from 'mongoose';

/**
 * DatabaseView — a saved presentation of a Database's rows.
 *
 * Each Database has one or more views. Views never change the data — they
 * only change what the user sees: filters narrow the row set, sorts reorder
 * it, groupBy partitions it (for board view), hiddenProperties / frozenProperties
 * affect table column UX.
 *
 * MVP view types: table | board | gallery | list | calendar | timeline.
 */
export type DatabaseViewType =
  | 'table'
  | 'board'
  | 'gallery'
  | 'list'
  | 'calendar'
  | 'timeline';

export const DATABASE_VIEW_TYPES: readonly DatabaseViewType[] = [
  'table',
  'board',
  'gallery',
  'list',
  'calendar',
  'timeline',
] as const;

export type SortDirection = 'asc' | 'desc';

export interface ViewSort {
  propertyId: string;
  direction: SortDirection;
}

/**
 * Filter trees mix two node kinds:
 *  - `condition`: leaf — applies an `operator` to `propertyId` against `value`.
 *  - `group`: branch — combines child filters via AND/OR.
 *
 * Persisted as plain JSON; validation happens at the route boundary
 * (apps/api/src/lib/databases/filters.ts).
 */
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

/**
 * View-type-specific config. Open shape — only the fields relevant to the
 * view type are read. Documented options:
 *   - calendar: { datePropertyId: string }
 *   - timeline: { startPropertyId: string, endPropertyId?: string }
 *   - gallery:  { coverSource: 'property' | 'pageCover'; coverPropertyId?: string; fit?: 'cover' | 'contain' }
 *   - board:    grouping is via top-level `groupBy`; no extra fields needed.
 */
export interface ViewConfig {
  datePropertyId?: string;
  startPropertyId?: string;
  endPropertyId?: string;
  coverSource?: 'property' | 'pageCover';
  coverPropertyId?: string;
  fit?: 'cover' | 'contain';
}

export interface IDatabaseView extends Document {
  databaseId: mongoose.Types.ObjectId;
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
  createdAt: Date;
  updatedAt: Date;
}

const ViewSortSchema = new Schema<ViewSort>(
  {
    propertyId: { type: String, required: true },
    direction: { type: String, enum: ['asc', 'desc'], required: true },
  },
  { _id: false },
);

const DatabaseViewSchemaDef = new Schema<IDatabaseView>(
  {
    databaseId: {
      type: Schema.Types.ObjectId,
      ref: 'Database',
      required: true,
      index: true,
    },
    name: { type: String, default: '' },
    type: {
      type: String,
      enum: DATABASE_VIEW_TYPES,
      required: true,
      default: 'table',
    },
    isDefault: { type: Boolean, default: false },
    filters: {
      type: Schema.Types.Mixed,
      default: (): FilterGroup => ({
        kind: 'group',
        combinator: 'and',
        filters: [],
      }),
    },
    sorts: { type: [ViewSortSchema], default: () => [] },
    groupBy: {
      type: Schema.Types.Mixed,
      default: null,
    },
    hiddenProperties: { type: [String], default: () => [] },
    frozenProperties: { type: [String], default: () => [] },
    pageSize: { type: Number, default: 50 },
    config: {
      type: Schema.Types.Mixed,
      default: (): ViewConfig => ({}),
    },
    order: { type: Number, default: 0 },
  },
  { timestamps: true },
);

DatabaseViewSchemaDef.index({ databaseId: 1, order: 1 });

export const DatabaseView: Model<IDatabaseView> =
  mongoose.models.DatabaseView ||
  mongoose.model<IDatabaseView>('DatabaseView', DatabaseViewSchemaDef);

export default DatabaseView;
