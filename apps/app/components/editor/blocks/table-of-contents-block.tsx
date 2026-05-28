import * as React from "react";
import { Pressable, View } from "react-native";
import { useQuery } from "@tanstack/react-query";
import { List as ListIcon } from "lucide-react-native";
import { Text } from "@/components/ui/text";
import { useColorScheme } from "@/lib/useColorScheme";
import apiClient from "@/lib/api/client";
import { API_ROUTES } from "@/lib/api/routes";
import { queryKeys } from "@/lib/hooks/query-keys";
import type { BlockComponentProps } from "./types";
import type { BlocksListResponse } from "@/lib/types/pages";

interface HeadingItem {
  id: string;
  text: string;
  depth: 1 | 2 | 3;
}

/**
 * Auto-derived table of contents — scans the current page's blocks for
 * heading_1/_2/_3 and renders them as a clickable list. Reads from the
 * same `useBlocks` query the editor uses, so it stays in sync without an
 * extra round-trip.
 */
export function TableOfContentsBlock({ block }: BlockComponentProps) {
  const { colors } = useColorScheme();
  const pageId = block.pageId;

  const blocks = useQuery<BlocksListResponse>({
    queryKey: queryKeys.blocks.list(pageId),
    queryFn: async () => {
      const res = await apiClient.get(API_ROUTES.pages.blocks(pageId));
      return res.data;
    },
    enabled: Boolean(pageId),
    staleTime: 1000 * 5,
  });

  const headings = React.useMemo<HeadingItem[]>(() => {
    if (!blocks.data) return [];
    const out: HeadingItem[] = [];
    for (const b of blocks.data.blocks) {
      if (
        b.type === "heading_1" ||
        b.type === "heading_2" ||
        b.type === "heading_3"
      ) {
        const text = typeof b.content.text === "string" ? b.content.text : "";
        if (!text.trim()) continue;
        const depth = b.type === "heading_1" ? 1 : b.type === "heading_2" ? 2 : 3;
        out.push({ id: b._id, text, depth });
      }
    }
    return out;
  }, [blocks.data]);

  if (headings.length === 0) {
    return (
      <View className="rounded-md border border-dashed border-border bg-muted/30 px-3 py-2 my-1">
        <View className="flex-row items-center gap-2">
          <ListIcon size={14} color={colors.mutedForeground} />
          <Text className="text-xs text-muted-foreground">
            Add headings to populate the table of contents.
          </Text>
        </View>
      </View>
    );
  }

  return (
    <View className="my-1 gap-0.5">
      {headings.map((h) => (
        <Pressable
          key={h.id}
          onPress={() => {
            // Web: scroll the heading into view via anchor convention.
            if (typeof document !== "undefined") {
              const el = document.querySelector(`[data-block-id="${h.id}"]`);
              if (el && el instanceof HTMLElement) {
                el.scrollIntoView({ behavior: "smooth", block: "start" });
              }
            }
          }}
          style={{ paddingLeft: (h.depth - 1) * 12 }}
          className="py-0.5"
        >
          <Text
            className="text-sm text-muted-foreground hover:text-foreground"
            numberOfLines={1}
          >
            {h.text}
          </Text>
        </Pressable>
      ))}
    </View>
  );
}
