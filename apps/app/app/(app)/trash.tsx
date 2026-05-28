import * as React from "react";
import {
  ActivityIndicator,
  Pressable,
  ScrollView,
  View,
} from "react-native";
import { useRouter } from "expo-router";
import { useOxy } from "@oxyhq/services";
import { RotateCcw, Trash2 } from "lucide-react-native";
import { Text } from "@/components/ui/text";
import { Button } from "@/components/ui/button";
import { ConfirmationDialog } from "@/components/ui/confirmation-dialog";
import { toast } from "@/components/sonner";
import { useColorScheme } from "@/lib/useColorScheme";
import { useWorkspaceStore } from "@/lib/stores/workspace-store";
import { useWorkspace } from "@/lib/hooks/use-workspaces";
import {
  useArchivedPages,
  useDeletePage,
  useEmptyTrash,
  useUpdatePage,
} from "@/lib/hooks/use-pages";
import { IconDisplay } from "@/components/page-chrome";
import type { Page } from "@/lib/types/pages";

/**
 * Trash route. Lists every archived page in the active workspace and lets
 * the user restore or permanently delete each one. Owners additionally see
 * an "Empty trash" button at the top.
 */
export default function TrashRoute() {
  const router = useRouter();
  const { colors } = useColorScheme();
  const { user } = useOxy();
  const currentWorkspaceId = useWorkspaceStore((s) => s.currentWorkspaceId);
  const { data: workspace } = useWorkspace(currentWorkspaceId ?? undefined);
  const { data, isLoading } = useArchivedPages(currentWorkspaceId);
  const updatePage = useUpdatePage();
  const deletePage = useDeletePage();
  const emptyTrash = useEmptyTrash();

  const [emptyOpen, setEmptyOpen] = React.useState(false);
  const [deleteTarget, setDeleteTarget] = React.useState<Page | null>(null);

  const pages = React.useMemo(() => {
    const list = data?.pages ?? [];
    return [...list].sort(
      (a, b) =>
        new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime(),
    );
  }, [data?.pages]);

  const isOwner = workspace?.ownerId === user?.id;

  const handleRestore = React.useCallback(
    (page: Page) => {
      updatePage.mutate(
        { id: page._id, archived: false },
        {
          onSuccess: () => toast.success("Page restored"),
          onError: (err) => toast.error(err.message || "Failed to restore"),
        },
      );
    },
    [updatePage],
  );

  const handleHardDelete = React.useCallback(() => {
    if (!deleteTarget || !currentWorkspaceId) return;
    const target = deleteTarget;
    deletePage.mutate(
      { id: target._id, workspaceId: currentWorkspaceId, hard: true },
      {
        onSuccess: () => {
          toast.success("Page deleted permanently");
        },
        onError: (err) => {
          toast.error(err.message || "Failed to delete page");
        },
      },
    );
    setDeleteTarget(null);
  }, [deleteTarget, currentWorkspaceId, deletePage]);

  const handleEmptyTrash = React.useCallback(() => {
    if (!currentWorkspaceId) return;
    emptyTrash.mutate(
      { workspaceId: currentWorkspaceId },
      {
        onSuccess: (result) => {
          toast.success(`Removed ${result.deleted} page${result.deleted === 1 ? "" : "s"}`);
        },
        onError: (err) => {
          toast.error(err.message || "Failed to empty trash");
        },
      },
    );
  }, [emptyTrash, currentWorkspaceId]);

  if (!currentWorkspaceId) {
    return (
      <View className="flex-1 items-center justify-center bg-background px-6">
        <Text className="text-base text-muted-foreground">
          Select a workspace to view trash.
        </Text>
      </View>
    );
  }

  return (
    <View className="flex-1 bg-background">
      {/* Header */}
      <View className="flex-row items-center justify-between border-b border-border/30 px-4 py-3 md:px-8">
        <View>
          <Text className="text-lg font-semibold text-foreground">Trash</Text>
          <Text className="text-xs text-muted-foreground">
            Archived pages live here for 30 days, then are deleted forever.
          </Text>
        </View>
        {isOwner ? (
          <Button
            variant="outline"
            size="sm"
            onPress={() => setEmptyOpen(true)}
            disabled={emptyTrash.isPending || pages.length === 0}
            className="h-9"
          >
            <View className="flex-row items-center gap-1.5">
              <Trash2 size={14} color={colors.foreground} />
              <Text className="text-sm font-medium">Empty trash</Text>
            </View>
          </Button>
        ) : null}
      </View>

      {isLoading ? (
        <View className="flex-1 items-center justify-center">
          <ActivityIndicator color={colors.mutedForeground} />
        </View>
      ) : pages.length === 0 ? (
        <View className="flex-1 items-center justify-center px-6">
          <Text className="text-sm text-muted-foreground">
            Trash is empty.
          </Text>
        </View>
      ) : (
        <ScrollView className="flex-1" contentContainerClassName="px-4 py-3 md:px-8">
          {pages.map((page) => (
            <TrashRow
              key={page._id}
              page={page}
              onRestore={() => handleRestore(page)}
              onHardDelete={() => setDeleteTarget(page)}
              canHardDelete={isOwner || page.ownerId === user?.id}
            />
          ))}
        </ScrollView>
      )}

      <ConfirmationDialog
        open={emptyOpen}
        onOpenChange={setEmptyOpen}
        title="Empty trash?"
        description={`This will permanently delete ${pages.length} page${pages.length === 1 ? "" : "s"} and every block they contain.`}
        confirmText="Empty trash"
        confirmVariant="destructive"
        loading={emptyTrash.isPending}
        onConfirm={handleEmptyTrash}
      />
      <ConfirmationDialog
        open={Boolean(deleteTarget)}
        onOpenChange={(next) => {
          if (!next) setDeleteTarget(null);
        }}
        title="Delete permanently?"
        description={`“${deleteTarget?.title || "Untitled"}” will be removed forever.`}
        confirmText="Delete"
        confirmVariant="destructive"
        loading={deletePage.isPending}
        onConfirm={handleHardDelete}
      />
    </View>
  );
}

