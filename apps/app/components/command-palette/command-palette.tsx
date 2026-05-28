import * as React from 'react';
import {
  Modal,
  View,
  Pressable,
  ScrollView,
  TextInput,
  KeyboardAvoidingView,
  Platform,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useRouter } from 'expo-router';
import { Search, FileText, Clock, X } from 'lucide-react-native';
import { Text } from '@/components/ui/text';
import { useUIStore } from '@/lib/stores/ui-store';
import { useColorScheme } from '@/lib/useColorScheme';
import { fuzzyFilter } from '@/lib/fuzzy';
import { usePaletteData } from './use-palette-data';
import type { PageItem, MemberItem, CommandItem } from './types';

/**
 * Native command palette — bottom sheet variant with the same item set as the
 * web modal. The web build resolves `command-palette.web.tsx`; this file is
 * the iOS/Android implementation.
 */
export function CommandPalette() {
  const open = useUIStore((s) => s.commandPaletteOpen);
  const setOpen = useUIStore((s) => s.setCommandPaletteOpen);
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const { colors } = useColorScheme();

  const [query, setQuery] = React.useState('');

  React.useEffect(() => {
    if (!open) setQuery('');
  }, [open]);

  const { recents, pages, members, commands } = usePaletteData({ query });

  const filteredPages = React.useMemo(
    () =>
      fuzzyFilter<PageItem>(pages, query, [
        (p) => p.title,
        (p) => p.breadcrumb ?? null,
      ]).slice(0, 30),
    [pages, query],
  );
  const filteredMembers = React.useMemo(
    () =>
      fuzzyFilter<MemberItem>(members, query, [
        (m) => m.title,
        (m) => m.email ?? null,
        (m) => m.username ?? null,
      ]).slice(0, 15),
    [members, query],
  );
  const filteredCommands = React.useMemo(
    () =>
      fuzzyFilter<CommandItem>(commands, query, [
        (c) => c.title,
        (c) => c.searchValue,
      ]),
    [commands, query],
  );

  const openPage = React.useCallback(
    (pageId: string) => {
      setOpen(false);
      router.push(`/p/${pageId}`);
    },
    [router, setOpen],
  );

  const hasResults =
    recents.length > 0 ||
    filteredPages.length > 0 ||
    filteredMembers.length > 0 ||
    filteredCommands.length > 0;

  return (
    <Modal
      visible={open}
      transparent
      animationType="slide"
      onRequestClose={() => setOpen(false)}
      statusBarTranslucent
    >
      <Pressable
        className="flex-1 bg-black/50"
        onPress={() => setOpen(false)}
      >
        <KeyboardAvoidingView
          behavior={Platform.OS === 'ios' ? 'padding' : undefined}
          className="flex-1 justify-end"
        >
          <Pressable
            onPress={(e) => e.stopPropagation()}
            className="rounded-t-3xl bg-background"
            style={{ maxHeight: '85%', paddingBottom: insets.bottom }}
          >
            {/* Drag handle */}
            <View className="items-center pt-2 pb-1">
              <View className="h-1 w-12 rounded-full bg-muted-foreground/30" />
            </View>

            {/* Search input */}
            <View className="flex-row items-center gap-2 px-4 pb-3 pt-1">
              <Search size={16} color={colors.mutedForeground} />
              <TextInput
                autoFocus
                value={query}
                onChangeText={setQuery}
                placeholder="Search pages, people and commands…"
                placeholderTextColor={colors.mutedForeground}
                className="flex-1 text-base text-foreground"
                returnKeyType="search"
              />
              <Pressable
                onPress={() => setOpen(false)}
                accessibilityLabel="Close search"
                className="h-8 w-8 items-center justify-center rounded-full"
              >
                <X size={16} color={colors.mutedForeground} />
              </Pressable>
            </View>

            <View className="h-px bg-border" />

            <ScrollView
              className="flex-1"
              keyboardShouldPersistTaps="handled"
              showsVerticalScrollIndicator={false}
            >
              {!hasResults ? (
                <View className="px-4 py-10">
                  <Text className="text-center text-sm text-muted-foreground">
                    No results.
                  </Text>
                </View>
              ) : null}

              {recents.length > 0 ? (
                <Group title="Recent">
                  {recents.map((item) => (
                    <PageRow
                      key={item.id}
                      item={item}
                      onPress={openPage}
                      leadingIcon={<Clock size={14} color={colors.mutedForeground} />}
                    />
                  ))}
                </Group>
              ) : null}

              {filteredPages.length > 0 ? (
                <Group title="Pages">
                  {filteredPages.map(({ item }) => (
                    <PageRow key={item.id} item={item} onPress={openPage} />
                  ))}
                </Group>
              ) : null}

              {filteredMembers.length > 0 ? (
                <Group title="People">
                  {filteredMembers.map(({ item }) => (
                    <MemberRow key={item.id} item={item} />
                  ))}
                </Group>
              ) : null}

              {filteredCommands.length > 0 ? (
                <Group title="Commands">
                  {filteredCommands.map(({ item }) => (
                    <CommandRow key={item.id} item={item} />
                  ))}
                </Group>
              ) : null}

              <View style={{ height: 16 }} />
            </ScrollView>
          </Pressable>
        </KeyboardAvoidingView>
      </Pressable>
    </Modal>
  );
}

