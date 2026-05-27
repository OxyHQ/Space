import type { WorkspaceRole } from "./use-workspaces";

/**
 * Role hierarchy mirrors `apps/api/src/models/workspace-member.ts`.
 * Frontend uses it to gate UI affordances; the backend enforces
 * authorisation independently.
 */
export const WORKSPACE_ROLES: WorkspaceRole[] = [
  "viewer",
  "commenter",
  "editor",
  "admin",
  "owner",
];

export function compareRoles(a: WorkspaceRole, b: WorkspaceRole): number {
  return WORKSPACE_ROLES.indexOf(a) - WORKSPACE_ROLES.indexOf(b);
}

export function hasRole(
  actual: WorkspaceRole | undefined,
  required: WorkspaceRole,
): boolean {
  if (!actual) return false;
  return compareRoles(actual, required) >= 0;
}

export const ROLE_LABELS: Record<WorkspaceRole, string> = {
  owner: "Owner",
  admin: "Admin",
  editor: "Editor",
  commenter: "Commenter",
  viewer: "Viewer",
};

export const ROLE_DESCRIPTIONS: Record<WorkspaceRole, string> = {
  owner: "Full access. Can delete workspace and transfer ownership.",
  admin: "Full access. Can invite and manage members.",
  editor: "Can create and edit pages.",
  commenter: "Can comment but not edit.",
  viewer: "Read-only access.",
};