interface TrashRowProps {
  page: Page;
  onRestore: () => void;
  onHardDelete: () => void;
  canHardDelete: boolean;
}
function TrashRow({
  page,
  onRestore,
  onHardDelete,
  canHardDelete,
}: TrashRowProps) {
  const router = useRouter();
  const { colors } = useColorScheme();

  return (
    <View className="flex-row items-center gap-3 rounded-md border border-border/40 px-3 py-2 mb-2 hover:bg-muted/40">
      <Pressable
        onPress={() => router.push(`/p/${page._id}`)}
        accessibilityLabel={`Open ${page.title || "Untitled"}`}
        className="h-8 w-8 items-center justify-center rounded-md"
      >
        <IconDisplay value={page.icon} size={20} showPlaceholder />
      </Pressable>
      <Pressable
        onPress={() => router.push(`/p/${page._id}`)}
        className="flex-1 min-w-0"
      >
        <Text className="text-sm font-medium text-foreground" numberOfLines={1}>
          {page.title.trim() || "Untitled"}
        </Text>
        <Text className="text-xs text-muted-foreground">
          Archived {formatTime(page.updatedAt)}
        </Text>
      </Pressable>
      <Pressable
        onPress={onRestore}
        accessibilityLabel="Restore page"
        className="h-8 flex-row items-center gap-1 rounded-md border border-border px-2 hover:bg-muted"
      >
        <RotateCcw size={14} color={colors.foreground} />
        <Text className="text-xs font-medium text-foreground">Restore</Text>
      </Pressable>
      {canHardDelete ? (
        <Pressable
          onPress={onHardDelete}
          accessibilityLabel="Delete page permanently"
          className="h-8 flex-row items-center gap-1 rounded-md border border-border px-2 hover:bg-destructive/10"
        >
          <Trash2 size={14} color={colors.foreground} />
          <Text className="text-xs font-medium text-foreground">Delete</Text>
        </Pressable>
      ) : null}
    </View>
  );
}

function formatTime(iso: string): string {
  try {
    return new Date(iso).toLocaleString();
  } catch {
    return iso;
  }
}
