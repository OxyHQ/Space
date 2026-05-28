import * as React from "react";
import { Platform, Pressable, TextInput, View } from "react-native";
import { Check, ChevronRight } from "lucide-react-native";
import { Text } from "@/components/ui/text";
import { useColorScheme } from "@/lib/useColorScheme";
import type {
  Block,
  BlockColor,
  BlockContent,
  BlockType,
  Segment,
} from "@/lib/types/pages";
import { cn } from "@/lib/utils";
import { RichEditable, type RichEditableHandle, type CaretRange } from "./rich-editable";
// Phase 3 block-type renderers (media, embeds, layout, interactive, math).
// They use a stand-alone props shape — see `blocks/types.ts`. The dispatch
// case forwards `onChangeContent` from the editor.
import { ImageBlock } from "./blocks/image-block";
import { VideoBlock } from "./blocks/video-block";
import { AudioBlock } from "./blocks/audio-block";
import { FileBlock } from "./blocks/file-block";
import { PdfBlock } from "./blocks/pdf-block";
import { BookmarkBlock } from "./blocks/bookmark-block";
import { EmbedBlock } from "./blocks/embed-block";
import { ColumnsBlock } from "./blocks/columns-block";
import { ColumnBlock } from "./blocks/column-block";
import { TableBlock as TableContainerBlock } from "./blocks/table-block";
import { TableRow as TableRowBlock } from "./blocks/table-row";
import { TableCell as TableCellBlock } from "./blocks/table-cell";
// Editor v2 (apps/app/components/editor/block.tsx → ToggleBlock below) already
// implements the toggle renderer with full RichEditable integration; defer to
// that. The standalone Phase 3 ToggleBlock at ./blocks/toggle-block.tsx is
// kept as a lightweight alternative for non-editor surfaces.
import { ButtonBlock } from "./blocks/button-block";
import { LinkToPageBlock } from "./blocks/link-to-page-block";
import { SyncBlock } from "./blocks/sync-block";
import { BreadcrumbBlock } from "./blocks/breadcrumb-block";
import { TableOfContentsBlock } from "./blocks/table-of-contents-block";
import { EquationBlock } from "./blocks/equation-block";
import { MermaidBlock } from "./blocks/mermaid-block";
import type { BlockComponentProps } from "./blocks/types";
// Side-effect: registers Phase 3 slash-menu entries with the editor framework.
import "./blocks/slash-menu-entries";

/**
 * Handlers handed down from the editor to each block. These mirror the
 * Phase 1 shape but accept `Segment[]` so rich text is preserved end-to-end.
 */
export interface BlockHandlers {
  /** Emitted on every text mutation — both segments and flattened text. */
  onChange: (next: { segments: Segment[]; text: string }) => void;
  /** Enter at end of block → split / create-new-block-below. */
  onSubmit: () => void;
  /** Backspace at offset 0 with empty selection → merge upwards / delete. */
  onBackspaceAtStart: () => void;
  /** Tab / Shift+Tab (web). */
  onIndent: (outdent: boolean) => void;
  /** Web: keydown raw event with caret range, for markdown shortcuts. */
  onKeyDown?: (event: KeyboardEvent, range: CaretRange) => boolean | void;
  /** Selection range — reported on every selection change. */
  onSelectionChange?: (range: CaretRange) => void;
  /** Todo blocks only. */
  onToggleChecked?: () => void;
  /** Toggle blocks only. */
  onToggleExpanded?: () => void;
  /** 1-based index used by numbered_list_item renderer. */
  listIndex?: number;
}

