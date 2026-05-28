import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useOxy } from "@oxyhq/services";
import apiClient from "../api/client";
import { API_ROUTES } from "../api/routes";
import { queryKeys } from "./query-keys";
import type {
  Comment,
  CommentContent,
  CommentResponse,
  CommentsListResponse,
} from "../types/comments";

/**
 * Page-level comment query. Pass `includeResolved=true` to fetch resolved
 * threads alongside open ones. Defaults to open only so the right-side panel
 * can render the "Open" filter without a second fetch.
 */
export function usePageComments(
  pageId: string | undefined,
  includeResolved = false,
) {
  const { isAuthenticated } = useOxy();
  return useQuery<CommentsListResponse>({
    queryKey: pageId
      ? queryKeys.comments.page(pageId, includeResolved)
      : ["comments", "page", "none", includeResolved],
    queryFn: async () => {
      if (!pageId) throw new Error("Page id required");
      const res = await apiClient.get<CommentsListResponse>(
        API_ROUTES.comments.listForPage(pageId),
        { params: includeResolved ? { includeResolved: "true" } : undefined },
      );
      return res.data;
    },
    enabled: isAuthenticated && Boolean(pageId),
    staleTime: 1000 * 15,
  });
}

/**
 * Block-level comment query — used by the inline comment indicator badge.
 * Returns both open and resolved comments; clients filter.
 */
export function useBlockComments(blockId: string | undefined) {
  const { isAuthenticated } = useOxy();
  return useQuery<CommentsListResponse>({
    queryKey: blockId
      ? queryKeys.comments.block(blockId)
      : ["comments", "block", "none"],
    queryFn: async () => {
      if (!blockId) throw new Error("Block id required");
      const res = await apiClient.get<CommentsListResponse>(
        API_ROUTES.blocks.comments(blockId),
      );
      return res.data;
    },
    enabled: isAuthenticated && Boolean(blockId),
    staleTime: 1000 * 30,
  });
}

interface CreateCommentInput {
  pageId: string;
  blockId?: string | null;
  parentCommentId?: string | null;
  content: { segments: CommentContent["segments"] };
}

export function useCreateComment() {
  const queryClient = useQueryClient();
  return useMutation<Comment, Error, CreateCommentInput>({
    mutationFn: async ({ pageId, ...input }) => {
      const res = await apiClient.post<CommentResponse>(
        API_ROUTES.comments.create(pageId),
        input,
      );
      return res.data.comment;
    },
    onSuccess: (comment) => {
      queryClient.invalidateQueries({
        queryKey: ["comments", "page", comment.pageId],
      });
      if (comment.blockId) {
        queryClient.invalidateQueries({
          queryKey: queryKeys.comments.block(comment.blockId),
        });
      }
    },
  });
}

interface UpdateCommentInput {
  id: string;
  pageId: string;
  blockId: string | null;
  content: { segments: CommentContent["segments"] };
}

export function useUpdateComment() {
  const queryClient = useQueryClient();
  return useMutation<Comment, Error, UpdateCommentInput>({
    mutationFn: async ({ id, content }) => {
      const res = await apiClient.patch<CommentResponse>(
        API_ROUTES.comments.update(id),
        { content },
      );
      return res.data.comment;
    },
    onSuccess: (comment) => {
      queryClient.invalidateQueries({
        queryKey: ["comments", "page", comment.pageId],
      });
      if (comment.blockId) {
        queryClient.invalidateQueries({
          queryKey: queryKeys.comments.block(comment.blockId),
        });
      }
    },
  });
}

interface ResolveCommentInput {
  id: string;
  pageId: string;
}

export function useResolveComment() {
  const queryClient = useQueryClient();
  return useMutation<Comment, Error, ResolveCommentInput>({
    mutationFn: async ({ id }) => {
      const res = await apiClient.post<CommentResponse>(
        API_ROUTES.comments.resolve(id),
      );
      return res.data.comment;
    },
    onSuccess: (comment) => {
      queryClient.invalidateQueries({
        queryKey: ["comments", "page", comment.pageId],
      });
      if (comment.blockId) {
        queryClient.invalidateQueries({
          queryKey: queryKeys.comments.block(comment.blockId),
        });
      }
    },
  });
}

export function useUnresolveComment() {
  const queryClient = useQueryClient();
  return useMutation<Comment, Error, ResolveCommentInput>({
    mutationFn: async ({ id }) => {
      const res = await apiClient.post<CommentResponse>(
        API_ROUTES.comments.unresolve(id),
      );
      return res.data.comment;
    },
    onSuccess: (comment) => {
      queryClient.invalidateQueries({
        queryKey: ["comments", "page", comment.pageId],
      });
      if (comment.blockId) {
        queryClient.invalidateQueries({
          queryKey: queryKeys.comments.block(comment.blockId),
        });
      }
    },
  });
}

interface DeleteCommentInput {
  id: string;
  pageId: string;
  blockId: string | null;
}

export function useDeleteComment() {
  const queryClient = useQueryClient();
  return useMutation<void, Error, DeleteCommentInput>({
    mutationFn: async ({ id }) => {
      await apiClient.delete(API_ROUTES.comments.delete(id));
    },
    onSuccess: (_data, { pageId, blockId }) => {
      queryClient.invalidateQueries({
        queryKey: ["comments", "page", pageId],
      });
      if (blockId) {
        queryClient.invalidateQueries({
          queryKey: queryKeys.comments.block(blockId),
        });
      }
    },
  });
}

/**
 * Group comments into threads: each top-level comment becomes a thread root,
 * replies attach to their parent. Resolved + open threads are returned in
 * original order from the API.
 */
export interface CommentThread {
  root: Comment;
  replies: Comment[];
}

export function groupIntoThreads(comments: Comment[]): CommentThread[] {
  const byParent = new Map<string, Comment[]>();
  const roots: Comment[] = [];
  for (const c of comments) {
    if (c.parentCommentId === null) {
      roots.push(c);
    } else {
      const list = byParent.get(c.parentCommentId) ?? [];
      list.push(c);
      byParent.set(c.parentCommentId, list);
    }
  }
  return roots.map((root) => ({
    root,
    replies: (byParent.get(root.id) ?? []).sort(
      (a, b) =>
        new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime(),
    ),
  }));
}
