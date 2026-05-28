import * as React from 'react';
import { View } from 'react-native';
import { usePathname } from 'expo-router';
import { Text } from '@/components/ui/text';
import { useUpdatePage } from '@/lib/hooks/use-pages';
import type { Page } from '@/lib/types/pages';
import { SidebarPageRow } from './page-row';
import {
  PageDragProvider,
  type DragMutation,
} from './drag-context';

interface SidebarPageTreeProps {
  /** Flat list of pages to organize into a tree. */
  pages: Page[];
  /** Workspace context (used for invalidation by mutations). */
  workspaceId: string;
  /** Empty-state copy when no pages match. */
  emptyText?: string;
  /** Whether drag-to-reorder is enabled for this tree. */
  enableDrag?: boolean;
}

interface TreeNode {
  page: Page;
  children: TreeNode[];
}

function buildLocalTree(pages: Page[]): TreeNode[] {
  const lookup = new Map<string, TreeNode>();
  for (const p of pages) lookup.set(p._id, { page: p, children: [] });
  const roots: TreeNode[] = [];
  for (const p of pages) {
    const node = lookup.get(p._id);
    if (!node) continue;
    if (p.parentId && lookup.has(p.parentId)) {
      lookup.get(p.parentId)?.children.push(node);
    } else {
      roots.push(node);
    }
  }
  const orderCompare = (a: TreeNode, b: TreeNode) => {
    const ao = a.page.order ?? 0;
    const bo = b.page.order ?? 0;
    if (ao !== bo) return ao - bo;
    return (
      new Date(b.page.updatedAt).getTime() -
      new Date(a.page.updatedAt).getTime()
    );
  };
  roots.sort(orderCompare);
  for (const n of lookup.values()) n.children.sort(orderCompare);
  return roots;
}

/**
 * Renders an indented tree of page rows from a filtered list of pages. Handles
 * local expand/collapse state and resolves drag drops to PATCH calls against
 * the pages API.
 */
export function SidebarPageTree({
  pages,
  workspaceId,
  emptyText,
  enableDrag = true,
}: SidebarPageTreeProps) {
  const pathname = usePathname();
  const updatePage = useUpdatePage();
  const [expanded, setExpanded] = React.useState<Record<string, boolean>>({});

  const roots = React.useMemo(() => buildLocalTree(pages), [pages]);
  const pagesById = React.useMemo(() => {
    const m = new Map<string, Page>();
    for (const p of pages) m.set(p._id, p);
    return m;
  }, [pages]);

  const handleCommit = React.useCallback(
    ({ sourceId, targetId, position }: DragMutation) => {
      if (sourceId === targetId) return;
      const target = pagesById.get(targetId);
      const source = pagesById.get(sourceId);
      if (!target || !source) return;

      // Prevent cycles: don't allow dropping onto own descendant.
      if (position === 'inside' || position === 'before' || position === 'after') {
        let cursor: Page | undefined = target;
        while (cursor) {
          if (cursor._id === sourceId) return;
          if (!cursor.parentId) break;
          cursor = pagesById.get(cursor.parentId);
        }
      }

      // Determine new parentId + order.
      let newParentId: string | null;
      let newOrder: number;
      if (position === 'inside') {
        newParentId = target._id;
        const siblings = pages
          .filter((p) => p.parentId === target._id)
          .map((p) => p.order ?? 0);
        newOrder = (siblings.length ? Math.max(...siblings) : -1) + 1;
      } else {
        newParentId = target.parentId ?? null;
        const targetOrder = target.order ?? 0;
        newOrder = position === 'before' ? targetOrder - 0.5 : targetOrder + 0.5;
      }

      updatePage.mutate({
        id: sourceId,
        parentId: newParentId,
        order: newOrder,
      });
    },
    [pages, pagesById, updatePage],
  );

  if (pages.length === 0) {
    if (!emptyText) return null;
    return (
      <View className="px-4 py-1.5">
        <Text className="text-xs text-muted-foreground">{emptyText}</Text>
      </View>
    );
  }

  return (
    <PageDragProvider onCommit={handleCommit}>
      <View>
        {roots.map((node) => (
          <TreeNodeRow
            key={node.page._id}
            node={node}
            depth={0}
            activePath={pathname}
            workspaceId={workspaceId}
            expanded={expanded}
            setExpanded={setExpanded}
            enableDrag={enableDrag}
            onCommit={handleCommit}
          />
        ))}
      </View>
    </PageDragProvider>
  );
}

interface TreeNodeRowProps {
  node: TreeNode;
  depth: number;
  activePath: string;
  workspaceId: string;
  expanded: Record<string, boolean>;
  setExpanded: React.Dispatch<React.SetStateAction<Record<string, boolean>>>;
  enableDrag: boolean;
  onCommit: (mutation: DragMutation) => void;
}

function TreeNodeRow({
  node,
  depth,
  activePath,
  workspaceId,
  expanded,
  setExpanded,
  enableDrag,
  onCommit,
}: TreeNodeRowProps) {
  const isOpen = Boolean(expanded[node.page._id]);
  const hasChildren = node.children.length > 0;
  const isActive = activePath === `/p/${node.page._id}`;

  const handleDrop = React.useCallback(
    (sourceId: string, position: 'before' | 'after' | 'inside') => {
      onCommit({ sourceId, targetId: node.page._id, position });
    },
    [node.page._id, onCommit],
  );

  return (
    <View>
      <SidebarPageRow
        page={node.page}
        depth={depth}
        hasChildren={hasChildren}
        isOpen={isOpen}
        onToggle={() =>
          setExpanded((prev) => ({
            ...prev,
            [node.page._id]: !prev[node.page._id],
          }))
        }
        isActive={isActive}
        workspaceId={workspaceId}
        enableDrag={enableDrag}
        onDrop={handleDrop}
      />
      {isOpen
        ? node.children.map((child) => (
            <TreeNodeRow
              key={child.page._id}
              node={child}
              depth={depth + 1}
              activePath={activePath}
              workspaceId={workspaceId}
              expanded={expanded}
              setExpanded={setExpanded}
              enableDrag={enableDrag}
              onCommit={onCommit}
            />
          ))
        : null}
    </View>
  );
}
