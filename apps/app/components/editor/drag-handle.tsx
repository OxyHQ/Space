import * as React from "react";
import { Platform, Pressable, View } from "react-native";
import { GripVertical, Plus } from "lucide-react-native";
import { useColorScheme } from "@/lib/useColorScheme";

interface DragHandleProps {
  /** Show the handle (web — only when block is hovered or menu open). */
  visible: boolean;
  /** Open the block action menu at this anchor. */
  onOpenMenu: (anchor: { top: number; left: number }) => void;
  /** Insert a new block below — secondary action on the plus button. */
  onPlus: () => void;
  /** Drag start — `useEditorDnd` wires this through. */
  onDragStart?: (event: React.PointerEvent<HTMLDivElement>) => void;
  /** Block id — exposed for the parent to wire dnd events. */
  blockId: string;
}

/**
 * Notion-style left-gutter handle. Web-only by intent — native enters
 * "move mode" via long-press on the block itself (handled in the editor).
 */
export function DragHandle({
  visible,
  onOpenMenu,
  onPlus,
  onDragStart,
  blockId,
}: DragHandleProps) {
  if (Platform.OS !== "web") return null;
  return (
    <DragHandleWeb
      visible={visible}
      onOpenMenu={onOpenMenu}
      onPlus={onPlus}
      onDragStart={onDragStart}
      blockId={blockId}
    />
  );
}

function DragHandleWeb({
  visible,
  onOpenMenu,
  onPlus,
  onDragStart,
  blockId,
}: DragHandleProps) {
  const { colors } = useColorScheme();
  const gripRef = React.useRef<View | null>(null);

  const handleGripPress = (event: React.MouseEvent<HTMLDivElement>) => {
    event.preventDefault();
    const target = event.currentTarget as HTMLDivElement;
    const rect = target.getBoundingClientRect();
    onOpenMenu({ top: rect.bottom + 4, left: rect.left });
  };

  return (
    <View
      style={{
        position: "absolute",
        right: "100%",
        top: 2,
        marginRight: 4,
        opacity: visible ? 1 : 0,
        flexDirection: "row",
        alignItems: "center",
        gap: 2,
      }}
      pointerEvents={visible ? "auto" : "none"}
      data-block-handle={blockId}
    >
      <Pressable
        onPress={onPlus}
        accessibilityLabel="Add block below"
        className="h-6 w-6 items-center justify-center rounded-md hover:bg-muted"
      >
        <Plus size={14} color={colors.mutedForeground} />
      </Pressable>
      <div
        ref={gripRef as unknown as React.RefObject<HTMLDivElement>}
        draggable
        onClick={handleGripPress}
        onPointerDown={onDragStart}
        title="Click for menu, drag to move"
        style={{
          cursor: "grab",
          padding: "4px 2px",
          borderRadius: 4,
          display: "inline-flex",
          alignItems: "center",
          justifyContent: "center",
        }}
      >
        <GripVertical size={14} color={colors.mutedForeground} />
      </div>
    </View>
  );
}
