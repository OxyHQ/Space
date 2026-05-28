import * as React from 'react';
import { View } from 'react-native';
import { useOxy } from '@oxyhq/services';
import { usePages } from '@/lib/hooks/use-pages';
import { useWorkspaceStore } from '@/lib/stores/workspace-store';
import type { Page } from '@/lib/types/pages';
import { SidebarSection } from './sidebar-section';
import { SidebarPageTree } from './sidebar-page-tree';

/**
 * Shared — pages in the active workspace that the current user did NOT create
 * but has access to via workspace membership. Hidden when the user is the
 * sole creator of every visible page.
 */
export function SharedSection() {
  const currentWorkspaceId = useWorkspaceStore((s) => s.currentWorkspaceId);
  const { user } = useOxy();
  const { data } = usePages(currentWorkspaceId);

  const sharedPages = React.useMemo<Page[]>(() => {
    if (!data?.pages || !user) return [];
    return data.pages.filter(
      (p) => p.ownerId !== user.id && !p.archived,
    );
  }, [data?.pages, user]);

  if (sharedPages.length === 0) return null;
  if (!currentWorkspaceId) return null;

  return (
    <SidebarSection sectionKey="shared" title="Shared">
      <View className="px-1">
        <SidebarPageTree
          pages={sharedPages}
          workspaceId={currentWorkspaceId}
          enableDrag={false}
        />
      </View>
    </SidebarSection>
  );
}
