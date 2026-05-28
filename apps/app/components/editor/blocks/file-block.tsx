import * as React from "react";
import { Platform, Pressable, View } from "react-native";
import { File as FileIcon, Upload } from "lucide-react-native";
import { Text } from "@/components/ui/text";
import { useColorScheme } from "@/lib/useColorScheme";
import { uploadFile } from "@/lib/uploads/upload-file";
import type { BlockComponentProps } from "./types";

function formatBytes(n: number): string {
  if (!Number.isFinite(n) || n <= 0) return "";
  const units = ["B", "KB", "MB", "GB"];
  let v = n;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i += 1;
  }
  return `${v.toFixed(v >= 100 || i === 0 ? 0 : 1)} ${units[i]}`;
}

/**
 * Generic file block — surfaces a download pill once a file is attached.
 * Pressing the pill opens the URL (web: new tab via anchor; native: web
 * browser).
 */
export function FileBlock({ block, onChangeContent }: BlockComponentProps) {
  const { colors } = useColorScheme();
  const url = typeof block.content.url === "string" ? block.content.url : "";
  const name = typeof block.content.name === "string" ? block.content.name : "";
  const size = typeof block.content.size === "number" ? block.content.size : 0;
  const [busy, setBusy] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
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
      onChangeContent({
        ...block.content,
        url: result.fileUrl,
        name: file.name,
        size: file.size,
        mimeType: file.type || "application/octet-stream",
      });
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
      const picker = await import("expo-document-picker");
      const { File } = await import("expo-file-system");
      const result = await picker.getDocumentAsync({ copyToCacheDirectory: true });
      if (result.canceled || result.assets.length === 0) return;
      const asset = result.assets[0];
      const file = new File(asset.uri);
      const bytes = await file.bytes();
      const mimeType = asset.mimeType ?? "application/octet-stream";
      const filename = asset.name ?? `file-${Date.now()}`;
      const uploaded = await uploadFile({
        filename,
        mimeType,
        body: bytes,
        size: bytes.byteLength,
      });
      onChangeContent({
        ...block.content,
        url: uploaded.fileUrl,
        name: filename,
        size: asset.size ?? bytes.byteLength,
        mimeType,
      });
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
          <FileIcon size={16} color={colors.mutedForeground} />
          <Text className="text-sm text-muted-foreground">File</Text>
        </View>
        <Pressable
          onPress={() => {
            if (Platform.OS === "web") {
              fileInputRef.current?.click();
            } else {
              void handleNativeUpload();
            }
          }}
          className="flex-row items-center gap-1 self-start rounded-md bg-primary px-3 py-1.5"
          disabled={busy}
        >
          <Upload size={14} color={colors.primaryForeground} />
          <Text
            className="text-sm font-medium"
            style={{ color: colors.primaryForeground }}
          >
            {busy ? "Uploading…" : "Choose file"}
          </Text>
        </Pressable>
        {Platform.OS === "web" ? (
          <input
            ref={fileInputRef}
            type="file"
            style={{ display: "none" }}
            onChange={(ev) => {
              const file = ev.target.files?.[0];
              if (file) void handleWebUpload(file);
              ev.target.value = "";
            }}
          />
        ) : null}
        {error ? <Text className="text-xs text-destructive">{error}</Text> : null}
      </View>
    );
  }

  const sizeLabel = formatBytes(size);
  const displayName = name || url.split("/").pop() || "file";

  if (Platform.OS === "web") {
    return (
      <a
        href={url}
        target="_blank"
        rel="noreferrer"
        style={{ textDecoration: "none" }}
      >
        <View className="flex-row items-center gap-3 rounded-lg border border-border bg-muted/40 px-3 py-2">
          <FileIcon size={18} color={colors.foreground} />
          <View className="flex-1">
            <Text className="text-sm text-foreground">{displayName}</Text>
            {sizeLabel ? (
              <Text className="text-xs text-muted-foreground">{sizeLabel}</Text>
            ) : null}
          </View>
        </View>
      </a>
    );
  }

  return (
    <Pressable
      onPress={() => {
        import("expo-web-browser").then((mod) => mod.openBrowserAsync(url));
      }}
      className="flex-row items-center gap-3 rounded-lg border border-border bg-muted/40 px-3 py-2"
    >
      <FileIcon size={18} color={colors.foreground} />
      <View className="flex-1">
        <Text className="text-sm text-foreground">{displayName}</Text>
        {sizeLabel ? (
          <Text className="text-xs text-muted-foreground">{sizeLabel}</Text>
        ) : null}
      </View>
    </Pressable>
  );
}
