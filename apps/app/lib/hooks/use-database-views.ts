import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useOxy } from "@oxyhq/services";
import apiClient from "../api/client";
import { API_ROUTES } from "../api/routes";
import { queryKeys } from "./query-keys";
import type {
  DatabaseView,
  DatabaseViewResponse,
  DatabaseViewType,
  DatabaseViewsResponse,
  FilterGroup,
  ViewConfig,
  ViewSort,
} from "../types/databases";

interface CreateViewInput {
  databaseId: string;
  name: string;
  type: DatabaseViewType;
  isDefault?: boolean;
  filters?: FilterGroup;
  sorts?: ViewSort[];
  groupBy?: { propertyId: string } | null;
  hiddenProperties?: string[];
  frozenProperties?: string[];
  pageSize?: number;
  config?: ViewConfig;
  order?: number;
}

interface UpdateViewInput {
  databaseId: string;
  viewId: string;
  name?: string;
  type?: DatabaseViewType;
  isDefault?: boolean;
  filters?: FilterGroup;
  sorts?: ViewSort[];
  groupBy?: { propertyId: string } | null;
  hiddenProperties?: string[];
  frozenProperties?: string[];
  pageSize?: number;
  config?: ViewConfig;
  order?: number;
}

interface DeleteViewInput {
  databaseId: string;
  viewId: string;
}

export function useDatabaseViews(databaseId: string | undefined) {
  const { isAuthenticated } = useOxy();
  return useQuery<DatabaseViewsResponse>({
    queryKey: databaseId
      ? queryKeys.databases.views(databaseId)
      : ["database", "none", "views"],
    queryFn: async () => {
      if (!databaseId) throw new Error("Database id required");
      const res = await apiClient.get<DatabaseViewsResponse>(
        API_ROUTES.databases.listViews(databaseId),
      );
      return res.data;
    },
    enabled: isAuthenticated && Boolean(databaseId),
  });
}

export function useCreateView() {
  const queryClient = useQueryClient();
  return useMutation<DatabaseView, Error, CreateViewInput>({
    mutationFn: async ({ databaseId, ...input }) => {
      const res = await apiClient.post<DatabaseViewResponse>(
        API_ROUTES.databases.createView(databaseId),
        input,
      );
      return res.data.view;
    },
    onSettled: (_data, _err, { databaseId }) => {
      queryClient.invalidateQueries({
        queryKey: queryKeys.databases.detail(databaseId),
      });
      queryClient.invalidateQueries({
        queryKey: queryKeys.databases.views(databaseId),
      });
    },
  });
}

export function useUpdateView() {
  const queryClient = useQueryClient();
  return useMutation<DatabaseView, Error, UpdateViewInput>({
    mutationFn: async ({ databaseId, viewId, ...patch }) => {
      const res = await apiClient.patch<DatabaseViewResponse>(
        API_ROUTES.databases.updateView(databaseId, viewId),
        patch,
      );
      return res.data.view;
    },
    onSettled: (_data, _err, { databaseId }) => {
      queryClient.invalidateQueries({
        queryKey: queryKeys.databases.detail(databaseId),
      });
      queryClient.invalidateQueries({
        queryKey: queryKeys.databases.views(databaseId),
      });
      queryClient.invalidateQueries({
        queryKey: ["database", databaseId, "rows"],
      });
    },
  });
}

export function useDeleteView() {
  const queryClient = useQueryClient();
  return useMutation<void, Error, DeleteViewInput>({
    mutationFn: async ({ databaseId, viewId }) => {
      await apiClient.delete(
        API_ROUTES.databases.deleteView(databaseId, viewId),
      );
    },
    onSettled: (_data, _err, { databaseId }) => {
      queryClient.invalidateQueries({
        queryKey: queryKeys.databases.detail(databaseId),
      });
      queryClient.invalidateQueries({
        queryKey: queryKeys.databases.views(databaseId),
      });
    },
  });
}
