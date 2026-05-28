import * as React from "react";
import { TextInput, View } from "react-native";
import { useColorScheme } from "@/lib/useColorScheme";
import type { BlockComponentProps } from "./types";

/**
 * Single cell inside a table row. Stores plain text on `content.text`
 * (segments arrive when the rich-text editor extends to cells). Cells
 * grow equally to fill the row.
 */
export function TableCell({ block, onChangeContent }: BlockComponentProps) {
  const { colors } = useColorScheme();
  const text = typeof block.content.text === "string" ? block.content.text : "";

  const [draft, setDraft] = React.useState(text);
  const lastBlockId = React.useRef(block._id);
  if (lastBlockId.current !== block._id) {
    lastBlockId.current = block._id;
    setDraft(text);
  }

  return (
    <View className="flex-1 min-w-[80px] border-r border-border last:border-r-0">
      <TextInput
        value={draft}
        onChangeText={setDraft}
        onBlur={() => {
          if (draft !== text) onChangeContent({ ...block.content, text: draft });
        }}
        placeholder="—"
        placeholderTextColor={colors.mutedForeground}
        className="px-2 py-1.5 text-sm text-foreground"
        multiline
      />
    </View>
  );
}
