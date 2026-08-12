import * as React from "react";
import { Platform, Pressable, TextInput, View } from "react-native";
import { Code as CodeIcon } from "lucide-react-native";
import { Text } from "@/components/ui/text";
import { useColorScheme } from "@/lib/useColorScheme";
import type { BlockComponentProps } from "./types";

interface EmbedDescriptor {
  src: string;
  source: string;
  ratio?: number;
  /** Optional sandbox attribute to lock down third-party embeds. */
  sandbox?: string;
  /** Custom permissions allow-list. */
  allow?: string;
}

function buildEmbed(url: string): EmbedDescriptor | null {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return null;
  }
  const host = parsed.host.toLowerCase();

  // YouTube
  if (host === "youtu.be" || host.endsWith("youtube.com")) {
    let id: string | undefined;
    if (host === "youtu.be") id = parsed.pathname.slice(1);
    else id = parsed.searchParams.get("v") ?? undefined;
    if (!id) return null;
    return {
      src: `https://www.youtube.com/embed/${id}`,
      source: "youtube",
      ratio: 16 / 9,
      allow:
        "accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture",
    };
  }

  // Vimeo
  if (host === "vimeo.com" || host.endsWith(".vimeo.com")) {
    const id = parsed.pathname.split("/").filter(Boolean).pop();
    if (!id) return null;
    return {
      src: `https://player.vimeo.com/video/${id}`,
      source: "vimeo",
      ratio: 16 / 9,
    };
  }

  // Loom
  if (host.endsWith("loom.com")) {
    const id = parsed.pathname.split("/").filter(Boolean).pop();
    if (!id) return null;
    return {
      src: `https://www.loom.com/embed/${id}`,
      source: "loom",
      ratio: 16 / 9,
    };
  }

  // Figma
  if (host.endsWith("figma.com")) {
    return {
      src: `https://www.figma.com/embed?embed_host=oxystation&url=${encodeURIComponent(url)}`,
      source: "figma",
      ratio: 4 / 3,
    };
  }

  // Twitter / X — use publish.twitter.com oembed iframe shape
  if (host === "twitter.com" || host === "x.com" || host.endsWith(".twitter.com")) {
    return {
      src: `https://platform.twitter.com/embed/Tweet.html?id=${encodeURIComponent(parsed.pathname.split("/").pop() ?? "")}`,
      source: "twitter",
      ratio: 3 / 4,
    };
  }

  // CodePen
  if (host.endsWith("codepen.io")) {
    const parts = parsed.pathname.split("/").filter(Boolean);
    // /:user/pen/:id  →  /:user/embed/:id
    if (parts.length >= 3 && parts[1] === "pen") {
      return {
        src: `https://codepen.io/${parts[0]}/embed/${parts[2]}`,
        source: "codepen",
        ratio: 4 / 3,
      };
    }
  }

  // GitHub Gist — embed via script-rendered iframe substitute (gist.it).
  if (host === "gist.github.com") {
    return {
      src: `https://gist.github.com${parsed.pathname}.pibb`,
      source: "github-gist",
      ratio: 4 / 3,
    };
  }

  return null;
}

/**
 * Generic embed block — accepts a URL and renders the best iframe we can
 * detect. Falls back to a "bookmark"-style summary if we can't auto-embed.
 */
export function EmbedBlock({ block, onChangeContent }: BlockComponentProps) {
  const { colors } = useColorScheme();
  const url = typeof block.content.url === "string" ? block.content.url : "";
  const [urlDraft, setUrlDraft] = React.useState(url);
  const lastBlockId = React.useRef(block._id);
  if (lastBlockId.current !== block._id) {
    lastBlockId.current = block._id;
    setUrlDraft(url);
  }

  const descriptor = React.useMemo(() => (url ? buildEmbed(url) : null), [url]);

  const commitUrl = (next: string) => {
    const trimmed = next.trim();
    const desc = trimmed ? buildEmbed(trimmed) : null;
    onChangeContent({
      ...block.content,
      url: trimmed,
      source: desc?.source ?? "other",
    });
  };

  if (!url) {
    return (
      <View className="rounded-lg border border-dashed border-border bg-muted/40 px-3 py-4 gap-3">
        <View className="flex-row items-center gap-2">
          <CodeIcon size={16} color={colors.mutedForeground} />
          <Text className="text-sm text-muted-foreground">Embed</Text>
        </View>
        <TextInput
          value={urlDraft}
          onChangeText={setUrlDraft}
          onBlur={() => commitUrl(urlDraft)}
          placeholder="Paste a YouTube, Figma, Twitter, CodePen, GitHub Gist…"
          placeholderTextColor={colors.mutedForeground}
          className="rounded-md bg-background px-2 py-1.5 text-sm text-foreground border border-input"
        />
      </View>
    );
  }

  if (Platform.OS !== "web" || !descriptor) {
    return (
      <Pressable
        className="rounded-lg border border-border bg-muted/30 px-3 py-2"
        onPress={() => {
          if (Platform.OS !== "web") {
            import("expo-web-browser").then((mod) => mod.openBrowserAsync(url));
          }
        }}
      >
        <Text className="text-sm text-foreground" numberOfLines={2}>
          {url}
        </Text>
      </Pressable>
    );
  }

  return (
    <View style={{ width: "100%", aspectRatio: descriptor.ratio ?? 16 / 9 }}>
      <iframe
        src={descriptor.src}
        title={`${descriptor.source} embed`}
        sandbox={descriptor.sandbox}
        allow={descriptor.allow}
        allowFullScreen
        style={{ border: 0, width: "100%", height: "100%", borderRadius: 8 }}
      />
    </View>
  );
}
