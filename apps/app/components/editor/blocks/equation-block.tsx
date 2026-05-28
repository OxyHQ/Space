import * as React from "react";
import { Platform, TextInput, View } from "react-native";
import { Sigma } from "lucide-react-native";
import { Text } from "@/components/ui/text";
import { useColorScheme } from "@/lib/useColorScheme";
import type { BlockComponentProps } from "./types";

/**
 * Equation block — stores LaTeX in `content.latex`. On web we render via
 * KaTeX; the KaTeX CSS is loaded lazily on first render to avoid pulling
 * font assets into native bundles. On native we display the raw LaTeX source
 * inside a monospace box (acceptable Phase 3 behavior — full native render
 * would require WebView).
 */
export function EquationBlock({ block, onChangeContent }: BlockComponentProps) {
  const { colors } = useColorScheme();
  const latex = typeof block.content.latex === "string" ? block.content.latex : "";
  const [draft, setDraft] = React.useState(latex);
  const lastBlockId = React.useRef(block._id);
  if (lastBlockId.current !== block._id) {
    lastBlockId.current = block._id;
    setDraft(latex);
  }

  const [html, setHtml] = React.useState<string>("");
  const lastRendered = React.useRef<string | null>(null);
  if (Platform.OS === "web" && lastRendered.current !== latex) {
    lastRendered.current = latex;
    if (latex) {
      // Lazy import — keeps initial bundle slim for users who never insert math.
      import("katex").then((mod) => {
        try {
          const rendered = mod.default.renderToString(latex, {
            throwOnError: false,
            displayMode: true,
          });
          setHtml(rendered);
        } catch {
          setHtml("");
        }
      });
      // Stylesheet is needed for proper typography. Inject once.
      if (typeof document !== "undefined") {
        const id = "katex-stylesheet";
        if (!document.getElementById(id)) {
          const link = document.createElement("link");
          link.id = id;
          link.rel = "stylesheet";
          link.href = "https://cdn.jsdelivr.net/npm/katex@0.16.9/dist/katex.min.css";
          document.head.appendChild(link);
        }
      }
    } else {
      setHtml("");
    }
  }

  return (
    <View className="rounded-md border border-border bg-muted/30 px-3 py-2 my-1 gap-2">
      <View className="flex-row items-center gap-2">
        <Sigma size={14} color={colors.mutedForeground} />
        <Text className="text-xs text-muted-foreground">Equation (LaTeX)</Text>
      </View>
      <TextInput
        value={draft}
        onChangeText={setDraft}
        onBlur={() => {
          if (draft !== latex) onChangeContent({ ...block.content, latex: draft });
        }}
        placeholder="\\frac{a}{b}"
        placeholderTextColor={colors.mutedForeground}
        className="rounded bg-background px-2 py-1.5 text-sm text-foreground border border-input font-mono"
        multiline
        numberOfLines={2}
      />
      {Platform.OS === "web" && html ? (
        <div
          dangerouslySetInnerHTML={{ __html: html }}
          style={{
            color: colors.foreground,
            backgroundColor: "transparent",
            overflowX: "auto",
          }}
        />
      ) : Platform.OS !== "web" && latex ? (
        <Text className="text-sm text-foreground font-mono">{latex}</Text>
      ) : null}
    </View>
  );
}
