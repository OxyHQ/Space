import * as React from "react";
import { View } from "react-native";
import { RefreshCcw } from "lucide-react-native";
import { Text } from "@/components/ui/text";
import { useColorScheme } from "@/lib/useColorScheme";
import type { BlockComponentProps } from "./types";

/**
 * Placeholder synced-block. Phase 3 ships the block type so editors can
 * persist references; the actual "show source block content here" rendering
 * lands in Phase 4 alongside permissions and circular-reference guards.
 */
export function SyncBlock({ block }: BlockComponentProps) {
  const { colors } = useColorScheme();
  const sourceId =
    typeof block.content.sourceBlockId === "string"
      ? block.content.sourceBlockId
      : "";
  return (
    <View className="flex-row items-center gap-2 rounded-md border border-dashed border-border bg-muted/30 px-3 py-2">
      <RefreshCcw size={14} color={colors.mutedForeground} />
      <View className="flex-1">
        <Text className="text-sm text-muted-foreground">
          Synced block (Phase 3)
        </Text>
        {sourceId ? (
          <Text className="text-xs text-muted-foreground" numberOfLines={1}>
            Source: {sourceId}
          </Text>
        ) : null}
      </View>
    </View>
  );
}
