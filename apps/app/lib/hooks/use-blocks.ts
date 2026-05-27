import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useOxy } from "@oxyhq/services";
import apiClient from "../api/client";
import { API_ROUTES } from "../api/routes";
import { queryKeys } from "./query-keys";
import type {
  Block,
  BlockContent,
  BlockResponse,
  BlockType,
  BlocksListResponse,
} from "../types/pages";

interface CreateBlockInput {
  pageId: string;
  type: BlockType;
  content?: BlockContent;
  order: number;
  parentBlockId?: string | null;
  /** Optional client-generated id for optimistic updates. */
  clientId?: string;
}

interface UpdateBlockInput {
  id: string;
  pageId: string;
  type?: BlockType;
  content?: BlockContent;
  order?: number;
  parentBlockId?: string | null;
}

interface DeleteBlockInput {
  id: string;
  pageId: string;
}

interface ReorderBlocksInput {
  pageId: string;
  blockIds: string[];
}

export function useBlocks(pageId: string | undefined) {
  const { isAuthenticated } = useOxy();

  return useQuery<BlocksListResponse>({
    queryKey: pageId ? queryKeys.blocks.list(pageId) : ["blocks", "none"],
    queryFn: async () => {
      if (!pageId) throw new Error("Page id required");
      const res = await apiClient.get(API_ROUTES.pages.blocks(pageId));
      return res.data;
    },
    enabled: isAuthenticated && Boolean(pageId),
  });
}

export function useCreateBlock() {
  const queryClient = useQueryClient();

  return useMutation<Block, Error, CreateBlockInput>({
    mutationFn: async ({ pageId, clientId: _clientId, ...input }) => {
      const res = await apiClient.post<BlockResponse>(
        API_ROUTES.pages.blocks(pageId),
        input,
      );
      return res.data.block;
    },
    onSettled: (block) => {
      if (!block) return;
      queryClient.invalidateQueries({
        queryKey: queryKeys.blocks.list(block.pageId),
      });
    },
  });
}

export function useUpdateBlock() {
  const queryClient = useQueryClient();

  return useMutation<Block, Error, UpdateBlockInput>({
    mutationFn: async ({ id, pageId: _pageId, ...patch }) => {
      const res = await apiClient.patch<BlockResponse>(
        API_ROUTES.blocks.update(id),
        patch,
      );
      return res.data.block;
    },
    onMutate: async ({ id, pageId, ...patch }) => {
      await queryClient.cancelQueries({
        queryKey: queryKeys.blocks.list(pageId),
      });
      const previous = queryClient.getQueryData<BlocksListResponse>(
        queryKeys.blocks.list(pageId),
      );
      if (previous) {
        queryClient.setQueryData<BlocksListResponse>(
          queryKeys.blocks.list(pageId),
          {
            blocks: previous.blocks.map((b) =>
              b._id === id ? ({ ...b, ...patch } as Block) : b,
            ),
          },
        );
      }
      return { previous, pageId };
    },
    onError: (_err, { pageId }, context) => {
      const ctx = context as
        | { previous?: BlocksListResponse; pageId: string }
        | undefined;
      if (ctx?.previous) {
        queryClient.setQueryData(queryKeys.blocks.list(pageId), ctx.previous);
      }
    },
    onSettled: (_block, _err, { pageId }) => {
      queryClient.invalidateQueries({
        queryKey: queryKeys.blocks.list(pageId),
      });
    },
  });
}

export function useDeleteBlock() {
  const queryClient = useQueryClient();

  return useMutation<void, Error, DeleteBlockInput>({
    mutationFn: async ({ id }) => {
      await apiClient.delete(API_ROUTES.blocks.delete(id));
    },
    onMutate: async ({ id, pageId }) => {
      await queryClient.cancelQueries({
        queryKey: queryKeys.blocks.list(pageId),
      });
      const previous = queryClient.getQueryData<BlocksListResponse>(
        queryKeys.blocks.list(pageId),
      );
      if (previous) {
        queryClient.setQueryData<BlocksListResponse>(
          queryKeys.blocks.list(pageId),
          { blocks: previous.blocks.filter((b) => b._id !== id) },
        );
      }
      return { previous };
    },
    onError: (_err, { pageId }, context) => {
      const ctx = context as { previous?: BlocksListResponse } | undefined;
      if (ctx?.previous) {
        queryClient.setQueryData(queryKeys.blocks.list(pageId), ctx.previous);
      }
    },
    onSettled: (_data, _err, { pageId }) => {
      queryClient.invalidateQueries({
        queryKey: queryKeys.blocks.list(pageId),
      });
    },
  });
}

export function useReorderBlocks() {
  const queryClient = useQueryClient();

  return useMutation<void, Error, ReorderBlocksInput>({
    mutationFn: async ({ pageId, blockIds }) => {
      await apiClient.post(API_ROUTES.blocks.reorder(pageId), { blockIds });
    },
    onSettled: (_data, _err, { pageId }) => {
      queryClient.invalidateQueries({
        queryKey: queryKeys.blocks.list(pageId),
      });
    },
  });
}
