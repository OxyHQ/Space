import * as React from 'react';
import {
  SharedPageRow,
  type PageRowSharedProps,
} from './shared-page-row';
import { usePageDrag, type DropPosition } from './drag-context';

export type { PageRowSharedProps };

const DRAG_MIME = 'application/x-oxy-page-id';

/**
 * Web sidebar page row with HTML5 drag-and-drop. Wraps the cross-platform
 * `SharedPageRow` and resolves the row's underlying DOM node via a stable
 * `nativeID` (which Expo renders as `id` on web). We avoid passing a ref
 * across the View/HTMLElement type boundary that way.
 *
 * Drop zones in a row:
 *  - top quarter → "before" (sibling above target)
 *  - middle half → "inside" (becomes a child of target)
 *  - bottom quarter → "after" (sibling below target)
 */
export function SidebarPageRow(props: PageRowSharedProps) {
  const { page, enableDrag = true } = props;
  const drag = usePageDrag();
  const [dropIndicator, setDropIndicator] = React.useState<DropPosition | null>(
    null,
  );
  const isDragging = drag.draggingId === page._id;
  const domId = React.useMemo(
    () => `sidebar-page-row-${page._id}`,
    [page._id],
  );

  const computePosition = React.useCallback(
    (node: HTMLElement, clientY: number): DropPosition => {
      const rect = node.getBoundingClientRect();
      const offset = clientY - rect.top;
      const ratio = offset / rect.height;
      if (ratio < 0.25) return 'before';
      if (ratio > 0.75) return 'after';
      return 'inside';
    },
    [],
  );

  React.useEffect(() => {
    if (!enableDrag) return;
    const node =
      typeof document !== 'undefined' ? document.getElementById(domId) : null;
    if (!node) return;

    node.setAttribute('draggable', 'true');

    const onDragStart = (e: DragEvent) => {
      if (!e.dataTransfer) return;
      e.dataTransfer.effectAllowed = 'move';
      e.dataTransfer.setData(DRAG_MIME, page._id);
      // Fallback so other browsers can read the id.
      e.dataTransfer.setData('text/plain', page._id);
      drag.setDraggingId(page._id);
    };

    const onDragEnd = () => {
      drag.setDraggingId(null);
      setDropIndicator(null);
    };

    const onDragOver = (e: DragEvent) => {
      const types = e.dataTransfer?.types;
      if (
        !types ||
        (!types.includes(DRAG_MIME) && !types.includes('text/plain'))
      ) {
        return;
      }
      e.preventDefault();
      if (e.dataTransfer) e.dataTransfer.dropEffect = 'move';
      if (!drag.draggingId || drag.draggingId === page._id) {
        setDropIndicator(null);
        return;
      }
      setDropIndicator(computePosition(node, e.clientY));
    };

    const onDragLeave = () => setDropIndicator(null);

    const onDrop = (e: DragEvent) => {
      e.preventDefault();
      const sourceId =
        e.dataTransfer?.getData(DRAG_MIME) ||
        e.dataTransfer?.getData('text/plain') ||
        '';
      const position = computePosition(node, e.clientY);
      setDropIndicator(null);
      drag.setDraggingId(null);
      if (!sourceId || sourceId === page._id) return;
      props.onDrop?.(sourceId, position);
    };

    node.addEventListener('dragstart', onDragStart);
    node.addEventListener('dragend', onDragEnd);
    node.addEventListener('dragover', onDragOver);
    node.addEventListener('dragleave', onDragLeave);
    node.addEventListener('drop', onDrop);

    return () => {
      node.removeAttribute('draggable');
      node.removeEventListener('dragstart', onDragStart);
      node.removeEventListener('dragend', onDragEnd);
      node.removeEventListener('dragover', onDragOver);
      node.removeEventListener('dragleave', onDragLeave);
      node.removeEventListener('drop', onDrop);
    };
  }, [computePosition, domId, drag, enableDrag, page._id, props]);

  return (
    <SharedPageRow
      {...props}
      platformDrag={{
        draggable: enableDrag,
        isDragging,
        dropIndicator,
        domId,
      }}
    />
  );
}
