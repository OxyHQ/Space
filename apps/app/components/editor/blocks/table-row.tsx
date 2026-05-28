import * as React from "react";
import { View } from "react-native";
import type { BlockComponentProps } from "./types";

/**
 * Row inside a `table` block. Children are `table_cell` blocks — the
 * editor passes them in via `renderChildren(block._id)`. Cells flex-grow
 * equally so the row maintains the parent table's column count.
 */
export function TableRow({ block, renderChildren }: BlockComponentProps) {
  return (
    <View className="flex-row border-b border-border last:border-b-0">
      {renderChildren ? renderChildren(block._id) : null}
    </View>
  );
}
