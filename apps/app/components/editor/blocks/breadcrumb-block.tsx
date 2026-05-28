import * as React from "react";
import { Pressable, View } from "react-native";
import { router } from "expo-router";
import { useQuery } from "@tanstack/react-query";
import { ChevronRight } from "lucide-react-native";
import { Text } from "@/components/ui/text";
import { useColorScheme } from "@/lib/useColorScheme";
import apiClient from "@/lib/api/client";
import { API_ROUTES } from "@/lib/api/routes";
import type { Page, PageResponse } from "@/lib/types/pages";
import type { BlockComponentProps } from "./types";

interface BreadcrumbTrail {
  pages: Page[];
}

async function fetchTrail(pageId: string): Promise<BreadcrumbTrail> {
  const visited = new Set<string>();
  const trail: Page[] = [];
  let cursor: string | null = pageId;
  while (cursor !== null && !visited.has(cursor)) {
    visited.add(cursor);
    const res: { data: PageResponse } = await apiClient.get<PageResponse>(
      API_ROUTES.pages.get(cursor),
    );
    trail.unshift(res.data.page);
    cursor = res.data.page.parentId;
  }
  return { pages: trail };
}

/**
 * Breadcrumb block — renders the path from the workspace root to the current
 * page. Auto-derived: no content needed, just the block's `pageId`. Walks the
 * `parentId` chain once and caches via React Query.
 */
export function BreadcrumbBlock({ block }: BlockComponentProps) {
  const { colors } = useColorScheme();
  const pageId = block.pageId;
  const trail = useQuery({
    queryKey: ["breadcrumb", pageId],
    queryFn: () => fetchTrail(pageId),
    enabled: Boolean(pageId),
    staleTime: 1000 * 30,
  });

  if (!trail.data) {
    return (
      <View className="my-1">
        <Text className="text-xs text-muted-foreground">Loading path…</Text>
      </View>
    );
  }

  return (
    <View className="flex-row items-center flex-wrap gap-1 my-1">
      {trail.data.pages.map((p, idx) => (
        <View key={p._id} className="flex-row items-center gap-1">
          <Pressable onPress={() => router.push(`/p/${p._id}`)}>
            <Text className="text-xs text-muted-foreground hover:text-foreground">
              {p.title || "Untitled"}
            </Text>
          </Pressable>
          {idx < trail.data.pages.length - 1 ? (
            <ChevronRight size={12} color={colors.mutedForeground} />
          ) : null}
        </View>
      ))}
    </View>
  );
}
