import { useMutation, useQueryClient } from "@tanstack/react-query";
import apiClient from "../api/client";
import { API_ROUTES } from "../api/routes";
import { queryKeys } from "./query-keys";
import type {
  Database,
  DatabaseResponse,
  DatabasePropertyType,
  PropertyConfig,
} from "../types/databases";

interface AddPropertyInput {
  databaseId: string;
  id?: string;
  name: string;
  type: DatabasePropertyType;
  config?: PropertyConfig;
}

interface UpdatePropertyInput {
  databaseId: string;
  propertyId: string;
  name?: string;
  type?: DatabasePropertyType;
  config?: PropertyConfig;
}

interface DeletePropertyInput {
  databaseId: string;
  propertyId: string;
}

export function useAddProperty() {
  const queryClient = useQueryClient();
  return useMutation<Database, Error, AddPropertyInput>({
    mutationFn: async ({ databaseId, ...input }) => {
      const res = await apiClient.post<DatabaseResponse>(
        API_ROUTES.databases.addProperty(databaseId),
        input,
      );
      return res.data.database;
    },
    onSettled: (database) => {
      if (!database) return;
      queryClient.invalidateQueries({
        queryKey: queryKeys.databases.detail(database.id),
      });
      queryClient.invalidateQueries({
        queryKey: ["database", database.id, "rows"],
      });
    },
  });
}

export function useUpdateProperty() {
  const queryClient = useQueryClient();
  return useMutation<Database, Error, UpdatePropertyInput>({
    mutationFn: async ({ databaseId, propertyId, ...input }) => {
      const res = await apiClient.patch<DatabaseResponse>(
        API_ROUTES.databases.updateProperty(databaseId, propertyId),
        input,
      );
      return res.data.database;
    },
    onSettled: (database) => {
      if (!database) return;
      queryClient.invalidateQueries({
        queryKey: queryKeys.databases.detail(database.id),
      });
      queryClient.invalidateQueries({
        queryKey: ["database", database.id, "rows"],
      });
    },
  });
}

export function useDeleteProperty() {
  const queryClient = useQueryClient();
  return useMutation<Database, Error, DeletePropertyInput>({
    mutationFn: async ({ databaseId, propertyId }) => {
      const res = await apiClient.delete<DatabaseResponse>(
        API_ROUTES.databases.deleteProperty(databaseId, propertyId),
      );
      return res.data.database;
    },
    onSettled: (database) => {
      if (!database) return;
      queryClient.invalidateQueries({
        queryKey: queryKeys.databases.detail(database.id),
      });
      queryClient.invalidateQueries({
        queryKey: ["database", database.id, "rows"],
      });
    },
  });
}
