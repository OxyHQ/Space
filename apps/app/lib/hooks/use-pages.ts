import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useOxy } from "@oxyhq/services";
import apiClient from "../api/client";
import { API_ROUTES } from "../api/routes";
import { queryKeys } from "./query-keys";
import type {
  BreadcrumbResponse,
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
  coverPosition?: number;
  parentId?: string | null;
  archived?: boolean;
  /**
   * Owned by the Page chrome agent (#14). Forwarded as-is to the API; if the
   * backend hasn't shipped the column yet, the update is a safe no-op.
   */
  favorited?: boolean;
  /** Sibling order; consumed by drag-to-reorder. */
  order?: number;
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
  /** When true, permanently delete from PostgreSQL (owner only). */
  hard?: boolean;
}

export function useDeletePage() {
  const queryClient = useQueryClient();

  return useMutation<void, Error, DeletePageInput>({
    mutationFn: async ({ id, hard }) => {
      await apiClient.delete(API_ROUTES.pages.delete(id), {
        params: hard ? { hard: "true" } : undefined,
      });
    },
    onSuccess: (_data, { workspaceId, id }) => {
      queryClient.invalidateQueries({
        queryKey: queryKeys.pages.list(workspaceId),
      });
      queryClient.invalidateQueries({
        queryKey: queryKeys.pages.archived(workspaceId),
      });
      queryClient.removeQueries({ queryKey: queryKeys.pages.detail(id) });
    },
  });
}

/**
 * Server-side duplicate (POST /pages/:id/duplicate). The backend copies the
 * page and its blocks and returns the new page.
 */
export function useDuplicatePage() {
  const queryClient = useQueryClient();

  return useMutation<Page, Error, { id: string; workspaceId: string }>({
    mutationFn: async ({ id }) => {
      const res = await apiClient.post<PageResponse>(
        API_ROUTES.pages.duplicate(id),
      );
      return res.data.page;
    },
    onSuccess: (_page, { workspaceId }) => {
      queryClient.invalidateQueries({
        queryKey: queryKeys.pages.list(workspaceId),
      });
    },
  });
}

/**
 * Fetches the breadcrumb chain for a page (root → current). Used by the
 * page-chrome breadcrumb header. Cached separately from the page detail.
 */
export function useBreadcrumb(pageId: string | null | undefined) {
  const { isAuthenticated } = useOxy();

  return useQuery<BreadcrumbResponse>({
    queryKey: pageId
      ? queryKeys.pages.breadcrumb(pageId)
      : ["page", "none", "breadcrumb"],
    queryFn: async () => {
      if (!pageId) throw new Error("Page id required");
      const res = await apiClient.get(API_ROUTES.pages.breadcrumb(pageId));
      return res.data;
    },
    enabled: isAuthenticated && Boolean(pageId),
    staleTime: 1000 * 30,
  });
}

/**
 * Lists archived pages for a workspace. Backs the /trash route.
 */
export function useArchivedPages(workspaceId: string | null) {
  const { isAuthenticated } = useOxy();

  return useQuery<PagesListResponse>({
    queryKey: queryKeys.pages.archived(workspaceId),
    queryFn: async () => {
      const res = await apiClient.get(API_ROUTES.pages.list, {
        params: workspaceId
          ? { workspaceId, archivedOnly: "true", includeArchived: "true" }
          : undefined,
      });
      return res.data;
    },
    staleTime: 1000 * 10,
    enabled: isAuthenticated && Boolean(workspaceId),
  });
}

/**
 * Empties the workspace trash (owner only). Cascade-deletes archived pages
 * and their blocks.
 */
export function useEmptyTrash() {
  const queryClient = useQueryClient();

  return useMutation<{ deleted: number }, Error, { workspaceId: string }>({
    mutationFn: async ({ workspaceId }) => {
      const res = await apiClient.post<{ success: boolean; deleted: number }>(
        API_ROUTES.workspaces.emptyTrash(workspaceId),
      );
      return { deleted: res.data.deleted };
    },
    onSuccess: (_data, { workspaceId }) => {
      queryClient.invalidateQueries({
        queryKey: queryKeys.pages.archived(workspaceId),
      });
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
