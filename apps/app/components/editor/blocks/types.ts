/**
 * Shared types for per-block-type renderers. Each renderer takes the Block
 * plus a small surface for committing content edits — keeps the dispatcher
 * (`block.tsx`) and the editor itself free of per-type plumbing.
 */
import type * as React from "react";
import type { Block, BlockContent, BlockType } from "@/lib/types/pages";

export interface BlockComponentProps {
  block: Block;
  /** Patch the block's `content`. Editor debounces save. */
  onChangeContent: (next: BlockContent) => void;
  /** Optional: change the block's type (used by callers like upload buttons). */
  onChangeType?: (type: BlockType) => void;
  /** True when the block was just created / clicked into. */
  autoFocus?: boolean;
  /** Read-only render (e.g. share-link preview). */
  readOnly?: boolean;
  /**
   * Container-block hook — returns the rendered child blocks of the given
   * parent id (their `parentBlockId === parentId`). Editor wires this so
   * containers like columns / table don't need to know about block lists.
   * When omitted, containers render an inline placeholder.
   */
  renderChildren?: (parentId: string) => React.ReactNode;
}
