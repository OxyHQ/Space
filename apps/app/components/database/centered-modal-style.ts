import { Platform } from "react-native";
import type { ViewStyle } from "react-native";

/**
 * Returns the inline style needed to render a centered floating panel on
 * web. RN's `transform` types only accept numeric translates, so we
 * compute the half-width / half-height in pixels here instead of using
 * a CSS `-50%` translate (which would require casting through `unknown`).
 *
 * Native platforms skip this entirely — the modal already pins to the
 * bottom via `absolute bottom-0` classnames.
 */
export function centeredModalStyle(width: number, height?: number): ViewStyle | undefined {
  if (Platform.OS !== "web") return undefined;
  const halfW = width / 2;
  const halfH = (height ?? 0) / 2;
  return {
    width,
    transform: [
      { translateX: -halfW },
      ...(height ? [{ translateY: -halfH }] : []),
    ],
  };
}
