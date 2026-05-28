import * as React from "react";
import { View } from "react-native";
import { Text } from "@/components/ui/text";
import type { BlockComponentProps } from "./types";

/**
 * `columns` container — renders its `column` children side-by-side. The
 * editor passes children in via `renderChildren(block._id)`; children are
 * expected to be `column` blocks. Mobile (< 640) collapses to a vertical
 * stack via wrap.
 */
export function ColumnsBlock({ block, renderChildren }: BlockComponentProps) {
  return (
    <View className="flex-row flex-wrap items-stretch gap-1 my-1">
      {renderChildren ? (
        renderChildren(block._id)
      ) : (
        <View className="flex-1 rounded-md border border-dashed border-border bg-muted/30 px-3 py-3">
          <Text className="text-xs text-muted-foreground">
            Drop blocks into each column
          </Text>
        </View>
      )}
    </View>
  );
}
