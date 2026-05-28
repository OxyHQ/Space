/**
 * Shared types for Pages and Blocks.
 *
 * Mirrors the contract owned by the backend (apps/api/src/models/block.ts +
 * routes/blocks.ts). Phase 2 (editor v2) adds:
 *   - `toggle` block type
 *   - inline rich-text `Segment[]` alongside plain `text`
 *   - block-level `color` / `backgroundColor` (Notion named colors)
 *
 * Frontend uses `"to_do"` as the BlockType name because that's what the
 * existing UI already shipped; backend stores `"todo"`. The route serializer
 * normalizes — see `mapBlockType` in `use-blocks.ts` if a future cleanup
 * unifies them. Today the type string is identical on both sides for every
 * type except todo, and `to_do` is the frontend canonical name.
 */

export interface Page {
  _id: string;
  workspaceId: string;
  parentId: string | null;
  ownerId: string;
  title: string;
  icon?: string | null;
  cover?: string | null;
  /** 0–100, vertical focal point used when cropping the cover image. */
  coverPosition?: number;
  archived: boolean;
  /**
   * Owned by Page-chrome agent (#14). Sidebar reads this to populate the
   * Favorites section; safe to be undefined until the backend ships the field.
   */
  favorited?: boolean;
  /** Sibling order within the same parent. Used by drag-to-reorder. */
  order?: number;
  createdAt: string;
  updatedAt: string;
  /**
   * Phase 4 — Databases. When `databaseId` is non-null this Page is a
   * row in that database. `properties` carries typed property values
   * keyed by propertyId. Regular doc pages omit both fields.
   */
  databaseId?: string | null;
  properties?: Record<string, unknown>;
}

/** Slim ancestor record returned by GET /pages/:id/breadcrumb. */
export interface BreadcrumbEntry {
  id: string;
  title: string;
  icon: string | null;
}

export interface BreadcrumbResponse {
  breadcrumb: BreadcrumbEntry[];
}

export interface PageNode extends Page {
  children: PageNode[];
}

export type BlockType =
  | "paragraph"
  | "heading_1"
  | "heading_2"
  | "heading_3"
  | "bulleted_list_item"
  | "numbered_list_item"
  | "to_do"
  | "quote"
  | "divider"
  | "code"
  | "callout"
  | "toggle"
  // Media
  | "image"
  | "video"
  | "audio"
  | "file"
  | "pdf"
  // Embeds
  | "bookmark"
  | "embed"
  // Layout
  | "columns"
  | "column"
  | "table"
  | "table_row"
  | "table_cell"
  // Interactive
  | "button"
  | "link_to_page"
  | "sync_block"
  | "breadcrumb"
  | "table_of_contents"
  // Math + diagram
  | "equation"
  | "mermaid"
  // Database
  | "inline_database";

export type BlockColor =
  | "default"
  | "gray"
  | "brown"
  | "orange"
  | "yellow"
  | "green"
  | "blue"
  | "purple"
  | "pink"
  | "red";

export const BLOCK_COLORS: readonly BlockColor[] = [
  "default",
  "gray",
  "brown",
  "orange",
  "yellow",
  "green",
  "blue",
  "purple",
  "pink",
  "red",
];

/**
 * Inline rich-text run. The editor stores `Segment[]` on every text block;
 * `text` is kept as the flattened plain-string mirror for callers (e.g.
 * search / exports) that don't read segments.
 */
export interface Segment {
  text: string;
  bold?: boolean;
  italic?: boolean;
  underline?: boolean;
  strike?: boolean;
  code?: boolean;
  color?: BlockColor;
  background?: BlockColor;
  link?: string;
}

export type VideoSource = "upload" | "youtube" | "vimeo" | "loom" | "other";
export type ImageAlignment = "left" | "center" | "right" | "full";
export type ButtonAction =
  | "duplicate-template"
  | "new-page"
  | "navigate"
  | "webhook";

/**
 * Block content is type-specific. Phase 2 extends with inline `segments[]`
 * and block-level color metadata; Phase 3 adds media, embed, layout, and
 * interactive block fields. All fields are optional so this single interface
 * stays usable across every variant; the backend route enforces the exact
 * shape per type.
 */
export interface BlockContent {
  text?: string;
  segments?: Segment[];
  checked?: boolean;
  language?: string;
  emoji?: string;
  icon?: string;
  expanded?: boolean;
  color?: BlockColor;
  backgroundColor?: BlockColor;
  // Media / embed
  url?: string;
  caption?: string;
  alt?: string;
  width?: number;
  alignment?: ImageAlignment;
  source?: string | VideoSource;
  name?: string;
  size?: number;
  mimeType?: string;
  title?: string;
  description?: string;
  image?: string;
  favicon?: string;
  // Layout
  columnCount?: 2 | 3 | 4;
  ratio?: number;
  rows?: number;
  cols?: number;
  withHeader?: boolean;
  // Interactive
  label?: string;
  action?: ButtonAction;
  pageId?: string;
  templateId?: string;
  webhookUrl?: string;
  sourceBlockId?: string;
  // Math + diagram
  latex?: string;
  code?: string;
  // Database (inline_database)
  databaseId?: string;
  viewId?: string;
}

export interface Block {
  _id: string;
  pageId: string;
  parentBlockId: string | null;
  type: BlockType;
  content: BlockContent;
  order: number;
  createdAt: string;
  updatedAt: string;
}

export interface PagesListResponse {
  pages: Page[];
}

export interface PageResponse {
  page: Page;
}

export interface BlocksListResponse {
  blocks: Block[];
}

export interface BlockResponse {
  block: Block;
}
