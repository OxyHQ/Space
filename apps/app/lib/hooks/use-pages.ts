import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useOxy } from "@oxyhq/services";
import apiClient from "../api/client";
import { API_ROUTES } from "../api/routes";
import { queryKeys } from "./query-keys";
import type {
  Page,
  PageResponse,
  PagesListResponse,
} from "../types/pages";

interface CreatePageInput {
  workspaceId: string;
  parentId?: string | null;
  title?: string;
  icon?: string | null;
}

interface UpdatePageInput {
  id: string;
  title?: string;
  icon?: string | null;
  cover?: string | null;
  parentId?: string | null;
  archived?: boolean;
}

export function usePages(workspaceId: string | null) {
  const { isAuthenticated } = useOxy();

  return useQuery<PagesListResponse>({
    queryKey: queryKeys.pages.list(workspaceId),
    queryFn: async () => {
      const res = await apiClient.get(API_ROUTES.pages.list, {
        params: workspaceId ? { workspaceId } : undefined,
      });
      return res.data;
    },
    staleTime: 1000 * 30,
    enabled: isAuthenticated && Boolean(workspaceId),
  });
}

export function usePage(id: string | undefined) {
  const { isAuthenticated } = useOxy();

  return useQuery<PageResponse>({
    queryKey: id ? queryKeys.pages.detail(id) : ["page", "none"],
    queryFn: async () => {
      if (!id) throw new Error("Page id required");
      const res = await apiClient.get(API_ROUTES.pages.get(id));
      return res.data;
    },
    enabled: isAuthenticated && Boolean(id),
  });
}

export function useCreatePage() {
  const queryClient = useQueryClient();

  return useMutation<Page, Error, CreatePageInput>({
    mutationFn: async (input) => {
      const res = await apiClient.post<PageResponse>(
        API_ROUTES.pages.create,
        input,
      );
      return res.data.page;
    },
    onSuccess: (page) => {
      queryClient.invalidateQueries({
        queryKey: queryKeys.pages.list(page.workspaceId),
      });
    },
  });
}

export function useUpdatePage() {
  const queryClient = useQueryClient();

  return useMutation<Page, Error, UpdatePageInput>({
    mutationFn: async ({ id, ...patch }) => {
      const res = await apiClient.patch<PageResponse>(
        API_ROUTES.pages.update(id),
        patch,
      );
      return res.data.page;
    },
    onMutate: async ({ id, ...patch }) => {
      await queryClient.cancelQueries({ queryKey: queryKeys.pages.detail(id) });
      const previous = queryClient.getQueryData<PageResponse>(
        queryKeys.pages.detail(id),
      );
      if (previous) {
        queryClient.setQueryData<PageResponse>(queryKeys.pages.detail(id), {
          page: { ...previous.page, ...patch } as Page,
        });
      }
      return { previous };
    },
    onError: (_err, { id }, context) => {
      const ctx = context as { previous?: PageResponse } | undefined;
      if (ctx?.previous) {
        queryClient.setQueryData(queryKeys.pages.detail(id), ctx.previous);
      }
    },
    onSettled: (page) => {
      if (!page) return;
      queryClient.invalidateQueries({
        queryKey: queryKeys.pages.list(page.workspaceId),
      });
      queryClient.invalidateQueries({
        queryKey: queryKeys.pages.detail(page._id),
      });
    },
  });
}

interface DeletePageInput {
  id: string;
  workspaceId: string;
}

export function useDeletePage() {
  const queryClient = useQueryClient();

  return useMutation<void, Error, DeletePageInput>({
    mutationFn: async ({ id }) => {
      await apiClient.delete(API_ROUTES.pages.delete(id));
    },
    onSuccess: (_data, { workspaceId }) => {
      queryClient.invalidateQueries({
        queryKey: queryKeys.pages.list(workspaceId),
      });
    },
  });
}

/**
 * Builds a tree from a flat list of pages. Pages with parentId === null are
 * roots. Children are ordered by `updatedAt` descending (most recent first).
 */
export function buildPageTree(pages: Page[]) {
  const byId = new Map<string, { page: Page; children: Page[] }>();
  for (const page of pages) {
    byId.set(page._id, { page, children: [] });
  }
  const roots: Page[] = [];
  for (const page of pages) {
    if (page.parentId && byId.has(page.parentId)) {
      byId.get(page.parentId)?.children.push(page);
    } else {
      roots.push(page);
    }
  }
  for (const node of byId.values()) {
    node.children.sort(
      (a, b) =>
        new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime(),
    );
  }
  roots.sort(
    (a, b) =>
      new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime(),
  );
  return { roots, byId };
}
