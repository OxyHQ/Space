import { create } from 'zustand';
import { createJSONStorage, persist } from 'zustand/middleware';
import AsyncStorage from '@react-native-async-storage/async-storage';

/**
 * Sidebar section keys — persisted collapsed state. New sections added here
 * default to expanded.
 */
export type SidebarSectionKey =
  | 'favorites'
  | 'private'
  | 'shared'
  | 'databases'
  | 'templates';

const MAX_RECENT_PAGES = 20;

interface UIState {
  sidebarOpen: boolean;
  sidebarCollapsed: boolean;
  shortcutsDialogOpen: boolean;
  commandPaletteOpen: boolean;
  sectionCollapsed: Record<SidebarSectionKey, boolean>;
  /**
   * Page ids in most-recently-opened order. Capped at 20. Persisted across
   * sessions so Cmd+K and the optional "Recents" sidebar section can show
   * familiar pages immediately on app start.
   */
  recentPageIds: string[];

  // Actions
  toggleSidebar: () => void;
  setSidebarOpen: (open: boolean) => void;
  toggleSidebarCollapsed: () => void;
  setSidebarCollapsed: (collapsed: boolean) => void;
  setShortcutsDialogOpen: (open: boolean) => void;
  toggleShortcutsDialog: () => void;
  setCommandPaletteOpen: (open: boolean) => void;
  toggleCommandPalette: () => void;
  toggleSection: (key: SidebarSectionKey) => void;
  setSectionCollapsed: (key: SidebarSectionKey, collapsed: boolean) => void;
  addRecentPage: (pageId: string) => void;
  removeRecentPage: (pageId: string) => void;
  clearRecentPages: () => void;
}

const DEFAULT_SECTION_COLLAPSED: Record<SidebarSectionKey, boolean> = {
  favorites: false,
  private: false,
  shared: false,
  databases: false,
  templates: true,
};

export const useUIStore = create<UIState>()(
  persist(
    (set) => ({
      sidebarOpen: false,
      sidebarCollapsed: false,
      shortcutsDialogOpen: false,
      commandPaletteOpen: false,
      sectionCollapsed: DEFAULT_SECTION_COLLAPSED,
      recentPageIds: [],

      toggleSidebar: () =>
        set((state) => ({ sidebarOpen: !state.sidebarOpen })),

      setSidebarOpen: (open) => set({ sidebarOpen: open }),

      toggleSidebarCollapsed: () =>
        set((state) => ({ sidebarCollapsed: !state.sidebarCollapsed })),

      setSidebarCollapsed: (collapsed) => set({ sidebarCollapsed: collapsed }),

      setShortcutsDialogOpen: (open) => set({ shortcutsDialogOpen: open }),

      toggleShortcutsDialog: () =>
        set((state) => ({ shortcutsDialogOpen: !state.shortcutsDialogOpen })),

      setCommandPaletteOpen: (open) => set({ commandPaletteOpen: open }),

      toggleCommandPalette: () =>
        set((state) => ({ commandPaletteOpen: !state.commandPaletteOpen })),

      toggleSection: (key) =>
        set((state) => ({
          sectionCollapsed: {
            ...state.sectionCollapsed,
            [key]: !state.sectionCollapsed[key],
          },
        })),

      setSectionCollapsed: (key, collapsed) =>
        set((state) => ({
          sectionCollapsed: {
            ...state.sectionCollapsed,
            [key]: collapsed,
          },
        })),

      addRecentPage: (pageId) =>
        set((state) => {
          const filtered = state.recentPageIds.filter((id) => id !== pageId);
          return {
            recentPageIds: [pageId, ...filtered].slice(0, MAX_RECENT_PAGES),
          };
        }),

      removeRecentPage: (pageId) =>
        set((state) => ({
          recentPageIds: state.recentPageIds.filter((id) => id !== pageId),
        })),

      clearRecentPages: () => set({ recentPageIds: [] }),
    }),
    {
      name: 'ui-store',
      storage: createJSONStorage(() => AsyncStorage),
      partialize: (state) => ({
        sidebarCollapsed: state.sidebarCollapsed,
        sectionCollapsed: state.sectionCollapsed,
        recentPageIds: state.recentPageIds,
      }),
      version: 2,
      migrate: (persisted, version) => {
        // v1 had only sidebarCollapsed; v2 adds sectionCollapsed + recentPageIds.
        if (version < 2 && persisted && typeof persisted === 'object') {
          const p = persisted as Partial<UIState>;
          return {
            ...p,
            sectionCollapsed: p.sectionCollapsed ?? DEFAULT_SECTION_COLLAPSED,
            recentPageIds: p.recentPageIds ?? [],
          };
        }
        return persisted as UIState;
      },
    },
  ),
);
