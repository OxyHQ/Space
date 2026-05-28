import * as React from 'react';
import { View, Pressable, ActivityIndicator } from 'react-native';
import { ChevronDown, ChevronRight, Plus } from 'lucide-react-native';
import { Text } from '@/components/ui/text';
import { useColorScheme } from '@/lib/useColorScheme';
import { useUIStore, type SidebarSectionKey } from '@/lib/stores/ui-store';

interface SidebarSectionProps {
  /** Persist key — controls collapsed state in the UI store. */
  sectionKey?: SidebarSectionKey;
  /** Section title (rendered as small uppercase text). */
  title: string;
  /** Inline action shown on hover (web) or always (native). */
  onAdd?: () => void;
  adding?: boolean;
  /** Whether to render the chevron toggle. Defaults to true. */
  collapsible?: boolean;
  /** Children rendered when expanded. */
  children: React.ReactNode;
  /** Optional indicator (e.g., unread count badge) rendered before the chevron. */
  trailing?: React.ReactNode;
}

/**
 * Reusable Notion-style sidebar section: small uppercase heading + collapsible
 * body. Collapsed state persists per-section in the UI store.
 *
 * When `sectionKey` is omitted, the section is always expanded (used for
 * sections that don't need persistence like "Recents").
 */
export function SidebarSection({
  sectionKey,
  title,
  onAdd,
  adding,
  collapsible = true,
  children,
  trailing,
}: SidebarSectionProps) {
  const { colors } = useColorScheme();
  const collapsed = useUIStore((s) =>
    sectionKey ? s.sectionCollapsed[sectionKey] : false,
  );
  const toggle = useUIStore((s) => s.toggleSection);

  const isOpen = !collapsed;

  const handleToggle = React.useCallback(() => {
    if (!collapsible || !sectionKey) return;
    toggle(sectionKey);
  }, [collapsible, sectionKey, toggle]);

  return (
    <View className="py-1">
      <View className="group/section flex-row items-center px-2">
        <Pressable
          onPress={handleToggle}
          accessibilityLabel={`${isOpen ? 'Collapse' : 'Expand'} ${title}`}
          accessibilityRole="button"
          disabled={!collapsible || !sectionKey}
          className="flex-1 flex-row items-center gap-1 rounded-md px-1 py-1 hover:bg-muted/50"
        >
          {collapsible && sectionKey ? (
            isOpen ? (
              <ChevronDown size={10} color={colors.mutedForeground} />
            ) : (
              <ChevronRight size={10} color={colors.mutedForeground} />
            )
          ) : (
            <View style={{ width: 10, height: 10 }} />
          )}
          <Text className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
            {title}
          </Text>
        </Pressable>
        {trailing ? <View className="mr-1">{trailing}</View> : null}
        {onAdd ? (
          <Pressable
            onPress={onAdd}
            accessibilityLabel={`Add to ${title}`}
            accessibilityRole="button"
            disabled={adding}
            className="h-6 w-6 items-center justify-center rounded-md hover:bg-muted"
          >
            {adding ? (
              <ActivityIndicator size="small" color={colors.mutedForeground} />
            ) : (
              <Plus size={12} color={colors.mutedForeground} />
            )}
          </Pressable>
        ) : null}
      </View>
      {isOpen ? <View className="mt-0.5">{children}</View> : null}
    </View>
  );
}
