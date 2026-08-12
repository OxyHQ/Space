import * as React from "react";
import { ActivityIndicator, Pressable, View } from "react-native";
import { Plus } from "lucide-react-native";
import { Redirect, useRouter } from "expo-router";
import { useOxy } from "@oxyhq/services";
import { Text } from "@/components/ui/text";
import { useColorScheme } from "@/lib/useColorScheme";
import { useWorkspaceStore } from "@/lib/stores/workspace-store";
import { useCreatePage, usePages } from "@/lib/hooks/use-pages";

/**
 * Landing screen — if the user has pages in the active workspace, redirect
 * to the most recently updated one. Otherwise show a "create first page" CTA.
 */
export default function HomePage() {
  const { colors } = useColorScheme();
  const router = useRouter();
  const { isAuthenticated } = useOxy();
  const currentWorkspaceId = useWorkspaceStore((s) => s.currentWorkspaceId);
  const { data, isLoading } = usePages(currentWorkspaceId);
  const createPage = useCreatePage();

  const mostRecent = React.useMemo(() => {
    if (!data?.pages || data.pages.length === 0) return null;
    const sorted = [...data.pages]
      .filter((p) => !p.archived)
      .sort(
        (a, b) =>
          new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime(),
      );
    return sorted[0] ?? null;
  }, [data?.pages]);

  if (mostRecent) {
    return <Redirect href={`/p/${mostRecent._id}`} />;
  }

  const handleCreate = async () => {
    if (!currentWorkspaceId) return;
    try {
      const page = await createPage.mutateAsync({
        workspaceId: currentWorkspaceId,
        parentId: null,
        title: "",
      });
      router.push(`/p/${page._id}`);
    } catch {
      // mutation surfaces via state.
    }
  };

  return (
    <View className="flex-1 items-center justify-center bg-background px-6">
      <View className="max-w-md items-center gap-4">
        <Text className="text-3xl font-semibold text-foreground text-center">
          Oxy Station
        </Text>

        {!isAuthenticated ? (
          <Text className="text-base text-muted-foreground text-center">
            Sign in to start building your workspace.
          </Text>
        ) : !currentWorkspaceId ? (
          <Text className="text-base text-muted-foreground text-center">
            Select a workspace from the sidebar to get started.
          </Text>
        ) : isLoading ? (
          <ActivityIndicator color={colors.mutedForeground} />
        ) : (
          <>
            <Text className="text-base text-muted-foreground text-center">
              Your workspace is empty. Create your first page to begin.
            </Text>
            <Pressable
              onPress={handleCreate}
              disabled={createPage.isPending}
              className="flex-row items-center gap-2 rounded-xl bg-primary px-4 py-3"
            >
              <Plus size={16} color={colors.primaryForeground} />
              <Text className="text-sm font-semibold text-primary-foreground">
                {createPage.isPending ? "Creating…" : "Create your first page"}
              </Text>
            </Pressable>
          </>
        )}
      </View>
    </View>
  );
}
