import * as React from "react";
import { Platform, Pressable, TextInput, View } from "react-native";
import { Check } from "lucide-react-native";
import { Text } from "@/components/ui/text";
import { useColorScheme } from "@/lib/useColorScheme";
import type { Block, BlockType } from "@/lib/types/pages";
import { EditableText } from "./editable-text";

export interface BlockHandlers {
  onChangeText: (text: string) => void;
  onSubmitEditing: () => void;
  onBackspaceAtStart: () => void;
  onIndent: (outdent: boolean) => void;
  onToggleChecked?: () => void;
  /** Reports current text + caret offset so the editor can manage the slash menu. */
  onChangeMeta?: (meta: { value: string; selection: number }) => void;
  /** Index used by numbered-list renderers (1-based within the same sibling group). */
  listIndex?: number;
}

interface BlockProps {
  block: Block;
  handlers: BlockHandlers;
  autoFocus?: boolean;
  inputRef?: React.RefObject<TextInput | null>;
}

/**
 * Dispatches a `Block` to its type-specific renderer. All renderers share
 * the same `<EditableText>` for plain-text input. Phase 1 stores plain text
 * — inline annotations (bold/italic/links) arrive later phases.
 */
export function BlockView({ block, handlers, autoFocus, inputRef }: BlockProps) {
  switch (block.type) {
    case "heading_1":
      return (
        <EditableText
          value={block.content.text ?? ""}
          onChangeText={handlers.onChangeText}
          onSubmitEditing={handlers.onSubmitEditing}
          onBackspaceAtStart={handlers.onBackspaceAtStart}
          onIndent={handlers.onIndent}
          onChangeMeta={handlers.onChangeMeta}
          placeholder="Heading 1"
          className="text-4xl font-bold text-foreground py-2"
          autoFocus={autoFocus}
          inputRef={inputRef}
        />
      );
    case "heading_2":
      return (
        <EditableText
          value={block.content.text ?? ""}
          onChangeText={handlers.onChangeText}
          onSubmitEditing={handlers.onSubmitEditing}
          onBackspaceAtStart={handlers.onBackspaceAtStart}
          onIndent={handlers.onIndent}
          onChangeMeta={handlers.onChangeMeta}
          placeholder="Heading 2"
          className="text-2xl font-bold text-foreground py-1.5"
          autoFocus={autoFocus}
          inputRef={inputRef}
        />
      );
    case "heading_3":
      return (
        <EditableText
          value={block.content.text ?? ""}
          onChangeText={handlers.onChangeText}
          onSubmitEditing={handlers.onSubmitEditing}
          onBackspaceAtStart={handlers.onBackspaceAtStart}
          onIndent={handlers.onIndent}
          onChangeMeta={handlers.onChangeMeta}
          placeholder="Heading 3"
          className="text-xl font-semibold text-foreground py-1"
          autoFocus={autoFocus}
          inputRef={inputRef}
        />
      );
    case "bulleted_list_item":
      return (
        <ListItemRow marker="•">
          <EditableText
            value={block.content.text ?? ""}
            onChangeText={handlers.onChangeText}
            onSubmitEditing={handlers.onSubmitEditing}
            onBackspaceAtStart={handlers.onBackspaceAtStart}
            onIndent={handlers.onIndent}
            onChangeMeta={handlers.onChangeMeta}
            placeholder="List item"
            className="text-base text-foreground"
            autoFocus={autoFocus}
            inputRef={inputRef}
          />
        </ListItemRow>
      );
    case "numbered_list_item":
      return (
        <ListItemRow marker={`${handlers.listIndex ?? 1}.`}>
          <EditableText
            value={block.content.text ?? ""}
            onChangeText={handlers.onChangeText}
            onSubmitEditing={handlers.onSubmitEditing}
            onBackspaceAtStart={handlers.onBackspaceAtStart}
            onIndent={handlers.onIndent}
            onChangeMeta={handlers.onChangeMeta}
            placeholder="List item"
            className="text-base text-foreground"
            autoFocus={autoFocus}
            inputRef={inputRef}
          />
        </ListItemRow>
      );
    case "to_do":
      return <TodoBlock block={block} handlers={handlers} autoFocus={autoFocus} inputRef={inputRef} />;
    case "quote":
      return (
        <View className="border-l-4 border-foreground/40 pl-3 py-1">
          <EditableText
            value={block.content.text ?? ""}
            onChangeText={handlers.onChangeText}
            onSubmitEditing={handlers.onSubmitEditing}
            onBackspaceAtStart={handlers.onBackspaceAtStart}
            onIndent={handlers.onIndent}
            onChangeMeta={handlers.onChangeMeta}
            placeholder="Empty quote"
            className="text-base italic text-foreground"
            autoFocus={autoFocus}
            inputRef={inputRef}
          />
        </View>
      );
    case "divider":
      return <View className="my-3 h-px w-full bg-border" />;
    case "code":
      return (
        <View className="rounded-lg bg-muted/60 px-3 py-2">
          <EditableText
            value={block.content.text ?? ""}
            onChangeText={handlers.onChangeText}
            onSubmitEditing={handlers.onSubmitEditing}
            onBackspaceAtStart={handlers.onBackspaceAtStart}
            onIndent={handlers.onIndent}
            onChangeMeta={handlers.onChangeMeta}
            placeholder="Code"
            className={
              Platform.OS === "web"
                ? "text-sm text-foreground font-mono"
                : "text-sm text-foreground"
            }
            autoFocus={autoFocus}
            inputRef={inputRef}
          />
        </View>
      );
    case "callout":
      return (
        <View className="flex-row gap-2 rounded-lg bg-muted/60 px-3 py-2">
          <Text className="text-base leading-7">
            {block.content.emoji ?? "💡"}
          </Text>
          <View className="flex-1">
            <EditableText
              value={block.content.text ?? ""}
              onChangeText={handlers.onChangeText}
              onSubmitEditing={handlers.onSubmitEditing}
              onBackspaceAtStart={handlers.onBackspaceAtStart}
              onIndent={handlers.onIndent}
              onChangeMeta={handlers.onChangeMeta}
              placeholder="Type something…"
              className="text-base text-foreground"
              autoFocus={autoFocus}
              inputRef={inputRef}
            />
          </View>
        </View>
      );
    case "paragraph":
    default:
      return (
        <EditableText
          value={block.content.text ?? ""}
          onChangeText={handlers.onChangeText}
          onSubmitEditing={handlers.onSubmitEditing}
          onBackspaceAtStart={handlers.onBackspaceAtStart}
          onIndent={handlers.onIndent}
          onChangeMeta={handlers.onChangeMeta}
          placeholder="Type ‘/’ for commands"
          className="text-base text-foreground py-0.5"
          autoFocus={autoFocus}
          inputRef={inputRef}
        />
      );
  }
}

