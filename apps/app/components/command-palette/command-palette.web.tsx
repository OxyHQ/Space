import * as React from 'react';
import { useRouter } from 'expo-router';
import {
  Command,
  CommandDialog,
  CommandInput,
  CommandList,
  CommandEmpty,
  CommandGroup,
  CommandItem,
  CommandShortcut,
  CommandSeparator,
} from '@/components/ui/command';
import { FileText, Clock } from 'lucide-react-native';
import { useUIStore } from '@/lib/stores/ui-store';
import { usePaletteData } from './use-palette-data';
import type { PageItem, MemberItem, CommandItem as CmdItem } from './types';

/**
 * Web command palette built on top of `cmdk`. Opens on Cmd+K (handled by
 * `useKeyboardShortcuts`) and via the sidebar Search button.
 *
 * Cmd+Enter opens the focused page in a new tab. Plain Enter navigates inline.
 */
export function CommandPalette() {
  const open = useUIStore((s) => s.commandPaletteOpen);
  const setOpen = useUIStore((s) => s.setCommandPaletteOpen);
  const router = useRouter();
  const [query, setQuery] = React.useState('');

  // Reset query when the palette closes so it opens fresh next time.
  React.useEffect(() => {
    if (!open) {
      // Defer to next frame so the close animation can read the query.
      const id = requestAnimationFrame(() => setQuery(''));
      return () => cancelAnimationFrame(id);
    }
  }, [open]);

  const { recents, pages, members, commands } = usePaletteData({ query });

  const openPage = React.useCallback(
    (pageId: string, newTab = false) => {
      setOpen(false);
      if (newTab && typeof window !== 'undefined') {
        window.open(`/p/${pageId}`, '_blank', 'noopener,noreferrer');
        return;
      }
      router.push(`/p/${pageId}`);
    },
    [router, setOpen],
  );

  const handlePageSelect = React.useCallback(
    (item: PageItem) => openPage(item.pageId),
    [openPage],
  );

  const handleMemberSelect = React.useCallback(
    (_member: MemberItem) => {
      setOpen(false);
      // Future: jump to a member's profile / DM. No-op for now.
    },
    [setOpen],
  );

  // Cmd+Enter handler — opens the active page in a new tab.
  const listRef = React.useRef<HTMLDivElement | null>(null);
  React.useEffect(() => {
    if (!open) return;
    const handler = (e: KeyboardEvent) => {
      if (e.key !== 'Enter') return;
      if (!(e.metaKey || e.ctrlKey)) return;
      const root = listRef.current;
      if (!root) return;
      const selected = root.querySelector<HTMLElement>(
        '[cmdk-item][data-selected="true"]',
      );
      if (!selected) return;
      const itemId = selected.getAttribute('data-value');
      if (!itemId) return;
      if (itemId.startsWith('page:')) {
        e.preventDefault();
        e.stopPropagation();
        openPage(itemId.slice('page:'.length), true);
      }
    };
    window.addEventListener('keydown', handler, true);
    return () => window.removeEventListener('keydown', handler, true);
  }, [open, openPage]);

  return (
    <CommandDialog open={open} onOpenChange={setOpen}>
      <CommandInput
        placeholder="Search pages, people and commands…"
        value={query}
        onValueChange={setQuery}
      />
      <div ref={listRef}>
        <CommandList>
          <CommandEmpty>No results.</CommandEmpty>

          {recents.length > 0 ? (
            <CommandGroup heading="Recent">
              {recents.map((item) => (
                <PageRow key={item.id} item={item} onSelect={handlePageSelect} icon={<Clock />} />
              ))}
            </CommandGroup>
          ) : null}

          {pages.length > 0 ? (
            <>
              {recents.length > 0 ? <CommandSeparator /> : null}
              <CommandGroup heading="Pages">
                {pages.map((item) => (
                  <PageRow key={item.id} item={item} onSelect={handlePageSelect} />
                ))}
              </CommandGroup>
            </>
          ) : null}

          {members.length > 0 ? (
            <>
              <CommandSeparator />
              <CommandGroup heading="People">
                {members.map((item) => (
                  <MemberRow key={item.id} item={item} onSelect={handleMemberSelect} />
                ))}
              </CommandGroup>
            </>
          ) : null}

          <CommandSeparator />
          <CommandGroup heading="Commands">
            {commands.map((item) => (
              <CommandRow key={item.id} item={item} />
            ))}
          </CommandGroup>
        </CommandList>
      </div>
    </CommandDialog>
  );
}

interface PageRowProps {
  item: PageItem;
  onSelect: (item: PageItem) => void;
  icon?: React.ReactNode;
}

function PageRow({ item, onSelect, icon }: PageRowProps) {
  return (
    <CommandItem
      value={item.id}
      keywords={[item.title, item.breadcrumb ?? '']}
      onSelect={() => onSelect(item)}
    >
      <span className="flex h-5 w-5 items-center justify-center text-base">
        {item.icon ? item.icon : icon ?? <FileText />}
      </span>
      <span className="flex flex-1 flex-col min-w-0">
        <span className="truncate text-sm text-foreground">{item.title}</span>
        {item.subtitle ? (
          <span className="truncate text-xs text-muted-foreground">
            {item.subtitle}
          </span>
        ) : null}
      </span>
    </CommandItem>
  );
}

interface MemberRowProps {
  item: MemberItem;
  onSelect: (item: MemberItem) => void;
}

function MemberRow({ item, onSelect }: MemberRowProps) {
  const initial = (item.title?.[0] ?? '?').toUpperCase();
  return (
    <CommandItem
      value={item.id}
      keywords={[item.title, item.email ?? '', item.username ?? '']}
      onSelect={() => onSelect(item)}
    >
      <span className="flex h-5 w-5 items-center justify-center rounded-full bg-muted text-[10px] font-semibold text-muted-foreground">
        {initial}
      </span>
      <span className="flex flex-1 flex-col min-w-0">
        <span className="truncate text-sm text-foreground">{item.title}</span>
        {item.subtitle ? (
          <span className="truncate text-xs text-muted-foreground">
            {item.subtitle}
          </span>
        ) : null}
      </span>
    </CommandItem>
  );
}

interface CommandRowProps {
  item: CmdItem;
}

function CommandRow({ item }: CommandRowProps) {
  const Icon = item.icon;
  return (
    <CommandItem
      value={item.id}
      keywords={[item.title, item.searchValue]}
      onSelect={() => item.onSelect()}
    >
      <span className="flex h-5 w-5 items-center justify-center">
        {Icon ? <Icon size={16} /> : null}
      </span>
      <span className="flex flex-1 flex-col min-w-0">
        <span className="truncate text-sm text-foreground">{item.title}</span>
        {item.subtitle ? (
          <span className="truncate text-xs text-muted-foreground">
            {item.subtitle}
          </span>
        ) : null}
      </span>
      {item.shortcut ? (
        <CommandShortcut>{item.shortcut}</CommandShortcut>
      ) : null}
    </CommandItem>
  );
}
