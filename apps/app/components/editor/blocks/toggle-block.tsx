import * as React from "react";
import { Pressable, TextInput, View } from "react-native";
import { ChevronDown, ChevronRight } from "lucide-react-native";
import { useColorScheme } from "@/lib/useColorScheme";
import type { BlockComponentProps } from "./types";

/**
 * Toggle block — clickable header that expands/collapses its children.
 * `content.expanded` is the persisted state. The editor wires children
 * via `renderChildren(block._id)` (children point at this block via
 * `parentBlockId`). Coordinated with Editor v2 — this is the renderer;
 * the framework already exposes the type via the slash menu.
 */
export function ToggleBlock({
  block,
  onChangeContent,
  renderChildren,
}: BlockComponentProps) {
  const { colors } = useColorScheme();
  const text = typeof block.content.text === "string" ? block.content.text : "";
  const expanded = block.content.expanded !== false;

  const [draft, setDraft] = React.useState(text);
  const lastBlockId = React.useRef(block._id);
  if (lastBlockId.current !== block._id) {
    lastBlockId.current = block._id;
    setDraft(text);
  }

  const toggleExpanded = () => {
    onChangeContent({ ...block.content, expanded: !expanded });
  };

  const Chevron = expanded ? ChevronDown : ChevronRight;

  return (
    <View className="gap-1">
      <View className="flex-row items-center gap-1">
        <Pressable
          onPress={toggleExpanded}
          accessibilityLabel={expanded ? "Collapse toggle" : "Expand toggle"}
          className="mt-1 h-5 w-5 items-center justify-center rounded hover:bg-muted"
        >
          <Chevron size={14} color={colors.foreground} />
        </Pressable>
        <View className="flex-1">
          <TextInput
            value={draft}
            onChangeText={setDraft}
            onBlur={() => {
              if (draft !== text) onChangeContent({ ...block.content, text: draft });
            }}
            placeholder="Toggle"
            placeholderTextColor={colors.mutedForeground}
            className="text-base text-foreground py-0.5"
          />
        </View>
      </View>
      {expanded && renderChildren ? (
        <View className="ml-6">{renderChildren(block._id)}</View>
      ) : null}
    </View>
  );
}
