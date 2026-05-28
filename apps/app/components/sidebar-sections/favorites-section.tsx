import * as React from 'react';
import { View } from 'react-native';
import { useOxy } from '@oxyhq/services';
import { usePages } from '@/lib/hooks/use-pages';
import type { Page } from '@/lib/types/pages';
import { useWorkspaceStore } from '@/lib/stores/workspace-store';
import { SidebarSection } from './sidebar-section';
import { SidebarPageTree } from './sidebar-page-tree';

/**
 * Favorites — pages with `favorited === true`. The Page chrome agent (#14)
 * owns the toggle; this section consumes the field. Hidden entirely when no
 * favorites exist to avoid empty sections cluttering the sidebar.
 */
export function FavoritesSection() {
  const currentWorkspaceId = useWorkspaceStore((s) => s.currentWorkspaceId);
  const { user } = useOxy();
  const { data } = usePages(currentWorkspaceId);

  const favorites = React.useMemo<Page[]>(() => {
    if (!data?.pages) return [];
    return data.pages.filter((p) => p.favorited === true && !p.archived);
  }, [data?.pages]);

  if (favorites.length === 0) return null;
  if (!currentWorkspaceId || !user) return null;

  return (
    <SidebarSection sectionKey="favorites" title="Favorites">
      <View className="px-1">
        <SidebarPageTree
          pages={favorites}
          workspaceId={currentWorkspaceId}
          enableDrag={false}
        />
      </View>
    </SidebarSection>
  );
}
