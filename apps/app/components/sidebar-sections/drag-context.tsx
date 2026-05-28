import * as React from 'react';

export type DropPosition = 'before' | 'after' | 'inside';

export interface DragMutation {
  /** Move sourceId into the parent of targetId at position before/after, or as a child of targetId when inside. */
  sourceId: string;
  targetId: string;
  position: DropPosition;
}

interface DragContextValue {
  draggingId: string | null;
  setDraggingId: (id: string | null) => void;
  onCommit: ((mutation: DragMutation) => void) | null;
}

const DragContext = React.createContext<DragContextValue>({
  draggingId: null,
  setDraggingId: () => undefined,
  onCommit: null,
});

interface DragProviderProps {
  onCommit: (mutation: DragMutation) => void;
  children: React.ReactNode;
}

/**
 * Shared drag state for the sidebar page rows. The provider keeps the dragging
 * id so siblings can render drop indicators, and exposes a single onCommit
 * callback that the row resolves to a PATCH against the backend.
 */
export function PageDragProvider({ onCommit, children }: DragProviderProps) {
  const [draggingId, setDraggingId] = React.useState<string | null>(null);
  const value = React.useMemo<DragContextValue>(
    () => ({ draggingId, setDraggingId, onCommit }),
    [draggingId, onCommit],
  );
  return <DragContext.Provider value={value}>{children}</DragContext.Provider>;
}

export function usePageDrag() {
  return React.useContext(DragContext);
}
