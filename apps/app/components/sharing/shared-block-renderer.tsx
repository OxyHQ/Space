import React from "react";
import { View, Pressable, Platform } from "react-native";
import { Text } from "@/components/ui/text";
import { Check } from "lucide-react-native";
import { useColorScheme } from "@/lib/useColorScheme";
import type { SharedBlock } from "@/lib/hooks/use-share-links";

/**
 * SharedBlockRenderer — read-only block renderer for the public
 * `/share/[token]` page. Mirrors Phase 1's block type enum but never
 * renders editable inputs. When Phase 1 frontend ships a shared
 * `BlockRenderer` with a `readOnly` prop, this file should be replaced
 * by that import to keep one source of truth for block layouts.
 */

interface SharedBlockRendererProps {
  block: SharedBlock;
}

function getText(content: Record<string, unknown>): string {
  const value = content.text;
  return typeof value === "string" ? value : "";
}

function getChecked(content: Record<string, unknown>): boolean {
  return content.checked === true;
}

function getIcon(content: Record<string, unknown>): string {
  return typeof content.icon === "string" ? content.icon : "💡";
}

function getLanguage(content: Record<string, unknown>): string {
  return typeof content.language === "string" ? content.language : "plain";
}

function ParagraphBlock({ content }: { content: Record<string, unknown> }) {
  const text = getText(content);
  return (
    <Text className="text-base leading-7 text-foreground">
      {text || (
        <Text className="text-muted-foreground italic">Empty paragraph</Text>
      )}
    </Text>
  );
}

function HeadingBlock({
  content,
  level,
}: {
  content: Record<string, unknown>;
  level: 1 | 2 | 3;
}) {
  const text = getText(content) || "Untitled heading";
  const className =
    level === 1
      ? "text-3xl font-bold text-foreground mt-4"
      : level === 2
        ? "text-2xl font-bold text-foreground mt-3"
        : "text-xl font-semibold text-foreground mt-2";
  return <Text className={className}>{text}</Text>;
}

function BulletedListBlock({
  content,
}: {
  content: Record<string, unknown>;
}) {
  return (
    <View className="flex-row gap-2">
      <Text className="text-base leading-7 text-foreground">{"•"}</Text>
      <Text className="text-base leading-7 text-foreground flex-1">
        {getText(content)}
      </Text>
    </View>
  );
}

function NumberedListBlock({
  content,
  index,
}: {
  content: Record<string, unknown>;
  index: number;
}) {
  return (
    <View className="flex-row gap-2">
      <Text className="text-base leading-7 text-foreground">{`${index}.`}</Text>
      <Text className="text-base leading-7 text-foreground flex-1">
        {getText(content)}
      </Text>
    </View>
  );
}

function TodoBlock({ content }: { content: Record<string, unknown> }) {
  const { colors } = useColorScheme();
  const checked = getChecked(content);
  return (
    <View className="flex-row gap-2 items-start">
      <View
        className="h-5 w-5 rounded border border-border items-center justify-center mt-0.5"
        style={{
          backgroundColor: checked ? colors.foreground : "transparent",
        }}
      >
        {checked ? <Check size={12} color={colors.background} /> : null}
      </View>
      <Text
        className={`text-base leading-7 flex-1 ${
          checked ? "text-muted-foreground line-through" : "text-foreground"
        }`}
      >
        {getText(content)}
      </Text>
    </View>
  );
}

function QuoteBlock({ content }: { content: Record<string, unknown> }) {
  return (
    <View className="border-l-2 border-border pl-4 py-1">
      <Text className="text-base leading-7 text-muted-foreground italic">
        {getText(content)}
      </Text>
    </View>
  );
}

function DividerBlock() {
  return <View className="h-px bg-border my-3" />;
}

function CodeBlock({ content }: { content: Record<string, unknown> }) {
  const text = getText(content);
  const language = getLanguage(content);
  return (
    <View className="rounded-lg border border-border bg-muted/40 overflow-hidden">
      <View className="flex-row items-center justify-between px-3 py-1.5 border-b border-border/60">
        <Text className="text-[11px] font-mono text-muted-foreground">
          {language}
        </Text>
      </View>
      <View className="p-3">
        <Text
          className="text-sm text-foreground"
          style={{
            fontFamily: Platform.select({
              web: "SpaceMono, monospace",
              default: "SpaceMono",
            }),
          }}
        >
          {text}
        </Text>
      </View>
    </View>
  );
}

function CalloutBlock({ content }: { content: Record<string, unknown> }) {
  return (
    <View className="flex-row gap-3 rounded-xl bg-muted/40 px-4 py-3">
      <Text className="text-2xl" style={{ lineHeight: 28 }}>
        {getIcon(content)}
      </Text>
      <Text className="text-base leading-7 text-foreground flex-1">
        {getText(content)}
      </Text>
    </View>
  );
}

export function SharedBlockRenderer({ block }: SharedBlockRendererProps) {
  switch (block.type) {
    case "paragraph":
      return <ParagraphBlock content={block.content} />;
    case "heading_1":
      return <HeadingBlock content={block.content} level={1} />;
    case "heading_2":
      return <HeadingBlock content={block.content} level={2} />;
    case "heading_3":
      return <HeadingBlock content={block.content} level={3} />;
    case "bulleted_list_item":
      return <BulletedListBlock content={block.content} />;
    case "numbered_list_item":
      return (
        <NumberedListBlock content={block.content} index={block.order + 1} />
      );
    case "todo":
      return <TodoBlock content={block.content} />;
    case "quote":
      return <QuoteBlock content={block.content} />;
    case "divider":
      return <DividerBlock />;
    case "code":
      return <CodeBlock content={block.content} />;
    case "callout":
      return <CalloutBlock content={block.content} />;
    default:
      return (
        <Text className="text-sm text-muted-foreground italic">
          Unsupported block type: {block.type}
        </Text>
      );
  }
}