interface BlockProps {
  block: Block;
  handlers: BlockHandlers;
  /** Auto-focus on mount — used for newly-created blocks. */
  autoFocus?: boolean;
  /** Legacy TextInput ref (native path) — kept for callers still using it. */
  inputRef?: React.RefObject<TextInput | null>;
  /** Imperative handle for selection/focus control. */
  handleRef?: React.MutableRefObject<RichEditableHandle | null>;
  /**
   * Phase 3 non-text blocks update arbitrary `content` (not just text). The
   * editor wires this so renderers can persist URL / metadata / layout
   * changes without going through the rich-text handler.
   */
  onChangeContent?: (next: BlockContent) => void;
  /**
   * Render the child blocks of a parent id. Used by container blocks
   * (columns, table, toggle). The editor knows the full block tree and so
   * owns child rendering; container renderers just call this with their
   * own id when they want to display their children.
   */
  renderChildren?: BlockComponentProps["renderChildren"];
}

/** Block-level color → text className. */
const BLOCK_TEXT_COLOR: Record<BlockColor, string> = {
  default: "",
  gray: "text-gray-500 dark:text-gray-400",
  brown: "text-amber-800 dark:text-amber-300",
  orange: "text-orange-600 dark:text-orange-400",
  yellow: "text-yellow-600 dark:text-yellow-400",
  green: "text-emerald-600 dark:text-emerald-400",
  blue: "text-blue-600 dark:text-blue-400",
  purple: "text-purple-600 dark:text-purple-400",
  pink: "text-pink-600 dark:text-pink-400",
  red: "text-red-600 dark:text-red-400",
};

const BLOCK_BG_COLOR: Record<BlockColor, string> = {
  default: "",
  gray: "bg-gray-200/50 dark:bg-gray-700/50",
  brown: "bg-amber-100 dark:bg-amber-900/40",
  orange: "bg-orange-100 dark:bg-orange-900/40",
  yellow: "bg-yellow-100 dark:bg-yellow-900/40",
  green: "bg-emerald-100 dark:bg-emerald-900/40",
  blue: "bg-blue-100 dark:bg-blue-900/40",
  purple: "bg-purple-100 dark:bg-purple-900/40",
  pink: "bg-pink-100 dark:bg-pink-900/40",
  red: "bg-red-100 dark:bg-red-900/40",
};

function blockColorClasses(content: Block["content"]): string {
  const text = content.color ? BLOCK_TEXT_COLOR[content.color] : "";
  const bg = content.backgroundColor
    ? BLOCK_BG_COLOR[content.backgroundColor]
    : "";
  return cn(text, bg);
}

/**
 * Dispatches a `Block` to its type-specific renderer. All renderers share
 * the same `<RichEditable>` for rich-text input (web) or a TextInput
 * fallback (native, plain).
 */
