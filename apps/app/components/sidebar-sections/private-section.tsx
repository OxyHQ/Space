import * as React from 'react';
import { View, ActivityIndicator } from 'react-native';
import { useRouter } from 'expo-router';
import { useOxy } from '@oxyhq/services';
import { Text } from '@/components/ui/text';
import { useWorkspaceStore } from '@/lib/stores/workspace-store';
import { useCreatePage, usePages } from '@/lib/hooks/use-pages';
import type { Page } from '@/lib/types/pages';
import { SidebarSection } from './sidebar-section';
import { SidebarPageTree } from './sidebar-page-tree';

/**
 * Private — pages owned by the current user. Mirrors Notion's "Private" tray:
 * a place where pages the signed-in user created live. Pages they were
 * invited to (but didn't create) show up in `<SharedSection />` instead.
 */
export function PrivateSection() {
  const router = useRouter();
  const currentWorkspaceId = useWorkspaceStore((s) => s.currentWorkspaceId);
  const { user } = useOxy();
  const { data, isLoading, isError } = usePages(currentWorkspaceId);
  const createPage = useCreatePage();

  const myPages = React.useMemo<Page[]>(() => {
    if (!data?.pages || !user) return [];
    return data.pages.filter(
      (p) => p.ownerId === user.id && !p.archived,
    );
  }, [data?.pages, user]);

  const handleCreate = React.useCallback(async () => {
    if (!currentWorkspaceId) return;
    try {
      const page = await createPage.mutateAsync({
        workspaceId: currentWorkspaceId,
        parentId: null,
        title: '',
      });
      router.push(`/p/${page._id}`);
    } catch {
      /* mutation surfaces errors via state */
    }
  }, [createPage, currentWorkspaceId, router]);

  if (!currentWorkspaceId) return null;

  return (
    <SidebarSection
      sectionKey="private"
      title="Private"
      onAdd={handleCreate}
      adding={createPage.isPending}
    >
      <View className="px-1">
        {isLoading ? (
          <View className="px-3 py-2 flex-row items-center gap-2">
            <ActivityIndicator size="small" />
            <Text className="text-xs text-muted-foreground">Loading…</Text>
          </View>
        ) : isError ? (
          <View className="px-3 py-2">
            <Text className="text-xs text-destructive">
              Couldn’t load pages.
            </Text>
          </View>
        ) : (
          <SidebarPageTree
            pages={myPages}
            workspaceId={currentWorkspaceId}
            emptyText="No private pages yet."
          />
        )}
      </View>
    </SidebarSection>
  );
}
