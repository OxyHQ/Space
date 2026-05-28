import { Router } from 'express';
import type { NextFunction, Request, Response } from 'express';
import mongoose from 'mongoose';
import { randomUUID } from 'crypto';
import { z } from 'zod';
import {
  Database,
  DATABASE_PROPERTY_TYPES,
  SELECT_COLORS,
  type DatabaseProperty,
  type DatabasePropertyType,
  type DatabaseSchema,
  type IDatabase,
  type PropertyConfig,
  type SelectOption,
} from '../models/database.js';
import {
  DatabaseView,
  DATABASE_VIEW_TYPES,
  type DatabaseViewType,
  type Filter,
  type FilterGroup,
  type IDatabaseView,
  type ViewConfig,
  type ViewSort,
} from '../models/database-view.js';
import { Page, type IPage } from '../models/page.js';
import { Block } from '../models/block.js';
import { authenticateToken } from '../middleware/auth.js';
import { requireWorkspaceMember } from '../middleware/workspace.js';
import { log } from '../lib/logger.js';
import {
  buildDefaultSchema,
  NAME_PROPERTY_ID,
} from '../lib/databases/schema-defaults.js';
import {
  parsePropertyValue,
  serializeParsedValue,
} from '../lib/databases/property-values.js';
import {
  evaluateFilter,
  filterGroupSchema,
} from '../lib/databases/filters.js';
import { compareBySorts } from '../lib/databases/sorts.js';
import { evaluateFormulaExpression } from '../lib/databases/formula.js';
import { resolveRollup } from '../lib/databases/rollups.js';

const router = Router();

router.use(authenticateToken);

const objectIdSchema = z
  .string()
  .regex(/^[0-9a-fA-F]{24}$/u, 'Invalid id');

const propertyTypeSchema = z.enum(
  DATABASE_PROPERTY_TYPES as readonly [
    DatabasePropertyType,
    ...DatabasePropertyType[],
  ],
);

const viewTypeSchema = z.enum(
  DATABASE_VIEW_TYPES as readonly [DatabaseViewType, ...DatabaseViewType[]],
);

const selectColorSchema = z.enum(
  SELECT_COLORS as readonly [SelectOption['color'], ...SelectOption['color'][]],
);

const selectOptionSchema = z.object({
  id: z.string().optional(),
  name: z.string().min(1).max(120),
  color: selectColorSchema.optional(),
});

const propertyConfigSchema = z
  .object({
    options: z.array(selectOptionSchema).optional(),
    format: z
      .union([
        z.literal('number'),
        z.literal('percent'),
        z.literal('currency:USD'),
        z.literal('currency:EUR'),
        z.literal('currency:GBP'),
        z.literal('currency:JPY'),
      ])
      .optional(),
    precision: z.number().int().min(0).max(10).optional(),
    includeTime: z.boolean().optional(),
    targetDatabaseId: objectIdSchema.optional(),
    twoWay: z.boolean().optional(),
    relationPropertyId: z.string().optional(),
    targetPropertyId: z.string().optional(),
    function: z
      .enum(['count', 'sum', 'avg', 'min', 'max', 'earliest', 'latest'])
      .optional(),
    expression: z.string().max(2000).optional(),
  })
  .strict();

const propertySchema = z.object({
  id: z.string().min(1).optional(),
  name: z.string().min(1).max(120),
  type: propertyTypeSchema,
  config: propertyConfigSchema.optional(),
});

const databaseSchemaSchema = z.object({
  properties: z.array(propertySchema).min(1),
});

const createDatabaseSchema = z.object({
  workspaceId: objectIdSchema,
  name: z.string().max(2000).optional(),
  icon: z.string().max(200).nullable().optional(),
  cover: z.string().max(2000).nullable().optional(),
  schema: databaseSchemaSchema.optional(),
  isInline: z.boolean().optional(),
  parentPageId: objectIdSchema.nullable().optional(),
});

const updateDatabaseSchema = z
  .object({
    name: z.string().max(2000).optional(),
    icon: z.string().max(200).nullable().optional(),
    cover: z.string().max(2000).nullable().optional(),
    archived: z.boolean().optional(),
  })
  .refine((data) => Object.keys(data).length > 0, {
    message: 'At least one field is required',
  });

const addPropertySchema = propertySchema;

const updatePropertySchema = z
  .object({
    name: z.string().min(1).max(120).optional(),
    type: propertyTypeSchema.optional(),
    config: propertyConfigSchema.optional(),
  })
  .refine((data) => Object.keys(data).length > 0, {
    message: 'At least one field is required',
  });

const createRowSchema = z.object({
  title: z.string().max(2000).optional(),
  properties: z.record(z.unknown()).optional(),
});

