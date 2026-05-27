import * as React from "react";
import { ActivityIndicator, Pressable, TextInput, View } from "react-native";
import { Plus } from "lucide-react-native";
import { Text } from "@/components/ui/text";
import { useColorScheme } from "@/lib/useColorScheme";
import {
  useBlocks,
  useCreateBlock,
  useDeleteBlock,
  useUpdateBlock,
} from "@/lib/hooks/use-blocks";
import type { Block, BlockType } from "@/lib/types/pages";
import { BlockView } from "./block";
import { SlashMenu, SLASH_MENU_OPTIONS } from "./slash-menu";

interface EditorProps {
  pageId: string;
}

const ORDER_STEP = 1000;

interface DraftMeta {
  /** True while the slash menu is showing for this block. */
  slashOpen: boolean;
  /** Index in the text where the trigger `/` lives. */
  slashIndex: number;
  query: string;
}

/**
 * Block editor. Owns:
 *   - block list ordering
 *   - per-block debounced content saves
 *   - slash menu state
 *   - keyboard-driven block creation/deletion (web)
 *   - "+ Add block" button (native + web)
 */
export function Editor({ pageId }: EditorProps) {
  const { colors } = useColorScheme();
  const { data, isLoading } = useBlocks(pageId);
  const createBlock = useCreateBlock();
  const updateBlock = useUpdateBlock();
  const deleteBlock = useDeleteBlock();

  const blocks = React.useMemo(() => {
    const list = data?.blocks ?? [];
    return [...list].sort((a, b) => a.order - b.order);
  }, [data?.blocks]);

  // Per-block local content buffers — TanStack Query is source of truth, but
  // typing must be instant so we mirror text locally and debounce writes.
  const [drafts, setDrafts] = React.useState<Record<string, string>>({});
  const [slashState, setSlashState] = React.useState<
    Record<string, DraftMeta>
  >({});
  const [focusRequest, setFocusRequest] = React.useState<string | null>(null);
  const inputRefs = React.useRef<
    Record<string, React.RefObject<TextInput | null>>
  >({});
  const saveTimersRef = React.useRef<Record<string, ReturnType<typeof setTimeout>>>(
    {},
  );

  const getRef = React.useCallback(
    (id: string): React.RefObject<TextInput | null> => {
      if (!inputRefs.current[id]) {
        inputRefs.current[id] = React.createRef<TextInput>();
      }
      return inputRefs.current[id];
    },
    [],
  );

  // Focus a freshly-created block after it shows up in the rendered list.
  React.useEffect(() => {
    if (!focusRequest) return;
    const target = blocks.find((b) => b._id === focusRequest);
    if (!target) return;
    const ref = inputRefs.current[focusRequest];
    if (ref?.current) {
      ref.current.focus();
      setFocusRequest(null);
    }
  }, [blocks, focusRequest]);

  const scheduleSave = React.useCallback(
    (block: Block, nextText: string) => {
      const existing = saveTimersRef.current[block._id];
      if (existing) clearTimeout(existing);
      saveTimersRef.current[block._id] = setTimeout(() => {
        updateBlock.mutate({
          id: block._id,
          pageId,
          content: { ...block.content, text: nextText },
        });
      }, 300);
    },
    [pageId, updateBlock],
  );

  const handleChangeText = React.useCallback(
    (block: Block, text: string) => {
      setDrafts((prev) => ({ ...prev, [block._id]: text }));
      scheduleSave(block, text);
    },
    [scheduleSave],
  );

  const handleChangeMeta = React.useCallback(
    (block: Block, meta: { value: string; selection: number }) => {
      // Detect "/" — open menu if the char immediately before the caret is "/".
      const idx = meta.selection - 1;
      const char = meta.value[idx];
      const prev = slashState[block._id];

      if (prev?.slashOpen) {
        // Continue if the original "/" is still there.
        const stillSlash = meta.value[prev.slashIndex] === "/";
        if (!stillSlash || meta.selection <= prev.slashIndex) {
          setSlashState((s) => {
            const next = { ...s };
            delete next[block._id];
            return next;
          });
          return;
        }
        const query = meta.value.slice(prev.slashIndex + 1, meta.selection);
        // Close if a space sneaks in — Notion-like.
        if (query.includes(" ")) {
          setSlashState((s) => {
            const next = { ...s };
            delete next[block._id];
            return next;
          });
          return;
        }
        setSlashState((s) => ({
          ...s,
          [block._id]: { slashOpen: true, slashIndex: prev.slashIndex, query },
        }));
        return;
      }

      if (char === "/") {
        // Trigger at start or after whitespace only — avoids triggering mid-URL.
        const prevChar = idx > 0 ? meta.value[idx - 1] : "";
        if (idx === 0 || prevChar === " " || prevChar === "\n") {
          setSlashState((s) => ({
            ...s,
            [block._id]: { slashOpen: true, slashIndex: idx, query: "" },
          }));
        }
      }
    },
    [slashState],
  );

  const closeSlash = React.useCallback((blockId: string) => {
    setSlashState((s) => {
      const next = { ...s };
      delete next[blockId];
      return next;
    });
  }, []);

  const handleSlashSelect = React.useCallback(
    async (block: Block, nextType: BlockType) => {
      const meta = slashState[block._id];
      if (!meta) return;
      const buffer = drafts[block._id] ?? block.content.text ?? "";
      const stripped =
        buffer.slice(0, meta.slashIndex) +
        buffer.slice(meta.slashIndex + 1 + meta.query.length);
      setDrafts((prev) => ({ ...prev, [block._id]: stripped }));
      closeSlash(block._id);
      try {
        await updateBlock.mutateAsync({
          id: block._id,
          pageId,
          type: nextType,
          content: { ...block.content, text: stripped },
        });
        // Re-focus the input so typing can continue uninterrupted.
        const ref = inputRefs.current[block._id];
        ref?.current?.focus();
      } catch {
        // mutation error surfaces via state; nothing to do here.
      }
    },
    [closeSlash, drafts, pageId, slashState, updateBlock],
  );

  const orderForNew = React.useCallback(
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

  const handleSubmit = React.useCallback(
    async (block: Block) => {
      const idx = blocks.findIndex((b) => b._id === block._id);
      const nextOrder = orderForNew(idx);
      try {
        const created = await createBlock.mutateAsync({
          pageId,
          type: "paragraph",
          content: { text: "" },
          order: nextOrder,
        });
        setFocusRequest(created._id);
      } catch {
        // mutation surfaces error via state; no further action.
      }
    },
    [blocks, createBlock, orderForNew, pageId],
  );

  const handleBackspaceAtStart = React.useCallback(
    async (block: Block) => {
      const idx = blocks.findIndex((b) => b._id === block._id);
      const previous = idx > 0 ? blocks[idx - 1] : null;
      const currentText = drafts[block._id] ?? block.content.text ?? "";

      if (currentText.length === 0 && blocks.length > 1) {
        try {
          await deleteBlock.mutateAsync({ id: block._id, pageId });
          if (previous) setFocusRequest(previous._id);
        } catch {
          // mutation surfaces via state.
        }
      } else if (previous) {
        const prevRef = inputRefs.current[previous._id];
        prevRef?.current?.focus();
      }
    },
    [blocks, deleteBlock, drafts, pageId],
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
          // mutation surfaces via state.
        }
        return;
      }
      // Indent: only valid if there's a sibling above (potential new parent).
      const above = blocks[idx - 1];
      if (!above) return;
      try {
        await updateBlock.mutateAsync({
          id: block._id,
          pageId,
          parentBlockId: above._id,
        });
      } catch {
        // mutation surfaces via state.
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

  const handleAddBlockButton = React.useCallback(async () => {
    const last = blocks[blocks.length - 1];
    const nextOrder = last ? last.order + ORDER_STEP : ORDER_STEP;
    try {
      const created = await createBlock.mutateAsync({
        pageId,
        type: "paragraph",
        content: { text: "" },
        order: nextOrder,
      });
      setFocusRequest(created._id);
    } catch {
      // mutation surfaces via state.
    }
  }, [blocks, createBlock, pageId]);

  // Numbered-list indexing — count only consecutive numbered_list_item peers
  // with the same parent.
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

  if (isLoading) {
    return (
      <View className="px-1 py-6">
        <ActivityIndicator color={colors.mutedForeground} />
      </View>
    );
  }

  return (
    <View className="gap-1">
      {blocks.map((block) => {
        const draft = drafts[block._id];
        const value = draft ?? block.content.text ?? "";
        const slash = slashState[block._id];
        return (
          <View key={block._id}>
            <BlockView
              block={
                draft !== undefined
                  ? ({ ...block, content: { ...block.content, text: value } } as Block)
                  : block
              }
              autoFocus={false}
              inputRef={getRef(block._id)}
              handlers={{
                onChangeText: (text) => handleChangeText(block, text),
                onSubmitEditing: () => handleSubmit(block),
                onBackspaceAtStart: () => handleBackspaceAtStart(block),
                onIndent: (outdent) => handleIndent(block, outdent),
                onChangeMeta: (meta) => handleChangeMeta(block, meta),
                onToggleChecked: () => handleToggleChecked(block),
                listIndex: numberedIndex[block._id],
              }}
            />
            {slash?.slashOpen ? (
              <View className="relative">
                <SlashMenu
                  open
                  query={slash.query}
                  onSelect={(t) => handleSlashSelect(block, t)}
                  onClose={() => closeSlash(block._id)}
                />
              </View>
            ) : null}
          </View>
        );
      })}

      {/* Add block button */}
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

      {/* Hint about block types — keeps discoverability without a hover toolbar yet. */}
      {blocks.length === 0 ? (
        <View className="mt-4">
          <Text className="text-sm text-muted-foreground">
            Press “Add block” to start. Inside a block, type{" "}
            <Text className="text-sm text-foreground">/</Text>
            {" "}to insert one of {SLASH_MENU_OPTIONS.length} block types.
          </Text>
        </View>
      ) : null}
    </View>
  );
}
