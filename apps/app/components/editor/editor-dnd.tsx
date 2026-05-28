/**
 * Editor drag-and-drop coordination (web).
 *
 * The state machine is intentionally tiny:
 *   1. PointerDown on a drag handle → record blockId + start coords.
 *   2. PointerMove ≥ 4px → enter "dragging" mode; show a fixed-position
 *      preview pill following the cursor.
 *   3. PointerMove over another block → emit `onIndicator` with the target
 *      block id + position ('above' | 'below').
 *   4. PointerUp → invoke `onDrop` if an indicator is active; clean up.
 *
 * The hook only owns the pointer plumbing — block-list reordering happens
 * in the editor (it has direct access to the block list and reorder mutation).
 */
import * as React from "react";

export type DropPosition = "above" | "below";

export interface DropIndicator {
  blockId: string;
  position: DropPosition;
}

export interface EditorDndApi {
  onHandlePointerDown: (
    blockId: string,
    event: React.PointerEvent<HTMLElement>,
  ) => void;
  draggingBlockId: string | null;
  indicator: DropIndicator | null;
  /** Provide a render callback for the drag preview (web-only). */
  renderPreview(): React.ReactNode;
}

interface UseEditorDndOptions {
  onDrop: (sourceId: string, indicator: DropIndicator) => void;
  /**
   * Look up the block id of a DOM node — typically the editor walks up
   * from the event target to find the closest `[data-block-id]` ancestor.
   */
  blockIdForNode: (node: Element | null) => string | null;
  /**
   * Look up the bounding rect of a block's row. Lets the hook decide
   * "above" vs "below" without each consumer reaching into the DOM.
   */
  rectForBlock: (blockId: string) => DOMRect | null;
  /** Optional label rendered in the drag preview pill. */
  previewLabel?: (blockId: string) => string;
}

export function useEditorDnd(options: UseEditorDndOptions): EditorDndApi {
  const { onDrop, blockIdForNode, rectForBlock, previewLabel } = options;
  const [draggingBlockId, setDragging] = React.useState<string | null>(null);
  const [indicator, setIndicator] = React.useState<DropIndicator | null>(null);
  const [pos, setPos] = React.useState<{ x: number; y: number } | null>(null);
  const startedRef = React.useRef<{ blockId: string; x: number; y: number } | null>(
    null,
  );

  const cleanup = React.useCallback(() => {
    startedRef.current = null;
    setDragging(null);
    setIndicator(null);
    setPos(null);
    if (typeof document !== "undefined") {
      document.body.style.userSelect = "";
    }
  }, []);

  React.useEffect(() => {
    if (typeof window === "undefined") return undefined;
    if (!draggingBlockId && !startedRef.current) return undefined;

    const onMove = (ev: PointerEvent) => {
      const started = startedRef.current;
      if (!started) return;
      const dx = ev.clientX - started.x;
      const dy = ev.clientY - started.y;
      if (!draggingBlockId && Math.hypot(dx, dy) < 4) return;
      if (!draggingBlockId) {
        setDragging(started.blockId);
        document.body.style.userSelect = "none";
      }
      setPos({ x: ev.clientX, y: ev.clientY });

      const targetEl = document.elementFromPoint(ev.clientX, ev.clientY);
      const targetBlockId = blockIdForNode(targetEl);
      if (!targetBlockId || targetBlockId === started.blockId) {
        setIndicator(null);
        return;
      }
      const rect = rectForBlock(targetBlockId);
      if (!rect) {
        setIndicator(null);
        return;
      }
      const middle = rect.top + rect.height / 2;
      const position: DropPosition = ev.clientY < middle ? "above" : "below";
      setIndicator((prev) =>
        prev && prev.blockId === targetBlockId && prev.position === position
          ? prev
          : { blockId: targetBlockId, position },
      );
    };

    const onUp = () => {
      const started = startedRef.current;
      const ind = indicator;
      if (started && ind) {
        onDrop(started.blockId, ind);
      }
      cleanup();
    };

    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
    return () => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
    };
  }, [
    blockIdForNode,
    cleanup,
    draggingBlockId,
    indicator,
    onDrop,
    rectForBlock,
  ]);

  const onHandlePointerDown = React.useCallback(
    (blockId: string, event: React.PointerEvent<HTMLElement>) => {
      if (event.button !== 0) return;
      // Don't initiate drag if user is clicking — they may want the menu.
      startedRef.current = {
        blockId,
        x: event.clientX,
        y: event.clientY,
      };
    },
    [],
  );

  const renderPreview = React.useCallback((): React.ReactNode => {
    if (!draggingBlockId || !pos) return null;
    const label = previewLabel?.(draggingBlockId) ?? "Block";
    return (
      <div
        style={{
          position: "fixed",
          left: pos.x + 12,
          top: pos.y + 12,
          zIndex: 80,
          background: "rgba(0,0,0,0.75)",
          color: "white",
          padding: "4px 10px",
          borderRadius: 6,
          fontSize: 12,
          pointerEvents: "none",
        }}
      >
        {label}
      </div>
    );
  }, [draggingBlockId, pos, previewLabel]);

  return {
    onHandlePointerDown,
    draggingBlockId,
    indicator,
    renderPreview,
  };
}
