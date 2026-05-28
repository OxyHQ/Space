import * as React from "react";
import { Image, View } from "react-native";
import { FileText } from "lucide-react-native";
import { Text } from "@/components/ui/text";
import { useColorScheme } from "@/lib/useColorScheme";
import { getLucideIcon } from "./lucide-icons";
import { parseIcon, type IconValue } from "./icon-value";

interface IconDisplayProps {
  /** Raw icon string from `Page.icon`. */
  value: string | null | undefined;
  /** Pixel size of the rendered icon. Defaults to 16 (sidebar size). */
  size?: number;
  /** Optional placeholder when icon is null/empty. Defaults to a doc icon. */
  showPlaceholder?: boolean;
}

/**
 * Single source of truth for rendering a page icon. The same component works
 * for sidebar (small), page header (large), and breadcrumb (xs) by varying
 * `size`. Falls back to a doc placeholder when `showPlaceholder` is true.
 */
export function IconDisplay({
  value,
  size = 16,
  showPlaceholder = false,
}: IconDisplayProps) {
  const parsed = React.useMemo<IconValue>(() => parseIcon(value), [value]);
  const { colors } = useColorScheme();

  if (parsed.kind === "none") {
    if (!showPlaceholder) return null;
    return (
      <View
        className="items-center justify-center"
        style={{ width: size, height: size }}
      >
        <FileText size={size * 0.85} color={colors.mutedForeground} />
      </View>
    );
  }

  if (parsed.kind === "emoji") {
    // Emoji rendering: lineHeight = size so the glyph sits in a clean square.
    return (
      <Text
        style={{ fontSize: size, lineHeight: size * 1.1 }}
        accessibilityLabel="Page icon"
      >
        {parsed.emoji}
      </Text>
    );
  }

  if (parsed.kind === "icon") {
    const Icon = getLucideIcon(parsed.name);
    if (!Icon) {
      return (
        <View
          className="items-center justify-center"
          style={{ width: size, height: size }}
        >
          <FileText size={size * 0.85} color={colors.mutedForeground} />
        </View>
      );
    }
    return <Icon size={size} color={colors.foreground} />;
  }

  // Image (uploaded or external URL).
  return (
    <Image
      source={{ uri: parsed.url }}
      style={{ width: size, height: size, borderRadius: size * 0.15 }}
      accessibilityLabel="Page icon"
    />
  );
}
