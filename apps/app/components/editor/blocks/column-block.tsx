import * as React from "react";
import { View } from "react-native";
import { Text } from "@/components/ui/text";
import type { BlockComponentProps } from "./types";

/**
 * A single column inside a `columns` container. Children blocks are blocks
 * whose `parentBlockId` points at this column — the editor passes them in
 * via `renderChildren(block._id)`. Width is computed by the parent
 * `ColumnsBlock` (flex: 1 per default, optionally `ratio`).
 */
export function ColumnBlock({ block, renderChildren }: BlockComponentProps) {
  const ratio =
    typeof block.content.ratio === "number" ? block.content.ratio : undefined;
  return (
    <View
      style={ratio ? { flex: ratio } : { flex: 1 }}
      className="min-w-[120px] gap-1 px-1"
    >
      {renderChildren ? (
        renderChildren(block._id)
      ) : (
        <View className="rounded-md border border-dashed border-border bg-muted/30 px-2 py-3">
          <Text className="text-xs text-muted-foreground">Empty column</Text>
        </View>
      )}
    </View>
  );
}
