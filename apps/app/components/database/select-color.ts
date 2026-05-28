import type { SelectColor } from "@/lib/types/databases";

/**
 * Background + foreground classes for select-style chips. The classes use
 * named NativeWind colors so light/dark theme switching keeps the chips
 * legible without inline styles.
 */
export const SELECT_COLOR_CLASSES: Record<
  SelectColor,
  { bg: string; fg: string }
> = {
  default: { bg: "bg-muted", fg: "text-foreground" },
  gray: { bg: "bg-zinc-200 dark:bg-zinc-700", fg: "text-zinc-800 dark:text-zinc-200" },
  brown: { bg: "bg-amber-200 dark:bg-amber-800", fg: "text-amber-900 dark:text-amber-100" },
  orange: { bg: "bg-orange-200 dark:bg-orange-800", fg: "text-orange-900 dark:text-orange-100" },
  yellow: { bg: "bg-yellow-200 dark:bg-yellow-800", fg: "text-yellow-900 dark:text-yellow-100" },
  green: { bg: "bg-green-200 dark:bg-green-800", fg: "text-green-900 dark:text-green-100" },
  blue: { bg: "bg-blue-200 dark:bg-blue-800", fg: "text-blue-900 dark:text-blue-100" },
  purple: { bg: "bg-purple-200 dark:bg-purple-800", fg: "text-purple-900 dark:text-purple-100" },
  pink: { bg: "bg-pink-200 dark:bg-pink-800", fg: "text-pink-900 dark:text-pink-100" },
  red: { bg: "bg-red-200 dark:bg-red-800", fg: "text-red-900 dark:text-red-100" },
};
