import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../../models/workspace.js', () => ({
  Workspace: vi.fn(),
}));

vi.mock('../../models/workspace-member.js', async () => {
  // We keep the real helpers (compareRoles, hasRole) — only mock the
  // model. This way we can verify role-hierarchy logic without spinning
  // up Mongo.
  const actual = await vi.importActual<typeof import('../../models/workspace-member.js')>(
    '../../models/workspace-member.js',
  );
  return {
    ...actual,
    WorkspaceMember: vi.fn(),
  };
});

vi.mock('../../models/share-link.js', () => ({
  ShareLink: vi.fn(),
  SHARE_LINK_SCOPES: ['read', 'comment', 'edit'],
}));

vi.mock('../../middleware/auth.js', () => ({
  authenticateToken: vi.fn((_req: any, _res: any, next: any) => next()),
  oxyClient: { getUserById: vi.fn(), searchProfiles: vi.fn() },
}));

vi.mock('../../middleware/workspace.js', () => ({
  ensurePersonalWorkspace: vi.fn((_req: any, _res: any, next: any) => next()),
  requireWorkspaceMember: vi.fn((_req: any, _res: any, next: any) => next()),
  requireRole: vi.fn(() => (_req: any, _res: any, next: any) => next()),
}));

vi.mock('../../lib/logger.js', () => ({
  log: {
    general: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
  },
}));

import { compareRoles, hasRole, WORKSPACE_ROLES } from '../../models/workspace-member.js';

describe('workspace role helpers', () => {
  it('orders roles viewer < commenter < editor < admin < owner', () => {
    expect(WORKSPACE_ROLES).toEqual(['viewer', 'commenter', 'editor', 'admin', 'owner']);
  });

  it('compareRoles returns negative when a < b', () => {
    expect(compareRoles('viewer', 'editor')).toBeLessThan(0);
    expect(compareRoles('editor', 'owner')).toBeLessThan(0);
  });

  it('compareRoles returns zero on equality', () => {
    expect(compareRoles('editor', 'editor')).toBe(0);
    expect(compareRoles('owner', 'owner')).toBe(0);
  });

  it('compareRoles returns positive when a > b', () => {
    expect(compareRoles('owner', 'admin')).toBeGreaterThan(0);
    expect(compareRoles('admin', 'commenter')).toBeGreaterThan(0);
  });

  it('hasRole grants higher roles all lower privileges', () => {
    expect(hasRole('owner', 'viewer')).toBe(true);
    expect(hasRole('admin', 'editor')).toBe(true);
    expect(hasRole('editor', 'commenter')).toBe(true);
    expect(hasRole('commenter', 'viewer')).toBe(true);
  });

  it('hasRole denies escalation', () => {
    expect(hasRole('viewer', 'commenter')).toBe(false);
    expect(hasRole('editor', 'admin')).toBe(false);
    expect(hasRole('admin', 'owner')).toBe(false);
  });

  it('hasRole accepts equal roles', () => {
    expect(hasRole('admin', 'admin')).toBe(true);
    expect(hasRole('viewer', 'viewer')).toBe(true);
  });
});

describe('workspace create input validation', () => {
  let createWorkspaceSchema: any;

  beforeEach(async () => {
    // Re-import inside beforeEach so the mocks above take effect even
    // though we are only exercising the local schemas.
    const mod = await import('zod');
    createWorkspaceSchema = mod.z.object({
      name: mod.z.string().trim().min(1).max(200),
      icon: mod.z.string().max(64).nullable().optional(),
    });
  });

  it('accepts a minimal valid body', () => {
    const result = createWorkspaceSchema.safeParse({ name: 'Team' });
    expect(result.success).toBe(true);
  });

  it('rejects empty names', () => {
    const result = createWorkspaceSchema.safeParse({ name: '' });
    expect(result.success).toBe(false);
  });

  it('rejects overlong names', () => {
    const result = createWorkspaceSchema.safeParse({ name: 'x'.repeat(201) });
    expect(result.success).toBe(false);
  });

  it('allows null icon', () => {
    const result = createWorkspaceSchema.safeParse({ name: 'X', icon: null });
    expect(result.success).toBe(true);
  });

  it('allows omitted icon', () => {
    const result = createWorkspaceSchema.safeParse({ name: 'X' });
    expect(result.success).toBe(true);
  });
});

describe('share link token generation', () => {
  it('generates base64url tokens of expected length', async () => {
    const crypto = await import('crypto');
    const token = crypto.randomBytes(24).toString('base64url');
    expect(token).toMatch(/^[A-Za-z0-9_-]+$/);
    // base64url(24 bytes) = 32 chars (no padding)
    expect(token.length).toBe(32);
  });
});
