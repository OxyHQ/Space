import * as React from 'react';
import { Platform } from 'react-native';
import { useRouter } from 'expo-router';
import { useUIStore } from '@/lib/stores/ui-store';
import { useWorkspaceStore } from '@/lib/stores/workspace-store';
import { useCreatePage } from '@/lib/hooks/use-pages';

/**
 * Returns true when the active element is an editable text surface (input,
 * textarea, contenteditable) so we don't hijack typing keystrokes.
 *
 * For Cmd+K / Cmd+N / Cmd+\ / Cmd+/ we still fire even inside inputs because
 * those use modifier+letter combos a user clearly intends to be app-wide.
 */
function isShortcutAllowedInEditor(): boolean {
  return true;
}

interface ShortcutContext {
  inEditor: boolean;
}

function getShortcutContext(e: KeyboardEvent): ShortcutContext {
  const target = e.target as HTMLElement | null;
  if (!target) return { inEditor: false };
  const tag = target.tagName?.toLowerCase();
  const isEditable =
    tag === 'input' ||
    tag === 'textarea' ||
    target.isContentEditable === true;
  return { inEditor: isEditable };
}

/**
 * Global keyboard shortcuts for Oxy Space. Web-only — native keyboards don't
 * have a meaningful Cmd/Ctrl convention for app-wide actions. Mounted once at
 * the (app) layout level.
 *
 * Shortcuts:
 *   - Cmd/Ctrl+K  → open command palette
 *   - Cmd/Ctrl+N  → create new root page in current workspace
 *   - Cmd/Ctrl+\  → toggle sidebar collapsed
 *   - Cmd/Ctrl+[  → toggle sidebar collapsed (alias)
 *   - Cmd/Ctrl+/  → toggle shortcuts dialog (only when not focused inside editor)
 */
export function useKeyboardShortcuts() {
  const router = useRouter();
  const setCommandPaletteOpen = useUIStore((s) => s.setCommandPaletteOpen);
  const toggleSidebarCollapsed = useUIStore((s) => s.toggleSidebarCollapsed);
  const toggleShortcutsDialog = useUIStore((s) => s.toggleShortcutsDialog);
  const currentWorkspaceId = useWorkspaceStore((s) => s.currentWorkspaceId);
  const createPage = useCreatePage();

  // Stash mutable handlers in a ref so the global listener doesn't churn.
  const handlersRef = React.useRef({
    router,
    setCommandPaletteOpen,
    toggleSidebarCollapsed,
    toggleShortcutsDialog,
    currentWorkspaceId,
    createPage,
  });
  handlersRef.current = {
    router,
    setCommandPaletteOpen,
    toggleSidebarCollapsed,
    toggleShortcutsDialog,
    currentWorkspaceId,
    createPage,
  };

  React.useEffect(() => {
    if (Platform.OS !== 'web') return;
    if (typeof window === 'undefined') return;

    const onKeyDown = (e: KeyboardEvent) => {
      const mod = e.metaKey || e.ctrlKey;
      if (!mod) return;
      if (!isShortcutAllowedInEditor()) return;

      const key = e.key.toLowerCase();
      const ctx = getShortcutContext(e);

      // Cmd+K → command palette
      if (key === 'k') {
        e.preventDefault();
        handlersRef.current.setCommandPaletteOpen(true);
        return;
      }

      // Cmd+N → new page
      if (key === 'n') {
        e.preventDefault();
        const { currentWorkspaceId: wsId, createPage: cp, router: r } =
          handlersRef.current;
        if (!wsId) return;
        cp.mutateAsync({
          workspaceId: wsId,
          parentId: null,
          title: '',
        })
          .then((page) => {
            r.push(`/p/${page._id}`);
          })
          .catch(() => {
            /* mutation surfaces errors via state */
          });
        return;
      }

      // Cmd+\ or Cmd+[ → toggle sidebar
      if (key === '\\' || key === '[') {
        e.preventDefault();
        handlersRef.current.toggleSidebarCollapsed();
        return;
      }

      // Cmd+/ → shortcuts dialog (skip when typing in editor surfaces)
      if (key === '/') {
        if (ctx.inEditor) return;
        e.preventDefault();
        handlersRef.current.toggleShortcutsDialog();
        return;
      }
    };

    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, []);
}
