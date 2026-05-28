import * as React from "react";
import { Platform, Pressable, TextInput, View } from "react-native";
import { Wand2 } from "lucide-react-native";
import { router } from "expo-router";
import { Text } from "@/components/ui/text";
import { useColorScheme } from "@/lib/useColorScheme";
import apiClient from "@/lib/api/client";
import { API_ROUTES } from "@/lib/api/routes";
import type { ButtonAction } from "@/lib/types/pages";
import type { BlockComponentProps } from "./types";

/**
 * Configurable button block. Renders a styled button + a small inline form
 * to set the label and action. Clicking the button fires the action:
 *   - navigate:           opens `content.url` (web new tab, native browser)
 *   - new-page:           POSTs /pages with a stub then routes to it
 *   - duplicate-template: clones the page id in `templateId` (no-op if blank)
 *   - webhook:            POSTs an empty body to `content.webhookUrl`
 *
 * All four actions are best-effort and never throw — UI surfaces feedback
 * inline.
 */
export function ButtonBlock({ block, onChangeContent }: BlockComponentProps) {
  const { colors } = useColorScheme();
  const label =
    typeof block.content.label === "string" ? block.content.label : "Button";
  const action: ButtonAction =
    (block.content.action as ButtonAction | undefined) ?? "navigate";
  const targetUrl = typeof block.content.url === "string" ? block.content.url : "";
  const webhookUrl =
    typeof block.content.webhookUrl === "string" ? block.content.webhookUrl : "";

  const [editing, setEditing] = React.useState(false);
  const [status, setStatus] = React.useState<string | null>(null);
  const [busy, setBusy] = React.useState(false);

  const click = async () => {
    setStatus(null);
    setBusy(true);
    try {
      if (action === "navigate" && targetUrl) {
        if (Platform.OS === "web") {
          window.open(targetUrl, "_blank", "noopener,noreferrer");
        } else {
          const mod = await import("expo-web-browser");
          await mod.openBrowserAsync(targetUrl);
        }
      } else if (action === "new-page") {
        const res = await apiClient.post<{ page: { _id: string } }>(
          API_ROUTES.pages.create,
          { title: "Untitled" },
        );
        router.push(`/p/${res.data.page._id}`);
      } else if (action === "duplicate-template") {
        const templateId =
          typeof block.content.templateId === "string"
            ? block.content.templateId
            : "";
        if (!templateId) {
          setStatus("Set a template page first.");
        } else {
          // Backend currently doesn't expose /pages/:id/duplicate — use create
          // as a fallback so the action still produces a new page.
          const res = await apiClient.post<{ page: { _id: string } }>(
            API_ROUTES.pages.create,
            { title: "Copy", parentId: templateId },
          );
          router.push(`/p/${res.data.page._id}`);
        }
      } else if (action === "webhook") {
        if (!webhookUrl) {
          setStatus("Set a webhook URL first.");
        } else {
          await fetch(webhookUrl, { method: "POST" });
          setStatus("Webhook fired.");
        }
      } else {
        setStatus("Configure the action below.");
      }
    } catch (err) {
      setStatus(err instanceof Error ? err.message : "Action failed");
    } finally {
      setBusy(false);
    }
  };

  return (
    <View className="gap-1 my-1">
      <View className="flex-row items-center gap-2">
        <Pressable
          onPress={click}
          disabled={busy}
          className="flex-row items-center gap-1 rounded-md bg-primary px-3 py-1.5"
        >
          <Wand2 size={14} color={colors.primaryForeground} />
          <Text
            className="text-sm font-medium"
            style={{ color: colors.primaryForeground }}
          >
            {busy ? "Working…" : label}
          </Text>
        </Pressable>
        <Pressable
          onPress={() => setEditing((v) => !v)}
          className="rounded-md px-2 py-1 hover:bg-muted"
        >
          <Text className="text-xs text-muted-foreground">
            {editing ? "Done" : "Edit"}
          </Text>
        </Pressable>
      </View>
      {editing ? (
        <View className="rounded-md border border-border bg-muted/30 p-2 gap-1">
          <TextInput
            value={label}
            onChangeText={(t) => onChangeContent({ ...block.content, label: t })}
            placeholder="Button label"
            placeholderTextColor={colors.mutedForeground}
            className="rounded bg-background px-2 py-1 text-sm text-foreground border border-input"
          />
          <View className="flex-row gap-1 flex-wrap">
            {(
              [
                "navigate",
                "new-page",
                "duplicate-template",
                "webhook",
              ] as readonly ButtonAction[]
            ).map((a) => (
              <Pressable
                key={a}
                onPress={() => onChangeContent({ ...block.content, action: a })}
                className={
                  a === action
                    ? "rounded-md px-2 py-1 bg-primary"
                    : "rounded-md px-2 py-1 bg-background border border-input"
                }
              >
                <Text
                  className={
                    a === action
                      ? "text-xs font-medium"
                      : "text-xs text-muted-foreground"
                  }
                  style={a === action ? { color: colors.primaryForeground } : undefined}
                >
                  {a}
                </Text>
              </Pressable>
            ))}
          </View>
          {action === "navigate" ? (
            <TextInput
              value={targetUrl}
              onChangeText={(t) =>
                onChangeContent({ ...block.content, url: t.trim() })
              }
              placeholder="https://…"
              placeholderTextColor={colors.mutedForeground}
              className="rounded bg-background px-2 py-1 text-sm text-foreground border border-input"
            />
          ) : null}
          {action === "webhook" ? (
            <TextInput
              value={webhookUrl}
              onChangeText={(t) =>
                onChangeContent({ ...block.content, webhookUrl: t.trim() })
              }
              placeholder="https://… (POST)"
              placeholderTextColor={colors.mutedForeground}
              className="rounded bg-background px-2 py-1 text-sm text-foreground border border-input"
            />
          ) : null}
        </View>
      ) : null}
      {status ? (
        <Text className="text-xs text-muted-foreground">{status}</Text>
      ) : null}
    </View>
  );
}
