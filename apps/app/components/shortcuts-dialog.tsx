import * as React from 'react';
import { Platform, View } from 'react-native';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Text } from '@/components/ui/text';
import { useUIStore } from '@/lib/stores/ui-store';

interface Shortcut {
  label: string;
  keys: string[];
}

const SHORTCUTS: Array<{ section: string; items: Shortcut[] }> = [
  {
    section: 'Navigation',
    items: [
      { label: 'Open search & command palette', keys: ['Mod', 'K'] },
      { label: 'Create new page', keys: ['Mod', 'N'] },
      { label: 'Toggle sidebar', keys: ['Mod', '\\'] },
      { label: 'Show keyboard shortcuts', keys: ['Mod', '/'] },
    ],
  },
  {
    section: 'In the palette',
    items: [
      { label: 'Move selection up / down', keys: ['↑', '↓'] },
      { label: 'Open selected result', keys: ['Enter'] },
      { label: 'Open in new tab', keys: ['Mod', 'Enter'] },
      { label: 'Close', keys: ['Esc'] },
    ],
  },
];

/**
 * Cross-platform shortcuts dialog. `Mod` renders as `⌘` on macOS and `Ctrl`
 * elsewhere.
 */
export function ShortcutsDialog() {
  const open = useUIStore((s) => s.shortcutsDialogOpen);
  const setOpen = useUIStore((s) => s.setShortcutsDialogOpen);
  const modLabel = useModifierLabel();

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>Keyboard shortcuts</DialogTitle>
          <DialogDescription>
            Move faster in Oxy Station with these shortcuts.
          </DialogDescription>
        </DialogHeader>
        <View className="gap-5">
          {SHORTCUTS.map((group) => (
            <View key={group.section} className="gap-2">
              <Text className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
                {group.section}
              </Text>
              <View className="gap-1">
                {group.items.map((sc) => (
                  <View
                    key={sc.label}
                    className="flex-row items-center justify-between gap-3"
                  >
                    <Text className="flex-1 text-sm text-foreground">
                      {sc.label}
                    </Text>
                    <View className="flex-row items-center gap-1">
                      {sc.keys.map((k) => (
                        <KeyCap key={`${sc.label}-${k}`}>
                          {k === 'Mod' ? modLabel : k}
                        </KeyCap>
                      ))}
                    </View>
                  </View>
                ))}
              </View>
            </View>
          ))}
        </View>
      </DialogContent>
    </Dialog>
  );
}

function KeyCap({ children }: { children: React.ReactNode }) {
  return (
    <View className="min-w-7 rounded-md border border-border bg-muted px-1.5 py-0.5">
      <Text className="text-center text-[11px] font-medium text-foreground">
        {children}
      </Text>
    </View>
  );
}

function useModifierLabel(): string {
  return React.useMemo(() => {
    if (Platform.OS === 'web' && typeof navigator !== 'undefined') {
      const platform = navigator.platform || '';
      const userAgent = navigator.userAgent || '';
      const isMac = /Mac|iPhone|iPad/i.test(platform) || /Mac/i.test(userAgent);
      return isMac ? '⌘' : 'Ctrl';
    }
    return Platform.OS === 'ios' ? '⌘' : 'Ctrl';
  }, []);
}
