/**
 * Encoding for the Page.icon string column.
 *
 * The model stores a single string with a `prefix:value` convention so a page
 * can hold any of: a unicode emoji, a named lucide icon, or an uploaded image
 * URL — without piling on new model columns. Legacy rows that contain a bare
 * emoji (no prefix) are still rendered as such for backwards compatibility.
 */

export type IconValue =
  | { kind: "emoji"; emoji: string }
  | { kind: "icon"; name: string }
  | { kind: "image"; url: string }
  | { kind: "none" };

/**
 * Parse a stored icon string into a discriminated union. Returns `none` when
 * the value is null/empty or malformed.
 */
export function parseIcon(raw: string | null | undefined): IconValue {
  if (!raw) return { kind: "none" };
  const trimmed = raw.trim();
  if (!trimmed) return { kind: "none" };

  if (trimmed.startsWith("emoji:")) {
    const emoji = trimmed.slice("emoji:".length);
    return emoji ? { kind: "emoji", emoji } : { kind: "none" };
  }
  if (trimmed.startsWith("icon:")) {
    const name = trimmed.slice("icon:".length);
    return name ? { kind: "icon", name } : { kind: "none" };
  }
  if (trimmed.startsWith("image:")) {
    const url = trimmed.slice("image:".length);
    return url ? { kind: "image", url } : { kind: "none" };
  }

  // Legacy: bare emoji. Pages created before this prefix scheme stored the
  // emoji character directly. Treat anything else as an emoji to preserve
  // those values.
  return { kind: "emoji", emoji: trimmed };
}

export function encodeEmoji(emoji: string): string {
  return `emoji:${emoji}`;
}

export function encodeIcon(name: string): string {
  return `icon:${name}`;
}

export function encodeImage(url: string): string {
  return `image:${url}`;
}
