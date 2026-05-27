import React from "react";
import { Text, View } from "react-native";
import { useColorScheme } from "@/lib/useColorScheme";

export interface OxySpaceWordmarkProps {
  width?: number;
  height?: number;
  color?: string;
}

/**
 * Simple text wordmark for Oxy Space.
 * `width` controls the rendered font size so call sites can keep the
 * same numeric scale used by the previous SVG wordmark.
 */
export function OxySpaceWordmark({ width = 256, height, color }: OxySpaceWordmarkProps) {
  const { colors } = useColorScheme();
  const fill = color ?? colors.foreground;

  // Approximate visual weight of the prior SVG (font height ~38% of width).
  const fontSize = Math.max(12, Math.round((width as number) * 0.32));
  const containerHeight = height ?? Math.round(fontSize * 1.2);

  return (
    <View
      style={{
        height: containerHeight,
        justifyContent: "center",
        alignItems: "flex-start",
      }}
    >
      <Text
        style={{
          color: fill,
          fontSize,
          fontWeight: "700",
          letterSpacing: -0.5,
          lineHeight: fontSize * 1.1,
        }}
      >
        Oxy Space
      </Text>
    </View>
  );
}
