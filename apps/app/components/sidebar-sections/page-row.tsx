import * as React from 'react';
import {
  SharedPageRow,
  type PageRowSharedProps,
} from './shared-page-row';

/**
 * Native sidebar page row. No drag-and-drop on native (would need
 * `react-native-draggable-flatlist` which is not installed); the row renders
 * the cross-platform `SharedPageRow` with no drag wiring.
 *
 * Web build resolves `page-row.web.tsx` instead.
 */
export function SidebarPageRow(props: PageRowSharedProps) {
  return <SharedPageRow {...props} platformDrag={null} />;
}

export type { PageRowSharedProps };
