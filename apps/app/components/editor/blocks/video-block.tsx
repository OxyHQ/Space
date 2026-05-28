import * as React from "react";
import { Platform, Pressable, TextInput, View } from "react-native";
import { Video as VideoIcon } from "lucide-react-native";
import { Text } from "@/components/ui/text";
import { useColorScheme } from "@/lib/useColorScheme";
import type { VideoSource } from "@/lib/types/pages";
import type { BlockComponentProps } from "./types";

function detectVideoSource(url: string): VideoSource {
  try {
    const u = new URL(url);
    const host = u.host.toLowerCase();
    if (host === "youtu.be" || host.endsWith("youtube.com")) return "youtube";
    if (host === "vimeo.com" || host.endsWith(".vimeo.com")) return "vimeo";
    if (host.endsWith("loom.com")) return "loom";
    return "other";
  } catch {
    return "other";
  }
}

function youtubeEmbed(url: string): string | null {
  try {
    const u = new URL(url);
    let id: string | undefined;
    if (u.host === "youtu.be") id = u.pathname.slice(1);
    else if (u.host.endsWith("youtube.com")) id = u.searchParams.get("v") ?? undefined;
    if (!id) return null;
    return `https://www.youtube.com/embed/${id}`;
  } catch {
    return null;
  }
}

function vimeoEmbed(url: string): string | null {
  try {
    const u = new URL(url);
    const id = u.pathname.split("/").filter(Boolean).pop();
    if (!id) return null;
    return `https://player.vimeo.com/video/${id}`;
  } catch {
    return null;
  }
}

function loomEmbed(url: string): string | null {
  try {
    const u = new URL(url);
    const id = u.pathname.split("/").filter(Boolean).pop();
    if (!id) return null;
    return `https://www.loom.com/embed/${id}`;
  } catch {
    return null;
  }
}

/**
 * Video block. Detects YouTube / Vimeo / Loom URLs and renders the standard
 * embed iframe. Uploaded video URLs (source='upload') render via a native
 * `<video>` element on web; on native we link out (RN doesn't ship a built-in
 * `<video>` widget — apps that need playback wire in `expo-av` separately).
 */
export function VideoBlock({ block, onChangeContent }: BlockComponentProps) {
  const { colors } = useColorScheme();
  const url = typeof block.content.url === "string" ? block.content.url : "";
  const caption =
    typeof block.content.caption === "string" ? block.content.caption : "";
  const [urlDraft, setUrlDraft] = React.useState(url);
  const lastBlockId = React.useRef(block._id);
  if (lastBlockId.current !== block._id) {
    lastBlockId.current = block._id;
    setUrlDraft(url);
  }

  const commitUrl = (next: string) => {
    const trimmed = next.trim();
    const source = detectVideoSource(trimmed);
    onChangeContent({ ...block.content, url: trimmed, source });
  };

  if (!url) {
    return (
      <View className="rounded-lg border border-dashed border-border bg-muted/40 px-3 py-4 gap-3">
        <View className="flex-row items-center gap-2">
          <VideoIcon size={16} color={colors.mutedForeground} />
          <Text className="text-sm text-muted-foreground">Video</Text>
        </View>
        <TextInput
          value={urlDraft}
          onChangeText={setUrlDraft}
          onBlur={() => commitUrl(urlDraft)}
          placeholder="Paste YouTube, Vimeo, Loom, or video URL"
          placeholderTextColor={colors.mutedForeground}
          className="rounded-md bg-background px-2 py-1.5 text-sm text-foreground border border-input"
        />
      </View>
    );
  }

  const source =
    (typeof block.content.source === "string" ? block.content.source : "") ||
    detectVideoSource(url);
  const embedUrl =
    source === "youtube"
      ? youtubeEmbed(url)
      : source === "vimeo"
        ? vimeoEmbed(url)
        : source === "loom"
          ? loomEmbed(url)
          : null;

  return (
    <View className="gap-1">
      {Platform.OS === "web" ? (
        embedUrl ? (
          <View style={{ aspectRatio: 16 / 9, width: "100%" }}>
            <iframe
              src={embedUrl}
              title="Embedded video"
              allowFullScreen
              allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture"
              style={{
                border: 0,
                width: "100%",
                height: "100%",
                borderRadius: 8,
              }}
            />
          </View>
        ) : (
          <video
            src={url}
            controls
            style={{ width: "100%", borderRadius: 8 }}
          />
        )
      ) : (
        <Pressable
          accessibilityLabel="Open video"
          className="rounded-lg bg-muted/60 px-3 py-3"
          onPress={() => {
            if (Platform.OS !== "web") {
              import("expo-web-browser").then((mod) =>
                mod.openBrowserAsync(url),
              );
            }
          }}
        >
          <View className="flex-row items-center gap-2">
            <VideoIcon size={16} color={colors.foreground} />
            <Text className="text-sm text-foreground">{url}</Text>
          </View>
        </Pressable>
      )}
      <TextInput
        value={caption}
        onChangeText={(t) => onChangeContent({ ...block.content, caption: t })}
        placeholder="Write a caption…"
        placeholderTextColor={colors.mutedForeground}
        className="text-xs text-muted-foreground py-1"
      />
    </View>
  );
}
