import * as React from "react";
import { Platform, Pressable, TextInput, View } from "react-native";
import { Image as ExpoImage } from "expo-image";
import { Image as ImageIcon, Upload } from "lucide-react-native";
import { Text } from "@/components/ui/text";
import { useColorScheme } from "@/lib/useColorScheme";
import { uploadFile } from "@/lib/uploads/upload-file";
import type { BlockComponentProps } from "./types";

/**
 * Image block — renders a captioned image. Empty state offers two paths:
 *   1) Paste a URL into the URL field.
 *   2) Upload via the file picker → presigned PUT → assign `content.url`.
 *
 * Cross-platform note: web uses a `<input type=file>` (hidden) since RN doesn't
 * expose one. Native picks via `expo-image-picker` (dynamic import so the web
 * bundle doesn't include native-only deps).
 */
export function ImageBlock({ block, onChangeContent }: BlockComponentProps) {
  const { colors } = useColorScheme();
  const url = typeof block.content.url === "string" ? block.content.url : "";
  const caption =
    typeof block.content.caption === "string" ? block.content.caption : "";
  const [urlDraft, setUrlDraft] = React.useState(url);
  const [busy, setBusy] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  // Reset the input when the block changes identity (e.g. fresh remount).
  const lastBlockId = React.useRef(block._id);
  if (lastBlockId.current !== block._id) {
    lastBlockId.current = block._id;
    setUrlDraft(url);
  }

  const commitUrl = (next: string) => {
    onChangeContent({ ...block.content, url: next.trim() });
  };
  const commitCaption = (next: string) => {
    onChangeContent({ ...block.content, caption: next });
  };

  const fileInputRef = React.useRef<HTMLInputElement | null>(null);
  const handleWebUpload = async (file: File) => {
    setBusy(true);
    setError(null);
    try {
      const buf = await file.arrayBuffer();
      const result = await uploadFile({
        filename: file.name,
        mimeType: file.type || "application/octet-stream",
        body: buf,
        size: file.size,
      });
      onChangeContent({ ...block.content, url: result.fileUrl });
    } catch (err) {
      setError(err instanceof Error ? err.message : "Upload failed");
    } finally {
      setBusy(false);
    }
  };

  const handleNativeUpload = async () => {
    setBusy(true);
    setError(null);
    try {
      const picker = await import("expo-image-picker");
      const result = await picker.launchImageLibraryAsync({
        mediaTypes: picker.MediaTypeOptions.Images,
        quality: 0.9,
      });
      if (result.canceled || result.assets.length === 0) return;
      const asset = result.assets[0];
      const { File } = await import("expo-file-system");
      const file = new File(asset.uri);
      const bytes = await file.bytes();
      const mimeType = asset.mimeType ?? "image/jpeg";
      const filename = asset.fileName ?? `image-${Date.now()}.jpg`;
      const uploaded = await uploadFile({
        filename,
        mimeType,
        body: bytes,
        size: bytes.byteLength,
      });
      onChangeContent({ ...block.content, url: uploaded.fileUrl });
    } catch (err) {
      setError(err instanceof Error ? err.message : "Upload failed");
    } finally {
      setBusy(false);
    }
  };

  if (!url) {
    return (
      <View className="rounded-lg border border-dashed border-border bg-muted/40 px-3 py-4 gap-3">
        <View className="flex-row items-center gap-2">
          <ImageIcon size={16} color={colors.mutedForeground} />
          <Text className="text-sm text-muted-foreground">Image</Text>
        </View>
        <View className="flex-row items-center gap-2">
          <TextInput
            value={urlDraft}
            onChangeText={setUrlDraft}
            onBlur={() => commitUrl(urlDraft)}
            placeholder="Paste image URL"
            placeholderTextColor={colors.mutedForeground}
            className="flex-1 rounded-md bg-background px-2 py-1.5 text-sm text-foreground border border-input"
          />
          <Pressable
            onPress={() => {
              if (Platform.OS === "web") {
                fileInputRef.current?.click();
              } else {
                void handleNativeUpload();
              }
            }}
            className="flex-row items-center gap-1 rounded-md bg-primary px-3 py-1.5"
            disabled={busy}
          >
            <Upload size={14} color={colors.primaryForeground} />
            <Text className="text-sm font-medium" style={{ color: colors.primaryForeground }}>
              {busy ? "Uploading…" : "Upload"}
            </Text>
          </Pressable>
        </View>
        {Platform.OS === "web" ? (
          <input
            ref={fileInputRef}
            type="file"
            accept="image/*"
            style={{ display: "none" }}
            onChange={(ev) => {
              const file = ev.target.files?.[0];
              if (file) void handleWebUpload(file);
              ev.target.value = "";
            }}
          />
        ) : null}
        {error ? (
          <Text className="text-xs text-destructive">{error}</Text>
        ) : null}
      </View>
    );
  }

  return (
    <View className="gap-1">
      <ExpoImage
        source={{ uri: url }}
        style={{ width: "100%", aspectRatio: 16 / 9, borderRadius: 8 }}
        contentFit="contain"
        transition={150}
        accessibilityLabel={
          typeof block.content.alt === "string" ? block.content.alt : undefined
        }
      />
      <TextInput
        value={caption}
        onChangeText={commitCaption}
        placeholder="Write a caption…"
        placeholderTextColor={colors.mutedForeground}
        className="text-xs text-muted-foreground py-1"
      />
    </View>
  );
}
