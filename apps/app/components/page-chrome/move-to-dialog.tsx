import * as React from "react";
import { Platform, Pressable, ScrollView, TextInput, View } from "react-native";
import { Home, X } from "lucide-react-native";
import {
  Dialog,
  DialogContent,
  DialogTitle,
} from "@/components/ui/dialog";
import { Text } from "@/components/ui/text";
import { useColorScheme } from "@/lib/useColorScheme";
import { usePages, useUpdatePage } from "@/lib/hooks/use-pages";
import type { Page } from "@/lib/types/pages";
import { IconDisplay } from "./icon-display";

interface MoveToDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  page: Page;
}

/**
 * Page picker for the "Move to" action. Shows a flat search of every page
 * in the workspace, plus a "Move to root" option. Excludes the page itself
 * and (best-effort) its descendants — backend will reject any cycle the UI
 * misses.
 */
export function MoveToDialog({ open, onOpenChange, page }: MoveToDialogProps) {
  const { colors } = useColorScheme();
  const [query, setQuery] = React.useState("");
  const { data, isLoading } = usePages(page.workspaceId);
  const updatePage = useUpdatePage();

  const candidates = React.useMemo(() => {
    const all = data?.pages ?? [];
    const descendantIds = collectDescendantIds(all, page._id);
    descendantIds.add(page._id);
    const normalized = query.trim().toLowerCase();
    return all
      .filter((p) => !p.archived && !descendantIds.has(p._id))
      .filter((p) => {
        if (!normalized) return true;
        const title = (p.title || "Untitled").toLowerCase();
        return title.includes(normalized);
      })
      .slice(0, 100);
  }, [data?.pages, page._id, query]);

  const handleMove = React.useCallback(
    (parentId: string | null) => {
      updatePage.mutate({ id: page._id, parentId });
      onOpenChange(false);
    },
    [updatePage, page._id, onOpenChange],
  );

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-md gap-3 p-4" showCloseButton={false}>
        <View className="flex-row items-center justify-between">
          <DialogTitle>Move page</DialogTitle>
          <Pressable
            onPress={() => onOpenChange(false)}
            className="h-8 w-8 items-center justify-center rounded-md hover:bg-muted"
            accessibilityLabel="Close"
          >
            <X size={16} className="text-muted-foreground" />
          </Pressable>
        </View>

        <View className="flex-row items-center gap-2 rounded-lg border border-border px-3 py-1.5">
          <TextInput
            value={query}
            onChangeText={setQuery}
            placeholder="Search pages…"
            className="flex-1 text-sm text-foreground"
            autoCorrect={false}
            autoCapitalize="none"
            style={
              Platform.OS === "web"
                ? { outlineWidth: 0, borderWidth: 0, padding: 0 }
                : undefined
            }
          />
        </View>

        <ScrollView className="max-h-80">
          <Pressable
            onPress={() => handleMove(null)}
            className="flex-row items-center gap-2 rounded-md px-2 py-2 hover:bg-muted"
            accessibilityLabel="Move to root"
          >
            <Home size={14} color={colors.mutedForeground} />
            <Text className="text-sm text-foreground">Move to root</Text>
          </Pressable>
          {isLoading ? (
            <Text className="px-2 py-2 text-sm text-muted-foreground">
              Loading…
            </Text>
          ) : candidates.length === 0 ? (
            <Text className="px-2 py-4 text-center text-sm text-muted-foreground">
              No pages match “{query}”.
            </Text>
          ) : (
            candidates.map((p) => (
              <Pressable
                key={p._id}
                onPress={() => handleMove(p._id)}
                className="flex-row items-center gap-2 rounded-md px-2 py-2 hover:bg-muted"
                accessibilityLabel={`Move under ${p.title || "Untitled"}`}
              >
                <View className="h-4 w-4 items-center justify-center">
                  <IconDisplay value={p.icon} size={14} showPlaceholder />
                </View>
                <Text className="flex-1 text-sm text-foreground" numberOfLines={1}>
                  {p.title.trim() || "Untitled"}
                </Text>
              </Pressable>
            ))
          )}
        </ScrollView>
      </DialogContent>
    </Dialog>
  );
}

/**
 * Returns the set of descendant page ids under a root, traversed iteratively
 * through the flat workspace list. Defensive against accidental cycles via
 * a `seen` set.
 */
function collectDescendantIds(pages: Page[], rootId: string): Set<string> {
  const childrenByParent = new Map<string, Page[]>();
  for (const p of pages) {
    if (p.parentId) {
      const list = childrenByParent.get(p.parentId) ?? [];
      list.push(p);
      childrenByParent.set(p.parentId, list);
    }
  }
  const collected = new Set<string>();
  let frontier: string[] = [rootId];
  while (frontier.length > 0) {
    const next: string[] = [];
    for (const id of frontier) {
      const kids = childrenByParent.get(id) ?? [];
      for (const k of kids) {
        if (collected.has(k._id)) continue;
        collected.add(k._id);
        next.push(k._id);
      }
    }
    frontier = next;
  }
  return collected;
}
