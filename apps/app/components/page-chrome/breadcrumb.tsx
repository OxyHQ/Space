import * as React from "react";
import { Pressable, ScrollView, View } from "react-native";
import { ChevronRight } from "lucide-react-native";
import { useRouter } from "expo-router";
import { Text } from "@/components/ui/text";
import { useColorScheme } from "@/lib/useColorScheme";
import { useBreadcrumb } from "@/lib/hooks/use-pages";
import { useWorkspace } from "@/lib/hooks/use-workspaces";
import { IconDisplay } from "./icon-display";
import type { BreadcrumbEntry } from "@/lib/types/pages";

interface BreadcrumbProps {
  pageId: string;
  workspaceId: string;
  /** Maximum middle crumbs to render before collapsing with `…`. */
  maxItems?: number;
}

/**
 * Workspace › Parent › … › Current. Each crumb is clickable (the last one
 * is the current page — disabled). Long chains collapse the middle into
 * `…` to keep the bar from overflowing on narrow viewports.
 */
export function Breadcrumb({ pageId, workspaceId, maxItems = 4 }: BreadcrumbProps) {
  const router = useRouter();
  const { colors } = useColorScheme();
  const { data: crumb } = useBreadcrumb(pageId);
  const { data: workspace } = useWorkspace(workspaceId);

  const entries: BreadcrumbEntry[] = crumb?.breadcrumb ?? [];
  // Drop the trailing self entry from the clickable list; it renders as the
  // active label.
  const ancestors = entries.slice(0, -1);
  const current = entries[entries.length - 1];

  const condensed = condenseAncestors(ancestors, maxItems);

  return (
    <ScrollView
      horizontal
      showsHorizontalScrollIndicator={false}
      contentContainerStyle={{ alignItems: "center" }}
      keyboardShouldPersistTaps="handled"
    >
      <Pressable
        onPress={() => router.push("/(app)")}
        accessibilityLabel="Workspace home"
        className="rounded-md px-1.5 py-1 hover:bg-muted"
      >
        <Text className="text-xs text-muted-foreground">
          {workspace?.name ?? "Workspace"}
        </Text>
      </Pressable>

      {condensed.map((entry, idx) => (
        <React.Fragment key={`${entry.kind}-${idx}`}>
          <ChevronRight
            size={12}
            color={colors.mutedForeground}
            style={{ marginHorizontal: 2 }}
          />
          {entry.kind === "page" ? (
            <Pressable
              onPress={() => router.push(`/p/${entry.page.id}`)}
              className="flex-row items-center rounded-md px-1.5 py-1 hover:bg-muted"
              accessibilityLabel={entry.page.title || "Untitled"}
            >
              {entry.page.icon ? (
                <View className="mr-1">
                  <IconDisplay value={entry.page.icon} size={14} />
                </View>
              ) : null}
              <Text className="text-xs text-muted-foreground" numberOfLines={1}>
                {entry.page.title.trim() || "Untitled"}
              </Text>
            </Pressable>
          ) : (
            <View className="px-1.5 py-1">
              <Text className="text-xs text-muted-foreground">…</Text>
            </View>
          )}
        </React.Fragment>
      ))}

      {current ? (
        <React.Fragment>
          <ChevronRight
            size={12}
            color={colors.mutedForeground}
            style={{ marginHorizontal: 2 }}
          />
          <View className="flex-row items-center rounded-md px-1.5 py-1">
            {current.icon ? (
              <View className="mr-1">
                <IconDisplay value={current.icon} size={14} />
              </View>
            ) : null}
            <Text
              className="text-xs font-medium text-foreground"
              numberOfLines={1}
            >
              {current.title.trim() || "Untitled"}
            </Text>
          </View>
        </React.Fragment>
      ) : null}
    </ScrollView>
  );
}

type CondensedEntry =
  | { kind: "page"; page: BreadcrumbEntry }
  | { kind: "ellipsis" };

/**
 * Notion-like middle truncation: keep the first ancestor and the last two,
 * collapse anything in between as `…`. When the chain is short, return
 * everything as-is.
 */
function condenseAncestors(
  ancestors: BreadcrumbEntry[],
  maxItems: number,
): CondensedEntry[] {
  if (ancestors.length <= maxItems) {
    return ancestors.map((page) => ({ kind: "page" as const, page }));
  }
  const head = ancestors[0];
  const tail = ancestors.slice(-2);
  return [
    { kind: "page" as const, page: head },
    { kind: "ellipsis" as const },
    ...tail.map((page) => ({ kind: "page" as const, page })),
  ];
}
