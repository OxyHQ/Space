import * as React from "react";
import {
  ActivityIndicator,
  Pressable,
  ScrollView,
  View,
} from "react-native";
import { useLocalSearchParams, useRouter } from "expo-router";
import { MessageCircle } from "lucide-react-native";
import { Text } from "@/components/ui/text";
import { Editor } from "@/components/editor/editor";
import { ShareButton } from "@/components/sharing";
import { CommentPanel } from "@/components/comments/comment-panel";
import { PageChrome, PageHeader } from "@/components/page-chrome";
import { RowPropertiesPanel } from "@/components/database/row-properties-panel";
import { useColorScheme } from "@/lib/useColorScheme";
import { usePage } from "@/lib/hooks/use-pages";
import { usePageComments } from "@/lib/hooks/use-comments";
import { useDatabase } from "@/lib/hooks/use-databases";
import { useTrackRecentPage } from "@/lib/hooks/use-track-recent-page";
import type { DatabaseRow, PropertyValue } from "@/lib/types/databases";
import type { Page } from "@/lib/types/pages";

/**
 * Page detail route. Wraps the block editor with `PageChrome` (cover + icon
 * pickers, breadcrumb, favourite star, actions menu) and renders the title /
 * cover via `PageHeader` inside the page's ScrollView so they scroll with
 * the editor content.
 *
 * Database rows get a `RowPropertiesPanel` between the header and the
 * editor; comments appear in a right-side `CommentPanel` toggled from the
 * top bar.
 */
export default function PageDetailRoute() {
  const params = useLocalSearchParams<{ pageId?: string | string[] }>();
  const pageId = Array.isArray(params.pageId) ? params.pageId[0] : params.pageId;

  if (!pageId) {
    return (
      <View className="flex-1 items-center justify-center bg-background px-6">
        <Text className="text-base text-muted-foreground">No page selected.</Text>
      </View>
    );
  }

  // Key by pageId so all child state (title draft, editor refs) resets when
  // the route param changes — no useEffect-based prop sync needed.
  return <PageDetail pageId={pageId} key={pageId} />;
}

function PageDetail({ pageId }: { pageId: string }) {
  const router = useRouter();
  const { colors } = useColorScheme();
  const { data, isLoading, isError, error } = usePage(pageId);
  const { data: commentsData } = usePageComments(pageId, false);
  useTrackRecentPage(pageId);

  const [commentPanel, setCommentPanel] = React.useState<{
    open: boolean;
    focusedBlockId: string | null;
  }>({ open: false, focusedBlockId: null });

  const openCommentCount = React.useMemo(() => {
    const comments = commentsData?.comments ?? [];
    return comments.filter(
      (c) => c.parentCommentId === null && c.resolvedAt === null,
    ).length;
  }, [commentsData?.comments]);

  const handleOpenPanel = (focusedBlockId: string | null = null) => {
    setCommentPanel({ open: true, focusedBlockId });
  };

  if (isLoading) {
    return (
      <View className="flex-1 items-center justify-center bg-background">
        <ActivityIndicator color={colors.mutedForeground} />
      </View>
    );
  }

  if (isError || !data?.page) {
    const message =
      error instanceof Error ? error.message : "We couldn’t load this page.";
    return (
      <View className="flex-1 items-center justify-center bg-background px-6">
        <View className="max-w-md items-center gap-3">
          <Text className="text-base text-foreground">{message}</Text>
          <Pressable
            onPress={() => router.replace("/(app)")}
            className="rounded-md bg-primary px-4 py-2"
          >
            <Text className="text-sm font-medium text-primary-foreground">
              Back to workspace
            </Text>
          </Pressable>
        </View>
      </View>
    );
  }

  const page = data.page;

  const rightHeader = (
    <View className="flex-row items-center gap-2">
      <Pressable
        onPress={() => handleOpenPanel(null)}
        accessibilityLabel="Open comments"
        className="flex-row items-center gap-1.5 rounded-md px-2 py-1 hover:bg-muted"
      >
        <MessageCircle size={14} color={colors.foreground} />
        <Text className="text-xs font-medium text-foreground">
          {openCommentCount > 0 ? openCommentCount : ""} Comments
        </Text>
      </Pressable>
      <ShareButton pageId={page._id} />
    </View>
  );

  return (
    <PageChrome page={page} rightHeader={rightHeader}>
      <View className="flex-1 flex-row">
        <ScrollView
          className="flex-1"
          contentContainerClassName="pb-12"
          keyboardShouldPersistTaps="handled"
        >
          <PageHeader page={page} />
          <View className="px-6 md:px-10 max-w-3xl w-full mx-auto pt-4">
            <DatabaseRowProperties page={page} />
            <Editor
              pageId={page._id}
              onOpenBlockComments={(blockId) => handleOpenPanel(blockId)}
            />
          </View>
        </ScrollView>

        <CommentPanel
          pageId={page._id}
          workspaceId={page.workspaceId}
          open={commentPanel.open}
          focusedBlockId={commentPanel.focusedBlockId}
          onClose={() =>
            setCommentPanel({ open: false, focusedBlockId: null })
          }
        />
      </View>
    </PageChrome>
  );
}

/**
 * Renders the database row property panel when the underlying page is a
 * database row (`databaseId` is set). Lazy-loads the parent database so
 * the schema is available for the property cells.
 *
 * Returns `null` if this page is a regular doc — leaves the existing
 * editor layout untouched.
 */
function DatabaseRowProperties({ page }: { page: Page }) {
  const databaseId =
    typeof page.databaseId === "string" ? page.databaseId : null;
  const { data } = useDatabase(databaseId ?? undefined);
  if (!databaseId || !data?.database) return null;
  const row: DatabaseRow = {
    id: page._id,
    _id: page._id,
    workspaceId: page.workspaceId,
    parentId: page.parentId,
    databaseId,
    title: page.title,
    icon: page.icon ?? null,
    cover: page.cover ?? null,
    ownerId: page.ownerId,
    archived: page.archived,
    order: 0,
    properties: (page.properties ?? {}) as Record<string, PropertyValue>,
    createdAt: page.createdAt,
    updatedAt: page.updatedAt,
  };
  return (
    <View className="pb-6 border-b border-border/30 mb-4">
      <RowPropertiesPanel database={data.database} row={row} />
    </View>
  );
}
