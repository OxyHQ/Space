import {
  useQuery,
  useMutation,
  useQueryClient,
  type UseQueryOptions,
} from "@tanstack/react-query";
import { useOxy } from "@oxyhq/services";
import apiClient from "../api/client";
import { workspaceKeys } from "./workspace-keys";

export type WorkspaceRole =
  | "viewer"
  | "commenter"
  | "editor"
  | "admin"
  | "owner";

export interface Workspace {
  _id: string;
  name: string;
  icon: string | null;
  ownerId: string;
  isPersonal: boolean;
  archivedAt: string | null;
  createdAt: string;
  updatedAt: string;
  /**
   * Role of the calling user for this workspace. Set by the backend list
   * endpoint by joining against `workspace_members`.
   */
  role?: WorkspaceRole;
}

export interface CreateWorkspaceInput {
  name: string;
  icon?: string | null;
}

export interface UpdateWorkspaceInput {
  name?: string;
  icon?: string | null;
}

const WORKSPACES_BASE = "/workspaces";

/**
 * useWorkspaces — list every workspace the current user is a member of
 * (personal + shared). The response is the source of truth for the
 * sidebar workspace switcher.
 */
export function useWorkspaces(
  options?: Partial<UseQueryOptions<Workspace[]>>,
) {
  const { isAuthenticated } = useOxy();

  return useQuery<Workspace[]>({
    queryKey: workspaceKeys.list,
    queryFn: async () => {
      const res = await apiClient.get<{ workspaces: Workspace[] }>(
        WORKSPACES_BASE,
      );
      return res.data.workspaces;
    },
    enabled: isAuthenticated,
    staleTime: 1000 * 60 * 2,
    retry: 1,
    ...options,
  });
}

export function useWorkspace(workspaceId: string | null | undefined) {
  const { isAuthenticated } = useOxy();
  const enabled = Boolean(isAuthenticated && workspaceId);

  return useQuery<Workspace>({
    queryKey: workspaceKeys.detail(workspaceId ?? ""),
    queryFn: async () => {
      const res = await apiClient.get<{ workspace: Workspace }>(
        `${WORKSPACES_BASE}/${workspaceId}`,
      );
      return res.data.workspace;
    },
    enabled,
    staleTime: 1000 * 60 * 2,
  });
}

export function useCreateWorkspace() {
  const queryClient = useQueryClient();

  return useMutation<Workspace, Error, CreateWorkspaceInput>({
    mutationFn: async (input) => {
      const res = await apiClient.post<{ workspace: Workspace }>(
        WORKSPACES_BASE,
        input,
      );
      return res.data.workspace;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: workspaceKeys.list });
    },
  });
}

export function useUpdateWorkspace(workspaceId: string) {
  const queryClient = useQueryClient();

  return useMutation<Workspace, Error, UpdateWorkspaceInput>({
    mutationFn: async (input) => {
      const res = await apiClient.patch<{ workspace: Workspace }>(
        `${WORKSPACES_BASE}/${workspaceId}`,
        input,
      );
      return res.data.workspace;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: workspaceKeys.list });
      queryClient.invalidateQueries({
        queryKey: workspaceKeys.detail(workspaceId),
      });
    },
  });
}

export function useDeleteWorkspace() {
  const queryClient = useQueryClient();

  return useMutation<void, Error, string>({
    mutationFn: async (workspaceId) => {
      await apiClient.delete(`${WORKSPACES_BASE}/${workspaceId}`);
    },
    onSuccess: (_data, workspaceId) => {
      queryClient.invalidateQueries({ queryKey: workspaceKeys.list });
      queryClient.removeQueries({
        queryKey: workspaceKeys.detail(workspaceId),
      });
    },
  });
}
