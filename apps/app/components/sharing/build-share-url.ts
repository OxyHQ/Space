import { Platform } from "react-native";

/**
 * Resolve the public host that serves `/share/[token]` URLs.
 * Priority:
 *   1. EXPO_PUBLIC_WEB_URL (set in CI/staging/prod env)
 *   2. window.location.origin (web only)
 *   3. Production fallback `https://station.oxy.so`
 */
function resolveWebOrigin(): string {
  if (process.env.EXPO_PUBLIC_WEB_URL) {
    return process.env.EXPO_PUBLIC_WEB_URL.replace(/\/$/, "");
  }
  if (Platform.OS === "web" && typeof window !== "undefined") {
    return window.location.origin;
  }
  return "https://station.oxy.so";
}

export function buildShareUrl(token: string): string {
  return `${resolveWebOrigin()}/share/${token}`;
}
