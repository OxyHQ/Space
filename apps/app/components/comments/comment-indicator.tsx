import * as React from "react";
import { Pressable, View } from "react-native";
import { MessageSquare } from "lucide-react-native";
import { Text } from "@/components/ui/text";
import { useColorScheme } from "@/lib/useColorScheme";
import { useBlockComments } from "@/lib/hooks/use-comments";

interface CommentIndicatorProps {
  blockId: string;
  onPress: () => void;
  /** When true, always renders the chrome (even with zero comments) so hover
   * affordances can attach to it. The badge dot is hidden if count === 0. */
  alwaysVisible?: boolean;
}

/**
 * Block-level comment indicator. Shows a tiny "💬 N" badge when the block
 * has non-resolved comments. Clicking opens the panel scoped to that block.
 *
 * Renders inert (returns null) when there are no comments and
 * `alwaysVisible` is false — the editor uses `alwaysVisible` for the always-
 * present "+ Comment" hover affordance.
 */
export function CommentIndicator({
  blockId,
  onPress,
  alwaysVisible,
}: CommentIndicatorProps) {
  const { colors } = useColorScheme();
  const { data } = useBlockComments(blockId);

  const openCount = React.useMemo(() => {
    const comments = data?.comments ?? [];
    // Count top-level threads that are not resolved.
    return comments.filter(
      (c) => c.parentCommentId === null && c.resolvedAt === null,
    ).length;
  }, [data?.comments]);

  if (!alwaysVisible && openCount === 0) return null;

  return (
    <Pressable
      onPress={onPress}
      className="flex-row items-center gap-1 rounded-md px-1.5 py-0.5 hover:bg-muted"
      accessibilityLabel={
        openCount > 0
          ? `${openCount} comment${openCount === 1 ? "" : "s"}`
          : "Add a comment"
      }
    >
      <MessageSquare
        size={12}
        color={openCount > 0 ? colors.primary : colors.mutedForeground}
      />
      {openCount > 0 ? (
        <Text className="text-[10px] font-medium text-primary">{openCount}</Text>
      ) : null}
      {openCount === 0 && alwaysVisible ? (
        <Text className="text-[10px] text-muted-foreground">Comment</Text>
      ) : (
        <View />
      )}
    </Pressable>
  );
}