const updateViewSchema = z
  .object({
    name: z.string().min(1).max(200).optional(),
    type: viewTypeSchema.optional(),
    isDefault: z.boolean().optional(),
    filters: filterGroupSchema.optional(),
    sorts: z
      .array(
        z.object({
          propertyId: z.string().min(1),
          direction: z.enum(['asc', 'desc']),
        }),
      )
      .optional(),
    groupBy: z
      .union([
        z.object({ propertyId: z.string().min(1) }),
        z.null(),
      ])
      .optional(),
    hiddenProperties: z.array(z.string()).optional(),
    frozenProperties: z.array(z.string()).optional(),
    pageSize: z.number().int().min(1).max(500).optional(),
    config: z
      .object({
        datePropertyId: z.string().optional(),
        startPropertyId: z.string().optional(),
        endPropertyId: z.string().optional(),
        coverSource: z.enum(['property', 'pageCover']).optional(),
        coverPropertyId: z.string().optional(),
        fit: z.enum(['cover', 'contain']).optional(),
      })
      .optional(),
    order: z.number().finite().optional(),
  })
  .refine((data) => Object.keys(data).length > 0, {
    message: 'At least one field is required',
  });

const createViewSchema = z.object({
  name: z.string().min(1).max(200),
  type: viewTypeSchema,
  isDefault: z.boolean().optional(),
  filters: filterGroupSchema.optional(),
  sorts: z
    .array(
      z.object({
        propertyId: z.string().min(1),
        direction: z.enum(['asc', 'desc']),
      }),
    )
    .optional(),
  groupBy: z
    .union([z.object({ propertyId: z.string().min(1) }), z.null()])
    .optional(),
  hiddenProperties: z.array(z.string()).optional(),
  frozenProperties: z.array(z.string()).optional(),
  pageSize: z.number().int().min(1).max(500).optional(),
  config: z
    .object({
      datePropertyId: z.string().optional(),
      startPropertyId: z.string().optional(),
      endPropertyId: z.string().optional(),
      coverSource: z.enum(['property', 'pageCover']).optional(),
      coverPropertyId: z.string().optional(),
      fit: z.enum(['cover', 'contain']).optional(),
    })
    .optional(),
  order: z.number().finite().optional(),
});

const listDatabasesQuerySchema = z.object({
  workspaceId: objectIdSchema,
  includeArchived: z
    .union([z.literal('true'), z.literal('false')])
    .optional()
    .transform((v) => v === 'true'),
});

const listRowsQuerySchema = z.object({
  viewId: objectIdSchema.optional(),
  cursor: z
    .string()
    .regex(/^\d+$/u)
    .optional(),
  pageSize: z
    .string()
    .regex(/^\d+$/u)
    .optional(),
  search: z.string().max(200).optional(),
});

function handleZodError(err: unknown, res: Response): boolean {
  if (err instanceof z.ZodError) {
    res.status(400).json({ error: 'Invalid input', details: err.errors });
    return true;
  }
  return false;
}

function assertWorkspace(req: Request, res: Response): string | null {
  const workspaceId = req.workspace?.id;
  if (!workspaceId) {
    res.status(400).json({ error: 'Workspace context required' });
    return null;
  }
  return workspaceId;
}

async function checkWorkspaceMembership(
  req: Request,
  res: Response,
  workspaceId: mongoose.Types.ObjectId | string,
): Promise<boolean> {
  req.headers['x-workspace-id'] = String(workspaceId);
  const passed = await new Promise<boolean>((resolve) => {
    const next: NextFunction = (err?: unknown) => {
      if (err) {
        log.general.error({ err }, 'Workspace membership middleware errored');
        if (!res.headersSent) {
          res.status(500).json({ error: 'Workspace membership check failed' });
        }
        resolve(false);
        return;
      }
      resolve(true);
    };
    requireWorkspaceMember(req, res, next);
  });
  if (!passed) return false;
  return !res.headersSent;
}

type SerializableDatabase = Pick<
  IDatabase,
  | '_id'
  | 'workspaceId'
  | 'name'
  | 'icon'
  | 'cover'
  | 'ownerId'
  | 'propertiesSchema'
  | 'isInline'
  | 'parentPageId'
  | 'archived'
  | 'createdAt'
  | 'updatedAt'
>;

/**
 * Wire format exposes the property schema as `schema` (mirrors the design
 * doc), even though the stored field name is `propertiesSchema`.
 */
function serializeDatabase(db: SerializableDatabase) {
  return {
    id: String(db._id),
    workspaceId: String(db.workspaceId),
    name: db.name,
    icon: db.icon,
    cover: db.cover,
    ownerId: db.ownerId,
    schema: db.propertiesSchema,
    isInline: db.isInline,
    parentPageId: db.parentPageId ? String(db.parentPageId) : null,
    archived: db.archived,
    createdAt: db.createdAt,
    updatedAt: db.updatedAt,
  };
}

type SerializableView = Pick<
  IDatabaseView,
  | '_id'
  | 'databaseId'
  | 'name'
  | 'type'
  | 'isDefault'
  | 'filters'
  | 'sorts'
  | 'groupBy'
  | 'hiddenProperties'
  | 'frozenProperties'
  | 'pageSize'
  | 'config'
  | 'order'
  | 'createdAt'
  | 'updatedAt'
