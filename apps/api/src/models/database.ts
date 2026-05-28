import mongoose, { Schema, Model, type HydratedDocument } from 'mongoose';

/**
 * Database — a Notion-style database. Lives in a workspace and owns a schema
 * of typed properties plus many rows (each row is itself a Page with
 * `databaseId` set — see `apps/api/src/models/page.ts`).
 *
 * A database can be:
 *   - "Full page": top-level entity in the workspace, visited at `/db/:id`.
 *   - "Inline": rendered as a block inside a parent page (`parentPageId`
 *     points to the host page; `isInline` is true).
 *
 * Soft-delete via `archived`.
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

export const DATABASE_PROPERTY_TYPES: readonly DatabasePropertyType[] = [
  'text',
  'number',
  'select',
  'multi_select',
  'status',
  'date',
  'person',
  'files',
  'checkbox',
  'url',
  'email',
  'phone',
  'relation',
  'rollup',
  'created_time',
  'last_edited_time',
  'created_by',
  'last_edited_by',
  'formula',
] as const;

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
] as const;

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
  // select / multi_select / status
  options?: SelectOption[];
  // number
  format?: NumberFormat;
  precision?: number;
  // date
  includeTime?: boolean;
  // relation
  targetDatabaseId?: string;
  twoWay?: boolean;
  // rollup
  relationPropertyId?: string;
  targetPropertyId?: string;
  function?: 'count' | 'sum' | 'avg' | 'min' | 'max' | 'earliest' | 'latest';
  // formula
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

/**
 * Plain shape of a Database document. The user-facing API exposes the
 * property schema as `schema`, but internally we store it as
 * `propertiesSchema` to avoid colliding with `mongoose.Document.schema`
 * (which is the Mongoose Schema for the collection).
 */
export interface IDatabase {
  _id: mongoose.Types.ObjectId;
  workspaceId: mongoose.Types.ObjectId;
  name: string;
  icon: string | null;
  cover: string | null;
  ownerId: string;
  propertiesSchema: DatabaseSchema;
  isInline: boolean;
  parentPageId: mongoose.Types.ObjectId | null;
  archived: boolean;
  createdAt: Date;
  updatedAt: Date;
}

export type DatabaseDocument = HydratedDocument<IDatabase>;

const DatabasePropertySchema = new Schema<DatabaseProperty>(
  {
    id: { type: String, required: true },
    name: { type: String, required: true },
    type: {
      type: String,
      enum: DATABASE_PROPERTY_TYPES,
      required: true,
    },
    config: { type: Schema.Types.Mixed, default: undefined },
  },
  { _id: false },
);

const DatabaseSchemaShape = new Schema<DatabaseSchema>(
  {
    properties: { type: [DatabasePropertySchema], default: () => [] },
  },
  { _id: false },
);

const DatabaseSchemaDef = new Schema<IDatabase>(
  {
    workspaceId: {
      type: Schema.Types.ObjectId,
      ref: 'Workspace',
      required: true,
      index: true,
    },
    name: { type: String, default: '' },
    icon: { type: String, default: null },
    cover: { type: String, default: null },
    ownerId: { type: String, required: true },
    propertiesSchema: {
      type: DatabaseSchemaShape,
      required: true,
      default: () => ({ properties: [] }),
    },
    isInline: { type: Boolean, default: false },
    parentPageId: {
      type: Schema.Types.ObjectId,
      ref: 'Page',
      default: null,
    },
    archived: { type: Boolean, default: false },
  },
  { timestamps: true },
);

DatabaseSchemaDef.index({ workspaceId: 1, archived: 1 });
DatabaseSchemaDef.index({ parentPageId: 1 });

export const Database: Model<IDatabase> =
  mongoose.models.Database ||
  mongoose.model<IDatabase>('Database', DatabaseSchemaDef);

export default Database;
