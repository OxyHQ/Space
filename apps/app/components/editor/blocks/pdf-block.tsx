import * as React from "react";
import { Platform, Pressable, TextInput, View } from "react-native";
import { FileText } from "lucide-react-native";
import { Text } from "@/components/ui/text";
import { useColorScheme } from "@/lib/useColorScheme";
import type { BlockComponentProps } from "./types";

/**
 * PDF block — embeds the PDF in an iframe on web, links out on native.
 * Falls back to a download pill if the iframe load fails (we can't tell
 * from JS whether the iframe succeeded, so we always show a small "Open in
 * new tab" link alongside it).
 */
export function PdfBlock({ block, onChangeContent }: BlockComponentProps) {
  const { colors } = useColorScheme();
  const url = typeof block.content.url === "string" ? block.content.url : "";
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
          <FileText size={16} color={colors.mutedForeground} />
          <Text className="text-sm text-muted-foreground">PDF</Text>
        </View>
        <TextInput
          value={urlDraft}
          onChangeText={setUrlDraft}
          onBlur={() =>
            onChangeContent({ ...block.content, url: urlDraft.trim() })
          }
          placeholder="Paste PDF URL"
          placeholderTextColor={colors.mutedForeground}
          className="rounded-md bg-background px-2 py-1.5 text-sm text-foreground border border-input"
        />
      </View>
    );
  }

  if (Platform.OS === "web") {
    return (
      <View className="gap-1">
        <View style={{ width: "100%", aspectRatio: 4 / 5 }}>
          <iframe
            src={url}
            title="PDF preview"
            style={{
              border: 0,
              width: "100%",
              height: "100%",
              borderRadius: 8,
            }}
          />
        </View>
        <a
          href={url}
          target="_blank"
          rel="noreferrer"
          style={{ fontSize: 12 }}
          className="text-xs text-muted-foreground hover:text-foreground"
        >
          Open in new tab
        </a>
      </View>
    );
  }

  return (
    <Pressable
      onPress={() =>
        import("expo-web-browser").then((mod) => mod.openBrowserAsync(url))
      }
      className="flex-row items-center gap-3 rounded-lg border border-border bg-muted/40 px-3 py-2"
    >
      <FileText size={18} color={colors.foreground} />
      <Text className="text-sm text-foreground">Open PDF</Text>
    </Pressable>
  );
}
