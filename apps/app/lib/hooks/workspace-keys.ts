/**
 * Workspace / member / share-link query keys.
 *
 * Kept in a separate module from `query-keys.ts` so Phase 2 frontend
 * (this set) and Phase 1 frontend (which extends `query-keys.ts` for
 * pages/blocks) don't fight over the same file during parallel
 * development. These keys are namespaced under `'workspace-*'` /
 * `'workspace-members-*'` / `'share-links-*'` to avoid collisions.
 */
export const workspaceKeys = {
  list: ["workspaces"] as const,
  detail: (id: string) => ["workspace", id] as const,
} as const;

export const workspaceMemberKeys = {
  list: (workspaceId: string) =>
    ["workspace-members", workspaceId] as const,
} as const;

export const shareLinkKeys = {
  list: (pageId: string) => ["share-links", pageId] as const,
  public: (token: string) => ["shared-page", token] as const,
} as const;
