import * as React from "react";
import { Platform, Pressable, TextInput, View } from "react-native";
import { Image as ExpoImage } from "expo-image";
import { useQuery } from "@tanstack/react-query";
import { Link2 } from "lucide-react-native";
import { Text } from "@/components/ui/text";
import { useColorScheme } from "@/lib/useColorScheme";
import { fetchEmbedPreview } from "@/lib/uploads/upload-file";
import type { BlockComponentProps } from "./types";

/**
 * Bookmark block — once a URL is set, fetches OG metadata from
 * `/embed/preview` (via React Query so callers benefit from the cache) and
 * stores the title/description/image/favicon on `content` so the card
 * renders without re-fetching on every paint.
 */
export function BookmarkBlock({ block, onChangeContent }: BlockComponentProps) {
  const { colors } = useColorScheme();
  const url = typeof block.content.url === "string" ? block.content.url : "";
  const title = typeof block.content.title === "string" ? block.content.title : "";
  const description =
    typeof block.content.description === "string" ? block.content.description : "";
  const image = typeof block.content.image === "string" ? block.content.image : "";
  const favicon =
    typeof block.content.favicon === "string" ? block.content.favicon : "";

  // Reset the draft when the block id changes (effectively "key-based reset").
  const [urlDraft, setUrlDraft] = React.useState(url);
  const lastBlockId = React.useRef(block._id);
  if (lastBlockId.current !== block._id) {
    lastBlockId.current = block._id;
    setUrlDraft(url);
  }

  const hasMetadata = Boolean(title || description || image);
  const preview = useQuery({
    queryKey: ["embed-preview", url],
    queryFn: () => fetchEmbedPreview(url),
    enabled: Boolean(url) && !hasMetadata,
    staleTime: 1000 * 60 * 30,
  });

  // Persist fetched metadata back onto the block's content — runs once per
  // (url, fetch result) pair. Using onSuccess via TanStack's data field via
  // a single declarative check keeps this idempotent.
  const fetched = preview.data;
  const lastWrittenUrl = React.useRef<string | null>(hasMetadata ? url : null);
  if (
    fetched &&
    lastWrittenUrl.current !== fetched.url &&
    !hasMetadata
  ) {
    lastWrittenUrl.current = fetched.url;
    onChangeContent({
      ...block.content,
      url,
      title: fetched.title,
      description: fetched.description,
      image: fetched.image,
      favicon: fetched.favicon,
    });
  }

  const commitUrl = (next: string) => {
    const trimmed = next.trim();
    if (trimmed === url) return;
    lastWrittenUrl.current = null;
    onChangeContent({
      ...block.content,
      url: trimmed,
      title: undefined,
      description: undefined,
      image: undefined,
      favicon: undefined,
    });
  };

  if (!url) {
    return (
      <View className="rounded-lg border border-dashed border-border bg-muted/40 px-3 py-4 gap-3">
        <View className="flex-row items-center gap-2">
          <Link2 size={16} color={colors.mutedForeground} />
          <Text className="text-sm text-muted-foreground">Bookmark</Text>
        </View>
        <TextInput
          value={urlDraft}
          onChangeText={setUrlDraft}
          onBlur={() => commitUrl(urlDraft)}
          placeholder="Paste any URL"
          placeholderTextColor={colors.mutedForeground}
          className="rounded-md bg-background px-2 py-1.5 text-sm text-foreground border border-input"
        />
      </View>
    );
  }

  const loading = preview.isFetching && !title;

  const cardBody = (
    <View className="flex-row gap-3 rounded-lg border border-border bg-muted/30 overflow-hidden">
      <View className="flex-1 px-3 py-2 gap-1">
        <Text className="text-sm font-medium text-foreground" numberOfLines={2}>
          {loading ? "Loading…" : title || url}
        </Text>
        {description ? (
          <Text className="text-xs text-muted-foreground" numberOfLines={2}>
            {description}
          </Text>
        ) : null}
        <View className="flex-row items-center gap-1 mt-1">
          {favicon ? (
            <ExpoImage
              source={{ uri: favicon }}
              style={{ width: 12, height: 12 }}
              contentFit="contain"
            />
          ) : null}
          <Text className="text-xs text-muted-foreground" numberOfLines={1}>
            {url}
          </Text>
        </View>
      </View>
      {image ? (
        <ExpoImage
          source={{ uri: image }}
          style={{ width: 96, height: 80 }}
          contentFit="cover"
        />
      ) : null}
    </View>
  );

  if (Platform.OS === "web") {
    return (
      <a
        href={url}
        target="_blank"
        rel="noreferrer"
        style={{ textDecoration: "none" }}
      >
        {cardBody}
      </a>
    );
  }

  return (
    <Pressable
      onPress={() =>
        import("expo-web-browser").then((mod) => mod.openBrowserAsync(url))
      }
    >
      {cardBody}
    </Pressable>
  );
}
