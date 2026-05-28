export const queryKeys = {
  conversations: {
    all: ['conversations'] as const,
    detail: (id: string) => ['conversation', id] as const,
  },
  credits: {
    info: ['credits'] as const,
    usage: (period?: string) => period ? ['credits-usage', period] as const : ['credits-usage'] as const,
    analytics: (period: string) => ['analytics', period] as const,
    price: ['credit-price'] as const,
    usageWarning: ['usage-warning'] as const,
  },
  billing: {
    packages: ['credit-packages'] as const,
    plans: (product?: string) => ['subscription-plans', product] as const,
    subscription: (product?: string) => ['subscription', product] as const,
    subscriptionPoll: (product?: string) => ['subscription-poll', product] as const,
    transactions: (limit?: number, offset?: number) => ['transactions', limit, offset] as const,
    entitlements: ['entitlements'] as const,
  },
  developer: {
    apps: ['developer-apps'] as const,
    app: (id: string) => ['developer-app', id] as const,
    keys: (appId: string) => ['developer-keys', appId] as const,
    usage: (appId: string, period: string) => ['developer-usage', appId, period] as const,
    keyUsage: (appId: string, keyId: string, period: string) => ['developer-key-usage', appId, keyId, period] as const,
    stats: ['developer-stats'] as const,
    modelsStats: ['models-stats'] as const,
  },
  organizations: {
    all: ['organizations'] as const,
    detail: (id: string) => ['organization', id] as const,
    members: (orgId: string) => ['organization-members', orgId] as const,
    agents: (orgId: string) => ['organization-agents', orgId] as const,
    invites: (orgId: string) => ['organization-invites', orgId] as const,
  },
  agentTeams: {
    all: ['agent-teams'] as const,
    detail: (id: string) => ['agent-team', id] as const,
  },
  referrals: {
    info: ['referral-info'] as const,
    history: ['referral-history'] as const,
  },
  suggestions: {
    welcome: ['suggestions', 'welcome'] as const,
    search: (query: string) => ['suggestions', 'search', query] as const,
    me: ['suggestions', 'me'] as const,
  },
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
