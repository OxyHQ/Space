import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useOxy } from "@oxyhq/services";
import apiClient from "../api/client";
import { API_ROUTES } from "../api/routes";
import { queryKeys } from "./query-keys";
import type {
  Database,
  DatabaseResponse,
  DatabaseSchema,
  DatabasesListResponse,
  DatabaseView,
} from "../types/databases";

interface CreateDatabaseInput {
  workspaceId: string;
  name?: string;
  icon?: string | null;
  cover?: string | null;
  schema?: DatabaseSchema;
  isInline?: boolean;
  parentPageId?: string | null;
}

interface UpdateDatabaseInput {
  id: string;
  name?: string;
  icon?: string | null;
  cover?: string | null;
  archived?: boolean;
}

/**
 * Fetch every database in the workspace. Used by:
 *  - the sidebar "Databases" section,
 *  - the /db/[id] route to pick a default DB when none is provided,
 *  - the inline-database block picker.
 */
export function useDatabases(workspaceId: string | null) {
  const { isAuthenticated } = useOxy();
  return useQuery<DatabasesListResponse>({
    queryKey: queryKeys.databases.list(workspaceId),
    queryFn: async () => {
      const res = await apiClient.get(API_ROUTES.databases.list, {
        params: workspaceId ? { workspaceId } : undefined,
      });
      return res.data;
    },
    staleTime: 1000 * 30,
    enabled: isAuthenticated && Boolean(workspaceId),
  });
}

/**
 * Single database with its views attached. The detail route renders both,
 * so we co-locate them in one query and one cache key.
 */
export function useDatabase(id: string | undefined) {
  const { isAuthenticated } = useOxy();
  return useQuery<{ database: Database; views: DatabaseView[] }>({
    queryKey: id ? queryKeys.databases.detail(id) : ["database", "none"],
    queryFn: async () => {
      if (!id) throw new Error("Database id required");
      const res = await apiClient.get<{
        database: Database;
        views: DatabaseView[];
      }>(API_ROUTES.databases.get(id));
      return {
        database: res.data.database,
        views: res.data.views ?? [],
      };
    },
    enabled: isAuthenticated && Boolean(id),
  });
}

export function useCreateDatabase() {
  const queryClient = useQueryClient();
  return useMutation<
    { database: Database; views: DatabaseView[] },
    Error,
    CreateDatabaseInput
  >({
    mutationFn: async (input) => {
      const res = await apiClient.post<{
        database: Database;
        views: DatabaseView[];
      }>(API_ROUTES.databases.create, input);
      return {
        database: res.data.database,
        views: res.data.views ?? [],
      };
    },
    onSuccess: ({ database }) => {
      queryClient.invalidateQueries({
        queryKey: queryKeys.databases.list(database.workspaceId),
      });
    },
  });
}

export function useUpdateDatabase() {
  const queryClient = useQueryClient();
  return useMutation<Database, Error, UpdateDatabaseInput>({
    mutationFn: async ({ id, ...patch }) => {
      const res = await apiClient.patch<DatabaseResponse>(
        API_ROUTES.databases.update(id),
        patch,
      );
      return res.data.database;
    },
    onMutate: async ({ id, ...patch }) => {
      await queryClient.cancelQueries({
        queryKey: queryKeys.databases.detail(id),
      });
      const previous = queryClient.getQueryData<{
        database: Database;
        views: DatabaseView[];
      }>(queryKeys.databases.detail(id));
      if (previous) {
        queryClient.setQueryData(queryKeys.databases.detail(id), {
          ...previous,
          database: { ...previous.database, ...patch } as Database,
        });
      }
      return { previous };
    },
    onError: (_err, { id }, context) => {
      const ctx = context as
        | {
            previous?: { database: Database; views: DatabaseView[] };
          }
        | undefined;
      if (ctx?.previous) {
        queryClient.setQueryData(
          queryKeys.databases.detail(id),
          ctx.previous,
        );
      }
    },
    onSettled: (database) => {
      if (!database) return;
      queryClient.invalidateQueries({
        queryKey: queryKeys.databases.list(database.workspaceId),
      });
      queryClient.invalidateQueries({
        queryKey: queryKeys.databases.detail(database.id),
      });
    },
  });
}

interface DeleteDatabaseInput {
  id: string;
  workspaceId: string;
  hard?: boolean;
}

export function useDeleteDatabase() {
  const queryClient = useQueryClient();
  return useMutation<void, Error, DeleteDatabaseInput>({
    mutationFn: async ({ id, hard }) => {
      await apiClient.delete(API_ROUTES.databases.delete(id), {
        params: hard ? { hard: "true" } : undefined,
      });
    },
    onSuccess: (_data, { workspaceId }) => {
      queryClient.invalidateQueries({
        queryKey: queryKeys.databases.list(workspaceId),
      });
    },
  });
}
