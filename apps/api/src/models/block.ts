import mongoose, { Schema, Model, Document } from 'mongoose';

/**
 * Block content payload — shape depends on `type`. The route layer
 * (`routes/blocks.ts`) is the source of truth for valid shapes and
 * normalizes via Zod schemas before persisting.
 *
 * Phase 2 (editor v2) adds:
 *   - `toggle` block type with `{ text, segments, expanded }`
 *   - rich-text `segments: Segment[]` alongside plain `text` for text blocks
 *     (text remains the canonical plain-text fallback for clients that don't
 *     read segments yet — both stay in sync on write)
 *   - optional block-level `color` / `backgroundColor` (Notion-style named
 *     colors: default, gray, brown, orange, yellow, green, blue, purple,
 *     pink, red)
 *
 * Documented variants (validated at the route boundary):
 *   - paragraph | heading_1..3 | bulleted_list_item | numbered_list_item | quote:
 *       { text: string, segments?: Segment[], color?, backgroundColor? }
 *   - todo:    { text, segments?, checked, color?, backgroundColor? }
 *   - code:    { text, language, color?, backgroundColor? }
 *   - callout: { text, segments?, icon, color?, backgroundColor? }
 *   - toggle:  { text, segments?, expanded, color?, backgroundColor? }
 *   - divider: { color?, backgroundColor? }
 *
 * Phase 3 (more block types) adds:
 *   - image:        { url, caption?, alt?, width?, alignment? }
 *   - video:        { url, source: 'upload'|'youtube'|'vimeo'|'loom'|'other', caption? }
 *   - audio:        { url, caption? }
 *   - file:         { url, name, size, mimeType }
 *   - pdf:          { url }
 *   - bookmark:     { url, title?, description?, image?, favicon? }
 *   - embed:        { url, source? }
 *   - columns:      { columnCount: 2|3|4 } (container; children are `column` blocks)
 *   - column:       { } (container; children are normal blocks)
 *   - table:        { rows, cols, withHeader } (children are table_row → table_cell)
 *   - table_row:    { } (children are table_cell)
 *   - table_cell:   { text, segments? }
 *   - button:       { label, action, ...params }
 *   - link_to_page: { pageId }
 *   - sync_block:   { sourceBlockId }
 *   - breadcrumb:   { }
 *   - table_of_contents: { }
 *   - equation:     { latex }
 *   - mermaid:      { code }
 *
 * Phase 4 (databases) adds:
 *   - inline_database: { databaseId, viewId? } — renders an embedded
 *     database view (the actual data lives in the Database + Page rows
 *     models, not in the block's content). Phase 4 owns the renderer.
 *
 * Segments enable inline formatting (bold/italic/underline/strike/code/link)
 * and per-segment text/background color without exposing rich text to APIs
 * that only consume plain `text`.
 */
/**
 * `Segment`, `BlockColor` and `BLOCK_COLORS` used to live here and now live in
 * `routes/blocks.ts`, the only thing that ever read them. They were content
 * VOCABULARY co-located with a storage model — the class of export that keeps a
 * ported route importing its old model for a reason unrelated to the model, and
 * that breaks silently the day the module is deleted. `Segment` had no consumer
 * at all.
 */
export type BlockContent = Record<string, unknown>;

export type BlockType =
  | 'paragraph'
  | 'heading_1'
  | 'heading_2'
  | 'heading_3'
  | 'bulleted_list_item'
  | 'numbered_list_item'
  | 'todo'
  | 'quote'
  | 'divider'
  | 'code'
  | 'callout'
  | 'toggle'
  // Media
  | 'image'
  | 'video'
  | 'audio'
  | 'file'
  | 'pdf'
  // Embeds
  | 'bookmark'
  | 'embed'
  // Layout
  | 'columns'
  | 'column'
  | 'table'
  | 'table_row'
  | 'table_cell'
  // Interactive
  | 'button'
  | 'link_to_page'
  | 'sync_block'
  | 'breadcrumb'
  | 'table_of_contents'
  // Math + diagram
  | 'equation'
  | 'mermaid'
  // Database
  | 'inline_database';

export const BLOCK_TYPES: readonly BlockType[] = [
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

/**
 * Block — atomic content unit inside a Page.
 * Belongs to a single `pageId`, optionally nested under a `parentBlockId`
 * (used for nested lists / toggle children).
 */
export interface IBlock extends Document {
  pageId: mongoose.Types.ObjectId;
  parentBlockId: mongoose.Types.ObjectId | null;
  type: BlockType;
  content: BlockContent;
  order: number;
  createdAt: Date;
  updatedAt: Date;
}

const BlockSchema = new Schema<IBlock>(
  {
    pageId: {
      type: Schema.Types.ObjectId,
      ref: 'Page',
      required: true,
      index: true,
    },
    parentBlockId: {
      type: Schema.Types.ObjectId,
      ref: 'Block',
      default: null,
    },
    type: {
      type: String,
      enum: BLOCK_TYPES,
      required: true,
    },
    content: {
      type: Schema.Types.Mixed,
      required: true,
      default: () => ({}),
    },
    order: {
      type: Number,
      required: true,
      default: 0,
    },
  },
  {
    timestamps: true,
  },
);

// Ordering / nesting queries on a single page.
BlockSchema.index({ pageId: 1, parentBlockId: 1, order: 1 });

export const Block: Model<IBlock> =
  mongoose.models.Block || mongoose.model<IBlock>('Block', BlockSchema);

export default Block;