export function BlockView({
  block,
  handlers,
  autoFocus,
  inputRef,
  handleRef,
  onChangeContent,
  renderChildren,
}: BlockProps) {
  const segments = block.content.segments ?? [];
  const fallback = block.content.text ?? "";

  const common = {
    segments,
    fallbackText: fallback,
    onChange: handlers.onChange,
    onSubmit: () => {
      handlers.onSubmit();
      return true;
    },
    onBackspaceAtStart: handlers.onBackspaceAtStart,
    onIndent: handlers.onIndent,
    onKeyDown: handlers.onKeyDown,
    onSelectionChange: handlers.onSelectionChange,
    autoFocus,
    textInputRef: inputRef,
    handleRef,
  };

  const colorCls = blockColorClasses(block.content);

  switch (block.type) {
    case "heading_1":
      return (
        <RichEditable
          {...common}
          placeholder="Heading 1"
          className={cn("text-4xl font-bold text-foreground py-2", colorCls)}
        />
      );
    case "heading_2":
      return (
        <RichEditable
          {...common}
          placeholder="Heading 2"
          className={cn("text-2xl font-bold text-foreground py-1.5", colorCls)}
        />
      );
    case "heading_3":
      return (
        <RichEditable
          {...common}
          placeholder="Heading 3"
          className={cn("text-xl font-semibold text-foreground py-1", colorCls)}
        />
      );
    case "bulleted_list_item":
      return (
        <ListItemRow marker="•" colorCls={colorCls}>
          <RichEditable
            {...common}
            placeholder="List item"
            className={cn("text-base text-foreground", colorCls)}
          />
        </ListItemRow>
      );
    case "numbered_list_item":
      return (
        <ListItemRow
          marker={`${handlers.listIndex ?? 1}.`}
          colorCls={colorCls}
        >
          <RichEditable
            {...common}
            placeholder="List item"
            className={cn("text-base text-foreground", colorCls)}
          />
        </ListItemRow>
      );
    case "to_do":
      return (
        <TodoBlock
          block={block}
          common={common}
          onToggleChecked={handlers.onToggleChecked}
          colorCls={colorCls}
        />
      );
    case "quote":
      return (
        <View
          className={cn(
            "border-l-4 border-foreground/40 pl-3 py-1 rounded-r",
            colorCls,
          )}
        >
          <RichEditable
            {...common}
            placeholder="Empty quote"
            className={cn("text-base italic text-foreground", colorCls)}
          />
        </View>
      );
    case "divider":
      return <View className="my-3 h-px w-full bg-border" />;
    case "code":
      return (
        <View className={cn("rounded-lg bg-muted/60 px-3 py-2", colorCls)}>
          <RichEditable
            {...common}
            placeholder="Code"
            className={cn(
              "text-sm text-foreground",
              Platform.OS === "web" ? "font-mono" : "",
              colorCls,
            )}
          />
        </View>
      );
    case "callout":
      return (
        <View
          className={cn(
            "flex-row gap-2 rounded-lg bg-muted/60 px-3 py-2",
            colorCls,
          )}
        >
          <Text className="text-base leading-7">
            {(block.content.icon as string | undefined) ??
              block.content.emoji ??
              "💡"}
          </Text>
          <View className="flex-1">
            <RichEditable
              {...common}
              placeholder="Type something…"
              className={cn("text-base text-foreground", colorCls)}
            />
          </View>
        </View>
      );
    case "toggle":
      return (
        <ToggleBlock
          block={block}
          common={common}
          onToggleExpanded={handlers.onToggleExpanded}
          colorCls={colorCls}
        />
      );
    case "image":
      return renderPhase3(ImageBlock, block, onChangeContent, renderChildren);
    case "video":
      return renderPhase3(VideoBlock, block, onChangeContent, renderChildren);
    case "audio":
      return renderPhase3(AudioBlock, block, onChangeContent, renderChildren);
    case "file":
      return renderPhase3(FileBlock, block, onChangeContent, renderChildren);
    case "pdf":
      return renderPhase3(PdfBlock, block, onChangeContent, renderChildren);
    case "bookmark":
      return renderPhase3(BookmarkBlock, block, onChangeContent, renderChildren);
    case "embed":
      return renderPhase3(EmbedBlock, block, onChangeContent, renderChildren);
    case "columns":
      return renderPhase3(ColumnsBlock, block, onChangeContent, renderChildren);
    case "column":
      return renderPhase3(ColumnBlock, block, onChangeContent, renderChildren);
    case "table":
      return renderPhase3(TableContainerBlock, block, onChangeContent, renderChildren);
    case "table_row":
      return renderPhase3(TableRowBlock, block, onChangeContent, renderChildren);
    case "table_cell":
      return renderPhase3(TableCellBlock, block, onChangeContent, renderChildren);
    case "button":
      return renderPhase3(ButtonBlock, block, onChangeContent, renderChildren);
    case "link_to_page":
      return renderPhase3(LinkToPageBlock, block, onChangeContent, renderChildren);
    case "sync_block":
      return renderPhase3(SyncBlock, block, onChangeContent, renderChildren);
    case "breadcrumb":
      return renderPhase3(BreadcrumbBlock, block, onChangeContent, renderChildren);
    case "table_of_contents":
      return renderPhase3(
        TableOfContentsBlock,
        block,
        onChangeContent,
        renderChildren,
      );
    case "equation":
      return renderPhase3(EquationBlock, block, onChangeContent, renderChildren);
    case "mermaid":
      return renderPhase3(MermaidBlock, block, onChangeContent, renderChildren);
    case "paragraph":
    default:
      return (
        <RichEditable
          {...common}
          placeholder="Type ‘/’ for commands"
          className={cn("text-base text-foreground py-0.5", colorCls)}
        />
      );
  }
}

