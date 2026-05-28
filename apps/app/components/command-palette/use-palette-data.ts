import * as React from 'react';
import { Linking, Platform } from 'react-native';
import {
  FileText,
  Settings as SettingsIcon,
  Trash2,
  Moon,
  Sun,
  Plus,
  HelpCircle,
} from 'lucide-react-native';
import { useRouter } from 'expo-router';
import { useUIStore } from '@/lib/stores/ui-store';
import { useWorkspaceStore } from '@/lib/stores/workspace-store';
import { usePages, useCreatePage } from '@/lib/hooks/use-pages';
import { useWorkspaceMembers } from '@/lib/hooks/use-workspace-members';
import { useColorScheme } from '@/lib/useColorScheme';
import type { Page } from '@/lib/types/pages';
import type {
  PageItem,
  MemberItem,
  CommandItem,
} from './types';

function memberDisplayName(member: {
  user?: { name?: { first?: string; last?: string } | null; username?: string | null; email?: string | null };
  userId?: string;
}): string {
  const name = member.user?.name;
  const first = name?.first?.trim();
  const last = name?.last?.trim();
  if (first && last) return `${first} ${last}`;
  if (first) return first;
  if (last) return last;
  return member.user?.username ?? member.user?.email ?? member.userId ?? 'Member';
}

interface UsePaletteDataParams {
  /** Current query text. Used to limit result sizing. */
  query: string;
}

interface PaletteData {
  recents: PageItem[];
  pages: PageItem[];
  members: MemberItem[];
  commands: CommandItem[];
}

/**
 * Builds the result groups for the command palette. Memoizes on the inputs
 * so the modal re-renders are cheap.
 */
export function usePaletteData({ query }: UsePaletteDataParams): PaletteData {
  const router = useRouter();
  const currentWorkspaceId = useWorkspaceStore((s) => s.currentWorkspaceId);
  const recentPageIds = useUIStore((s) => s.recentPageIds);
  const setCommandPaletteOpen = useUIStore((s) => s.setCommandPaletteOpen);
  const setShortcutsDialogOpen = useUIStore((s) => s.setShortcutsDialogOpen);
  const { setColorScheme, colorScheme } = useColorScheme();
  const createPage = useCreatePage();

  const { data: pageData } = usePages(currentWorkspaceId);
  const { data: members } = useWorkspaceMembers(currentWorkspaceId);

  const pageById = React.useMemo(() => {
    const m = new Map<string, Page>();
    for (const p of pageData?.pages ?? []) m.set(p._id, p);
    return m;
  }, [pageData?.pages]);

  /**
   * Build a breadcrumb (chain of ancestor titles up to root) for a page.
   * Falls back to "Untitled" when an ancestor has no title.
   */
  const buildBreadcrumb = React.useCallback(
    (page: Page): string => {
      const parts: string[] = [];
      let cursor: Page | undefined = page;
      // Guard against cycles by capping depth.
      let depth = 0;
      while (cursor && depth < 16) {
        parts.unshift(cursor.title.trim() || 'Untitled');
        if (!cursor.parentId) break;
        cursor = pageById.get(cursor.parentId);
        depth += 1;
      }
      return parts.slice(0, -1).join(' / ');
    },
    [pageById],
  );

  const pages: PageItem[] = React.useMemo(() => {
    const visible = (pageData?.pages ?? []).filter((p) => !p.archived);
    return visible.map<PageItem>((p) => {
      const breadcrumb = buildBreadcrumb(p);
      const title = p.title.trim() || 'Untitled';
      return {
        kind: 'page',
        id: `page:${p._id}`,
        pageId: p._id,
        searchValue: `${title} ${breadcrumb}`.trim(),
        title,
        subtitle: breadcrumb || undefined,
        icon: p.icon,
        breadcrumb: breadcrumb || undefined,
      };
    });
  }, [pageData?.pages, buildBreadcrumb]);

  const recents: PageItem[] = React.useMemo(() => {
    if (query.trim().length > 0) return [];
    const byId = new Map(pages.map((p) => [p.pageId, p] as const));
    const out: PageItem[] = [];
    for (const id of recentPageIds) {
      const match = byId.get(id);
      if (match) out.push(match);
      if (out.length >= 5) break;
    }
    return out;
  }, [pages, recentPageIds, query]);

  const memberItems: MemberItem[] = React.useMemo(() => {
    const list = members ?? [];
    return list.map<MemberItem>((m) => {
      const title = memberDisplayName(m);
      const email = m.user?.email ?? null;
      const username = m.user?.username ?? null;
      return {
        kind: 'member',
        id: `member:${m._id}`,
        searchValue: `${title} ${email ?? ''} ${username ?? ''}`.trim(),
        title,
        subtitle: email ?? (username ? `@${username}` : undefined),
        email,
        username,
        avatar: m.user?.avatar ?? null,
        userId: m.userId,
      };
    });
  }, [members]);

  const commands: CommandItem[] = React.useMemo(() => {
    const close = () => setCommandPaletteOpen(false);
    const list: CommandItem[] = [
      {
        kind: 'command',
        id: 'cmd:new-page',
        title: 'New page',
        subtitle: 'Create a page in the current workspace',
        searchValue: 'new page create',
        icon: Plus,
        shortcut: 'N',
        onSelect: () => {
          close();
          if (!currentWorkspaceId) return;
          createPage
            .mutateAsync({
              workspaceId: currentWorkspaceId,
              parentId: null,
              title: '',
            })
            .then((page) => {
              router.push(`/p/${page._id}`);
            })
            .catch(() => {
              /* mutation surfaces errors via state */
            });
        },
      },
      {
        kind: 'command',
        id: 'cmd:settings',
        title: 'Open settings',
        searchValue: 'settings preferences',
        icon: SettingsIcon,
        onSelect: () => {
          close();
          router.push('/(app)/settings');
        },
      },
      {
        kind: 'command',
        id: 'cmd:trash',
        title: 'Open trash',
        searchValue: 'trash deleted archived',
        icon: Trash2,
        onSelect: () => {
          close();
          router.push('/trash');
        },
      },
      {
        kind: 'command',
        id: 'cmd:toggle-theme',
        title: colorScheme === 'dark' ? 'Switch to light mode' : 'Switch to dark mode',
        searchValue: 'theme dark light mode toggle',
        icon: colorScheme === 'dark' ? Sun : Moon,
        onSelect: () => {
          close();
          setColorScheme(colorScheme === 'dark' ? 'light' : 'dark');
        },
      },
      {
        kind: 'command',
        id: 'cmd:shortcuts',
        title: 'Keyboard shortcuts',
        searchValue: 'help keyboard shortcuts',
        icon: HelpCircle,
        shortcut: '/',
        onSelect: () => {
          close();
          setShortcutsDialogOpen(true);
        },
      },
    ];

    // Web-only utility: open in new tab via Linking on native is irrelevant
    // here, but keep this guard around the future "open external" actions.
    if (Platform.OS === 'web') {
      list.push({
        kind: 'command',
        id: 'cmd:docs',
        title: 'Open Oxy docs',
        searchValue: 'docs help documentation',
        icon: FileText,
        onSelect: () => {
          close();
          Linking.openURL('https://oxy.so/docs');
        },
      });
    }
    return list;
  }, [
    colorScheme,
    createPage,
    currentWorkspaceId,
    router,
    setColorScheme,
    setCommandPaletteOpen,
    setShortcutsDialogOpen,
  ]);

  return { recents, pages, members: memberItems, commands };
}
