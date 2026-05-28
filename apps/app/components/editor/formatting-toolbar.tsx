import * as React from "react";
import { Platform, Pressable, StyleSheet, View } from "react-native";
import {
  Bold,
  Code,
  Italic,
  Link2,
  Palette,
  Strikethrough,
  Underline,
} from "lucide-react-native";
import { Text } from "@/components/ui/text";
import { useColorScheme } from "@/lib/useColorScheme";
import type { BlockColor } from "@/lib/types/pages";
import { BLOCK_COLORS } from "@/lib/types/pages";

export interface FormattingState {
  bold: boolean;
  italic: boolean;
  underline: boolean;
  strike: boolean;
  code: boolean;
}

export interface FormattingToolbarProps {
  /** True while a non-collapsed selection exists in a focused editor. */
  open: boolean;
  /**
   * Pixel position (in viewport coordinates) where the toolbar should anchor.
   * Web-only — native ignores positioning and shows a sheet via Modal.
   */
  anchor?: { top: number; left: number; width: number } | null;
  /** Current annotation state of the selection (for active styling). */
  active: FormattingState;
  onToggle: (mark: keyof FormattingState) => void;
  onSetColor: (color: BlockColor) => void;
  onSetBackground: (color: BlockColor) => void;
  onSetLink: (url: string | null) => void;
}

const BTN_BASE =
  "h-8 px-2 items-center justify-center rounded-md flex-row gap-1";

/**
 * Floating selection toolbar. Web-only positioning; on native the toolbar
 * stays hidden (rich inline isn't supported there in Phase 2). The native
 * path returns null so unused render branches don't cost anything.
 */
export function FormattingToolbar(props: FormattingToolbarProps) {
  if (Platform.OS !== "web") return null;
  if (!props.open) return null;
  return <FormattingToolbarWeb {...props} />;
}

function FormattingToolbarWeb({
  anchor,
  active,
  onToggle,
  onSetColor,
  onSetBackground,
  onSetLink,
}: FormattingToolbarProps) {
  const { colors } = useColorScheme();
  const [openMenu, setOpenMenu] = React.useState<"color" | "background" | null>(
    null,
  );
  const [linkOpen, setLinkOpen] = React.useState(false);
  const [linkValue, setLinkValue] = React.useState("");

  const top = anchor ? Math.max(8, anchor.top - 48) : 16;
  const left = anchor ? Math.max(8, anchor.left) : 16;

  const submitLink = () => {
    const trimmed = linkValue.trim();
    onSetLink(trimmed.length > 0 ? trimmed : null);
    setLinkOpen(false);
    setLinkValue("");
  };

  // The contenteditable below collapses its selection on any mousedown that
  // isn't inside it. Wrap interactive chrome in a <div> with preventDefault on
  // mousedown so toolbar clicks keep the selection live.
  const preventBlur = (ev: React.MouseEvent<HTMLDivElement>) => {
    ev.preventDefault();
  };

  return (
    <View
      style={[styles.popover, { top, left }]}
      // Stop selection collapse when clicking on toolbar buttons.
      onStartShouldSetResponderCapture={() => true}
    >
      <div onMouseDown={preventBlur}>
      <View
        className="flex-row items-center gap-1 rounded-xl border border-border bg-popover px-1 py-1 shadow-lg"
      >
        <ToolbarButton
          active={active.bold}
          onPress={() => onToggle("bold")}
          ariaLabel="Bold"
        >
          <Bold size={14} color={colors.foreground} />
        </ToolbarButton>
        <ToolbarButton
          active={active.italic}
          onPress={() => onToggle("italic")}
          ariaLabel="Italic"
        >
          <Italic size={14} color={colors.foreground} />
        </ToolbarButton>
        <ToolbarButton
          active={active.underline}
          onPress={() => onToggle("underline")}
          ariaLabel="Underline"
        >
          <Underline size={14} color={colors.foreground} />
        </ToolbarButton>
        <ToolbarButton
          active={active.strike}
          onPress={() => onToggle("strike")}
          ariaLabel="Strikethrough"
        >
          <Strikethrough size={14} color={colors.foreground} />
        </ToolbarButton>
        <ToolbarButton
          active={active.code}
          onPress={() => onToggle("code")}
          ariaLabel="Code"
        >
          <Code size={14} color={colors.foreground} />
        </ToolbarButton>
        <ToolbarButton
          active={linkOpen}
          onPress={() => setLinkOpen((v) => !v)}
          ariaLabel="Link"
        >
          <Link2 size={14} color={colors.foreground} />
        </ToolbarButton>
        <ToolbarButton
          active={openMenu === "color"}
          onPress={() =>
            setOpenMenu((m) => (m === "color" ? null : "color"))
          }
          ariaLabel="Text color"
        >
          <View className="flex-row items-center gap-1">
            <Palette size={14} color={colors.foreground} />
            <Text className="text-xs font-medium text-foreground">A</Text>
          </View>
        </ToolbarButton>
        <ToolbarButton
          active={openMenu === "background"}
          onPress={() =>
            setOpenMenu((m) => (m === "background" ? null : "background"))
          }
          ariaLabel="Background color"
        >
          <View className="h-4 w-4 rounded-sm bg-foreground/20" />
        </ToolbarButton>
      </View>

      {openMenu === "color" ? (
        <ColorPalette
          label="Text color"
          onPick={(c) => {
            onSetColor(c);
            setOpenMenu(null);
          }}
        />
      ) : null}
      {openMenu === "background" ? (
        <ColorPalette
          label="Background"
          onPick={(c) => {
            onSetBackground(c);
            setOpenMenu(null);
          }}
        />
      ) : null}
      {linkOpen ? (
        <View className="mt-1 flex-row items-center gap-1 rounded-xl border border-border bg-popover px-2 py-1 shadow-lg">
          <input
            value={linkValue}
            onChange={(e) => setLinkValue(e.currentTarget.value)}
            placeholder="Paste link…"
            className="flex-1 bg-transparent text-sm text-foreground outline-none"
            style={{ minWidth: 220 }}
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                e.preventDefault();
                submitLink();
              } else if (e.key === "Escape") {
                e.preventDefault();
                setLinkOpen(false);
              }
            }}
            autoFocus
          />
          <Pressable
            onPress={submitLink}
            className="rounded-md bg-primary px-2 py-1"
          >
            <Text className="text-xs font-medium text-primary-foreground">
              Apply
            </Text>
          </Pressable>
        </View>
      ) : null}
      </div>
    </View>
  );
}

