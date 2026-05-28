/**
 * Encoding for the Page.cover string column. Same shape as `icon-value.ts`:
 * a single `prefix:value` string covers every cover variant we ship.
 *
 *   gradient:<index>   — a preset gradient (defined in COVER_GRADIENTS).
 *   color:<#hex>       — a solid color cover.
 *   image:<url>        — uploaded or external image URL.
 *   unsplash:<url>     — Unsplash image. Behaves like `image:` at render time
 *                        but kept distinct so the picker tab can preselect.
 */

export type CoverValue =
  | { kind: "gradient"; index: number }
  | { kind: "color"; hex: string }
  | { kind: "image"; url: string }
  | { kind: "unsplash"; url: string }
  | { kind: "none" };

export function parseCover(raw: string | null | undefined): CoverValue {
  if (!raw) return { kind: "none" };
  const trimmed = raw.trim();
  if (!trimmed) return { kind: "none" };

  if (trimmed.startsWith("gradient:")) {
    const idx = Number.parseInt(trimmed.slice("gradient:".length), 10);
    if (Number.isFinite(idx) && idx >= 0 && idx < COVER_GRADIENTS.length) {
      return { kind: "gradient", index: idx };
    }
    return { kind: "none" };
  }
  if (trimmed.startsWith("color:")) {
    const hex = trimmed.slice("color:".length);
    return hex ? { kind: "color", hex } : { kind: "none" };
  }
  if (trimmed.startsWith("image:")) {
    const url = trimmed.slice("image:".length);
    return url ? { kind: "image", url } : { kind: "none" };
  }
  if (trimmed.startsWith("unsplash:")) {
    const url = trimmed.slice("unsplash:".length);
    return url ? { kind: "unsplash", url } : { kind: "none" };
  }
  // Legacy: bare URL. Treat as image so pre-prefix pages still render.
  if (/^https?:\/\//u.test(trimmed)) {
    return { kind: "image", url: trimmed };
  }
  return { kind: "none" };
}

export function encodeGradient(index: number): string {
  return `gradient:${index}`;
}
export function encodeColor(hex: string): string {
  return `color:${hex}`;
}
export function encodeCoverImage(url: string): string {
  return `image:${url}`;
}
export function encodeUnsplash(url: string): string {
  return `unsplash:${url}`;
}

/**
 * Preset gradient list. Each entry is two-stop CSS-linear-gradient-friendly.
 * Direction is fixed at 135deg to keep the picker visual identical on web
 * and native. Add to the end of the array to avoid invalidating stored
 * indices.
 */
export const COVER_GRADIENTS: ReadonlyArray<{
  name: string;
  from: string;
  to: string;
}> = [
  { name: "Sunset", from: "#ff7e5f", to: "#feb47b" },
  { name: "Aurora", from: "#a8edea", to: "#fed6e3" },
  { name: "Tropics", from: "#43cea2", to: "#185a9d" },
  { name: "Lavender", from: "#c471f5", to: "#fa71cd" },
  { name: "Mint", from: "#76b852", to: "#8dc26f" },
  { name: "Ocean", from: "#2193b0", to: "#6dd5ed" },
  { name: "Sherbet", from: "#f7971e", to: "#ffd200" },
  { name: "Plum", from: "#5614b0", to: "#dbd65c" },
  { name: "Crimson", from: "#ed213a", to: "#93291e" },
  { name: "Slate", from: "#232526", to: "#414345" },
];

/**
 * Preset solid colors. Picked to read well as a 200px cover behind dark text.
 */
export const COVER_COLORS: ReadonlyArray<{ name: string; hex: string }> = [
  { name: "Slate", hex: "#1f2937" },
  { name: "Stone", hex: "#57534e" },
  { name: "Brick", hex: "#9a3412" },
  { name: "Marigold", hex: "#a16207" },
  { name: "Moss", hex: "#15803d" },
  { name: "Sea", hex: "#0e7490" },
  { name: "Sky", hex: "#1d4ed8" },
  { name: "Violet", hex: "#6d28d9" },
  { name: "Rose", hex: "#be185d" },
  { name: "Charcoal", hex: "#27272a" },
];
