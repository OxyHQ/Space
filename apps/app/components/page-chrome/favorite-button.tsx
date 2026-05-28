import * as React from "react";
import { Pressable } from "react-native";
import { Star } from "lucide-react-native";
import { useColorScheme } from "@/lib/useColorScheme";
import { useUpdatePage } from "@/lib/hooks/use-pages";

interface FavoriteButtonProps {
  pageId: string;
  favorited: boolean;
}

/**
 * Star icon that toggles `Page.favorited`. Fills when active. Reads its own
 * UI state from the prop so it can be driven by either the page detail or
 * the actions menu (single source of truth: the page itself).
 */
export function FavoriteButton({ pageId, favorited }: FavoriteButtonProps) {
  const { colors } = useColorScheme();
  const updatePage = useUpdatePage();

  const handleToggle = React.useCallback(() => {
    updatePage.mutate({ id: pageId, favorited: !favorited });
  }, [updatePage, pageId, favorited]);

  return (
    <Pressable
      onPress={handleToggle}
      accessibilityLabel={favorited ? "Unfavorite" : "Favorite"}
      className="h-9 w-9 items-center justify-center rounded-lg hover:bg-muted"
    >
      <Star
        size={16}
        color={favorited ? "#f59e0b" : colors.foreground}
        fill={favorited ? "#f59e0b" : "transparent"}
      />
    </Pressable>
  );
}
