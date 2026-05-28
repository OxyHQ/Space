import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useOxy } from "@oxyhq/services";
import apiClient from "../api/client";
import { API_ROUTES } from "../api/routes";
import { queryKeys } from "./query-keys";
import type {
  DatabaseRow,
  DatabaseRowResponse,
  DatabaseRowsResponse,
  PropertyValue,
} from "../types/databases";
import type { Page, PageResponse } from "../types/pages";

/**
 * Backend serializes a database row as a Page payload extended with
 * `databaseId` and `properties`. The shapes are structurally identical
 * to `DatabaseRow` — but Zod-narrowed property values aren't expressible
 * on the Page type without coupling pages to databases. This helper does
 * the runtime-safe conversion in one place.
 */
function pageToDatabaseRow(page: Page): DatabaseRow {
  return {
    id: page._id,
    _id: page._id,
    workspaceId: page.workspaceId,
    parentId: page.parentId,
    databaseId: page.databaseId ?? null,
    title: page.title,
    icon: page.icon ?? null,
    cover: page.cover ?? null,
    ownerId: page.ownerId,
    archived: page.archived,
    order: 0,
    properties: (page.properties ?? {}) as Record<string, PropertyValue>,
    createdAt: page.createdAt,
    updatedAt: page.updatedAt,
  };
}

interface CreateRowInput {
  databaseId: string;
  title?: string;
  properties?: Record<string, PropertyValue | unknown>;
}

interface UpdateRowInput {
  databaseId: string;
  rowId: string;
  title?: string;
  icon?: string | null;
  cover?: string | null;
  archived?: boolean;
  properties?: Record<string, PropertyValue | unknown>;
}

interface DeleteRowInput {
  databaseId: string;
  rowId: string;
}

/**
 * List rows for the given database. When `viewId` is passed, the server
 * applies that view's filters / sorts / page size before returning.
 *
 * The query is keyed on (databaseId, viewId) so switching views fetches
 * fresh rows. We mirror the view's full payload in the response so
 * downstream UI can render badges (active sort, active filter count)
 * without a second roundtrip.
 */
export function useDatabaseRows(
  databaseId: string | undefined,
  viewId: string | null,
) {
  const { isAuthenticated } = useOxy();
  return useQuery<DatabaseRowsResponse>({
    queryKey: databaseId
      ? queryKeys.databases.rows(databaseId, viewId)
      : ["database", "none", "rows"],
    queryFn: async () => {
      if (!databaseId) throw new Error("Database id required");
      const res = await apiClient.get<DatabaseRowsResponse>(
        API_ROUTES.databases.listRows(databaseId),
        { params: viewId ? { viewId } : undefined },
      );
      return res.data;
    },
    enabled: isAuthenticated && Boolean(databaseId),
  });
}

export function useCreateRow() {
  const queryClient = useQueryClient();
  return useMutation<DatabaseRow, Error, CreateRowInput>({
    mutationFn: async ({ databaseId, ...input }) => {
      const res = await apiClient.post<DatabaseRowResponse>(
        API_ROUTES.databases.createRow(databaseId),
        input,
      );
      return res.data.row;
    },
    onSettled: (_data, _err, { databaseId }) => {
      queryClient.invalidateQueries({
        queryKey: ["database", databaseId, "rows"],
      });
    },
  });
}

/**
 * Row updates use the existing PATCH /pages/:id endpoint because a row
 * IS a Page with `databaseId` set. Either `properties` or page-level
 * fields (title, icon, etc.) can be updated in one request.
 */
export function useUpdateRow() {
  const queryClient = useQueryClient();
  return useMutation<DatabaseRow, Error, UpdateRowInput>({
    mutationFn: async ({ rowId, databaseId: _databaseId, ...patch }) => {
      const res = await apiClient.patch<PageResponse>(
        API_ROUTES.pages.update(rowId),
        patch,
      );
      return pageToDatabaseRow(res.data.page);
    },
    onMutate: async ({ databaseId, rowId, ...patch }) => {
      const queries = queryClient.getQueriesData<DatabaseRowsResponse>({
        queryKey: ["database", databaseId, "rows"],
      });
      const previous: Array<{
        key: unknown[];
        data: DatabaseRowsResponse | undefined;
      }> = [];
      for (const [key, data] of queries) {
        previous.push({ key: key as unknown[], data });
        if (!data) continue;
        queryClient.setQueryData<DatabaseRowsResponse>(
          key as unknown[],
          {
            ...data,
            rows: data.rows.map((r) =>
              r.id === rowId
                ? {
                    ...r,
                    ...patch,
                    properties: {
                      ...r.properties,
                      ...((patch.properties ?? {}) as Record<
                        string,
                        PropertyValue
                      >),
                    },
                  }
                : r,
            ),
          },
        );
      }
      return { previous };
    },
    onError: (_err, _vars, context) => {
      const ctx = context as
        | {
            previous?: Array<{
              key: unknown[];
              data: DatabaseRowsResponse | undefined;
            }>;
          }
        | undefined;
      if (!ctx?.previous) return;
      for (const entry of ctx.previous) {
        if (entry.data === undefined) continue;
        queryClient.setQueryData(entry.key, entry.data);
      }
    },
    onSettled: (_data, _err, { databaseId, rowId }) => {
      queryClient.invalidateQueries({
        queryKey: ["database", databaseId, "rows"],
      });
      queryClient.invalidateQueries({
        queryKey: queryKeys.pages.detail(rowId),
      });
    },
  });
}

export function useDeleteRow() {
  const queryClient = useQueryClient();
  return useMutation<void, Error, DeleteRowInput>({
    mutationFn: async ({ rowId }) => {
      // Row deletion is page deletion — soft-delete via /pages/:id with
      // archived: true. Hard delete is gated on workspace ownership.
      await apiClient.delete(API_ROUTES.pages.delete(rowId));
    },
    onSettled: (_data, _err, { databaseId }) => {
      queryClient.invalidateQueries({
        queryKey: ["database", databaseId, "rows"],
      });
    },
  });
}
