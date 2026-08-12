import { sql } from 'drizzle-orm';
import {
  boolean,
  check,
  doublePrecision,
  index,
  jsonb,
  pgTable,
  text,
  type AnyPgColumn,
} from 'drizzle-orm/pg-core';
import { createdAt, generatedId, inList, updatedAt } from '@oxyhq/db';
import { workspaces } from './workspaces.js';

/**
 * Pages and blocks — the document primitive and its content units.
 *
 * Ported from `src/models/page.ts` and `src/models/block.ts`. The conventions
 * (uuidv7 text ids, `text` + CHECK instead of `pgEnum`, `inList` rendering the
 * literal side without parentheses, column names derived by `DATABASE_CASING`)
 * are stated once in `workspaces.ts` and are not repeated here. What IS stated
 * here is every place the Mongo and Postgres semantics differ, because each one
 * is a decision somebody has to be able to check.
 */

/**
 * Per-property value on a database row. The shape depends on the property's
 * declared type and is validated at the route boundary by
 * `lib/databases/property-values.ts`, never by the storage layer — the same
 * split the Mongoose `Map<string, Mixed>` had.
 */
export type PageProperties = Record<string, unknown>;

/** Bounds of `pages.coverPosition`, as a percentage offset. */
export const COVER_POSITION_MIN = 0;
export const COVER_POSITION_MAX = 100;

