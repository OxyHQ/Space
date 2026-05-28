import * as React from "react";
import { Platform, TextInput, View } from "react-native";
import { Workflow } from "lucide-react-native";
import { Text } from "@/components/ui/text";
import { useColorScheme } from "@/lib/useColorScheme";
import type { BlockComponentProps } from "./types";

let mermaidLoader: Promise<typeof import("mermaid")> | null = null;
function loadMermaid(): Promise<typeof import("mermaid")> {
  if (Platform.OS !== "web") {
    return Promise.reject(new Error("Mermaid web-only"));
  }
  if (!mermaidLoader) {
    mermaidLoader = import("mermaid").then((mod) => {
      mod.default.initialize({ startOnLoad: false, securityLevel: "loose" });
      return mod;
    });
  }
  return mermaidLoader;
}

/**
 * Mermaid block — stores diagram source in `content.code`. On web we render
 * via mermaid.js (lazy-loaded). On native we show the raw code; native
 * rendering would need WebView (Phase 4).
 */
export function MermaidBlock({ block, onChangeContent }: BlockComponentProps) {
  const { colors } = useColorScheme();
  const code = typeof block.content.code === "string" ? block.content.code : "";
  const [draft, setDraft] = React.useState(code);
  const lastBlockId = React.useRef(block._id);
  if (lastBlockId.current !== block._id) {
    lastBlockId.current = block._id;
    setDraft(code);
  }

  const [svg, setSvg] = React.useState<string>("");
  const [renderError, setRenderError] = React.useState<string>("");
  const lastRendered = React.useRef<string | null>(null);
  const idRef = React.useRef(`mermaid-${Math.random().toString(36).slice(2)}`);

  if (Platform.OS === "web" && lastRendered.current !== code) {
    lastRendered.current = code;
    if (code.trim()) {
      loadMermaid()
        .then(async (mod) => {
          try {
            const { svg: rendered } = await mod.default.render(idRef.current, code);
            setSvg(rendered);
            setRenderError("");
          } catch (err) {
            setRenderError(err instanceof Error ? err.message : "Render failed");
            setSvg("");
          }
        })
        .catch((err) => {
          setRenderError(err instanceof Error ? err.message : "Mermaid unavailable");
        });
    } else {
      setSvg("");
      setRenderError("");
    }
  }

  return (
    <View className="rounded-md border border-border bg-muted/30 px-3 py-2 my-1 gap-2">
      <View className="flex-row items-center gap-2">
        <Workflow size={14} color={colors.mutedForeground} />
        <Text className="text-xs text-muted-foreground">Mermaid diagram</Text>
      </View>
      <TextInput
        value={draft}
        onChangeText={setDraft}
        onBlur={() => {
          if (draft !== code) onChangeContent({ ...block.content, code: draft });
        }}
        placeholder={"graph TD;\n  A-->B;"}
        placeholderTextColor={colors.mutedForeground}
        className="rounded bg-background px-2 py-1.5 text-sm text-foreground border border-input font-mono"
        multiline
        numberOfLines={4}
      />
      {Platform.OS === "web" && svg ? (
        <div
          dangerouslySetInnerHTML={{ __html: svg }}
          style={{ overflowX: "auto" }}
        />
      ) : null}
      {Platform.OS === "web" && renderError ? (
        <Text className="text-xs text-destructive">{renderError}</Text>
      ) : null}
      {Platform.OS !== "web" && code ? (
        <Text className="text-sm text-foreground font-mono">{code}</Text>
      ) : null}
    </View>
  );
}
