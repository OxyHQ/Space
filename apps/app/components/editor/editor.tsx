import * as React from "react";
import {
  ActivityIndicator,
  Platform,
  Pressable,
  TextInput,
  View,
} from "react-native";
import { Plus } from "lucide-react-native";
import { Text } from "@/components/ui/text";
import { useColorScheme } from "@/lib/useColorScheme";
import {
  useBlocks,
  useCreateBlock,
  useDeleteBlock,
  useReorderBlocks,
  useUpdateBlock,
} from "@/lib/hooks/use-blocks";
import type {
  Block,
  BlockColor,
  BlockType,
  Segment,
} from "@/lib/types/pages";
import { cn } from "@/lib/utils";
import { CommentIndicator } from "@/components/comments/comment-indicator";
import { BlockView } from "./block";
import { BlockActionMenu } from "./block-action-menu";
import { DragHandle } from "./drag-handle";
import { useEditorDnd, type DropPosition } from "./editor-dnd";
import {
  FormattingToolbar,
  type FormattingState,
} from "./formatting-toolbar";
import {
  detectInlineShortcut,
  detectShortcut,
} from "./markdown-shortcuts";
import {
  applyAnnotationRange,
  ensureSegments,
  rangeHasMark,
  segmentsToPlainText,
} from "./segments";
import { SlashMenu, getSlashMenuOptions } from "./slash-menu";
import type { RichEditableHandle, CaretRange } from "./rich-editable";

interface EditorProps {
  pageId: string;
  /**
   * Called when a block's comment trigger (or existing indicator) is tapped.
   * Receives the block id so the caller can open the comment panel scoped to
   * that block. Optional — when omitted the indicator is hidden.
   */
  onOpenBlockComments?: (blockId: string) => void;
}

const ORDER_STEP = 1000;

interface SlashState {
  blockId: string;
  /** Plain-text caret offset of the slash trigger. */
  slashIndex: number;
  query: string;
}

interface ActionMenuState {
  blockId: string;
  anchor: { top: number; left: number } | null;
}

interface ToolbarState {
  blockId: string;
  range: CaretRange;
  anchor: { top: number; left: number; width: number } | null;
  active: FormattingState;
}

/**
 * Block editor v2. Owns:
 *   - block list ordering (TanStack Query is source-of-truth)
 *   - per-block segment drafts + debounced saves
 *   - slash menu / action menu / formatting toolbar coordination
 *   - drag-and-drop reordering (web)
 *   - multi-block selection (web)
 *   - markdown shortcuts (web)
 *   - toggle expand/collapse, todo checked toggle
 *   - comment indicator gutter (handed in via `onOpenBlockComments`)
 */