function ColorPalette({
  label,
  onPick,
}: {
  label: string;
  onPick: (color: BlockColor) => void;
}) {
  return (
    <View className="mt-1 rounded-xl border border-border bg-popover p-2 shadow-lg">
      <Text className="mb-1 text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
        {label}
      </Text>
      <View className="flex-row flex-wrap gap-1">
        {BLOCK_COLORS.map((c) => (
          <Pressable
            key={c}
            onPress={() => onPick(c)}
            className="h-7 w-7 items-center justify-center rounded-md border border-border hover:bg-muted"
          >
            <View
              className={
                c === "default"
                  ? "h-4 w-4 rounded-sm border border-border"
                  : "h-4 w-4 rounded-sm"
              }
              style={c === "default" ? undefined : { backgroundColor: COLOR_SWATCH[c] }}
            />
          </Pressable>
        ))}
      </View>
    </View>
  );
}

const COLOR_SWATCH: Record<BlockColor, string | undefined> = {
  default: undefined,
  gray: "#9CA3AF",
  brown: "#92400E",
  orange: "#F97316",
  yellow: "#EAB308",
  green: "#10B981",
  blue: "#3B82F6",
  purple: "#A855F7",
  pink: "#EC4899",
  red: "#EF4444",
};

function ToolbarButton({
  active,
  onPress,
  ariaLabel,
  children,
}: {
  active: boolean;
  onPress: () => void;
  ariaLabel: string;
  children: React.ReactNode;
}) {
  return (
    <Pressable
      onPress={onPress}
      accessibilityLabel={ariaLabel}
      className={
        active
          ? `${BTN_BASE} bg-primary/10`
          : `${BTN_BASE} hover:bg-muted`
      }
    >
      {children}
    </Pressable>
  );
}

const styles = StyleSheet.create({
  popover: {
    position: "absolute",
    zIndex: 60,
  },
});
