import mongoose, { Schema, Model, Document } from 'mongoose';

/**
 * Block content payload — shape depends on `type`. Phase 1 keeps content
 * simple (no inline annotations); Phase 2+ may evolve specific variants.
 *
 * The route layer (`routes/blocks.ts`) is the source of truth for valid
 * shapes per type — it normalizes via Zod schemas before persisting.
 *
 * Documented variants (validated at the route boundary):
 *   - paragraph | heading_1..3 | bulleted_list_item | numbered_list_item | quote:
 *       { text: string }
 *   - todo:    { text: string, checked: boolean }
 *   - code:    { text: string, language: string }
 *   - callout: { text: string, icon: string }
 *   - divider: {}
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
  | 'callout';

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
