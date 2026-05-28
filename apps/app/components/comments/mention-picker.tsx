import * as React from "react";
import { Modal, Platform, Pressable, StyleSheet, View } from "react-native";
import { Calendar, FileText, User } from "lucide-react-native";
import { Text } from "@/components/ui/text";
import { useColorScheme } from "@/lib/useColorScheme";
import { useWorkspaceMembers } from "@/lib/hooks/use-workspace-members";
import { usePages } from "@/lib/hooks/use-pages";
import type { MentionKind, MentionSegment } from "@/lib/types/comments";

interface MentionPickerProps {
  open: boolean;
  query: string;
  workspaceId: string;
  onSelect: (segment: MentionSegment) => void;
  onClose: () => void;
}

interface PickerItem {
  key: string;
  kind: MentionKind;
  /** Display label (e.g. "Nate Isern", "My Project", "Today"). */
  label: string;
  /** Secondary text (email, page path, formatted date). */
  detail?: string;
  build: () => MentionSegment;
}

function formatDate(d: Date): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

function formatDisplayDate(d: Date): string {
  return d.toLocaleDateString(undefined, {
    weekday: "short",
    month: "short",
    day: "numeric",
  });
}

/**
 * Mention picker — autocomplete shown when the user types `@` inside an
 * editable surface (comment composer today; editor v2 wires it in later).
 *
 * Source data:
 *   - People: workspace members (via `useWorkspaceMembers`)
 *   - Pages: workspace pages (via `usePages`)
 *   - Dates: deterministic options (Today, Tomorrow, Next week) — natural
 *     language parsing lives outside the picker for now.
 *
 * Filtering is local; the lists are small enough that we don't need server
 * search yet. When the workspace grows past a few hundred entries, swap the
 * client-side filter for a debounced server query.
 */
export function MentionPicker({
  open,
  query,
  workspaceId,
  onSelect,
  onClose,
}: MentionPickerProps) {
  const { colors } = useColorScheme();
  const { data: members } = useWorkspaceMembers(workspaceId);
  const { data: pagesData } = usePages(workspaceId);

  const items = React.useMemo<PickerItem[]>(() => {
    const q = query.trim().toLowerCase();

    const people: PickerItem[] = (members ?? []).map((m) => {
      const name = m.user?.name
        ? [m.user.name.first, m.user.name.last].filter(Boolean).join(" ")
        : null;
      const label = name || m.user?.username || m.userId;
      const detail = m.user?.email ?? m.user?.username ?? undefined;
      return {
        key: `user:${m.userId}`,
        kind: "user",
        label,
        detail,
        build: (): MentionSegment => ({
          type: "mention",
          kind: "user",
          id: m.userId,
          originalText: `@${name || m.user?.username || m.userId}`,
        }),
      };
    });

    const pages: PickerItem[] = (pagesData?.pages ?? [])
      .filter((p) => !p.archived)
      .map((p) => {
        const title = p.title?.trim() || "Untitled";
        return {
          key: `page:${p._id}`,
          kind: "page",
          label: title,
          detail: p.icon ? `${p.icon} page` : "page",
          build: (): MentionSegment => ({
            type: "mention",
            kind: "page",
            id: p._id,
            originalText: `@${title}`,
          }),
        };
      });

    const today = new Date();
    const tomorrow = new Date();
    tomorrow.setDate(today.getDate() + 1);
    const nextWeek = new Date();
    nextWeek.setDate(today.getDate() + 7);

    const dates: PickerItem[] = [
      { label: "Today", d: today },
      { label: "Tomorrow", d: tomorrow },
      { label: "Next week", d: nextWeek },
    ].map(({ label, d }) => ({
      key: `date:${label}`,
      kind: "date",
      label,
      detail: formatDisplayDate(d),
      build: (): MentionSegment => ({
        type: "mention",
        kind: "date",
        date: formatDate(d),
        originalText: `@${label}`,
      }),
    }));

    const all = [...people, ...pages, ...dates];
    if (!q) return all.slice(0, 12);
    return all
      .filter((item) => {
        return (
          item.label.toLowerCase().includes(q) ||
          (item.detail && item.detail.toLowerCase().includes(q))
        );
      })
      .slice(0, 12);
  }, [members, pagesData?.pages, query]);

  if (!open) return null;

  const renderIcon = (kind: MentionKind) => {
    if (kind === "user") return <User size={16} color={colors.foreground} />;
    if (kind === "page") return <FileText size={16} color={colors.foreground} />;
    return <Calendar size={16} color={colors.foreground} />;
  };

  const list = (
    <View className="w-72 rounded-2xl border border-border bg-popover py-1 shadow-lg">
      <View className="px-3 pt-2 pb-1">
        <Text className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
          Mention
        </Text>
      </View>
      <View className="max-h-72">
        {items.length === 0 ? (
          <View className="px-3 py-3">
            <Text className="text-sm text-muted-foreground">
              No matches for &quot;{query}&quot;
            </Text>
          </View>
        ) : (
          items.map((item) => (
            <Pressable
              key={item.key}
              onPress={() => onSelect(item.build())}
              className="flex-row items-center gap-3 px-3 py-2 hover:bg-muted active:bg-muted"
            >
              <View className="h-8 w-8 items-center justify-center rounded-md bg-muted">
                {renderIcon(item.kind)}
              </View>
              <View className="flex-1">
                <Text className="text-sm font-medium text-foreground" numberOfLines={1}>
                  {item.label}
                </Text>
                {item.detail ? (
                  <Text
                    className="text-xs text-muted-foreground"
                    numberOfLines={1}
                  >
                    {item.detail}
                  </Text>
                ) : null}
              </View>
            </Pressable>
          ))
        )}
      </View>
    </View>
  );

  if (Platform.OS === "web") {
    return (
      <View style={styles.webPopover} pointerEvents="box-none">
        <View style={styles.webPopoverInner} pointerEvents="auto">
          {list}
        </View>
      </View>
    );
  }

  return (
    <Modal visible={open} transparent animationType="fade" onRequestClose={onClose}>
      <Pressable
        style={StyleSheet.absoluteFill}
        className="bg-black/50"
        onPress={onClose}
      />
      <View className="absolute bottom-0 left-0 right-0 p-3">{list}</View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  webPopover: {
    position: "absolute",
    top: 0,
    left: 0,
    right: 0,
    zIndex: 50,
  },
  webPopoverInner: {
    position: "absolute",
    top: 0,
    left: 0,
  },
});
