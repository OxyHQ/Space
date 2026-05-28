import * as React from "react";
import {
  ActivityIndicator,
  Modal,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  View,
} from "react-native";
import { CheckCheck, MessageCircle, X } from "lucide-react-native";
import { Text } from "@/components/ui/text";
import { useColorScheme } from "@/lib/useColorScheme";
import {
  groupIntoThreads,
  useCreateComment,
  usePageComments,
} from "@/lib/hooks/use-comments";
import { CommentComposer } from "./comment-composer";
import { CommentThread } from "./comment-thread";
import type { CommentSegment } from "@/lib/types/comments";

type FilterMode = "all" | "open" | "resolved";

interface CommentPanelProps {
  pageId: string;
  workspaceId: string;
  open: boolean;
  onClose: () => void;
  /**
   * When set, scoped to comments on a specific block. The page-level
   * composer is hidden; the thread list filters to that block.
   */
  focusedBlockId?: string | null;
}

/**
 * Right-side comment panel. On web slides in from the right; on native it
 * presents as a modal sheet. Lists comment threads grouped by top-level
 * comment, with All / Open / Resolved filters and a page-level composer at
 * the bottom.
 */
export function CommentPanel({
  pageId,
  workspaceId,
  open,
  onClose,
  focusedBlockId,
}: CommentPanelProps) {
  const { colors } = useColorScheme();
  const [filter, setFilter] = React.useState<FilterMode>("open");
  const includeResolved = filter !== "open";
  const { data, isLoading } = usePageComments(pageId, includeResolved);
  const createMutation = useCreateComment();

  const threads = React.useMemo(() => {
    const comments = data?.comments ?? [];
    const filteredByBlock = focusedBlockId
      ? comments.filter(
          (c) =>
            c.blockId === focusedBlockId ||
            (c.parentCommentId !== null &&
              comments.some(
                (p) => p.id === c.parentCommentId && p.blockId === focusedBlockId,
              )),
        )
      : comments;
    const grouped = groupIntoThreads(filteredByBlock);
    if (filter === "resolved") {
      return grouped.filter((t) => t.root.resolvedAt !== null);
    }
    if (filter === "open") {
      return grouped.filter((t) => t.root.resolvedAt === null);
    }
    return grouped;
  }, [data?.comments, focusedBlockId, filter]);

  const handleSubmit = async (segments: CommentSegment[]) => {
    await createMutation.mutateAsync({
      pageId,
      blockId: focusedBlockId ?? null,
      parentCommentId: null,
      content: { segments },
    });
  };

  const headerTitle = focusedBlockId ? "Block comments" : "Comments";

  const body = (
    <View
      className="h-full bg-background border-l border-border flex-1"
      style={Platform.OS === "web" ? { width: 360, maxWidth: "100%" } : undefined}
    >
      <View className="flex-row items-center justify-between border-b border-border px-4 py-3">
        <View className="flex-row items-center gap-2">
          <MessageCircle size={16} color={colors.foreground} />
          <Text className="text-sm font-semibold text-foreground">
            {headerTitle}
          </Text>
        </View>
        <Pressable
          onPress={onClose}
          accessibilityLabel="Close comments"
          className="rounded-md p-1 hover:bg-muted"
        >
          <X size={16} color={colors.mutedForeground} />
        </Pressable>
      </View>

      <View className="flex-row gap-1 border-b border-border px-4 py-2">
        {(["open", "all", "resolved"] as FilterMode[]).map((mode) => (
          <Pressable
            key={mode}
            onPress={() => setFilter(mode)}
            className={
              filter === mode
                ? "rounded-md bg-muted px-2 py-1"
                : "rounded-md px-2 py-1 hover:bg-muted"
            }
          >
            <Text
              className={
                filter === mode
                  ? "text-xs font-medium text-foreground capitalize"
                  : "text-xs text-muted-foreground capitalize"
              }
            >
              {mode}
            </Text>
          </Pressable>
        ))}
      </View>

      <ScrollView className="flex-1" contentContainerClassName="p-3 gap-3">
        {isLoading ? (
          <View className="items-center py-8">
            <ActivityIndicator color={colors.mutedForeground} />
          </View>
        ) : threads.length === 0 ? (
          <View className="items-center gap-2 py-12 px-4">
            <CheckCheck size={24} color={colors.mutedForeground} />
            <Text className="text-sm text-muted-foreground text-center">
              {filter === "resolved"
                ? "No resolved comments yet."
                : filter === "open"
                  ? "No open comments. Hover a block to comment, or add a page-level note below."
                  : "No comments yet."}
            </Text>
          </View>
        ) : (
          threads.map((thread) => (
            <CommentThread
              key={thread.root.id}
              thread={thread}
              workspaceId={workspaceId}
              pageId={pageId}
            />
          ))
        )}
      </ScrollView>

      <View className="border-t border-border p-3">
        <CommentComposer
          workspaceId={workspaceId}
          placeholder={focusedBlockId ? "Comment on this block…" : "Add a page comment…"}
          onSubmit={handleSubmit}
          submitting={createMutation.isPending}
        />
      </View>
    </View>
  );

  if (Platform.OS === "web") {
    if (!open) return null;
    return (
      <View
        style={styles.webOverlay}
        pointerEvents="box-none"
      >
        <View style={styles.webPanel} pointerEvents="auto">
          {body}
        </View>
      </View>
    );
  }

  return (
    <Modal visible={open} animationType="slide" onRequestClose={onClose} transparent>
      <View className="flex-1 bg-black/50">
        <Pressable
          onPress={onClose}
          style={StyleSheet.absoluteFill}
          accessibilityLabel="Dismiss comment panel"
        />
        <View className="mt-20 flex-1 rounded-t-2xl overflow-hidden">{body}</View>
      </View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  webOverlay: {
    position: "absolute",
    top: 0,
    right: 0,
    bottom: 0,
    zIndex: 40,
  },
  webPanel: {
    height: "100%",
  },
});
