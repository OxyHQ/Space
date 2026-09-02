import * as React from "react";
import { Platform, Pressable, TextInput, View } from "react-native";
import { Music } from "lucide-react-native";
import { Text } from "@/components/ui/text";
import { useColorScheme } from "@/lib/useColorScheme";
import type { BlockComponentProps } from "./types";

/**
 * Audio block — accepts a URL (paste or upload) and renders a player.
 * On web we use the standard <audio> element; on native we link out to the
 * URL. Station stores the block and opens native audio in the system browser;
 * it does not request microphone or background-audio permissions.
 */
export function AudioBlock({ block, onChangeContent }: BlockComponentProps) {
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

  if (!url) {
    return (
      <View className="rounded-lg border border-dashed border-border bg-muted/40 px-3 py-4 gap-3">
        <View className="flex-row items-center gap-2">
          <Music size={16} color={colors.mutedForeground} />
          <Text className="text-sm text-muted-foreground">Audio</Text>
        </View>
        <TextInput
          value={urlDraft}
          onChangeText={setUrlDraft}
          onBlur={() =>
            onChangeContent({ ...block.content, url: urlDraft.trim() })
          }
          placeholder="Paste audio URL"
          placeholderTextColor={colors.mutedForeground}
          className="rounded-md bg-background px-2 py-1.5 text-sm text-foreground border border-input"
        />
      </View>
    );
  }

  return (
    <View className="gap-1">
      {Platform.OS === "web" ? (
        <audio controls src={url} style={{ width: "100%" }} />
      ) : (
        <Pressable
          className="flex-row items-center gap-2 rounded-lg bg-muted/60 px-3 py-2"
          onPress={() => {
            import("expo-web-browser").then((mod) => mod.openBrowserAsync(url));
          }}
        >
          <Music size={14} color={colors.foreground} />
          <Text className="text-sm text-foreground">{url}</Text>
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
