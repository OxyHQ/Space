import * as React from "react";
import {
  Modal,
  Platform,
  Pressable,
  View,
  StyleSheet,
} from "react-native";
import {
  AlignLeft,
  Heading1,
  Heading2,
  Heading3,
  List,
  ListOrdered,
  CheckSquare,
  Quote,
  Minus,
  Code2,
  Megaphone,
} from "lucide-react-native";
import { Text } from "@/components/ui/text";
import { useColorScheme } from "@/lib/useColorScheme";
import type { BlockType } from "@/lib/types/pages";

export interface SlashMenuOption {
  type: BlockType;
  label: string;
  description: string;
  Icon: React.ComponentType<{ size?: number; color?: string }>;
}

export const SLASH_MENU_OPTIONS: readonly SlashMenuOption[] = [
  {
    type: "paragraph",
    label: "Text",
    description: "Plain text paragraph.",
    Icon: AlignLeft,
  },
  {
    type: "heading_1",
    label: "Heading 1",
    description: "Large section heading.",
    Icon: Heading1,
  },
  {
    type: "heading_2",
    label: "Heading 2",
    description: "Medium section heading.",
    Icon: Heading2,
  },
  {
    type: "heading_3",
    label: "Heading 3",
    description: "Small section heading.",
    Icon: Heading3,
  },
  {
    type: "bulleted_list_item",
    label: "Bulleted list",
    description: "Create a simple bulleted list.",
    Icon: List,
  },
  {
    type: "numbered_list_item",
    label: "Numbered list",
    description: "Create a list with numbering.",
    Icon: ListOrdered,
  },
  {
    type: "to_do",
    label: "To-do list",
    description: "Track tasks with checkboxes.",
    Icon: CheckSquare,
  },
  {
    type: "quote",
    label: "Quote",
    description: "Capture a quote.",
    Icon: Quote,
  },
  {
    type: "divider",
    label: "Divider",
    description: "Visually divide blocks.",
    Icon: Minus,
  },
  {
    type: "code",
    label: "Code",
    description: "Monospace code block.",
    Icon: Code2,
  },
  {
    type: "callout",
    label: "Callout",
    description: "Highlight important info.",
    Icon: Megaphone,
  },
];

interface SlashMenuProps {
  open: boolean;
  query: string;
  onSelect: (type: BlockType) => void;
  onClose: () => void;
}

export function SlashMenu({
  open,
  query,
  onSelect,
  onClose,
}: SlashMenuProps) {
  const { colors } = useColorScheme();

  const filtered = React.useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return SLASH_MENU_OPTIONS;
    return SLASH_MENU_OPTIONS.filter(
      (opt) =>
        opt.label.toLowerCase().includes(q) ||
        opt.type.toLowerCase().includes(q),
    );
  }, [query]);

  if (!open) return null;

  const list = (
    <View className="w-72 rounded-2xl border border-border bg-popover py-1 shadow-lg">
      <View className="px-3 pt-2 pb-1">
        <Text className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
          Blocks
        </Text>
      </View>
      <View className="max-h-72">
        {filtered.length === 0 ? (
          <View className="px-3 py-3">
            <Text className="text-sm text-muted-foreground">
              No matches for “{query}”
            </Text>
          </View>
        ) : (
          filtered.map((opt) => (
            <Pressable
              key={opt.type}
              onPress={() => onSelect(opt.type)}
              className="flex-row items-center gap-3 px-3 py-2 hover:bg-muted active:bg-muted"
            >
              <View className="h-8 w-8 items-center justify-center rounded-md bg-muted">
                <opt.Icon size={16} color={colors.foreground} />
              </View>
              <View className="flex-1">
                <Text className="text-sm font-medium text-foreground">
                  {opt.label}
                </Text>
                <Text className="text-xs text-muted-foreground">
                  {opt.description}
                </Text>
              </View>
            </Pressable>
          ))
        )}
      </View>
    </View>
  );

  // Web: absolute-positioned popover just below the current block's input.
  // The parent renders this inside a `relative` container so 0,0 ≈ caret row.
  if (Platform.OS === "web") {
    return (
      <View style={styles.webPopover} pointerEvents="box-none">
        <View style={styles.webPopoverInner} pointerEvents="auto">
          {list}
        </View>
      </View>
    );
  }

  // Native: bottom sheet via Modal — simple, no positional math.
  return (
    <Modal
      visible={open}
      transparent
      animationType="fade"
      onRequestClose={onClose}
    >
      <Pressable
        style={StyleSheet.absoluteFill}
        className="bg-black/50"
        onPress={onClose}
      />
      <View className="absolute bottom-0 left-0 right-0 p-3">{list}</View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  webPopover: {
    position: "absolute",
    top: 0,
    left: 0,
    right: 0,
    zIndex: 50,
  },
  webPopoverInner: {
    position: "absolute",
    top: 0,
    left: 0,
  },
});