function ListItemRow({
  marker,
  children,
}: {
  marker: string;
  children: React.ReactNode;
}) {
  return (
    <View className="flex-row gap-2 py-0.5">
      <View className="min-w-[20px] items-end pt-[2px]">
        <Text className="text-base text-foreground">{marker}</Text>
      </View>
      <View className="flex-1">{children}</View>
    </View>
  );
}

function TodoBlock({
  block,
  handlers,
  autoFocus,
  inputRef,
}: {
  block: Block;
  handlers: BlockHandlers;
  autoFocus?: boolean;
  inputRef?: React.RefObject<TextInput | null>;
}) {
  const { colors } = useColorScheme();
  const checked = Boolean(block.content.checked);
  return (
    <View className="flex-row items-start gap-2 py-0.5">
      <Pressable
        onPress={handlers.onToggleChecked}
        accessibilityRole="checkbox"
        accessibilityState={{ checked }}
        className={
          checked
            ? "mt-1 h-5 w-5 items-center justify-center rounded-md bg-primary"
            : "mt-1 h-5 w-5 items-center justify-center rounded-md border border-input"
        }
      >
        {checked ? <Check size={14} color={colors.primaryForeground} /> : null}
      </Pressable>
      <View className="flex-1">
        <EditableText
          value={block.content.text ?? ""}
          onChangeText={handlers.onChangeText}
          onSubmitEditing={handlers.onSubmitEditing}
          onBackspaceAtStart={handlers.onBackspaceAtStart}
          onIndent={handlers.onIndent}
          onChangeMeta={handlers.onChangeMeta}
          placeholder="To-do"
          className={
            checked
              ? "text-base text-muted-foreground line-through"
              : "text-base text-foreground"
          }
          autoFocus={autoFocus}
          inputRef={inputRef}
        />
      </View>
    </View>
  );
}

export type { BlockType };
