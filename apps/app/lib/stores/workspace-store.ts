import { create } from "zustand";
import AsyncStorage from "@react-native-async-storage/async-storage";
import { createJSONStorage, persist } from "zustand/middleware";

/**
 * Workspace store — owns the currently active workspace id.
 *
 * Phase 1 frontend writes the placeholder shape. Phase 2 frontend extends
 * with workspace list, switcher state, member list, etc. New fields must
 * not break this contract — `currentWorkspaceId` and `setCurrentWorkspaceId`
 * are consumed by Phase 1 (page tree, page detail, blocks editor).
 */
interface WorkspaceState {
  currentWorkspaceId: string | null;
  setCurrentWorkspaceId: (id: string | null) => void;
}

export const useWorkspaceStore = create<WorkspaceState>()(
  persist(
    (set) => ({
      currentWorkspaceId: null,
      setCurrentWorkspaceId: (id) => set({ currentWorkspaceId: id }),
    }),
    {
      name: "workspace-store",
      storage: createJSONStorage(() => AsyncStorage),
      partialize: (state) => ({
        currentWorkspaceId: state.currentWorkspaceId,
      }),
    },
  ),
);
