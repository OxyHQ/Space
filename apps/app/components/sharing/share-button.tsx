import React from "react";
import { Pressable, View } from "react-native";
import { Share2 } from "lucide-react-native";
import { Text } from "@/components/ui/text";
import { useColorScheme } from "@/lib/useColorScheme";
import { ShareModal } from "./share-modal";

interface ShareButtonProps {
  pageId: string;
  /** Compact icon-only mode for tight headers. Defaults to false. */
  compact?: boolean;
}

/**
 * ShareButton — opens the ShareModal for a given page.
 * Intended to be placed in the page detail header (top-right). Safe to
 * render anywhere; the only requirement is a valid pageId.
 */
export function ShareButton({ pageId, compact = false }: ShareButtonProps) {
  const { colors } = useColorScheme();
  const [open, setOpen] = React.useState(false);

  if (!pageId) return null;

  return (
    <>
      <Pressable
        onPress={() => setOpen(true)}
        className={
          compact
            ? "h-9 w-9 items-center justify-center rounded-lg hover:bg-muted"
            : "h-9 px-3 flex-row items-center gap-1.5 rounded-lg border border-border hover:bg-muted"
        }
        accessibilityRole="button"
        accessibilityLabel="Share page"
      >
        <Share2 size={14} color={colors.foreground} />
        {!compact && (
          <Text className="text-xs font-semibold text-foreground">Share</Text>
        )}
      </Pressable>
      <ShareModal open={open} onOpenChange={setOpen} pageId={pageId} />
    </>
  );
}
