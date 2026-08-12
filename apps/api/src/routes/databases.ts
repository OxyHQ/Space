import { Router } from 'express';
import type { NextFunction, Request, Response } from 'express';
import { randomUUID } from 'crypto';
import { isLiveEntityId } from '@oxyhq/db';
import { z } from 'zod';
import { getDb, type PgHandle } from '../db/client.js';
import {
  DATABASE_PROPERTY_TYPES,
  DATABASE_VIEW_TYPES,
  DEFAULT_VIEW_PAGE_SIZE,
  EMPTY_FILTER_GROUP,
  SELECT_COLORS,
  type DatabaseProperty,
  type DatabasePropertyType,
  type DatabaseSchema,
  type DatabaseViewType,
  type Filter,
  type PropertyConfig,
  type SelectOption,
  type ViewConfig,
  type ViewSort,
} from '../db/schema/databases.js';
import type { PageRow } from '../repositories/pages.js';
import {
  countViews,
  deleteDatabase,
  deleteDatabaseView,
  deleteViewsByDatabase,
  demoteOtherDefaultViews,
  findDatabaseById,
  findDatabaseWorkspaceId,
  findDefaultView,
  findFirstViewByOrder,
  findViewById,
  insertDatabase,
  insertDatabaseView,
  listDatabasesByWorkspace,
  listViewsByDatabase,
  nextViewOrder,
  updateDatabase,
  updateDatabaseView,
  writeDatabaseSchema,
  type DatabaseRecord,
  type DatabaseViewRecord,
} from '../repositories/databases.js';
import {
  createPage,
  deleteDatabaseRows,
  findPageById,
  listDatabaseRows,
  nextDatabaseRowOrder,
  removePropertyFromDatabaseRows,
} from '../repositories/pages.js';
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

/**
 * The id shape a row can actually have.
 *
 * Replaces a 24-hex ObjectId regex. `isLiveEntityId` is the one place either
 * shape is spelled out: a uuid v7 for every row created on Postgres, and a
 * 24-char ObjectId hex for every row a backfill copied over verbatim — both are
 * live simultaneously, so neither may be rejected. A 24-hex regex here would
 * 400 every id the schema now generates.
 *
 * It exists to turn malformed input into a 400 and nothing else; it is never a
 * precondition on a query, which already answers "no such row" for free.
 */
const entityIdSchema = z.string().refine(isLiveEntityId, 'Invalid id');

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
    targetDatabaseId: entityIdSchema.optional(),
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
  workspaceId: entityIdSchema,
  name: z.string().max(2000).optional(),
  icon: z.string().max(200).nullable().optional(),
  cover: z.string().max(2000).nullable().optional(),
  schema: databaseSchemaSchema.optional(),
  isInline: z.boolean().optional(),
  parentPageId: entityIdSchema.nullable().optional(),
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
  workspaceId: entityIdSchema,
  includeArchived: z
    .union([z.literal('true'), z.literal('false')])
    .optional()
    .transform((v) => v === 'true'),
});

