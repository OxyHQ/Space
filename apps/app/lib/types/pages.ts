/**
 * Shared types for Pages and Blocks (Phase 1).
 *
 * Mirrors the contract owned by the Phase 1 backend agent. Kept narrow on
 * purpose — Phase 3 (real-time collab) will extend Block content shapes.
 */

export interface Page {
  _id: string;
  workspaceId: string;
  parentId: string | null;
  ownerId: string;
  title: string;
  icon?: string | null;
  cover?: string | null;
  archived: boolean;
  createdAt: string;
  updatedAt: string;
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
  | "callout";

/**
 * Block content is type-specific. Phase 1 stores plain text (no inline
 * annotations) — `text` is the canonical field for text blocks. Type-specific
 * extras (checked, language, emoji) live alongside it.
 */
export interface BlockContent {
  text?: string;
  checked?: boolean;
  language?: string;
  emoji?: string;
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
