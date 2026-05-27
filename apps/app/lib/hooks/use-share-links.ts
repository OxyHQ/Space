import {
  useQuery,
  useMutation,
  useQueryClient,
  type UseQueryOptions,
} from "@tanstack/react-query";
import { useOxy } from "@oxyhq/services";
import axios from "axios";
import apiClient from "../api/client";
import config from "../config";
import { shareLinkKeys } from "./workspace-keys";

export type ShareLinkScope = "read" | "comment" | "edit";

export const SHARE_LINK_SCOPES: ShareLinkScope[] = ["read", "comment", "edit"];

export interface ShareLink {
  _id: string;
  pageId: string;
  token: string;
  scope: ShareLinkScope;
  createdBy: string;
  expiresAt: string | null;
  revokedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface CreateShareLinkInput {
  scope: ShareLinkScope;
  expiresAt?: string | null;
}

export interface SharedBlock {
  _id: string;
  pageId: string;
  parentBlockId: string | null;
  type: string;
  content: Record<string, unknown>;
  order: number;
}

export interface SharedPage {
  page: {
    _id: string;
    title: string;
    icon: string | null;
    cover: string | null;
    updatedAt: string;
  };
  blocks: SharedBlock[];
  share: {
    scope: ShareLinkScope;
    expiresAt: string | null;
  };
}

function shareLinksBase(pageId: string) {
  return `/pages/${pageId}/share-links`;
}

export function useShareLinks(
  pageId: string | null | undefined,
  options?: Partial<UseQueryOptions<ShareLink[]>>,
) {
  const { isAuthenticated } = useOxy();
  const enabled = Boolean(isAuthenticated && pageId);

  return useQuery<ShareLink[]>({
    queryKey: shareLinkKeys.list(pageId ?? ""),
    queryFn: async () => {
      const res = await apiClient.get<{ links: ShareLink[] }>(
        shareLinksBase(pageId ?? ""),
      );
      return res.data.links;
    },
    enabled,
    staleTime: 1000 * 30,
    ...options,
  });
}

export function useCreateShareLink(pageId: string) {
  const queryClient = useQueryClient();

  return useMutation<ShareLink, Error, CreateShareLinkInput>({
    mutationFn: async (input) => {
      const res = await apiClient.post<{ link: ShareLink }>(
        shareLinksBase(pageId),
        input,
      );
      return res.data.link;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({
        queryKey: shareLinkKeys.list(pageId),
      });
    },
  });
}

export function useRevokeShareLink(pageId: string) {
  const queryClient = useQueryClient();

  return useMutation<void, Error, string>({
    mutationFn: async (linkId) => {
      await apiClient.delete(`${shareLinksBase(pageId)}/${linkId}`);
    },
    onSuccess: () => {
      queryClient.invalidateQueries({
        queryKey: shareLinkKeys.list(pageId),
      });
    },
  });
}

/**
 * useSharedPage — public, unauthenticated read of a shared page by
 * token. Uses a bare axios client (no Bearer header) so the call goes
 * through even when the visitor isn't logged in.
 */
export function useSharedPage(token: string | null | undefined) {
  return useQuery<SharedPage>({
    queryKey: shareLinkKeys.public(token ?? ""),
    queryFn: async () => {
      const res = await axios.get<SharedPage>(
        `${config.apiUrl}/share/${token}`,
        { timeout: 15000 },
      );
      return res.data;
    },
    enabled: Boolean(token),
    staleTime: 1000 * 60,
    retry: false,
  });
}