export const pages = pgTable(
  'pages',
  {
    id: generatedId(),
    workspaceId: text()
      .notNull()
      .references(() => workspaces.id, { onDelete: 'cascade' }),
    /**
     * Self-reference: pages form a tree per workspace, `null` = root.
     *
     * `ON DELETE SET NULL`, and the choice matters more than it looks.
     *
     * CASCADE is the obvious reading of `DELETE /api/pages/:id?hard=true`,
     * which BFS-collects descendants and deletes them — but it is WRONG here,
     * because a second delete path exists. `POST
     * /api/workspaces/:id/trash/empty` (`routes/workspaces.ts:604-618`) deletes
     * every ARCHIVED page in the workspace, and archiving a page
     * (`routes/pages.ts:485`) stamps only that page — its children stay
     * `archived: false`. Under CASCADE, emptying the trash would destroy live
     * descendants of an archived parent; under Mongo it left them in place with
     * a dangling `parentId`. That is data loss introduced by the FK alone, and
     * it is reachable today.
     *
     * NO ACTION was the other candidate and is worse still: the same
     * trash-empty would abort with 23503, breaking a route that works.
     *
     * SET NULL keeps the row and surfaces it — the orphan becomes a root page
     * of its workspace instead of a child of a page that no longer exists,
     * which is what a client tree-builder can actually render. It is a
     * behaviour change against Mongo, in the direction of visibility rather
     * than loss; `pagesRepository.deletePageTree` is unaffected because it
     * deletes the whole recursive set in ONE statement, so the referential
     * action finds no surviving child to null out (asserted, not assumed —
     * `pages.pgdb.test.ts`).
     */
    parentId: text().references((): AnyPgColumn => pages.id, { onDelete: 'set null' }),
    title: text().notNull().default(''),
    icon: text(),
    cover: text(),
    /** Vertical offset (percent) for cropped cover rendering; 50 = centered. */
    coverPosition: doublePrecision().notNull().default(50),
    /** Oxy user id — text, not a foreign key. See `workspaces.ownerId`. */
    ownerId: text().notNull(),
    /** Soft delete. The trash view lists these; emptying the trash removes them. */
    archived: boolean().notNull().default(false),
    /** Starred in the sidebar Favorites section. */
    favorited: boolean().notNull().default(false),
    /**
     * Sibling ordering. `double precision`, not an integer: `PATCH
     * /api/pages/:id` accepts `z.number().finite()`, so a client may write a
     * fractional order to insert between two neighbours without renumbering.
     *
     * No `isfinite` CHECK. The Mongoose schema had no validator on this field,
     * so a constraint here would be a NEW rule applied to rows nobody has
     * checked — the opposite call from `coverPosition` below, whose `min`/`max`
     * genuinely ran.
     */
    order: doublePrecision().notNull().default(0),
    /**
     * Non-null when this page is a row of a database (Phase 4).
     *
     * Deliberately NOT a foreign key yet: the `databases` domain is a separate
     * port and its table does not exist in this schema. The reference belongs
     * in the change that lands `databases`, together with its own delete
     * semantics — `routes/databases.ts:765-771` hard-deletes a database's rows
     * explicitly today, so the natural action there is CASCADE, but that is
     * that port's call to make and to test.
     */
    databaseId: text(),
    /**
     * Typed property values for a database row, keyed by propertyId.
     *
     * The Mongoose field was `Map<string, Mixed>` defaulting to an empty Map,
     * which serialises to `{}` — so `not null default '{}'`, never nullable.
     * Writers must merge rather than replace: `PATCH /api/pages/:id` sets
     * individual keys on the existing map (`routes/pages.ts:413-424`), which is
     * `properties || $1::jsonb` here, and `DELETE
     * /api/databases/:id/properties/:propertyId` unsets one key
     * (`routes/databases.ts:906`), which is `properties - $1`.
     */
    properties: jsonb().$type<PageProperties>().notNull().default({}),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    /**
     * Ported from `PageSchema.index({ workspaceId: 1, parentId: 1, order: 1 })`.
     * Serves the tree listing, and its `workspaceId` prefix subsumes the
     * standalone `workspaceId: index: true` the Mongoose schema also declared —
     * a leading-column prefix is a usable access path in Postgres, so the
     * single-column index would only cost writes.
     */
    index('pages_workspace_parent_order_idx').on(t.workspaceId, t.parentId, t.order),
    /** Ported from `PageSchema.index({ workspaceId: 1, archived: 1 })`. */
    index('pages_workspace_archived_idx').on(t.workspaceId, t.archived),
    /**
     * Ported from `PageSchema.index({ databaseId: 1, archived: 1, createdAt: 1 })`.
     * Its prefix subsumes the standalone `databaseId` index, as above.
     */
    index('pages_database_archived_created_idx').on(t.databaseId, t.archived, t.createdAt),
    /**
     * NOT in the Mongoose schema, and required by this schema rather than
     * inherited from it.
     *
     * `parentId` is now both a foreign key and the recursion column of every
     * tree walk (`deletePageTree`, `findPageAncestry`). An unindexed FK
     * referencing column makes each parent DELETE a sequential scan to run the
     * SET NULL action, and each level of a recursive CTE another one. Mongo had
     * neither obligation — its own descendant BFS
     * (`routes/pages.ts:506`) queries `parentId` with no `workspaceId`, so it
     * matched no index there either and simply scanned.
     */
    index('pages_parent_idx').on(t.parentId),
    /**
     * Ported from `PageSchema` field `favorited: { index: true }`, deliberately
     * reshaped. A standalone btree on a boolean is not a usable access path,
     * and the only query that filters on it (`?favoritedOnly=true`) is always
     * workspace-scoped, so the port is a PARTIAL index keyed on `workspaceId`.
     * Reshaped, not dropped: dropping it is the change that no functional test
     * could ever detect.
     */
    index('pages_workspace_favorited_idx')
      .on(t.workspaceId)
      .where(sql`${t.favorited}`),
    /**
     * No query performs jsonb containment today — `GET /api/databases/:id/rows`
     * loads a database's rows and filters them in JS
     * (`routes/databases.ts:955-980`). This index exists for the property
     * filtering that replaces that scan, and is the one entry here that is
     * ahead of its reader rather than ported from Mongo.
     */
    index('pages_properties_gin_idx').using('gin', t.properties),
    /**
     * The Mongoose `min: 0, max: 100` on `coverPosition` genuinely ran: the only
     * writer is `page.coverPosition = ...; await page.save()`
     * (`routes/pages.ts:387,439`), and `save()` runs validators. So it becomes a
     * live constraint rather than being dropped as a validator that never
     * fired. `between` also rejects `'NaN'::double precision`, which the
     * Mongoose validator did not.
     */
    check(
      'pages_cover_position_range',
      sql`${t.coverPosition} between ${sql.raw(String(COVER_POSITION_MIN))} and ${sql.raw(String(COVER_POSITION_MAX))}`,
    ),
  ],
);

/**
 * Every block type the editor persists.
 *
 * Declared here rather than imported from `src/models/block.ts`: the Mongoose
 * model is what this schema replaces, and pulling it into the drizzle schema
 * graph would make `drizzle-kit` load mongoose. The two lists must agree for as
 * long as both exist, which is asserted by `blocks.pgdb.test.ts` — a drift gate
 * that retires with the model file.
 */
