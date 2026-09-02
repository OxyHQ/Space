/** Routes consumed by the Station workspace client. */
export const API_ROUTES = {
  pages: {
    list: '/pages',
    create: '/pages',
    get: (id: string) => `/pages/${id}`,
    update: (id: string) => `/pages/${id}`,
    delete: (id: string) => `/pages/${id}`,
    blocks: (id: string) => `/pages/${id}/blocks`,
    duplicate: (id: string) => `/pages/${id}/duplicate`,
    breadcrumb: (id: string) => `/pages/${id}/breadcrumb`,
    export: (id: string) => `/pages/${id}/export`,
  },
  workspaces: {
    emptyTrash: (id: string) => `/workspaces/${id}/trash/empty`,
  },
  blocks: {
    update: (id: string) => `/blocks/${id}`,
    delete: (id: string) => `/blocks/${id}`,
    reorder: (pageId: string) => `/pages/${pageId}/blocks/reorder`,
    comments: (id: string) => `/blocks/${id}/comments`,
  },
  comments: {
    listForPage: (pageId: string) => `/pages/${pageId}/comments`,
    listForBlock: (blockId: string) => `/blocks/${blockId}/comments`,
    create: (pageId: string) => `/pages/${pageId}/comments`,
    update: (id: string) => `/comments/${id}`,
    resolve: (id: string) => `/comments/${id}/resolve`,
    unresolve: (id: string) => `/comments/${id}/unresolve`,
    delete: (id: string) => `/comments/${id}`,
  },
  uploads: {
    presign: '/uploads/presign',
  },
  embed: {
    preview: '/embed/preview',
  },
  databases: {
    list: '/databases',
    create: '/databases',
    get: (id: string) => `/databases/${id}`,
    update: (id: string) => `/databases/${id}`,
    delete: (id: string) => `/databases/${id}`,
    addProperty: (id: string) => `/databases/${id}/properties`,
    updateProperty: (id: string, propertyId: string) =>
      `/databases/${id}/properties/${propertyId}`,
    deleteProperty: (id: string, propertyId: string) =>
      `/databases/${id}/properties/${propertyId}`,
    listRows: (id: string) => `/databases/${id}/rows`,
    createRow: (id: string) => `/databases/${id}/rows`,
    listViews: (id: string) => `/databases/${id}/views`,
    createView: (id: string) => `/databases/${id}/views`,
    updateView: (id: string, viewId: string) =>
      `/databases/${id}/views/${viewId}`,
    deleteView: (id: string, viewId: string) =>
      `/databases/${id}/views/${viewId}`,
  },
} as const;