>;

function serializeView(view: SerializableView) {
  return {
    id: String(view._id),
    databaseId: String(view.databaseId),
    name: view.name,
    type: view.type,
    isDefault: view.isDefault,
    filters: view.filters,
    sorts: view.sorts,
    groupBy: view.groupBy,
    hiddenProperties: view.hiddenProperties,
    frozenProperties: view.frozenProperties,
    pageSize: view.pageSize,
    config: view.config,
    order: view.order,
    createdAt: view.createdAt,
    updatedAt: view.updatedAt,
  };
}

type SerializableRow = Pick<
  IPage,
  | '_id'
  | 'workspaceId'
  | 'parentId'
  | 'title'
  | 'icon'
  | 'cover'
  | 'ownerId'
  | 'archived'
  | 'order'
  | 'databaseId'
  | 'createdAt'
  | 'updatedAt'
> & {
  properties: Map<string, unknown> | Record<string, unknown> | undefined;
};

interface RowSerializationOpts {
  derived: Record<string, unknown>;
}

function serializeRow(row: SerializableRow, opts?: RowSerializationOpts) {
  const properties: Record<string, unknown> = {};
  if (row.properties) {
    if (row.properties instanceof Map) {
      for (const [key, value] of row.properties.entries()) {
        properties[key] = value;
      }
    } else {
      Object.assign(properties, row.properties as Record<string, unknown>);
    }
  }
  if (opts) Object.assign(properties, opts.derived);

  return {
    id: String(row._id),
    _id: String(row._id),
    workspaceId: String(row.workspaceId),
    parentId: row.parentId ? String(row.parentId) : null,
    databaseId: row.databaseId ? String(row.databaseId) : null,
    title: row.title,
    icon: row.icon,
    cover: row.cover,
    ownerId: row.ownerId,
    archived: row.archived,
    order: row.order,
    properties,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

/**
 * Normalize incoming property values for create/update. Returns a
 * key->stored-shape map. Throws ZodError for invalid shapes.
 *
 * Drops keys that:
 *   - reference an unknown property id
 *   - reference a server-derived property (rollup, formula, created_time,
 *     created_by, last_edited_time, last_edited_by)
 */
function normalizeIncomingProperties(
  schema: DatabaseSchema,
  incoming: Record<string, unknown>,
): { stored: Record<string, unknown>; nameFromProperty: string | null } {
  const byId = new Map<string, DatabaseProperty>();
  for (const prop of schema.properties) byId.set(prop.id, prop);

  const stored: Record<string, unknown> = {};
  let nameFromProperty: string | null = null;

  for (const [key, raw] of Object.entries(incoming)) {
    const prop = byId.get(key);
    if (!prop) continue;
    const parsed = parsePropertyValue(prop.type, raw);
    if (!parsed) continue;
    const serialized = serializeParsedValue(parsed);
    stored[key] = serialized;
    if (key === NAME_PROPERTY_ID && parsed.kind === 'text') {
      nameFromProperty = parsed.text;
    }
  }

  return { stored, nameFromProperty };
}

/**
 * Resolve server-derived properties (rollup, formula, created_time, etc.)
 * for a row at read time. Returns a plain key->value map keyed by
 * propertyId. The caller merges this into the row payload sent to the
 * client.
 */
async function resolveDerivedProperties(
  row: SerializableRow,
  schema: DatabaseSchema,
): Promise<Record<string, unknown>> {
  const out: Record<string, unknown> = {};
  for (const prop of schema.properties) {
    switch (prop.type) {
      case 'created_time':
        out[prop.id] = {
          start: row.createdAt ? new Date(row.createdAt).toISOString() : null,
        };
        break;
      case 'last_edited_time':
        out[prop.id] = {
          start: row.updatedAt ? new Date(row.updatedAt).toISOString() : null,
        };
        break;
      case 'created_by':
        out[prop.id] = { userIds: row.ownerId ? [row.ownerId] : [] };
        break;
      case 'last_edited_by':
        // No separate "last editor" tracking yet — fall back to owner.
        out[prop.id] = { userIds: row.ownerId ? [row.ownerId] : [] };
        break;
      case 'formula': {
        const expr = prop.config?.expression ?? '';
        const value = evaluateFormulaExpression(expr);
        out[prop.id] =
          typeof value === 'number'
            ? { number: value }
            : typeof value === 'string'
              ? { text: value }
              : { text: '' };
        break;
      }
      case 'rollup': {
        const value = await resolveRollup(prop, row);
        out[prop.id] =
          value === null
            ? { text: '' }
            : typeof value === 'number'
              ? { number: value }
              : { text: value };
        break;
      }
      default:
        break;
    }
  }
  return out;
}

/**
 * Build a brand-new database with sensible defaults: validated schema,
 * one default table view, and (if no schema provided) Notion-style
 * Name + Status properties.
 */
async function createDefaultViewForDatabase(
  databaseId: mongoose.Types.ObjectId,
): Promise<void> {
  const defaultFilter: FilterGroup = {
    kind: 'group',
    combinator: 'and',
    filters: [],
  };
  const defaultConfig: ViewConfig = {};
  await DatabaseView.create({
    databaseId,
    name: 'All',
    type: 'table',
    isDefault: true,
    filters: defaultFilter,
    sorts: [],
    groupBy: null,
    hiddenProperties: [],
    frozenProperties: [],
    pageSize: 50,
    config: defaultConfig,
    order: 0,
  });
}

/**
 * Ensure every property has a stable id and option ids. Used at schema
 * creation / property-add time. Mutates and returns the input.
 */
function normalizeSchema(schema: DatabaseSchema): DatabaseSchema {
  const seenIds = new Set<string>();
  for (const prop of schema.properties) {
    if (!prop.id || seenIds.has(prop.id)) {
      prop.id = randomUUID();
    }
    seenIds.add(prop.id);
    if (prop.config?.options) {
      prop.config.options = prop.config.options.map((opt) => ({
        id: opt.id ?? randomUUID(),
        name: opt.name,
        color: opt.color ?? 'default',
      }));
    }
  }
  return schema;
}

// ---------------------------------------------------------------------------
// Database CRUD
// ---------------------------------------------------------------------------

/**
 * GET /databases?workspaceId=...
 */
router.get('/', requireWorkspaceMember, async (req: Request, res: Response) => {
  try {
    const query = listDatabasesQuerySchema.parse(req.query);
    const workspaceId = assertWorkspace(req, res);
    if (!workspaceId) return;
    if (query.workspaceId !== workspaceId) {
      res.status(403).json({ error: 'Workspace mismatch' });
      return;
    }

    const filter: Record<string, unknown> = {
      workspaceId: new mongoose.Types.ObjectId(workspaceId),
    };
    if (!query.includeArchived) filter.archived = false;

    const databases = await Database.find(filter)
      .sort({ updatedAt: -1 })
      .lean<SerializableDatabase[]>();

    res.json({ databases: databases.map((d) => serializeDatabase(d)) });
  } catch (error: unknown) {
    if (handleZodError(error, res)) return;
    log.general.error({ err: error }, 'Failed to list databases');
    res.status(500).json({ error: 'Failed to list databases' });
  }
});

/**
 * GET /databases/:id
 * Returns the database + its views (default and saved).
 */
router.get('/:id', async (req: Request, res: Response) => {
  try {
    const params = z.object({ id: objectIdSchema }).parse(req.params);
    const db = await Database.findById(params.id).lean<SerializableDatabase | null>();
    if (!db) {
      res.status(404).json({ error: 'Database not found' });
      return;
    }
    const ok = await checkWorkspaceMembership(req, res, db.workspaceId);
    if (!ok) return;

    const views = await DatabaseView.find({ databaseId: db._id })
      .sort({ order: 1, createdAt: 1 })
      .lean<SerializableView[]>();

    res.json({
      database: serializeDatabase(db),
      views: views.map((v) => serializeView(v)),
    });
  } catch (error: unknown) {
    if (handleZodError(error, res)) return;
    log.general.error({ err: error }, 'Failed to fetch database');
    res.status(500).json({ error: 'Failed to fetch database' });
  }
});

/**
 * POST /databases
 */
router.post(
  '/',
  (req, res, next) => {
    const wsFromBody =
      typeof req.body?.workspaceId === 'string' ? req.body.workspaceId : undefined;
    if (wsFromBody && !req.headers['x-workspace-id']) {
      req.headers['x-workspace-id'] = wsFromBody;
    }
    next();
  },
  requireWorkspaceMember,
  async (req: Request, res: Response) => {
    try {
      const body = createDatabaseSchema.parse(req.body);
      const workspaceId = assertWorkspace(req, res);
      if (!workspaceId) return;
      if (body.workspaceId !== workspaceId) {
        res.status(403).json({ error: 'Workspace mismatch' });
        return;
      }
      const userId = req.user?.id;
      if (!userId) {
        res.status(401).json({ error: 'Unauthorized' });
        return;
      }

      // Inline DBs must point to a page in the same workspace.
      if (body.parentPageId) {
        const parent = await Page.findById(body.parentPageId)
          .select('workspaceId')
          .lean();
        if (!parent) {
          res.status(404).json({ error: 'Parent page not found' });
          return;
        }
        if (String(parent.workspaceId) !== workspaceId) {
          res
            .status(400)
            .json({ error: 'Parent page is in a different workspace' });
          return;
        }
      }

      const propertiesSchema: DatabaseSchema = body.schema
        ? normalizeSchema({
            properties: body.schema.properties.map((p) => ({
              id: p.id ?? randomUUID(),
              name: p.name,
              type: p.type,
              config: p.config as PropertyConfig | undefined,
            })),
          })
        : buildDefaultSchema();

      const db = await Database.create({
        workspaceId: new mongoose.Types.ObjectId(workspaceId),
        name: body.name ?? 'Untitled',
        icon: body.icon ?? null,
        cover: body.cover ?? null,
        ownerId: userId,
        propertiesSchema,
        isInline: body.isInline ?? false,
        parentPageId: body.parentPageId
          ? new mongoose.Types.ObjectId(body.parentPageId)
          : null,
        archived: false,
      });

      await createDefaultViewForDatabase(db._id as mongoose.Types.ObjectId);

      const views = await DatabaseView.find({ databaseId: db._id })
        .sort({ order: 1, createdAt: 1 })
        .lean<SerializableView[]>();

      res.status(201).json({
        database: serializeDatabase(db),
        views: views.map((v) => serializeView(v)),
      });
    } catch (error: unknown) {
      if (handleZodError(error, res)) return;
      log.general.error({ err: error }, 'Failed to create database');
      res.status(500).json({ error: 'Failed to create database' });
    }
  },
);

/**
 * PATCH /databases/:id
 * Update name / icon / cover / archived.
 */
router.patch('/:id', async (req: Request, res: Response) => {
  try {
    const params = z.object({ id: objectIdSchema }).parse(req.params);
    const body = updateDatabaseSchema.parse(req.body);

    const db = await Database.findById(params.id);
    if (!db) {
      res.status(404).json({ error: 'Database not found' });
      return;
    }
    const ok = await checkWorkspaceMembership(req, res, db.workspaceId);
    if (!ok) return;

    if (body.name !== undefined) db.name = body.name;
    if (body.icon !== undefined) db.icon = body.icon;
    if (body.cover !== undefined) db.cover = body.cover;
    if (body.archived !== undefined) db.archived = body.archived;
    await db.save();

    res.json({ database: serializeDatabase(db) });
  } catch (error: unknown) {
    if (handleZodError(error, res)) return;
    log.general.error({ err: error }, 'Failed to update database');
    res.status(500).json({ error: 'Failed to update database' });
  }
});

/**
 * DELETE /databases/:id
 * Soft-delete by default (archived=true). Hard delete requires owner role
 * and cascades to rows + views.
 */
router.delete('/:id', async (req: Request, res: Response) => {
  try {
    const params = z.object({ id: objectIdSchema }).parse(req.params);
    const hard = req.query.hard === 'true';

    const db = await Database.findById(params.id);
    if (!db) {
      res.status(404).json({ error: 'Database not found' });
      return;
    }
    const ok = await checkWorkspaceMembership(req, res, db.workspaceId);
    if (!ok) return;

    if (hard) {
      if (req.workspace?.role !== 'owner') {
        res.status(403).json({ error: 'Hard delete requires workspace owner role' });
        return;
      }
      const rows = await Page.find({ databaseId: db._id })
        .select('_id')
        .lean<{ _id: mongoose.Types.ObjectId }[]>();
      const rowIds = rows.map((r) => r._id);
      if (rowIds.length > 0) {
        await Block.deleteMany({ pageId: { $in: rowIds } });
        await Page.deleteMany({ _id: { $in: rowIds } });
      }
      await DatabaseView.deleteMany({ databaseId: db._id });
      await Database.deleteOne({ _id: db._id });
      res.json({ success: true });
      return;
    }

    db.archived = true;
    await db.save();
    res.json({ database: serializeDatabase(db) });
  } catch (error: unknown) {
    if (handleZodError(error, res)) return;
    log.general.error({ err: error }, 'Failed to delete database');
    res.status(500).json({ error: 'Failed to delete database' });
  }
});

// ---------------------------------------------------------------------------
// Properties (schema mutations)
// ---------------------------------------------------------------------------

router.post('/:id/properties', async (req: Request, res: Response) => {
  try {
    const params = z.object({ id: objectIdSchema }).parse(req.params);
    const body = addPropertySchema.parse(req.body);

    const db = await Database.findById(params.id);
    if (!db) {
      res.status(404).json({ error: 'Database not found' });
      return;
    }
    const ok = await checkWorkspaceMembership(req, res, db.workspaceId);
    if (!ok) return;

    const property: DatabaseProperty = {
      id: body.id ?? randomUUID(),
      name: body.name,
      type: body.type,
      config: body.config as PropertyConfig | undefined,
    };

    if (db.propertiesSchema.properties.some((p) => p.id === property.id)) {
      res.status(409).json({ error: 'Property id already exists' });
      return;
    }

    db.propertiesSchema.properties.push(property);
    db.propertiesSchema = normalizeSchema(db.propertiesSchema);
    db.markModified('propertiesSchema');
    await db.save();

    res.status(201).json({ database: serializeDatabase(db) });
  } catch (error: unknown) {
    if (handleZodError(error, res)) return;
    log.general.error({ err: error }, 'Failed to add property');
    res.status(500).json({ error: 'Failed to add property' });
  }
});

router.patch(
  '/:id/properties/:propertyId',
  async (req: Request, res: Response) => {
    try {
      const params = z
        .object({ id: objectIdSchema, propertyId: z.string().min(1) })
        .parse(req.params);
      const body = updatePropertySchema.parse(req.body);

      const db = await Database.findById(params.id);
      if (!db) {
        res.status(404).json({ error: 'Database not found' });
        return;
      }
      const ok = await checkWorkspaceMembership(req, res, db.workspaceId);
      if (!ok) return;

      const idx = db.propertiesSchema.properties.findIndex(
        (p) => p.id === params.propertyId,
      );
      if (idx === -1) {
        res.status(404).json({ error: 'Property not found' });
        return;
      }
      const current = db.propertiesSchema.properties[idx];
      const next: DatabaseProperty = {
        id: current.id,
        name: body.name ?? current.name,
        type: body.type ?? current.type,
        config:
          body.config !== undefined
            ? (body.config as PropertyConfig)
            : current.config,
      };
      db.propertiesSchema.properties[idx] = next;
      db.propertiesSchema = normalizeSchema(db.propertiesSchema);
      db.markModified('propertiesSchema');
      await db.save();

      res.json({ database: serializeDatabase(db) });
    } catch (error: unknown) {
      if (handleZodError(error, res)) return;
      log.general.error({ err: error }, 'Failed to update property');
      res.status(500).json({ error: 'Failed to update property' });
    }
  },
);

router.delete(
  '/:id/properties/:propertyId',
  async (req: Request, res: Response) => {
    try {
      const params = z
        .object({ id: objectIdSchema, propertyId: z.string().min(1) })
        .parse(req.params);

      const db = await Database.findById(params.id);
      if (!db) {
        res.status(404).json({ error: 'Database not found' });
        return;
      }
      const ok = await checkWorkspaceMembership(req, res, db.workspaceId);
      if (!ok) return;

      if (params.propertyId === NAME_PROPERTY_ID) {
        res.status(400).json({ error: 'Cannot delete the Name property' });
        return;
      }
      db.propertiesSchema.properties = db.propertiesSchema.properties.filter(
        (p) => p.id !== params.propertyId,
      );
      db.markModified('propertiesSchema');
      await db.save();

      // Drop the property from every row.
      await Page.updateMany(
        { databaseId: db._id },
        { $unset: { [`properties.${params.propertyId}`]: '' } },
      );

      res.json({ database: serializeDatabase(db) });
    } catch (error: unknown) {
      if (handleZodError(error, res)) return;
      log.general.error({ err: error }, 'Failed to delete property');
      res.status(500).json({ error: 'Failed to delete property' });
    }
  },
);

// ---------------------------------------------------------------------------
// Rows
// ---------------------------------------------------------------------------

router.get('/:id/rows', async (req: Request, res: Response) => {
  try {
    const params = z.object({ id: objectIdSchema }).parse(req.params);
    const query = listRowsQuerySchema.parse(req.query);

    const db = await Database.findById(params.id).lean<SerializableDatabase | null>();
    if (!db) {
      res.status(404).json({ error: 'Database not found' });
      return;
    }
    const ok = await checkWorkspaceMembership(req, res, db.workspaceId);
    if (!ok) return;

    // Find the view (or fall back to default if none given).
    let view: SerializableView | null = null;
    if (query.viewId) {
      view = await DatabaseView.findById(query.viewId).lean<SerializableView | null>();
      if (!view || String(view.databaseId) !== String(db._id)) {
        res.status(404).json({ error: 'View not found' });
        return;
      }
    } else {
      view = await DatabaseView.findOne({
        databaseId: db._id,
        isDefault: true,
      }).lean<SerializableView | null>();
    }

    // Load all rows for the database. Filter / sort in JS — Phase 4 keeps
    // the typed property layer simple and database sizes are bounded by
    // the soft cap (10k rows in Phase 5 is the design target).
    const rowDocs = await Page.find({
      databaseId: db._id,
      archived: false,
    })
      .lean<SerializableRow[]>();

    const propertyById = new Map<string, DatabaseProperty>();
    for (const p of db.propertiesSchema.properties) propertyById.set(p.id, p);

    let filtered = rowDocs;
    if (query.search) {
      const needle = query.search.toLowerCase();
      filtered = filtered.filter((r) => r.title.toLowerCase().includes(needle));
    }
    if (view?.filters && view.filters.filters.length > 0) {
      filtered = filtered.filter((r) =>
        evaluateFilter(view!.filters as Filter, r, propertyById),
      );
    }
    if (view?.sorts && view.sorts.length > 0) {
      const compare = compareBySorts(view.sorts, propertyById);
      filtered = [...filtered].sort(compare);
    } else {
      filtered = [...filtered].sort(
        (a, b) =>
          new Date(a.createdAt as unknown as string).getTime() -
          new Date(b.createdAt as unknown as string).getTime(),
      );
    }

    const pageSize = Math.min(
      500,
      Math.max(1, Number(query.pageSize ?? view?.pageSize ?? 50)),
    );
    const cursorOffset = Number(query.cursor ?? '0');
    const slice = filtered.slice(cursorOffset, cursorOffset + pageSize);
    const nextCursor =
      cursorOffset + pageSize < filtered.length
        ? String(cursorOffset + pageSize)
        : null;

    const serializedRows = await Promise.all(
      slice.map(async (row) => {
        const derived = await resolveDerivedProperties(
          row,
          db.propertiesSchema,
        );
        return serializeRow(row, { derived });
      }),
    );

    res.json({
      rows: serializedRows,
      total: filtered.length,
      cursor: nextCursor,
      view: view ? serializeView(view) : null,
    });
  } catch (error: unknown) {
    if (handleZodError(error, res)) return;
    log.general.error({ err: error }, 'Failed to list rows');
    res.status(500).json({ error: 'Failed to list rows' });
  }
});

router.post('/:id/rows', async (req: Request, res: Response) => {
  try {
    const params = z.object({ id: objectIdSchema }).parse(req.params);
    const body = createRowSchema.parse(req.body);

    const db = await Database.findById(params.id).lean<SerializableDatabase | null>();
    if (!db) {
      res.status(404).json({ error: 'Database not found' });
      return;
    }
    const ok = await checkWorkspaceMembership(req, res, db.workspaceId);
    if (!ok) return;
    const userId = req.user?.id;
    if (!userId) {
      res.status(401).json({ error: 'Unauthorized' });
      return;
    }

    const { stored, nameFromProperty } = normalizeIncomingProperties(
      db.propertiesSchema,
      body.properties ?? {},
    );

    // Resolve final title: explicit body.title wins, then properties.name,
    // then fall back to "" (the row card will show "Untitled").
    const title =
      typeof body.title === 'string'
        ? body.title
        : nameFromProperty !== null
          ? nameFromProperty
          : '';

    const last = await Page.findOne({ databaseId: db._id })
      .sort({ order: -1 })
      .select('order')
      .lean();
    const nextOrder = last ? last.order + 1 : 0;

    const row = await Page.create({
      workspaceId: db.workspaceId,
      parentId: null,
      title,
      icon: null,
      cover: null,
      ownerId: userId,
      archived: false,
      order: nextOrder,
      databaseId: db._id,
      properties: new Map(Object.entries(stored)),
    });

    const lean: SerializableRow = {
      _id: row._id as mongoose.Types.ObjectId,
      workspaceId: row.workspaceId,
      parentId: row.parentId,
      title: row.title,
      icon: row.icon,
      cover: row.cover,
      ownerId: row.ownerId,
      archived: row.archived,
      order: row.order,
      databaseId: row.databaseId,
      properties: row.properties,
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
    };
    const derived = await resolveDerivedProperties(lean, db.propertiesSchema);

    res.status(201).json({ row: serializeRow(lean, { derived }) });
  } catch (error: unknown) {
    if (handleZodError(error, res)) return;
    log.general.error({ err: error }, 'Failed to create row');
    res.status(500).json({ error: 'Failed to create row' });
  }
});

// ---------------------------------------------------------------------------
// Views
// ---------------------------------------------------------------------------

router.get('/:id/views', async (req: Request, res: Response) => {
  try {
    const params = z.object({ id: objectIdSchema }).parse(req.params);
    const db = await Database.findById(params.id).select('workspaceId').lean();
    if (!db) {
      res.status(404).json({ error: 'Database not found' });
      return;
    }
    const ok = await checkWorkspaceMembership(req, res, db.workspaceId);
    if (!ok) return;

    const views = await DatabaseView.find({ databaseId: db._id })
      .sort({ order: 1, createdAt: 1 })
      .lean<SerializableView[]>();
    res.json({ views: views.map((v) => serializeView(v)) });
  } catch (error: unknown) {
    if (handleZodError(error, res)) return;
    log.general.error({ err: error }, 'Failed to list views');
    res.status(500).json({ error: 'Failed to list views' });
  }
});

router.post('/:id/views', async (req: Request, res: Response) => {
  try {
    const params = z.object({ id: objectIdSchema }).parse(req.params);
    const body = createViewSchema.parse(req.body);

    const db = await Database.findById(params.id).select('workspaceId').lean();
    if (!db) {
      res.status(404).json({ error: 'Database not found' });
      return;
    }
    const ok = await checkWorkspaceMembership(req, res, db.workspaceId);
    if (!ok) return;

    const last = await DatabaseView.findOne({ databaseId: db._id })
      .sort({ order: -1 })
      .select('order')
      .lean();
    const nextOrder =
      body.order ?? (last ? last.order + 1 : 0);

    // Convert nullable groupBy { propertyId } into the storage shape.
    const groupByValue: { propertyId: string } | null =
      body.groupBy === undefined
        ? null
        : body.groupBy === null
          ? null
          : { propertyId: body.groupBy.propertyId };

    const view = await DatabaseView.create({
      databaseId: db._id,
      name: body.name,
      type: body.type,
      isDefault: body.isDefault ?? false,
      filters:
        body.filters ?? ({
          kind: 'group',
          combinator: 'and',
          filters: [],
        } satisfies FilterGroup),
      sorts: (body.sorts ?? []) as ViewSort[],
      groupBy: groupByValue,
      hiddenProperties: body.hiddenProperties ?? [],
      frozenProperties: body.frozenProperties ?? [],
      pageSize: body.pageSize ?? 50,
      config: (body.config ?? {}) as ViewConfig,
      order: nextOrder,
    });

    res.status(201).json({ view: serializeView(view) });
  } catch (error: unknown) {
    if (handleZodError(error, res)) return;
    log.general.error({ err: error }, 'Failed to create view');
    res.status(500).json({ error: 'Failed to create view' });
  }
});

router.patch(
  '/:id/views/:viewId',
  async (req: Request, res: Response) => {
    try {
      const params = z
        .object({ id: objectIdSchema, viewId: objectIdSchema })
        .parse(req.params);
      const body = updateViewSchema.parse(req.body);

      const db = await Database.findById(params.id).select('workspaceId').lean();
      if (!db) {
        res.status(404).json({ error: 'Database not found' });
        return;
      }
      const ok = await checkWorkspaceMembership(req, res, db.workspaceId);
      if (!ok) return;

      const view = await DatabaseView.findById(params.viewId);
      if (!view || String(view.databaseId) !== String(db._id)) {
        res.status(404).json({ error: 'View not found' });
        return;
      }

      if (body.name !== undefined) view.name = body.name;
      if (body.type !== undefined) view.type = body.type;
      if (body.isDefault !== undefined) {
        view.isDefault = body.isDefault;
        if (body.isDefault) {
          // Demote previous default(s).
          await DatabaseView.updateMany(
            {
              databaseId: db._id,
              _id: { $ne: view._id },
              isDefault: true,
            },
            { $set: { isDefault: false } },
          );
        }
      }
      if (body.filters !== undefined) view.filters = body.filters;
      if (body.sorts !== undefined) view.sorts = body.sorts as ViewSort[];
      if (body.groupBy !== undefined) {
        view.groupBy =
          body.groupBy === null
            ? null
            : { propertyId: body.groupBy.propertyId };
      }
      if (body.hiddenProperties !== undefined) {
        view.hiddenProperties = body.hiddenProperties;
      }
      if (body.frozenProperties !== undefined) {
        view.frozenProperties = body.frozenProperties;
      }
      if (body.pageSize !== undefined) view.pageSize = body.pageSize;
      if (body.config !== undefined) view.config = body.config as ViewConfig;
      if (body.order !== undefined) view.order = body.order;

      await view.save();
      res.json({ view: serializeView(view) });
    } catch (error: unknown) {
      if (handleZodError(error, res)) return;
      log.general.error({ err: error }, 'Failed to update view');
      res.status(500).json({ error: 'Failed to update view' });
    }
  },
);

router.delete(
  '/:id/views/:viewId',
  async (req: Request, res: Response) => {
    try {
      const params = z
        .object({ id: objectIdSchema, viewId: objectIdSchema })
        .parse(req.params);

      const db = await Database.findById(params.id).select('workspaceId').lean();
      if (!db) {
        res.status(404).json({ error: 'Database not found' });
        return;
      }
      const ok = await checkWorkspaceMembership(req, res, db.workspaceId);
      if (!ok) return;

      const view = await DatabaseView.findById(params.viewId);
      if (!view || String(view.databaseId) !== String(db._id)) {
        res.status(404).json({ error: 'View not found' });
        return;
      }

      // Don't allow deleting the last view — promote another to default
      // if we're removing the default.
      const total = await DatabaseView.countDocuments({ databaseId: db._id });
      if (total <= 1) {
        res.status(400).json({ error: 'Cannot delete the last view' });
        return;
      }
      const wasDefault = view.isDefault;
      await DatabaseView.deleteOne({ _id: view._id });
      if (wasDefault) {
        const fallback = await DatabaseView.findOne({ databaseId: db._id })
          .sort({ order: 1, createdAt: 1 });
        if (fallback) {
          fallback.isDefault = true;
          await fallback.save();
        }
      }
      res.json({ success: true });
    } catch (error: unknown) {
      if (handleZodError(error, res)) return;
      log.general.error({ err: error }, 'Failed to delete view');
      res.status(500).json({ error: 'Failed to delete view' });
    }
  },
);

export default router;