export function Editor({ pageId, onOpenBlockComments }: EditorProps) {
  const { colors } = useColorScheme();
  const { data, isLoading } = useBlocks(pageId);
  const createBlock = useCreateBlock();
  const updateBlock = useUpdateBlock();
  const deleteBlock = useDeleteBlock();
  const reorderBlocks = useReorderBlocks();

  // Server-source-of-truth, sorted by order.
  const blocks = React.useMemo(() => {
    const list = data?.blocks ?? [];
    return [...list].sort((a, b) => a.order - b.order);
  }, [data?.blocks]);

  // Build the parent → children tree so we can render nested blocks
  // (toggles, list children).
  const childMap = React.useMemo(() => {
    const map = new Map<string | null, Block[]>();
    for (const b of blocks) {
      const key = b.parentBlockId ?? null;
      const arr = map.get(key) ?? [];
      arr.push(b);
      map.set(key, arr);
    }
    return map;
  }, [blocks]);

  // --- Drafts: segments + text typed locally before the server write lands.
  const [drafts, setDrafts] = React.useState<
    Record<string, { segments: Segment[]; text: string }>
  >({});

  // Slash menu state — one open at a time across the editor.
  const [slash, setSlash] = React.useState<SlashState | null>(null);
  const [actionMenu, setActionMenu] = React.useState<ActionMenuState | null>(
    null,
  );
  const [toolbar, setToolbar] = React.useState<ToolbarState | null>(null);
  const [selectedIds, setSelectedIds] = React.useState<readonly string[]>([]);
  const [hoveredId, setHoveredId] = React.useState<string | null>(null);
  const [focusedId, setFocusedId] = React.useState<string | null>(null);
  const [focusRequest, setFocusRequest] = React.useState<string | null>(null);

  const editorContainerRef = React.useRef<View | null>(null);
  const blockNodeRefs = React.useRef<Record<string, HTMLDivElement | null>>({});
  const inputRefs = React.useRef<
    Record<string, React.RefObject<TextInput | null>>
  >({});
  const handleRefs = React.useRef<
    Record<string, React.MutableRefObject<RichEditableHandle | null>>
  >({});
  const saveTimersRef = React.useRef<
    Record<string, ReturnType<typeof setTimeout>>
  >({});

  const getInputRef = React.useCallback(
    (id: string): React.RefObject<TextInput | null> => {
      if (!inputRefs.current[id]) {
        inputRefs.current[id] = React.createRef<TextInput>();
      }
      return inputRefs.current[id];
    },
    [],
  );

  const getHandleRef = React.useCallback(
    (id: string): React.MutableRefObject<RichEditableHandle | null> => {
      if (!handleRefs.current[id]) {
        handleRefs.current[id] = { current: null };
      }
      return handleRefs.current[id];
    },
    [],
  );

  // Focus a freshly-created block when it appears in the rendered list.
  React.useEffect(() => {
    if (!focusRequest) return;
    const target = blocks.find((b) => b._id === focusRequest);
    if (!target) return;
    const handle = handleRefs.current[focusRequest]?.current;
    const input = inputRefs.current[focusRequest]?.current;
    if (handle) {
      handle.focus();
      setFocusRequest(null);
    } else if (input) {
      input.focus();
      setFocusRequest(null);
    }
  }, [blocks, focusRequest]);

  const currentSegmentsFor = React.useCallback(
    (block: Block): Segment[] => {
      const draft = drafts[block._id];
      if (draft) return draft.segments;
      const segs = block.content.segments;
      if (segs && segs.length > 0) return segs;
      const t = block.content.text ?? "";
      return t.length > 0 ? [{ text: t }] : [];
    },
    [drafts],
  );

  const currentTextFor = React.useCallback(
    (block: Block): string => {
      const draft = drafts[block._id];
      if (draft) return draft.text;
      return block.content.text ?? "";
    },
    [drafts],
  );

  // -- Persist helpers ------------------------------------------------------
  const scheduleSave = React.useCallback(
    (block: Block, next: { segments: Segment[]; text: string }) => {
      const existing = saveTimersRef.current[block._id];
      if (existing) clearTimeout(existing);
      saveTimersRef.current[block._id] = setTimeout(() => {
        updateBlock.mutate({
          id: block._id,
          pageId,
          content: {
            ...block.content,
            segments: next.segments,
            text: next.text,
          },
        });
      }, 300);
    },
    [pageId, updateBlock],
  );

  const flushSave = React.useCallback((blockId: string) => {
    const existing = saveTimersRef.current[blockId];
    if (existing) {
      clearTimeout(existing);
      delete saveTimersRef.current[blockId];
    }
  }, []);

  // -- Slash menu trigger detection -----------------------------------------
  const maybeOpenSlash = React.useCallback(
    (block: Block, text: string) => {
      if (slash && slash.blockId === block._id) {
        if (text[slash.slashIndex] !== "/") {
          setSlash(null);
          return;
        }
        const handle = handleRefs.current[block._id]?.current;
        const range = handle?.getSelection();
        if (!range) return;
        const queryEnd = range.start;
        if (queryEnd <= slash.slashIndex) {
          setSlash(null);
          return;
        }
        const query = text.slice(slash.slashIndex + 1, queryEnd);
        if (query.includes(" ") || query.includes("\n")) {
          setSlash(null);
          return;
        }
        setSlash({ ...slash, query });
        return;
      }
      const handle = handleRefs.current[block._id]?.current;
      const range = handle?.getSelection();
      if (!range) return;
      const caret = range.start;
      if (caret === 0) return;
      const justTyped = text[caret - 1];
      if (justTyped !== "/") return;
      const prevChar = caret >= 2 ? text[caret - 2] : "";
      if (caret === 1 || prevChar === " " || prevChar === "\n") {
        setSlash({ blockId: block._id, slashIndex: caret - 1, query: "" });
      }
    },
    [slash],
  );

  // -- Change handler from RichEditable -------------------------------------
  const handleChange = React.useCallback(
    (block: Block, next: { segments: Segment[]; text: string }) => {
      setDrafts((prev) => ({ ...prev, [block._id]: next }));
      scheduleSave(block, next);
      if (Platform.OS === "web") {
        maybeOpenSlash(block, next.text);
      }
    },
    [maybeOpenSlash, scheduleSave],
  );

  const closeSlash = React.useCallback(() => setSlash(null), []);

  const handleSlashSelect = React.useCallback(
    async (block: Block, nextType: BlockType) => {
      if (!slash || slash.blockId !== block._id) return;
      const text = currentTextFor(block);
      const stripped =
        text.slice(0, slash.slashIndex) +
        text.slice(slash.slashIndex + 1 + slash.query.length);
      const nextSegments: Segment[] =
        stripped.length > 0 ? [{ text: stripped }] : [];
      setDrafts((prev) => ({
        ...prev,
        [block._id]: { segments: nextSegments, text: stripped },
      }));
      flushSave(block._id);
      setSlash(null);
      try {
        await updateBlock.mutateAsync({
          id: block._id,
          pageId,
          type: nextType,
          content: {
            ...block.content,
            segments: nextSegments,
            text: stripped,
            ...(nextType === "toggle" ? { expanded: true } : {}),
            ...(nextType === "columns" ? { columnCount: 2 } : {}),
            ...(nextType === "table"
              ? { rows: 2, cols: 2, withHeader: false }
              : {}),
          },
        });
        // Bootstrap container children so the block is usable immediately
        // after slash-menu conversion (Phase 3 layout blocks).
        if (nextType === "columns") {
          for (let i = 0; i < 2; i += 1) {
            await createBlock.mutateAsync({
              pageId,
              type: "column",
              content: {},
              parentBlockId: block._id,
              order: i,
            });
          }
        } else if (nextType === "table") {
          for (let r = 0; r < 2; r += 1) {
            const row = await createBlock.mutateAsync({
              pageId,
              type: "table_row",
              content: {},
              parentBlockId: block._id,
              order: r,
            });
            for (let c = 0; c < 2; c += 1) {
              await createBlock.mutateAsync({
                pageId,
                type: "table_cell",
                content: { text: "" },
                parentBlockId: row._id,
                order: c,
              });
            }
          }
        }
        const handle = handleRefs.current[block._id]?.current;
        handle?.focus();
      } catch {
        // Surface via mutation state.
      }
    },
    [createBlock, currentTextFor, flushSave, pageId, slash, updateBlock],
  );

  // -- Block creation / deletion / order ------------------------------------
  const orderForAfter = React.useCallback(
    (afterIndex: number) => {
      const after = blocks[afterIndex];
      const before = blocks[afterIndex + 1];
      if (after && before) {
        return (after.order + before.order) / 2;
      }
      if (after) return after.order + ORDER_STEP;
      if (before) return before.order - ORDER_STEP;
      return ORDER_STEP;
    },
    [blocks],
  );

  const handleSubmitNew = React.useCallback(
    async (block: Block) => {
      const idx = blocks.findIndex((b) => b._id === block._id);
      const nextOrder = orderForAfter(idx);
      try {
        const created = await createBlock.mutateAsync({
          pageId,
          type: "paragraph",
          content: { text: "", segments: [] },
          order: nextOrder,
        });
        setFocusRequest(created._id);
      } catch {
        // Surface via mutation state.
      }
    },
    [blocks, createBlock, orderForAfter, pageId],
  );

  const handleBackspaceAtStart = React.useCallback(
    async (block: Block) => {
      const idx = blocks.findIndex((b) => b._id === block._id);
      const previous = idx > 0 ? blocks[idx - 1] : null;
      const text = currentTextFor(block);
      if (text.length === 0 && blocks.length > 1) {
        try {
          await deleteBlock.mutateAsync({ id: block._id, pageId });
          if (previous) setFocusRequest(previous._id);
        } catch {
          // Surface via mutation state.
        }
      } else if (previous) {
        handleRefs.current[previous._id]?.current?.focus();
      }
    },
    [blocks, currentTextFor, deleteBlock, pageId],
  );

  const handleIndent = React.useCallback(
    async (block: Block, outdent: boolean) => {
      if (
        block.type !== "bulleted_list_item" &&
        block.type !== "numbered_list_item" &&
        block.type !== "to_do"
      ) {
        return;
      }
      const idx = blocks.findIndex((b) => b._id === block._id);
      if (outdent) {
        if (!block.parentBlockId) return;
        try {
          await updateBlock.mutateAsync({
            id: block._id,
            pageId,
            parentBlockId: null,
          });
        } catch {
          // Surface via mutation state.
        }
        return;
      }
      const above = blocks[idx - 1];
      if (!above) return;
      try {
        await updateBlock.mutateAsync({
          id: block._id,
          pageId,
          parentBlockId: above._id,
        });
      } catch {
        // Surface via mutation state.
      }
    },
    [blocks, pageId, updateBlock],
  );

  const handleToggleChecked = React.useCallback(
    (block: Block) => {
      if (block.type !== "to_do") return;
      updateBlock.mutate({
        id: block._id,
        pageId,
        content: { ...block.content, checked: !block.content.checked },
      });
    },
    [pageId, updateBlock],
  );

  const handleToggleExpanded = React.useCallback(
    (block: Block) => {
      if (block.type !== "toggle") return;
      const expanded = block.content.expanded !== false;
      updateBlock.mutate({
        id: block._id,
        pageId,
        content: { ...block.content, expanded: !expanded },
      });
    },
    [pageId, updateBlock],
  );

  // -- Drag and drop --------------------------------------------------------
  const dnd = useEditorDnd({
    blockIdForNode: (node) => {
      let cur: Element | null = node;
      while (cur && cur instanceof HTMLElement) {
        const id = cur.dataset.blockId;
        if (id) return id;
        cur = cur.parentElement;
      }
      return null;
    },
    rectForBlock: (id) => {
      const el = blockNodeRefs.current[id];
      if (!el) return null;
      return el.getBoundingClientRect();
    },
    onDrop: (sourceId, indicator) => {
      const flat = blocks.filter((b) => !b.parentBlockId);
      const ids = flat.map((b) => b._id);
      const targetIndex = ids.indexOf(indicator.blockId);
      if (targetIndex < 0) return;
      const insertAt =
        indicator.position === "above" ? targetIndex : targetIndex + 1;
      const without = ids.filter((id) => id !== sourceId);
      const adjusted =
        ids.indexOf(sourceId) < insertAt ? insertAt - 1 : insertAt;
      without.splice(adjusted, 0, sourceId);
      reorderBlocks.mutate({ pageId, blockIds: without });
    },
    previewLabel: (id) => {
      const b = blocks.find((x) => x._id === id);
      const text = b ? currentTextFor(b) : "";
      const truncated = text.length > 40 ? `${text.slice(0, 40)}…` : text;
      return truncated || (b?.type ?? "Block");
    },
  });

  // -- Markdown shortcuts ---------------------------------------------------
  const applyMarkdownShortcut = React.useCallback(
    async (block: Block): Promise<boolean> => {
      const text = currentTextFor(block);
      const detected = detectShortcut(text);
      if (!detected) return false;
      flushSave(block._id);
      const nextSegments: Segment[] =
        detected.remainder.length > 0 ? [{ text: detected.remainder }] : [];
      setDrafts((prev) => ({
        ...prev,
        [block._id]: { segments: nextSegments, text: detected.remainder },
      }));
      try {
        await updateBlock.mutateAsync({
          id: block._id,
          pageId,
          type: detected.type,
          content: {
            ...block.content,
            segments: nextSegments,
            text: detected.remainder,
            ...(detected.type === "toggle" ? { expanded: true } : {}),
          },
        });
        if (detected.type === "divider") {
          const idx = blocks.findIndex((b) => b._id === block._id);
          const created = await createBlock.mutateAsync({
            pageId,
            type: "paragraph",
            content: { text: "", segments: [] },
            order: orderForAfter(idx),
          });
          setFocusRequest(created._id);
        } else {
          handleRefs.current[block._id]?.current?.focus();
        }
      } catch {
        // Surface via mutation state.
      }
      return true;
    },
    [
      blocks,
      createBlock,
      currentTextFor,
      flushSave,
      orderForAfter,
      pageId,
      updateBlock,
    ],
  );

  /**
   * Inline markdown shortcut application. Called immediately after a text
   * change so it sees the latest text. Returns true when a shortcut applied
   * (caller can skip the regular onChange handling if needed).
   */
  const applyInlineShortcut = React.useCallback(
    (block: Block, latest: { segments: Segment[]; text: string }): boolean => {
      const handle = handleRefs.current[block._id]?.current;
      const range = handle?.getSelection();
      if (!range) return false;
      const text = latest.text;
      const before = text.slice(0, range.start);
      const inline = detectInlineShortcut(before);
      if (!inline) return false;
      const headLen = inline.start;
      const innerStart = inline.start;
      const innerEnd = innerStart + inline.inner.length;
      const newText =
        text.slice(0, inline.start) +
        inline.inner +
        text.slice(inline.end);
      const head = newText.slice(0, headLen);
      const tail = newText.slice(innerEnd);
      const annotated: Segment[] = [];
      if (head.length > 0) annotated.push({ text: head });
      if (inline.inner.length > 0) {
        const innerSeg: Segment = { text: inline.inner };
        innerSeg[inline.mark] = true;
        annotated.push(innerSeg);
      }
      if (tail.length > 0) annotated.push({ text: tail });
      const next = { segments: annotated, text: newText };
      setDrafts((prev) => ({ ...prev, [block._id]: next }));
      scheduleSave(block, next);
      const caret = innerEnd;
      requestAnimationFrame(() => {
        handleRefs.current[block._id]?.current?.setSelection({
          start: caret,
          end: caret,
        });
      });
      return true;
    },
    [scheduleSave],
  );

  // -- Block-level rich text mutation ---------------------------------------
  const mutateSegmentsRange = React.useCallback(
    (
      blockId: string,
      range: CaretRange,
      patch: Parameters<typeof applyAnnotationRange>[3],
    ) => {
      const block = blocks.find((b) => b._id === blockId);
      if (!block) return;
      const segments = ensureSegments(
        currentSegmentsFor(block),
        currentTextFor(block),
      );
      const nextSegments = applyAnnotationRange(
        segments,
        range.start,
        range.end,
        patch,
      );
      const text = segmentsToPlainText(nextSegments);
      const next = { segments: nextSegments, text };
      setDrafts((prev) => ({ ...prev, [blockId]: next }));
      scheduleSave(block, next);
    },
    [blocks, currentSegmentsFor, currentTextFor, scheduleSave],
  );

  const toggleMark = React.useCallback(
    (
      blockId: string,
      range: CaretRange,
      mark: keyof FormattingState,
    ) => {
      const block = blocks.find((b) => b._id === blockId);
      if (!block) return;
      const segments = ensureSegments(
        currentSegmentsFor(block),
        currentTextFor(block),
      );
      const active = rangeHasMark(segments, range.start, range.end, mark);
      mutateSegmentsRange(blockId, range, { [mark]: !active });
      setToolbar((t) =>
        t && t.blockId === blockId
          ? { ...t, active: { ...t.active, [mark]: !active } }
          : t,
      );
    },
    [blocks, currentSegmentsFor, currentTextFor, mutateSegmentsRange],
  );

  // -- Selection toolbar ---------------------------------------------------
  const handleSelectionChange = React.useCallback(
    (block: Block, range: CaretRange) => {
      if (Platform.OS !== "web") return;
      if (range.start === range.end) {
        setToolbar(null);
        return;
      }
      const node = blockNodeRefs.current[block._id];
      const winSel =
        typeof window !== "undefined" ? window.getSelection() : null;
      let anchor: ToolbarState["anchor"] = null;
      if (winSel && winSel.rangeCount > 0) {
        const r = winSel.getRangeAt(0);
        const rect = r.getBoundingClientRect();
        if (rect && rect.width + rect.height > 0) {
          anchor = {
            top: rect.top + window.scrollY,
            left: rect.left + window.scrollX,
            width: rect.width,
          };
        }
      } else if (node) {
        const rect = node.getBoundingClientRect();
        anchor = {
          top: rect.top + window.scrollY,
          left: rect.left + window.scrollX,
          width: rect.width,
        };
      }
      const segments = ensureSegments(
        currentSegmentsFor(block),
        currentTextFor(block),
      );
      const active: FormattingState = {
        bold: rangeHasMark(segments, range.start, range.end, "bold"),
        italic: rangeHasMark(segments, range.start, range.end, "italic"),
        underline: rangeHasMark(segments, range.start, range.end, "underline"),
        strike: rangeHasMark(segments, range.start, range.end, "strike"),
        code: rangeHasMark(segments, range.start, range.end, "code"),
      };
      setToolbar({ blockId: block._id, range, anchor, active });
    },
    [currentSegmentsFor, currentTextFor],
  );

  // -- Keyboard shortcuts (web) --------------------------------------------
  const handleEditorKeyDown = React.useCallback(
    (
      block: Block,
      event: KeyboardEvent,
      range: CaretRange,
    ): boolean | void => {
      if (Platform.OS !== "web") return;
      const meta = event.metaKey || event.ctrlKey;

      if (event.key === "Escape" && slash) {
        event.preventDefault();
        setSlash(null);
        return true;
      }
      if (slash && slash.blockId === block._id) {
        if (
          event.key === "ArrowDown" ||
          event.key === "ArrowUp" ||
          event.key === "Enter"
        ) {
          // SlashMenu owns these via its own global listener.
          return false;
        }
      }

      if (meta && event.key === "/") {
        event.preventDefault();
        const node = blockNodeRefs.current[block._id];
        if (node) {
          const rect = node.getBoundingClientRect();
          setActionMenu({
            blockId: block._id,
            anchor: {
              top: rect.bottom + window.scrollY + 4,
              left: rect.left + window.scrollX,
            },
          });
        } else {
          setActionMenu({ blockId: block._id, anchor: null });
        }
        return true;
      }

      if (meta && (event.key === "a" || event.key === "A")) {
        const text = currentTextFor(block);
        if (range.start === 0 && range.end === text.length) {
          event.preventDefault();
          setSelectedIds(blocks.map((b) => b._id));
          return true;
        }
        return false;
      }

      if (meta && (event.key === "b" || event.key === "B")) {
        event.preventDefault();
        toggleMark(block._id, range, "bold");
        return true;
      }
      if (meta && (event.key === "i" || event.key === "I")) {
        event.preventDefault();
        toggleMark(block._id, range, "italic");
        return true;
      }
      if (meta && (event.key === "u" || event.key === "U")) {
        event.preventDefault();
        toggleMark(block._id, range, "underline");
        return true;
      }
      if (meta && (event.key === "e" || event.key === "E")) {
        event.preventDefault();
        toggleMark(block._id, range, "code");
        return true;
      }
      if (
        meta &&
        event.shiftKey &&
        (event.key === "s" || event.key === "S")
      ) {
        event.preventDefault();
        toggleMark(block._id, range, "strike");
        return true;
      }
      if (meta && (event.key === "k" || event.key === "K")) {
        event.preventDefault();
        const url = window.prompt("Link URL");
        if (url !== null) {
          mutateSegmentsRange(block._id, range, {
            link: url.length === 0 ? undefined : url,
          });
        }
        return true;
      }

      // Markdown block-level shortcut: trigger on " " or other prefixes.
      if (event.key === " " && block.type === "paragraph") {
        const text = currentTextFor(block);
        if (range.start === text.length) {
          const detected = detectShortcut(text);
          if (detected) {
            event.preventDefault();
            void applyMarkdownShortcut(block);
            return true;
          }
        }
      }
      if (event.key === "-" && block.type === "paragraph") {
        const text = currentTextFor(block);
        if (text === "--" && range.start === 2) {
          event.preventDefault();
          // Update local draft so detectShortcut sees the third dash.
          setDrafts((prev) => ({
            ...prev,
            [block._id]: {
              segments: [{ text: "---" }],
              text: "---",
            },
          }));
          void applyMarkdownShortcut({
            ...block,
            content: { ...block.content, text: "---" },
          });
          return true;
        }
      }
      if (event.key === "`" && block.type === "paragraph") {
        const text = currentTextFor(block);
        if (text === "``" && range.start === 2) {
          event.preventDefault();
          setDrafts((prev) => ({
            ...prev,
            [block._id]: { segments: [{ text: "```" }], text: "```" },
          }));
          void applyMarkdownShortcut({
            ...block,
            content: { ...block.content, text: "```" },
          });
          return true;
        }
      }

      return undefined;
    },
    [
      applyMarkdownShortcut,
      blocks,
      currentTextFor,
      mutateSegmentsRange,
      slash,
      toggleMark,
    ],
  );

  // -- Block click for multi-block selection -------------------------------
  const handleBlockMouseDown = React.useCallback(
    (block: Block, event: React.MouseEvent<HTMLDivElement>) => {
      if (Platform.OS !== "web") return;
      if (event.shiftKey) {
        const anchor = focusedId ?? selectedIds[0] ?? block._id;
        const aIdx = blocks.findIndex((b) => b._id === anchor);
        const bIdx = blocks.findIndex((b) => b._id === block._id);
        if (aIdx < 0 || bIdx < 0) return;
        const [lo, hi] = aIdx < bIdx ? [aIdx, bIdx] : [bIdx, aIdx];
        const ids = blocks.slice(lo, hi + 1).map((b) => b._id);
        setSelectedIds(ids);
        event.preventDefault();
      } else {
        setSelectedIds([]);
      }
    },
    [blocks, focusedId, selectedIds],
  );

  // -- Multi-block keyboard actions ----------------------------------------
  React.useEffect(() => {
    if (Platform.OS !== "web") return;
    if (selectedIds.length === 0) return;
    const handler = (ev: KeyboardEvent) => {
      if (ev.key === "Escape") {
        ev.preventDefault();
        setSelectedIds([]);
        return;
      }
      if (ev.key === "Backspace" || ev.key === "Delete") {
        ev.preventDefault();
        for (const id of selectedIds) {
          deleteBlock.mutate({ id, pageId });
        }
        setSelectedIds([]);
        return;
      }
      const meta = ev.metaKey || ev.ctrlKey;
      if (meta && (ev.key === "c" || ev.key === "C")) {
        const text = blocks
          .filter((b) => selectedIds.includes(b._id))
          .map((b) => currentTextFor(b))
          .join("\n");
        navigator.clipboard.writeText(text).catch(() => {
          /* user-initiated; ignore */
        });
        ev.preventDefault();
        return;
      }
      if (meta && (ev.key === "x" || ev.key === "X")) {
        const text = blocks
          .filter((b) => selectedIds.includes(b._id))
          .map((b) => currentTextFor(b))
          .join("\n");
        navigator.clipboard.writeText(text).catch(() => {
          /* ignore */
        });
        for (const id of selectedIds) {
          deleteBlock.mutate({ id, pageId });
        }
        setSelectedIds([]);
        ev.preventDefault();
        return;
      }
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [blocks, currentTextFor, deleteBlock, pageId, selectedIds]);

  // -- Block menu actions ---------------------------------------------------
  const openActionMenuAtAnchor = React.useCallback(
    (blockId: string, anchor: { top: number; left: number } | null) => {
      setActionMenu({ blockId, anchor });
    },
    [],
  );

  const closeActionMenu = React.useCallback(() => setActionMenu(null), []);

  const handleTurnInto = React.useCallback(
    async (blockId: string, type: BlockType) => {
      const block = blocks.find((b) => b._id === blockId);
      if (!block) return;
      try {
        await updateBlock.mutateAsync({
          id: blockId,
          pageId,
          type,
          content: {
            ...block.content,
            ...(type === "toggle" ? { expanded: true } : {}),
          },
        });
      } catch {
        // Surface via mutation state.
      }
    },
    [blocks, pageId, updateBlock],
  );

  const handleDuplicate = React.useCallback(
    async (blockId: string) => {
      const block = blocks.find((b) => b._id === blockId);
      if (!block) return;
      const idx = blocks.findIndex((b) => b._id === blockId);
      try {
        const created = await createBlock.mutateAsync({
          pageId,
          type: block.type,
          content: { ...block.content },
          order: orderForAfter(idx),
          parentBlockId: block.parentBlockId,
        });
        setFocusRequest(created._id);
      } catch {
        // Surface via mutation state.
      }
    },
    [blocks, createBlock, orderForAfter, pageId],
  );

  const handleDelete = React.useCallback(
    async (blockId: string) => {
      try {
        await deleteBlock.mutateAsync({ id: blockId, pageId });
      } catch {
        // Surface via mutation state.
      }
    },
    [deleteBlock, pageId],
  );

  const handleSetColor = React.useCallback(
    (blockId: string, color: BlockColor) => {
      const block = blocks.find((b) => b._id === blockId);
      if (!block) return;
      updateBlock.mutate({
        id: blockId,
        pageId,
        content: {
          ...block.content,
          color: color === "default" ? undefined : color,
        },
      });
    },
    [blocks, pageId, updateBlock],
  );

  const handleSetBackground = React.useCallback(
    (blockId: string, color: BlockColor) => {
      const block = blocks.find((b) => b._id === blockId);
      if (!block) return;
      updateBlock.mutate({
        id: blockId,
        pageId,
        content: {
          ...block.content,
          backgroundColor: color === "default" ? undefined : color,
        },
      });
    },
    [blocks, pageId, updateBlock],
  );

  const handleCopyLink = React.useCallback((blockId: string) => {
    if (typeof window === "undefined") return;
    const url = `${window.location.origin}${window.location.pathname}#block-${blockId}`;
    navigator.clipboard.writeText(url).catch(() => {
      /* ignore */
    });
  }, []);

  /**
   * Non-rich-text content patch (Phase 3 renderers — image url, table size,
   * embed url, etc.). Persists immediately rather than debouncing; these
   * patches are coarse-grained and typically follow a discrete UI action.
   */
  const handleChangeContent = React.useCallback(
    (block: Block, next: Block["content"]) => {
      flushSave(block._id);
      updateBlock.mutate({
        id: block._id,
        pageId,
        content: { ...block.content, ...next },
      });
    },
    [flushSave, pageId, updateBlock],
  );

  // -- Numbered list indexing ----------------------------------------------
  const numberedIndex = React.useMemo(() => {
    const result: Record<string, number> = {};
    let counter = 0;
    let lastParent: string | null | undefined = undefined;
    for (const b of blocks) {
      if (b.type === "numbered_list_item") {
        if (lastParent === b.parentBlockId) {
          counter += 1;
        } else {
          counter = 1;
          lastParent = b.parentBlockId;
        }
        result[b._id] = counter;
      } else {
        counter = 0;
        lastParent = undefined;
      }
    }
    return result;
  }, [blocks]);

  // -- Top-level "Add block" button ----------------------------------------
  const handleAddBlockButton = React.useCallback(async () => {
    const last = blocks[blocks.length - 1];
    const nextOrder = last ? last.order + ORDER_STEP : ORDER_STEP;
    try {
      const created = await createBlock.mutateAsync({
        pageId,
        type: "paragraph",
        content: { text: "", segments: [] },
        order: nextOrder,
      });
      setFocusRequest(created._id);
    } catch {
      // Surface via mutation state.
    }
  }, [blocks, createBlock, pageId]);

  if (isLoading) {
    return (
      <View className="px-1 py-6">
        <ActivityIndicator color={colors.mutedForeground} />
      </View>
    );
  }

  const rootBlocks = childMap.get(null) ?? [];

  // Mutable holder for the render-tree callback — populated below once
  // the row handler bag exists. Keeps the closure stable across renders.
  const renderChildrenOfRef = React.useRef<(parentId: string) => React.ReactNode>(
    () => null,
  );

  // Build a typed bag of per-row handlers to avoid prop drilling chains.
  const rowHandlers: RowHandlerBag = {
    getInputRef,
    getHandleRef,
    blockNodeRefs,
    onChange: handleChange,
    onChangeContent: handleChangeContent,
    onSubmitNew: handleSubmitNew,
    onBackspaceAtStart: handleBackspaceAtStart,
    onIndent: handleIndent,
    onKeyDown: handleEditorKeyDown,
    onSelectionChange: handleSelectionChange,
    onToggleChecked: handleToggleChecked,
    onToggleExpanded: handleToggleExpanded,
    onPlus: handleSubmitNew,
    onMouseDown: handleBlockMouseDown,
    applyInlineShortcut,
    openActionMenu: openActionMenuAtAnchor,
    setHoveredId,
    setFocusedId,
    onOpenBlockComments,
    renderChildrenOf: (id) => renderChildrenOfRef.current(id),
  };

  renderChildrenOfRef.current = (parentId: string) => {
    const kids = childMap.get(parentId) ?? [];
    return kids.map((child) =>
      renderBlockTree({
        block: child,
        depth: 0,
        childMap,
        dnd,
        slash,
        selectedIds,
        hoveredId,
        numberedIndex,
        handlers: rowHandlers,
      }),
    );
  };

  return (
    <View
      ref={editorContainerRef}
      className="gap-1"
      data-editor-root
    >
      {rootBlocks.map((block) =>
        renderBlockTree({
          block,
          depth: 0,
          childMap,
          dnd,
          slash,
          selectedIds,
          hoveredId,
          numberedIndex,
          handlers: rowHandlers,
        }),
      )}

      {slash ? (
        <SlashMenuOverlay
          blockNode={blockNodeRefs.current[slash.blockId] ?? null}
          query={slash.query}
          onSelect={(type) => {
            const block = blocks.find((b) => b._id === slash.blockId);
            if (block) void handleSlashSelect(block, type);
          }}
          onClose={closeSlash}
        />
      ) : null}

      {actionMenu ? (
        <BlockActionMenu
          open
          anchor={actionMenu.anchor}
          currentType={
            blocks.find((b) => b._id === actionMenu.blockId)?.type ?? "paragraph"
          }
          onClose={closeActionMenu}
          onTurnInto={(t) => void handleTurnInto(actionMenu.blockId, t)}
          onDuplicate={() => void handleDuplicate(actionMenu.blockId)}
          onDelete={() => void handleDelete(actionMenu.blockId)}
          onSetColor={(c) => handleSetColor(actionMenu.blockId, c)}
          onSetBackground={(c) => handleSetBackground(actionMenu.blockId, c)}
          onCopyLink={() => handleCopyLink(actionMenu.blockId)}
        />
      ) : null}

      {toolbar ? (
        <FormattingToolbar
          open
          anchor={toolbar.anchor}
          active={toolbar.active}
          onToggle={(mark) => toggleMark(toolbar.blockId, toolbar.range, mark)}
          onSetColor={(c) =>
            mutateSegmentsRange(toolbar.blockId, toolbar.range, { color: c })
          }
          onSetBackground={(c) =>
            mutateSegmentsRange(toolbar.blockId, toolbar.range, {
              background: c,
            })
          }
          onSetLink={(url) =>
            mutateSegmentsRange(toolbar.blockId, toolbar.range, {
              link: url ?? undefined,
            })
          }
        />
      ) : null}

      {dnd.renderPreview()}

      <Pressable
        onPress={handleAddBlockButton}
        className="mt-2 flex-row items-center gap-2 self-start rounded-md px-2 py-1 hover:bg-muted active:bg-muted"
        disabled={createBlock.isPending}
        accessibilityLabel="Add block"
      >
        <Plus size={14} color={colors.mutedForeground} />
        <Text className="text-sm text-muted-foreground">
          {createBlock.isPending ? "Adding…" : "Add block"}
        </Text>
      </Pressable>

      {blocks.length === 0 ? (
        <View className="mt-4">
          <Text className="text-sm text-muted-foreground">
            Press “Add block” to start. Inside a block, type{" "}
            <Text className="text-sm text-foreground">/</Text>{" "}
            to insert one of {getSlashMenuOptions().length} block types.
          </Text>
        </View>
      ) : null}
    </View>
  );
}

interface RowHandlerBag {
  getInputRef: (id: string) => React.RefObject<TextInput | null>;
  getHandleRef: (
    id: string,
  ) => React.MutableRefObject<RichEditableHandle | null>;
  blockNodeRefs: React.MutableRefObject<
    Record<string, HTMLDivElement | null>
  >;
  onChange: (
    block: Block,
    next: { segments: Segment[]; text: string },
  ) => void;
  onChangeContent: (block: Block, next: Block["content"]) => void;
  onSubmitNew: (block: Block) => void;
  onBackspaceAtStart: (block: Block) => void;
  onIndent: (block: Block, outdent: boolean) => void;
  onKeyDown: (
    block: Block,
    event: KeyboardEvent,
    range: CaretRange,
  ) => boolean | void;
  onSelectionChange: (block: Block, range: CaretRange) => void;
  onToggleChecked: (block: Block) => void;
  onToggleExpanded: (block: Block) => void;
  onPlus: (block: Block) => void;
  onMouseDown: (block: Block, e: React.MouseEvent<HTMLDivElement>) => void;
  applyInlineShortcut: (
    block: Block,
    latest: { segments: Segment[]; text: string },
  ) => boolean;
  openActionMenu: (
    blockId: string,
    anchor: { top: number; left: number } | null,
  ) => void;
  setHoveredId: (id: string | null) => void;
  setFocusedId: (id: string | null) => void;
  onOpenBlockComments?: (blockId: string) => void;
  /** Render child blocks of `parentId` for Phase 3 container blocks. */
  renderChildrenOf: (parentId: string) => React.ReactNode;
}

interface RenderArgs {
  block: Block;
  depth: number;
  childMap: Map<string | null, Block[]>;
  dnd: ReturnType<typeof useEditorDnd>;
  slash: SlashState | null;
  selectedIds: readonly string[];
  hoveredId: string | null;
  numberedIndex: Record<string, number>;
  handlers: RowHandlerBag;
}

/**
 * Block types whose renderer is responsible for placing its own children
 * (via the `renderChildren(parentId)` callback). The outer tree skips its
 * children recursion for these so the children don't appear twice.
 *
 * Note: `toggle` is intentionally NOT in this set — my Editor v2 ToggleBlock
 * defers child placement to the outer tree so toggle nesting stays
 * consistent with bulleted/numbered/to-do parents.
 */
const CONTAINER_BLOCK_TYPES = new Set<BlockType>([
  "columns",
  "column",
  "table",
  "table_row",
]);

function renderBlockTree(args: RenderArgs): React.ReactNode {
  const {
    block,
    depth,
    childMap,
    dnd,
    selectedIds,
    hoveredId,
    numberedIndex,
    handlers,
  } = args;
  const isSelected = selectedIds.includes(block._id);
  const isHovered = hoveredId === block._id;
  const isDragOver =
    dnd.indicator?.blockId === block._id ? dnd.indicator.position : null;
  const children = childMap.get(block._id) ?? [];
  const expanded =
    block.type === "toggle" ? block.content.expanded !== false : true;
  const containerOwnsChildren = CONTAINER_BLOCK_TYPES.has(block.type);

  const rowContent = (
    <View
      className={cn(
        "relative",
        isSelected ? "rounded bg-primary/10" : null,
      )}
    >
      <DragHandle
        visible={isHovered || dnd.draggingBlockId === block._id}
        blockId={block._id}
        onOpenMenu={(anchor) =>
          handlers.openActionMenu(block._id, anchor)
        }
        onPlus={() => handlers.onPlus(block)}
        onDragStart={(ev) => dnd.onHandlePointerDown(block._id, ev)}
      />
      <BlockView
        block={block}
        autoFocus={false}
        inputRef={handlers.getInputRef(block._id)}
        handleRef={handlers.getHandleRef(block._id)}
        onChangeContent={(next) => handlers.onChangeContent(block, next)}
        renderChildren={handlers.renderChildrenOf}
        handlers={{
          onChange: (next) => {
            const consumed = handlers.applyInlineShortcut(block, next);
            if (!consumed) handlers.onChange(block, next);
          },
          onSubmit: () => handlers.onSubmitNew(block),
          onBackspaceAtStart: () => handlers.onBackspaceAtStart(block),
          onIndent: (outdent) => handlers.onIndent(block, outdent),
          onKeyDown: (event, range) =>
            handlers.onKeyDown(block, event, range),
          onSelectionChange: (range) =>
            handlers.onSelectionChange(block, range),
          onToggleChecked: () => handlers.onToggleChecked(block),
          onToggleExpanded: () => handlers.onToggleExpanded(block),
          listIndex: numberedIndex[block._id],
        }}
      />
    </View>
  );

  const withComments = handlers.onOpenBlockComments ? (
    <View className="flex-row items-start gap-1">
      <View className="flex-1 min-w-0">{rowContent}</View>
      <View className="w-7 items-end pt-1 shrink-0">
        <CommentIndicator
          blockId={block._id}
          onPress={() => handlers.onOpenBlockComments?.(block._id)}
          alwaysVisible={Platform.OS === "web" ? isHovered : false}
        />
      </View>
    </View>
  ) : (
    rowContent
  );

  if (Platform.OS === "web") {
    return (
      <View key={block._id} style={{ marginLeft: depth * 24 }}>
        <div
          ref={(el) => {
            handlers.blockNodeRefs.current[block._id] = el;
          }}
          data-block-id={block._id}
          onMouseEnter={() => handlers.setHoveredId(block._id)}
          onMouseLeave={() =>
            handlers.setHoveredId(
              hoveredId === block._id ? null : hoveredId,
            )
          }
          onMouseDown={(e) => handlers.onMouseDown(block, e)}
          onFocusCapture={() => handlers.setFocusedId(block._id)}
          style={{ position: "relative" }}
        >
          {isDragOver === "above" ? <DropIndicatorLine /> : null}
          {withComments}
          {isDragOver === "below" ? <DropIndicatorLine /> : null}
        </div>
        {containerOwnsChildren || (block.type === "toggle" && !expanded)
          ? null
          : (
              <View>
                {children.map((child) =>
                  renderBlockTree({ ...args, block: child, depth: depth + 1 }),
                )}
              </View>
            )}
      </View>
    );
  }

  return (
    <View key={block._id} style={{ marginLeft: depth * 16 }}>
      {withComments}
      {block.type === "toggle" && !expanded ? null : (
        <View>
          {children.map((child) =>
            renderBlockTree({ ...args, block: child, depth: depth + 1 }),
          )}
        </View>
      )}
    </View>
  );
}

function DropIndicatorLine() {
  return (
    <View
      className="absolute left-0 right-0 h-0.5 bg-primary"
      style={{ top: 0 }}
    />
  );
}

/**
 * Overlay wrapper that positions the slash menu below the active block.
 * On web we anchor to the block's bounding rect; on native the SlashMenu
 * paints itself as a bottom-sheet so the rect is irrelevant.
 */
function SlashMenuOverlay({
  blockNode,
  query,
  onSelect,
  onClose,
}: {
  blockNode: HTMLDivElement | null;
  query: string;
  onSelect: (type: BlockType) => void;
  onClose: () => void;
}) {
  if (Platform.OS !== "web") {
    return (
      <SlashMenu open query={query} onSelect={onSelect} onClose={onClose} />
    );
  }
  const rect = blockNode?.getBoundingClientRect();
  const top = rect ? rect.bottom + window.scrollY + 4 : 0;
  const left = rect ? rect.left + window.scrollX : 0;
  return (
    <View
      style={{
        position: "absolute",
        top,
        left,
        zIndex: 50,
      }}
    >
      <SlashMenu open query={query} onSelect={onSelect} onClose={onClose} />
    </View>
  );
}

export type { DropPosition };
