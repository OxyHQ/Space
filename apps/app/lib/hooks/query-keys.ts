export const queryKeys = {
  pages: {
    list: (workspaceId: string | null) => ['pages', workspaceId] as const,
    detail: (id: string) => ['page', id] as const,
    breadcrumb: (id: string) => ['page', id, 'breadcrumb'] as const,
    archived: (workspaceId: string | null) =>
      ['pages', workspaceId, 'archived'] as const,
  },
  blocks: {
    list: (pageId: string) => ['blocks', pageId] as const,
  },
  comments: {
    page: (pageId: string, includeResolved: boolean) =>
      ['comments', 'page', pageId, includeResolved] as const,
    block: (blockId: string) => ['comments', 'block', blockId] as const,
  },
  databases: {
    list: (workspaceId: string | null) => ['databases', workspaceId] as const,
    detail: (id: string) => ['database', id] as const,
    views: (id: string) => ['database', id, 'views'] as const,
    rows: (id: string, viewId: string | null) =>
      ['database', id, 'rows', viewId] as const,
  },
} as const;
