import * as React from "react";
import { Pressable, View } from "react-native";
import { useRouter } from "expo-router";
import { Calendar, FileText, User } from "lucide-react-native";
import { Text } from "@/components/ui/text";
import { useOxy } from "@oxyhq/services";
import { useColorScheme } from "@/lib/useColorScheme";
import { cn } from "@/lib/utils";
import {
  isMentionSegment,
  type CommentContent as CommentContentType,
  type MentionSegment,
} from "@/lib/types/comments";

interface CommentContentProps {
  content: CommentContentType;
  /** Tailwind size class for the surrounding text. Defaults to text-sm. */
  textClassName?: string;
}

/**
 * Renders rich-text comment content with inline mention chips.
 *
 * Text segments preserve bold/italic/underline/strike/code/link annotations.
 * Mention chips are subtle pill components that are clickable: user mentions
 * open the Oxy account sheet, page mentions navigate to the target page,
 * date mentions are non-interactive but visually distinguished.
 */
export function CommentContentView({
  content,
  textClassName,
}: CommentContentProps) {
  const segments = content.segments ?? [];
  return (
    <View className="flex-row flex-wrap">
      {segments.map((seg, idx) => {
        if (isMentionSegment(seg)) {
          return <MentionChip key={idx} mention={seg} />;
        }
        return (
          <Text
            key={idx}
            className={cn(
              "text-sm text-foreground",
              textClassName,
              seg.bold && "font-bold",
              seg.italic && "italic",
              seg.underline && "underline",
              seg.strike && "line-through",
              seg.code && "font-mono bg-muted/60 rounded px-1",
            )}
          >
            {seg.text}
          </Text>
        );
      })}
    </View>
  );
}

function MentionChip({ mention }: { mention: MentionSegment }) {
  const router = useRouter();
  const { showBottomSheet } = useOxy();
  const { colors } = useColorScheme();

  const Icon = mention.kind === "user" ? User : mention.kind === "page" ? FileText : Calendar;

  const handlePress = () => {
    if (mention.kind === "page" && mention.id) {
      router.push(`/(app)/p/${mention.id}`);
      return;
    }
    if (mention.kind === "user" && mention.id) {
      // Best-effort — the Oxy account sheet covers the current user only,
      // but for non-self mentions we degrade to a no-op (Phase 3 will add
      // a user-profile sheet via Oxy services).
      showBottomSheet?.("AccountSettings");
    }
  };

  return (
    <Pressable
      onPress={handlePress}
      className="flex-row items-center gap-1 rounded-md bg-primary/10 px-1.5 py-0.5 mx-0.5"
      accessibilityRole="link"
      accessibilityLabel={`Mention: ${mention.originalText}`}
    >
      <Icon size={12} color={colors.primary} />
      <Text className="text-xs font-medium text-primary">
        {mention.kind === "date" && mention.date
          ? formatDate(mention.date)
          : mention.originalText.replace(/^@/, "")}
      </Text>
    </Pressable>
  );
}

function formatDate(iso: string): string {
  const [y, m, d] = iso.split("-").map((part) => parseInt(part, 10));
  if (!y || !m || !d) return iso;
  const date = new Date(y, m - 1, d);
  if (Number.isNaN(date.getTime())) return iso;
  return date.toLocaleDateString(undefined, {
    month: "short",
    day: "numeric",
    year: "numeric",
  });
}
