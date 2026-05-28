import type { ComponentType } from 'react';

export type CommandPaletteItemKind = 'page' | 'member' | 'command';

interface BaseItem {
  kind: CommandPaletteItemKind;
  id: string;
  /** Free-text used for fuzzy matching. */
  searchValue: string;
  /** Primary label rendered in the result row. */
  title: string;
  /** Optional secondary label (breadcrumb, email, description). */
  subtitle?: string;
}

export interface PageItem extends BaseItem {
  kind: 'page';
  pageId: string;
  icon?: string | null;
  breadcrumb?: string;
}

export interface MemberItem extends BaseItem {
  kind: 'member';
  email?: string | null;
  username?: string | null;
  avatar?: string | null;
  /** Optional Oxy user id; we surface it for the future "open profile" action. */
  userId?: string;
}

export interface CommandAction {
  /** Stable id used by cmdk. */
  id: string;
  title: string;
  subtitle?: string;
  /** Lucide icon component. */
  icon?: ComponentType<{ size?: number; color?: string; className?: string }>;
  /** Display shortcut hint (e.g., `Cmd N`). */
  shortcut?: string;
  /** Synchronous handler invoked on selection. */
  onSelect: () => void;
}

export interface CommandItem extends BaseItem, Omit<CommandAction, 'id' | 'title' | 'subtitle'> {
  kind: 'command';
}

export type AnyCommandItem = PageItem | MemberItem | CommandItem;