export const BLOCK_TYPES = [
  'paragraph',
  'heading_1',
  'heading_2',
  'heading_3',
  'bulleted_list_item',
  'numbered_list_item',
  'todo',
  'quote',
  'divider',
  'code',
  'callout',
  'toggle',
  'image',
  'video',
  'audio',
  'file',
  'pdf',
  'bookmark',
  'embed',
  'columns',
  'column',
  'table',
  'table_row',
  'table_cell',
  'button',
  'link_to_page',
  'sync_block',
  'breadcrumb',
  'table_of_contents',
  'equation',
  'mermaid',
  'inline_database',
] as const;
export type BlockType = (typeof BLOCK_TYPES)[number];

/**
 * Block payload. Per-type shape lives in `routes/blocks.ts`, which normalises
 * every write through Zod — the storage layer holds the object and validates
 * nothing about it, exactly as the Mongoose `Mixed` did.
 */
export type BlockContent = Record<string, unknown>;

export const blocks = pgTable(
  'blocks',
  {
    id: generatedId(),
    /**
     * CASCADE, unlike the pages self-reference above, and for a reason that
     * does not apply there: every path that deletes a page already deletes its
     * blocks in the same request (`routes/pages.ts:478`,
     * `routes/workspaces.ts:617`, `routes/databases.ts:770`). There is no path
     * that deletes a page and keeps its blocks, so the cascade reproduces the
     * existing behaviour rather than adding to it.
     */
    pageId: text()
      .notNull()
      .references(() => pages.id, { onDelete: 'cascade' }),
    /**
     * Nesting inside a page (list children, toggle bodies, table rows/cells).
     *
     * CASCADE for the same reason: `DELETE /api/blocks/:id` BFS-collects
     * descendants and deletes them (`routes/blocks.ts:596-598`), and no route
     * deletes a block while keeping its children. `deleteBlockTree` still
     * deletes the recursive set explicitly, because the route reports the
     * COUNT and a cascade does not report one.
     *
     * The route also enforces that a parent block belongs to the same page as
     * its child (`routes/blocks.ts:461,539`). That could be made structural
     * with a composite `(parentBlockId, pageId) -> (id, pageId)` self-reference
     * plus a redundant unique, and deliberately is not: nothing ever moves a
     * block between pages, so there is no concurrent-write race for the
     * constraint to close, and a self-referential COMPOSITE foreign key is
     * exactly the construct drizzle-kit has been observed to drop silently from
     * both the migration and the snapshot.
     */
    parentBlockId: text().references((): AnyPgColumn => blocks.id, { onDelete: 'cascade' }),
    /**
     * `$type` so a SELECT is typed as narrowly as the CHECK below constrains
     * it, the same way `content` and `pages.properties` are. Without it a read
     * comes back as bare `string` while an insert is already narrowed by
     * `blocksRepository.CreateBlockInput`, and `routes/blocks.ts` — which
     * re-normalises content against the block's CURRENT type when only the type
     * changed — would need a cast or a guard for a state the CHECK makes
     * unreachable. It is a TypeScript annotation only: the rendered DDL is
     * byte-identical with and without it.
     */
    type: text().$type<BlockType>().notNull(),
    content: jsonb().$type<BlockContent>().notNull().default({}),
    /** Sibling ordering within `(pageId, parentBlockId)`. See `pages.order`. */
    order: doublePrecision().notNull().default(0),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    /**
     * Ported from `BlockSchema.index({ pageId: 1, parentBlockId: 1, order: 1 })`.
     * Its `pageId` prefix subsumes the standalone `pageId: index: true` the
     * Mongoose schema also declared.
     */
    index('blocks_page_parent_order_idx').on(t.pageId, t.parentBlockId, t.order),
    /**
     * NOT in the Mongoose schema. Same argument as `pages_parent_idx`:
     * `parentBlockId` is now a foreign key with a referential action and the
     * recursion column of `deleteBlockTree`.
     */
    index('blocks_parent_block_idx').on(t.parentBlockId),
    /**
     * The Mongoose `enum: BLOCK_TYPES` genuinely ran — every write is
     * `Block.create()`, `block.save()` or `Block.insertMany()`
     * (`routes/blocks.ts:485,563`, `routes/pages.ts:580`), all of which run
     * validators. The one write that does not, the reorder `bulkWrite`
     * (`routes/blocks.ts:661`), sets only `order`.
     */
    check('blocks_type', sql`${t.type} in (${sql.raw(inList(BLOCK_TYPES))})`),
  ],
);