/**
 * Render a Phase 3 (non-rich-text) block component. Centralizes the
 * onChangeContent fallback so each case stays a single line.
 */
function renderPhase3(
  Component: React.ComponentType<BlockComponentProps>,
  block: Block,
  onChangeContent: ((next: BlockContent) => void) | undefined,
  renderChildren: BlockProps["renderChildren"],
): React.ReactElement {
  const noopChange = (_next: BlockContent) => undefined;
  return (
    <Component
      block={block}
      onChangeContent={onChangeContent ?? noopChange}
      renderChildren={renderChildren}
    />
  );
}

function ListItemRow({
  marker,
  children,
  colorCls,
}: {
  marker: string;
  children: React.ReactNode;
  colorCls?: string;
}) {
  return (
    <View className={cn("flex-row gap-2 py-0.5 rounded", colorCls)}>
      <View className="min-w-[20px] items-end pt-[2px]">
        <Text className={cn("text-base text-foreground", colorCls)}>
          {marker}
        </Text>
      </View>
      <View className="flex-1">{children}</View>
    </View>
  );
}

interface InnerCommonProps {
  segments: Segment[];
  fallbackText: string;
  onChange: BlockHandlers["onChange"];
  onSubmit: () => boolean | void;
  onBackspaceAtStart: BlockHandlers["onBackspaceAtStart"];
  onIndent: BlockHandlers["onIndent"];
  onKeyDown?: BlockHandlers["onKeyDown"];
  onSelectionChange?: BlockHandlers["onSelectionChange"];
  autoFocus?: boolean;
  textInputRef?: React.RefObject<TextInput | null>;
  handleRef?: React.MutableRefObject<RichEditableHandle | null>;
}

function TodoBlock({
  block,
  common,
  onToggleChecked,
  colorCls,
}: {
  block: Block;
  common: InnerCommonProps;
  onToggleChecked?: () => void;
  colorCls?: string;
}) {
  const { colors } = useColorScheme();
  const checked = Boolean(block.content.checked);
  return (
    <View
      className={cn("flex-row items-start gap-2 py-0.5 rounded", colorCls)}
    >
      <Pressable
        onPress={onToggleChecked}
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
        <RichEditable
          {...common}
          placeholder="To-do"
          className={
            checked
              ? cn("text-base text-muted-foreground line-through", colorCls)
              : cn("text-base text-foreground", colorCls)
          }
        />
      </View>
    </View>
  );
}

function ToggleBlock({
  block,
  common,
  onToggleExpanded,
  colorCls,
}: {
  block: Block;
  common: InnerCommonProps;
  onToggleExpanded?: () => void;
  colorCls?: string;
}) {
  const { colors } = useColorScheme();
  // Default to expanded when unset — preserves Phase 2 spec.
  const expanded = block.content.expanded !== false;
  return (
    <View className={cn("flex-row items-start gap-1 py-0.5 rounded", colorCls)}>
      <Pressable
        onPress={onToggleExpanded}
        accessibilityLabel={expanded ? "Collapse" : "Expand"}
        className="mt-0.5 h-6 w-6 items-center justify-center rounded-md hover:bg-muted"
      >
        <View
          style={{
            transform: [{ rotate: expanded ? "90deg" : "0deg" }],
          }}
        >
          <ChevronRight size={14} color={colors.foreground} />
        </View>
      </Pressable>
      <View className="flex-1">
        <RichEditable
          {...common}
          placeholder="Toggle"
          className={cn("text-base text-foreground", colorCls)}
        />
      </View>
    </View>
  );
}

export type { BlockType };
