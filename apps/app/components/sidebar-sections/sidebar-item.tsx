import * as React from 'react';
import { Pressable, View } from 'react-native';
import type { LucideIcon } from 'lucide-react-native';
import { Text } from '@/components/ui/text';
import { useColorScheme } from '@/lib/useColorScheme';

interface SidebarItemProps {
  icon: LucideIcon;
  label: string;
  onPress: () => void;
  isActive?: boolean;
  /** Optional right-side text (e.g. "⌘K") or badge node. */
  trailing?: React.ReactNode;
  accessibilityLabel?: string;
}

/**
 * Top-level sidebar link row used by static surfaces (Search, Inbox,
 * Settings, Trash). Mirrors the look of a page row but without the indent /
 * chevron / hover actions.
 */
export const SidebarItem = React.memo(function SidebarItem({
  icon: Icon,
  label,
  onPress,
  isActive,
  trailing,
  accessibilityLabel,
}: SidebarItemProps) {
  const { colors } = useColorScheme();
  return (
    <Pressable
      onPress={onPress}
      accessibilityLabel={accessibilityLabel ?? label}
      accessibilityRole="button"
      className={
        isActive
          ? 'flex-row items-center bg-muted px-3 py-1.5 rounded-md'
          : 'flex-row items-center px-3 py-1.5 rounded-md hover:bg-muted/60 active:bg-muted/60'
      }
    >
      <View className="h-5 w-5 items-center justify-center">
        <Icon size={14} color={colors.mutedForeground} />
      </View>
      <Text
        className={
          isActive
            ? 'ml-2 flex-1 text-sm font-medium text-foreground'
            : 'ml-2 flex-1 text-sm text-foreground'
        }
        numberOfLines={1}
      >
        {label}
      </Text>
      {trailing ? <View className="ml-2">{trailing}</View> : null}
    </Pressable>
  );
});
