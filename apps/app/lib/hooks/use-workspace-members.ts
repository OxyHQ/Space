import {
  useQuery,
  useMutation,
  useQueryClient,
  type UseQueryOptions,
} from "@tanstack/react-query";
import { useOxy } from "@oxyhq/services";
import apiClient from "../api/client";
import { workspaceMemberKeys } from "./workspace-keys";
import type { WorkspaceRole } from "./use-workspaces";

export interface WorkspaceMemberUser {
  id: string;
  username: string | null;
  email: string | null;
  name: {
    first?: string;
    last?: string;
  } | null;
  avatar: string | null;
}

export interface WorkspaceMember {
  _id: string;
  workspaceId: string;
  userId: string;
  role: WorkspaceRole;
  invitedBy: string | null;
  joinedAt: string;
  createdAt: string;
  updatedAt: string;
  /**
   * Hydrated user profile attached by the backend list endpoint via a
   * batch lookup against the Oxy auth service. Optional because the
   * profile fetch can fail; the row should still render with a fallback.
   */
  user?: WorkspaceMemberUser;
}

export interface InviteMemberInput {
  email: string;
  role: WorkspaceRole;
}

export interface UpdateMemberRoleInput {
  memberId: string;
  role: WorkspaceRole;
}

function membersBase(workspaceId: string) {
  return `/workspaces/${workspaceId}/members`;
}

export function useWorkspaceMembers(
  workspaceId: string | null | undefined,
  options?: Partial<UseQueryOptions<WorkspaceMember[]>>,
) {
  const { isAuthenticated } = useOxy();
  const enabled = Boolean(isAuthenticated && workspaceId);

  return useQuery<WorkspaceMember[]>({
    queryKey: workspaceMemberKeys.list(workspaceId ?? ""),
    queryFn: async () => {
      const res = await apiClient.get<{ members: WorkspaceMember[] }>(
        membersBase(workspaceId ?? ""),
      );
      return res.data.members;
    },
    enabled,
    staleTime: 1000 * 30,
    ...options,
  });
}

export function useInviteMember(workspaceId: string) {
  const queryClient = useQueryClient();

  return useMutation<WorkspaceMember, Error, InviteMemberInput>({
    mutationFn: async (input) => {
      const res = await apiClient.post<{ member: WorkspaceMember }>(
        membersBase(workspaceId),
        input,
      );
      return res.data.member;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({
        queryKey: workspaceMemberKeys.list(workspaceId),
      });
    },
  });
}

export function useUpdateMemberRole(workspaceId: string) {
  const queryClient = useQueryClient();

  return useMutation<WorkspaceMember, Error, UpdateMemberRoleInput>({
    mutationFn: async ({ memberId, role }) => {
      const res = await apiClient.patch<{ member: WorkspaceMember }>(
        `${membersBase(workspaceId)}/${memberId}`,
        { role },
      );
      return res.data.member;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({
        queryKey: workspaceMemberKeys.list(workspaceId),
      });
    },
  });
}

export function useRemoveMember(workspaceId: string) {
  const queryClient = useQueryClient();

  return useMutation<void, Error, string>({
    mutationFn: async (memberId) => {
      await apiClient.delete(`${membersBase(workspaceId)}/${memberId}`);
    },
    onSuccess: () => {
      queryClient.invalidateQueries({
        queryKey: workspaceMemberKeys.list(workspaceId),
      });
    },
  });
}