function Group({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <View className="px-2 py-1">
      <View className="px-3 pt-3 pb-1">
        <Text className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
          {title}
        </Text>
      </View>
      <View>{children}</View>
    </View>
  );
}

interface PageRowProps {
  item: PageItem;
  onPress: (id: string) => void;
  leadingIcon?: React.ReactNode;
}

function PageRow({ item, onPress, leadingIcon }: PageRowProps) {
  const { colors } = useColorScheme();
  return (
    <Pressable
      onPress={() => onPress(item.pageId)}
      accessibilityRole="button"
      className="flex-row items-center gap-3 rounded-lg px-3 py-2 active:bg-muted"
    >
      <View className="h-6 w-6 items-center justify-center">
        {item.icon ? (
          <Text className="text-base">{item.icon}</Text>
        ) : (
          leadingIcon ?? <FileText size={14} color={colors.mutedForeground} />
        )}
      </View>
      <View className="flex-1">
        <Text className="text-sm text-foreground" numberOfLines={1}>
          {item.title}
        </Text>
        {item.subtitle ? (
          <Text
            className="text-xs text-muted-foreground"
            numberOfLines={1}
          >
            {item.subtitle}
          </Text>
        ) : null}
      </View>
    </Pressable>
  );
}

function MemberRow({ item }: { item: MemberItem }) {
  const initial = (item.title?.[0] ?? '?').toUpperCase();
  return (
    <Pressable
      accessibilityRole="button"
      className="flex-row items-center gap-3 rounded-lg px-3 py-2 active:bg-muted"
    >
      <View className="h-6 w-6 items-center justify-center rounded-full bg-muted">
        <Text className="text-[10px] font-semibold text-muted-foreground">
          {initial}
        </Text>
      </View>
      <View className="flex-1">
        <Text className="text-sm text-foreground" numberOfLines={1}>
          {item.title}
        </Text>
        {item.subtitle ? (
          <Text
            className="text-xs text-muted-foreground"
            numberOfLines={1}
          >
            {item.subtitle}
          </Text>
        ) : null}
      </View>
    </Pressable>
  );
}

function CommandRow({ item }: { item: CommandItem }) {
  const { colors } = useColorScheme();
  const Icon = item.icon;
  return (
    <Pressable
      onPress={() => item.onSelect()}
      accessibilityRole="button"
      className="flex-row items-center gap-3 rounded-lg px-3 py-2 active:bg-muted"
    >
      <View className="h-6 w-6 items-center justify-center">
        {Icon ? <Icon size={16} color={colors.mutedForeground} /> : null}
      </View>
      <View className="flex-1">
        <Text className="text-sm text-foreground" numberOfLines={1}>
          {item.title}
        </Text>
        {item.subtitle ? (
          <Text className="text-xs text-muted-foreground" numberOfLines={1}>
            {item.subtitle}
          </Text>
        ) : null}
      </View>
    </Pressable>
  );
}
