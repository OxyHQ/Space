import * as React from 'react';
import { useUIStore } from '@/lib/stores/ui-store';

/**
 * Records the visited page id in the recent-pages list.
 *
 * Why a hook (vs calling addRecentPage directly): consumers usually only have
 * a `string | undefined` from a router param. This guards against logging
 * "undefined" and only fires when the id changes — avoiding redundant work on
 * every render of `[pageId].tsx`.
 */
export function useTrackRecentPage(pageId: string | undefined) {
  const addRecentPage = useUIStore((s) => s.addRecentPage);

  React.useEffect(() => {
    if (!pageId) return;
    addRecentPage(pageId);
  }, [pageId, addRecentPage]);
}