const listRowsQuerySchema = z.object({
  viewId: entityIdSchema.optional(),
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
  workspaceId: string,
): Promise<boolean> {
  req.headers['x-workspace-id'] = workspaceId;
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

/**
 * Wire format exposes the property schema as `schema` (mirrors the design
 * doc), even though the stored column is `properties_schema`.
 */
function serializeDatabase(db: DatabaseRecord) {
  return {
    id: db.id,
    workspaceId: db.workspaceId,
    name: db.name,
    icon: db.icon,
    cover: db.cover,
    ownerId: db.ownerId,
    schema: db.propertiesSchema,
    isInline: db.isInline,
    parentPageId: db.parentPageId,
    archived: db.archived,
    createdAt: db.createdAt,
    updatedAt: db.updatedAt,
  };
}

function serializeView(view: DatabaseViewRecord) {
  return {
    id: view.id,
    databaseId: view.databaseId,
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

interface RowSerializationOpts {
  derived: Record<string, unknown>;
}

/**
 * A row is a page. `id` is the only id on the wire — the `_id` this used to
 * emit alongside it was the Mongo primary key under its storage name, and
 * carrying it forward would publish a field no row has.
 */
function serializeRow(row: PageRow, opts?: RowSerializationOpts) {
  const properties: Record<string, unknown> = { ...row.properties };
  if (opts) Object.assign(properties, opts.derived);

  return {
    id: row.id,
    workspaceId: row.workspaceId,
    parentId: row.parentId,
    databaseId: row.databaseId,
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
  handle: PgHandle,
  row: PageRow,
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
        const value = await resolveRollup(handle, prop, row);
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
 * The view every new database is created with.
 *
 * Takes a handle rather than reaching for the pool: `POST /databases` creates
 * the database and this view in ONE transaction. Under Mongo they were two
 * independent writes, so a failure between them left a database with no views
 * at all — a state the rest of the route refuses to produce (`DELETE
 * /:id/views/:viewId` will not remove the last one). This makes the storage
 * uphold an invariant the code already tried to hold; it does not invent one.
 */
async function createDefaultViewForDatabase(
  handle: PgHandle,
  databaseId: string,
): Promise<void> {
  await insertDatabaseView(handle, {
    databaseId,
    name: 'All',
    type: 'table',
    isDefault: true,
    filters: EMPTY_FILTER_GROUP,
    sorts: [],
    groupBy: null,
    hiddenProperties: [],
    frozenProperties: [],
    pageSize: DEFAULT_VIEW_PAGE_SIZE,
    config: {},
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

    const databases = await listDatabasesByWorkspace(getDb(), {
      workspaceId,
      includeArchived: query.includeArchived,
    });

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
    const params = z.object({ id: entityIdSchema }).parse(req.params);
    const handle = getDb();
    const db = await findDatabaseById(handle, params.id);
    if (!db) {
      res.status(404).json({ error: 'Database not found' });
      return;
    }
    const ok = await checkWorkspaceMembership(req, res, db.workspaceId);
    if (!ok) return;

    const views = await listViewsByDatabase(handle, db.id);

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

      const handle = getDb();

      // Inline DBs must point to a page in the same workspace.
      if (body.parentPageId) {
        const parent = await findPageById(handle, body.parentPageId);
        if (!parent) {
          res.status(404).json({ error: 'Parent page not found' });
          return;
        }
        if (parent.workspaceId !== workspaceId) {
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

      const created = await handle.transaction(async (tx) => {
        const db = await insertDatabase(tx, {
          workspaceId,
          name: body.name ?? 'Untitled',
          icon: body.icon ?? null,
          cover: body.cover ?? null,
          ownerId: userId,
          propertiesSchema,
          isInline: body.isInline ?? false,
          parentPageId: body.parentPageId ?? null,
          archived: false,
        });
        await createDefaultViewForDatabase(tx, db.id);
        return { db, views: await listViewsByDatabase(tx, db.id) };
      });

      res.status(201).json({
        database: serializeDatabase(created.db),
        views: created.views.map((v) => serializeView(v)),
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
    const params = z.object({ id: entityIdSchema }).parse(req.params);
    const body = updateDatabaseSchema.parse(req.body);

    const handle = getDb();
    const db = await findDatabaseById(handle, params.id);
    if (!db) {
      res.status(404).json({ error: 'Database not found' });
      return;
    }
    const ok = await checkWorkspaceMembership(req, res, db.workspaceId);
    if (!ok) return;

    // `undefined` and `null` are different instructions here: `icon` and
    // `cover` are nullable and an explicit `null` must be written.
    const updated = await updateDatabase(handle, db.id, {
      name: body.name,
      icon: body.icon,
      cover: body.cover,
      archived: body.archived,
    });
    if (!updated) {
      res.status(404).json({ error: 'Database not found' });
      return;
    }

    res.json({ database: serializeDatabase(updated) });
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
    const params = z.object({ id: entityIdSchema }).parse(req.params);
    const hard = req.query.hard === 'true';

    const handle = getDb();
    const db = await findDatabaseById(handle, params.id);
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
      // Rows, views and the database leave together. Under Mongo these were
      // four independent `deleteMany` calls, so a failure part-way left rows
      // pointing at a database that no longer existed. Blocks go with their
      // rows through `blocks.pageId ON DELETE CASCADE`, which is why the
      // route's explicit `Block.deleteMany` has no counterpart.
      await handle.transaction(async (tx) => {
        await deleteDatabaseRows(tx, db.id);
        await deleteViewsByDatabase(tx, db.id);
        await deleteDatabase(tx, db.id);
      });
      res.json({ success: true });
      return;
    }

    const archived = await updateDatabase(handle, db.id, { archived: true });
    if (!archived) {
      res.status(404).json({ error: 'Database not found' });
      return;
    }
    res.json({ database: serializeDatabase(archived) });
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
    const params = z.object({ id: entityIdSchema }).parse(req.params);
    const body = addPropertySchema.parse(req.body);

    const handle = getDb();
    const db = await findDatabaseById(handle, params.id);
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
    const updated = await writeDatabaseSchema(
      handle,
      db.id,
      normalizeSchema(db.propertiesSchema),
    );
    if (!updated) {
      res.status(404).json({ error: 'Database not found' });
      return;
    }

    res.status(201).json({ database: serializeDatabase(updated) });
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
        .object({ id: entityIdSchema, propertyId: z.string().min(1) })
        .parse(req.params);
      const body = updatePropertySchema.parse(req.body);

      const handle = getDb();
      const db = await findDatabaseById(handle, params.id);
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
      const updated = await writeDatabaseSchema(
        handle,
        db.id,
        normalizeSchema(db.propertiesSchema),
      );
      if (!updated) {
        res.status(404).json({ error: 'Database not found' });
        return;
      }

      res.json({ database: serializeDatabase(updated) });
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
        .object({ id: entityIdSchema, propertyId: z.string().min(1) })
        .parse(req.params);

      const handle = getDb();
      const db = await findDatabaseById(handle, params.id);
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
      const propertiesSchema: DatabaseSchema = {
        properties: db.propertiesSchema.properties.filter(
          (p) => p.id !== params.propertyId,
        ),
      };

      // Dropping the property from the schema and from every row is one
      // logical write: the schema is what tells a reader the key exists, so a
      // failure between the two leaves values no reader can reach and no
      // writer will overwrite.
      const updated = await handle.transaction(async (tx) => {
        const row = await writeDatabaseSchema(tx, db.id, propertiesSchema);
        if (!row) return null;
        await removePropertyFromDatabaseRows(tx, db.id, params.propertyId);
        return row;
      });
      if (!updated) {
        res.status(404).json({ error: 'Database not found' });
        return;
      }

      res.json({ database: serializeDatabase(updated) });
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
    const params = z.object({ id: entityIdSchema }).parse(req.params);
    const query = listRowsQuerySchema.parse(req.query);

    const handle = getDb();
    const db = await findDatabaseById(handle, params.id);
    if (!db) {
      res.status(404).json({ error: 'Database not found' });
      return;
    }
    const ok = await checkWorkspaceMembership(req, res, db.workspaceId);
    if (!ok) return;

    // Find the view (or fall back to default if none given).
    let view: DatabaseViewRecord | null = null;
    if (query.viewId) {
      view = await findViewById(handle, query.viewId, db.id);
      if (!view) {
        res.status(404).json({ error: 'View not found' });
        return;
      }
    } else {
      view = await findDefaultView(handle, db.id);
    }

    // Load all rows for the database. Filter / sort in JS — Phase 4 keeps
    // the typed property layer simple and database sizes are bounded by
    // the soft cap (10k rows in Phase 5 is the design target).
    const rowDocs = await listDatabaseRows(handle, db.id, { archived: false });

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
        (a, b) => a.createdAt.getTime() - b.createdAt.getTime(),
      );
    }

    const pageSize = Math.min(
      500,
      Math.max(1, Number(query.pageSize ?? view?.pageSize ?? DEFAULT_VIEW_PAGE_SIZE)),
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
          handle,
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
    const params = z.object({ id: entityIdSchema }).parse(req.params);
    const body = createRowSchema.parse(req.body);

    const handle = getDb();
    const db = await findDatabaseById(handle, params.id);
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

    const nextOrder = await nextDatabaseRowOrder(handle, db.id);

    const row = await createPage(handle, {
      workspaceId: db.workspaceId,
      parentId: null,
      title,
      icon: null,
      cover: null,
      ownerId: userId,
      archived: false,
      order: nextOrder,
      databaseId: db.id,
      properties: stored,
    });

    const derived = await resolveDerivedProperties(
      handle,
      row,
      db.propertiesSchema,
    );

    res.status(201).json({ row: serializeRow(row, { derived }) });
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
    const params = z.object({ id: entityIdSchema }).parse(req.params);
    const handle = getDb();
    const db = await findDatabaseWorkspaceId(handle, params.id);
    if (!db) {
      res.status(404).json({ error: 'Database not found' });
      return;
    }
    const ok = await checkWorkspaceMembership(req, res, db.workspaceId);
    if (!ok) return;

    const views = await listViewsByDatabase(handle, db.id);
    res.json({ views: views.map((v) => serializeView(v)) });
  } catch (error: unknown) {
    if (handleZodError(error, res)) return;
    log.general.error({ err: error }, 'Failed to list views');
    res.status(500).json({ error: 'Failed to list views' });
  }
});

router.post('/:id/views', async (req: Request, res: Response) => {
  try {
    const params = z.object({ id: entityIdSchema }).parse(req.params);
    const body = createViewSchema.parse(req.body);

    const handle = getDb();
    const db = await findDatabaseWorkspaceId(handle, params.id);
    if (!db) {
      res.status(404).json({ error: 'Database not found' });
      return;
    }
    const ok = await checkWorkspaceMembership(req, res, db.workspaceId);
    if (!ok) return;

    // `??`, not `||`: `order: 0` is a legitimate explicit order.
    const nextOrder = body.order ?? (await nextViewOrder(handle, db.id));

    // Convert nullable groupBy { propertyId } into the storage shape.
    const groupByValue: { propertyId: string } | null =
      body.groupBy === undefined
        ? null
        : body.groupBy === null
          ? null
          : { propertyId: body.groupBy.propertyId };

    const view = await insertDatabaseView(handle, {
      databaseId: db.id,
      name: body.name,
      type: body.type,
      isDefault: body.isDefault ?? false,
      filters: body.filters ?? EMPTY_FILTER_GROUP,
      sorts: (body.sorts ?? []) as ViewSort[],
      groupBy: groupByValue,
      hiddenProperties: body.hiddenProperties ?? [],
      frozenProperties: body.frozenProperties ?? [],
      pageSize: body.pageSize ?? DEFAULT_VIEW_PAGE_SIZE,
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
        .object({ id: entityIdSchema, viewId: entityIdSchema })
        .parse(req.params);
      const body = updateViewSchema.parse(req.body);

      const handle = getDb();
      const db = await findDatabaseWorkspaceId(handle, params.id);
      if (!db) {
        res.status(404).json({ error: 'Database not found' });
        return;
      }
      const ok = await checkWorkspaceMembership(req, res, db.workspaceId);
      if (!ok) return;

      const view = await findViewById(handle, params.viewId, db.id);
      if (!view) {
        res.status(404).json({ error: 'View not found' });
        return;
      }

      // Promoting a view and demoting the previous default(s) commit
      // together — Mongo demoted first and saved the target afterwards, so a
      // failure between the two left the database with no default at all.
      const updated = await handle.transaction(async (tx) => {
        if (body.isDefault) {
          await demoteOtherDefaultViews(tx, db.id, view.id);
        }
        return updateDatabaseView(tx, view.id, {
          name: body.name,
          type: body.type,
          isDefault: body.isDefault,
          filters: body.filters,
          sorts: body.sorts as ViewSort[] | undefined,
          groupBy:
            body.groupBy === undefined
              ? undefined
              : body.groupBy === null
                ? null
                : { propertyId: body.groupBy.propertyId },
          hiddenProperties: body.hiddenProperties,
          frozenProperties: body.frozenProperties,
          pageSize: body.pageSize,
          config: body.config as ViewConfig | undefined,
          order: body.order,
        });
      });
      if (!updated) {
        res.status(404).json({ error: 'View not found' });
        return;
      }

      res.json({ view: serializeView(updated) });
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
        .object({ id: entityIdSchema, viewId: entityIdSchema })
        .parse(req.params);

      const handle = getDb();
      const db = await findDatabaseWorkspaceId(handle, params.id);
      if (!db) {
        res.status(404).json({ error: 'Database not found' });
        return;
      }
      const ok = await checkWorkspaceMembership(req, res, db.workspaceId);
      if (!ok) return;

      const view = await findViewById(handle, params.viewId, db.id);
      if (!view) {
        res.status(404).json({ error: 'View not found' });
        return;
      }

      // Don't allow deleting the last view — promote another to default
      // if we're removing the default.
      const total = await countViews(handle, db.id);
      if (total <= 1) {
        res.status(400).json({ error: 'Cannot delete the last view' });
        return;
      }
      // The delete and the promotion commit together: between them the
      // database has no default view, and `GET /:id/rows` resolves its view
      // from exactly that flag.
      await handle.transaction(async (tx) => {
        await deleteDatabaseView(tx, view.id);
        if (!view.isDefault) return;
        const fallback = await findFirstViewByOrder(tx, db.id);
        if (fallback) {
          await updateDatabaseView(tx, fallback.id, { isDefault: true });
        }
      });
      res.json({ success: true });
    } catch (error: unknown) {
      if (handleZodError(error, res)) return;
      log.general.error({ err: error }, 'Failed to delete view');
      res.status(500).json({ error: 'Failed to delete view' });
    }
  },
);

export default router;
